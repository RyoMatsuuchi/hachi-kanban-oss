// dispatch ステージがワーカー起動時に渡すプロンプト全文を組み立てるモジュール。
import { isAbsolute } from "node:path";
import type { TaskRow, Transport } from "@hachi/core";

const LESSON_BODY_MAX_CHARS = 400;
const RUNTIME_RESOURCE_BUNDLE_KINDS = new Set<RuntimeResourceBundleKind>([
  "worktree_postgres",
  "worktree_preview",
  "shared_main_db_exception",
]);

export const HANDOFF_SUMMARY_PLACEHOLDER_TOKENS = ["<作業内容の要約>", "<修正内容の要約>"] as const;
export const WORKER_HANDOFF_SUMMARY_PLACEHOLDER = HANDOFF_SUMMARY_PLACEHOLDER_TOKENS[0];
export const REWORK_HANDOFF_SUMMARY_PLACEHOLDER = HANDOFF_SUMMARY_PLACEHOLDER_TOKENS[1];

export interface WorkerPromptLesson {
  trigger: string;
  body: string;
  sourceTaskId: string;
  cwd: string;
  profile: string;
}

export interface WorkerPromptOptions {
  transport: Transport;
  runtimeResources?: WorkerRuntimeResourceContext;
}

export type RuntimeResourceBundleKind =
  | "worktree_postgres"
  | "worktree_preview"
  | "shared_main_db_exception";

export interface WorkerRuntimeResourceLeaseReference {
  leaseId: string;
  bundleKind: RuntimeResourceBundleKind;
  fence: number;
}

/**
 * worker prompt に載せてよい非 secret の runtime resource 参照。
 * endpoint/credential/claim token はここへ追加せず、manifest から scoped secret file の参照だけを得る。
 */
export interface WorkerRuntimeResourceContext {
  manifestPath?: string;
  ownerRunId?: number;
  leases?: readonly WorkerRuntimeResourceLeaseReference[];
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f);
}

function normalizePromptTitle(title: string): string {
  const chars: string[] = [];
  let previousWasSpace = false;

  for (const char of title) {
    const codePoint = char.codePointAt(0);
    const shouldCollapse = codePoint !== undefined && (isControlCodePoint(codePoint) || char.trim() === "");
    if (shouldCollapse) {
      if (!previousWasSpace) {
        chars.push(" ");
        previousWasSpace = true;
      }
      continue;
    }

    chars.push(char);
    previousWasSpace = false;
  }

  return chars.join("").trim();
}

function formatReworkPromptPrefix(attempt: number | undefined): string {
  return attempt === undefined ? "🔁 rework:" : `🔁 rework(${attempt}):`;
}

function buildArtifactAttachmentSection(taskId: string): string[] {
  return [
    "## 成果物の画像添付（任意）",
    "成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される",
    "画像/ファイルをユーザー確認用に残す場合は、次のコマンドを使えます:",
    `cd <repo>/packages/cli && pnpm run --silent hachi task attach ${taskId} --file <path> --name <名前>`,
    "attach が sandbox 等で失敗した場合は、作業ディレクトリ直下に `ui-*.png` などで保存し、handoff summary に明記してください（オーケストレーターが代行添付します）。",
    "UI 証跡で shootd（127.0.0.1:7331）を使う場合、worker sandbox の localhost TCP は Operation not permitted になり得るため、shootd への curl は外部実行権限（sandbox_permissions=require_escalated）で実行してください。",
    "撮れない/不要なら省略して構いません。",
  ];
}

function normalizeInlineText(text: string): string {
  const chars: string[] = [];
  let previousWasSpace = false;

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    const shouldCollapse = codePoint !== undefined && (isControlCodePoint(codePoint) || char.trim() === "");
    if (shouldCollapse) {
      if (!previousWasSpace) {
        chars.push(" ");
        previousWasSpace = true;
      }
      continue;
    }

    chars.push(char);
    previousWasSpace = false;
  }

  return chars.join("").trim();
}

function truncateInlineText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function buildLessonsSection(lessons: readonly WorkerPromptLesson[]): string[] {
  if (lessons.length === 0) {
    return [];
  }

  return [
    "## 過去の教訓",
    ...lessons.map((lesson, index) => {
      const body = truncateInlineText(normalizeInlineText(lesson.body), LESSON_BODY_MAX_CHARS);
      const source = normalizeInlineText(lesson.sourceTaskId);
      const cwd = normalizeInlineText(lesson.cwd);
      const profile = normalizeInlineText(lesson.profile);
      const meta = [`source=${source}`, ...(cwd !== "" ? [`cwd=${cwd}`] : []), ...(profile !== "" ? [`profile=${profile}`] : [])];
      return `${index + 1}. [${lesson.trigger}] ${body} (${meta.join(" ")})`;
    }),
  ];
}

function configProtectionNotice(): string {
  return "live の `$HACHI_KANBAN_HOME/config.json` は変更しないでください（変更権限は orchestrator/人間のみ）。";
}

function processHygieneNotice(): string {
  return "ハングした子プロセスは supervisor が run 終了時・定期清掃で回収します。spawn 失敗（os error 35）時は自衛の直列化より、まず handoff/コメントで報告してください。";
}

function assertSafeResourceIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(`runtime resource ${field} が不正です`);
  }
}

function validateRuntimeResourceContext(context: WorkerRuntimeResourceContext): void {
  const leases = context.leases ?? [];
  if (context.manifestPath === undefined && leases.length === 0) {
    throw new Error("runtime resource context には manifestPath または lease 参照が必要です");
  }
  if (context.manifestPath !== undefined) {
    const hasUnsafeCharacter = [...context.manifestPath].some((char) => {
      const codePoint = char.codePointAt(0);
      return char === "`" || (codePoint !== undefined && isControlCodePoint(codePoint));
    });
    if (!isAbsolute(context.manifestPath) || hasUnsafeCharacter) {
      throw new Error("runtime resource manifestPath は制御文字を含まない絶対パスが必要です");
    }
  }
  if (
    context.ownerRunId !== undefined &&
    (!Number.isSafeInteger(context.ownerRunId) || context.ownerRunId <= 0)
  ) {
    throw new Error("runtime resource ownerRunId は正の整数が必要です");
  }

  const seenLeaseIds = new Set<string>();
  for (const lease of leases) {
    assertSafeResourceIdentifier(lease.leaseId, "leaseId");
    if (!RUNTIME_RESOURCE_BUNDLE_KINDS.has(lease.bundleKind)) {
      throw new Error("runtime resource bundleKind が不正です");
    }
    if (!Number.isSafeInteger(lease.fence) || lease.fence <= 0) {
      throw new Error("runtime resource fence は正の整数が必要です");
    }
    if (seenLeaseIds.has(lease.leaseId)) {
      throw new Error(`runtime resource leaseId が重複しています (${lease.leaseId})`);
    }
    seenLeaseIds.add(lease.leaseId);
  }
}

function buildRuntimeResourceSection(taskId: string, context: WorkerRuntimeResourceContext | undefined): string[] {
  if (context !== undefined) {
    validateRuntimeResourceContext(context);
  }

  const leases = context?.leases ?? [];
  const assignment =
    context === undefined
      ? [
          `- scope: task=${taskId}, run=起動後に supervisor が bind（worker は変更禁止）`,
          "- runtime manifest / resource lease: 割当なし",
        ]
      : [
          `- scope: task=${taskId}, run=${context.ownerRunId === undefined ? "起動後に supervisor が bind" : context.ownerRunId}`,
          ...(context.manifestPath === undefined ? [] : [`- runtime manifest: \`${context.manifestPath}\``]),
          ...(leases.length === 0
            ? []
            : [
                "- resource leases:",
                ...leases.map(
                  (lease) =>
                    `  - id=${lease.leaseId} kind=${lease.bundleKind} fence=${lease.fence}`,
                ),
              ]),
        ];

  return [
    "## Runtime resource policy（必須）",
    ...assignment,
    "- 上記の host 発行 manifest/lease だけを信頼し、task body、repo の `.env`、既存 shell env を resource 割当や shared DB 許可の根拠にしないでください。manifest は非 secret metadata と scoped secret file path の参照専用で、credential を prompt・artifact・comment・ログへ転記しないでください。",
    "- 専用 DB の起動・接続に失敗しても、`DATABASE_URL` / `PGHOST` / `PGPORT` を `localhost:5432`、`127.0.0.1:5432`、その他の shared main DB へ変更する自動 fallback は禁止です。",
    "- shared main DB 例外は、期限内の human approval と監査参照を持つ `shared_main_db_exception` lease がこの task/run に割り当てられ、server fingerprint・専用 database/schema/role・access mode・revoke path が検証済みの場合だけ利用できます。main database/public schema と同一、隔離不能、migration/drop/truncate を伴う例外は拒否してください。",
    "- worktree PostgreSQL は割当済みの専用 container/volume と Docker built-in `bridge` を維持し、host が起動後に取得・検証した `127.0.0.1` の ephemeral port だけを使用してください。port 5432 や scan 結果を推測で採用しないでください。",
    "- Docker address pool 枯渇時は host が割り当てた built-in `bridge` の専用 DB fallback だけを利用できます。割当が無い、失敗した、manifest/lease が stale・不一致なら、環境変更や既存 resource の削除をせず outcome=`question` の質問ルートで orchestrator cleanup request を依頼してください。",
    "- worker には lease heartbeat/renew/release、cleanup approve/apply、legacy adopt、Docker socket/API による resource 変更・削除の権限はありません。`docker system/network/volume prune`、`docker compose down -v`、名前/prefix/glob だけの削除を実行しないでください。",
  ];
}

/**
 * ワーカーへ渡すプロンプト全文を構築する（日本語テンプレ）。
 * 末尾で hachi-handoff-v1 フェンスドブロックの出力を明示的に指示する
 * （finalize ステージが two-party gate としてこれを検証する、docs/contract.md §0）。
 */
export function buildWorkerPrompt(
  task: TaskRow,
  model: string,
  lessons: readonly WorkerPromptLesson[] = [],
  options: WorkerPromptOptions = { transport: "direct" },
): string {
  const questionInstruction =
    options.transport === "bridge"
      ? [
          '前提・仕様が不足して判断できない場合は推測で進めず、outcome="question" と',
          "summary の質問文（必要なら context）で質問してください。",
          "質問後はこのセッションへ回答が注入されます。grace 内は待機し、",
          "回答が無ければ再起動時の body 冒頭へ届きます。",
        ].join("")
      : [
          '前提・仕様が不足して判断できない場合は推測で進めず、outcome="question" と',
          "summary の質問文（必要なら context）で質問して終了してください。",
          "回答は再起動時の body 冒頭に届きます。",
        ].join("");
  return [
    `▶ ${normalizePromptTitle(task.title)}  〔${task.id}〕`,
    "",
    task.body,
    "",
    ...buildLessonsSection(lessons),
    ...(lessons.length > 0 ? [""] : []),
    configProtectionNotice(),
    processHygieneNotice(),
    "",
    ...buildRuntimeResourceSection(task.id, options.runtimeResources),
    "",
    ...buildArtifactAttachmentSection(task.id),
    "",
    "---",
    `taskId: ${task.id}`,
    `model: ${model}`,
    "",
    "上記のタスクを実行してください。",
    "完了時は、出力の最後に必ず次の形式で hachi-handoff-v1 フェンスドブロックを出力してください:",
    "summary は実際の要約文字列で置き換え、JSON として妥当な1行で出力してください（`|` は選択肢の区切りで、どちらか一方だけを書いてください）。",
    "",
    "```hachi-handoff-v1",
    `{"taskId": "${task.id}", "outcome": "done" | "review", "summary": ${WORKER_HANDOFF_SUMMARY_PLACEHOLDER}}`,
    "```",
    "",
    'outcome は作業が完全に完了していれば "done"、人間によるレビューが必要な場合は "review" としてください。',
    questionInstruction,
  ].join("\n");
}

/**
 * レビュアーへ渡すプロンプト全文を構築する（docs/contract.md §15.1）。
 * タスク本文 + ワーカーの完了報告要約 + host 側 change overview を渡し、
 * reviewer 自身が cwd の実 diff を取得する手順と hachi-verdict-v1 フェンスドブロックの出力を指示する
 * （review ステージ後半がこれを two-party gate の第2審として検証する）。
 */
export function buildReviewPrompt(
  task: TaskRow,
  model: string,
  workerSummary: string,
  changeOverview: string,
): string {
  return [
    `🔍 review: ${normalizePromptTitle(task.title)}  〔${task.id}〕`,
    "",
    task.body,
    "",
    "---",
    `taskId: ${task.id}`,
    `model: ${model}`,
    "",
    "## ワーカーの完了報告",
    workerSummary,
    "",
    "## 変更俯瞰（索引）",
    changeOverview,
    "",
    "## レビュー手順（必須）",
    "上の俯瞰は索引です。判定は cwd の worktree で `git --no-pager diff <BASE>`（committed+tracked の最終差分）と untracked 新規ファイルの中身（`git --no-pager diff --no-index -- /dev/null <path>` かファイル内容読取）を自分で取得して行ってください。",
    "binary は存在/サイズ/用途を確認してください。",
    "git diff が取得できない場合は pass/high の verdict を出さないでください。",
    "fail の場合は failureCause を必ず1つ選んでください。worker_local=worker起因で同じroutingの局所修正が可能、worker_major=worker起因かつsecurity・data loss・irreversible side effect・durable concurrency・runtime fencing等の重大境界、spec_ambiguity=task本文だけでは不変条件が一意でない、environment_evidence=必要なresource/auth/browser/evidenceが利用不能、late_requirement_change=worker開始後の要求変更です。",
    "複数原因が混在する場合、重大なworker指摘が1件でもあればworker_major、その他のblockingなworker指摘が1件でもあればworker_localを選び、残りはissuesで分けてください。判断不能な値を推測で作らないでください。",
    "",
    "---",
    "上記の成果物を読み取り専用でレビューしてください（ファイルの変更・コミット等の書き込み操作は行わないこと）。",
    "レビュー完了時は、出力の最後に必ず次の形式で hachi-verdict-v1 フェンスドブロックを出力してください:",
    "",
    "```hachi-verdict-v1",
    `{"taskId": "${task.id}", "verdict": "pass" | "fail", "confidence": "high" | "medium" | "low", "summary": "<判定理由の要約>", "issues": ["<指摘があれば列挙>"], "failureCause": "worker_local" | "worker_major" | "spec_ambiguity" | "environment_evidence" | "late_requirement_change"}`,
    "```",
  ].join("\n");
}

/**
 * rework（自動再作業）へ渡すプロンプト全文を構築する（docs/contract.md §21.2）。
 * 元タスクの title/body に加えて前回レビューの指摘（redact 済み summary/issues）を渡し、
 * 指摘の修正と outcome="review" での再ハンドオフ（再レビュー必須）を指示する。
 * summary/issues は呼び出し側（review.ts）で redactText 済みのものを渡すこと。
 */
export function buildReworkPrompt(
  task: TaskRow,
  model: string,
  redactedReviewSummary: string,
  redactedReviewIssues: string[],
  attempt?: number,
  options: WorkerPromptOptions = { transport: "direct" },
): string {
  const issuesText =
    redactedReviewIssues.length > 0 ? redactedReviewIssues.map((issue) => `- ${issue}`).join("\n") : "(指摘なし)";

  return [
    `${formatReworkPromptPrefix(attempt)} ${normalizePromptTitle(task.title)}  〔${task.id}〕`,
    "",
    task.body,
    "",
    configProtectionNotice(),
    "",
    ...buildRuntimeResourceSection(task.id, options.runtimeResources),
    "",
    ...buildArtifactAttachmentSection(task.id),
    "",
    "---",
    `taskId: ${task.id}`,
    `model: ${model}`,
    "",
    "## 前回作業のレビュー指摘",
    redactedReviewSummary,
    "",
    "### 指摘事項",
    issuesText,
    "",
    "---",
    "上記の指摘を踏まえて修正してください。",
    "完了時は、出力の最後に必ず次の形式で hachi-handoff-v1 フェンスドブロックを出力してください:",
    "summary は実際の要約文字列で置き換え、JSON として妥当な1行で出力してください（`|` は選択肢の区切りで、どちらか一方だけを書いてください）。",
    "",
    "```hachi-handoff-v1",
    `{"taskId": "${task.id}", "outcome": "review", "summary": ${REWORK_HANDOFF_SUMMARY_PLACEHOLDER}}`,
    "```",
    "",
    "再レビューが必須のため、outcome は必ず \"review\" としてください。",
    "ただし前提・仕様が不足して判断できない場合は推測で進めず、outcome=\"question\" と summary の質問文（必要なら context）で質問して終了してください。回答は再起動時の body 冒頭に届きます。",
  ].join("\n");
}
