// Claude Code の公開 CLI 面だけを使う cross-session worker/relay 補助。
//
// ListAgents / SendMessage は Claude session 内の built-in であり、Hachi の
// TypeScript process から呼べる公開 RPC ではない。このファイルは `claude --bg`
// と `claude agents --json` の検証、ならびに active Claude orchestrator が
// built-in を実行するための構造化 envelope を提供する。非公開 daemon socket や
// wire protocol には接続しない。
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { hostname } from "node:os";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LaunchOptions,
  NativeCommunicationAdapter,
  NativeCommunicationDeliveryRequest,
  NativeCommunicationDeliveryResult,
  NativeCommunicationProbeResult,
  NativeCommunicationSessionRef,
  SessionRef,
  SessionStatus,
  StopResult,
  TaskRow,
  WorkerAdapter,
} from "@hachi/core";
import {
  buildClaudeStopHookSettings,
  installClaudeTranscriptHook,
  readClaudeTranscriptCapture,
} from "./claude-transcript-hook.js";

/** Claude cross-session messaging の pilot で要求する最低 runtime version。 */
export const CLAUDE_CROSS_SESSION_MIN_RUNTIME_VERSION = "2.1.226";
/** 起動時に process-local settings で要求する capability。 */
export const CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY = "crossSessionInbound:accept";
/** relay envelope の version。 */
export const CLAUDE_RELAY_ENVELOPE_SCHEMA = "hachi.claude-relay.v1";
/** relay receipt の version。 */
export const CLAUDE_RELAY_RECEIPT_SCHEMA = "hachi.claude-relay-receipt.v1";

type CommandExitCode = number | null;

/** model call を発生させずに CLI を差し替えるための command 結果。 */
export interface ClaudeCrossSessionCommandResult {
  exitCode: CommandExitCode;
  stdout: string;
  stderr: string;
  error?: string;
}

/** `claude --version` / `claude agents --json` を実行する依存境界。 */
export type ClaudeCrossSessionCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<ClaudeCrossSessionCommandResult>;

/** background worker の起動依存境界。実装時にも spawn の argv 配列を直接使う。 */
export interface ClaudeCrossSessionSpawnRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
}

export interface ClaudeCrossSessionSpawnResult {
  pid: number;
  /** detached spawn の所有者が外部 worker を exact process group で回収する hook。 */
  stop?: () => Promise<void>;
}

export type ClaudeCrossSessionSpawner = (
  request: ClaudeCrossSessionSpawnRequest,
) => Promise<ClaudeCrossSessionSpawnResult>;

/** 起動後の discovery/state failure で、spawn した exact worker だけを回収する。 */
export type ClaudeCrossSessionProcessTerminator = (pid: number) => Promise<void>;

/** relay の送信者を live Claude orchestrator の exact identity に束縛する。 */
export interface ClaudeRelaySourcePrincipal {
  orchestratorId: string;
  orchestratorSessionId: string;
  orchestratorGeneration: number;
  providerSessionId: string;
}

export interface ClaudeRelayTarget {
  providerSessionId: string;
  agentRef: string;
}

export interface ClaudeRelayAckCommand {
  command: "hachi communication relay receipt --json";
  attemptId: string;
  attemptNonce: string;
  deliveryId: string;
  messageKey: string;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  expectedCancelFence: number;
}

/** active Claude orchestrator へ渡す relay envelope。payload は core 側で redact 済みであることが前提。 */
export interface ClaudeRelayEnvelope {
  schemaVersion: typeof CLAUDE_RELAY_ENVELOPE_SCHEMA;
  kind: "claude-cross-session-relay";
  attemptId: string;
  attemptNonce: string;
  deliveryId: string;
  messageKey: string;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  expectedCancelFence: number;
  expiresAt: number;
  source: ClaudeRelaySourcePrincipal;
  target: ClaudeRelayTarget;
  payload: string;
  ack: ClaudeRelayAckCommand;
}

/** relay model に許可する built-in はこの2つだけ。shell/任意toolは許可しない。 */
export const CLAUDE_RELAY_ALLOWED_TOOLS = ["ListAgents", "SendMessage"] as const;

export interface ClaudeRelayExecutorOptions {
  allowedTools: typeof CLAUDE_RELAY_ALLOWED_TOOLS;
}

/** live executor が model text ではなく host-side tool invocation を返すための証拠。 */
export interface ClaudeRelayToolUseEvidence {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ClaudeRelayToolResultEvidence {
  toolUseId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface ClaudeRelayReceiverObservation {
  source: "receiver";
  agentRef: string;
  messageKey: string;
}

export interface ClaudeRelayExecutionEvidence {
  /** final model output は receipt authority ではない。監査用に保持するだけ。 */
  finalOutput?: string;
  toolUses: readonly ClaudeRelayToolUseEvidence[];
  toolResults: readonly ClaudeRelayToolResultEvidence[];
  receiverObservation?: ClaudeRelayReceiverObservation;
}

export type ClaudeRelayReceiptOutcome =
  | "transport-accepted"
  | "session-observed"
  | "acknowledged"
  | "rejected"
  | "uncertain";

export interface ClaudeRelayReceiptExpectation {
  attemptId: string;
  attemptNonce: string;
  deliveryId: string;
  messageKey: string;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  expectedCancelFence: number;
  target: ClaudeRelayTarget;
  source?: ClaudeRelaySourcePrincipal;
}

export interface ClaudeRelayReceipt {
  schemaVersion: typeof CLAUDE_RELAY_RECEIPT_SCHEMA;
  outcome: ClaudeRelayReceiptOutcome;
  receiptId?: string;
  attemptId: string;
  attemptNonce?: string;
  attemptNonceHash?: string;
  deliveryId: string;
  messageKey: string;
  taskId: string;
  runId: number;
  hachiSessionId: string;
  expectedCancelFence: number;
  target: ClaudeRelayTarget;
  source?: ClaudeRelaySourcePrincipal;
  /** session-observed のとき、receiver session が観測した exact message key。 */
  observedMessageKey?: string;
  /** acknowledged のとき、receiver が返した exact binding。 */
  ack?: ClaudeRelayAckCommand;
  detail?: string;
}

export type ClaudeRelayReceiptParseResult =
  | { ok: true; receipt: ClaudeRelayReceipt; delivery: NativeCommunicationDeliveryResult }
  | { ok: false; detail: string };

/** `claude agents --json` の一要素を正規化したもの。 */
export interface ClaudeAgentEntry {
  sessionId: string;
  name: string;
  /** ListAgents が返した exact ref。sessionId で代用せず、欠落時は fail-closed にする。 */
  agentRef: string;
  status: string;
  state: string | null;
  waitingFor: string | null;
  runtimeVersion: string | null;
  /** runtime listに欄が無いときはnull。configured evidenceで補完した値ではない。 */
  inboundAccepted: boolean | null;
  capabilityHash: string | null;
}

export interface ClaudeAgentList {
  agents: readonly ClaudeAgentEntry[];
}

interface ClaudeCrossSessionState {
  providerSessionId: string;
  agentName: string;
  agentRef: string;
  model: string;
  cwd: string;
  pid: number;
  runtimeVersion: string;
  capabilityHash: string;
  /** Hachi-owned process-local launch settingsに固定したconfigured evidence。 */
  crossSessionInbound: "accept";
  hostId: string;
  observedAt: number;
  expiresAt: number;
}

interface ClaudeCrossSessionClock {
  nowSeconds(): number;
  sleep(ms: number): Promise<void>;
}

export interface ClaudeCrossSessionWorkerOptions {
  /** session metadata を格納する専用ディレクトリ。prompt/payload は保存しない。 */
  stateDir: string;
  /** provider が transcript を保存する canonical root。未構成なら external spawn 前に fail-closed。 */
  providerTranscriptRoot?: string;
  claudeBin?: string;
  hostId?: string;
  minimumRuntimeVersion?: string;
  bindingTtlSeconds?: number;
  discoveryTimeoutMs?: number;
  discoveryPollIntervalMs?: number;
  commandTimeoutMs?: number;
  commandRunner?: ClaudeCrossSessionCommandRunner;
  spawner?: ClaudeCrossSessionSpawner;
  sessionIdFactory?: () => string;
  nameFactory?: (task: TaskRow, sessionId: string) => string;
  clock?: ClaudeCrossSessionClock;
  /** spawn 後の discovery/write failure で exact detached process group を停止する DI。 */
  stopSpawnedWorker?: ClaudeCrossSessionProcessTerminator;
  /** 無い場合、deliver() は live orchestrator 未接続として rejected に倒す。 */
  relayExecutor?: ClaudeRelayExecutor;
  relaySource?: ClaudeRelaySourcePrincipal;
}

/** built-in を呼ぶ live Claude orchestrator の外側で注入する relay executor。 */
export interface ClaudeRelayExecutor {
  execute(
    prompt: string,
    envelope: ClaudeRelayEnvelope,
    options?: ClaudeRelayExecutorOptions,
  ): Promise<string | ClaudeRelayExecutionEvidence>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1000;
const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 50;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_BINDING_TTL_SECONDS = 3600;
const MAX_BINDING_TTL_SECONDS = 86_400;

/** 現行の公開 Claude CLI が host-side tool evidence を返さないことを示す fail-closed 理由。 */
export const CLAUDE_RELAY_PUBLIC_CLI_LIMITATION =
  "Claude public CLI は ListAgents/SendMessage の実 tool-use/result と receiver observation を外部 executor へ公開しないため、prompt-generated receipt を native delivery の証拠にできません";

const SCRUBBED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function buildScrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function defaultClock(): ClaudeCrossSessionClock {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<ClaudeCrossSessionCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: buildScrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ClaudeCrossSessionCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      finish({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.once("close", (exitCode: number | null) => {
      finish({ exitCode, stdout, stderr });
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: null, stdout, stderr, error: "command timeout" });
    }, options.timeoutMs);
    child.once("close", () => clearTimeout(timeout));
  });
}

function defaultSpawner(request: ClaudeCrossSessionSpawnRequest): Promise<ClaudeCrossSessionSpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: buildScrubbedEnv(),
        detached: true,
        stdio: "ignore",
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error("Claude cross-session worker の pid を取得できませんでした"));
      return;
    }
    child.unref();
    resolve({ pid, stop: () => terminateProcessGroup(pid) });
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

/** detached spawn が作った process group だけを bounded に停止する。 */
async function terminateProcessGroup(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Claude worker pid が不正です");
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`Claude agents JSON: ${key} が不正です`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  if (!(key in record)) return null;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`Claude agents JSON: ${key} が不正です`);
  }
  return value;
}

function optionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (!(key in record)) return null;
  const value = record[key];
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`Claude agents JSON: ${key} が不正です`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function readInboundEvidence(record: Record<string, unknown>): boolean | null {
  const candidates: unknown[] = [];
  for (const key of ["crossSessionInbound", "inboundPolicy"]) {
    if (key in record) candidates.push(record[key]);
  }
  const runtimeEvidence = optionalRecord(record, "runtimeEvidence");
  if (runtimeEvidence !== null) {
    if ("crossSessionInbound" in runtimeEvidence) candidates.push(runtimeEvidence.crossSessionInbound);
    if ("inboundPolicy" in runtimeEvidence) candidates.push(runtimeEvidence.inboundPolicy);
    for (const key of ["capabilities", "capabilityTokens", "capability"]) {
      if (key in runtimeEvidence) candidates.push(runtimeEvidence[key]);
    }
  }
  for (const key of ["capabilities", "capabilityTokens"]) {
    if (!(key in record)) continue;
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`Claude agents JSON: ${key} が不正です`);
    }
    candidates.push(value);
  }
  for (const candidate of candidates) {
    if (candidate === "accept" || candidate === CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY) return true;
    if (Array.isArray(candidate) && candidate.includes(CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY)) return true;
    if (isRecord(candidate) && candidate["crossSessionInbound"] === "accept") return true;
  }
  return candidates.length === 0 ? null : false;
}

function readCapabilityHash(record: Record<string, unknown>): string | null {
  const value = optionalString(record, "capabilityHash");
  if (value === null) return null;
  if (!isSha256(value)) throw new Error("Claude agents JSON: capabilityHash が不正です");
  return value.toLowerCase();
}

function parseRuntimeVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part >= 0)) return null;
  return [major, minor, patch];
}

/** `claude --version` の出力を strict semver へ正規化する。 */
export function parseClaudeRuntimeVersion(output: string): string | null {
  const firstLine = output.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /(?:Claude Code\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(firstLine);
  const version = match?.[1];
  if (version === undefined || parseRuntimeVersion(version) === null) return null;
  return version;
}

function compareRuntimeVersion(left: string, right: string): number {
  const l = parseRuntimeVersion(left);
  const r = parseRuntimeVersion(right);
  if (l === null || r === null) throw new Error("Claude runtime version が不正です");
  const pairs: readonly [number, number][] = [[l[0], r[0]], [l[1], r[1]], [l[2], r[2]]];
  for (const [leftPart, rightPart] of pairs) {
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0 || value.includes("\u0000")) {
    throw new Error(`${label} が空または不正です`);
  }
}

function assertSafeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} が不正です`);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** canonical capability snapshot の hash。caller の自己申告値を信頼せず再計算する。 */
export function computeClaudeCrossSessionCapabilityHash(runtimeVersion: string): string {
  if (parseRuntimeVersion(runtimeVersion) === null) throw new Error("Claude runtime version が不正です");
  const snapshot = {
    schemaVersion: "communication-capability.v1",
    provider: "claude",
    route: "claude-cross-session",
    runtimeVersion,
    capabilities: ["background-session", "agents-json", CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY],
  };
  return createHash("sha256").update(stableStringify(snapshot), "utf8").digest("hex");
}

/** `claude agents --json` の output を fail-closed で正規化する。 */
export function parseClaudeAgentsJson(raw: string): ClaudeAgentList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Claude agents JSON を parse できません");
  }
  if (!Array.isArray(parsed)) throw new Error("Claude agents JSON は配列でなければなりません");

  const agents: ClaudeAgentEntry[] = [];
  const names = new Set<string>();
  const refs = new Set<string>();
  const sessions = new Set<string>();
  for (const item of parsed) {
    if (!isRecord(item)) throw new Error("Claude agents JSON の agent 要素が不正です");
    const sessionId = requiredString(item, "sessionId");
    if (!isUuid(sessionId)) throw new Error("Claude agents JSON: sessionId が UUID ではありません");
    const name = requiredString(item, "name");
    const state = optionalString(item, "state");
    // Claude 2.1.226 の実際の `claude agents --json --all` は state を返すが、
    // status を返さない。status は state から正規化し、両方無い場合は unknown に倒す。
    const status = optionalString(item, "status") ?? state ?? "unknown";
    const waitingFor = optionalString(item, "waitingFor");
    // runtime の schema 差分として id を受けるが、sessionId そのものへの fallback はしない。
    const agentRef = optionalString(item, "agentRef")
      ?? optionalString(item, "ref")
      ?? optionalString(item, "agentId")
      ?? optionalString(item, "id");
    if (agentRef === null) throw new Error("Claude agents JSON: exact agentRef がありません");
    if (agentRef === sessionId) throw new Error("Claude agents JSON: agentRef を sessionId の代用にできません");
    if (names.has(name)) throw new Error("Claude agents JSON: duplicate agent name");
    if (refs.has(agentRef)) throw new Error("Claude agents JSON: duplicate agent ref");
    if (sessions.has(sessionId)) throw new Error("Claude agents JSON: duplicate sessionId");
    names.add(name);
    refs.add(agentRef);
    sessions.add(sessionId);
    const runtimeVersion = optionalString(item, "runtimeVersion");
    if (runtimeVersion !== null && parseRuntimeVersion(runtimeVersion) === null) {
      throw new Error("Claude agents JSON: runtimeVersion が不正です");
    }
    agents.push({
      sessionId,
      name,
      agentRef,
      status,
      state,
      waitingFor,
      runtimeVersion,
      inboundAccepted: readInboundEvidence(item),
      capabilityHash: readCapabilityHash(item),
    });
  }
  return { agents };
}

function readState(stateDir: string, sessionId: string): ClaudeCrossSessionState | null {
  if (!isUuid(sessionId)) return null;
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, `${sessionId}.json`), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  try {
    const providerSessionId = requiredString(parsed, "providerSessionId");
    const agentName = requiredString(parsed, "agentName");
    const agentRef = requiredString(parsed, "agentRef");
    const model = requiredString(parsed, "model");
    const cwd = requiredString(parsed, "cwd");
    const runtimeVersion = requiredString(parsed, "runtimeVersion");
    const capabilityHash = requiredString(parsed, "capabilityHash");
    const crossSessionInbound = requiredString(parsed, "crossSessionInbound");
    const hostId = requiredString(parsed, "hostId");
    const pid = parsed.pid;
    const observedAt = parsed.observedAt;
    const expiresAt = parsed.expiresAt;
    if (!isUuid(providerSessionId) || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return null;
    if (parseRuntimeVersion(runtimeVersion) === null || !isSha256(capabilityHash) || crossSessionInbound !== "accept") return null;
    assertSafeInteger(observedAt as number, "observedAt");
    assertSafeInteger(expiresAt as number, "expiresAt");
    return {
      providerSessionId,
      agentName,
      agentRef,
      model,
      cwd,
      pid,
      runtimeVersion,
      capabilityHash: capabilityHash.toLowerCase(),
      crossSessionInbound: "accept",
      hostId,
      observedAt: observedAt as number,
      expiresAt: expiresAt as number,
    };
  } catch {
    return null;
  }
}

function writeState(stateDir: string, state: ClaudeCrossSessionState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, `${state.providerSessionId}.json`);
  writeFileSync(path, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function statusFromAgent(agent: ClaudeAgentEntry): SessionStatus {
  const status = agent.status.toLowerCase();
  const state = agent.state?.toLowerCase() ?? "";
  if (["working", "busy", "running", "active"].includes(status) || ["working", "busy", "running"].includes(state)) {
    return { state: "active", lastActivityAt: null };
  }
  if (["waiting", "needs-input", "needs_input", "blocked"].includes(status)
    || ["waiting", "needs-input", "needs_input", "blocked"].includes(state)) {
    return { state: "awaiting-input", lastActivityAt: null };
  }
  if (["idle", "ready"].includes(status) || ["idle", "ready"].includes(state)) {
    return { state: "idle", lastActivityAt: null };
  }
  if (["done", "completed", "ended", "stopped", "failed", "error"].includes(status)
    || ["done", "completed", "ended", "stopped", "failed", "error"].includes(state)) {
    return { state: "ended", lastActivityAt: null, resultCount: 1 };
  }
  return { state: "unknown", lastActivityAt: null };
}

function targetFromRef(ref: SessionRef): Extract<NativeCommunicationSessionRef, { route: "claude-cross-session" }> | null {
  if (ref.provider !== "claude" || ref.nativeCommunication?.route !== "claude-cross-session") return null;
  return ref.nativeCommunication;
}

function targetRecordMatches(
  entry: ClaudeAgentEntry,
  target: Extract<NativeCommunicationSessionRef, { route: "claude-cross-session" }>,
  state: ClaudeCrossSessionState,
  runtimeVersion: string,
  capabilityHash: string,
): boolean {
  return entry.sessionId === target.providerSessionId
    && entry.agentRef === target.agentRef
    && entry.name === state.agentName
    && state.crossSessionInbound === "accept"
    && entry.inboundAccepted !== false
    && (entry.runtimeVersion === null || entry.runtimeVersion === runtimeVersion)
    && (entry.capabilityHash === null || entry.capabilityHash === capabilityHash);
}

function commandFailureDetail(result: ClaudeCrossSessionCommandResult, label: string): string {
  const error = result.error ?? `exit=${String(result.exitCode)}`;
  return `${label}: ${error}`;
}

function validateBindingTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_BINDING_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_BINDING_TTL_SECONDS) {
    throw new Error("Claude cross-session binding TTL が不正です");
  }
  return ttl;
}

function validateRelaySource(source: ClaudeRelaySourcePrincipal): void {
  assertNonEmpty(source.orchestratorId, "orchestratorId");
  assertNonEmpty(source.orchestratorSessionId, "orchestratorSessionId");
  assertNonEmpty(source.providerSessionId, "providerSessionId");
  assertSafeInteger(source.orchestratorGeneration, "orchestratorGeneration", 1);
  if (!isUuid(source.providerSessionId)) throw new Error("relay source providerSessionId が UUID ではありません");
}

function validateRelayTarget(target: ClaudeRelayTarget): void {
  assertNonEmpty(target.providerSessionId, "target.providerSessionId");
  assertNonEmpty(target.agentRef, "target.agentRef");
  if (!isUuid(target.providerSessionId)) throw new Error("relay target providerSessionId が UUID ではありません");
}

/** NativeCommunicationDeliveryRequest と source identity から relay envelope を作る。 */
export function createClaudeRelayEnvelope(
  input: NativeCommunicationDeliveryRequest,
  source: ClaudeRelaySourcePrincipal,
  expiresAt: number,
): ClaudeRelayEnvelope {
  if (input.target.route !== "claude-cross-session") throw new Error("Claude relay target route が不正です");
  assertNonEmpty(input.attemptId, "attemptId");
  assertNonEmpty(input.attemptNonce, "attemptNonce");
  assertNonEmpty(input.deliveryId, "deliveryId");
  assertNonEmpty(input.messageKey, "messageKey");
  assertNonEmpty(input.taskId, "taskId");
  assertNonEmpty(input.message, "message");
  assertSafeInteger(input.runId, "runId", 1);
  assertSafeInteger(input.expectedCancelFence, "expectedCancelFence");
  assertSafeInteger(expiresAt, "expiresAt", 1);
  validateRelaySource(source);
  validateRelayTarget({ providerSessionId: input.target.providerSessionId, agentRef: input.target.agentRef });
  const target: ClaudeRelayTarget = {
    providerSessionId: input.target.providerSessionId,
    agentRef: input.target.agentRef,
  };
  const ack: ClaudeRelayAckCommand = {
    command: "hachi communication relay receipt --json",
    attemptId: input.attemptId,
    attemptNonce: input.attemptNonce,
    deliveryId: input.deliveryId,
    messageKey: input.messageKey,
    taskId: input.taskId,
    runId: input.runId,
    hachiSessionId: input.hachiSessionId,
    expectedCancelFence: input.expectedCancelFence,
  };
  return {
    schemaVersion: CLAUDE_RELAY_ENVELOPE_SCHEMA,
    kind: "claude-cross-session-relay",
    attemptId: input.attemptId,
    attemptNonce: input.attemptNonce,
    deliveryId: input.deliveryId,
    messageKey: input.messageKey,
    taskId: input.taskId,
    runId: input.runId,
    hachiSessionId: input.hachiSessionId,
    expectedCancelFence: input.expectedCancelFence,
    expiresAt,
    source,
    target,
    payload: input.message,
    ack,
  };
}

/** 命名を明示した caller 向け alias。 */
export const buildClaudeRelayEnvelope = createClaudeRelayEnvelope;

/** live orchestrator が一回だけ built-in を呼ぶための prompt。JSON envelope はそのまま送信対象にする。 */
export function buildClaudeRelayPrompt(envelope: ClaudeRelayEnvelope): string {
  return [
    "Hachi Claude cross-session relay v1。これは構造化 delivery envelope であり、内容を勝手に変更しないこと。",
    "あなたは active exact Claude orchestrator である。Hachi の claim/begin-dispatch が済んだ後にだけ実行すること。",
    "使用してよい built-in tool は ListAgents と SendMessage だけ。Bash、任意の shell/CLI、その他の tool、任意の ack command 実行は絶対に使わないこと。",
    "公開 built-in ListAgents で target.providerSessionId と target.agentRef の両方を再確認し、表示名だけで宛先を選ばないこと。",
    "ListAgents の ref が一致しない、重複する、inbound policy/capability/runtime evidence が無い場合は SendMessage を実行せず rejected を返すこと。",
    "一致した場合だけ SendMessage をこの envelope の JSON 文字列に対して一回だけ実行すること。timeout、tool error、異形結果は uncertain とし再送しないこと。",
    "最後の model text は証拠ではない。host-side executor が実際の ListAgents/SendMessage tool-use と tool-result を取得できない場合、Hachi は native delivery を成功扱いしない。",
    stableStringify(envelope),
  ].join("\n");
}

function readReceiptValue(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) throw new Error(`relay receipt: ${key} がありません`);
  return record[key];
}

function requiredReceiptString(record: Record<string, unknown>, key: string): string {
  const value = readReceiptValue(record, key);
  if (typeof value !== "string" || value.length === 0) throw new Error(`relay receipt: ${key} が不正です`);
  return value;
}

function requiredReceiptInteger(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = readReceiptValue(record, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`relay receipt: ${key} が不正です`);
  }
  return value;
}

function parseRelayTarget(value: unknown): ClaudeRelayTarget {
  if (!isRecord(value)) throw new Error("relay receipt: target が不正です");
  const target = {
    providerSessionId: requiredReceiptString(value, "providerSessionId"),
    agentRef: requiredReceiptString(value, "agentRef"),
  };
  validateRelayTarget(target);
  return target;
}

function parseRelaySource(value: unknown): ClaudeRelaySourcePrincipal {
  if (!isRecord(value)) throw new Error("relay receipt: source が不正です");
  const source = {
    orchestratorId: requiredReceiptString(value, "orchestratorId"),
    orchestratorSessionId: requiredReceiptString(value, "orchestratorSessionId"),
    orchestratorGeneration: requiredReceiptInteger(value, "orchestratorGeneration", 1),
    providerSessionId: requiredReceiptString(value, "providerSessionId"),
  };
  validateRelaySource(source);
  return source;
}

function parseRelayAck(value: unknown): ClaudeRelayAckCommand {
  if (!isRecord(value)) throw new Error("relay receipt: ack が不正です");
  const command = requiredReceiptString(value, "command");
  if (command !== "hachi communication relay receipt --json") throw new Error("relay receipt: ack command が不正です");
  return {
    command,
    attemptId: requiredReceiptString(value, "attemptId"),
    attemptNonce: requiredReceiptString(value, "attemptNonce"),
    deliveryId: requiredReceiptString(value, "deliveryId"),
    messageKey: requiredReceiptString(value, "messageKey"),
    taskId: requiredReceiptString(value, "taskId"),
    runId: requiredReceiptInteger(value, "runId", 1),
    hachiSessionId: requiredReceiptString(value, "hachiSessionId"),
    expectedCancelFence: requiredReceiptInteger(value, "expectedCancelFence"),
  };
}

function assertReceiptMatchesExpectation(
  receipt: ClaudeRelayReceipt,
  expected: ClaudeRelayReceiptExpectation,
): void {
  if (receipt.attemptId !== expected.attemptId
    || receipt.deliveryId !== expected.deliveryId
    || receipt.messageKey !== expected.messageKey
    || receipt.taskId !== expected.taskId
    || receipt.runId !== expected.runId
    || receipt.hachiSessionId !== expected.hachiSessionId
    || receipt.expectedCancelFence !== expected.expectedCancelFence
    || receipt.target.providerSessionId !== expected.target.providerSessionId
    || receipt.target.agentRef !== expected.target.agentRef) {
    throw new Error("relay receipt: exact attempt/delivery/binding が一致しません");
  }
  const nonceMatches = receipt.attemptNonce === expected.attemptNonce
    || receipt.attemptNonceHash === createHash("sha256").update(expected.attemptNonce, "utf8").digest("hex");
  if (!nonceMatches) throw new Error("relay receipt: attempt nonce が一致しません");
  if (expected.source !== undefined) {
    if (receipt.source === undefined
      || receipt.source.orchestratorId !== expected.source.orchestratorId
      || receipt.source.orchestratorSessionId !== expected.source.orchestratorSessionId
      || receipt.source.orchestratorGeneration !== expected.source.orchestratorGeneration
      || receipt.source.providerSessionId !== expected.source.providerSessionId) {
      throw new Error("relay receipt: source provenance が一致しません");
    }
  }
}

/** model/tool の結果を成功へ丸めず、exact envelope/binding と outcome を検証する。 */
export function parseClaudeRelayReceipt(
  raw: string,
  expected: ClaudeRelayReceiptExpectation,
): ClaudeRelayReceiptParseResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("relay receipt は JSON object でなければなりません");
    const record = isRecord(parsed.receipt) ? parsed.receipt : parsed;
    const schemaVersion = requiredReceiptString(record, "schemaVersion");
    if (schemaVersion !== CLAUDE_RELAY_RECEIPT_SCHEMA) throw new Error("relay receipt schema が不正です");
    const outcome = requiredReceiptString(record, "outcome") as ClaudeRelayReceiptOutcome;
    if (!["transport-accepted", "session-observed", "acknowledged", "rejected", "uncertain"].includes(outcome)) {
      throw new Error("relay receipt outcome が不正です");
    }
    const target = parseRelayTarget(readReceiptValue(record, "target"));
    const source = "source" in record ? parseRelaySource(record.source) : undefined;
    const receiptId = "receiptId" in record ? requiredReceiptString(record, "receiptId") : undefined;
    const attemptNonce = "attemptNonce" in record ? requiredReceiptString(record, "attemptNonce") : undefined;
    const attemptNonceHash = "attemptNonceHash" in record ? requiredReceiptString(record, "attemptNonceHash") : undefined;
    if (attemptNonceHash !== undefined && !isSha256(attemptNonceHash)) throw new Error("relay receipt nonce hash が不正です");
    const detail = "detail" in record ? requiredReceiptString(record, "detail") : undefined;
    const receipt: ClaudeRelayReceipt = {
      schemaVersion,
      outcome,
      ...(receiptId !== undefined ? { receiptId } : {}),
      attemptId: requiredReceiptString(record, "attemptId"),
      ...(attemptNonce !== undefined ? { attemptNonce } : {}),
      ...(attemptNonceHash !== undefined ? { attemptNonceHash: attemptNonceHash.toLowerCase() } : {}),
      deliveryId: requiredReceiptString(record, "deliveryId"),
      messageKey: requiredReceiptString(record, "messageKey"),
      taskId: requiredReceiptString(record, "taskId"),
      runId: requiredReceiptInteger(record, "runId", 1),
      hachiSessionId: requiredReceiptString(record, "hachiSessionId"),
      expectedCancelFence: requiredReceiptInteger(record, "expectedCancelFence"),
      target,
      ...(source !== undefined ? { source } : {}),
      ...("observedMessageKey" in record ? { observedMessageKey: requiredReceiptString(record, "observedMessageKey") } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(outcome === "acknowledged" ? { ack: parseRelayAck(readReceiptValue(record, "ack")) } : {}),
    };
    assertReceiptMatchesExpectation(receipt, expected);
    if (receiptId === undefined && outcome !== "rejected" && outcome !== "uncertain") {
      throw new Error("relay receipt: accepted outcome に receiptId がありません");
    }
    if ((outcome === "rejected" || outcome === "uncertain") && detail === undefined) {
      throw new Error("relay receipt: rejected/uncertain に detail がありません");
    }
    if (outcome === "session-observed" || outcome === "acknowledged") {
      if (receipt.observedMessageKey !== expected.messageKey) {
        throw new Error("relay receipt: session observation が exact message key と一致しません");
      }
    }
    if (outcome === "acknowledged") {
      if (receipt.ack === undefined) throw new Error("relay receipt: acknowledged に ack がありません");
      const ack = receipt.ack;
      if (ack.command !== "hachi communication relay receipt --json"
        || ack.attemptId !== expected.attemptId
        || ack.attemptNonce !== expected.attemptNonce
        || ack.deliveryId !== expected.deliveryId
        || ack.messageKey !== expected.messageKey
        || ack.taskId !== expected.taskId
        || ack.runId !== expected.runId
        || ack.hachiSessionId !== expected.hachiSessionId
        || ack.expectedCancelFence !== expected.expectedCancelFence) {
        throw new Error("relay receipt: acknowledged ack binding が一致しません");
      }
    }
    if (outcome === "rejected" || outcome === "uncertain") {
      return { ok: true, receipt, delivery: { outcome, ...(receiptId !== undefined ? { receiptId } : {}), detail: detail! } };
    }
    return { ok: true, receipt, delivery: { outcome: outcome.replace("-", "_") as "transport_accepted" | "session_observed" | "acknowledged", receiptId: receiptId!, ...(detail !== undefined ? { detail } : {}) } };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "relay receipt が不正です" };
  }
}

/** parser の fail-closed 結果を例外で扱いたい CLI/Supervisor 用の薄い facade。 */
export function assertClaudeRelayReceipt(
  raw: string,
  expected: ClaudeRelayReceiptExpectation,
): ClaudeRelayReceipt {
  const parsed = parseClaudeRelayReceipt(raw, expected);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.receipt;
}

type ClaudeRelayEvidenceVerification =
  | { ok: true; delivery: NativeCommunicationDeliveryResult }
  | { ok: false; detail: string };

function parseToolResultJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseAgentsToolResult(value: unknown): ClaudeAgentList | null {
  const parsed = parseToolResultJson(value);
  const candidate = isRecord(parsed) && "agents" in parsed ? parsed.agents : parsed;
  if (!Array.isArray(candidate)) return null;
  try {
    return parseClaudeAgentsJson(JSON.stringify(candidate));
  } catch {
    return null;
  }
}

function successfulSendMessageResult(value: unknown): boolean {
  const parsed = parseToolResultJson(value);
  if (!isRecord(parsed)) return false;
  if (parsed.isError === true || parsed.error !== undefined) return false;
  if (parsed.ok === true || parsed.success === true) return true;
  const status = parsed.status;
  return typeof status === "string" && ["ok", "accepted", "sent", "delivered"].includes(status.toLowerCase());
}

function relayEvidenceReceiptId(envelope: ClaudeRelayEnvelope, useIds: readonly string[]): string {
  // receipt ID は model output から取得せず、Hachi が検証した evidence binding から導出する。
  const binding = stableStringify({
    attemptId: envelope.attemptId,
    deliveryId: envelope.deliveryId,
    messageKey: envelope.messageKey,
    providerSessionId: envelope.target.providerSessionId,
    agentRef: envelope.target.agentRef,
    useIds,
  });
  return `claude-tool-${createHash("sha256").update(binding, "utf8").digest("hex")}`;
}

/**
 * model の最終 JSON/receipt ではなく、host-side executor が取得した実 tool evidence を検証する。
 * 現行公開 CLI はこの evidence を返さないため、実機ではこの検証へ到達せず fail-closed になる。
 */
export function verifyClaudeRelayExecutionEvidence(
  evidence: ClaudeRelayExecutionEvidence,
  envelope: ClaudeRelayEnvelope,
): ClaudeRelayEvidenceVerification {
  try {
    if (!Array.isArray(evidence.toolUses) || !Array.isArray(evidence.toolResults)) {
      throw new Error("Claude relay host-side tool evidence がありません");
    }
    if (evidence.toolUses.length !== 2 || evidence.toolResults.length !== 2) {
      throw new Error("Claude relay は ListAgents と SendMessage を各1回だけ要求します");
    }
    const useIds = new Set<string>();
    for (const use of evidence.toolUses) {
      if (!isRecord(use) || typeof use.toolUseId !== "string" || use.toolUseId.length === 0
        || typeof use.name !== "string" || !CLAUDE_RELAY_ALLOWED_TOOLS.includes(use.name as typeof CLAUDE_RELAY_ALLOWED_TOOLS[number])) {
        throw new Error("Claude relay tool-use evidence が許可された exact tool ではありません");
      }
      if (useIds.has(use.toolUseId)) throw new Error("Claude relay tool-use evidence が重複しています");
      useIds.add(use.toolUseId);
    }
    const listUse = evidence.toolUses.find((use) => use.name === "ListAgents");
    const sendUse = evidence.toolUses.find((use) => use.name === "SendMessage");
    if (listUse === undefined || sendUse === undefined) {
      throw new Error("Claude relay tool-use evidence に ListAgents/SendMessage が揃っていません");
    }
    const resultByUse = new Map<string, ClaudeRelayToolResultEvidence>();
    for (const result of evidence.toolResults) {
      if (!isRecord(result) || typeof result.toolUseId !== "string" || typeof result.name !== "string") {
        throw new Error("Claude relay tool-result evidence が不正です");
      }
      if (resultByUse.has(result.toolUseId)) throw new Error("Claude relay tool-result evidence が重複しています");
      if (result.name !== "ListAgents" && result.name !== "SendMessage") {
        throw new Error("Claude relay tool-result に許可外 tool が含まれています");
      }
      if ("isError" in result && result.isError !== undefined && typeof result.isError !== "boolean") {
        throw new Error("Claude relay tool-result isError が不正です");
      }
      resultByUse.set(result.toolUseId, {
        toolUseId: result.toolUseId,
        name: result.name,
        result: result.result,
        ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      });
    }
    if (resultByUse.size !== useIds.size || [...useIds].some((id) => !resultByUse.has(id))) {
      throw new Error("Claude relay tool-result が exact tool-use に bind されていません");
    }
    const listResult = resultByUse.get(listUse.toolUseId);
    const sendResult = resultByUse.get(sendUse.toolUseId);
    if (listResult === undefined || sendResult === undefined || listResult.name !== "ListAgents"
      || sendResult.name !== "SendMessage" || listResult.isError === true || sendResult.isError === true) {
      throw new Error("Claude relay tool-result の exact binding または error state が不正です");
    }
    const agents = parseAgentsToolResult(listResult.result);
    if (agents === null || !agents.agents.some((agent) =>
      agent.sessionId === envelope.target.providerSessionId && agent.agentRef === envelope.target.agentRef)) {
      throw new Error("ListAgents tool-result が exact providerSessionId/agentRef を観測していません");
    }
    if (!isRecord(sendUse.input) || sendUse.input.agentRef !== envelope.target.agentRef
      || typeof sendUse.input.message !== "string") {
      throw new Error("SendMessage tool-use が exact agentRef/message を指定していません");
    }
    const sentEnvelope = parseToolResultJson(sendUse.input.message);
    if (!isRecord(sentEnvelope) || stableStringify(sentEnvelope) !== stableStringify(envelope)) {
      throw new Error("SendMessage tool-use の message が exact envelope/message key に bind されていません");
    }
    if (!successfulSendMessageResult(sendResult.result)) {
      throw new Error("SendMessage tool-result が成功を明示していません");
    }
    if (evidence.receiverObservation !== undefined) {
      const observation = evidence.receiverObservation;
      if (observation.source !== "receiver" || observation.agentRef !== envelope.target.agentRef
        || observation.messageKey !== envelope.messageKey) {
        throw new Error("receiver observation が exact agentRef/message key に bind されていません");
      }
    }
    const receiptId = relayEvidenceReceiptId(envelope, [...useIds].sort());
    return {
      ok: true,
      delivery: {
        outcome: evidence.receiverObservation === undefined ? "transport_accepted" : "session_observed",
        receiptId,
        detail: evidence.receiverObservation === undefined
          ? "host-side ListAgents/SendMessage tool evidence を検証しました"
          : "host-side tool evidence と receiver の exact message key observation を検証しました",
      },
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Claude relay tool evidence が不正です" };
  }
}

/** Claude public cross-session worker と relay adapter。built-in は relayExecutor 経由でのみ実行できる。 */
export class ClaudeCrossSessionWorkerAdapter implements WorkerAdapter, NativeCommunicationAdapter {
  readonly provider = "claude" as const;
  readonly route = "claude-cross-session" as const;

  private readonly stateDir: string;
  private readonly providerTranscriptRoot: string | undefined;
  private readonly claudeBin: string;
  private readonly hostId: string;
  private readonly minimumRuntimeVersion: string;
  private readonly bindingTtlSeconds: number;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryPollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly commandRunner: ClaudeCrossSessionCommandRunner;
  private readonly spawner: ClaudeCrossSessionSpawner;
  private readonly sessionIdFactory: () => string;
  private readonly nameFactory: (task: TaskRow, sessionId: string) => string;
  private readonly clock: ClaudeCrossSessionClock;
  private readonly stopSpawnedWorker: ClaudeCrossSessionProcessTerminator;
  private readonly relayExecutor: ClaudeRelayExecutor | undefined;
  private readonly relaySource: ClaudeRelaySourcePrincipal | undefined;

  constructor(options: ClaudeCrossSessionWorkerOptions) {
    this.stateDir = options.stateDir;
    this.providerTranscriptRoot = options.providerTranscriptRoot;
    this.claudeBin = options.claudeBin ?? "claude";
    this.hostId = options.hostId ?? hostname();
    this.minimumRuntimeVersion = options.minimumRuntimeVersion ?? CLAUDE_CROSS_SESSION_MIN_RUNTIME_VERSION;
    if (parseRuntimeVersion(this.minimumRuntimeVersion) === null) throw new Error("Claude minimum runtime version が不正です");
    this.bindingTtlSeconds = validateBindingTtl(options.bindingTtlSeconds);
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.discoveryPollIntervalMs = options.discoveryPollIntervalMs ?? DEFAULT_DISCOVERY_POLL_INTERVAL_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.discoveryTimeoutMs) || this.discoveryTimeoutMs < 0) throw new Error("discoveryTimeoutMs が不正です");
    if (!Number.isSafeInteger(this.discoveryPollIntervalMs) || this.discoveryPollIntervalMs < 0) throw new Error("discoveryPollIntervalMs が不正です");
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) throw new Error("commandTimeoutMs が不正です");
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.spawner = options.spawner ?? defaultSpawner;
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.nameFactory = options.nameFactory ?? ((task, sessionId) => `hachi-${task.id}-${sessionId.slice(0, 8)}-worker`);
    this.clock = options.clock ?? defaultClock();
    this.stopSpawnedWorker = options.stopSpawnedWorker ?? terminateProcessGroup;
    this.relayExecutor = options.relayExecutor;
    this.relaySource = options.relaySource;
    if (this.relaySource !== undefined) validateRelaySource(this.relaySource);
  }

  private async runtimeVersion(): Promise<string> {
    const result = await this.commandRunner(this.claudeBin, ["--version"], { timeoutMs: this.commandTimeoutMs });
    if (result.exitCode !== 0 || result.error !== undefined) throw new Error(commandFailureDetail(result, "claude --version"));
    const version = parseClaudeRuntimeVersion(result.stdout);
    if (version === null) throw new Error("claude --version の runtime version が不明です");
    if (compareRuntimeVersion(version, this.minimumRuntimeVersion) < 0) {
      throw new Error(`Claude runtime version が最低要件未満です: ${version}`);
    }
    return version;
  }

  private async listAgents(): Promise<ClaudeAgentList> {
    // `--all` is still the public agents JSON surface and keeps discovery
    // deterministic when a freshly spawned background session briefly changes
    // state. Completed entries are parsed but never selected without exact
    // session/ref/name binding.
    const result = await this.commandRunner(this.claudeBin, ["agents", "--json", "--all"], { timeoutMs: this.commandTimeoutMs });
    if (result.exitCode !== 0 || result.error !== undefined) throw new Error(commandFailureDetail(result, "claude agents --json"));
    return parseClaudeAgentsJson(result.stdout);
  }

  private async discoverTarget(
    sessionId: string,
    name: string,
    runtimeVersion: string,
    startedAt: number,
  ): Promise<ClaudeAgentEntry> {
    const capabilityHash = computeClaudeCrossSessionCapabilityHash(runtimeVersion);
    const deadline = Date.now() + this.discoveryTimeoutMs;
    let lastFailure = "agent list に exact target がありません";
    while (true) {
      const list = await this.listAgents();
      const target = list.agents.find((agent) => agent.sessionId === sessionId);
      if (target !== undefined) {
        if (target.name !== name) throw new Error("Claude worker の sessionId/name binding が一致しません");
        if (target.inboundAccepted === false) {
          throw new Error("Claude worker の crossSessionInbound policy がconfigured launch settingsを拒否しています");
        }
        if (target.runtimeVersion !== null && target.runtimeVersion !== runtimeVersion) {
          throw new Error("Claude worker の runtime version evidence が起動時 version と一致しません");
        }
        if (target.capabilityHash !== null && target.capabilityHash !== capabilityHash) {
          throw new Error("Claude worker の capability hash が一致しません");
        }
        return target;
      }
      if (list.agents.some((agent) => agent.name === name)) {
        lastFailure = "Claude worker name が別 session と衝突しています";
      }
      if (Date.now() >= deadline) throw new Error(lastFailure);
      await this.clock.sleep(this.discoveryPollIntervalMs);
      void startedAt;
    }
  }

  async launch(task: TaskRow, options: LaunchOptions): Promise<SessionRef> {
    const sessionId = this.sessionIdFactory();
    if (!isUuid(sessionId)) throw new Error("Claude cross-session provider sessionId は UUID でなければなりません");
    const name = this.nameFactory(task, sessionId);
    assertNonEmpty(name, "Claude worker name");
    const runtimeVersion = await this.runtimeVersion();
    if (this.providerTranscriptRoot === undefined) {
      throw new Error("Claude cross-session provider transcript root が未構成です。external spawn 前に停止しました");
    }
    const hookPaths = installClaudeTranscriptHook(this.stateDir, sessionId, this.providerTranscriptRoot);
    const settings: {
      crossSessionInbound: "accept";
      fastMode?: boolean;
      hooks: ReturnType<typeof buildClaudeStopHookSettings>["hooks"];
    } = {
      crossSessionInbound: "accept",
      ...buildClaudeStopHookSettings(hookPaths),
    };
    if (options.speed !== undefined) settings.fastMode = options.speed === "fast";
    const args: string[] = [
      "--bg",
      "--name",
      name,
      "--session-id",
      sessionId,
      "--model",
      options.model,
    ];
    if (options.effort !== undefined) args.push("--effort", options.effort);
    args.push(
      "--settings",
      JSON.stringify(settings),
      // `--bare` は意図的に付けない。session inbox / runtime policy を維持する non-bare worker。
      options.promptText,
    );
    const spawned = await this.spawner({ executable: this.claudeBin, args, cwd: options.cwd });
    try {
      if (!Number.isSafeInteger(spawned.pid) || spawned.pid <= 1) {
        throw new Error("Claude cross-session worker pid が不正です");
      }
      const startedAt = this.clock.nowSeconds();
      const agent = await this.discoverTarget(sessionId, name, runtimeVersion, startedAt);
      const observedAt = this.clock.nowSeconds();
      const expiresAt = observedAt + this.bindingTtlSeconds;
      const capabilityHash = computeClaudeCrossSessionCapabilityHash(runtimeVersion);
      const state: ClaudeCrossSessionState = {
        providerSessionId: sessionId,
        agentName: name,
        agentRef: agent.agentRef,
        model: options.model,
        cwd: options.cwd,
        pid: spawned.pid,
        runtimeVersion,
        capabilityHash,
        crossSessionInbound: "accept",
        hostId: this.hostId,
        observedAt,
        expiresAt,
      };
      writeState(this.stateDir, state);
      const nativeCommunication: NativeCommunicationSessionRef = {
        route: "claude-cross-session",
        providerSessionId: sessionId,
        agentRef: agent.agentRef,
        runtimeVersion,
        capabilityHash,
        hostId: this.hostId,
        observedAt,
        expiresAt,
      };
      return {
        provider: "claude",
        sessionId,
        serverUrl: "direct",
        model: options.model,
        modelDelivery: "native",
        ...(options.effort !== undefined ? { effortDelivery: "native" as const } : {}),
        ...(options.speed !== undefined ? { speedDelivery: "native" as const } : {}),
        nativeCommunication,
        startedAt,
      };
    } catch (error) {
      // --bg は detached なので、discovery / state failure をそのまま返すと
      // board に未登録の Claude worker を残す。spawner が返した exact stop hook
      // を優先し、無い DI でも exact PID の process group だけを回収する。
      try {
        if (spawned.stop !== undefined) {
          await spawned.stop();
        } else {
          await this.stopSpawnedWorker(spawned.pid);
        }
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : "Claude worker launch failed";
        const cleanup = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure";
        throw new Error(`${primary}; exact spawned worker cleanup failed: ${cleanup}`);
      }
      throw error;
    }
  }

  private validatedAgentForRef(ref: SessionRef, list: ClaudeAgentList, now: number): ClaudeAgentEntry | null {
    const target = targetFromRef(ref);
    if (target === null || target.expiresAt <= now) return null;
    // delivery requestのhachiSessionIdはcontrol-planeのexact run bindingであり、
    // providerのstate artifactのaddressはnative targetのproviderSessionIdが正本。
    const state = readState(this.stateDir, target.providerSessionId);
    if (state === null) return null;
    const entry = list.agents.find((agent) => agent.sessionId === target.providerSessionId);
    if (entry === undefined) return null;
    const capabilityHash = computeClaudeCrossSessionCapabilityHash(target.runtimeVersion);
    if (!targetRecordMatches(entry, target, state, target.runtimeVersion, capabilityHash)) return null;
    if (state.providerSessionId !== target.providerSessionId
      || state.agentRef !== target.agentRef
      || state.runtimeVersion !== target.runtimeVersion
      || state.capabilityHash !== target.capabilityHash
      || state.crossSessionInbound !== "accept") return null;
    return entry;
  }

  async status(ref: SessionRef): Promise<SessionStatus> {
    const target = targetFromRef(ref);
    if (target === null) return { state: "unknown", lastActivityAt: null };
    try {
      const runtimeVersion = await this.runtimeVersion();
      if (runtimeVersion !== target.runtimeVersion) return { state: "unknown", lastActivityAt: null };
      const list = await this.listAgents();
      const entry = this.validatedAgentForRef(ref, list, this.clock.nowSeconds());
      return entry === null ? { state: "unknown", lastActivityAt: null } : statusFromAgent(entry);
    } catch {
      return { state: "unknown", lastActivityAt: null };
    }
  }

  async fetchTranscript(ref: SessionRef): Promise<string> {
    const target = targetFromRef(ref);
    if (target === null || target.providerSessionId !== ref.sessionId) {
      throw new Error("Claude Stop hook transcript の exact session binding がありません");
    }
    return readClaudeTranscriptCapture(this.stateDir, target.providerSessionId);
  }

  async inject(ref: SessionRef, message: string): Promise<void> {
    void ref;
    void message;
    throw new Error("Claude cross-session の inject は live orchestrator の SendMessage relay 経由のみ対応します");
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.runtimeVersion();
      return true;
    } catch {
      return false;
    }
  }

  async stop(ref: SessionRef): Promise<StopResult> {
    void ref;
    // `claude agents --json` は read-only list であり、stop/kill の公開 CLI 面を提供しない。
    // daemon socket や内部 task id を推測して停止しない。
    return { stopped: false, reason: "unsupported" };
  }

  async probe(ref: SessionRef, now: number): Promise<NativeCommunicationProbeResult> {
    const target = targetFromRef(ref);
    if (target === null) return { state: "unsupported", detail: "Claude native route/binding がありません" };
    if (target.expiresAt <= now) return { state: "unsupported", detail: "Claude native target binding が期限切れです" };
    if (target.hostId !== this.hostId) return { state: "unsupported", detail: "Claude native target が別 host です" };
    try {
      const runtimeVersion = await this.runtimeVersion();
      if (runtimeVersion !== target.runtimeVersion) {
        return { state: "unsupported", detail: "Claude runtime version drift" };
      }
      const list = await this.listAgents();
      const entry = this.validatedAgentForRef(ref, list, now);
      if (entry === null) return { state: "unsupported", detail: "Claude exact session/agent ref または owned launch evidence がありません" };
      const observedAt = now;
      const expiresAt = now + this.bindingTtlSeconds;
      const capabilityHash = computeClaudeCrossSessionCapabilityHash(runtimeVersion);
      return {
        state: "supported",
        detail: "Claude cross-session exact binding と Hachi-owned inbound launch evidence を確認しました",
        target: {
          route: "claude-cross-session",
          providerSessionId: target.providerSessionId,
          agentRef: target.agentRef,
          runtimeVersion,
          capabilityHash,
          hostId: target.hostId,
          observedAt,
          expiresAt,
        },
      };
    } catch (error) {
      return {
        state: "unknown",
        detail: error instanceof Error ? error.message : "Claude native capability probe に失敗しました",
      };
    }
  }

  async deliver(input: NativeCommunicationDeliveryRequest): Promise<NativeCommunicationDeliveryResult> {
    if (this.relayExecutor === undefined || this.relaySource === undefined) {
      return { outcome: "rejected", detail: "Claude SendMessage は active Claude orchestrator の relay executor が必要です" };
    }
    const now = this.clock.nowSeconds();
    if (input.target.route !== "claude-cross-session" || input.target.expiresAt <= now) {
      return { outcome: "rejected", detail: "Claude relay target binding が不正または期限切れです" };
    }
    const probe = await this.probe({
      provider: "claude",
      sessionId: input.hachiSessionId,
      serverUrl: "direct",
      model: "unknown",
      modelDelivery: "native",
      nativeCommunication: input.target,
      startedAt: now,
    }, now);
    if (probe.state !== "supported") {
      return { outcome: "rejected", detail: `Claude relay probe failed: ${probe.detail}` };
    }
    const envelope = createClaudeRelayEnvelope(input, this.relaySource, input.target.expiresAt);
    const prompt = buildClaudeRelayPrompt(envelope);
    let execution: string | ClaudeRelayExecutionEvidence;
    try {
      execution = await this.relayExecutor.execute(prompt, envelope, { allowedTools: CLAUDE_RELAY_ALLOWED_TOOLS });
    } catch {
      return { outcome: "uncertain", detail: "Claude live orchestrator relay executor が異常終了しました" };
    }
    if (typeof execution === "string") {
      // 公開 CLI が返す model text は prompt-generated receipt に過ぎず、
      // ListAgents/SendMessage の実行・結果・receiver observation を証明しない。
      // ここで transport_accepted/acknowledged に丸めると二重配送を招くため uncertain。
      return { outcome: "uncertain", detail: CLAUDE_RELAY_PUBLIC_CLI_LIMITATION };
    }
    const verified = verifyClaudeRelayExecutionEvidence(execution, envelope);
    return verified.ok ? verified.delivery : { outcome: "uncertain", detail: verified.detail };
  }
}

/** 親 package が route 名で adapter を参照する場合の別名。 */
export const ClaudeCrossSessionAdapter = ClaudeCrossSessionWorkerAdapter;

/** Relay 側だけを明示したい caller 向けの別名。 */
export const ClaudeCrossSessionRelayAdapter = ClaudeCrossSessionWorkerAdapter;
export const ClaudeCrossSessionCommunicationAdapter = ClaudeCrossSessionWorkerAdapter;
export const ClaudeCrossSessionNativeAdapter = ClaudeCrossSessionWorkerAdapter;
