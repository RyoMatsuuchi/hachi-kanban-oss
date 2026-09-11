// two-party gate: ワーカー完了ハンドオフの検証遷移ステージ（docs/contract.md §0/§10）
// LLM 出力（handoff）は「提案」であり、supervisor が transcript から検証して初めて状態遷移する。
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { injectSession } from "@hachi/adapters";
import {
  classifyRuntimeGenerationInterruption,
  isExternalRuntimeGenerationStore,
  isInProgressReason,
  redactText,
} from "@hachi/core";
import type {
  DurableSteerStore,
  EventRow,
  KanbanStore,
  Logger,
  RunStatus,
  RunRow,
  SessionRef,
  SessionStatus,
  Stage,
  StageDeps,
  StageResult,
  SteerDeliveryRow,
  SteerDeliveryStatus,
  TaskRow,
  WorkerAdapter,
  RuntimeGenerationInterruptionCorrelationV1,
} from "@hachi/core";
import type { ProfileEntryConfig } from "@hachi/core/config-schema";
import type {
  ExternalRuntimeGenerationReader,
  ExternalRuntimeGenerationReadResult,
} from "../external-runtime-generation-reader.js";
import { HANDOFF_NUDGE_GRACE_SECONDS, QUESTION_GRACE_SECONDS, SUPERVISOR_ACTOR } from "../constants.js";
import {
  buildEndRunMeta,
  endStatsFromStatus,
  fetchEndRunStats,
  hasNoEndStats,
  type RunEndStats,
} from "./end-run-meta.js";
import { cancellationForRun, rejectLateResultOnce } from "./cancel.js";
import {
  saveFullTranscriptArtifact,
  saveTranscriptArtifact,
  type SaveFullTranscriptArtifactOptions,
} from "../artifacts.js";
import {
  buildConfigModifiedEventPayload,
  CONFIG_MODIFIED_EVENT_TYPE,
  type ConfigFileSnapshot,
  tryReadConfigFileSnapshot,
} from "../config-protection.js";
import { HANDOFF_SUMMARY_PLACEHOLDER_TOKENS } from "../prompt.js";
import {
  classifyExecutionFailure,
  extractAssistantFence,
  isFenceForTask,
  isHandoffSchema,
  type ClassifiedExecutionFailure,
  type FenceFailureReason,
} from "../fence-extraction.js";
import {
  captureEndEvidenceBestEffort,
  HANDOFF_GIT_EVIDENCE_EVENT_TYPE,
  handoffGitEvidenceProbe,
  parseHandoffGitLaunchSnapshot,
  type HandoffGitEvidence,
} from "../handoff-git-evidence.js";
import {
  hasQuestionAwaitingRecord,
  latestQuestionAwaitingPayload,
  maxSessionEndedResultCount,
  maxSessionEndedResultWatermark,
  QUESTION_AWAITING_EVENT_TYPE,
  type QuestionAwaitingPayload,
} from "../question-awaiting.js";
import {
  extractEventSessionId,
  extractSessionEndSnapshot,
  extractSessionEndedLastResultId,
  latestSessionEndedEvent,
  pickAdapter,
  reconstructSessionRef,
  sessionStatusLastEntryId,
  sessionStatusResultWatermark,
} from "../session-ref.js";
import {
  resolveVerifyPlan,
  executeVerifyPlan,
  classifyVerifyFailure,
  isVerifyEnvironmentFailure,
  isVerifyFailure,
  buildVerifyFailureSummary,
  verifyResultLabel,
} from "./review.js";
import type { VerifyMeta } from "./review.js";

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

const CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;
const HANDOFF_POLICY_DECLARATION_REGEX = /^handoff-policy:[ \t]*(\S+)[ \t]*$/;
const REVIEW_POLICY_DECLARATION_REGEX = /^review-policy:[ \t]*(\S+)[ \t]*$/;
const EVIDENCE_DIR_LINE_REGEX = /^evidence-dir:\s*(\S+)\s*$/gm;
const COMMIT_CONTEXT_REGEX = /(?:commit|コミット)/i;
/**
 * commit したことを述べる肯定表現。ASCII 語には `\b` で語境界を要求し、`uncommitted` /
 * `precommitted` のような前置修飾を肯定主張と誤読しない。日本語側に `\b` は付けない
 * （カタカナ・漢字は word 文字ではないため語頭で境界が成立せず、付けると逆に一致しなくなる）。
 */
const POSITIVE_COMMIT_CLAIM_REGEX =
  /(?:コミット(?:済み|しました|した|作成|完了)|\bcommit済み|\bcommitted\b|\bcreated\s+commits?\b|\bcommit(?:\s+hash)?\s*[:=])/i;
/**
 * commit していないことを述べる否定表現。日本語・英語に加え、実務で頻出する混在形
 * （`commitされていない` / `未commit` / `commit無し` 等）と `uncommitted` も拾う。
 */
const NEGATIVE_COMMIT_CLAIM_REGEX =
  /(?:(?:コミット|commit)\s*(?:は|を|も)?\s*(?:不要|なし|無し|していない|していません|しておらず|せず|されていない|されておらず|されていません|未実施)|未\s*コミット|未\s*commit|\bno\s+commits?\b|\bnot\s+committed\b|\bwithout\s+commits?\b|\buncommitted\b)/i;
/**
 * 肯定/否定の近傍判定に使う文セグメント区切り。`hachi-handoff-v1` の summary は JSON の
 * 1 field であり物理行数は常に 1 になるため、行分割では summary 全体が 1 行に潰れて
 * 肯定と否定が同居してしまう。区切りは改行・句点・セミコロンに限り、読点や `/` では切らない
 * （細かく切るほど否定が近傍から外れて肯定を打ち消せなくなり、誤判定側に倒れるため）。
 * commit hash の有無は近傍ではなく handoff 全体で見る（hash が隣接節にあっても拾えるようにする）。
 */
const COMMIT_CLAIM_SEGMENT_REGEX = /(?:\r?\n|[。；;])/;
const COMMIT_HASH_REGEX = /\b[0-9a-f]{7,64}\b/gi;
/**
 * 16進文字列は commit hash 以外の識別子とも一致する。候補にする前に、所有リポジトリの
 * 手掛かりが無い形＝別種の識別子と読み取れる形を除外する。
 * 直前・直後に接合する区切り（`litellm@<hash>` / `owner/repo@<hash>` / URL 内 /
 * ハイフン区切りの UUID / `transcript-<hash>.txt`）が対象。`:` は `commit: <hash>` を、
 * `.` は commit 範囲表記 `<base>..<tip>` の tip 側を壊すため接合文字に含めない。
 */
const FOREIGN_HASH_PREFIX_REGEX = /[@/\\-]$/;
const FOREIGN_HASH_SUFFIX_REGEX = /^[@/\\-]/;
/** `sha256:` / `digest=` のような別種 hash の名前空間接頭。`commit:` は commit 主張なので含めない。 */
const FOREIGN_HASH_NAMESPACE_REGEX =
  /(?:^|[^0-9A-Za-z])(?:sha\d*|md5|blake\w*|digest|checksum|oid|blob|tree|image|uuid)\s*[:=]\s*$/i;
/** 接頭・接尾の判定に見る前後文字数（名前空間接頭が収まる長さで足りる） */
const FOREIGN_HASH_CONTEXT_WINDOW = 32;
/** 実在確認に git を起こす候補数の上限。超過分は未確認のまま無視する（失敗にはしない） */
const MAX_RESOLVED_COMMIT_CLAIMS = 20;
const ARTIFACT_CONTEXT_REGEX = /(?:artifact|artifacts|成果物|スクリーンショット|screenshot|画像|添付|ファイル|file)/i;
const ARTIFACT_PATH_REGEX =
  /(?:^|[\s"'`(（\[<])((?:\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|(?:\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\.(?:png|jpg|jpeg|webp|gif|txt|md|log|json|html|svg|csv))(?=$|[\s"'`)、，,。)>\]])/gi;
const UI_ARTIFACT_PATH_REGEX =
  /(?:^|[\s"'`(（\[<])(ui-[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp|gif))(?=$|[\s"'`)、，,。)>\]])/gi;
/** basename が UI 証跡（ui-*.png 等）かを判定する。ディレクトリ付き表記の分類に使う（g フラグ無し） */
const UI_ARTIFACT_BASENAME_REGEX = /^ui-[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp|gif)$/i;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * transcript 取得失敗の許容回数（契約 §12.16-1）。同一 sessionId でこの回数に達したら
 * open run を failed で close し needs-manual へ付替する（恒久リーク防止）。
 */
const TRANSCRIPT_FETCH_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_RUN_SECONDS = 7200;
const STEER_TERMINAL_SUMMARY_EVENT_TYPE = "steer_terminal_summary";
const STEER_TERMINAL_SUMMARY_VERSION = 1;
const STEER_TERMINAL_SUMMARY_MAX_KEYS = 20;
const STEER_TERMINAL_SUMMARY_MAX_KEY_LENGTH = 120;

const HANDOFF_NUDGE_MESSAGE =
  "作業は完了しているようですが、出力の最後に hachi-handoff-v1 フェンスがありません。新たな作業はせず、" +
  "ここまでの outcome（done/review/question）と summary を hachi-handoff-v1 フェンスで今すぐ出力してください。";

interface SteerTerminalStateCounts {
  pending: number;
  delivered: number;
  acknowledged: number;
  superseded: number;
  expired: number;
  unknown: number;
}

interface BoundedSteerKeyList {
  count: number;
  keys: string[];
  truncated: boolean;
}

interface SteerTerminalSummary {
  counts: SteerTerminalStateCounts;
  unacknowledged: BoundedSteerKeyList;
  unknown: BoundedSteerKeyList;
}

/**
 * §65.4 の終端表示用 state へ lifecycle status を畳み込む。
 * transport accepted/uncertain は worker 観測を推測せず unknown のままにする。
 */
function steerTerminalState(status: SteerDeliveryStatus): keyof SteerTerminalStateCounts {
  switch (status) {
    case "queued":
    case "dispatching":
      return "pending";
    case "session_observed":
      return "delivered";
    case "acknowledged":
      return "acknowledged";
    case "superseded":
      return "superseded";
    case "stale_cancelled":
    case "failed":
      return "expired";
    case "transport_accepted":
    case "uncertain":
      return "unknown";
  }
}

function boundedSteerKey(messageKey: string): string {
  const normalized = redactText(messageKey).replace(/\s+/g, " ").trim();
  if (normalized.length <= STEER_TERMINAL_SUMMARY_MAX_KEY_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, STEER_TERMINAL_SUMMARY_MAX_KEY_LENGTH - 3)}...`;
}

function boundedSteerKeyList(deliveries: SteerDeliveryRow[]): BoundedSteerKeyList {
  return {
    count: deliveries.length,
    keys: deliveries.slice(0, STEER_TERMINAL_SUMMARY_MAX_KEYS).map((delivery) =>
      boundedSteerKey(delivery.messageKey)
    ),
    truncated: deliveries.length > STEER_TERMINAL_SUMMARY_MAX_KEYS,
  };
}

function buildSteerTerminalSummary(deliveries: SteerDeliveryRow[]): SteerTerminalSummary {
  const counts: SteerTerminalStateCounts = {
    pending: 0,
    delivered: 0,
    acknowledged: 0,
    superseded: 0,
    expired: 0,
    unknown: 0,
  };
  for (const delivery of deliveries) {
    counts[steerTerminalState(delivery.status)] += 1;
  }
  return {
    counts,
    unacknowledged: boundedSteerKeyList(
      deliveries.filter((delivery) => delivery.status !== "acknowledged"),
    ),
    unknown: boundedSteerKeyList(
      deliveries.filter((delivery) =>
        delivery.status === "transport_accepted" || delivery.status === "uncertain"
      ),
    ),
  };
}

function hasSteerTerminalSummary(
  store: KanbanStore,
  taskId: string,
  runId: number,
  sessionId: string,
): boolean {
  return store.listEvents(taskId, STEER_TERMINAL_SUMMARY_EVENT_TYPE).some((event) => {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return payload["version"] === STEER_TERMINAL_SUMMARY_VERSION &&
        payload["runId"] === runId &&
        payload["sessionId"] === sessionId;
    } catch {
      return false;
    }
  });
}

function formatSteerKeyList(label: string, list: BoundedSteerKeyList): string {
  const keys = list.keys.length > 0 ? list.keys.join(", ") : "なし";
  const suffix = list.truncated ? ", ..." : "";
  return `${label} (${list.count}件): ${keys}${suffix}`;
}

function recordSteerTerminalSummaryOnce(store: KanbanStore, openRun: RunRow): void {
  const steerStore = store as KanbanStore & DurableSteerStore;
  const deliveries = steerStore
    .listSteerDeliveries(openRun.taskId)
    .filter((delivery) => delivery.runId === openRun.id && delivery.sessionId === openRun.sessionId);
  // steer 0件を含む全runをversion/run/sessionで冪等化し、終端時の監査記録を必ず残す。
  if (hasSteerTerminalSummary(store, openRun.taskId, openRun.id, openRun.sessionId)) {
    return;
  }

  const summary = buildSteerTerminalSummary(deliveries);
  store.addEvent(openRun.taskId, STEER_TERMINAL_SUMMARY_EVENT_TYPE, SUPERVISOR_ACTOR, {
    version: STEER_TERMINAL_SUMMARY_VERSION,
    runId: openRun.id,
    sessionId: openRun.sessionId,
    counts: summary.counts,
    unacknowledged: summary.unacknowledged,
    unknown: summary.unknown,
  });
  const { counts } = summary;
  store.addComment(
    openRun.taskId,
    SUPERVISOR_ACTOR,
    [
      `Durable steer 終端サマリ v${STEER_TERMINAL_SUMMARY_VERSION}: ` +
        `pending=${counts.pending}, delivered=${counts.delivered}, acknowledged=${counts.acknowledged}, ` +
        `superseded=${counts.superseded}, expired=${counts.expired}, unknown=${counts.unknown}`,
      formatSteerKeyList("未acknowledged key", summary.unacknowledged),
      formatSteerKeyList("unknown key", summary.unknown),
    ].join("\n"),
  );
}

function endRunWithSteerTerminalSummary(
  store: KanbanStore,
  openRun: RunRow,
  status: RunStatus,
  meta?: Record<string, unknown>,
): void {
  store.endRun(openRun.id, status, meta);
  recordSteerTerminalSummaryOnce(store, openRun);
}

async function cleanupDirectRunProcessGroup(
  adapter: WorkerAdapter,
  ref: SessionRef,
  logger: Logger,
  taskId: string,
): Promise<void> {
  if (ref.serverUrl !== "direct" || adapter.stop === undefined) {
    return;
  }
  try {
    // 契約 §34.2.1: stop() は例外を投げなくても stopped:false（already-exited/unsupported/
    // unsignalable/kill-unconfirmed）を返しうる。**戻り値の reason は stopped の値に関わらず
    // 必ず証拠として記録する。** unsignalable/kill-unconfirmed（＝停止未確認）は warn、
    // already-exited/unsupported（＝ベストエフォート cleanup の想定内の結果）は info で残す。
    const result = await adapter.stop(ref);
    const fields = { taskId, sessionId: ref.sessionId, reason: result.reason };
    if (!result.stopped) {
      if (result.reason === "unsignalable" || result.reason === "kill-unconfirmed") {
        logger.warn("finalize: direct run の process group 停止を確認できませんでした", fields);
      } else {
        logger.info("finalize: direct run の process group cleanup は停止呼び出し不要でした（想定内）", fields);
      }
    } else {
      // 契約 §34.2.1: 成功2値（terminated/killed）も stopped:false の4値と同じく reason を
      // 証拠として記録する。stopped:false のときだけ記録すると成功経路の reason が欠落する。
      logger.info("finalize: direct run の process group cleanup が完了しました", fields);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("finalize: direct run の process group cleanup に失敗しました", {
      taskId,
      sessionId: ref.sessionId,
      error: redactText(message),
    });
  }
}

function fullTranscriptArchiveOptions(deps: StageDeps): SaveFullTranscriptArtifactOptions {
  return (deps as StageDepsWithFullTranscriptArchive).fullTranscriptArchive ?? {};
}

function saveFullTranscriptArtifactBestEffort(
  deps: StageDeps,
  taskId: string,
  ref: SessionRef,
  fallbackTranscript: string,
): void {
  try {
    saveFullTranscriptArtifact(
      deps.env,
      taskId,
      ref.sessionId,
      ref.provider,
      ref.serverUrl,
      fallbackTranscript,
      fullTranscriptArchiveOptions(deps),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn("finalize: full transcript の artifact 保存に失敗しました", {
      taskId,
      sessionId: ref.sessionId,
      error: redactText(message),
    });
  }
}

function addConfigModifiedEventIfNeeded(
  store: KanbanStore,
  taskId: string,
  openRun: RunRow,
  currentSnapshot: ConfigFileSnapshot | null,
): void {
  const payload = buildConfigModifiedEventPayload(openRun, currentSnapshot);
  if (payload !== null) {
    store.addEvent(taskId, CONFIG_MODIFIED_EVENT_TYPE, SUPERVISOR_ACTOR, payload);
  }
}

/**
 * finalize Tx 冒頭の再検証に失敗したことを示す内部シグナル（契約 §12.12-1）。
 * Tx 内で throw して better-sqlite3 に自動ロールバックさせ（side effect なし）、
 * stale_finalize_skipped の記録は Tx 外で行う。
 */
class StaleFinalizeAbort extends Error {}

/**
 * Tx 冒頭でタスクと最新 open run を再読込し、この finalize がまだ対象とすべき状態かを検証する
 * （契約 §12.12-1）。fetchTranscript（外部 I/O）を待っている間にタスクが再起動（新 run 開始）
 * されていた場合、旧セッションの handoff/クリーンアップを新セッションへ誤適用しないための最終ゲート。
 * 満たさない場合は StaleFinalizeAbort を throw し、呼び出し元の store.transaction() を丸ごとロールバックさせる。
 */
function assertStillTargetSession(store: KanbanStore, taskId: string, sessionId: string): void {
  const currentTask = store.getTask(taskId);
  const latestRun = store.getLatestOpenRun(taskId);
  const stillValid =
    currentTask !== null &&
    currentTask.status === "blocked" &&
    isInProgressReason(currentTask.blockReason) &&
    latestRun !== null &&
    latestRun.sessionId === sessionId &&
    cancellationForRun(store, latestRun.id) === null;
  if (!stillValid) {
    throw new StaleFinalizeAbort();
  }
}

function exactTargetRun(store: KanbanStore, taskId: string, sessionId: string): RunRow | null {
  const currentTask = store.getTask(taskId);
  const exactRun = store.getOpenRunByTaskSession(taskId, sessionId);
  const latestRun = store.getLatestOpenRun(taskId);
  const stillValid =
    currentTask !== null &&
    currentTask.status === "blocked" &&
    isInProgressReason(currentTask.blockReason) &&
    exactRun !== null &&
    latestRun !== null &&
    latestRun.id === exactRun.id &&
    cancellationForRun(store, exactRun.id) === null;
  return stillValid ? exactRun : null;
}

function assertStillTargetRun(store: KanbanStore, taskId: string, runId: number, sessionId: string): void {
  const exactRun = exactTargetRun(store, taskId, sessionId);
  if (exactRun === null || exactRun.id !== runId) {
    throw new StaleFinalizeAbort();
  }
}

/** stale_finalize_skipped イベントを Tx 外で記録し warn ログを出す（契約 §12.12-1） */
function recordStaleFinalizeSkipped(
  store: KanbanStore,
  logger: Logger,
  taskId: string,
  sessionId: string,
  phase: string,
): void {
  const run = store.getOpenRunByTaskSession(taskId, sessionId);
  if (run !== null && cancellationForRun(store, run.id) !== null) {
    rejectLateResultOnce(store, run, sessionId);
    logger.warn("finalize: cancel fence 後の late result mutation を拒否しました", {
      taskId,
      sessionId,
      phase,
    });
    return;
  }
  store.addEvent(taskId, "stale_finalize_skipped", SUPERVISOR_ACTOR, { sessionId, phase });
  logger.warn("finalize: タスクが再起動されたため stale handoff の適用を中断しました", {
    taskId,
    sessionId,
    phase,
  });
}

interface HandoffPayload {
  taskId: string;
  outcome: "done" | "review" | "question";
  summary: string;
  context: string | null;
  commitClaims: string[];
  artifactPathClaims: string[];
}

/** 16進の走査結果。`foreign` は所有リポジトリの手掛かりが無い形（外部識別子と読める形）。 */
interface CommitHashScan {
  claimed: string[];
  foreign: string[];
}

interface HandoffEvidenceClaims {
  /** 文面から拾った commit hash 候補。実在確認は verify 側で行う（実在しない候補は無視する） */
  commitHashes: string[];
  /**
   * 外部識別子と読めるため候補から外した16進。**失敗の理由には決してしない**が、run 内 commit と
   * 一致した場合だけは「hash が記載されている」証拠として認める。自リポジトリの commit URL を
   * 貼った正当な報告を hash 未記載として block しないための逃がし口。
   */
  foreignCommitHashes: string[];
  artifactPaths: HandoffArtifactPathClaim[];
  commitClaimedWithoutHash: boolean;
}

export interface HandoffArtifactPathClaim {
  path: string;
  source: "structured" | "summary";
  missingIsFailure: boolean;
}

/**
 * commit hash 候補の実在確認の内訳。判定は failures 側で完結し、ここは監査記録のためだけに残す
 * （範囲外の実在 commit ＝ 取り込み済み上流への言及は失敗にせず情報として記録する）。
 */
interface CommitClaimAudit {
  /** 実在を確認できた hash（＝主張として扱ったもの） */
  confirmed: string[];
  /** この run で作られた commit を指していた hash */
  runCommits: string[];
  /** 実在するがこの run の成果ではない hash（取り込み済みの上流 commit 等） */
  upstream: string[];
  /** 実在を確認できず誤検出として無視した16進候補 */
  unresolved: string[];
}

type HandoffEvidenceFailureKind = "policy" | "commit" | "working-tree" | "artifact" | "verifier";

interface HandoffEvidenceFailure {
  kind: HandoffEvidenceFailureKind;
  message: string;
  claim?: string;
}

interface HandoffEvidenceVerificationInput {
  taskId: string;
  cwd: string | null;
  artifactsDir: string;
  evidenceDirs: string[];
  claims: HandoffEvidenceClaims;
  requireCleanWorkingTree: boolean;
  /** 有効 policy が `no-commit` か（未宣言の既定を含む。no-commit 違反判定に使う） */
  noCommitPolicy: boolean;
  /** run 起動時スナップショットと現在 HEAD の実測差分。判定に不要で未取得の場合は null */
  gitEvidence: HandoffGitEvidence | null;
}

interface HandoffEvidenceVerificationResult {
  ok: boolean;
  claims: HandoffEvidenceClaims;
  failures: HandoffEvidenceFailure[];
  /** summary 散文由来の不在候補。状態遷移は妨げず、監査情報として残す。 */
  warnings?: HandoffEvidenceFailure[];
  /** 許可 root 配下で実在を確認できた成果物パス（監査記録用）。 */
  confirmedArtifactPaths?: string[];
  /** commit hash 候補の実在確認の内訳（監査記録用。verifier 差し替え時は未設定でよい） */
  commitClaimAudit?: CommitClaimAudit;
}

interface HandoffEvidenceVerifier {
  verify(input: HandoffEvidenceVerificationInput): Promise<HandoffEvidenceVerificationResult>;
}

interface StageDepsWithHandoffEvidenceVerifier extends StageDeps {
  handoffEvidenceVerifier?: HandoffEvidenceVerifier;
}

interface StageDepsWithFullTranscriptArchive extends StageDeps {
  fullTranscriptArchive?: SaveFullTranscriptArtifactOptions;
}

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
}

interface HandoffPolicyDeclarations {
  policy: "no-commit" | "commit" | "invalid";
  evidenceDirs: string[];
}

type ReviewPolicy = NonNullable<ProfileEntryConfig["reviewPolicy"]>;
type ReviewPolicyDeclaration = ReviewPolicy | "invalid" | null;

interface ArtifactRoot {
  label: string;
  path: string;
}

type DirtyWorkingTreeReportStatus = "clean" | "dirty" | "not-git" | "unavailable";

interface DirtyWorkingTreeReport {
  status: DirtyWorkingTreeReportStatus;
  entries: string[];
  message?: string;
}

interface ClassifiedOutputFailure {
  reason: FenceFailureReason;
  diagnostic: string;
}

type MissingOutputGitTrigger = "worker_output_missing" | "handoff_missing";

interface MissingOutputGitEvidenceContext {
  runId: number;
  evidence: HandoffGitEvidence;
}

/** handoff 証拠検証で実測した git 状態と、その probe 対象 run（exact-run fence 用）。 */
interface HandoffGitEvidenceContext {
  runId: number;
  evidence: HandoffGitEvidence;
}

async function captureMissingOutputGitEvidence(
  deps: StageDeps,
  taskId: string,
  sessionId: string,
): Promise<MissingOutputGitEvidenceContext | null> {
  // 外部 Git probe の開始前に exact open run/session を再確認する。stale finalize は probe 自体を行わない。
  const openRun = exactTargetRun(deps.store, taskId, sessionId);
  if (openRun === null) {
    return null;
  }
  const snapshot = parseHandoffGitLaunchSnapshot(openRun.meta);
  const evidence = await captureEndEvidenceBestEffort(handoffGitEvidenceProbe(deps), snapshot);
  return { runId: openRun.id, evidence };
}

/**
 * handoff 証拠検証のために、run 起動時スナップショットと現在 HEAD の差分を実測する。
 * §65.3 の handoff 欠落経路と違い event は記録しない（bounded Git evidence の二重記録を避ける）が、
 * probe 対象の runId は返す。probe（外部 I/O）待ちの間に同一 sessionId の replacement run が
 * 始まっていた場合に、旧 run 由来の証拠で新 run を終端させないための exact-run fence に使う。
 */
async function captureHandoffGitEvidenceForVerification(
  deps: StageDeps,
  taskId: string,
  sessionId: string,
): Promise<HandoffGitEvidenceContext | null> {
  const openRun = exactTargetRun(deps.store, taskId, sessionId);
  if (openRun === null) {
    return null;
  }
  const snapshot = parseHandoffGitLaunchSnapshot(openRun.meta);
  const evidence = await captureEndEvidenceBestEffort(handoffGitEvidenceProbe(deps), snapshot);
  return { runId: openRun.id, evidence };
}

/**
 * 実測できた場合のみ「この run で worker が作った commit」の数を返す。取得不能・未取得は null。
 * `git merge` で取り込んだ上流 commit は他 ref から到達できるため数えない（言及しただけの
 * 上流 commit や main の取り込みを worker の commit と誤認しないため）。
 */
function actualCommitCount(evidence: HandoffGitEvidence | null): number | null {
  if (evidence === null || evidence.state === "unavailable") {
    return null;
  }
  return evidence.localCommitCount;
}

/**
 * no-commit 違反として確定できる commit 数だけを返す。帰属が ambiguous の場合は、
 * remote-tracking ref で除外された commit の作成主体を断定できないため fail-open にする。
 */
function noCommitViolationCount(evidence: HandoffGitEvidence | null): number | null {
  if (evidence?.localCommitAttribution !== "exact") {
    return null;
  }
  return actualCommitCount(evidence);
}

/** この run で作られた commit の oid を列挙できたか（打ち切られていたら監査は行わない） */
function runCommitOidsFullyEnumerated(evidence: HandoffGitEvidence | null): boolean {
  if (evidence === null || evidence.localCommitCount === null) {
    return false;
  }
  return evidence.localCommitOids.length >= evidence.localCommitCount;
}

/** 候補 hash（短縮形を含む）がこの run で作られた commit を指しているか。 */
function claimMatchesRunCommit(candidate: string, evidence: HandoffGitEvidence | null): boolean {
  if (evidence === null) {
    return false;
  }
  return evidence.localCommitOids.some((oid) => oid.startsWith(candidate));
}

/** 実 git 状態を取れなかった理由のラベル（失敗文言と監査 meta に出す）。 */
function gitTruthUnavailableLabel(evidence: HandoffGitEvidence | null): string {
  if (evidence === null) {
    return "snapshot-unavailable";
  }
  return evidence.unavailableReason ?? "probe-failed";
}

/** 監査用に実 git 状態を meta/payload へ落とす。未取得は null のまま残す。 */
function buildEvidenceGitAudit(evidence: HandoffGitEvidence | null): Record<string, unknown> | null {
  if (evidence === null) {
    return null;
  }
  return {
    state: evidence.state,
    commitCount: evidence.commitCount,
    localCommitCount: evidence.localCommitCount,
    // ambiguous のときは no-commit 違反の見逃しがあり得る。host-finalize の裏取り材料として残す。
    localCommitAttribution: evidence.localCommitAttribution,
    ...(evidence.unavailableReason !== undefined ? { unavailableReason: evidence.unavailableReason } : {}),
  };
}

function boundedCountLabel(count: number | null, truncated: boolean): string {
  if (count === null) {
    return "?";
  }
  return truncated ? `${count}+` : String(count);
}

function formatMissingOutputGitEvidenceComment(evidence: HandoffGitEvidence): string {
  const fileCount = boundedCountLabel(evidence.dirtyFileCount, evidence.dirtyFileCountTruncated);
  const commitCount = boundedCountLabel(evidence.commitCount, false);
  if (evidence.state === "unavailable") {
    return `Git evidence: unavailable (files=${fileCount}, commits=${commitCount}, reason=${evidence.unavailableReason ?? "probe-failed"})`;
  }
  const pathList = evidence.paths.length > 0 ? evidence.paths.join(", ") : "なし";
  const pathSuffix = evidence.pathsTruncated ? ", ..." : "";
  const summary =
    evidence.commitSummaries.length > 0 ? evidence.commitSummaries.join(" / ") : "なし";
  return `Git evidence: ${evidence.state} (files=${fileCount}, paths=${pathList}${pathSuffix}, commits=${commitCount}, summary=${summary})`;
}

function formatMissingOutputGitEvidenceBlockSuffix(evidence: HandoffGitEvidence): string {
  const fileCount = boundedCountLabel(evidence.dirtyFileCount, evidence.dirtyFileCountTruncated);
  const commitCount = boundedCountLabel(evidence.commitCount, false);
  return `[git=${evidence.state} files=${fileCount} commits=${commitCount}]`;
}

function addMissingOutputGitEvidenceEvent(
  store: KanbanStore,
  taskId: string,
  sessionId: string,
  trigger: MissingOutputGitTrigger,
  context: MissingOutputGitEvidenceContext,
): void {
  const { evidence } = context;
  store.addEvent(taskId, HANDOFF_GIT_EVIDENCE_EVENT_TYPE, SUPERVISOR_ACTOR, {
    version: 1,
    trigger,
    runId: context.runId,
    sessionId,
    state: evidence.state,
    dirtyFileCount: evidence.dirtyFileCount,
    dirtyFileCountTruncated: evidence.dirtyFileCountTruncated,
    paths: evidence.paths,
    pathsTruncated: evidence.pathsTruncated,
    commitCount: evidence.commitCount,
    commitSummaries: evidence.commitSummaries,
    ...(evidence.unavailableReason !== undefined ? { unavailableReason: evidence.unavailableReason } : {}),
  });
}

function outputFailureMeta(
  failure: ClassifiedOutputFailure,
  correlation: RuntimeGenerationInterruptionCorrelationV1 | null,
): Record<string, unknown> {
  return {
    outputFailure: {
      reason: correlation?.reason ?? failure.reason,
      diagnostic: redactText(failure.diagnostic),
    },
    ...(failure.reason === "worker_output_missing"
      ? {
          infraCorrelation: correlation === null
            ? { version: 1, state: "unconfirmed" }
            : { ...correlation, state: "confirmed" },
        }
      : {}),
  };
}

/** 0-token/provider拒否または安全な抽出不能を、nudge/placeholder 経路へ流さず終端化する。 */
async function finalizeClassifiedOutputFailure(
  deps: StageDeps,
  task: TaskRow,
  ref: SessionRef,
  adapter: WorkerAdapter,
  transcript: string,
  failure: ClassifiedOutputFailure,
  observedStatus: SessionStatus | null,
): Promise<"applied" | "stale"> {
  const { store, env, logger } = deps;
  const redactedDiagnostic = redactText(failure.diagnostic);
  let transcriptPath: string | null = null;
  let saveErrorMessage: string | null = null;
  try {
    transcriptPath = saveTranscriptArtifact(env, task.id, ref.sessionId, transcript);
  } catch (err) {
    saveErrorMessage = err instanceof Error ? err.message : String(err);
    logger.warn("finalize: 分類済み失敗の transcript 保存に失敗しました", {
      taskId: task.id,
      sessionId: ref.sessionId,
      error: redactText(saveErrorMessage),
    });
  }
  saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);

  let gitEvidenceContext: MissingOutputGitEvidenceContext | null = null;
  if (failure.reason === "worker_output_missing") {
    gitEvidenceContext = await captureMissingOutputGitEvidence(deps, task.id, ref.sessionId);
    if (gitEvidenceContext === null) {
      recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, failure.reason);
      return "stale";
    }
  }

  const observedStats = observedStatus !== null && observedStatus !== undefined
    ? endStatsFromStatus(observedStatus)
    : {};
  const endStats: RunEndStats = hasNoEndStats(observedStats)
    ? await fetchEndRunStats(adapter, ref, logger, task.id, "finalize")
    : observedStats;
  const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
    stage: "finalize",
    taskId: task.id,
    sessionId: ref.sessionId,
  });
  let externalGenerationRead: ExternalRuntimeGenerationReadResult | null = null;
  const externalGenerationReader = (deps as StageDepsWithExternalRuntimeGenerationReader)
    .externalRuntimeGenerationReader;
  if (
    failure.reason === "worker_output_missing" && externalGenerationReader !== undefined &&
    isExternalRuntimeGenerationStore(store)
  ) {
    try {
      externalGenerationRead = await externalGenerationReader.read(ref.provider, Date.now());
    } catch {
      externalGenerationRead = { state: "unknown", code: "read_failed" };
    }
  }
  const endedEvent = latestSessionEndedEvent(
    store.listEvents(task.id, "session_ended")
      .filter((event) => extractEventSessionId(event.payload) === ref.sessionId),
  );
  const terminalObservedAt = (endedEvent?.createdAt ?? Math.floor(Date.now() / 1000)) * 1_000;

  try {
    store.transaction(() => {
      if (gitEvidenceContext !== null) {
        assertStillTargetRun(store, task.id, gitEvidenceContext.runId, ref.sessionId);
      } else {
        assertStillTargetSession(store, task.id, ref.sessionId);
      }
      const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
      let correlation: RuntimeGenerationInterruptionCorrelationV1 | null = null;
      if (
        failure.reason === "worker_output_missing" && openRun !== null &&
        externalGenerationRead?.state === "valid" && isExternalRuntimeGenerationStore(store)
      ) {
        const acceptedAt = Date.now();
        const acceptance = store.acceptExternalRuntimeGenerationStatus(externalGenerationRead.sample, acceptedAt);
        if (acceptance === "accepted" || acceptance === "idempotent") {
          const binding = store.getExternalRuntimeGenerationBinding(openRun.id);
          const status = store.getExternalRuntimeGenerationStatus(ref.provider);
          if (binding !== null && status !== null) {
            correlation = classifyRuntimeGenerationInterruption({
              binding,
              status,
              runStartedAt: openRun.startedAt * 1_000,
              terminalObservedAt,
              nowMs: acceptedAt,
              diagnosticCode: "worker_output_missing",
            });
          }
        }
      }
      const classifiedReason = correlation?.reason ?? failure.reason;
      store.addEvent(task.id, classifiedReason, SUPERVISOR_ACTOR, correlation === null
        ? {
            sessionId: ref.sessionId,
            diagnostic: redactedDiagnostic,
            ...(failure.reason === "worker_output_missing"
              ? { infraCorrelation: { version: 1, state: "unconfirmed" } }
              : {}),
          }
        : { ...correlation, infraCorrelation: { version: 1, state: "confirmed" } });
      if (gitEvidenceContext !== null) {
        addMissingOutputGitEvidenceEvent(
          store,
          task.id,
          ref.sessionId,
          "worker_output_missing",
          gitEvidenceContext,
        );
      }
      const artifactNote =
        transcriptPath !== null
          ? ` (transcript: ${transcriptPath})`
          : ` transcript の保存に失敗しました（${redactText(saveErrorMessage ?? "unknown")}）`;
      const gitEvidenceNote =
        gitEvidenceContext !== null
          ? `\n${formatMissingOutputGitEvidenceComment(gitEvidenceContext.evidence)}`
          : "";
      store.addComment(
        task.id,
        SUPERVISOR_ACTOR,
        `ワーカー実行を ${classifiedReason} と分類しました。${redactedDiagnostic}${artifactNote}${gitEvidenceNote}`,
      );

      if (openRun !== null) {
        addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
        endRunWithSteerTerminalSummary(
          store,
          openRun,
          "failed",
          buildEndRunMeta(openRun, endStats, outputFailureMeta(failure, correlation)),
        );
      }
      store.updateBlockReason(
        task.id,
        `needs-manual: 実行失敗 ${classifiedReason} (session=${ref.sessionId})${
          gitEvidenceContext !== null
            ? ` ${formatMissingOutputGitEvidenceBlockSuffix(gitEvidenceContext.evidence)}`
            : ""
        }`,
        SUPERVISOR_ACTOR,
        "human",
      );
    });
  } catch (err) {
    if (err instanceof StaleFinalizeAbort) {
      recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, failure.reason);
      return "stale";
    }
    throw err;
  }
  await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
  return "applied";
}

function shouldNudgeMissingHandoff(ref: SessionRef): boolean {
  return ref.serverUrl !== "direct";
}

function handoffNudgeSentAt(event: EventRow): number {
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const ts = (parsed as Record<string, unknown>).ts;
      if (typeof ts === "number" && Number.isFinite(ts)) {
        return ts;
      }
    }
  } catch {
    // payload が壊れていてもイベントの作成時刻を正本として救済済み扱いにする。
  }
  return event.createdAt;
}

function handoffMissingCommentBody(
  transcriptPath: string | null,
  saveErrorMessage: string | null,
  afterNudge: boolean,
): string {
  const prefix = afterNudge
    ? "救済リプロンプト後も hachi-handoff-v1 ブロックを取得できませんでした。人間の確認をお願いします。"
    : "ワーカー出力から hachi-handoff-v1 ブロックが検出できませんでした。人間の確認をお願いします。";
  if (transcriptPath !== null) {
    return `${prefix}(transcript: ${transcriptPath})`;
  }
  return `${prefix}transcript の保存に失敗しました（${saveErrorMessage}）`;
}

/**
 * handoff summary がプレースホルダ（未置換テンプレート文字列）かどうかを判定する。
 * prompt.ts の handoff テンプレに実在する既知字句、空文字列、極端に短い summary を検出する。
 * fail-closed: 疑わしい summary は拒否側に倒す。
 */
const SUMMARY_MIN_LENGTH = 10;

function isPlaceholderSummary(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed === "" || trimmed.length < SUMMARY_MIN_LENGTH) {
    return true;
  }
  return HANDOFF_SUMMARY_PLACEHOLDER_TOKENS.some((token) => trimmed.includes(token));
}

/** task.body 中の `cwd: <path>` 行を抽出する（dispatch/review と同じ契約）。 */
function extractCwd(body: string): string | null {
  const match = body.match(CWD_LINE_REGEX);
  const value = match?.[1];
  return value !== undefined && value !== "" ? value : null;
}

function extractHandoffPolicyDeclarations(body: string): HandoffPolicyDeclarations {
  const declarationLine = body
    .split(/\r\n|\n|\r/)
    .find((line) => line.startsWith("handoff-policy:"));
  let policy: HandoffPolicyDeclarations["policy"] = "no-commit";
  if (declarationLine !== undefined) {
    const value = declarationLine.match(HANDOFF_POLICY_DECLARATION_REGEX)?.[1];
    policy = value === "no-commit" || value === "commit" ? value : "invalid";
  }
  const evidenceDirs: string[] = [];
  EVIDENCE_DIR_LINE_REGEX.lastIndex = 0;
  for (const match of body.matchAll(EVIDENCE_DIR_LINE_REGEX)) {
    const value = match[1];
    if (value !== undefined && value !== "" && isAbsolute(value)) {
      evidenceDirs.push(resolve(value));
    }
  }
  return {
    policy,
    evidenceDirs: uniqueStrings(evidenceDirs),
  };
}

function extractReviewPolicyDeclaration(body: string): ReviewPolicyDeclaration {
  const declarationLine = body
    .split(/\r\n|\n|\r/)
    .find((line) => line.startsWith("review-policy:"));
  if (declarationLine === undefined) {
    return null;
  }
  const value = declarationLine.match(REVIEW_POLICY_DECLARATION_REGEX)?.[1];
  return value === "required" || value === "worker-outcome" ? value : "invalid";
}

function resolveReviewPolicy(deps: StageDeps, task: TaskRow): ReviewPolicy {
  const declaration = extractReviewPolicyDeclaration(task.body);
  if (declaration !== null && declaration !== "invalid") {
    return declaration;
  }
  const profileName = task.profile !== "" ? task.profile : deps.config.defaultProfile;
  const profile = deps.config.profiles[profileName] as ProfileEntryConfig | undefined;
  return profile?.reviewPolicy ?? "required";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectStringFields(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          values.push(item);
        }
      }
    }
  }
  return values;
}

/**
 * commit hash の「候補」を取り出す。ここで拾うのは候補までで、実在確認は verify 側で行う
 * （実在しない16進文字列は誤検出として無視し、失敗にしない）。
 */
function extractCommitHashCandidatesFromText(text: string): CommitHashScan {
  const claimed: string[] = [];
  const foreign: string[] = [];
  COMMIT_HASH_REGEX.lastIndex = 0;
  for (const match of text.matchAll(COMMIT_HASH_REGEX)) {
    const value = match[0]!;
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - FOREIGN_HASH_CONTEXT_WINDOW), start);
    const after = text.slice(start + value.length, start + value.length + FOREIGN_HASH_CONTEXT_WINDOW);
    const isForeign =
      FOREIGN_HASH_PREFIX_REGEX.test(before) ||
      FOREIGN_HASH_SUFFIX_REGEX.test(after) ||
      FOREIGN_HASH_NAMESPACE_REGEX.test(before);
    (isForeign ? foreign : claimed).push(value.toLowerCase());
  }
  return { claimed, foreign };
}

/**
 * 近傍セグメント単位で、否定表現に打ち消されていない肯定 commit 主張が残るかを判定する。
 * 同一 summary に肯定と否定が同居しても、同じセグメントに否定があれば肯定は成立しない。
 */
function hasUncancelledPositiveCommitClaim(text: string): boolean {
  for (const segment of text.split(COMMIT_CLAIM_SEGMENT_REGEX)) {
    if (NEGATIVE_COMMIT_CLAIM_REGEX.test(segment)) {
      continue;
    }
    if (POSITIVE_COMMIT_CLAIM_REGEX.test(segment)) {
      return true;
    }
  }
  return false;
}

function collectRegexGroupMatches(regex: RegExp, text: string): string[] {
  const values: string[] = [];
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const value = match[1];
    if (value !== undefined && !value.includes("*")) {
      values.push(value);
    }
  }
  return values;
}

function extractArtifactPathsFromText(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (ARTIFACT_CONTEXT_REGEX.test(line)) {
      paths.push(...collectRegexGroupMatches(ARTIFACT_PATH_REGEX, line));
    }
  }
  paths.push(...collectRegexGroupMatches(UI_ARTIFACT_PATH_REGEX, text));
  return uniqueStrings(paths);
}

/**
 * 抽出済みパスの basename（最後の `/` 以降）が UI 証跡かを判定する。
 * summary 散文由来でも `./ui-x.png` や `screens/ui-x.png` のような表記は
 * bare な `ui-x.png` と同じく不在を failure として扱うための判定。
 */
function isUiArtifactPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return UI_ARTIFACT_BASENAME_REGEX.test(basename);
}

function extractArtifactPathsFromStructuredClaim(text: string): string[] {
  return uniqueStrings([
    ...collectRegexGroupMatches(ARTIFACT_PATH_REGEX, text),
    ...collectRegexGroupMatches(UI_ARTIFACT_PATH_REGEX, text),
  ]);
}

function extractHandoffEvidenceClaims(handoff: HandoffPayload): HandoffEvidenceClaims {
  const summaryCommitHashes: string[] = [];
  const summaryForeignHashes: string[] = [];
  for (const line of handoff.summary.split(/\r?\n/)) {
    if (COMMIT_CONTEXT_REGEX.test(line)) {
      const scan = extractCommitHashCandidatesFromText(line);
      summaryCommitHashes.push(...scan.claimed);
      summaryForeignHashes.push(...scan.foreign);
    }
  }

  const structuredScans = handoff.commitClaims.map((claim) => extractCommitHashCandidatesFromText(claim));
  const structuredCommitHashes = structuredScans.flatMap((scan) => scan.claimed);
  const structuredArtifactPaths = uniqueStrings(
    handoff.artifactPathClaims.flatMap((claim) => extractArtifactPathsFromStructuredClaim(claim)),
  );
  const structuredArtifactPathSet = new Set(structuredArtifactPaths);
  const artifactPaths: HandoffArtifactPathClaim[] = [
    ...structuredArtifactPaths.map((path) => ({
      path,
      source: "structured" as const,
      missingIsFailure: true,
    })),
    ...extractArtifactPathsFromText(handoff.summary)
      .filter((path) => !structuredArtifactPathSet.has(path))
      .map((path) => ({
        path,
        source: "summary" as const,
        missingIsFailure: isUiArtifactPath(path),
      })),
  ];
  const commitHashes = uniqueStrings([...structuredCommitHashes, ...summaryCommitHashes]);
  const foreignCommitHashes = uniqueStrings([
    ...structuredScans.flatMap((scan) => scan.foreign),
    ...summaryForeignHashes,
  ]);

  return {
    commitHashes,
    foreignCommitHashes,
    artifactPaths,
    // hash が handoff のどこにも無いときだけ「hash 無しの肯定主張」とみなす（文面レベルの signal）
    commitClaimedWithoutHash: commitHashes.length === 0 && hasUncancelledPositiveCommitClaim(handoff.summary),
  };
}

function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolveResult) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES },
      (error: ExecFileException | null, stdout: string, stderr: string): void => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolveResult({
          exitCode,
          stdout,
          stderr,
          errorMessage: error === null ? null : error.message,
        });
      },
    );
  });
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root !== "" ? root : null;
}

function gitFailureDetail(result: GitCommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    return stderr;
  }
  return result.errorMessage ?? `exit=${result.exitCode ?? "unknown"}`;
}

/**
 * commit hash 候補を実在確認で仕分ける。**ここでは失敗を作らない。**
 * - 実在しない候補は外部リポジトリの sha / content hash / UUID 等の誤検出として無視する
 * - 実在する候補は、この run で作られた commit か（＝ runCommits）そうでないか（＝ upstream。
 *   取り込み済みの上流 commit への言及）に分けて情報として記録するだけに留める
 *
 * 未達の主張かどうかは、文面ではなく実測した run 内 commit の側から判定する（verifyHandoffEvidence）。
 */
async function classifyCommitClaims(
  gitRoot: string | null,
  candidates: string[],
  foreignCandidates: string[],
  gitEvidence: HandoffGitEvidence | null,
): Promise<CommitClaimAudit> {
  const audit: CommitClaimAudit = { confirmed: [], runCommits: [], upstream: [], unresolved: [] };
  // 除外した16進も、run 内 commit と一致するものだけは記載として認める（自リポジトリの commit URL 等）。
  // git は起こさない。一致しなければ黙って捨てる＝失敗理由にはならない。
  for (const candidate of foreignCandidates) {
    if (claimMatchesRunCommit(candidate, gitEvidence)) {
      audit.confirmed.push(candidate);
      audit.runCommits.push(candidate);
    }
  }
  let resolveCalls = 0;
  for (const candidate of candidates) {
    // 実測した run 内 commit の prefix 一致は git を起こさずに判定できる。監査の可否を
    // 候補数の上限に左右させないため、この判定だけは全候補に対して先に行う。
    if (claimMatchesRunCommit(candidate, gitEvidence)) {
      audit.confirmed.push(candidate);
      audit.runCommits.push(candidate);
      continue;
    }
    if (gitRoot === null || resolveCalls >= MAX_RESOLVED_COMMIT_CLAIMS) {
      audit.unresolved.push(candidate);
      continue;
    }
    resolveCalls += 1;
    const resolved = await runGit(gitRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (resolved.exitCode !== 0) {
      audit.unresolved.push(candidate);
      continue;
    }
    audit.confirmed.push(candidate);
    audit.upstream.push(candidate);
  }
  return audit;
}

async function verifyCleanWorkingTree(gitRoot: string): Promise<HandoffEvidenceFailure | null> {
  const status = await runGit(gitRoot, ["status", "--porcelain=v1"]);
  if (status.exitCode !== 0) {
    return {
      kind: "working-tree",
      message: `working tree 状態の取得に失敗しました: ${gitFailureDetail(status)}`,
    };
  }
  const dirty = status.stdout.trim();
  if (dirty === "") {
    return null;
  }
  const sample = dirty.split(/\r?\n/).slice(0, 5).join("; ");
  return {
    kind: "working-tree",
    message: `working tree が clean ではありません: ${sample}`,
  };
}

async function inspectDirtyWorkingTree(cwd: string | null): Promise<DirtyWorkingTreeReport> {
  if (cwd === null) {
    return { status: "unavailable", entries: [], message: "cwd 行がありません" };
  }
  const gitRoot = await resolveGitRoot(cwd);
  if (gitRoot === null) {
    return { status: "not-git", entries: [] };
  }
  const status = await runGit(gitRoot, ["status", "--porcelain=v1"]);
  if (status.exitCode !== 0) {
    return {
      status: "unavailable",
      entries: [],
      message: gitFailureDetail(status),
    };
  }
  const entries = status.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  return {
    status: entries.length === 0 ? "clean" : "dirty",
    entries,
  };
}

function formatNoCommitDirtyReport(report: DirtyWorkingTreeReport): string {
  if (report.status === "dirty") {
    const shownEntries = report.entries.slice(0, 20);
    const remaining = report.entries.length - shownEntries.length;
    const suffix = remaining > 0 ? `; ... (+${remaining}件)` : "";
    return `handoff-policy: no-commit により working tree clean 検証をスキップしました。dirty files: ${shownEntries.join(
      "; ",
    )}${suffix}`;
  }
  if (report.status === "clean") {
    return "handoff-policy: no-commit により working tree clean 検証をスキップしました。dirty files: なし";
  }
  if (report.status === "not-git") {
    return "handoff-policy: no-commit により working tree clean 検証をスキップしました。cwd は git repository ではありません";
  }
  return `handoff-policy: no-commit により working tree clean 検証をスキップしました。dirty files: 取得失敗 (${report.message ?? "unknown"})`;
}

/** no-commit 違反を fail-open にした場合だけ、オーケストレーター向けの裏取り材料を残す。 */
function formatNoCommitCommitAssessment(evidence: HandoffGitEvidence | null): string | null {
  if (evidence?.localCommitAttribution === "ambiguous") {
    return "handoff-policy: no-commit 違反を判定できませんでした。commit の帰属が ambiguous です";
  }
  if (evidence === null || evidence.state === "unavailable" || evidence.localCommitCount === null) {
    return `handoff-policy: no-commit 違反を判定できませんでした。reason=${gitTruthUnavailableLabel(evidence)}`;
  }
  return null;
}

function isInsideOrSame(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isBareArtifactFilename(claim: string): boolean {
  return !claim.includes("/") && !claim.includes("\\");
}

function uniqueArtifactRoots(roots: ArtifactRoot[]): ArtifactRoot[] {
  const uniqueRoots: ArtifactRoot[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    const resolvedPath = resolve(root.path);
    if (!seenPaths.has(resolvedPath)) {
      seenPaths.add(resolvedPath);
      uniqueRoots.push({ label: root.label, path: resolvedPath });
    }
  }
  return uniqueRoots;
}

function buildArtifactRoots(
  cwd: string | null,
  artifactsDir: string,
  taskId: string,
  evidenceDirs: string[],
  bareFilename: boolean,
): ArtifactRoot[] {
  const cwdRoots: ArtifactRoot[] = cwd !== null ? [{ label: "cwd", path: cwd }] : [];
  const taskArtifactRoot: ArtifactRoot = { label: "task artifacts", path: resolve(artifactsDir, taskId) };
  const evidenceRoots: ArtifactRoot[] = evidenceDirs
    .filter((dir) => isAbsolute(dir))
    .map((dir) => ({ label: "evidence-dir", path: dir }));
  const orderedRoots = bareFilename
    ? [...evidenceRoots, ...cwdRoots, taskArtifactRoot]
    : [...cwdRoots, taskArtifactRoot, ...evidenceRoots];
  return uniqueArtifactRoots(orderedRoots);
}

function artifactAllowedLocationLabel(input: HandoffEvidenceVerificationInput): string {
  return input.evidenceDirs.length > 0 ? "cwd、task artifacts、evidence-dir" : "cwd または task artifacts";
}

const ARTIFACT_PLACEMENT_INSTRUCTION =
  "成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される";

function resolveArtifactCandidates(
  claim: string,
  input: HandoffEvidenceVerificationInput,
): string[] {
  const trimmed = claim.trim();
  if (trimmed === "" || trimmed.includes("*")) {
    return [];
  }

  if (isAbsolute(trimmed)) {
    const absolutePath = resolve(trimmed);
    const roots = buildArtifactRoots(input.cwd, input.artifactsDir, input.taskId, input.evidenceDirs, false);
    return roots.some((root) => isInsideOrSame(root.path, absolutePath)) ? [absolutePath] : [];
  }

  const candidates: string[] = [];
  const roots = buildArtifactRoots(
    input.cwd,
    input.artifactsDir,
    input.taskId,
    input.evidenceDirs,
    isBareArtifactFilename(trimmed),
  );
  for (const root of roots) {
    const candidate = resolve(root.path, trimmed);
    if (isInsideOrSame(root.path, candidate)) {
      candidates.push(candidate);
    }
  }
  return uniqueStrings(candidates);
}

function verifyArtifactPath(
  claim: string,
  input: HandoffEvidenceVerificationInput,
): HandoffEvidenceFailure | null {
  const candidates = resolveArtifactCandidates(claim, input);
  if (candidates.length === 0) {
    return {
      kind: "artifact",
      claim,
      message: `成果物パスが許可された場所（${artifactAllowedLocationLabel(input)}）にありません: ${claim}。${ARTIFACT_PLACEMENT_INSTRUCTION}`,
    };
  }
  if (candidates.some((candidate) => existsSync(candidate))) {
    return null;
  }
  return {
    kind: "artifact",
    claim,
    message: `主張された成果物パスが存在しません: ${claim}。${ARTIFACT_PLACEMENT_INSTRUCTION}`,
  };
}

async function verifyHandoffEvidence(
  input: HandoffEvidenceVerificationInput,
): Promise<HandoffEvidenceVerificationResult> {
  const failures: HandoffEvidenceFailure[] = [];
  const warnings: HandoffEvidenceFailure[] = [];
  const confirmedArtifactPaths: string[] = [];
  const needsGit = input.claims.commitHashes.length > 0 || input.requireCleanWorkingTree;
  const gitRoot = input.cwd !== null && needsGit ? await resolveGitRoot(input.cwd) : null;

  // 16進候補は実在確認で仕分けるだけで失敗にしない。未達の主張は実測した run 内 commit 側から判定する。
  const commitClaimAudit = await classifyCommitClaims(
    gitRoot,
    input.claims.commitHashes,
    input.claims.foreignCommitHashes,
    input.gitEvidence,
  );

  // 文面の主張だけでは block しない。実際に commit が増えたかを起動時スナップショット比較で確かめる。
  const runCommitCount = actualCommitCount(input.gitEvidence);
  const policyViolationCount = noCommitViolationCount(input.gitEvidence);
  if (input.noCommitPolicy && policyViolationCount !== null && policyViolationCount > 0) {
    // no-commit タスクで実際に commit された。hash の有無とは別の違反なので文言を分ける。
    failures.push({
      kind: "commit",
      message: `handoff-policy: no-commit 違反 — run 開始後に commit が ${policyViolationCount} 件作成されています`,
    });
  } else if (input.claims.commitClaimedWithoutHash) {
    if (runCommitCount === null) {
      // 実 git 状態を確認できない場合のみ、従来どおり文面主張で fail-closed にする。
      failures.push({
        kind: "commit",
        message: `コミット済みの主張がありますが commit hash がありません（実 git 状態を検証できません: ${gitTruthUnavailableLabel(
          input.gitEvidence,
        )}）`,
      });
    } else if (runCommitCount > 0 && commitClaimAudit.runCommits.length === 0) {
      failures.push({
        kind: "commit",
        message: `コミット済みの主張がありますが commit hash がありません（run 開始後の commit ${runCommitCount} 件）`,
      });
    }
    // 実測 0 件なら文面がどう読めても commit 主張は成立させない（実 git 状態を正とする）
  } else if (
    runCommitCount !== null &&
    runCommitCount > 0 &&
    commitClaimAudit.runCommits.length === 0 &&
    (input.claims.commitHashes.length > 0 || input.claims.foreignCommitHashes.length > 0) &&
    // oid を全件列挙できたときだけ突合する（打ち切られていたら記載済みでも照合できないため）。
    runCommitOidsFullyEnumerated(input.gitEvidence)
  ) {
    // 監査に必要なのは「この run で作った commit の hash が handoff に残ること」だけ。
    // 上流 commit への言及や実在しない16進があっても、それ自体は失敗理由にしない。
    failures.push({
      kind: "commit",
      message: `run 開始後に作成された commit ${runCommitCount} 件の hash が handoff に記載されていません`,
    });
  }

  if (input.requireCleanWorkingTree && gitRoot !== null) {
    const failure = await verifyCleanWorkingTree(gitRoot);
    if (failure !== null) {
      failures.push(failure);
    }
  }

  for (const artifactClaim of input.claims.artifactPaths) {
    const failure = verifyArtifactPath(artifactClaim.path, input);
    if (failure === null) {
      confirmedArtifactPaths.push(artifactClaim.path);
    } else if (!artifactClaim.missingIsFailure) {
      warnings.push(failure);
    } else {
      failures.push(failure);
    }
  }

  return {
    ok: failures.length === 0,
    claims: input.claims,
    failures,
    warnings,
    confirmedArtifactPaths,
    commitClaimAudit,
  };
}

const DEFAULT_HANDOFF_EVIDENCE_VERIFIER: HandoffEvidenceVerifier = {
  verify: verifyHandoffEvidence,
};

function pickHandoffEvidenceVerifier(deps: StageDeps): HandoffEvidenceVerifier {
  const maybeDeps = deps as StageDepsWithHandoffEvidenceVerifier;
  return maybeDeps.handoffEvidenceVerifier ?? DEFAULT_HANDOFF_EVIDENCE_VERIFIER;
}

function summarizeEvidenceFailures(failures: HandoffEvidenceFailure[]): string {
  return failures.map((failure) => failure.message).join("; ");
}

function buildEvidenceFailurePayload(
  sessionId: string,
  result: HandoffEvidenceVerificationResult,
  gitEvidence: HandoffGitEvidence | null,
): Record<string, unknown> {
  return {
    sessionId,
    git: buildEvidenceGitAudit(gitEvidence),
    failures: result.failures.map((failure) => ({
      kind: failure.kind,
      message: redactText(failure.message),
      claim: failure.claim !== undefined ? redactText(failure.claim) : undefined,
    })),
    warnings: (result.warnings ?? []).map((warning) => ({
      kind: warning.kind,
      message: redactText(warning.message),
      claim: warning.claim !== undefined ? redactText(warning.claim) : undefined,
    })),
    claims: {
      commitHashes: result.claims.commitHashes,
      artifactPaths: result.claims.artifactPaths.map((claim) => redactText(claim.path)),
      artifactPathClaims: result.claims.artifactPaths.map((claim) => ({
        path: redactText(claim.path),
        source: claim.source,
        missingIsFailure: claim.missingIsFailure,
      })),
      commitClaimedWithoutHash: result.claims.commitClaimedWithoutHash,
    },
    artifactClaims: {
      confirmed: (result.confirmedArtifactPaths ?? []).map((path) => redactText(path)),
    },
    commitClaims: result.commitClaimAudit ?? null,
  };
}

function buildEvidenceMeta(
  result: HandoffEvidenceVerificationResult,
  gitEvidence: HandoffGitEvidence | null,
): Record<string, unknown> {
  return {
    status: result.ok ? "passed" : "failed",
    git: buildEvidenceGitAudit(gitEvidence),
    failures: result.failures.map((failure) => ({
      kind: failure.kind,
      message: redactText(failure.message),
      claim: failure.claim !== undefined ? redactText(failure.claim) : undefined,
    })),
    warnings: (result.warnings ?? []).map((warning) => ({
      kind: warning.kind,
      message: redactText(warning.message),
      claim: warning.claim !== undefined ? redactText(warning.claim) : undefined,
    })),
    claims: {
      commitHashes: result.claims.commitHashes,
      artifactPaths: result.claims.artifactPaths.map((claim) => redactText(claim.path)),
      artifactPathClaims: result.claims.artifactPaths.map((claim) => ({
        path: redactText(claim.path),
        source: claim.source,
        missingIsFailure: claim.missingIsFailure,
      })),
      commitClaimedWithoutHash: result.claims.commitClaimedWithoutHash,
    },
    artifactClaims: {
      confirmed: (result.confirmedArtifactPaths ?? []).map((path) => redactText(path)),
    },
    commitClaims: result.commitClaimAudit ?? null,
  };
}

/**
 * tenant に verify コマンドが定義されている場合、outcome=done の handoff に対して verify を実行する。
 * verify が失敗した場合は done 遷移を拒否し needs-manual へ付替する（fail-closed）。
 * verify が未定義またはスキップの場合は VerifySkippedMeta を返す（done 遷移を続行してよい。
 * review 経路と整合し、skip 監査記録を task_runs.meta.verify に残す）。
 */
async function runVerifyForDoneDirect(
  deps: StageDeps,
  task: TaskRow,
): Promise<VerifyMeta> {
  const plan = resolveVerifyPlan(deps, task);
  // skip の場合も plan.meta（VerifySkippedMeta）を返し、run meta に監査記録を残す
  // （review 経路の executeVerifyPlan と整合させる）
  return executeVerifyPlan(deps, plan);
}

/** ハンドオフ JSON を手動検証する。taskId 不一致・型不正はすべて null（fail-closed） */
function parseHandoff(raw: string, expectedTaskId: string): HandoffPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  const taskId = record.taskId;
  if (typeof taskId !== "string" || taskId !== expectedTaskId) {
    return null;
  }

  const outcome = record.outcome;
  if (outcome !== "done" && outcome !== "review" && outcome !== "question") {
    return null;
  }

  const summary = record.summary;
  if (typeof summary !== "string") {
    return null;
  }
  const context = typeof record.context === "string" ? record.context : null;

  const commitClaims = collectStringFields(record, ["commit", "commits", "commitHash", "commitHashes"]);
  const artifactPathClaims = collectStringFields(record, ["artifact", "artifacts", "artifactPath", "artifactPaths"]);

  return { taskId, outcome, summary, context, commitClaims, artifactPathClaims };
}

function normalizeQuestionSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "質問文が空です";
}

function truncateQuestionReason(summary: string): string {
  const normalized = normalizeQuestionSummary(summary);
  return normalized.length <= 80 ? normalized : normalized.slice(0, 80);
}

function buildQuestionComment(summary: string, context: string | null): string {
  const lines = ["ワーカーから質問が届きました。", "", "## 質問", summary];
  if (context !== null && context.trim().length > 0) {
    lines.push("", "## 背景", context);
  }
  return lines.join("\n");
}

function questionIdFor(sessionId: string, baselineResultWatermark: number, summary: string, context: string | null): string {
  const hash = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(baselineResultWatermark))
    .update("\0")
    .update(summary)
    .update("\0")
    .update(context ?? "")
    .digest("hex")
    .slice(0, 16);
  return `q_${hash}`;
}

function questionDeadline(now: number, openRun: RunRow, maxRunSeconds: number | undefined): number {
  const runDeadline = openRun.startedAt + (maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS);
  return Math.min(now + QUESTION_GRACE_SECONDS, runDeadline);
}

export const finalizeStage: Stage = {
  name: "finalize",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const { store, env, logger } = deps;
    const notes: string[] = [];
    let actions = 0;

    for (const task of store.listInProgress()) {
      // 正本は task_runs（block_reason はパースしない。docs/contract.md §12.5-1）。
      // 先に ref を確定し、以降のイベント参照はすべて現在の open run の sessionId でスコープする。
      const ref = reconstructSessionRef(store, task.id);
      if (ref === null) {
        logger.warn("finalize: task_runs から session を再構築できません", { taskId: task.id });
        notes.push(`${task.id}: session再構築失敗`);
        continue;
      }
      const cancelRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
      if (cancelRun !== null && cancellationForRun(store, cancelRun.id) !== null) {
        const hasEndedResult = store
          .listEvents(task.id, "session_ended")
          .some((event) => extractEventSessionId(event.payload) === ref.sessionId);
        if (apply && hasEndedResult) {
          rejectLateResultOnce(store, cancelRun, ref.sessionId);
        }
        notes.push(`${task.id}: cancel fence 後の finalize mutation を拒否しました`);
        continue;
      }

      // 契約 §17.3: ref.serverUrl==="direct" の run は direct adapter へルーティングする。
      // 未構成（direct 指定なのに directAdapters に codex が無い）の場合は fail-safe に skip する。
      let adapter: WorkerAdapter;
      try {
        adapter = pickAdapter(deps, ref);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("finalize: adapter 選択に失敗しました", { taskId: task.id, error: redactText(message) });
        notes.push(`${task.id}: adapter選択エラー`);
        continue;
      }

      // 現在のセッション（open run の sessionId）に紐づく session_ended のみを対象にする。
      // 再起動タスクで過去セッションのイベントを誤参照しない（docs/contract.md §12.5-3）。
      const endedEvents = store
        .listEvents(task.id, "session_ended")
        .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
      const latestEndedEvent = latestSessionEndedEvent(endedEvents);
      if (latestEndedEvent === null) {
        continue;
      }

      // bridge の session_ended は静穏確認済み snapshot に過ぎない。transcript 取得・nudge・run close・
      // task 遷移より先に現在値を再取得し、一致しなければ副作用なしで次 tick へ待つ（§13.4）。
      let confirmedBridgeStatus: SessionStatus | null = null;
      if (ref.serverUrl !== "direct") {
        const endedSnapshot = extractSessionEndSnapshot(latestEndedEvent.payload);
        if (endedSnapshot === null) {
          notes.push(`${task.id}: bridge session_ended snapshot が不正なため finalize をスキップします`);
          continue;
        }
        try {
          confirmedBridgeStatus = await adapter.status(ref);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("finalize: bridge終端 snapshot の再取得に失敗しました", {
            taskId: task.id,
            sessionId: ref.sessionId,
            error: redactText(message),
          });
          notes.push(`${task.id}: bridge終端 snapshot 再取得エラー`);
          continue;
        }
        if (
          confirmedBridgeStatus.state !== "idle" ||
          sessionStatusResultWatermark(confirmedBridgeStatus) !== endedSnapshot.resultWatermark ||
          sessionStatusLastEntryId(confirmedBridgeStatus) !== endedSnapshot.lastEntryId
        ) {
          notes.push(`${task.id}: bridge終端 snapshot が変化したため finalize をスキップします`);
          continue;
        }
      }
      const observedResultCount = maxSessionEndedResultCount(endedEvents, ref.sessionId);
      const observedResultWatermark = maxSessionEndedResultWatermark(endedEvents, ref.sessionId);
      const questionEvents = store.listEvents(task.id, QUESTION_AWAITING_EVENT_TYPE);
      const waitingQuestion = latestQuestionAwaitingPayload(questionEvents, ref.sessionId);
      const latestEndedLastResultId = extractSessionEndedLastResultId(latestEndedEvent.payload);
      if (
        waitingQuestion !== null &&
        waitingQuestion.baselineResultWatermark === undefined &&
        latestEndedLastResultId > 0
      ) {
        notes.push(
          `${task.id}: legacy question_awaiting baseline は lastResultId と比較できないため finalize をスキップします (sessionId=${ref.sessionId}, resultWatermark=${observedResultWatermark})`,
        );
        continue;
      }
      const baselineResultWatermark = waitingQuestion?.baselineResultWatermark ?? waitingQuestion?.baselineResultCount;
      if (waitingQuestion !== null && observedResultWatermark <= (baselineResultWatermark ?? 0)) {
        notes.push(
          `${task.id}: question_awaiting baseline 以内のため finalize をスキップします (sessionId=${ref.sessionId}, resultWatermark=${observedResultWatermark})`,
        );
        continue;
      }

      // handoff_missing 記録済み（現在のセッション分）は人間介入待ち。無限リトライしない（冪等）
      const alreadyMissing = store
        .listEvents(task.id, "handoff_missing")
        .some((event) => extractEventSessionId(event.payload) === ref.sessionId);
      if (alreadyMissing) {
        continue;
      }

      let transcript: string;
      try {
        transcript = await adapter.fetchTranscript(ref);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("finalize: transcript取得に失敗しました", { taskId: task.id, error: redactText(message) });
        notes.push(`${task.id}: transcript取得エラー`);
        // fetchTranscript 自体が失敗した場合は保存すべき transcript が無いため artifact パス無しで
        // warn 相当のコメントのみ残す（docs/contract.md §12.7-2）。
        // ただし transcript 取得は毎 tick リトライされ続けるため、同一 session の失敗コメントは
        // transcript_fetch_failed イベント（payload.sessionId）で冪等化し1回のみ記録する。
        // 記録済みなら以降は warn ログのみに留める（docs/contract.md §12.10-3）。
        // イベント自体はリトライ回数を数えるため毎失敗 tick 記録する（docs/contract.md §12.16-1）。
        // 同一 sessionId のイベント数が閾値に達したら恒久リーク防止のため needs-manual へ強制退避する。
        const priorFailures = store
          .listEvents(task.id, "transcript_fetch_failed")
          .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
        const alreadyReported = priorFailures.length > 0;
        const failureCountAfterThisTick = priorFailures.length + 1;
        const thresholdReached = failureCountAfterThisTick >= TRANSCRIPT_FETCH_FAILURE_THRESHOLD;

        // 契約 §12.18-2: 閾値到達・未到達のどちらの分岐も transcript_fetch_failed イベント
        // （必要ならコメント）の書き込みを伴うため、apply/dry-run 双方で actions に計上する
        // （他分岐の actions 集計との対称性を保つ）。
        actions += 1;

        if (apply) {
          if (thresholdReached) {
            saveFullTranscriptArtifactBestEffort(deps, task.id, ref, "");
            // 契約 §14.5: endRun 前に adapter.status(ref) を1回呼び lastResult / usage を取得する
            // （ベストエフォート。取得失敗時は既存 meta のまま endRun する）。
            const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
            const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
              stage: "finalize",
              taskId: task.id,
              sessionId: ref.sessionId,
            });
            try {
              // (a) 失敗イベント記録 (b) open run の failed close (c) needs-manual への付替を単一 Tx で
              // 原子化する（docs/contract.md §12.6-1 と同様のリーク防止パターン）。
              store.transaction(() => {
                // Tx 冒頭の最終再検証(契約 §12.12-1)。fetchTranscript を毎 tick 待つ間に
                // タスクが再起動されていた場合、旧セッション分の強制退避を新セッションへ誤適用しない。
                assertStillTargetSession(store, task.id, ref.sessionId);

                store.addEvent(task.id, "transcript_fetch_failed", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });

                const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
                if (openRun !== null) {
                  addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                  endRunWithSteerTerminalSummary(store, openRun, "failed", buildEndRunMeta(openRun, endStats));
                }

                store.updateBlockReason(
                  task.id,
                  `needs-manual: transcript 取得不能 (session=${ref.sessionId})`,
                  SUPERVISOR_ACTOR,
                  "human",
                );
              });
            } catch (txErr) {
              if (txErr instanceof StaleFinalizeAbort) {
                recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "transcript_fetch_exhausted");
                continue;
              }
              throw txErr;
            }
            await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
          } else {
            try {
              // 契約 §12.17-3: 閾値未満の記録分岐でも Tx 冒頭で assertStillTargetSession による
              // 再検証を行う。fetchTranscript の await 中にタスクが再起動されていた場合、旧セッション
              // 向けの transcript_fetch_failed イベント/コメントを新セッションへ誤って記録しない。
              store.transaction(() => {
                assertStillTargetSession(store, task.id, ref.sessionId);

                store.addEvent(task.id, "transcript_fetch_failed", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });
                if (!alreadyReported) {
                  store.addComment(
                    task.id,
                    SUPERVISOR_ACTOR,
                    redactText(`ワーカー完了確認中に transcript の取得に失敗しました: ${message}`),
                  );
                }
              });
            } catch (txErr) {
              if (txErr instanceof StaleFinalizeAbort) {
                recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "transcript_fetch_retry");
                continue;
              }
              throw txErr;
            }
          }
        } else {
          // dry-run: apply 時に書き込まれる内容と同じ情報を notes に出す（書き込みはしない、契約 §12.18-2）。
          if (thresholdReached) {
            notes.push(
              `dry-run: ${task.id} transcript_fetch_failed 記録予定 (session=${ref.sessionId}) + needs-manual 付替予定`,
            );
          } else {
            notes.push(
              `dry-run: ${task.id} transcript_fetch_failed 記録予定 (session=${ref.sessionId})${
                alreadyReported ? "" : " + コメント記録予定"
              }`,
            );
          }
        }
        continue;
      }

      let terminalStatus: SessionStatus | null = confirmedBridgeStatus;
      if (terminalStatus === null) {
        try {
          terminalStatus = await adapter.status(ref);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("finalize: 抽出境界用 status の取得に失敗しました", {
            taskId: task.id,
            sessionId: ref.sessionId,
            error: redactText(message),
          });
        }
      }

      const extraction = extractAssistantFence({
        transcript,
        ...(terminalStatus?.raw !== undefined ? { structuredStatusRaw: terminalStatus.raw } : {}),
        ...(ref.serverUrl === "direct" ? { assistantOnlyOutput: true } : {}),
        spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
      });
      const hasValidStructuredResult =
        extraction.kind === "candidate" &&
        extraction.source === "structured_result" &&
        extraction.structuredSuccess === true;
      const earlyFailure: ClassifiedExecutionFailure | null =
        hasValidStructuredResult || isFenceForTask(extraction, task.id) || terminalStatus === null
          ? null
          : classifyExecutionFailure(
              terminalStatus,
              transcript,
              ref.serverUrl === "direct"
                ? "direct_assistant_output"
                : ref.serverUrl.trim() !== ""
                  ? "bridge_transcript"
                  : "unknown",
            );
      if (earlyFailure !== null) {
        actions += 1;
        notes.push(`${task.id}: ${earlyFailure.reason} として分類`);
        if (apply) {
          await finalizeClassifiedOutputFailure(
            deps,
            task,
            ref,
            adapter,
            transcript,
            earlyFailure,
            terminalStatus,
          );
        }
        continue;
      }

      if (extraction.kind === "failure") {
        actions += 1;
        notes.push(`${task.id}: ${extraction.reason} として分類`);
        if (apply) {
          await finalizeClassifiedOutputFailure(
            deps,
            task,
            ref,
            adapter,
            transcript,
            extraction,
            terminalStatus,
          );
        }
        continue;
      }

      const handoff = extraction.kind === "candidate" ? parseHandoff(extraction.raw, task.id) : null;

      if (handoff === null) {
        logger.warn("finalize: handoff ブロックが検出できません", { taskId: task.id });
        notes.push(`${task.id}: handoff欠如/不正`);
        let handoffNudgeGraceExpired = false;
        let countedMissingHandoffAction = false;
        if (shouldNudgeMissingHandoff(ref)) {
          const nudgeEvents = store
            .listEvents(task.id, "handoff_nudge_sent")
            .filter((event) => extractEventSessionId(event.payload) === ref.sessionId);
          const nudgeEvent = nudgeEvents.at(-1);
          if (nudgeEvent === undefined) {
            actions += 1;
            countedMissingHandoffAction = true;
            if (apply) {
              try {
                await injectSession(env.bridges[ref.provider], ref, HANDOFF_NUDGE_MESSAGE);
                try {
                  store.transaction(() => {
                    assertStillTargetSession(store, task.id, ref.sessionId);
                    store.addEvent(task.id, "handoff_nudge_sent", SUPERVISOR_ACTOR, {
                      sessionId: ref.sessionId,
                      ts: now,
                    });
                  });
                } catch (err) {
                  if (err instanceof StaleFinalizeAbort) {
                    recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_nudge_sent");
                    continue;
                  }
                  throw err;
                }
                notes.push(`${task.id}: handoff救済リプロンプト注入`);
                continue;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn("finalize: handoff 救済リプロンプト注入に失敗しました", {
                  taskId: task.id,
                  sessionId: ref.sessionId,
                  error: redactText(message),
                });
                notes.push(`${task.id}: handoff救済リプロンプト失敗`);
              }
            } else {
              notes.push(`dry-run: ${task.id} handoff_nudge_sent 記録予定 (session=${ref.sessionId})`);
              continue;
            }
          } else {
            const elapsedSeconds = now - handoffNudgeSentAt(nudgeEvent);
            if (elapsedSeconds < HANDOFF_NUDGE_GRACE_SECONDS) {
              notes.push(`${task.id}: handoff救済リプロンプト grace 内`);
              continue;
            }
            handoffNudgeGraceExpired = true;
          }
        }
        if (!countedMissingHandoffAction) {
          actions += 1;
        }
        if (apply) {
          // 欠落/不正分岐でも transcript は監査・手動リカバリの材料として artifacts に保存する
          // （docs/contract.md §12.7-2）。捨てずに needs-manual コメントへ artifact パスを含める。
          // ただし transcript 保存は best-effort とする（契約 §12.12-2）。artifact ストレージ障害を
          // resource guard 枠の恒久リークに連動させないため、保存に失敗しても run close + needs-manual
          // 付替は必ず実行する。失敗時はコメントに redact 済みエラーを明記する。
          let transcriptPath: string | null = null;
          let saveErrorMessage: string | null = null;
          try {
            // transcript-<sessionId>.txt に保存する（docs/contract.md §12.17-2）。stale セッションの
            // transcript が現行セッションの監査証跡を上書きしないようファイル名をセッションでスコープする。
            transcriptPath = saveTranscriptArtifact(env, task.id, ref.sessionId, transcript);
          } catch (err) {
            saveErrorMessage = err instanceof Error ? err.message : String(err);
            logger.warn("finalize: transcript の artifact 保存に失敗しました", {
              taskId: task.id,
              error: redactText(saveErrorMessage),
            });
          }
          saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);

          const gitEvidenceContext = await captureMissingOutputGitEvidence(deps, task.id, ref.sessionId);
          if (gitEvidenceContext === null) {
            recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_missing");
            continue;
          }

          // 契約 §14.5: endRun 前に adapter.status(ref) を1回呼び lastResult / usage を取得する
          // （ベストエフォート。取得失敗時は既存 meta のまま endRun する）。
          const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
          const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "finalize",
            taskId: task.id,
            sessionId: ref.sessionId,
          });

          try {
            // (a)(b)(c) を単一 Tx で原子化する（docs/contract.md §12.6-1）。
            // handoff_missing イベント記録だけでは block_reason が codex/claude-in-progress: のまま残り、
            // listInProgress / resource guard から永久に外れない「リーク」になる。open run を failed で close し
            // block_reason を needs-manual へ付け替えることで、人間の対応待ちとして枠を解放する。
            store.transaction(() => {
              // Tx 冒頭の最終再検証（契約 §12.12-1）。fetchTranscript 中に再起動された旧セッションの
              // クリーンアップを新セッションへ誤適用しない。
              assertStillTargetRun(store, task.id, gitEvidenceContext.runId, ref.sessionId);

              store.addEvent(task.id, "handoff_missing", SUPERVISOR_ACTOR, { sessionId: ref.sessionId });
              addMissingOutputGitEvidenceEvent(
                store,
                task.id,
                ref.sessionId,
                "handoff_missing",
                gitEvidenceContext,
              );

              const commentBody = [
                handoffMissingCommentBody(transcriptPath, saveErrorMessage, handoffNudgeGraceExpired),
                formatMissingOutputGitEvidenceComment(gitEvidenceContext.evidence),
              ].join("\n");
              store.addComment(task.id, SUPERVISOR_ACTOR, redactText(commentBody));

              const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
              if (openRun !== null) {
                addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                endRunWithSteerTerminalSummary(store, openRun, "failed", buildEndRunMeta(openRun, endStats));
              }

              store.updateBlockReason(
                task.id,
                `needs-manual: handoff 欠落 (session=${ref.sessionId}) ${formatMissingOutputGitEvidenceBlockSuffix(
                  gitEvidenceContext.evidence,
                )}`,
                SUPERVISOR_ACTOR,
                "human",
              );
            });
          } catch (err) {
            if (err instanceof StaleFinalizeAbort) {
              recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_missing");
              continue;
            }
            throw err;
          }
          await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
        }
        continue;
      }

      actions += 1;

      // プレースホルダ（テンプレート未置換文字列）の検出。ワーカーが handoff テンプレを
      // そのまま出力した場合は fail-closed で拒否する（handoff_rejected イベント記録 + needs-manual 化）。
      if (isPlaceholderSummary(handoff.summary)) {
        logger.warn("finalize: handoff summary がプレースホルダです", { taskId: task.id });
        notes.push(`${task.id}: handoff summary がプレースホルダのため拒否`);
        if (apply) {
          let transcriptPath: string | null = null;
          let saveErrorMessage: string | null = null;
          try {
            transcriptPath = saveTranscriptArtifact(env, task.id, ref.sessionId, transcript);
          } catch (err) {
            saveErrorMessage = err instanceof Error ? err.message : String(err);
            logger.warn("finalize: transcript の artifact 保存に失敗しました", {
              taskId: task.id,
              error: redactText(saveErrorMessage),
            });
          }
          saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);

          const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
          const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "finalize",
            taskId: task.id,
            sessionId: ref.sessionId,
          });

          try {
            store.transaction(() => {
              assertStillTargetSession(store, task.id, ref.sessionId);

              store.addEvent(task.id, "handoff_rejected", SUPERVISOR_ACTOR, {
                sessionId: ref.sessionId,
                reason: "placeholder_summary",
                summary: redactText(handoff.summary),
              });

              const commentBody =
                transcriptPath !== null
                  ? `ワーカーの handoff summary がテンプレートのプレースホルダのままです。人間の確認をお願いします。(transcript: ${transcriptPath})`
                  : `ワーカーの handoff summary がテンプレートのプレースホルダのままです。人間の確認をお願いします。transcript の保存に失敗しました（${saveErrorMessage}）`;
              store.addComment(task.id, SUPERVISOR_ACTOR, redactText(commentBody));

              const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
              if (openRun !== null) {
                addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                endRunWithSteerTerminalSummary(store, openRun, "failed", buildEndRunMeta(openRun, endStats));
              }

              store.updateBlockReason(
                task.id,
                `needs-manual: handoff summary がプレースホルダ (session=${ref.sessionId})`,
                SUPERVISOR_ACTOR,
                "human",
              );
            });
          } catch (err) {
            if (err instanceof StaleFinalizeAbort) {
              recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_rejected");
              continue;
            }
            throw err;
          }
          await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
        }
        continue;
      }

      if (handoff.outcome === "question") {
        const questionSummary = redactText(normalizeQuestionSummary(handoff.summary));
        const questionContext = handoff.context === null ? null : redactText(handoff.context);
        const reason = `worker-question: ${truncateQuestionReason(questionSummary)}`;
        notes.push(`${task.id}: worker question を検出 — worker-question へ付替`);
        if (apply) {
          saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);
          const isBridgeRun = ref.serverUrl !== "direct";
          if (isBridgeRun) {
            const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
            if (openRun === null) {
              logger.warn("finalize: question_awaiting 記録対象の open run が見つかりません", {
                taskId: task.id,
                sessionId: ref.sessionId,
              });
              notes.push(`${task.id}: question_awaiting 対象 run 不在`);
              continue;
            }
            const payload: QuestionAwaitingPayload = {
              sessionId: ref.sessionId,
              baselineResultCount: observedResultCount,
              baselineResultWatermark: observedResultWatermark,
              ...(latestEndedLastResultId > 0 ? { baselineLastResultId: latestEndedLastResultId } : {}),
              deadline: questionDeadline(now, openRun, deps.config.resourceGuard.maxRunSeconds),
              questionId: questionIdFor(ref.sessionId, observedResultWatermark, questionSummary, questionContext),
            };
            try {
              store.transaction((): void => {
                assertStillTargetSession(store, task.id, ref.sessionId);
                const currentQuestionEvents = store.listEvents(task.id, QUESTION_AWAITING_EVENT_TYPE);
                const alreadyRecorded = hasQuestionAwaitingRecord(currentQuestionEvents, payload);
                if (!alreadyRecorded) {
                  store.addComment(task.id, SUPERVISOR_ACTOR, buildQuestionComment(questionSummary, questionContext));
                  store.addEvent(task.id, "question_asked", SUPERVISOR_ACTOR, {
                    sessionId: ref.sessionId,
                    questionId: payload.questionId,
                    question: questionSummary,
                    ...(questionContext !== null ? { context: questionContext } : {}),
                  });
                  store.addEvent(task.id, QUESTION_AWAITING_EVENT_TYPE, SUPERVISOR_ACTOR, { ...payload });
                }
                store.updateBlockReason(task.id, reason, SUPERVISOR_ACTOR, "");
                store.createOrGetOrchestratorRequest({
                  taskId: task.id,
                  questionId: payload.questionId,
                  question: questionSummary,
                  ...(questionContext !== null ? { context: questionContext } : {}),
                  worktree: extractCwd(task.body) ?? "",
                  project: task.tenant,
                });
              });
            } catch (err) {
              if (err instanceof StaleFinalizeAbort) {
                recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "question_awaiting");
                continue;
              }
              throw err;
            }
          } else {
            const directQuestionId = questionIdFor(
              ref.sessionId,
              observedResultCount,
              questionSummary,
              questionContext,
            );
            const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
            const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
              stage: "finalize",
              taskId: task.id,
              sessionId: ref.sessionId,
            });

            try {
              store.transaction(() => {
                assertStillTargetSession(store, task.id, ref.sessionId);

                store.addComment(task.id, SUPERVISOR_ACTOR, buildQuestionComment(questionSummary, questionContext));
                store.addEvent(task.id, "question_asked", SUPERVISOR_ACTOR, {
                  sessionId: ref.sessionId,
                  questionId: directQuestionId,
                  question: questionSummary,
                  ...(questionContext !== null ? { context: questionContext } : {}),
                });
                store.createOrGetOrchestratorRequest({
                  taskId: task.id,
                  questionId: directQuestionId,
                  question: questionSummary,
                  ...(questionContext !== null ? { context: questionContext } : {}),
                  worktree: extractCwd(task.body) ?? "",
                  project: task.tenant,
                });

                const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
                if (openRun !== null) {
                  addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                  endRunWithSteerTerminalSummary(store, openRun, "done", buildEndRunMeta(openRun, endStats));
                }

                store.updateBlockReason(task.id, reason, SUPERVISOR_ACTOR, "");
              });
            } catch (err) {
              if (err instanceof StaleFinalizeAbort) {
                recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "question_asked");
                continue;
              }
              throw err;
            }
            await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
          }
        }
        continue;
      }

      const cwd = extractCwd(task.body);
      const handoffPolicy = extractHandoffPolicyDeclarations(task.body);
      const reviewPolicyDeclaration = extractReviewPolicyDeclaration(task.body);
      const reviewPolicyApplied = resolveReviewPolicy(deps, task);
      // review policy が done 申告を review へ倒した場合、finalize は outcome: review として扱う（§76.1）。
      // 遷移先・finalized event の outcome・done 直行 verify ゲート（§39）はこの実効値で判定し、
      // §43 の証拠検証（requireCleanWorkingTree / noCommitDirtyReport）だけは申告 outcome のままにする。
      // done-origin の非done finalized 判定は to=review かつ outcome=review を要求するため、申告値 done の
      // まま記録すると invalid-done-signal に分類され後続 reviewer pass の done origin を汚染する。
      const effectiveOutcome: "done" | "review" =
        handoff.outcome === "done" && reviewPolicyApplied === "worker-outcome" ? "done" : "review";
      const noCommitPolicy = handoffPolicy.policy === "no-commit";
      const evidenceClaims = extractHandoffEvidenceClaims(handoff);
      // 文面ではなく実 git 状態を正とする。判定を左右する場合だけ probe する
      // （no-commit 違反検知・肯定主張の裏取り・hash 候補が run 内 commit を指すかの突合）。
      const handoffGitContext =
        noCommitPolicy ||
        evidenceClaims.commitClaimedWithoutHash ||
        evidenceClaims.commitHashes.length > 0
          ? await captureHandoffGitEvidenceForVerification(deps, task.id, ref.sessionId)
          : null;
      const gitEvidence = handoffGitContext?.evidence ?? null;
      let evidenceResult: HandoffEvidenceVerificationResult;
      try {
        evidenceResult = await pickHandoffEvidenceVerifier(deps).verify({
          taskId: task.id,
          cwd,
          artifactsDir: env.artifactsDir,
          evidenceDirs: handoffPolicy.evidenceDirs,
          claims: evidenceClaims,
          requireCleanWorkingTree: handoff.outcome === "done" && handoffPolicy.policy === "commit",
          noCommitPolicy,
          gitEvidence,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        evidenceResult = {
          ok: false,
          claims: evidenceClaims,
          failures: [
            {
              kind: "verifier",
              message: `handoff 証拠検証中に例外が発生しました: ${message}`,
            },
          ],
        };
      }
      if (handoffPolicy.policy === "invalid") {
        evidenceResult = {
          ...evidenceResult,
          ok: false,
          failures: [
            {
              kind: "policy",
              message: "handoff-policy 宣言が不正です（許可値: no-commit / commit）",
            },
            ...evidenceResult.failures,
          ],
        };
      }
      if (reviewPolicyDeclaration === "invalid") {
        evidenceResult = {
          ...evidenceResult,
          ok: false,
          failures: [
            {
              kind: "policy",
              message: "review-policy 宣言が不正です（許可値: required / worker-outcome）",
            },
            ...evidenceResult.failures,
          ],
        };
      }

      if (!evidenceResult.ok) {
        const failureSummary = summarizeEvidenceFailures(evidenceResult.failures);
        logger.warn("finalize: handoff 証拠検証に失敗しました", {
          taskId: task.id,
          failures: redactText(failureSummary),
        });
        notes.push(`${task.id}: handoff 証拠検証NG — review-required へ付替`);
        if (apply) {
          let transcriptPath: string | null = null;
          let saveErrorMessage: string | null = null;
          try {
            transcriptPath = saveTranscriptArtifact(env, task.id, ref.sessionId, transcript);
          } catch (err) {
            saveErrorMessage = err instanceof Error ? err.message : String(err);
            logger.warn("finalize: transcript の artifact 保存に失敗しました", {
              taskId: task.id,
              error: redactText(saveErrorMessage),
            });
          }
          saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);

          const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
          const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
            stage: "finalize",
            taskId: task.id,
            sessionId: ref.sessionId,
          });

          try {
            store.transaction(() => {
              assertStillTargetSession(store, task.id, ref.sessionId);
              if (handoffGitContext !== null) {
                // probe 中に run が入れ替わっていた場合、旧 run 由来の git 証拠を新 run へ適用しない
                assertStillTargetRun(store, task.id, handoffGitContext.runId, ref.sessionId);
              }

              store.addEvent(
                task.id,
                "handoff_evidence_failed",
                SUPERVISOR_ACTOR,
                buildEvidenceFailurePayload(ref.sessionId, evidenceResult, gitEvidence),
              );

              const commentBody =
                transcriptPath !== null
                  ? `ワーカーの handoff 証拠検証に失敗しました: ${failureSummary}\n(transcript: ${transcriptPath})`
                  : `ワーカーの handoff 証拠検証に失敗しました: ${failureSummary}\ntranscript の保存に失敗しました（${saveErrorMessage}）`;
              store.addComment(task.id, SUPERVISOR_ACTOR, redactText(commentBody));

              const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
              if (openRun !== null) {
                addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                endRunWithSteerTerminalSummary(
                  store,
                  openRun,
                  "failed",
                  buildEndRunMeta(openRun, endStats, {
                    handoffEvidence: buildEvidenceMeta(evidenceResult, gitEvidence),
                    reviewPolicyApplied,
                    workerOutcome: handoff.outcome,
                  }),
                );
              }

              store.updateBlockReason(
                task.id,
                `review-required: handoff 証拠検証失敗 (session=${ref.sessionId})`,
                SUPERVISOR_ACTOR,
                "human",
              );
            });
          } catch (err) {
            if (err instanceof StaleFinalizeAbort) {
              recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_evidence_failed");
              continue;
            }
            throw err;
          }
          await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
        }
        continue;
      }

      notes.push(`${task.id}: handoff検証OK (outcome=${handoff.outcome})`);
      if (apply) {
        // transcript 保存は best-effort とする（契約 §12.13-1）。成功パス（有効 handoff →
        // done/review 遷移）は artifact ストレージ障害に妨げられてはならない。保存失敗時は
        // 遷移自体は必ず実行した上で、その旨を redact 済みコメントに明記する（§12.12-2 と対称）。
        let saveErrorMessage: string | null = null;
        const noCommitDirtyReport =
          noCommitPolicy && handoff.outcome === "done"
            ? formatNoCommitDirtyReport(await inspectDirtyWorkingTree(cwd))
            : null;
        const noCommitCommitAssessment = noCommitPolicy
          ? formatNoCommitCommitAssessment(gitEvidence)
          : null;
        try {
          // transcript-<sessionId>.txt に保存する（docs/contract.md §12.17-2）。
          saveTranscriptArtifact(env, task.id, ref.sessionId, transcript);
        } catch (err) {
          saveErrorMessage = err instanceof Error ? err.message : String(err);
          logger.warn("finalize: transcript の artifact 保存に失敗しました", {
            taskId: task.id,
            error: redactText(saveErrorMessage),
          });
        }
        saveFullTranscriptArtifactBestEffort(deps, task.id, ref, transcript);

        // outcome=done 直行経路の verify ゲート（§39）。tenant に verify コマンドが定義されている
        // 場合、done 遷移前に verify を実行し、失敗時は needs-manual へ付替する（fail-closed）。
        // review policy で review へ倒した場合は走らせず、review 経路の verify に一本化する（§76.1）。
        let verifyMeta: VerifyMeta | undefined;
        if (effectiveOutcome === "done") {
          // verify は外部コマンド実行を伴うため、実行直前にも stale セッション検証を行う
          // （review 経路の verify_preflight と同型。fetchTranscript 後〜verify 開始前の窓で
          // タスクが再起動されていた場合、旧セッションの verify を新セッションへ誤適用しない）。
          try {
            assertStillTargetSession(store, task.id, ref.sessionId);
          } catch (preflightErr) {
            if (preflightErr instanceof StaleFinalizeAbort) {
              recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "done_verify_preflight");
              continue;
            }
            throw preflightErr;
          }
          verifyMeta = await runVerifyForDoneDirect(deps, task);
          if (verifyMeta !== undefined && isVerifyFailure(verifyMeta)) {
            const verifyFailure = verifyMeta;
            const verifyEnvironmentFailure = isVerifyEnvironmentFailure(verifyFailure);
            logger.warn(
              verifyEnvironmentFailure
                ? "finalize: outcome=done の verify 実行環境に問題があります"
                : "finalize: outcome=done の verify に失敗しました",
              { taskId: task.id },
            );
            notes.push(
              verifyEnvironmentFailure
                ? `${task.id}: done 直行 verify 実行環境失敗 — review-required へ付替`
                : `${task.id}: done 直行 verify 失敗 — needs-manual へ付替`,
            );

            const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
            const verifyFailureSummary = buildVerifyFailureSummary(verifyFailure);
            const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
              stage: "finalize",
              taskId: task.id,
              sessionId: ref.sessionId,
            });
            // 失敗テストだけを再実行し flake（environment_evidence）か再現（worker_local）かを判定する
            // （review 経路の classifyVerifyFailure と同型。verify_environment_failed には適用しない）。
            const retryClassification = verifyEnvironmentFailure
              ? null
              : await classifyVerifyFailure(deps, verifyFailure);
            const verifyFlakeDetected = retryClassification?.failureCause === "environment_evidence";

            try {
              store.transaction(() => {
                assertStillTargetSession(store, task.id, ref.sessionId);

                if (verifyEnvironmentFailure) {
                  // 契約 §39.2: 実行PATH値やHOME配下の情報を event/comment へ転記しない。
                  store.addEvent(task.id, "verify_environment_failed", SUPERVISOR_ACTOR, {
                    sessionId: ref.sessionId,
                    exitCode: verifyFailure.exitCode,
                    runtimePathSource: verifyFailure.runtimePathSource,
                  });
                } else {
                  store.addEvent(task.id, "handoff_verify_failed", SUPERVISOR_ACTOR, {
                    sessionId: ref.sessionId,
                    verify: verifyFailure,
                    failureCause: retryClassification?.failureCause ?? "worker_local",
                    modelFailureCounted: !verifyFlakeDetected,
                    ...(retryClassification === null ? {} : { verifyRetry: retryClassification.verifyRetry }),
                  });

                  store.addComment(
                    task.id,
                    SUPERVISOR_ACTOR,
                    redactText(
                      verifyFlakeDetected
                        ? `ワーカーは done を報告しましたが verify に失敗しました（再実行で flake と判定): ${verifyFailureSummary}`
                        : `ワーカーは done を報告しましたが verify に失敗しました: ${verifyFailureSummary}`,
                    ),
                  );
                }

                const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
                if (openRun !== null) {
                  addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
                  // verify 証跡を run meta に記録する（review 経路の endRun と整合させる。§39 の監査記録）
                  const extraMeta: Record<string, unknown> = {
                    verify: verifyFailure,
                    reviewPolicyApplied,
                    workerOutcome: handoff.outcome,
                  };
                  endRunWithSteerTerminalSummary(
                    store,
                    openRun,
                    "failed",
                    buildEndRunMeta(openRun, endStats, extraMeta),
                  );
                }

                store.updateBlockReason(
                  task.id,
                  verifyEnvironmentFailure
                    ? `review-required: verify_environment_failed (${verifyResultLabel(verifyFailure)})`
                    : verifyFlakeDetected
                      ? `review-required: verify_flake_detected (session=${ref.sessionId})`
                      : `needs-manual: done 直行 verify 失敗 (session=${ref.sessionId})`,
                  SUPERVISOR_ACTOR,
                  "human",
                );
              });
            } catch (err) {
              if (err instanceof StaleFinalizeAbort) {
                recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_verify_failed");
                continue;
              }
              throw err;
            }
            await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
            continue;
          }
        }

        // 契約 §14.5: endRun 前に adapter.status(ref) を1回呼び lastResult / usage を取得する
        // （ベストエフォート。取得失敗時は既存 meta のまま endRun する）。
        const endStats = await fetchEndRunStats(adapter, ref, logger, task.id, "finalize");
        const currentConfigSnapshot = tryReadConfigFileSnapshot(env, logger, {
          stage: "finalize",
          taskId: task.id,
          sessionId: ref.sessionId,
        });

        try {
          // addComment + transition(finalized) + endRun(done) を単一 Tx で原子化する（docs/contract.md §12.8-4）。
          // クラッシュ等で Tx が中断しても「done なのに open run が残る」不整合を残さない。
          store.transaction(() => {
            // Tx 冒頭の最終再検証（契約 §12.12-1）。fetchTranscript 中に再起動された旧セッションの
            // handoff を新セッションへ誤適用しない。
            assertStillTargetSession(store, task.id, ref.sessionId);
            if (handoffGitContext !== null) {
              // probe 中に run が入れ替わっていた場合、旧 run 由来の git 証拠で新 run を done にしない
              assertStillTargetRun(store, task.id, handoffGitContext.runId, ref.sessionId);
            }

            // handoff.summary はワーカー由来の自由文のため、コメントへ書く前に必ず redactText を通す
            // （docs/contract.md §12.7-3）。生データは artifacts のみに置く。transcript 保存に失敗した
            // 場合はその旨も同じコメントに明記する（契約 §12.13-1）。
            const reportLines = [`ワーカー完了報告: ${handoff.summary}`];
            if (noCommitDirtyReport !== null) {
              reportLines.push(noCommitDirtyReport);
            }
            if (noCommitCommitAssessment !== null) {
              reportLines.push(noCommitCommitAssessment);
            }
            for (const warning of evidenceResult.warnings ?? []) {
              const claim = warning.claim === undefined ? "" : ` ${warning.claim}`;
              reportLines.push(`handoff 証拠 warning: ${warning.kind}${claim}`);
            }
            if (saveErrorMessage !== null) {
              reportLines.push(`transcript の保存に失敗しました（${saveErrorMessage}）`);
            }
            const reportBody = reportLines.join("\n");
            store.addComment(task.id, SUPERVISOR_ACTOR, redactText(reportBody));
            // outcome は実効値で記録し、worker の元の申告は workerOutcome として別途残す（run meta と同じ意味）
            store.transition({
              taskId: task.id,
              to: effectiveOutcome,
              actor: SUPERVISOR_ACTOR,
              eventType: "finalized",
              payload: {
                sessionId: ref.sessionId,
                outcome: effectiveOutcome,
                workerOutcome: handoff.outcome,
              },
            });

            const openRun = store.getOpenRunByTaskSession(task.id, ref.sessionId);
            if (openRun !== null) {
              addConfigModifiedEventIfNeeded(store, task.id, openRun, currentConfigSnapshot);
              // verify 成功時のメタ情報も run meta に記録する（verify が実行された場合）
              const extraMeta: Record<string, unknown> = {
                ...(verifyMeta !== undefined ? { verify: verifyMeta } : {}),
                reviewPolicyApplied,
                workerOutcome: handoff.outcome,
              };
              if (
                handoffGitContext !== null ||
                (evidenceResult.warnings?.length ?? 0) > 0 ||
                (evidenceResult.confirmedArtifactPaths?.length ?? 0) > 0
              ) {
                // 実 git 状態または artifact claim を根拠に通した場合、判定材料を監査用に残す
                extraMeta.handoffEvidence = buildEvidenceMeta(evidenceResult, gitEvidence);
              }
              endRunWithSteerTerminalSummary(store, openRun, "done", buildEndRunMeta(openRun, endStats, extraMeta));
            }
          });
        } catch (err) {
          if (err instanceof StaleFinalizeAbort) {
            recordStaleFinalizeSkipped(store, logger, task.id, ref.sessionId, "handoff_success");
            continue;
          }
          throw err;
        }
        await cleanupDirectRunProcessGroup(adapter, ref, logger, task.id);
      }
    }

    return { name: "finalize", actions, skipped: false, notes };
  },
};
