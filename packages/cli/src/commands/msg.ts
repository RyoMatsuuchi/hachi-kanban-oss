// =============================================================================
// hachi msg send: agent.message.v1 パケットを構築し、対象タスクへコメントとして書き込む。
// board-first: 送信=ボードへの記録。実処理は supervisor の messages ステージが担う。
// =============================================================================

import { Command, Option } from "commander";
import {
  newNonce,
  parseEnqueuePayload,
  parseSteerPayload,
  redactJsonStrings,
  serializeAgentMessage,
  type AgentMessageV1,
  type DurableSteerStore,
  type MessageIntent,
  type MessageRole,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";

const INTENTS: readonly MessageIntent[] = ["enqueue", "steer", "escalate", "answer"];
const FROM_ROLES: readonly MessageRole[] = ["orchestrator", "human"];

/**
 * intent ごとの既定 to.role。CLI には --to-role オプションが存在しない（契約に規定が無いため）。
 * enqueue は orchestrator（子タスク生成の判断主体）、steer/answer は実行中の worker、
 * escalate は human 宛てを既定とする。to.role は本 CLI では処理判定に使われず記録用メタデータ。
 */
const DEFAULT_TARGET_ROLE: Record<MessageIntent, MessageRole> = {
  enqueue: "orchestrator",
  steer: "worker",
  escalate: "human",
  answer: "worker",
};

interface MsgSendOptions {
  task: string;
  intent: MessageIntent;
  payload: string;
  fromRole: MessageRole;
  key?: string;
  json?: boolean;
}

/** --payload の JSON 文字列をパースし、非 null なオブジェクトであることを検証する（fail-closed） */
function parsePayloadJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`payload の JSON パースに失敗しました: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload はオブジェクトである必要があります");
  }
  return parsed as Record<string, unknown>;
}

/** intent に応じて payload を core のスキーマで正規化する（enqueue/steer のみ厳密検証） */
function normalizePayload(intent: MessageIntent, payload: Record<string, unknown>): Record<string, unknown> {
  // EnqueuePayload/SteerPayload はインデックスシグネチャを持たない具象 interface のため、
  // agent.message.v1 の payload（Record<string, unknown>）へ格納する際に明示的に変換する。
  if (intent === "enqueue") {
    return { ...parseEnqueuePayload(payload) } as Record<string, unknown>;
  }
  if (intent === "steer") {
    const parsed = parseSteerPayload(payload);
    const supersedesId = payload["supersedesId"];
    if (supersedesId !== undefined && (typeof supersedesId !== "string" || supersedesId === "")) {
      throw new Error("steer supersedesId は空でない文字列が必須です");
    }
    return { ...parsed, ...(typeof supersedesId === "string" ? { supersedesId } : {}) } as Record<string, unknown>;
  }
  return payload;
}

/** hachi msg send の action 本体 */
function runSend(deps: CliDeps, options: MsgSendOptions): void {
  const payload = parsePayloadJson(options.payload);
  const normalizedPayload = normalizePayload(options.intent, payload);
  // board へ書き込まれる前に payload の全文字列リーフ（配列・任意深さのネスト含む）を
  // 再帰的に redact する（docs/contract.md §12.13-2）。
  const redactedPayload = redactJsonStrings(normalizedPayload) as Record<string, unknown>;
  const idempotencyKey = options.key ?? newNonce();
  let lifecyclePayload = redactedPayload;
  if (options.intent === "steer") {
    const run = deps.store.getLatestOpenRun(options.task);
    if (run === null) {
      throw new Error("steer 対象に current open run がありません");
    }
    const steerStore = deps.store as CliDeps["store"] & DurableSteerStore;
    const supersedesId = redactedPayload["supersedesId"];
    const delivery = steerStore.createOrGetSteerDelivery({
      taskId: options.task,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: idempotencyKey,
      expectedCancelFence: steerStore.currentRunCancelFence(run.id),
      ...(typeof supersedesId === "string" ? { supersedesId } : {}),
      actor: options.fromRole,
    });
    lifecyclePayload = {
      message: redactedPayload["message"],
      deliveryId: delivery.id,
      runId: delivery.runId,
      sessionId: delivery.sessionId,
      cancelFence: delivery.expectedCancelFence,
    };
  }

  const message: AgentMessageV1 = {
    schema: "agent.message.v1",
    from: { role: options.fromRole, provider: "", sessionId: "" },
    to: { role: DEFAULT_TARGET_ROLE[options.intent], taskId: options.task },
    intent: options.intent,
    payload: lifecyclePayload,
    idempotencyKey,
    createdAt: Math.floor(Date.now() / 1000),
  };

  const body = serializeAgentMessage(message);
  const comment = deps.store.addComment(options.task, options.fromRole, body);
  const json = options.json === true;

  emit(deps, json, singularResourceEnvelope(comment, { comment, message }), [
    `メッセージを送信しました: comment#${comment.id} intent=${options.intent} key=${idempotencyKey}`,
  ]);
}

/** hachi msg サブコマンド群を登録する */
export function registerMsgCommand(program: Command, deps: CliDeps): void {
  const msg = program.command("msg").description("agent.message.v1 の送信");

  msg
    .command("send")
    .description("対象タスクへ agent.message.v1 パケットをコメントとして書き込む")
    .requiredOption("--task <id>", "対象タスク ID")
    .addOption(new Option("--intent <intent>", "メッセージ種別").choices(INTENTS).makeOptionMandatory())
    .requiredOption("--payload <json>", "payload（JSON 文字列）")
    .addOption(new Option("--from-role <role>", "送信元ロール").choices(FROM_ROLES).default("human"))
    .option("--key <idempotencyKey>", "冪等キー（省略時は自動生成）")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: MsgSendOptions): void => runSend(deps, options)));
}
