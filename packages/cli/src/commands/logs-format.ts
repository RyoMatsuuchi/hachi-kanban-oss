// =============================================================================
// task logs 用 bridge イベント整形（docs/contract.md §50.3）
// =============================================================================

import { redactJsonStrings, redactText } from "@hachi/core";

export type BridgeLogEntry = Record<string, unknown>;

export interface BridgeLogFormatterState {
  textBuffer: string;
  lastStatus: string | null;
}

export interface BridgeLogFormatResult {
  lines: string[];
  state: BridgeLogFormatterState;
}

const DEFAULT_TOOL_COMMAND_LIMIT = 80;

export function createBridgeLogFormatterState(): BridgeLogFormatterState {
  return { textBuffer: "", lastStatus: null };
}

function entryText(entry: BridgeLogEntry): string {
  const value = entry["text"];
  return typeof value === "string" ? value : "";
}

function flushTextBuffer(state: BridgeLogFormatterState, lines: string[]): BridgeLogFormatterState {
  if (state.textBuffer.length === 0) {
    return state;
  }
  lines.push(redactText(state.textBuffer));
  return { ...state, textBuffer: "" };
}

function firstStringField(entry: BridgeLogEntry, fields: readonly string[]): string {
  for (const field of fields) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function extractToolCommand(entry: BridgeLogEntry): string {
  const direct = firstStringField(entry, ["command", "cmd", "name", "tool", "title"]);
  if (direct.length > 0) {
    return direct;
  }
  const nested = entry["input"];
  if (typeof nested === "object" && nested !== null) {
    const value = firstStringField(nested as Record<string, unknown>, ["command", "cmd", "name"]);
    if (value.length > 0) {
      return value;
    }
  }
  return "(command unknown)";
}

function truncateCommand(command: string, limit: number): string {
  return command.length <= limit ? command : command.slice(0, limit);
}

function appendStatusLine(
  entry: BridgeLogEntry,
  state: BridgeLogFormatterState,
  lines: string[],
): BridgeLogFormatterState {
  const rawState = entry["state"];
  if (typeof rawState !== "string" || rawState === state.lastStatus) {
    return state;
  }
  lines.push(`status: ${redactText(rawState)}`);
  return { ...state, lastStatus: rawState };
}

/**
 * bridge の /api/messages エントリを人間可読ログへ変換する。
 * text_delta は連結してから出し、status は state 変化時だけ表示する。
 */
export function formatBridgeLogEntries(
  entries: readonly BridgeLogEntry[],
  initialState: BridgeLogFormatterState = createBridgeLogFormatterState(),
): BridgeLogFormatResult {
  let state = initialState;
  const lines: string[] = [];

  for (const entry of entries) {
    switch (entry["type"]) {
      case "text_delta":
        state = { ...state, textBuffer: `${state.textBuffer}${entryText(entry)}` };
        break;
      case "status":
        state = flushTextBuffer(state, lines);
        state = appendStatusLine(entry, state, lines);
        break;
      case "tool_end":
        state = flushTextBuffer(state, lines);
        lines.push(`⚙ ${redactText(truncateCommand(extractToolCommand(entry), DEFAULT_TOOL_COMMAND_LIMIT))}`);
        break;
      case "user_prompt":
        state = flushTextBuffer(state, lines);
        lines.push(`[user] ${redactText(entryText(entry))}`);
        break;
      case "result":
        state = flushTextBuffer(state, lines);
        lines.push(`[assistant] ${redactText(entryText(entry))}`);
        break;
      default:
        state = flushTextBuffer(state, lines);
        break;
    }
  }

  state = flushTextBuffer(state, lines);
  return { lines, state };
}

export function serializeRawBridgeEntry(entry: BridgeLogEntry): string {
  return JSON.stringify(redactJsonStrings(entry));
}
