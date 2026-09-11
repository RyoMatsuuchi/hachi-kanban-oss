// handoff / verdict 共通の安全なフェンス抽出境界（docs/contract.md §53.0/§53.0.1）。
// user prompt を含む bridge transcript は検索せず、adapter が保証する構造化 result だけを扱う。
import type { SessionStatus } from "@hachi/core";
import { HANDOFF_SUMMARY_PLACEHOLDER_TOKENS } from "./prompt.js";

export type FenceFailureReason =
  | "provider_capacity_exceeded"
  | "incompatible_model_transport"
  | "cli_startup_failed"
  | "run_truncated_max_turns"
  | "worker_output_missing"
  | "extraction_failed"
  | "parse_invalid";

export interface FenceSpec {
  label: "hachi-handoff-v1" | "hachi-verdict-v1";
  isSchemaValid(value: unknown): boolean;
}

export interface FenceExtractionInput {
  transcript: string;
  structuredStatusRaw?: unknown;
  /** direct CLI の stdout は prompt と分離された assistant 最終出力チャネルとして扱う。 */
  assistantOnlyOutput?: boolean;
  spec: FenceSpec;
}

export type FenceExtractionResult =
  | {
      kind: "candidate";
      raw: string;
      source: "structured_result" | "assistant_fallback" | "assistant_output";
      /** structured result 自体が成功応答か。failure 分類より優先できるのは true の場合だけ。 */
      structuredSuccess?: boolean;
    }
  | { kind: "missing" }
  | { kind: "failure"; reason: "extraction_failed" | "parse_invalid"; diagnostic: string };

export interface ClassifiedExecutionFailure {
  reason:
    | "provider_capacity_exceeded"
    | "incompatible_model_transport"
    | "cli_startup_failed"
    | "run_truncated_max_turns"
    | "worker_output_missing"
    | "extraction_failed";
  diagnostic: string;
}

export type ExecutionFailureSource =
  | "bridge_transcript"
  | "direct_assistant_output"
  | "unknown";

const MISSING_DIRECT_TRANSCRIPT = "(出力ファイルなし)";

type AssistantResult =
  | { kind: "found"; text: string; success: boolean }
  | { kind: "unavailable" }
  | { kind: "invalid"; diagnostic: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function structuredAssistantResult(raw: unknown): AssistantResult {
  if (!isRecord(raw) || !("messages" in raw)) {
    return { kind: "unavailable" };
  }
  if (!Array.isArray(raw.messages)) {
    return { kind: "invalid", diagnostic: "structured messages が配列ではありません" };
  }

  for (let index = raw.messages.length - 1; index >= 0; index -= 1) {
    const entry = raw.messages[index];
    if (!isRecord(entry) || entry.type !== "result") {
      continue;
    }
    if (typeof entry.text !== "string") {
      return { kind: "invalid", diagnostic: "structured assistant result に text がありません" };
    }
    return { kind: "found", text: entry.text, success: entry.success === true };
  }
  return { kind: "unavailable" };
}

/** bridge の構造化 assistant result が安全に取得でき、成功応答であるかを判定する。 */
export function hasSuccessfulStructuredAssistantResult(raw: unknown): boolean {
  const result = structuredAssistantResult(raw);
  return result.kind === "found" && result.success;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLastFence(text: string, spec: FenceSpec): FenceExtractionResult {
  const regex = new RegExp("```" + escapeRegex(spec.label) + "\\s*\\r?\\n([\\s\\S]*?)```", "g");
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) {
    return { kind: "missing" };
  }

  const raw = matches.at(-1)?.[1]?.trim();
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (spec.isSchemaValid(parsed)) {
        return { kind: "candidate", raw, source: "assistant_fallback" };
      }
    } catch {
      // 末尾の同名フェンスが不正なら、手前の候補へ後退せず parse_invalid へ倒す。
    }
  }

  return {
    kind: "failure",
    reason: "parse_invalid",
    diagnostic: `${spec.label} の JSON/schema が不正です`,
  };
}

/** 構造化 assistant result を第一選択にし、安全な fallback だけでフェンスを抽出する pure 境界。 */
export function extractAssistantFence(input: FenceExtractionInput): FenceExtractionResult {
  const structured = structuredAssistantResult(input.structuredStatusRaw);
  if (structured.kind === "invalid") {
    return { kind: "failure", reason: "extraction_failed", diagnostic: structured.diagnostic };
  }
  if (structured.kind === "found") {
    const extracted = extractLastFence(structured.text, input.spec);
    return extracted.kind === "candidate"
      ? { ...extracted, source: "structured_result", structuredSuccess: structured.success }
      : extracted;
  }

  if (input.assistantOnlyOutput === true) {
    const extracted = extractLastFence(input.transcript, input.spec);
    return extracted.kind === "candidate" ? { ...extracted, source: "assistant_output" } : extracted;
  }

  return {
    kind: "failure",
    reason: "extraction_failed",
    diagnostic: "bridge の構造化 assistant result を取得できませんでした",
  };
}

/** 抽出済み候補が対象 task の fence かを判定する（failure 分類より優先させるため）。 */
export function isFenceForTask(extraction: FenceExtractionResult, taskId: string): boolean {
  if (extraction.kind !== "candidate") {
    return false;
  }
  try {
    const parsed = JSON.parse(extraction.raw) as unknown;
    if (!isRecord(parsed) || parsed.taskId !== taskId) {
      return false;
    }
    const summary = parsed.summary;
    return (
      typeof summary !== "string"
      || !HANDOFF_SUMMARY_PLACEHOLDER_TOKENS.some((token) => summary.includes(token))
    );
  } catch {
    return false;
  }
}

function lastStructuredResult(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) {
    return null;
  }
  for (let index = raw.messages.length - 1; index >= 0; index -= 1) {
    const entry = raw.messages[index];
    if (isRecord(entry) && entry.type === "result") {
      return entry;
    }
  }
  return null;
}

function structuredDiagnosticText(result: Record<string, unknown> | null): string | null {
  if (result !== null) {
    for (const key of ["error", "message", "reason", "text", "code"] as const) {
      const value = result[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim().slice(0, 500);
      }
      if (isRecord(value)) {
        for (const nestedKey of ["message", "reason", "code"] as const) {
          const nested = value[nestedKey];
          if (typeof nested === "string" && nested.trim() !== "") {
            return nested.trim().slice(0, 500);
          }
        }
      }
    }
  }
  return null;
}

function reasonFromDiagnostic(diagnostic: string): ClassifiedExecutionFailure["reason"] | null {
  // ターン上限による打ち切り。usage/rate limit より先に判定する（"limit" 語が capacity 側へ吸われるため）。
  // even-terminal は error_max_turns を受けて "Reached max turns limit (N turns)" を result に載せる。
  // direct CLI 側は "Reached maximum number of turns" を出す（reference §3 の既出文言）。
  // 「上限へ到達した」文型だけに絞る。単に maxTurns へ言及しただけの診断
  // （"maxTurns is not supported by this runtime" 等）は incompatible_model_transport の担当。
  if (
    /(?:reached\s+max(?:imum)?\s+(?:number\s+of\s+)?turns|max[ _-]?turns\s+limit|ターン(?:数)?上限に達)/i
      .test(diagnostic)
  ) {
    return "run_truncated_max_turns";
  }
  if (/(?:usage[ _-]?limit|rate[ _-]?limit|capacity|quota|too many requests|\b429\b)/i.test(diagnostic)) {
    return "provider_capacity_exceeded";
  }
  if (
    /(?:incompatible|unsupported|not supported|does not support|model.*transport|transport.*model)/i.test(
      diagnostic,
    )
  ) {
    return "incompatible_model_transport";
  }
  if (
    /(?:command not found|no such file|failed to spawn|spawn failed|startup failed|os error\s*35|enoent|eacces)/i.test(
      diagnostic,
    )
  ) {
    return "cli_startup_failed";
  }
  return null;
}

/** launch/preflight も 0-token 終端処理と同じ診断語彙を使うための共有境界。 */
export function classifyProviderFailureDiagnostic(
  diagnostic: string,
): ClassifiedExecutionFailure["reason"] | null {
  return reasonFromDiagnostic(diagnostic);
}

function directAssistantDiagnostic(
  transcript: string,
): { kind: "diagnostic"; text: string } | { kind: "missing" } {
  const trimmed = transcript.trim();
  if (trimmed === "" || trimmed === MISSING_DIRECT_TRANSCRIPT) {
    return { kind: "missing" };
  }

  let diagnosticSource = trimmed;
  if (trimmed.startsWith("OpenAI Codex v")) {
    const separatorPattern = /^--------\r?$/gm;
    const firstSeparator = separatorPattern.exec(trimmed);
    const secondSeparator = firstSeparator === null ? null : separatorPattern.exec(trimmed);
    if (secondSeparator !== null) {
      const withoutBanner = trimmed.slice(secondSeparator.index + secondSeparator[0].length).trim();
      if (withoutBanner !== "") {
        diagnosticSource = withoutBanner;
      }
    }
  }

  return { kind: "diagnostic", text: diagnosticSource.slice(-500) };
}

/** turns/tokens=0 または構造化拒否を、フェンス抽出より先に分類する。 */
export function classifyExecutionFailure(
  status: Pick<SessionStatus, "lastResult" | "raw">,
  transcript: string,
  source: ExecutionFailureSource,
): ClassifiedExecutionFailure | null {
  const result = lastStructuredResult(status.raw);
  const structuredRejection = result?.success === false || result?.error !== undefined;
  const stats = status.lastResult;
  const zeroToken = stats !== undefined && stats.turns === 0 && stats.inputTokens === 0 && stats.outputTokens === 0;
  const structuredDiagnostic = structuredDiagnosticText(result);

  if (source === "direct_assistant_output") {
    const direct = directAssistantDiagnostic(transcript);
    if (direct.kind === "missing") {
      return { reason: "worker_output_missing", diagnostic: "実出力を取得できませんでした" };
    }
  }

  if (structuredDiagnostic !== null && (structuredRejection || zeroToken)) {
    const reason = reasonFromDiagnostic(structuredDiagnostic);
    if (reason !== null) {
      return { reason, diagnostic: structuredDiagnostic };
    }
    if (structuredRejection || zeroToken) {
      return { reason: "worker_output_missing", diagnostic: structuredDiagnostic };
    }
  }

  if (structuredRejection || zeroToken || (result === null && stats === undefined)) {
    if (source === "bridge_transcript") {
      return { reason: "extraction_failed", diagnostic: "bridge の構造化 assistant 診断を取得できませんでした" };
    }
    if (source === "direct_assistant_output") {
      const fallback = directAssistantDiagnostic(transcript);
      if (fallback.kind === "missing") {
        return { reason: "worker_output_missing", diagnostic: "実出力を取得できませんでした" };
      }
      const reason = reasonFromDiagnostic(fallback.text);
      if (reason !== null) {
        return { reason, diagnostic: fallback.text };
      }
      if (zeroToken || structuredRejection) {
        return { reason: "worker_output_missing", diagnostic: fallback.text };
      }
    }
  }

  return null;
}

export function isHandoffSchema(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.taskId === "string" &&
    (value.outcome === "done" || value.outcome === "review" || value.outcome === "question") &&
    typeof value.summary === "string"
  );
}

export function isVerdictSchema(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.taskId === "string" &&
    (value.verdict === "pass" || value.verdict === "fail") &&
    (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low") &&
    typeof value.summary === "string"
  );
}
