// Telegram inline keyboard の nonce 管理とゲートウェイ状態（contract §42.2）
// nonce は「どの提案（kind/taskId/提案時点）への承認か」を state に紐付けて
// 流用を拒否する。24時間期限・1回限り。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@hachi/core";
import type { Environment, EventRow, KanbanStore, TaskRow } from "@hachi/core";

/** nonce の有効期限（24時間） */
export const NONCE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** nonce のランダムバイト数（12 hex 文字 = 6 bytes） */
const NONCE_BYTES = 6;

/** inline keyboard の承認対象種別 */
export type NonceKind = "user-decision" | "steward-promote";

/** 個々の nonce エントリ */
export interface NonceEntry {
  action: "approve";
  taskId: string;
  kind: NonceKind;
  /** タスク状態のハッシュ（stale 検出用。approve 時に再計算して一致確認） */
  stateHash: string;
  /** 登録時点の tasks.updated_at。秒精度のため event id と併用する */
  taskUpdatedAt: number;
  /** 登録時点で最後に観測した状態変更系 event id */
  mutationEventId: number;
  /** steward proposal の event id。user-decision では null */
  proposalEventId: number | null;
  /** 登録時刻（Unix ms） */
  createdAt: number;
}

/** nonce 登録・承認時に比較する提案スナップショット */
export interface ProposalStateSnapshot {
  stateHash: string;
  taskUpdatedAt: number;
  mutationEventId: number;
  proposalEventId: number | null;
}

/** state/telegram-in.json の永続化スキーマ */
export interface TelegramInState {
  /** getUpdates の次回 offset（冪等性カーソル。contract §42.1） */
  updateOffset: number;
  /** 有効な nonce → エントリのマップ */
  nonces: Record<string, NonceEntry>;
}

/** state ファイルのパスを返す */
export function telegramInStatePath(env: Environment): string {
  return join(env.home, "state", "telegram-in.json");
}

/** state ファイルを読み込む（存在しなければ初期値を返す） */
export function readTelegramInState(env: Environment): TelegramInState {
  const filePath = telegramInStatePath(env);
  if (!existsSync(filePath)) {
    return { updateOffset: 0, nonces: {} };
  }
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as Partial<TelegramInState>;
    return {
      updateOffset: typeof parsed.updateOffset === "number" ? parsed.updateOffset : 0,
      nonces:
        parsed.nonces !== undefined && typeof parsed.nonces === "object" && parsed.nonces !== null
          ? (parsed.nonces as Record<string, NonceEntry>)
          : {},
    };
  } catch {
    return { updateOffset: 0, nonces: {} };
  }
}

/** state ファイルを原子的に書き出す（tmp → rename。contract §42.1 冪等性カーソル） */
export function writeTelegramInState(env: Environment, state: TelegramInState): void {
  const dir = join(env.home, "state");
  mkdirSync(dir, { recursive: true });
  const filePath = telegramInStatePath(env);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

/** ランダムな nonce 文字列を生成する */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/** nonce を state に登録し、生成した nonce 文字列を返す */
export function registerNonce(state: TelegramInState, entry: NonceEntry): string {
  const nonce = generateNonce();
  state.nonces[nonce] = entry;
  return nonce;
}

/**
 * nonce を消費する。有効なら NonceEntry を返して state から削除（1回限り）。
 * 未登録・期限切れの場合は null を返す（contract §42.2: nonce は1回限り・期限24h）。
 */
export function consumeNonce(state: TelegramInState, nonce: string, nowMs: number): NonceEntry | null {
  const entry = state.nonces[nonce];
  if (entry === undefined) {
    return null;
  }
  // 24時間期限チェック
  if (nowMs - entry.createdAt > NONCE_EXPIRY_MS) {
    delete state.nonces[nonce];
    return null;
  }
  // 1回限り: 消費して削除
  delete state.nonces[nonce];
  return entry;
}

/** 期限切れ nonce を一括削除し、削除件数を返す */
export function pruneExpiredNonces(state: TelegramInState, nowMs: number): number {
  let pruned = 0;
  for (const [nonce, entry] of Object.entries(state.nonces)) {
    if (nowMs - entry.createdAt > NONCE_EXPIRY_MS) {
      delete state.nonces[nonce];
      pruned += 1;
    }
  }
  return pruned;
}

const TASK_MUTATION_EVENT_TYPES = new Set([
  "status_changed",
  "block_reason_updated",
  "body_updated",
  "override_changed",
]);

function parseEventPayload(event: EventRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 状態・前提を変える既知 event の最新 id を返す */
export function findLatestTaskMutationEventId(store: KanbanStore, taskId: string): number {
  const events = store.listEvents(taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (TASK_MUTATION_EVENT_TYPES.has(event.eventType)) {
      return event.id;
    }
  }
  return 0;
}

function isCurrentBlockTransition(event: EventRow, task: TaskRow): boolean {
  if (event.eventType !== "status_changed" || task.status !== "blocked") {
    return false;
  }
  const payload = parseEventPayload(event);
  return payload?.to === "blocked" && payload.reason === task.blockReason;
}

function isCurrentStewardProposal(events: EventRow[], proposal: EventRow, task: TaskRow): boolean {
  const laterMutations = events.filter(
    (event) => event.id > proposal.id && TASK_MUTATION_EVENT_TYPES.has(event.eventType),
  );
  if (laterMutations.length === 0) {
    return true;
  }
  return laterMutations.length === 1 && isCurrentBlockTransition(laterMutations[0]!, task);
}

/** 現在の状態に対応する最新 steward promote 提案 event id を返す */
export function findLatestStewardPromoteProposalEventId(store: KanbanStore, task: TaskRow): number | null {
  const events = store.listEvents(task.id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventType !== "steward_proposal") {
      continue;
    }
    const payload = parseEventPayload(event);
    if (payload?.kind === "promote" && isCurrentStewardProposal(events, event, task)) {
      return event.id;
    }
  }
  return null;
}

/**
 * タスクの現在状態からハッシュを計算する（stale 検出用）。
 * kind/taskId/状態/提案 event id/状態変更 event id をまとめて比較し、
 * 同じ見た目の blocked 状態へ戻った古い nonce の流用も拒否する。
 */
export function computeStateHash(store: KanbanStore, task: TaskRow, kind: NonceKind): ProposalStateSnapshot {
  const mutationEventId = findLatestTaskMutationEventId(store, task.id);
  const proposalEventId = kind === "steward-promote" ? findLatestStewardPromoteProposalEventId(store, task) : null;
  const fingerprint = {
    kind,
    taskId: task.id,
    status: task.status,
    blockReason: task.blockReason,
    assignee: task.assignee,
    taskUpdatedAt: task.updatedAt,
    mutationEventId,
    proposalEventId,
  };
  return {
    stateHash: sha256Hex(JSON.stringify(fingerprint)).slice(0, 16),
    taskUpdatedAt: task.updatedAt,
    mutationEventId,
    proposalEventId,
  };
}
