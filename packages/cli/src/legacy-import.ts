// =============================================================================
// 旧ボード import ツール（docs/contract.md §16、一回きりの移行ツール）
// 旧 legacy-hermes ボード（~/.hermes-hachi-dev/kanban/boards/dev/kanban.db）の
// 生きタスク（triage/todo/blocked）を新ボードへ移行する。
// 旧 DB へは読み取り専用アクセスのみ（PRAGMA query_only=ON。書き込み・checkpoint・
// integrity_check 厳禁）。書き込みは KanbanStore 経由でのみ行う（core への直接依存は型のみ）。
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hasKnownReasonPrefix, isInProgressReason } from "@hachi/core";
import type { Environment, KanbanStore, TaskRow, TaskStatus } from "@hachi/core";
import { truncate } from "./output.js";

/** import 対象として許可する旧 status（docs/contract.md §16.2 でマッピングが定義済みのもののみ） */
export const IMPORTABLE_LEGACY_STATUSES = ["triage", "todo", "blocked"] as const;
export type ImportableLegacyStatus = (typeof IMPORTABLE_LEGACY_STATUSES)[number];

function isImportableLegacyStatus(value: string): value is ImportableLegacyStatus {
  return (IMPORTABLE_LEGACY_STATUSES as readonly string[]).includes(value);
}

/** SQL WHERE で既に絞り込み済みのはずの旧 status を実行時にも再検証する（fail-closed の多重防御） */
function assertImportableLegacyStatus(status: string): asserts status is ImportableLegacyStatus {
  if (!isImportableLegacyStatus(status)) {
    throw new Error(`想定外の旧 status です（SQL の絞り込みと矛盾しています）: ${status}`);
  }
}

/** --status CSV の既定値（docs/contract.md §16.1） */
const DEFAULT_STATUS_CSV = "triage,todo,blocked";

/** block_reason 変換で使う先頭切り詰め長（docs/contract.md §16.2） */
const LEGACY_REASON_TRUNCATE_LEN = 200;

/** import 実行時の actor 名（provenance コメント・イベントの actor として記録） */
const IMPORT_ACTOR = "legacy-import";

// ========== 旧 DB 読み取り ==========

/** 旧 DB から読み取ったタスク1件（トレラント。欠落カラムは既定値で埋める） */
export interface LegacyTaskRow {
  legacyId: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  tenant: string;
  assignee: string;
  /** block_reason 相当の生値（block_reason 列があればそれ、無ければ result 列、両方無ければ空文字） */
  blockReasonRaw: string;
  /** epoch 秒 */
  createdAt: number;
}

/**
 * 旧 DB を読み取り専用で開く（PRAGMA query_only=ON + busy_timeout。書き込み厳禁）。
 * fileMustExist:true のため存在しないパスは throw する。
 */
export function openLegacyDatabase(dbPath: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(`旧 DB を開けませんでした: ${dbPath} (${(err as Error).message})`);
  }
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function detectColumns(db: Database.Database): Set<string> {
  const rows = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** 旧スキーマに存在する列だけを SELECT に含める（無い列は読み取り後に既定値で埋める） */
const OPTIONAL_SELECT_COLUMNS = [
  "title",
  "body",
  "priority",
  "tenant",
  "assignee",
  "block_reason",
  "result",
  "created_at",
] as const;

function buildSelectColumns(columns: ReadonlySet<string>): string {
  const wanted = ["id", "status", ...OPTIONAL_SELECT_COLUMNS].filter((name) => columns.has(name));
  return wanted.join(", ");
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : undefined;
}

function mapLegacyRow(row: Record<string, unknown>): LegacyTaskRow {
  const legacyId = readString(row, "id") ?? "";
  const status = readString(row, "status") ?? "";
  const blockReasonRaw = readString(row, "block_reason") ?? readString(row, "result") ?? "";

  return {
    legacyId,
    title: readString(row, "title") ?? "",
    body: readString(row, "body") ?? "",
    status,
    priority: readNumber(row, "priority") ?? 0,
    tenant: readString(row, "tenant") ?? "",
    assignee: readString(row, "assignee") ?? "",
    blockReasonRaw,
    createdAt: readNumber(row, "created_at") ?? 0,
  };
}

/**
 * 旧 DB の tasks から import 対象候補を読み取る（読み取り専用）。
 * statuses / taskIds（指定時のみ）で絞り込む。id/status 列が無いスキーマは想定外として throw する。
 */
export function readLegacyTasks(
  db: Database.Database,
  statuses: readonly ImportableLegacyStatus[],
  taskIds: readonly string[],
): LegacyTaskRow[] {
  const columns = detectColumns(db);
  if (!columns.has("id") || !columns.has("status")) {
    throw new Error("旧 DB の tasks テーブルに id/status 列が見つかりません（想定外のスキーマです）");
  }

  const selectColumns = buildSelectColumns(columns);
  const statusPlaceholders = statuses.map(() => "?").join(", ");
  const params: unknown[] = [...statuses];

  let sql = `SELECT ${selectColumns} FROM tasks WHERE status IN (${statusPlaceholders})`;
  if (taskIds.length > 0) {
    const idPlaceholders = taskIds.map(() => "?").join(", ");
    sql += ` AND id IN (${idPlaceholders})`;
    params.push(...taskIds);
  }
  const orderColumn = columns.has("created_at") ? "created_at" : "id";
  sql += ` ORDER BY ${orderColumn} ASC`;

  const rawRows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rawRows.map(mapLegacyRow);
}

// ========== block_reason 変換（docs/contract.md §16.2） ==========

/** convertLegacyBlockReason の戻り値。wasConverted は assignee=human 付替の要否判定に使う */
export interface LegacyBlockReasonConversion {
  reason: string;
  /** true の場合は needs-manual: (imported) への変換が発生している（旧文脈の判断を人間に委ねるため assignee=human） */
  wasConverted: boolean;
}

/**
 * 旧 block reason を新 REASON_PREFIXES 体系へ変換する。
 * 既知 prefix に一致する場合はそのまま採用する（wasConverted=false）。ただし in-progress prefix
 * （codex-in-progress:/claude-in-progress:）は supervisor 専有のため、旧データ由来であっても
 * 採用せず変換対象とする（task.ts の runBlock と同じ fail-closed 方針。契約 §12.11-2）。
 * 一致しない場合は `needs-manual: (imported) <元 reason 先頭200字>` に変換する（wasConverted=true。
 * 呼び出し側は契約 §16.2 に従い assignee=human を付ける）。
 */
export function convertLegacyBlockReason(rawReason: string): LegacyBlockReasonConversion {
  const trimmed = rawReason.trim();
  if (trimmed.length > 0 && hasKnownReasonPrefix(trimmed) && !isInProgressReason(trimmed)) {
    return { reason: trimmed, wasConverted: false };
  }
  const truncated = truncate(trimmed, LEGACY_REASON_TRUNCATE_LEN);
  const summary = truncated.length > 0 ? truncated : "(旧理由なし)";
  return { reason: `needs-manual: (imported) ${summary}`, wasConverted: true };
}

// ========== 冪等性: import 状態ファイル ==========

/** legacyId → 新タスク id のマップ */
export type LegacyImportState = Record<string, string>;

function stateFilePath(env: Environment): string {
  return join(env.home, "state", "legacy-import.json");
}

interface ReadStateResult {
  state: LegacyImportState;
  warning?: string;
}

/**
 * import 状態ファイルを読み込む（docs/contract.md §16.3 の実装簡素化案）。
 * ファイル欠損・パース失敗時は fail-open で空マップを返し、warning に理由を記録する
 * （dry-run 出力で「二重 import の恐れがある」旨を必ず警告表示するため）。
 */
export function readLegacyImportState(env: Environment): ReadStateResult {
  const path = stateFilePath(env);
  if (!existsSync(path)) {
    return {
      state: {},
      warning:
        "import 状態ファイルが見つかりません（初回実行、または消失）。冪等性判定はこのファイルのみに依存するため、重複 import の恐れがあります（fail-open）",
    };
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("トップレベルはオブジェクトである必要があります");
    }
    const state: LegacyImportState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        state[key] = value;
      }
    }
    return { state };
  } catch (err) {
    return {
      state: {},
      warning: `import 状態ファイルの読み込みに失敗しました（${(err as Error).message}）。fail-open で継続します（重複 import の恐れがあります）`,
    };
  }
}

/** import 状態ファイルを保存する（apply 成功のたびに呼び出し、クラッシュ時の損失範囲を最小化する） */
export function writeLegacyImportState(env: Environment, state: LegacyImportState): void {
  const dir = join(env.home, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFilePath(env), JSON.stringify(state, null, 2), "utf8");
}

// ========== 変換計画 ==========

export type LegacyImportItemStatus = "pending" | "already-imported";

export interface LegacyImportPlanItem {
  legacy: LegacyTaskRow;
  itemStatus: LegacyImportItemStatus;
  /** itemStatus==='already-imported' の場合のみ設定される既存の新タスク id */
  existingNewId?: string;
  /** itemStatus==='pending' の場合のみ設定される変換後 status */
  targetStatus?: ImportableLegacyStatus;
  /** targetStatus==='blocked' の場合のみ設定される変換後 block_reason */
  targetBlockReason?: string;
  /**
   * targetStatus==='blocked' かつ block_reason が needs-manual: (imported) へ変換された場合のみ
   * 'human' が設定される（docs/contract.md §16.2: 旧文脈の判断は人間に委ねる。fail-closed）。
   * 未設定時は旧 assignee をそのまま引き継ぐ。
   */
  targetAssignee?: string;
}

/** 旧タスク一覧と import 状態から変換計画を組み立てる（副作用なし） */
export function buildImportPlan(
  legacyTasks: readonly LegacyTaskRow[],
  state: LegacyImportState,
): LegacyImportPlanItem[] {
  return legacyTasks.map((legacy) => {
    const existingNewId = state[legacy.legacyId];
    if (existingNewId !== undefined) {
      return { legacy, itemStatus: "already-imported", existingNewId };
    }

    assertImportableLegacyStatus(legacy.status);
    if (legacy.status === "blocked") {
      const conversion = convertLegacyBlockReason(legacy.blockReasonRaw);
      return {
        legacy,
        itemStatus: "pending",
        targetStatus: "blocked",
        targetBlockReason: conversion.reason,
        ...(conversion.wasConverted ? { targetAssignee: "human" } : {}),
      };
    }
    return { legacy, itemStatus: "pending", targetStatus: legacy.status };
  });
}

// ========== apply（KanbanStore への書き込み） ==========

export interface LegacyImportApplyResult {
  legacyId: string;
  newTaskId: string;
  targetStatus: TaskStatus;
}

/**
 * pending な1件を新ボードへ取り込む（単一トランザクション）。
 * triage で作成 → todo は transition、blocked は triage→ready→block() で遷移させる
 * （core の許可遷移マップ ready→blocked のみが blocked 到達経路のため）。
 * 最後に provenance コメントと legacy_imported イベントを記録する（docs/contract.md §16.2/16.3）。
 */
export function applyImportItem(store: KanbanStore, item: LegacyImportPlanItem): LegacyImportApplyResult {
  if (item.itemStatus !== "pending" || item.targetStatus === undefined) {
    throw new Error(`apply 対象ではないアイテムです（既に import 済みの可能性があります）: ${item.legacy.legacyId}`);
  }
  const legacy = item.legacy;
  const targetStatus = item.targetStatus;
  const createdIso = new Date(legacy.createdAt * 1000).toISOString();

  const task = store.transaction((): TaskRow => {
    const created = store.createTask(
      {
        title: legacy.title,
        body: legacy.body,
        tenant: legacy.tenant,
        assignee: legacy.assignee,
        priority: legacy.priority,
      },
      IMPORT_ACTOR,
    );

    let current: TaskRow = created;
    if (targetStatus === "todo") {
      current = store.transition({ taskId: created.id, to: "todo", actor: IMPORT_ACTOR });
    } else if (targetStatus === "blocked") {
      store.transition({ taskId: created.id, to: "ready", actor: IMPORT_ACTOR });
      const reason = item.targetBlockReason;
      if (reason === undefined) {
        throw new Error(`blocked 変換に block_reason がありません: ${legacy.legacyId}`);
      }
      current = store.block(created.id, reason, IMPORT_ACTOR, item.targetAssignee);
    }

    store.addComment(
      current.id,
      IMPORT_ACTOR,
      `imported from hermes kanban ${legacy.legacyId} (created ${createdIso}, status ${legacy.status})`,
    );
    store.addEvent(current.id, "legacy_imported", IMPORT_ACTOR, {
      legacyId: legacy.legacyId,
      legacyStatus: legacy.status,
      legacyCreatedAt: createdIso,
    });

    return current;
  });

  return { legacyId: legacy.legacyId, newTaskId: task.id, targetStatus: task.status };
}

// ========== オーケストレーション ==========

export interface LegacyImportCliOptions {
  dbPath: string;
  /** 未指定時は DEFAULT_STATUS_CSV を使う */
  statusCsv: string | undefined;
  taskIds: readonly string[];
  apply: boolean;
}

export interface LegacyImportReport {
  apply: boolean;
  dbPath: string;
  statuses: readonly ImportableLegacyStatus[];
  warning?: string;
  /** --task で指定されたが旧 DB 内で見つからなかった id */
  notFoundTaskIds: string[];
  items: LegacyImportPlanItem[];
  applied: LegacyImportApplyResult[];
  errors: Array<{ legacyId: string; message: string }>;
}

function parseStatusCsv(raw: string | undefined): ImportableLegacyStatus[] {
  const csv = raw ?? DEFAULT_STATUS_CSV;
  const parts = csv
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error("--status には最低1つの状態を指定してください");
  }

  const result: ImportableLegacyStatus[] = [];
  for (const part of parts) {
    if (!isImportableLegacyStatus(part)) {
      throw new Error(
        `--status に指定できるのは triage/todo/blocked のみです（done/archived は移行対象外です）: ${part}`,
      );
    }
    if (!result.includes(part)) {
      result.push(part);
    }
  }
  return result;
}

/**
 * import-legacy の本体。旧 DB を読み取り専用で開いて計画を組み立て、--apply 指定時のみ
 * KanbanStore（新ボード）へ書き込む。env/store は呼び出し側（CliDeps）から渡す
 * （このモジュール自体は CliDeps に依存しない薄い実装にする）。
 */
export function runLegacyImport(
  env: Environment,
  store: KanbanStore,
  options: LegacyImportCliOptions,
): LegacyImportReport {
  const statuses = parseStatusCsv(options.statusCsv);
  if (!existsSync(options.dbPath)) {
    throw new Error(`旧 DB ファイルが見つかりません: ${options.dbPath}`);
  }

  const db = openLegacyDatabase(options.dbPath);
  let legacyTasks: LegacyTaskRow[];
  try {
    legacyTasks = readLegacyTasks(db, statuses, options.taskIds);
  } finally {
    db.close();
  }

  const notFoundTaskIds = options.taskIds.filter(
    (id) => !legacyTasks.some((task) => task.legacyId === id),
  );

  const { state, warning } = readLegacyImportState(env);
  const items = buildImportPlan(legacyTasks, state);

  const applied: LegacyImportApplyResult[] = [];
  const errors: Array<{ legacyId: string; message: string }> = [];

  if (options.apply) {
    const nextState: LegacyImportState = { ...state };
    for (const item of items) {
      if (item.itemStatus !== "pending") {
        continue;
      }
      try {
        const result = applyImportItem(store, item);
        applied.push(result);
        nextState[result.legacyId] = result.newTaskId;
        // 1件ごとに永続化する（クラッシュ時に既 import 分の状態を失わない。fail-open の影響範囲最小化）
        writeLegacyImportState(env, nextState);
      } catch (err) {
        errors.push({
          legacyId: item.legacy.legacyId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    apply: options.apply,
    dbPath: options.dbPath,
    statuses,
    ...(warning !== undefined ? { warning } : {}),
    notFoundTaskIds,
    items,
    applied,
    errors,
  };
}

// ========== 表示整形 ==========

/** LegacyImportReport をテキスト表示用の行配列に整形する（docs/contract.md §16.1 の dry-run 出力要件） */
export function formatLegacyImportReport(report: LegacyImportReport): string[] {
  const pending = report.items.filter((item) => item.itemStatus === "pending");
  const skipped = report.items.filter((item) => item.itemStatus === "already-imported");

  const lines: string[] = [
    `旧 DB: ${report.dbPath} / 対象 status: ${report.statuses.join(",")} / モード: ${report.apply ? "apply" : "dry-run"}`,
    `対象件数: ${pending.length}件（import 済みスキップ: ${skipped.length}件）`,
  ];

  if (report.warning !== undefined) {
    lines.push(`警告: ${report.warning}`);
  }
  if (report.notFoundTaskIds.length > 0) {
    lines.push(`警告: 指定した --task が旧 DB 内で見つかりませんでした: ${report.notFoundTaskIds.join(", ")}`);
  }

  lines.push("", "=== 対象（変換内容） ===");
  if (pending.length === 0) {
    lines.push("(対象タスクはありません)");
  } else {
    for (const item of pending) {
      const legacy = item.legacy;
      const reasonPart = item.targetBlockReason !== undefined ? ` block_reason="${item.targetBlockReason}"` : "";
      const assigneeDisplay = item.targetAssignee ?? legacy.assignee;
      const assigneeNote = item.targetAssignee !== undefined ? " (人間確認へ付替)" : "";
      lines.push(
        `${legacy.legacyId} [${legacy.status} -> ${item.targetStatus}] title="${legacy.title}" tenant="${legacy.tenant}" priority=${legacy.priority} assignee="${assigneeDisplay}"${assigneeNote}${reasonPart}`,
      );
    }
  }

  lines.push("", "=== スキップ（import 済み） ===");
  if (skipped.length === 0) {
    lines.push("(該当なし)");
  } else {
    for (const item of skipped) {
      lines.push(`${item.legacy.legacyId} -> 既に import 済みです: ${item.existingNewId}`);
    }
  }

  if (report.apply) {
    lines.push("", "=== apply 結果 ===");
    if (report.applied.length === 0 && report.errors.length === 0) {
      lines.push("(apply 対象はありませんでした)");
    }
    for (const result of report.applied) {
      lines.push(`${result.legacyId} -> 作成しました: ${result.newTaskId} (status=${result.targetStatus})`);
    }
    for (const error of report.errors) {
      lines.push(`${error.legacyId} -> エラー: ${error.message}`);
    }
  }

  return lines;
}
