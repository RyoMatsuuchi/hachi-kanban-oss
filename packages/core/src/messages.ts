// =============================================================================
// agent.message.v1（docs/contract.md §8）
// task_comments の body に JSON フェンスドブロックとして格納するメッセージパケットの
// シリアライズ/パース/検証を担う。不正なブロックは無視せず fail-closed で除外し報告する。
// =============================================================================

import { z } from "zod";
import type { AgentMessageV1, EnqueuePayload, SteerPayload } from "./types.js";

const FENCE_LANG = "agent-message-v1";
const FENCE_REGEX = /```agent-message-v1\s*\n([\s\S]*?)```/g;

const messageRoleSchema = z.enum(["worker", "reviewer", "orchestrator", "human"]);
const providerOrEmptySchema = z.union([z.literal("codex"), z.literal("claude"), z.literal("")]);
const messageIntentSchema = z.enum(["enqueue", "steer", "escalate", "answer"]);

const messagePartySchema = z.object({
  role: messageRoleSchema,
  provider: providerOrEmptySchema,
  sessionId: z.string(),
});

const messageTargetSchema = z.object({
  role: messageRoleSchema,
  taskId: z.string(),
});

/** agent.message.v1 の zod スキーマ（docs/contract.md §8） */
export const agentMessageV1Schema = z.object({
  schema: z.literal("agent.message.v1"),
  from: messagePartySchema,
  to: messageTargetSchema,
  intent: messageIntentSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
  createdAt: z.number(),
});

const enqueuePayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  tenant: z.string(),
  profile: z.string().optional(),
  priority: z.number().optional(),
});

const steerPayloadSchema = z.object({
  message: z.string().min(1),
});

/** AgentMessageV1 をコメント本文用のフェンスドブロックへシリアライズする */
export function serializeAgentMessage(msg: AgentMessageV1): string {
  return "```" + FENCE_LANG + "\n" + JSON.stringify(msg, null, 2) + "\n```";
}

/** parseAgentMessages が不正ブロックを報告する際の情報 */
export interface AgentMessageParseError {
  /** フェンスブロック内の生テキスト */
  raw: string;
  /** 検証/パース失敗の理由 */
  reason: string;
}

/** parseAgentMessages の戻り値。不正ブロックは messages に含めず errors に列挙する（fail-closed） */
export interface ParsedAgentMessages {
  messages: AgentMessageV1[];
  errors: AgentMessageParseError[];
}

/** コメント本文から agent.message.v1 のフェンスドブロックを全て抽出し検証する */
export function parseAgentMessages(commentBody: string): ParsedAgentMessages {
  const messages: AgentMessageV1[] = [];
  const errors: AgentMessageParseError[] = [];

  for (const match of commentBody.matchAll(FENCE_REGEX)) {
    const raw = (match[1] ?? "").trim();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      errors.push({ raw, reason: `JSON パースに失敗しました: ${(err as Error).message}` });
      continue;
    }

    const result = agentMessageV1Schema.safeParse(parsedJson);
    if (!result.success) {
      errors.push({ raw, reason: `スキーマ検証に失敗しました: ${result.error.message}` });
      continue;
    }

    messages.push(result.data);
  }

  return { messages, errors };
}

/** intent=enqueue の payload を検証して型付きで返す。不正な場合は throw（fail-closed） */
export function parseEnqueuePayload(payload: Record<string, unknown>): EnqueuePayload {
  const result = enqueuePayloadSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`enqueue payload の検証に失敗しました: ${result.error.message}`);
  }

  const data = result.data;
  const out: EnqueuePayload = { title: data.title, body: data.body, tenant: data.tenant };
  if (data.profile !== undefined) {
    out.profile = data.profile;
  }
  if (data.priority !== undefined) {
    out.priority = data.priority;
  }
  return out;
}

/** intent=steer の payload を検証して型付きで返す。不正な場合は throw（fail-closed） */
export function parseSteerPayload(payload: Record<string, unknown>): SteerPayload {
  const result = steerPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`steer payload の検証に失敗しました: ${result.error.message}`);
  }
  return { message: result.data.message };
}
