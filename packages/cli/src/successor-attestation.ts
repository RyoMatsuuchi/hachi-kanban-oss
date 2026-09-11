// =============================================================================
// Codex SessionStart attestation の実機依存。
// command 自体の検証・Store CAS は commands/orchestrator.ts に置き、stdin/tmux/fs/host/hash は
// この narrow adapter を CliDeps へ注入して offline test から完全に切り離す。
// =============================================================================

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import type { OrchestratorSuccessorLaunchRow } from "@hachi/core";
import { parseStrictJson } from "./strict-json.js";
import type {
  CliDeps,
  CliStdinReader,
  SuccessorAttestationHashProbe,
  SuccessorTmuxReadback,
  SuccessorTmuxReadbackFailureReason,
  SuccessorTmuxReadbackResult,
} from "./deps.js";

const TMUX_OWNER_OPTION = "@hachi_handoff_owner";
const TMUX_SERVER_LIFETIME_OPTION = "@hachi_runtime_lifetime_v1";
const TMUX_SERVER_LIFETIME_HASH_DOMAIN = "hachi-tmux-server-lifetime-v1\0";
const TMUX_FIELD_SEPARATOR = "\u001f";
const SESSION_START_STDIN_MAX_BYTES = 16_384;
const AUTHORITY_JSON_MAX_DEPTH = 64;
const SERVER_LIFETIME_NONCE = /^[A-Za-z0-9_-]{43}$/;

function parsePositiveInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface TmuxSnapshot {
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  cwd: string;
  ownerNonce: string;
  tmuxSocketPath: string;
  tmuxServerPid: number;
}

export interface SuccessorAttestationCommandRunner {
  run(command: "tmux" | "ps", args: readonly string[]): string;
}

const defaultCommandRunner: SuccessorAttestationCommandRunner = {
  run(command: "tmux" | "ps", args: readonly string[]): string {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(command === "ps" ? { env: { ...process.env, LC_ALL: "C" } } : {}),
    });
  },
};

function singleLine(output: string): string | null {
  const normalized = output.endsWith("\r\n") ? output.slice(0, -2) :
    output.endsWith("\n") ? output.slice(0, -1) : output;
  return normalized.includes("\n") || normalized.includes("\r") ? null : normalized;
}

function readTmuxSnapshot(
  commandRunner: SuccessorAttestationCommandRunner,
  tmuxPane: string,
  canonicalizeSocketPath: (path: string) => string,
): TmuxSnapshot | null {
  try {
    const output = commandRunner.run(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        tmuxPane,
        "-F",
        `#{session_name}${TMUX_FIELD_SEPARATOR}#{pane_id}${TMUX_FIELD_SEPARATOR}` +
          `#{pane_pid}${TMUX_FIELD_SEPARATOR}#{pane_current_path}${TMUX_FIELD_SEPARATOR}` +
          `#{${TMUX_OWNER_OPTION}}${TMUX_FIELD_SEPARATOR}#{socket_path}${TMUX_FIELD_SEPARATOR}#{pid}`,
      ],
    );
    const normalized = singleLine(output);
    if (normalized === null) return null;
    const fields = normalized.split(TMUX_FIELD_SEPARATOR);
    if (fields.length !== 7) return null;
    const [
      tmuxSession = "",
      observedPane = "",
      rawPid = "",
      cwd = "",
      ownerNonce = "",
      rawSocketPath = "",
      rawServerPid = "",
    ] = fields;
    const panePid = parsePositiveInteger(rawPid);
    const tmuxServerPid = parsePositiveInteger(rawServerPid);
    if (tmuxSession === "" || observedPane !== tmuxPane || panePid === null || cwd === "" ||
        !isAbsolute(rawSocketPath) || tmuxServerPid === null) {
      return null;
    }
    const tmuxSocketPath = canonicalizeSocketPath(rawSocketPath);
    if (!isAbsolute(tmuxSocketPath)) return null;
    return {
      tmuxSession,
      tmuxPane: observedPane,
      panePid,
      cwd,
      ownerNonce,
      tmuxSocketPath,
      tmuxServerPid,
    };
  } catch {
    return null;
  }
}

function readProcessGroupId(
  commandRunner: SuccessorAttestationCommandRunner,
  panePid: number,
): number | null {
  try {
    const output = commandRunner.run("ps", ["-o", "pgid=", "-p", String(panePid)]);
    return parsePositiveInteger(output.trim());
  } catch {
    return null;
  }
}

function readServerStartTime(
  commandRunner: SuccessorAttestationCommandRunner,
  serverPid: number,
): number | null {
  try {
    const output = commandRunner.run("ps", ["-p", String(serverPid), "-o", "lstart="]);
    const value = singleLine(output)?.trim() ?? "";
    if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(value)) {
      return null;
    }
    const parsed = Math.floor(Date.parse(value) / 1_000);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readServerLifetimeNonce(
  commandRunner: SuccessorAttestationCommandRunner,
): { ok: true; nonce: string } | { ok: false; reason: "missing" | "malformed" } {
  let output: string;
  try {
    output = commandRunner.run("tmux", ["show-options", "-s", "-v", TMUX_SERVER_LIFETIME_OPTION]);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const value = singleLine(output);
  if (value === null) return { ok: false, reason: "malformed" };
  if (value === "") return { ok: false, reason: "missing" };
  return SERVER_LIFETIME_NONCE.test(value)
    ? { ok: true, nonce: value }
    : { ok: false, reason: "malformed" };
}

function hashServerLifetime(canonicalSocketPath: string, nonce: string): string {
  return createHash("sha256")
    .update(`${TMUX_SERVER_LIFETIME_HASH_DOMAIN}${canonicalSocketPath}\0${nonce}`)
    .digest("hex");
}

function readStableExactPane(
  commandRunner: SuccessorAttestationCommandRunner,
  tmuxPane: string,
  canonicalizeSocketPath: (path: string) => string,
): SuccessorTmuxReadbackResult {
  const before = readTmuxSnapshot(commandRunner, tmuxPane, canonicalizeSocketPath);
  if (before === null) return { ok: false, reason: "unavailable" };
  const beforeLifetime = readServerLifetimeNonce(commandRunner);
  if (!beforeLifetime.ok) return beforeLifetime;
  const serverStartBefore = readServerStartTime(commandRunner, before.tmuxServerPid);
  if (serverStartBefore === null) return { ok: false, reason: "unavailable" };
  const processGroupId = readProcessGroupId(commandRunner, before.panePid);
  if (processGroupId === null) return { ok: false, reason: "unavailable" };
  const serverStartAfter = readServerStartTime(commandRunner, before.tmuxServerPid);
  if (serverStartAfter === null) return { ok: false, reason: "unavailable" };
  const afterLifetime = readServerLifetimeNonce(commandRunner);
  if (!afterLifetime.ok) {
    return { ok: false, reason: afterLifetime.reason === "missing" ? "drift" : "malformed" };
  }
  const after = readTmuxSnapshot(commandRunner, tmuxPane, canonicalizeSocketPath);
  if (after === null) return { ok: false, reason: "unavailable" };

  const serverIdentityStable = before.tmuxSocketPath === after.tmuxSocketPath &&
    before.tmuxServerPid === after.tmuxServerPid &&
    serverStartBefore === serverStartAfter &&
    beforeLifetime.nonce === afterLifetime.nonce;
  if (!serverIdentityStable) return { ok: false, reason: "drift" };
  if (JSON.stringify(before) !== JSON.stringify(after)) return { ok: false, reason: "unavailable" };

  return {
    ok: true,
    value: {
      ...after,
      processGroupId,
      tmuxServerStartTime: serverStartAfter,
      tmuxServerLifetimeHash: hashServerLifetime(after.tmuxSocketPath, afterLifetime.nonce),
    },
  };
}

/** tmux→ps→tmux の前後で server lifetime を含む全 identity が固定された時だけ返す実 adapter。 */
export function createSuccessorTmuxReadback(
  commandRunner: SuccessorAttestationCommandRunner,
  canonicalizeSocketPath: (path: string) => string = realpathSync,
): SuccessorTmuxReadback {
  return {
    readExactPane(tmuxPane: string): SuccessorTmuxReadbackResult {
      return readStableExactPane(commandRunner, tmuxPane, canonicalizeSocketPath);
    },
    initializeServerLifetimeAndReadExactPane(
      tmuxPane: string,
      nonceCandidate: string,
    ): SuccessorTmuxReadbackResult {
      if (!SERVER_LIFETIME_NONCE.test(nonceCandidate)) {
        return { ok: false, reason: "malformed" };
      }
      try {
        commandRunner.run(
          "tmux",
          ["set-option", "-s", "-o", TMUX_SERVER_LIFETIME_OPTION, nonceCandidate],
        );
      } catch {
        // -o の競合は既存値が勝者。直後の show-options readback が成否を決める。
      }
      return readStableExactPane(commandRunner, tmuxPane, canonicalizeSocketPath);
    },
  };
}

export const defaultSuccessorTmuxReadback = createSuccessorTmuxReadback(defaultCommandRunner);

/** process.stdin を byte 上限付きで読む。上限到達後も読み続けず、即座に fail-closed する。 */
export function createProcessStdinReader(stream: NodeJS.ReadableStream = process.stdin): CliStdinReader {
  return {
    async read(maxBytes: number): Promise<string> {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new Error(`SessionStart hook stdin は ${maxBytes} bytes 以下が必須です`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function hashFile(path: string, readFile: (path: string) => Buffer): string {
  const bytes = readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Gate 4 の共通 resolver が返す canonical path だけを受け取る file hash probe。 */
export function createSuccessorAttestationHashProbe(
  hookDefinitionPath: string,
  helperExecutablePath: string,
  readFile: (path: string) => Buffer = readFileSync,
): SuccessorAttestationHashProbe {
  return {
    readInstalledHashes(): { hookDefinitionHash: string; hookExecutableHash: string } {
      return {
        hookDefinitionHash: hashFile(hookDefinitionPath, readFile),
        hookExecutableHash: hashFile(helperExecutablePath, readFile),
      };
    },
  };
}

/** Gate 4 publication 前は artifact を推測せず、production helper を明示的に閉じる。 */
export const unconfiguredSuccessorAttestationHashProbe: SuccessorAttestationHashProbe = {
  readInstalledHashes(): never {
    throw new Error("Codex successor attestation hash probe は Gate 4 publication 前のため未構成です");
  },
};

export function defaultCurrentHostId(): string {
  return hostname();
}

export function defaultCanonicalizeSuccessorCwd(path: string): string {
  return realpathSync(path);
}

interface SessionStartHookInput {
  sessionId: string;
  cwd: string;
  source: "startup" | "resume" | "compact" | "clear";
}

const SESSION_START_ALLOWED_KEYS = new Set([
  "session_id",
  "cwd",
  "source",
  "hook_event_name",
  "transcript_path",
  "model",
  "permission_mode",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function successorServerLifetimeMismatchMessage(
  slotId: string,
  observed: Exclude<SuccessorTmuxReadbackFailureReason, "unavailable">,
): string {
  return `SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=${slotId} expected=known observed=${observed}; ` +
    "attestation/final authority=0; exact rollback required";
}

function boundedHookString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value === "" || value.length > maxLength || value.includes("\0")) {
    throw new Error(`SessionStart hook ${field} のschemaが不正です`);
  }
  return value;
}

function parseSessionStartHookInput(raw: string): SessionStartHookInput {
  if (raw === "" || Buffer.byteLength(raw, "utf8") > SESSION_START_STDIN_MAX_BYTES) {
    throw new Error(`SessionStart hook stdin は1〜${SESSION_START_STDIN_MAX_BYTES} bytesが必須です`);
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw, {
      maxBytes: SESSION_START_STDIN_MAX_BYTES,
      maxDepth: AUTHORITY_JSON_MAX_DEPTH,
      maxTokens: SESSION_START_STDIN_MAX_BYTES,
    });
  } catch {
    throw new Error("SessionStart hook stdin は単一のJSON objectが必須です");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SessionStart hook stdin は単一のJSON objectが必須です");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.hasOwn(record, "agent_id")) {
    throw new Error("agent_id 付き hook input は root SessionStart authority ではありません");
  }
  const unknownKeys = Object.keys(record).filter((key) => !SESSION_START_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error("SessionStart hook stdin に未許可fieldがあります");
  }
  const hookEventName = boundedHookString(record["hook_event_name"], "hook_event_name", 64);
  if (hookEventName === "SubagentStart") {
    throw new Error("SubagentStart は root SessionStart authority ではありません");
  }
  if (hookEventName !== "SessionStart") {
    throw new Error("hook_event_name=SessionStart が必須です");
  }
  const source = boundedHookString(record["source"], "source", 32);
  if (!(<readonly string[]>["startup", "resume", "compact", "clear"]).includes(source)) {
    throw new Error("SessionStart hook source は startup/resume/compact/clear のみです");
  }
  if (record["transcript_path"] !== undefined && record["transcript_path"] !== null) {
    boundedHookString(record["transcript_path"], "transcript_path", 8_192);
  }
  if (record["model"] !== undefined) boundedHookString(record["model"], "model", 256);
  if (record["permission_mode"] !== undefined) {
    const permissionMode = boundedHookString(record["permission_mode"], "permission_mode", 32);
    if (!["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"].includes(permissionMode)) {
      throw new Error("SessionStart hook permission_mode のschemaが不正です");
    }
  }
  return {
    sessionId: boundedHookString(record["session_id"], "session_id", 512),
    cwd: boundedHookString(record["cwd"], "cwd", 8_192),
    source: source as SessionStartHookInput["source"],
  };
}

function isConsumedResume(
  deps: CliDeps,
  input: {
    providerSessionId: string;
    canonicalCwd: string;
    hostId: string;
    tmuxSession: string;
    tmuxPane: string;
    panePid: number;
    processGroupId: number;
    tmuxSocketPath: string;
    tmuxServerPid: number;
    tmuxServerStartTime: number;
    tmuxServerLifetimeHash: string;
    ownerNonceHash: string;
    hookDefinitionHash: string;
    hookExecutableHash: string;
  },
): boolean {
  const matches = deps.store.listSuccessorLaunches().filter((launch) =>
    launch.targetProvider === "codex" &&
    launch.providerSessionSource === "codex-session-start" &&
    launch.providerSessionId === input.providerSessionId &&
    launch.attestationConsumedAt !== null &&
    launch.status === "succeeded" &&
    launch.canonicalCwd === input.canonicalCwd &&
    launch.observedCanonicalCwd === input.canonicalCwd &&
    launch.hostId === input.hostId &&
    launch.observedHostId === input.hostId &&
    launch.tmuxSession === input.tmuxSession &&
    launch.tmuxPane === input.tmuxPane &&
    launch.panePid === input.panePid &&
    launch.processGroupId === input.processGroupId &&
    launch.tmuxSocketPath === input.tmuxSocketPath &&
    launch.tmuxServerPid === input.tmuxServerPid &&
    launch.tmuxServerStartTime === input.tmuxServerStartTime &&
    launch.tmuxServerLifetimeHash === input.tmuxServerLifetimeHash &&
    launch.ownerNonceHash === input.ownerNonceHash &&
    launch.hookDefinitionHash === input.hookDefinitionHash &&
    launch.observedHookDefinitionHash === input.hookDefinitionHash &&
    launch.hookExecutableHash === input.hookExecutableHash &&
    launch.observedHookExecutableHash === input.hookExecutableHash
  );
  return matches.length === 1;
}

function lifetimeFailureSlot(
  deps: CliDeps,
  input: {
    source: SessionStartHookInput["source"];
    canonicalCwd: string;
    hostId: string;
    tmuxPane: string;
    hookDefinitionHash: string;
    hookExecutableHash: string;
  },
): string {
  const matches = deps.store.listSuccessorLaunches().filter((launch) =>
    launch.targetProvider === "codex" &&
    launch.canonicalCwd === input.canonicalCwd &&
    launch.observedCanonicalCwd === input.canonicalCwd &&
    launch.hostId === input.hostId &&
    launch.observedHostId === input.hostId &&
    launch.tmuxPane === input.tmuxPane &&
    launch.hookDefinitionHash === input.hookDefinitionHash &&
    launch.observedHookDefinitionHash === input.hookDefinitionHash &&
    launch.hookExecutableHash === input.hookExecutableHash &&
    launch.observedHookExecutableHash === input.hookExecutableHash &&
    (input.source === "startup"
      ? launch.status === "runtime_bound"
      : ["attested", "accepting", "succeeded"].includes(launch.status))
  );
  return matches.length === 1 ? matches[0]!.id : "unknown";
}

function nonServerRuntimeMatches(
  launch: OrchestratorSuccessorLaunchRow,
  input: {
    providerSessionId: string;
    canonicalCwd: string;
    hostId: string;
    tmuxSession: string;
    tmuxPane: string;
    panePid: number;
    processGroupId: number;
    ownerNonceHash: string;
    hookDefinitionHash: string;
    hookExecutableHash: string;
  },
  source: SessionStartHookInput["source"],
): boolean {
  return launch.targetProvider === "codex" &&
    launch.canonicalCwd === input.canonicalCwd &&
    launch.observedCanonicalCwd === input.canonicalCwd &&
    launch.hostId === input.hostId && launch.observedHostId === input.hostId &&
    launch.tmuxSession === input.tmuxSession && launch.tmuxPane === input.tmuxPane &&
    launch.hookDefinitionHash === input.hookDefinitionHash &&
    launch.observedHookDefinitionHash === input.hookDefinitionHash &&
    launch.hookExecutableHash === input.hookExecutableHash &&
    launch.observedHookExecutableHash === input.hookExecutableHash &&
    (source === "startup"
      ? launch.status === "runtime_bound"
      : launch.providerSessionId === input.providerSessionId &&
        ["attested", "accepting", "succeeded"].includes(launch.status));
}

function assertServerLifetimeMatches(
  deps: CliDeps,
  identity: {
    providerSessionId: string;
    canonicalCwd: string;
    hostId: string;
    tmuxSession: string;
    tmuxPane: string;
    panePid: number;
    processGroupId: number;
    tmuxSocketPath: string;
    tmuxServerPid: number;
    tmuxServerStartTime: number;
    tmuxServerLifetimeHash: string;
    ownerNonceHash: string;
    hookDefinitionHash: string;
    hookExecutableHash: string;
  },
  source: SessionStartHookInput["source"],
): void {
  const matches = deps.store.listSuccessorLaunches().filter((launch) =>
    nonServerRuntimeMatches(launch, identity, source)
  );
  if (matches.length !== 1) return;
  const launch = matches[0]!;
  if (launch.tmuxSocketPath !== identity.tmuxSocketPath ||
      launch.tmuxServerPid !== identity.tmuxServerPid ||
      launch.tmuxServerStartTime !== identity.tmuxServerStartTime ||
      launch.tmuxServerLifetimeHash !== identity.tmuxServerLifetimeHash) {
    throw new Error(successorServerLifetimeMismatchMessage(launch.id, "drift"));
  }
}

/** `hachi orchestrator successor-launch attest` の静的 helper 本体。 */
export async function runSuccessorLaunchAttest(deps: CliDeps): Promise<void> {
  const raw = await deps.stdin.read(SESSION_START_STDIN_MAX_BYTES);
  const hook = parseSessionStartHookInput(raw);
  // compact/clear は正常な authority 0。stdout を空にして Codex hook protocol の no-op とする。
  if (hook.source === "compact" || hook.source === "clear") return;

  const tmuxPane = deps.processEnv.TMUX_PANE;
  if (typeof tmuxPane !== "string" || !/^%[0-9]+$/.test(tmuxPane)) {
    throw new Error("TMUX_PANE は ^%[0-9]+$ の exact pane locator が必須です");
  }
  const canonicalHookCwd = deps.canonicalizeSuccessorCwd(hook.cwd);
  if (!isAbsolute(canonicalHookCwd)) throw new Error("SessionStart hook cwd をcanonical化できません");
  const hostId = deps.currentHostId().trim();
  if (hostId === "") throw new Error("current host ID を確認できません");
  const hashes = deps.successorAttestationHashProbe.readInstalledHashes();
  if (!/^[0-9a-f]{64}$/.test(hashes.hookDefinitionHash) ||
      !/^[0-9a-f]{64}$/.test(hashes.hookExecutableHash)) {
    throw new Error("install 済み hook definition/helper hash を確認できません");
  }
  const readbackResult = deps.successorTmuxReadback.readExactPane(tmuxPane);
  if (!readbackResult.ok) {
    if (readbackResult.reason !== "unavailable") {
      const slotId = lifetimeFailureSlot(deps, {
        source: hook.source,
        canonicalCwd: canonicalHookCwd,
        hostId,
        tmuxPane,
        hookDefinitionHash: hashes.hookDefinitionHash,
        hookExecutableHash: hashes.hookExecutableHash,
      });
      throw new Error(successorServerLifetimeMismatchMessage(slotId, readbackResult.reason));
    }
    throw new Error("exact tmux pane runtime identity を読み返せません");
  }
  const readback = readbackResult.value;
  if (readback.tmuxPane !== tmuxPane || readback.tmuxSession === "" ||
      !Number.isSafeInteger(readback.panePid) || readback.panePid <= 0 ||
      !Number.isSafeInteger(readback.processGroupId) || readback.processGroupId <= 0 ||
      !isAbsolute(readback.tmuxSocketPath) ||
      !Number.isSafeInteger(readback.tmuxServerPid) || readback.tmuxServerPid <= 0 ||
      !Number.isSafeInteger(readback.tmuxServerStartTime) || readback.tmuxServerStartTime <= 0 ||
      !/^[0-9a-f]{64}$/.test(readback.tmuxServerLifetimeHash)) {
    throw new Error("exact tmux pane runtime identity を読み返せません");
  }
  const canonicalTmuxCwd = deps.canonicalizeSuccessorCwd(readback.cwd);
  if (canonicalHookCwd !== canonicalTmuxCwd) {
    throw new Error("SessionStart hook cwd と exact tmux pane cwd が一致しません");
  }
  const identity = {
    providerSessionId: hook.sessionId,
    canonicalCwd: canonicalHookCwd,
    hostId,
    tmuxSession: readback.tmuxSession,
    tmuxPane: readback.tmuxPane,
    panePid: readback.panePid,
    processGroupId: readback.processGroupId,
    tmuxSocketPath: readback.tmuxSocketPath,
    tmuxServerPid: readback.tmuxServerPid,
    tmuxServerStartTime: readback.tmuxServerStartTime,
    tmuxServerLifetimeHash: readback.tmuxServerLifetimeHash,
    ownerNonceHash: sha256(readback.ownerNonce),
    hookDefinitionHash: hashes.hookDefinitionHash,
    hookExecutableHash: hashes.hookExecutableHash,
  };
  assertServerLifetimeMatches(deps, identity, hook.source);
  if (readback.ownerNonce === "") throw new Error("exact tmux pane owner identity を読み返せません");
  const attested = deps.store.attestSuccessorLaunch({
    providerSessionSource: "codex-session-start",
    source: hook.source,
    ...identity,
  });
  if (attested === null) {
    if (hook.source === "resume" && isConsumedResume(deps, identity)) return;
    throw new Error("Codex successor attestation authority を一意に確認できません");
  }
  // raw handle を出せる唯一の面。launch row、text log、通常のCLI JSON envelopeへは混ぜない。
  deps.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Hachi successor attestation handle: ${attested.attestationHandle}`,
    },
  })}\n`);
}
