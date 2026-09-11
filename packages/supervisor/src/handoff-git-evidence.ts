import { execFile, type ExecFileException } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { redactText } from "@hachi/core";
import type { StageDeps } from "@hachi/core";

export const HANDOFF_GIT_LAUNCH_META_KEY = "handoffGitLaunchSnapshot";
export const HANDOFF_GIT_EVIDENCE_EVENT_TYPE = "handoff_git_evidence_v1";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 256 * 1024;
const MAX_DIRTY_FILE_COUNT = 200;
const MAX_RECORDED_PATHS = 20;
const MAX_PATH_LENGTH = 240;
const MAX_COMMIT_SUMMARIES = 5;
const MAX_LOCAL_COMMIT_OIDS = 20;
const MAX_COMMIT_SUMMARY_LENGTH = 200;
const OID_REGEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNAVAILABLE_REASONS = new Set<HandoffGitUnavailableReason>([
  "snapshot-unavailable",
  "cwd-unavailable",
  "not-git",
  "timeout",
  "output-limit",
  "probe-failed",
  "invalid-output",
  "ownership-mismatch",
]);

export type HandoffGitUnavailableReason =
  | "snapshot-unavailable"
  | "cwd-unavailable"
  | "not-git"
  | "timeout"
  | "output-limit"
  | "probe-failed"
  | "invalid-output"
  | "ownership-mismatch";

export type HandoffGitLaunchSnapshot =
  | {
      schemaVersion: "handoff-git-launch.v1";
      state: "available";
      canonicalWorktree: string;
      repoCommonDir: string;
      headOid: string;
    }
  | {
      schemaVersion: "handoff-git-launch.v1";
      state: "unavailable";
      reason: HandoffGitUnavailableReason;
    };

export interface HandoffGitEvidence {
  schemaVersion: "handoff-git-evidence.v1";
  state: "clean" | "dirty" | "unavailable";
  dirtyFileCount: number | null;
  dirtyFileCountTruncated: boolean;
  paths: string[];
  pathsTruncated: boolean;
  commitCount: number | null;
  commitSummaries: string[];
  /**
   * run 開始後に増えた commit のうち、現在の branch 以外の branch / remote-tracking ref から
   * 到達できないもの（＝この run で新しく作られた commit）の件数。`git merge` で取り込んだ
   * 上流 commit は他 ref から到達できるため含まない。取得不能時は null。
   */
  localCommitCount: number | null;
  /** 上記 commit の完全 oid（先頭 MAX_LOCAL_COMMIT_OIDS 件）。handoff の hash 主張との突合に使う。 */
  localCommitOids: string[];
  /**
   * localCommitCount の確度。`ambiguous` は「remote-tracking ref によって範囲から引かれた commit が
   * あるが、それが上流の前進なのか worker 自身の push なのかを ref 形状から判別できない」状態
   * （既定 branch 上、または既定 branch を特定できない場合）。誤検出を避けて引く側に倒しているため、
   * この値が `ambiguous` のときは no-commit 違反の見逃しがあり得る。取得不能時は null。
   */
  localCommitAttribution: "exact" | "ambiguous" | null;
  unavailableReason?: HandoffGitUnavailableReason;
}

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  exitCode?: number;
  failureReason?: HandoffGitUnavailableReason;
}

interface GitCommandExecutor {
  run(cwd: string, args: readonly string[]): Promise<GitCommandResult>;
}

export interface HandoffGitEvidenceProbe {
  captureLaunchSnapshot(cwd: string): Promise<HandoffGitLaunchSnapshot>;
  captureEndEvidence(snapshot: HandoffGitLaunchSnapshot): Promise<HandoffGitEvidence>;
}

interface StageDepsWithHandoffGitEvidenceProbe extends StageDeps {
  handoffGitEvidenceProbe?: HandoffGitEvidenceProbe;
}

class NodeGitCommandExecutor implements GitCommandExecutor {
  run(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    return new Promise<GitCommandResult>((resolveResult) => {
      execFile(
        "git",
        [
          "--no-pager",
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          cwd,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          shell: false,
          windowsHide: true,
        },
        (error: ExecFileException | null, stdout: string): void => {
          if (error === null) {
            resolveResult({ ok: true, stdout });
            return;
          }
          const code = typeof error.code === "string" ? error.code : "";
          const failureReason: HandoffGitUnavailableReason =
            error.killed || code === "ETIMEDOUT"
              ? "timeout"
              : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "output-limit"
                : "probe-failed";
          resolveResult({
            ok: false,
            stdout: "",
            ...(typeof error.code === "number" ? { exitCode: error.code } : {}),
            failureReason,
          });
        },
      );
    });
  }
}

function unavailableLaunch(reason: HandoffGitUnavailableReason): HandoffGitLaunchSnapshot {
  return {
    schemaVersion: "handoff-git-launch.v1",
    state: "unavailable",
    reason,
  };
}

function unavailableEvidence(reason: HandoffGitUnavailableReason): HandoffGitEvidence {
  return {
    schemaVersion: "handoff-git-evidence.v1",
    state: "unavailable",
    dirtyFileCount: null,
    dirtyFileCountTruncated: false,
    paths: [],
    pathsTruncated: false,
    commitCount: null,
    commitSummaries: [],
    localCommitCount: null,
    localCommitOids: [],
    localCommitAttribution: null,
    unavailableReason: reason,
  };
}

function commandFailureReason(result: GitCommandResult): HandoffGitUnavailableReason {
  return result.failureReason ?? "probe-failed";
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function readRepositoryIdentity(
  executor: GitCommandExecutor,
  cwd: string,
): Promise<
  | { ok: true; canonicalWorktree: string; repoCommonDir: string }
  | { ok: false; reason: HandoffGitUnavailableReason }
> {
  const identity = await executor.run(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  if (!identity.ok) {
    return {
      ok: false,
      reason: identity.exitCode !== undefined ? "not-git" : commandFailureReason(identity),
    };
  }
  const lines = identity.stdout.trim().split(/\r?\n/);
  const worktree = lines[0];
  const commonDir = lines[1];
  if (
    lines.length !== 2 ||
    worktree === undefined ||
    commonDir === undefined ||
    !isAbsolute(worktree) ||
    !isAbsolute(commonDir)
  ) {
    return { ok: false, reason: "invalid-output" };
  }
  const [canonicalWorktree, repoCommonDir] = await Promise.all([
    canonicalPath(worktree),
    canonicalPath(commonDir),
  ]);
  if (canonicalWorktree === null || repoCommonDir === null) {
    return { ok: false, reason: "cwd-unavailable" };
  }
  return { ok: true, canonicalWorktree, repoCommonDir };
}

async function readHeadOid(
  executor: GitCommandExecutor,
  cwd: string,
): Promise<{ ok: true; headOid: string } | { ok: false; reason: HandoffGitUnavailableReason }> {
  const head = await executor.run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok) {
    return { ok: false, reason: commandFailureReason(head) };
  }
  const headOid = head.stdout.trim().toLowerCase();
  if (!OID_REGEX.test(headOid)) {
    return { ok: false, reason: "invalid-output" };
  }
  return { ok: true, headOid };
}

/**
 * 現在 checkout している branch 名（`refs/heads/` を除いた形）。detached HEAD と取得失敗は null。
 * `rev-list --exclude=<glob> --branches` の glob は `refs/heads/` 相対で解釈されるため短縮名を返す。
 */
async function readCurrentBranchName(executor: GitCommandExecutor, cwd: string): Promise<string | null> {
  const result = await executor.run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!result.ok) {
    return null;
  }
  const name = result.stdout.trim();
  // glob 文字を含む名前は --exclude で過剰除外になり得るため使わない（git の ref 名規則上は現れない）
  return name !== "" && /^[A-Za-z0-9._/-]+$/.test(name) ? name : null;
}

/**
 * `refs/remotes/origin/HEAD` が指す既定 branch の短縮名（例 `main`）。未設定・取得失敗は null。
 * 「現在 branch が既定 branch か」の判定だけに使う（下記 excludeOwnRemoteTracking 参照）。
 */
async function readDefaultBranchName(executor: GitCommandExecutor, cwd: string): Promise<string | null> {
  const result = await executor.run(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (!result.ok) {
    return null;
  }
  // `origin/main` の形で返るため remote 名を落とす
  const name = result.stdout.trim().replace(/^origin\//, "");
  return name !== "" && /^[A-Za-z0-9._/-]+$/.test(name) ? name : null;
}

/**
 * 現在 branch と同名の remote-tracking ref（`origin/<branch>` 等）を「run 前から在った証拠」から
 * 外してよいか。worker が commit して push すると同名 ref が前進するため、外さないと自分の commit を
 * 自分で打ち消して no-commit 違反を見逃す。
 *
 * ただし既定 branch 上では、同名 ref の前進が「worker の push」なのか「上流の前進」なのかを
 * ref の形からは区別できない。区別できない側では誤検出（正当な worker を block する）を避けるため
 * 除外を維持する。既定 branch を特定できない場合も同じ理由で保守側に倒す。
 */
function excludeOwnRemoteTracking(branchName: string | null, defaultBranchName: string | null): boolean {
  return branchName !== null && defaultBranchName !== null && branchName !== defaultBranchName;
}

function parseCommitOids(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => OID_REGEX.test(line));
}

function normalizeStatusPath(rawPath: string): string | null {
  const withoutControls = rawPath.replace(/[\u0000-\u001f\u007f]/g, "");
  if (withoutControls === "" || isAbsolute(withoutControls)) {
    return null;
  }
  const normalized = posix.normalize(withoutControls.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    return null;
  }
  return redactText(normalized).slice(0, MAX_PATH_LENGTH);
}

function parseStatusPaths(stdout: string): {
  dirtyFileCount: number;
  dirtyFileCountTruncated: boolean;
  paths: string[];
  pathsTruncated: boolean;
} | null {
  const records = stdout.split("\0").filter((record) => record !== "");
  const normalizedPaths: string[] = [];
  let observedCount = 0;
  for (const record of records) {
    if (record.length < 4 || record[2] !== " ") {
      return null;
    }
    const path = normalizeStatusPath(record.slice(3));
    if (path === null) {
      return null;
    }
    observedCount += 1;
    if (normalizedPaths.length < MAX_RECORDED_PATHS) {
      normalizedPaths.push(path);
    }
    if (observedCount > MAX_DIRTY_FILE_COUNT) {
      break;
    }
  }
  const dirtyFileCountTruncated = observedCount > MAX_DIRTY_FILE_COUNT;
  const dirtyFileCount = dirtyFileCountTruncated ? MAX_DIRTY_FILE_COUNT : observedCount;
  return {
    dirtyFileCount,
    dirtyFileCountTruncated,
    paths: normalizedPaths,
    pathsTruncated: dirtyFileCountTruncated || dirtyFileCount > normalizedPaths.length,
  };
}

function parseCommitCount(stdout: string): number | null {
  const value = stdout.trim();
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function parseCommitSummaries(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, MAX_COMMIT_SUMMARIES)
    .map((line) => redactText(line.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, MAX_COMMIT_SUMMARY_LENGTH));
}

export class NodeHandoffGitEvidenceProbe implements HandoffGitEvidenceProbe {
  constructor(private readonly executor: GitCommandExecutor = new NodeGitCommandExecutor()) {}

  async captureLaunchSnapshot(cwd: string): Promise<HandoffGitLaunchSnapshot> {
    if (cwd.trim() === "") {
      return unavailableLaunch("cwd-unavailable");
    }
    const identity = await readRepositoryIdentity(this.executor, cwd);
    if (!identity.ok) {
      return unavailableLaunch(identity.reason);
    }
    const head = await readHeadOid(this.executor, identity.canonicalWorktree);
    if (!head.ok) {
      return unavailableLaunch(head.reason);
    }
    return {
      schemaVersion: "handoff-git-launch.v1",
      state: "available",
      canonicalWorktree: identity.canonicalWorktree,
      repoCommonDir: identity.repoCommonDir,
      headOid: head.headOid,
    };
  }

  async captureEndEvidence(snapshot: HandoffGitLaunchSnapshot): Promise<HandoffGitEvidence> {
    if (snapshot.state !== "available") {
      return unavailableEvidence(snapshot.reason);
    }
    const identity = await readRepositoryIdentity(this.executor, snapshot.canonicalWorktree);
    if (!identity.ok) {
      return unavailableEvidence(identity.reason);
    }
    if (
      identity.canonicalWorktree !== snapshot.canonicalWorktree ||
      identity.repoCommonDir !== snapshot.repoCommonDir
    ) {
      return unavailableEvidence("ownership-mismatch");
    }
    const head = await readHeadOid(this.executor, snapshot.canonicalWorktree);
    if (!head.ok) {
      return unavailableEvidence(head.reason);
    }
    // 取り込んだ上流 commit を worker の成果と数えないため、現在 branch 以外の ref から
    // 到達できる commit を範囲から外す。`--exclude=<glob>` は直後の ref 列挙 option にだけ効き、
    // glob は `--remotes` なら `refs/remotes/` 相対、`--branches` なら `refs/heads/` 相対で解釈される。
    const [branchName, defaultBranchName] = await Promise.all([
      readCurrentBranchName(this.executor, snapshot.canonicalWorktree),
      readDefaultBranchName(this.executor, snapshot.canonicalWorktree),
    ]);
    const localRangeArgs = [
      `${snapshot.headOid}..${head.headOid}`,
      "--not",
      ...(excludeOwnRemoteTracking(branchName, defaultBranchName) ? [`--exclude=*/${branchName}`] : []),
      "--remotes",
      ...(branchName !== null ? [`--exclude=${branchName}`] : []),
      "--branches",
      "--",
    ];
    const [status, commitCountResult, localCountResult] = await Promise.all([
      this.executor.run(snapshot.canonicalWorktree, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]),
      this.executor.run(snapshot.canonicalWorktree, [
        "rev-list",
        "--count",
        `${snapshot.headOid}..${head.headOid}`,
        "--",
      ]),
      this.executor.run(snapshot.canonicalWorktree, ["rev-list", "--count", ...localRangeArgs]),
    ]);
    if (!status.ok) {
      return unavailableEvidence(commandFailureReason(status));
    }
    if (!commitCountResult.ok) {
      return unavailableEvidence(commandFailureReason(commitCountResult));
    }
    if (!localCountResult.ok) {
      return unavailableEvidence(commandFailureReason(localCountResult));
    }
    const statusReport = parseStatusPaths(status.stdout);
    const commitCount = parseCommitCount(commitCountResult.stdout);
    const localCommitCount = parseCommitCount(localCountResult.stdout);
    if (statusReport === null || commitCount === null || localCommitCount === null) {
      return unavailableEvidence("invalid-output");
    }

    let localCommitOids: string[] = [];
    if (localCommitCount > 0) {
      const oids = await this.executor.run(snapshot.canonicalWorktree, [
        "rev-list",
        `--max-count=${MAX_LOCAL_COMMIT_OIDS}`,
        ...localRangeArgs,
      ]);
      if (!oids.ok) {
        return unavailableEvidence(commandFailureReason(oids));
      }
      localCommitOids = parseCommitOids(oids.stdout);
    }

    let commitSummaries: string[] = [];
    if (commitCount > 0) {
      const summaries = await this.executor.run(snapshot.canonicalWorktree, [
        "log",
        `--max-count=${MAX_COMMIT_SUMMARIES}`,
        "--format=%h%x09%s",
        `${snapshot.headOid}..${head.headOid}`,
        "--",
      ]);
      if (!summaries.ok) {
        return unavailableEvidence(commandFailureReason(summaries));
      }
      commitSummaries = parseCommitSummaries(summaries.stdout);
    }

    const state =
      statusReport.dirtyFileCount > 0 || statusReport.dirtyFileCountTruncated || head.headOid !== snapshot.headOid
        ? "dirty"
        : "clean";
    return {
      schemaVersion: "handoff-git-evidence.v1",
      state,
      ...statusReport,
      commitCount,
      commitSummaries,
      localCommitCount,
      localCommitOids,
      // 引かれた commit が無ければ判別の余地も無い（exact）。引かれていて、かつ自 branch の
      // remote-tracking を除外源に残したままなら、push と上流前進を区別できていない。
      localCommitAttribution:
        commitCount > localCommitCount && !excludeOwnRemoteTracking(branchName, defaultBranchName)
          ? "ambiguous"
          : "exact",
    };
  }
}

const DEFAULT_PROBE = new NodeHandoffGitEvidenceProbe();

export function handoffGitEvidenceProbe(deps: StageDeps): HandoffGitEvidenceProbe {
  return (deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe ?? DEFAULT_PROBE;
}

export async function captureLaunchSnapshotBestEffort(
  probe: HandoffGitEvidenceProbe,
  cwd: string,
): Promise<HandoffGitLaunchSnapshot> {
  try {
    return await probe.captureLaunchSnapshot(cwd);
  } catch {
    return unavailableLaunch("probe-failed");
  }
}

export async function captureEndEvidenceBestEffort(
  probe: HandoffGitEvidenceProbe,
  snapshot: HandoffGitLaunchSnapshot,
): Promise<HandoffGitEvidence> {
  try {
    return await probe.captureEndEvidence(snapshot);
  } catch {
    return unavailableEvidence("probe-failed");
  }
}

export function parseHandoffGitLaunchSnapshot(meta: string): HandoffGitLaunchSnapshot {
  try {
    const parsed = JSON.parse(meta) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unavailableLaunch("snapshot-unavailable");
    }
    const value = (parsed as Record<string, unknown>)[HANDOFF_GIT_LAUNCH_META_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return unavailableLaunch("snapshot-unavailable");
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.schemaVersion === "handoff-git-launch.v1" &&
      candidate.state === "available" &&
      typeof candidate.canonicalWorktree === "string" &&
      typeof candidate.repoCommonDir === "string" &&
      typeof candidate.headOid === "string" &&
      isAbsolute(candidate.canonicalWorktree) &&
      isAbsolute(candidate.repoCommonDir) &&
      OID_REGEX.test(candidate.headOid)
    ) {
      return {
        schemaVersion: "handoff-git-launch.v1",
        state: "available",
        canonicalWorktree: candidate.canonicalWorktree,
        repoCommonDir: candidate.repoCommonDir,
        headOid: candidate.headOid.toLowerCase(),
      };
    }
    if (
      candidate.schemaVersion === "handoff-git-launch.v1" &&
      candidate.state === "unavailable" &&
      typeof candidate.reason === "string" &&
      UNAVAILABLE_REASONS.has(candidate.reason as HandoffGitUnavailableReason)
    ) {
      return unavailableLaunch(candidate.reason as HandoffGitUnavailableReason);
    }
    return unavailableLaunch("snapshot-unavailable");
  } catch {
    return unavailableLaunch("snapshot-unavailable");
  }
}
