import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import {
  applyFanoutPlan,
  createFanoutPlan,
  createKanbanReadView,
  evaluateFanoutIntegrationGate,
  getFanoutApplyAuthority,
  hashFanoutParentBody,
} from "@hachi/core";
import type { FanoutIntegrationChildGitEvidence, FanoutPlanResult, GitObjectFormat } from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit } from "../output.js";

const MAX_FANOUT_PLAN_INPUT_BYTES = 1024 * 1024;

interface FanoutPlanOptions {
  parent: string;
  file: string;
  json?: boolean;
}

interface FanoutApplyOptions extends FanoutPlanOptions {
  approvedPlanHash: string;
  orchestrator: string;
  session: string;
  generation: string;
}

interface FanoutIntegrationOptions extends FanoutApplyOptions {
  mainRef: string;
}

interface FanoutGitSnapshot {
  repoCommonDir: string;
  objectFormat: GitObjectFormat;
  mainRef: string;
  mainHead: string;
  mainHeadAfterProbe: string;
  children: FanoutIntegrationChildGitEvidence[];
}

export interface FanoutGitProbe {
  canonicalRepoCommonDir(repoCommonDir: string): string;
  objectFormat(repoCommonDir: string): string;
  resolveMain(repoCommonDir: string, mainRef: string): string;
  registeredWorktrees(repoCommonDir: string): Set<string>;
  canonicalWorktree(worktree: string): string;
  worktreeCommonDir(worktree: string): string;
  branch(worktree: string): string | null;
  head(worktree: string): string;
  clean(worktree: string): boolean;
  mainIsAncestor(worktree: string, mainHead: string, childHead: string): boolean;
  changedPaths(worktree: string, mainHead: string, childHead: string): string[];
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

class FanoutFileValidationError extends Error {}

function fileValidationError(message: string): FanoutFileValidationError {
  return new FanoutFileValidationError(message);
}

/** fdから最大1MiB+1だけ読み、fstat後の拡張もfail-closedで拒否する。afterStatは競合test専用。 */
export function readRegularJsonFile(path: string, afterStat?: () => void): unknown {
  if (path.includes("\0")) {
    throw fileValidationError("--file pathにNULは指定できません");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw fileValidationError("--file は通常fileである必要があります");
    }
    if (stat.size > MAX_FANOUT_PLAN_INPUT_BYTES) {
      throw fileValidationError("--file は1MiB以下である必要があります");
    }
    afterStat?.();
    const buffer = Buffer.alloc(MAX_FANOUT_PLAN_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    if (bytesRead > MAX_FANOUT_PLAN_INPUT_BYTES) {
      throw fileValidationError("--file は1MiB以下である必要があります");
    }
    const text = buffer.toString("utf8", 0, bytesRead);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw fileValidationError("--file のJSONが不正です");
    }
    return parsed;
  } catch (error) {
    if (error instanceof FanoutFileValidationError) {
      throw error;
    }
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ELOOP") {
      throw fileValidationError("--file にsymlinkは指定できません");
    }
    throw fileValidationError("--file を安全に読み取れません");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        throw fileValidationError("--file を安全に読み取れません");
      }
    }
  }
}

function runFanoutPlan(deps: CliDeps, options: FanoutPlanOptions): void {
  const rawInput = readRegularJsonFile(options.file);
  const result = createFanoutPlan(rawInput);
  const view = createKanbanReadView(deps.env.dbPath);
  try {
    const parent = view.task(options.parent);
    if (parent === null) {
      throw new Error("親タスクが見つかりません");
    }
    if (result.plan.parentTaskId !== options.parent || result.plan.parentSnapshot.taskId !== options.parent) {
      throw new Error("--parent と入力snapshotのtask IDが一致しません");
    }
    if (
      result.plan.parentSnapshot.updatedAt !== parent.updatedAt ||
      result.plan.parentSnapshot.bodyHash !== hashFanoutParentBody(parent.body)
    ) {
      throw new Error("親タスクsnapshotが現在値と一致しません");
    }
    emit(deps, options.json ?? false, result, [
      `plan_hash: ${result.planHash}`,
      `parent_task_id: ${result.plan.parentTaskId}`,
      `children: ${result.plan.children.length}`,
      result.canonicalJson,
    ]);
  } finally {
    view.close();
  }
}

function parseGeneration(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("--generation は正の整数である必要があります");
  }
  return Number.parseInt(value, 10);
}

function canonicalGitCommonDir(worktree: string): string {
  let output: string;
  try {
    output = execFileSync("git", ["-C", worktree, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeGitEnvironment(),
    }).trim();
  } catch {
    throw new Error("既存worktreeのGit ownershipを確認できません");
  }
  if (output.length === 0) {
    throw new Error("既存worktreeのGit common-dirが空です");
  }
  const commonDir = isAbsolute(output) ? output : resolve(worktree, output);
  try {
    return realpathSync(commonDir);
  } catch {
    throw new Error("既存worktreeのGit common-dirを解決できません");
  }
}

function canonicalDeclaredGitCommonDir(repoCommonDir: string): string {
  let output: string;
  try {
    output = execFileSync("git", ["--git-dir", repoCommonDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeGitEnvironment(),
    }).trim();
  } catch {
    throw new Error("repo common-dirがGit repositoryとして認識できません");
  }
  const commonDir = isAbsolute(output) ? output : resolve(repoCommonDir, output);
  try {
    return realpathSync(commonDir);
  } catch {
    throw new Error("repo common-dirのGit probe結果を解決できません");
  }
}

function gitText(repoCommonDir: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["--git-dir", repoCommonDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeGitEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error("fan-out integration Git証拠を取得できません");
  }
}

function worktreeGitText(worktree: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeGitEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error("fan-out child worktreeのGit証拠を取得できません");
  }
}

function assertMainRef(value: string): void {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error("--main-ref は安全なrefs/heads/*である必要があります");
  }
}

function registeredWorktreePaths(repoCommonDir: string): Set<string> {
  const output = gitText(repoCommonDir, ["worktree", "list", "--porcelain", "-z"]);
  return new Set(
    output
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length)),
  );
}

function probeMainIsAncestor(worktree: string, mainHead: string, childHead: string): boolean {
  const result = spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", mainHead, childHead], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: safeGitEnvironment(),
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error("latest main祖先関係を確認できません");
}

const nodeFanoutGitProbe: FanoutGitProbe = {
  canonicalRepoCommonDir: canonicalDeclaredGitCommonDir,
  objectFormat: (repoCommonDir) => probeGitObjectFormat(repoCommonDir),
  resolveMain: (repoCommonDir, mainRef) =>
    gitText(repoCommonDir, ["rev-parse", "--verify", `${mainRef}^{commit}`]).trim(),
  registeredWorktrees: registeredWorktreePaths,
  canonicalWorktree: (worktree) => {
    try {
      return realpathSync(worktree);
    } catch {
      throw new Error("fan-out child worktreeが存在しません");
    }
  },
  worktreeCommonDir: canonicalGitCommonDir,
  branch: (worktree) => {
    try {
      return worktreeGitText(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    } catch {
      return null;
    }
  },
  head: (worktree) => worktreeGitText(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
  clean: (worktree) =>
    worktreeGitText(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0,
  mainIsAncestor: probeMainIsAncestor,
  changedPaths: (worktree, mainHead, childHead) =>
    worktreeGitText(worktree, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      `${mainHead}..${childHead}`,
      "--",
    ])
      .split("\0")
      .filter((path) => path.length > 0),
};

/** §63.3: repositoryのGit object formatをread-only probeする。 */
export function probeGitObjectFormat(repoCommonDir: string): string {
  return gitText(repoCommonDir, ["rev-parse", "--show-object-format"]).trim();
}

/** §63.3 F3 host証拠をread-only Git probeで取得する。 */
export function collectFanoutGitSnapshot(
  planResult: FanoutPlanResult,
  mainRef: string,
  probe: FanoutGitProbe = nodeFanoutGitProbe,
): FanoutGitSnapshot {
  assertMainRef(mainRef);
  const repoCommonDir = planResult.plan.repoCommonDir;
  if (probe.canonicalRepoCommonDir(repoCommonDir) !== repoCommonDir) {
    throw new Error("repo common-dirがGitの実common-dirと一致しません");
  }
  const probedFormat = probe.objectFormat(repoCommonDir);
  if (probedFormat !== "sha1" && probedFormat !== "sha256") {
    throw new Error("Git object formatが未知です");
  }
  const objectFormat: GitObjectFormat = probedFormat;
  const mainHead = probe.resolveMain(repoCommonDir, mainRef);
  const registered = probe.registeredWorktrees(repoCommonDir);
  const children = planResult.plan.children.map((child): FanoutIntegrationChildGitEvidence => {
    const canonicalWorktree = probe.canonicalWorktree(child.worktree);
    const commonDir = probe.worktreeCommonDir(child.worktree);
    const branch = probe.branch(child.worktree);
    const head = probe.head(child.worktree);
    const clean = probe.clean(child.worktree);
    const changedPaths = probe.changedPaths(child.worktree, mainHead, head);
    return {
      key: child.key,
      worktree: canonicalWorktree,
      registeredWorktree: registered.has(canonicalWorktree) ? canonicalWorktree : null,
      repoCommonDir: commonDir,
      branch,
      head,
      clean,
      mainIsAncestor: probe.mainIsAncestor(child.worktree, mainHead, head),
      changedPaths,
    };
  });
  const mainHeadAfterProbe = probe.resolveMain(repoCommonDir, mainRef);
  return { repoCommonDir, objectFormat, mainRef, mainHead, mainHeadAfterProbe, children };
}

/** apply前のhost境界をread-onlyで再検証する。worktreeが未作成なら最深の既存親までsymlinkを拒否する。 */
export function assertApplyHostPreflight(repoCommonDir: string, worktrees: string[]): void {
  let canonicalRepo: string;
  try {
    canonicalRepo = realpathSync(repoCommonDir);
    if (canonicalRepo !== repoCommonDir || !statSync(repoCommonDir).isDirectory()) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("repo common-dirがhost上のcanonical directoryではありません");
  }
  if (canonicalDeclaredGitCommonDir(repoCommonDir) !== canonicalRepo) {
    throw new Error("repo common-dirがGitの実common-dirと一致しません");
  }

  for (const worktree of worktrees) {
    if (existsSync(worktree)) {
      let canonicalWorktree: string;
      try {
        canonicalWorktree = realpathSync(worktree);
        if (canonicalWorktree !== worktree || !statSync(worktree).isDirectory()) {
          throw new Error("invalid");
        }
      } catch {
        throw new Error("既存worktreeがcanonical directoryではありません");
      }
      if (canonicalGitCommonDir(worktree) !== canonicalRepo) {
        throw new Error("既存worktreeがplanのGit common-dirに属していません");
      }
      continue;
    }
    let ancestor = dirname(worktree);
    while (!existsSync(ancestor)) {
      const next = dirname(ancestor);
      if (next === ancestor) {
        throw new Error("worktreeの既存親directoryを解決できません");
      }
      ancestor = next;
    }
    if (realpathSync(ancestor) !== ancestor || !statSync(ancestor).isDirectory()) {
      throw new Error("worktreeの親pathにsymlinkまたは非directoryがあります");
    }
  }
}

function runFanoutApply(deps: CliDeps, options: FanoutApplyOptions): void {
  const rawInput = readRegularJsonFile(options.file);
  const planResult = createFanoutPlan(rawInput);
  if (planResult.plan.parentTaskId !== options.parent) {
    throw new Error("--parent と入力snapshotのtask IDが一致しません");
  }
  assertApplyHostPreflight(
    planResult.plan.repoCommonDir,
    planResult.plan.children.map((child) => child.worktree),
  );
  const result = applyFanoutPlan(deps.store, {
    planResult,
    approvedPlanHash: options.approvedPlanHash,
    orchestratorId: options.orchestrator,
    sessionId: options.session,
    generation: parseGeneration(options.generation),
    actor: "orchestrator",
  });
  emit(deps, options.json ?? false, result, [
    result.applied ? "fan-out planを適用しました" : "fan-out planは適用済みです",
    `plan_hash: ${result.planHash}`,
    ...result.children.map((child) => `${child.key}: ${child.task.id}`),
  ]);
}

function runFanoutIntegrationCheck(deps: CliDeps, options: FanoutIntegrationOptions): void {
  const rawInput = readRegularJsonFile(options.file);
  const planResult = createFanoutPlan(rawInput);
  if (planResult.plan.parentTaskId !== options.parent) {
    throw new Error("--parent と入力snapshotのtask IDが一致しません");
  }
  const git = collectFanoutGitSnapshot(planResult, options.mainRef);
  const view = createKanbanReadView(deps.env.dbPath);
  try {
    const authority = getFanoutApplyAuthority(deps.store, options.parent);
    const decision = evaluateFanoutIntegrationGate({
      planResult,
      approvedPlanHash: options.approvedPlanHash,
      authority,
      orchestrator: deps.store.getOrchestrator(options.orchestrator),
      session: deps.store.getOrchestratorSession(options.session),
      orchestratorId: options.orchestrator,
      sessionId: options.session,
      generation: parseGeneration(options.generation),
      parentBindings: deps.store.listTaskOrchestratorBindings(options.parent),
      children: planResult.plan.children.map((child) => {
        const taskId = authority?.children.find((item) => item.key === child.key)?.taskId;
        return {
          key: child.key,
          task: taskId === undefined ? null : view.task(taskId),
          bindings: taskId === undefined ? [] : deps.store.listTaskOrchestratorBindings(taskId),
          runs: taskId === undefined ? [] : view.runs(taskId),
          links: taskId === undefined ? [] : deps.store.listLinks(taskId),
        };
      }),
      repoCommonDir: git.repoCommonDir,
      objectFormat: git.objectFormat,
      mainRef: git.mainRef,
      mainHead: git.mainHead,
      mainHeadAfterProbe: git.mainHeadAfterProbe,
      gitChildren: git.children,
    });
    emit(deps, options.json ?? false, decision, [
      "fan-out integration gate: pass",
      "requested_action: host-ff-only-integration",
      "host_recheck_required: true (各ff-only直前にsession/main/child/verifyを再検証)",
      `plan_hash: ${decision.planHash}`,
      `main_head: ${decision.mainHead}`,
      `git_object_format: ${decision.objectFormat}`,
      ...decision.children.map((child) => `${child.key}: ${child.branch}@${child.head}`),
    ]);
  } finally {
    view.close();
  }
}

/** read-onlyな fanout plan コマンドを登録する。 */
export function registerFanoutCommand(program: Command, deps: CliDeps): void {
  const fanout = program.command("fanout").description("タスク間fan-out plan操作");
  fanout
    .command("plan")
    .description("fanout-plan-input.v1を検証し、read-onlyでplanを生成する")
    .requiredOption("--parent <taskId>", "親タスクID")
    .requiredOption("--file <json>", "fanout-plan-input.v1 JSON file")
    .option("--json", "JSON形式で出力")
    .action(
      withErrorHandling(deps, (options: FanoutPlanOptions): void => {
        runFanoutPlan(deps, options);
      }),
    );
  fanout
    .command("apply")
    .description("承認済みfanout planをgeneration fence付きで冪等適用する")
    .requiredOption("--parent <taskId>", "親タスクID")
    .requiredOption("--file <json>", "fanout-plan-input.v1 JSON file")
    .requiredOption("--approved-plan-hash <sha256>", "明示承認されたplan hash")
    .requiredOption("--orchestrator <id>", "stable orchestrator identity")
    .requiredOption("--session <id>", "active orchestrator session")
    .requiredOption("--generation <n>", "active session generation")
    .option("--json", "JSON形式で出力")
    .action(
      withErrorHandling(deps, (options: FanoutApplyOptions): void => {
        runFanoutApply(deps, options);
      }),
    );
  fanout
    .command("integration-check")
    .description("§63のboard/Git/verify証拠をread-only検証しhost ff-only統合要求を返す")
    .requiredOption("--parent <taskId>", "親タスクID")
    .requiredOption("--file <json>", "fanout-plan-input.v1 JSON file")
    .requiredOption("--approved-plan-hash <sha256>", "明示承認されたplan hash")
    .requiredOption("--orchestrator <id>", "stable orchestrator identity")
    .requiredOption("--session <id>", "active orchestrator session")
    .requiredOption("--generation <n>", "active session generation")
    .option("--main-ref <ref>", "統合基準branchの完全ref", "refs/heads/main")
    .option("--json", "JSON形式で出力")
    .action(
      withErrorHandling(deps, (options: FanoutIntegrationOptions): void => {
        runFanoutIntegrationCheck(deps, options);
      }),
    );
}
