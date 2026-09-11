// Claude hook payload を G2 relay の bounded ingress event へ変換する adapter。
// hook の設定・relay transport・registry の所有権は外から注入し、このモジュールでは変換と安全境界だけを担う。
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import {
  redactText,
  type RelayIngressEvent,
  type RelayIngressEventKind,
  type RelayJsonValue,
  type RelayOwnerFence,
} from "@hachi/core";

export const DEFAULT_CLAUDE_HOOK_RELAY_TIMEOUT_MS = 250;
export const CLAUDE_HOOK_ENABLE_RECORD_MAX_BYTES = 4 * 1024;
export const CLAUDE_HOOK_TEXT_MAX_BYTES = 16 * 1024;
export const CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES = 2 * 1024;
export const CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES = 1024;

const MAX_IDENTIFIER_BYTES = 512;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_NOTIFICATION_TEXT_BYTES = 1024;
const MAX_ERROR_TEXT_BYTES = 2048;
const TRUNCATION_MARKER = "…[truncated]";
const REDACTED_MARKER = "[REDACTED]";

const SUPPORTED_HOOK_EVENTS = new Set<string>([
  "MessageDisplay",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SessionStart",
  "StopFailure",
  "SessionEnd",
]);

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|authorization|password|passwd|secret|credential|private[_-]?key|database[_-]?url)/i;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential|private[_-]?key|database[_-]?url)/i;
const ASSIGNMENT_PREFIX_PATTERN = /(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|\b([A-Za-z0-9_-]+)\b)[ \t]*[:=][ \t]*/g;
const URL_USERINFO_PATTERN = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]*@/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g;

export interface ClaudeHookEnableRecord {
  sessionId: string;
  providerSessionId: string;
  handoverGeneration: number;
  relayId: string;
  /** epoch 秒。この時刻と同値になった時点で無効。 */
  expiresAt: number;
}

export interface ClaudeHookRelayEmitter {
  emit(event: RelayIngressEvent, signal: AbortSignal): Promise<void>;
  unregister(owner: RelayOwnerFence, signal: AbortSignal): Promise<void>;
}

export interface ClaudeHookRelayAdapterOptions {
  owner: RelayOwnerFence;
  readEnableRecord: () => unknown;
  emitter: ClaudeHookRelayEmitter;
  now?: () => number;
  timeoutMs?: number;
  initialSequence?: number;
}

export type ClaudeHookIgnoredReason = "not-enabled" | "unsupported" | "invalid-payload";
export type ClaudeHookRelayAction = "emit" | "unregister";

export type ClaudeHookRelayOutcome =
  | { status: "ignored"; reason: ClaudeHookIgnoredReason }
  | { status: "sent"; eventCount: number }
  | { status: "unregistered" }
  | { status: "timed_out"; action: ClaudeHookRelayAction }
  | { status: "failed"; action: ClaudeHookRelayAction };

interface BoundedText {
  value: string;
  truncated: boolean;
}

interface SanitizedSummary extends BoundedText {
  redacted: boolean;
}

interface HookEventSpec {
  kind: RelayIngressEventKind;
  turnId: string | null;
  toolId: string | null;
  payload: RelayJsonValue;
  dedupeKey: string | null;
}

type HookConversion =
  | { status: "events"; specs: HookEventSpec[] }
  | { status: "unregister" }
  | { status: "ignored"; reason: Exclude<ClaudeHookIgnoredReason, "not-enabled"> };

interface ClaudeCommandHookSetting {
  type: "command";
  command: string;
  async: true;
  timeout: number;
}

interface ClaudeHookMatcherSetting {
  matcher?: string;
  hooks: ClaudeCommandHookSetting[];
}

export interface ClaudeHookRelaySettings {
  hooks: {
    MessageDisplay: ClaudeHookMatcherSetting[];
    Stop: ClaudeHookMatcherSetting[];
    PreToolUse: ClaudeHookMatcherSetting[];
    PostToolUse: ClaudeHookMatcherSetting[];
    PostToolUseFailure: ClaudeHookMatcherSetting[];
    Notification: ClaudeHookMatcherSetting[];
    SessionStart: ClaudeHookMatcherSetting[];
    StopFailure: ClaudeHookMatcherSetting[];
    SessionEnd: ClaudeHookMatcherSetting[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES;
}

function optionalIdentifier(value: unknown): string | null {
  return isSafeIdentifier(value) ? value : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** enable record の JSON shape を fail-closed に検証する。 */
export function parseClaudeHookEnableRecord(value: unknown): ClaudeHookEnableRecord | null {
  if (!isRecord(value)) return null;
  if (
    !isSafeIdentifier(value["sessionId"])
    || !isSafeIdentifier(value["providerSessionId"])
    || !isPositiveSafeInteger(value["handoverGeneration"])
    || !isSafeIdentifier(value["relayId"])
    || !isPositiveSafeInteger(value["expiresAt"])
  ) {
    return null;
  }
  return {
    sessionId: value["sessionId"],
    providerSessionId: value["providerSessionId"],
    handoverGeneration: value["handoverGeneration"],
    relayId: value["relayId"],
    expiresAt: value["expiresAt"],
  };
}

/**
 * host が配置した enable record を、symlink・owner・mode・size を検証して局所 read する。
 * 不在・不正はすべて null とし、hook 側を停止させない。
 */
export function readClaudeHookEnableRecord(path: string): ClaudeHookEnableRecord | null {
  if (typeof fsConstants.O_NOFOLLOW !== "number") return null;
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }

  try {
    const stats = fstatSync(fileDescriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stats.isFile()
      || stats.size > CLAUDE_HOOK_ENABLE_RECORD_MAX_BYTES
      || (currentUid !== undefined && stats.uid !== currentUid)
      || (stats.mode & 0o077) !== 0
    ) {
      return null;
    }
    const buffer = Buffer.alloc(CLAUDE_HOOK_ENABLE_RECORD_MAX_BYTES + 1);
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > CLAUDE_HOOK_ENABLE_RECORD_MAX_BYTES) return null;
    try {
      return parseClaudeHookEnableRecord(JSON.parse(buffer.toString("utf8", 0, bytesRead)) as unknown);
    } catch {
      return null;
    }
  } finally {
    closeSync(fileDescriptor);
  }
}

function truncateUtf8(value: string, maxBytes: number): BoundedText {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentLimit) break;
    prefix += character;
    bytes += characterBytes;
  }
  return { value: `${prefix}${TRUNCATION_MARKER}`, truncated: true };
}

function redactFreeText(value: string): string {
  const assignmentsRedacted = value.replace(/[^\r\n]+/g, (line: string): string => {
    for (const match of line.matchAll(ASSIGNMENT_PREFIX_PATTERN)) {
      const key = match[1] ?? match[2] ?? match[3];
      if (key === undefined || !SENSITIVE_ASSIGNMENT_KEY_PATTERN.test(key) || match.index === undefined) continue;
      return `${line.slice(0, match.index + match[0].length)}${REDACTED_MARKER}`;
    }
    return line;
  });
  return redactText(assignmentsRedacted)
    .replace(PEM_PRIVATE_KEY_PATTERN, REDACTED_MARKER)
    .replace(URL_USERINFO_PATTERN, (_match: string, prefix: string): string => `${prefix}${REDACTED_MARKER}@`)
    .replace(JWT_PATTERN, REDACTED_MARKER)
    .replace(AWS_ACCESS_KEY_PATTERN, REDACTED_MARKER);
}

function redactStructuredJson(value: unknown): unknown {
  if (typeof value === "string") return redactFreeText(value);
  if (Array.isArray(value)) return value.map((item) => redactStructuredJson(item));
  if (isRecord(value)) {
    const resultEntries: Array<[string, unknown]> = [];
    const usedKeys = new Set<string>();
    for (const [key, nested] of Object.entries(value)) {
      const redactedKey = redactFreeText(key);
      let resultKey = redactedKey;
      let suffix = 2;
      while (usedKeys.has(resultKey)) {
        resultKey = `${redactedKey}#${suffix}`;
        suffix += 1;
      }
      usedKeys.add(resultKey);

      const redactedNested = SENSITIVE_KEY_PATTERN.test(key) && typeof nested === "string"
        ? REDACTED_MARKER
        : redactStructuredJson(nested);
      resultEntries.push([resultKey, redactedNested]);
    }
    return Object.fromEntries(resultEntries);
  }
  return value;
}

function redactJsonText(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const normalized = JSON.stringify(parsed);
    const redacted = JSON.stringify(redactStructuredJson(parsed));
    if (redacted === normalized) return value;
    return redacted ?? REDACTED_MARKER;
  } catch {
    return null;
  }
}

function redactSensitiveText(value: string): string {
  const directJson = redactJsonText(value);
  if (directJson !== null) return directJson;
  return redactFreeText(value);
}

export { redactSensitiveText as redactClaudeHookRelayText };

function sanitizeText(value: string, maxBytes: number, oneLine = false): SanitizedSummary {
  // PEM の終端が scan 上限より後ろでも秘密鍵を残さないよう、入力全体を先に redact する。
  const exceededScanBound = Buffer.byteLength(value, "utf8") > maxBytes * 8;
  const redacted = redactSensitiveText(value);
  const scanBounded = truncateUtf8(redacted, maxBytes * 8);
  const normalized = oneLine ? scanBounded.value.replace(/\s+/g, " ").trim() : scanBounded.value;
  const bounded = truncateUtf8(normalized, maxBytes);
  return {
    value: bounded.value,
    truncated: exceededScanBound || scanBounded.truncated || bounded.truncated,
    redacted: redacted !== value,
  };
}

function sanitizeOneLine(value: string, maxBytes: number): SanitizedSummary {
  return sanitizeText(value, maxBytes, true);
}

function safeToolName(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return null;
  return sanitizeOneLine(value, MAX_TOOL_NAME_BYTES).value;
}

function stableEventId(owner: RelayOwnerFence, kind: RelayIngressEventKind, dedupeKey: string): string {
  const digest = createHash("sha256")
    .update(owner.providerSessionId)
    .update("\0")
    .update(String(owner.handoverGeneration))
    .update("\0")
    .update(kind)
    .update("\0")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 32);
  return `claude-hook-${digest}`;
}

function numberField(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

function toolSummaryFromSuccess(payload: Record<string, unknown>): SanitizedSummary {
  const response = payload["tool_response"];
  if (!isRecord(response)) {
    return { value: "出力は省略されました", truncated: false, redacted: false };
  }
  if (response["isImage"] === true) {
    return { value: "画像出力は省略されました", truncated: false, redacted: false };
  }
  const stdout = typeof response["stdout"] === "string" ? response["stdout"] : "";
  const stderr = typeof response["stderr"] === "string" ? response["stderr"] : "";
  const parts: string[] = [];
  if (stdout.trim() !== "") parts.push(`stdout: ${stdout}`);
  if (stderr.trim() !== "") parts.push(`stderr: ${stderr}`);
  if (parts.length === 0) {
    return { value: "出力なし", truncated: false, redacted: false };
  }
  return sanitizeOneLine(parts.join("; "), CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES);
}

function fitToolPayload(payload: { [key: string]: RelayJsonValue }): RelayJsonValue {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES) {
    return payload;
  }
  const summary = typeof payload["summary"] === "string" ? payload["summary"] : "";
  let limit = Math.min(CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES, Buffer.byteLength(summary, "utf8"));
  while (limit > 0) {
    const bounded = truncateUtf8(summary, limit);
    const candidate: { [key: string]: RelayJsonValue } = {
      ...payload,
      summary: bounded.value,
      summaryTruncated: true,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES) {
      return candidate;
    }
    limit = Math.floor(limit / 2);
  }
  return { name: payload["name"] ?? "unknown", success: payload["success"] ?? false, summary: TRUNCATION_MARKER };
}

function toolEndPayload(
  payload: Record<string, unknown>,
  toolName: string,
  success: boolean,
): RelayJsonValue {
  const summary = success
    ? toolSummaryFromSuccess(payload)
    : sanitizeOneLine(
      typeof payload["error"] === "string" ? payload["error"] : "tool execution failed",
      CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES,
    );
  const result: { [key: string]: RelayJsonValue } = {
    name: toolName,
    success,
    summary: summary.value,
    summaryTruncated: summary.truncated,
    summaryRedacted: summary.redacted,
  };
  const durationMs = numberField(payload["duration_ms"]);
  if (durationMs !== null) result["durationMs"] = durationMs;
  if (success && isRecord(payload["tool_response"])) {
    const response = payload["tool_response"];
    if (typeof response["interrupted"] === "boolean") result["interrupted"] = response["interrupted"];
    if (typeof response["isImage"] === "boolean") result["isImage"] = response["isImage"];
    if (typeof response["noOutputExpected"] === "boolean") {
      result["noOutputExpected"] = response["noOutputExpected"];
    }
  } else if (!success && typeof payload["is_interrupt"] === "boolean") {
    result["interrupted"] = payload["is_interrupt"];
  }
  return fitToolPayload(result);
}

function hookKey(payload: Record<string, unknown>, fallback: string): string {
  const promptId = optionalIdentifier(payload["prompt_id"]);
  return promptId ?? fallback;
}

function buildCommandHook(command: string, timeoutSeconds: number): ClaudeCommandHookSetting {
  return { type: "command", command, async: true, timeout: timeoutSeconds };
}

/**
 * ~/.claude/settings.json を直接変更せず、利用側が明示的に配置できる async hook 設定例を返す。
 * PermissionRequest は同期 decision を扱わないため含めない。
 */
export function createClaudeHookRelaySettings(
  command: string,
  timeoutSeconds = 1,
): ClaudeHookRelaySettings {
  if (!isSafeIdentifier(command) || !isPositiveSafeInteger(timeoutSeconds)) {
    throw new Error("hook command と timeoutSeconds は妥当な非空値が必須です");
  }
  const handler = (): ClaudeCommandHookSetting => buildCommandHook(command, timeoutSeconds);
  return {
    hooks: {
      MessageDisplay: [{ hooks: [handler()] }],
      Stop: [{ hooks: [handler()] }],
      PreToolUse: [{ matcher: "*", hooks: [handler()] }],
      PostToolUse: [{ matcher: "*", hooks: [handler()] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [handler()] }],
      Notification: [{ matcher: "permission_prompt", hooks: [handler()] }],
      SessionStart: [{ hooks: [handler()] }],
      StopFailure: [{ matcher: "*", hooks: [handler()] }],
      SessionEnd: [{ hooks: [handler()] }],
    },
  };
}

/** Claude の async hook 群を current relay owner へ束縛して順序付きで送る。 */
export class ClaudeHookRelayAdapter {
  private readonly owner: RelayOwnerFence;
  private readonly readEnableRecord: () => unknown;
  private readonly emitter: ClaudeHookRelayEmitter;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private nextSequence: number;
  private dispatchTail: Promise<void> = Promise.resolve();
  private readonly displayedTextByPrompt = new Map<string, string>();

  constructor(options: ClaudeHookRelayAdapterOptions) {
    if (
      !isSafeIdentifier(options.owner.sessionId)
      || !isSafeIdentifier(options.owner.providerSessionId)
      || !isSafeIdentifier(options.owner.host)
      || !isSafeIdentifier(options.owner.evenTerminalBootEpoch)
      || !isPositiveSafeInteger(options.owner.handoverGeneration)
      || !isSafeIdentifier(options.owner.relayId)
      || !isPositiveSafeInteger(options.owner.fencingToken)
    ) {
      throw new Error("relay owner identity は妥当な fenced identity が必須です");
    }
    if (!isPositiveSafeInteger(options.timeoutMs ?? DEFAULT_CLAUDE_HOOK_RELAY_TIMEOUT_MS)) {
      throw new Error("timeoutMs は正の安全な整数が必須です");
    }
    if (!isPositiveSafeInteger(options.initialSequence ?? 1)) {
      throw new Error("initialSequence は正の安全な整数が必須です");
    }
    this.owner = { ...options.owner };
    this.readEnableRecord = options.readEnableRecord;
    this.emitter = options.emitter;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_HOOK_RELAY_TIMEOUT_MS;
    this.nextSequence = options.initialSequence ?? 1;
  }

  handle(input: unknown): Promise<ClaudeHookRelayOutcome> {
    if (!isRecord(input) || !isSafeIdentifier(input["session_id"]) || !isSafeIdentifier(input["hook_event_name"])) {
      return Promise.resolve({ status: "ignored", reason: "invalid-payload" });
    }
    const hookEventName = input["hook_event_name"];
    if (!SUPPORTED_HOOK_EVENTS.has(hookEventName)) {
      return Promise.resolve({ status: "ignored", reason: "unsupported" });
    }

    let rawEnableRecord: unknown;
    try {
      rawEnableRecord = this.readEnableRecord();
    } catch {
      return Promise.resolve({ status: "ignored", reason: "not-enabled" });
    }
    const enableRecord = parseClaudeHookEnableRecord(rawEnableRecord);
    if (!this.isEnabled(enableRecord, input["session_id"])) {
      return Promise.resolve({ status: "ignored", reason: "not-enabled" });
    }

    const conversion = this.convert(input, hookEventName);
    if (conversion.status === "ignored") {
      return Promise.resolve(conversion);
    }
    if (conversion.status === "unregister") {
      const deadlineMs = Date.now() + this.timeoutMs;
      return this.enqueue(() => this.runWithTimeout(
        "unregister",
        (signal) => this.emitter.unregister(this.owner, signal),
        0,
        deadlineMs,
      ));
    }
    if (conversion.specs.length === 0) {
      return Promise.resolve({ status: "ignored", reason: "invalid-payload" });
    }

    const events = this.reserveEvents(conversion.specs);
    if (events === null) {
      return Promise.resolve({ status: "failed", action: "emit" });
    }
    const deadlineMs = Date.now() + this.timeoutMs;
    return this.enqueue(() => this.runWithTimeout("emit", async (signal) => {
      for (const event of events) {
        await this.emitter.emit(event, signal);
      }
    }, events.length, deadlineMs));
  }

  private isEnabled(record: ClaudeHookEnableRecord | null, providerSessionId: string): boolean {
    if (record === null) return false;
    let now: number;
    try {
      now = this.now();
    } catch {
      return false;
    }
    if (!isNonNegativeSafeInteger(now) || record.expiresAt <= now) return false;
    return record.sessionId === this.owner.sessionId
      && record.providerSessionId === this.owner.providerSessionId
      && record.providerSessionId === providerSessionId
      && record.handoverGeneration === this.owner.handoverGeneration
      && record.relayId === this.owner.relayId;
  }

  private convert(payload: Record<string, unknown>, hookEventName: string): HookConversion {
    switch (hookEventName) {
      case "MessageDisplay":
        return this.convertMessageDisplay(payload);
      case "Stop":
        return this.convertStop(payload);
      case "PreToolUse":
        return this.convertPreToolUse(payload);
      case "PostToolUse":
        return this.convertPostToolUse(payload, true);
      case "PostToolUseFailure":
        return this.convertPostToolUse(payload, false);
      case "Notification":
        return this.convertNotification(payload);
      case "SessionStart":
        return this.convertSessionStart(payload);
      case "StopFailure":
        return this.convertStopFailure(payload);
      case "SessionEnd":
        return { status: "unregister" };
      default:
        return { status: "ignored", reason: "unsupported" };
    }
  }

  private convertMessageDisplay(payload: Record<string, unknown>): HookConversion {
    const delta = payload["delta"];
    const turnId = optionalIdentifier(payload["turn_id"]);
    const messageId = optionalIdentifier(payload["message_id"]);
    const index = payload["index"];
    const final = payload["final"];
    if (typeof delta !== "string" || turnId === null || messageId === null || !isNonNegativeSafeInteger(index) || typeof final !== "boolean") {
      return { status: "ignored", reason: "invalid-payload" };
    }
    const text = sanitizeText(delta, CLAUDE_HOOK_TEXT_MAX_BYTES);
    const promptKey = hookKey(payload, turnId);
    this.displayedTextByPrompt.set(promptKey, text.value);
    return {
      status: "events",
      specs: [{
        kind: "text_delta",
        turnId,
        toolId: null,
        payload: { text: text.value, final, index, truncated: text.truncated },
        dedupeKey: `message:${messageId}:${index}:${final ? "final" : "partial"}`,
      }],
    };
  }

  private convertStop(payload: Record<string, unknown>): HookConversion {
    const rawText = payload["last_assistant_message"];
    if (typeof rawText !== "string") return { status: "ignored", reason: "invalid-payload" };
    const text = sanitizeText(rawText, CLAUDE_HOOK_TEXT_MAX_BYTES);
    const promptKey = hookKey(payload, "session");
    const duplicateDisplay = this.displayedTextByPrompt.get(promptKey) === text.value;
    this.displayedTextByPrompt.delete(promptKey);
    const stopKey = createHash("sha256").update(promptKey).update("\0").update(rawText).digest("hex");
    const specs: HookEventSpec[] = [];
    if (!duplicateDisplay) {
      specs.push({
        kind: "text",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId: null,
        payload: { text: text.value, truncated: text.truncated },
        dedupeKey: `stop-text:${stopKey}`,
      });
    }
    specs.push(
      {
        kind: "result",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId: null,
        payload: { success: true, text: text.value, truncated: text.truncated },
        dedupeKey: `stop-result:${stopKey}`,
      },
      {
        kind: "status",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId: null,
        payload: { state: "idle" },
        dedupeKey: `stop-status:${stopKey}`,
      },
    );
    return { status: "events", specs };
  }

  private convertPreToolUse(payload: Record<string, unknown>): HookConversion {
    const toolName = safeToolName(payload["tool_name"]);
    const toolId = optionalIdentifier(payload["tool_use_id"]);
    if (toolName === null || toolId === null) return { status: "ignored", reason: "invalid-payload" };
    return {
      status: "events",
      specs: [{
        kind: "tool_start",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId,
        // tool_input は command や credential を含み得るため relay payload へ複製しない。
        payload: { name: toolName },
        dedupeKey: `tool-start:${toolId}`,
      }],
    };
  }

  private convertPostToolUse(payload: Record<string, unknown>, success: boolean): HookConversion {
    const toolName = safeToolName(payload["tool_name"]);
    const toolId = optionalIdentifier(payload["tool_use_id"]);
    if (toolName === null || toolId === null) return { status: "ignored", reason: "invalid-payload" };
    return {
      status: "events",
      specs: [{
        kind: "tool_end",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId,
        payload: toolEndPayload(payload, toolName, success),
        dedupeKey: `tool-end:${success ? "success" : "failure"}:${toolId}`,
      }],
    };
  }

  private convertNotification(payload: Record<string, unknown>): HookConversion {
    if (payload["notification_type"] !== "permission_prompt" || typeof payload["message"] !== "string") {
      return { status: "ignored", reason: "unsupported" };
    }
    const message = sanitizeOneLine(payload["message"], MAX_NOTIFICATION_TEXT_BYTES);
    const title = typeof payload["title"] === "string"
      ? sanitizeOneLine(payload["title"], MAX_NOTIFICATION_TEXT_BYTES)
      : null;
    const eventPayload: { [key: string]: RelayJsonValue } = {
      message: message.value,
      displayOnly: true,
      truncated: message.truncated,
    };
    if (title !== null) eventPayload["title"] = title.value;
    return {
      status: "events",
      specs: [{
        kind: "permission_request",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId: null,
        payload: eventPayload,
        // Notification には実測済みの相関 ID が無いため、別 request を誤って重複排除しない。
        dedupeKey: null,
      }],
    };
  }

  private convertSessionStart(payload: Record<string, unknown>): HookConversion {
    if (typeof payload["source"] !== "string") return { status: "ignored", reason: "invalid-payload" };
    const source = sanitizeOneLine(payload["source"], MAX_NOTIFICATION_TEXT_BYTES);
    return {
      status: "events",
      specs: [{
        kind: "status",
        turnId: null,
        toolId: null,
        payload: { state: "busy", source: source.value },
        // SessionStart には実測上 event ID が無いため、sequence を event ID の一部にする。
        dedupeKey: null,
      }],
    };
  }

  private convertStopFailure(payload: Record<string, unknown>): HookConversion {
    if (typeof payload["error"] !== "string" || payload["error"].trim() === "") {
      return { status: "ignored", reason: "invalid-payload" };
    }
    const code = sanitizeOneLine(payload["error"], MAX_NOTIFICATION_TEXT_BYTES);
    const detail = typeof payload["error_details"] === "string"
      ? sanitizeOneLine(payload["error_details"], MAX_ERROR_TEXT_BYTES)
      : null;
    const message = typeof payload["last_assistant_message"] === "string"
      ? sanitizeOneLine(payload["last_assistant_message"], MAX_ERROR_TEXT_BYTES)
      : null;
    const eventPayload: { [key: string]: RelayJsonValue } = { code: code.value };
    if (detail !== null) eventPayload["detail"] = detail.value;
    if (message !== null) eventPayload["message"] = message.value;
    const promptKey = hookKey(payload, `${code.value}:${detail?.value ?? ""}:${message?.value ?? ""}`);
    return {
      status: "events",
      specs: [{
        kind: "error",
        turnId: optionalIdentifier(payload["prompt_id"]),
        toolId: null,
        payload: eventPayload,
        dedupeKey: `stop-failure:${promptKey}`,
      }],
    };
  }

  private reserveEvents(specs: readonly HookEventSpec[]): RelayIngressEvent[] | null {
    if (this.nextSequence > Number.MAX_SAFE_INTEGER - specs.length + 1) return null;
    const events = specs.map((spec, index): RelayIngressEvent => {
      const sequence = this.nextSequence + index;
      const dedupeKey = spec.dedupeKey ?? `sequence:${sequence}`;
      return {
        sessionId: this.owner.sessionId,
        handoverGeneration: this.owner.handoverGeneration,
        turnId: spec.turnId,
        toolId: spec.toolId,
        sequence,
        eventId: stableEventId(this.owner, spec.kind, dedupeKey),
        kind: spec.kind,
        payload: spec.payload,
      };
    });
    this.nextSequence += specs.length;
    return events;
  }

  private enqueue(run: () => Promise<ClaudeHookRelayOutcome>): Promise<ClaudeHookRelayOutcome> {
    const queued = this.dispatchTail.then(run, run);
    this.dispatchTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async runWithTimeout(
    action: ClaudeHookRelayAction,
    operation: (signal: AbortSignal) => Promise<void>,
    eventCount = 0,
    deadlineMs = Date.now() + this.timeoutMs,
  ): Promise<ClaudeHookRelayOutcome> {
    const remainingMs = deadlineMs - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { status: "timed_out", action };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<ClaudeHookRelayOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "timed_out", action });
      }, remainingMs);
    });
    const attempt = Promise.resolve()
      .then(() => operation(controller.signal))
      .then<ClaudeHookRelayOutcome, ClaudeHookRelayOutcome>(
        () => action === "emit" ? { status: "sent", eventCount } : { status: "unregistered" },
        () => ({ status: "failed", action }),
      );
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
