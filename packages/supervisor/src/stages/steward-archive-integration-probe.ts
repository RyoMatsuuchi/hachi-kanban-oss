/**
 * §74.2 auto-archive の統合観測ゲートを駆動する hardened git observation probe。
 *
 * `handoff-git-evidence.ts` の `NodeGitCommandExecutor` は再利用しない（§74.2.3 が要求する
 * env sanitize が無いため）。ここでは新規に env を絞った executor を実装する。
 * probe 自身は `deps.env` に依存せず、呼び出し元（steward.ts 側。本タスクの対象外）から
 * `canonicalWorktreeRoot` を文字列で受け取るだけにし、テスタビリティを保つ。
 */

import { execFile, type ExecFileException } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { StageDeps } from "@hachi/core";
import {
  type ArchiveIntegrationObservation,
  type CwdNormalization,
  type IntegrationProofResult,
  type IntegrationTargetResolution,
} from "./steward-archive-integration.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 256 * 1024;
const OID_REGEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// 統合先ref解決の順序付きフォールバック候補（§74.2.1 候補2・3）。候補1は symbolic-ref の
// 解決結果から動的に決まるためここには含めない。
const FALLBACK_INTEGRATION_REF_CANDIDATES = ["refs/remotes/origin/main", "refs/heads/main"] as const;

/**
 * §74.2.3 / F5: git 関連の環境変数を無害化する。
 *
 * denylist（既知の危険な名前だけを除去する）は、git が将来追加する新しい `GIT_*` 変数や、
 * 見落とした既存の変数（`GIT_COMMON_DIR` / `GIT_OBJECT_DIRECTORY` / `GIT_SHALLOW_FILE` /
 * `GIT_REPLACE_REF_BASE` / `GIT_EXEC_PATH` 等）を継承させてしまう。cwd は task body 由来の
 * 外部入力であり、そこで動く process の環境（`process.env`）自体も信頼できない前提に置くべき
 * であるため、ここでは逆に **git バイナリの実行に最低限必要な変数だけを allowlist で明示的に
 * 許可し、それ以外は `GIT_*` を含め一切継承しない**。
 */
const GIT_ENV_ALLOWLIST = ["PATH"] as const;

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * git subprocess 1回分の実行結果。exit code の意味はコマンドごとに異なる（§74.2.3.1）ため、
 * ここでは解釈せず生の結果だけを返す。呼び出し側がコマンドごとに解釈する。
 */
export type GitExecResult =
  | { kind: "exit"; code: number; stdout: string }
  | { kind: "max-buffer" }
  // timeout / signal / spawn失敗 / maxBuffer以外の実行時異常をまとめて表す
  | { kind: "failed" };

export interface GitExecutor {
  run(cwd: string, args: readonly string[]): Promise<GitExecResult>;
}

/**
 * §74.2.3 の実行制約を満たす hardened executor。
 * - shell を介さない（execFile + shell:false）
 * - `--no-optional-locks -c core.fsmonitor=false --literal-pathspecs` を全コマンドの先頭に付ける。
 *   `--literal-pathspecs` は git のトップレベルオプションであり（`git diff` 等サブコマンド側の
 *   フラグとしては解釈されず usage error になる）、pathspec magic を全コマンド共通で無効化するため
 *   ここで一括して付与する（path を扱わないコマンドには無害）
 * - git 関連 env を継承させない
 * - timeout / maxBuffer / killSignal を固定する
 */
export class NodeStewardArchiveIntegrationGitExecutor implements GitExecutor {
  run(cwd: string, args: readonly string[]): Promise<GitExecResult> {
    return new Promise<GitExecResult>((resolveResult) => {
      execFile(
        "git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", cwd, ...args],
        {
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          shell: false,
          windowsHide: true,
          env: sanitizedGitEnv(),
        },
        (error: ExecFileException | null, stdout: string): void => {
          if (error === null) {
            resolveResult({ kind: "exit", code: 0, stdout });
            return;
          }
          if (typeof error.code === "number") {
            // 正常に終了したが exit code が非ゼロ（コマンドごとの意味は呼び出し側で解釈する）
            resolveResult({ kind: "exit", code: error.code, stdout: typeof stdout === "string" ? stdout : "" });
            return;
          }
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolveResult({ kind: "max-buffer" });
            return;
          }
          // timeout（killed / ETIMEDOUT）・signal・spawn失敗等はすべて実行失敗として扱う
          resolveResult({ kind: "failed" });
        },
      );
    });
  }
}

export interface StewardArchiveIntegrationProbe {
  observe(input: { cwd: string; canonicalWorktreeRoot: string }): Promise<ArchiveIntegrationObservation>;
}

export interface StageDepsWithStewardArchiveIntegrationProbe extends StageDeps {
  stewardArchiveIntegrationProbe?: StewardArchiveIntegrationProbe;
}

/**
 * §74.2.0 step1/2 の入力になる realpath 解決結果。「確認された不在（ENOENT）」と
 * 「不在を確認できていない（EACCES/ELOOP/ENOTDIR等の途中コンポーネントでのエラー）」を
 * 区別する。両者を同一視すると、権限拒否等で観測できなかったパスが
 * 「stat で不在を確認できた」ケース（決定表 行5/6）へ誤って倒れてしまう
 * （§74.2 3906行目「エラーで不在を確認できなかったものはここへ倒さない」）。
 */
type PathResolution =
  | { kind: "resolved"; path: string }
  | { kind: "absent" } // realpath で確認された不在（ENOENT）
  | { kind: "unresolved" }; // 権限エラー等、不在を確認できていない（§74.2 行2へ倒す）

async function canonicalPath(path: string): Promise<PathResolution> {
  try {
    return { kind: "resolved", path: await realpath(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "unresolved" };
  }
}

function isUnderRoot(candidateAbsolutePath: string, rootAbsolutePath: string): boolean {
  const rel = relative(rootAbsolutePath, candidateAbsolutePath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * §74.2.0 step1 / F3: 不在パス（realpath が ENOENT だったパス）を、実在する最長の祖先
 * ディレクトリまで symlink 解決し、残りの非存在セグメントをそのまま連結して正規化する。
 *
 * 不在パス自体は realpath できないため、修正前は canonicalWorktreeRoot 側の symlink 解決も
 * あえて省き、両者とも絶対化のみ（lexical比較）で `underCanonicalRoot` を判定していた。
 * しかし §74.2 の決定表・行5/6 は「board の canonical worktree root 配下かどうか」という
 * 実体（symlink解決後）の包含関係を問うものであり、lexical 一致に頼ると canonicalWorktreeRoot
 * 自体が symlink 越しのパスを持つ環境（例: macOS の `/var` → `/private/var`）で誤判定し得る。
 * ここでは cwd 側も「存在する祖先まで」symlink 解決してから比較することで、root 側の
 * symlink 解決（呼び出し元で必須）と対称にする。
 */
async function canonicalizeAbsentPath(absolutePath: string): Promise<string> {
  const trailingSegments: string[] = [];
  let current = absolutePath;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      // ファイルシステムルートまで辿っても解決できなかった（通常あり得ない）。
      // 安全側で絶対化のみへフォールバックする。
      return absolutePath;
    }
    trailingSegments.unshift(basename(current));
    const resolution = await canonicalPath(parent);
    if (resolution.kind === "resolved") {
      return trailingSegments.reduce((acc, segment) => resolvePath(acc, segment), resolution.path);
    }
    if (resolution.kind === "unresolved") {
      // 途中の祖先で権限エラー等が発生し、不在すら確認できない → 解決不能。
      // 安全側で絶対化のみへフォールバックする。
      return absolutePath;
    }
    // まだ absent（この祖先も存在しない）。さらに上の祖先へ辿る。
    current = parent;
  }
}

/**
 * symbolic-ref が返す候補 ref 名の簡易な健全性チェック。git のref名規則上、正当な ref 名が
 * `-` から始まることはなく、制御文字を含むこともない。想定外の出力を安全側（probe失敗）に倒す。
 */
function isSafeRefCandidate(name: string): boolean {
  return name !== "" && !name.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(name);
}

function parseOidLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => OID_REGEX.test(line));
}

type VerifyRefResult = { kind: "resolved"; oid: string } | { kind: "unresolved" } | { kind: "failed" };
type SymbolicRefResult = { kind: "resolved"; ref: string } | { kind: "unresolved" } | { kind: "failed" };
type StatusProbeResult = "clean" | "dirty" | "exec-failed";
type TargetResolutionProbeResult =
  | { kind: "resolved"; ref: string; oid: string }
  | { kind: "unresolved" }
  | { kind: "failed" };

/** §74.2.0 で確定し pin する worktree identity（symlink 解決済みの絶対パス）。 */
interface WorktreeIdentity {
  toplevel: string;
  commonDir: string;
}

export class NodeStewardArchiveIntegrationProbe implements StewardArchiveIntegrationProbe {
  constructor(private readonly executor: GitExecutor = new NodeStewardArchiveIntegrationGitExecutor()) {}

  async observe(input: { cwd: string; canonicalWorktreeRoot: string }): Promise<ArchiveIntegrationObservation> {
    if (input.cwd.trim() === "") {
      return { cwd: { kind: "no-cwd" }, drift: false };
    }

    // §74.2.0 step1: 絶対化 + symlink解決
    const absoluteCwd = resolvePath(input.cwd);
    const cwdResolution = await canonicalPath(absoluteCwd);
    if (cwdResolution.kind === "unresolved") {
      // 不在を確認できなかった（EACCES/ELOOP/ENOTDIR等）。cwd は task body 由来の信頼できない
      // 外部入力であり、これを行5/6（worktree-missing）へ倒すと、canonical worktree root 配下に
      // 権限拒否を起こすパスを書くだけで allow 側の経路を誤って通せてしまう。安全側（行2）に倒す。
      return { cwd: { kind: "not-a-worktree" }, drift: false };
    }
    if (cwdResolution.kind === "absent") {
      // step2: 存在しないことを確認できた → canonicalWorktreeRoot 配下かどうかで分岐する（git は一切呼ばない）。
      // F3: root は実在するディレクトリのため symlink 解決してから比較する。cwd 自体は realpath
      // できない（存在しない）が、実在する最長の祖先までは symlink 解決した上で残りを連結する
      // （canonicalizeAbsentPath）。lexical 一致だけに頼らず、双方とも symlink 解決後の実体で
      // 包含関係を判定することで、root が symlink 越しの絶対パスを持つ環境（macOS の
      // `/var` → `/private/var` 等）での誤判定を防ぐ。
      const rootResolution = await canonicalPath(input.canonicalWorktreeRoot);
      if (rootResolution.kind !== "resolved") {
        // canonical root 自体を解決できない（通常あり得ない設定不備・権限エラー等）。
        // 実体の包含関係を確認できない以上、安全側で「配下ではない」（行6 veto）に倒す。
        return { cwd: { kind: "worktree-missing", underCanonicalRoot: false }, drift: false };
      }
      const canonicalizedCwd = await canonicalizeAbsentPath(absoluteCwd);
      return {
        cwd: { kind: "worktree-missing", underCanonicalRoot: isUnderRoot(canonicalizedCwd, rootResolution.path) },
        drift: false,
      };
    }
    const resolvedCwd = cwdResolution.path;

    const stats = await stat(resolvedCwd).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      // ディレクトリでない（通常ファイル等）。realpath直後のstat失敗（レース）も同様に扱う。
      return { cwd: { kind: "not-a-worktree" }, drift: false };
    }

    // step3: toplevel と common-dir を取得（非git/bare/権限エラーは全て not-a-worktree）
    const identity = await this.readRepositoryIdentity(resolvedCwd);
    if (identity === null) {
      return { cwd: { kind: "not-a-worktree" }, drift: false };
    }

    // step4: toplevel/common-dir をそれぞれ symlink 解決する
    const [toplevelResolution, commonDirResolution] = await Promise.all([
      canonicalPath(identity.toplevel),
      canonicalPath(identity.commonDir),
    ]);
    // ここは absent（確認された不在）でも unresolved（不在を確認できていない）でも
    // 結果は変わらない（どちらも行2 not-a-worktree が正しい）。
    if (toplevelResolution.kind !== "resolved" || commonDirResolution.kind !== "resolved") {
      return { cwd: { kind: "not-a-worktree" }, drift: false };
    }
    const resolvedToplevel = toplevelResolution.path;
    const resolvedCommonDir = commonDirResolution.path;

    // 通常repoの `.git` はディレクトリであり、その親が toplevel と一致すれば repo root。
    const isRepoRoot = dirname(resolvedCommonDir) === resolvedToplevel;
    if (isRepoRoot) {
      // 行3/4: repo root ではporcelain以外のgitコマンドを一切実行しない。
      const status = await this.runStatusPorcelain(resolvedToplevel);
      // repo root には veto 経路が無い（CwdNormalization の repo-root は dirty:boolean のみ）ため、
      // 実行自体が失敗した場合（非maxBuffer）は保守的に dirty=true 側へフォールバックする。
      const dirty = status !== "clean";
      return { cwd: { kind: "repo-root", dirty }, drift: false };
    }

    // step5: サブディレクトリ指定は readRepositoryIdentity の --show-toplevel で自然に正規化される
    // F4: §74.2.0 で確定した worktreeIdentity（toplevel/common-dir）は §74.4 の再観測でも
    // 同一性を確認する対象のため、ここで pin してそのまま持ち回る。
    return this.observeWorktreePresent(input.cwd, resolvedToplevel, {
      toplevel: resolvedToplevel,
      commonDir: resolvedCommonDir,
    });
  }

  private async readRepositoryIdentity(cwd: string): Promise<{ toplevel: string; commonDir: string } | null> {
    const result = await this.executor.run(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    if (!(result.kind === "exit" && result.code === 0)) {
      return null;
    }
    const lines = result.stdout.trim().split(/\r?\n/);
    const toplevel = lines[0];
    const commonDir = lines[1];
    if (
      lines.length !== 2 ||
      toplevel === undefined ||
      commonDir === undefined ||
      !isAbsolute(toplevel) ||
      !isAbsolute(commonDir)
    ) {
      return null;
    }
    return { toplevel, commonDir };
  }

  /** §74.2 porcelain 判定。非空 or maxBuffer 超過 → dirty。それ以外の実行失敗は exec-failed。 */
  private async runStatusPorcelain(cwd: string): Promise<StatusProbeResult> {
    const result = await this.executor.run(cwd, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (result.kind === "max-buffer") {
      return "dirty";
    }
    if (result.kind === "exit" && result.code === 0) {
      return result.stdout.trim() === "" ? "clean" : "dirty";
    }
    return "exec-failed";
  }

  private async revParseVerifyRef(cwd: string, ref: string): Promise<VerifyRefResult> {
    const result = await this.executor.run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!(result.kind === "exit")) {
      return { kind: "failed" };
    }
    if (result.code === 0) {
      const oid = result.stdout.trim().toLowerCase();
      if (!OID_REGEX.test(oid)) {
        return { kind: "failed" };
      }
      return { kind: "resolved", oid };
    }
    if (result.code === 1) {
      return { kind: "unresolved" };
    }
    return { kind: "failed" };
  }

  private async symbolicRefQuiet(cwd: string, ref: string): Promise<SymbolicRefResult> {
    const result = await this.executor.run(cwd, ["symbolic-ref", "--quiet", ref]);
    if (!(result.kind === "exit")) {
      return { kind: "failed" };
    }
    if (result.code === 0) {
      const target = result.stdout.trim();
      if (!isSafeRefCandidate(target)) {
        return { kind: "failed" };
      }
      return { kind: "resolved", ref: target };
    }
    if (result.code === 1) {
      return { kind: "unresolved" };
    }
    return { kind: "failed" };
  }

  /** §74.2.1 統合先 ref の解決。順序付きフォールバックで最初に解決できた1つだけを返す。 */
  private async resolveIntegrationTarget(cwd: string): Promise<TargetResolutionProbeResult> {
    const symref = await this.symbolicRefQuiet(cwd, "refs/remotes/origin/HEAD");
    if (symref.kind === "failed") {
      return { kind: "failed" };
    }
    if (symref.kind === "resolved") {
      const verify = await this.revParseVerifyRef(cwd, symref.ref);
      if (verify.kind === "failed") {
        return { kind: "failed" };
      }
      if (verify.kind === "resolved") {
        return { kind: "resolved", ref: symref.ref, oid: verify.oid };
      }
      // dangling symref（exit1）→ 候補2へフォールバック
    }

    for (const candidateRef of FALLBACK_INTEGRATION_REF_CANDIDATES) {
      const verify = await this.revParseVerifyRef(cwd, candidateRef);
      if (verify.kind === "failed") {
        return { kind: "failed" };
      }
      if (verify.kind === "resolved") {
        return { kind: "resolved", ref: candidateRef, oid: verify.oid };
      }
    }

    return { kind: "unresolved" };
  }

  /**
   * rev-list / cherry / diff-tree 用。§74.2.3.1 の終了コード解釈表では、これらのコマンドは
   * exit 0 のときだけ「出力で判定」対象になる（`merge-base --is-ancestor` や `diff --quiet` の
   * ような「0/1 のどちらも正常系」というコマンドとは異なる）。exit 1 は実際の git エラー
   * （不正な revision range 等）を意味し得るため、表の行8（probe失敗）に倒す。F2 修正前は
   * `code === 0 || code === 1` を両方成功扱いにしており、実エラーを「出力が空」と区別できず
   * 誤って none/patch-equivalent 側へ倒れ得る欠陥があった。
   */
  private async runRequireSuccess(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
    const result = await this.executor.run(cwd, args);
    if (result.kind === "exit" && result.code === 0) {
      return { ok: true, stdout: result.stdout };
    }
    return { ok: false };
  }

  /**
   * §74.2.2 統合証明（A または B）。porcelain が clean の場合のみ呼ばれる。
   * A が成立すればそこで確定し、B は評価しない。A が不成立の場合のみ B を評価する。
   */
  private async computeIntegrationProof(
    cwd: string,
    headOid: string,
    targetOid: string,
  ): Promise<{ kind: "ancestor" | "patch-equivalent" | "none" } | { kind: "probe-failed" }> {
    // A. 厳密な到達可能性
    const ancestorResult = await this.executor.run(cwd, ["merge-base", "--is-ancestor", headOid, targetOid]);
    if (ancestorResult.kind === "exit" && ancestorResult.code === 0) {
      return { kind: "ancestor" };
    }
    if (!(ancestorResult.kind === "exit" && ancestorResult.code === 1)) {
      // exit0（祖先）・exit1（非祖先）以外は全てprobe失敗
      return { kind: "probe-failed" };
    }

    // B. patch等価 + 補強（Aが不成立の場合のみ）
    const range = `${targetOid}..${headOid}`;

    const merges = await this.runRequireSuccess(cwd, ["rev-list", "--merges", range, "--"]);
    if (!merges.ok) {
      return { kind: "probe-failed" };
    }
    const mergeOids = parseOidLines(merges.stdout);

    const nonMerges = await this.runRequireSuccess(cwd, ["rev-list", "--no-merges", range, "--"]);
    if (!nonMerges.ok) {
      return { kind: "probe-failed" };
    }
    const nonMergeOids = parseOidLines(nonMerges.stdout);

    // 条件1: M（merge commit集合）が空
    const condition1 = mergeOids.length === 0;

    // 条件2: git cherry の出力に + 始まりの行が無い（exit codeでは判定せず出力内容だけで判定）
    const cherry = await this.runRequireSuccess(cwd, ["cherry", targetOid, headOid]);
    if (!cherry.ok) {
      return { kind: "probe-failed" };
    }
    const condition2 = !cherry.stdout.split(/\r?\n/).some((line) => line.startsWith("+"));

    // 条件3（Nが空でない場合のみ評価。Nが空ならツリー全体比較への退行を避けるため評価をスキップし成立扱い）
    let condition3 = true;
    if (nonMergeOids.length > 0) {
      const paths = new Set<string>();
      for (const commitOid of nonMergeOids) {
        // §74.2.3: diff-tree も diff 系サブコマンドであり、external diff driver / textconv
        // フィルタを起動し得るため --no-ext-diff --no-textconv を付ける（F5）。
        const diffTree = await this.runRequireSuccess(cwd, [
          "diff-tree",
          "-r",
          "--no-commit-id",
          "--name-only",
          "-z",
          "--no-ext-diff",
          "--no-textconv",
          commitOid,
          "--",
        ]);
        if (!diffTree.ok) {
          return { kind: "probe-failed" };
        }
        for (const path of diffTree.stdout.split("\0")) {
          if (path !== "") {
            paths.add(path);
          }
        }
      }
      if (paths.size > 0) {
        // --literal-pathspecs は executor 側でトップレベルオプションとして全コマンド共通に付与済み
        const diffResult = await this.executor.run(cwd, [
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          targetOid,
          headOid,
          "--",
          ...paths,
        ]);
        if (diffResult.kind === "exit" && diffResult.code === 0) {
          condition3 = true;
        } else if (diffResult.kind === "exit" && diffResult.code === 1) {
          condition3 = false;
        } else {
          return { kind: "probe-failed" };
        }
      }
      // paths が空（非merge commitが差分パスを持たない異常系）は条件3評価をスキップし成立のまま扱う
    }

    return condition1 && condition2 && condition3 ? { kind: "patch-equivalent" } : { kind: "none" };
  }

  /**
   * §74.4 drift の最終確認。行10/11（allow）を確定させる直前だけ呼ぶ。
   * pin した worktreeIdentity（toplevel/common-dir）・HEAD OID・統合先 ref 名+OID・porcelain の
   * いずれかが変化していれば true を返す。再取得そのものが失敗した場合も drift とみなす（保守的に倒す）。
   *
   * F4: 修正前は HEAD OID・porcelain に加え「pin した ref 名の OID」だけを直接引き直しており、
   * 次の2種類の drift を見逃し得た。
   * 1. worktree identity: cwd に別のリポジトリが作り直された（同一パスで worktree
   *    remove→add し直された等）場合、toplevel/common-dir が変わっていても検出できなかった。
   * 2. 統合先 ref の付け替え: `origin/HEAD` の symbolic-ref が別ブランチへ repoint された場合、
   *    pin していた ref 名（例 `refs/remotes/origin/main`）自体の OID が変わっていなければ
   *    素通りしていた。§74.2.1 と同じ順序付きフォールバックを丸ごと再実行し、
   *    再解決結果の **ref 名と OID の両方** が pin した値と一致することを確認する。
   */
  private async checkDrift(
    taskCwd: string,
    pinnedIdentity: WorktreeIdentity,
    pinnedHeadOid: string,
    pinnedRef: string,
    pinnedTargetOid: string,
  ): Promise<boolean> {
    // §74.4 / F4: 初回に symlink 解決した toplevel を再利用せず、task body 由来の cwd を
    // §74.2.0 step1 から再正規化する。解決済み toplevel だけを入口にすると、判定中に元の
    // cwd symlink が別 worktree へ付け替えられても stale な worktree を再観測してしまう。
    const absoluteCwdRecheck = resolvePath(taskCwd);
    const cwdRecheck = await canonicalPath(absoluteCwdRecheck);
    if (cwdRecheck.kind !== "resolved") {
      return true;
    }
    const statsRecheck = await stat(cwdRecheck.path).catch(() => null);
    if (statsRecheck === null || !statsRecheck.isDirectory()) {
      return true;
    }

    const identityRecheck = await this.readRepositoryIdentity(cwdRecheck.path);
    if (identityRecheck === null) {
      return true;
    }
    const [toplevelRecheck, commonDirRecheck] = await Promise.all([
      canonicalPath(identityRecheck.toplevel),
      canonicalPath(identityRecheck.commonDir),
    ]);
    if (
      toplevelRecheck.kind !== "resolved" ||
      commonDirRecheck.kind !== "resolved" ||
      toplevelRecheck.path !== pinnedIdentity.toplevel ||
      commonDirRecheck.path !== pinnedIdentity.commonDir
    ) {
      return true;
    }

    // identity が一致した場合も、以後のゲート全体は再正規化後の toplevel を入口に再評価する。
    const recheckedToplevel = toplevelRecheck.path;
    const headRecheck = await this.revParseVerifyRef(recheckedToplevel, "HEAD");
    if (headRecheck.kind !== "resolved" || headRecheck.oid !== pinnedHeadOid) {
      return true;
    }

    const targetRecheck = await this.resolveIntegrationTarget(recheckedToplevel);
    if (
      targetRecheck.kind !== "resolved" ||
      targetRecheck.ref !== pinnedRef ||
      targetRecheck.oid !== pinnedTargetOid
    ) {
      return true;
    }

    const statusRecheck = await this.runStatusPorcelain(recheckedToplevel);
    return statusRecheck !== "clean";
  }

  private async observeWorktreePresent(
    taskCwd: string,
    toplevel: string,
    identity: WorktreeIdentity,
  ): Promise<ArchiveIntegrationObservation> {
    const cwd: CwdNormalization = { kind: "worktree-present" };

    // worktree HEAD OID を pin する（取得失敗 → 行8）
    const headPin = await this.revParseVerifyRef(toplevel, "HEAD");
    if (headPin.kind !== "resolved") {
      const integrationProof: IntegrationProofResult = { kind: "probe-failed" };
      return { cwd, integrationProof, drift: false };
    }

    // §74.2.1 統合先 ref の解決
    const target = await this.resolveIntegrationTarget(toplevel);
    if (target.kind === "failed") {
      const integrationTarget: IntegrationTargetResolution = { state: "unresolved" };
      const integrationProof: IntegrationProofResult = { kind: "probe-failed" };
      return { cwd, integrationTarget, integrationProof, drift: false };
    }
    if (target.kind === "unresolved") {
      const integrationTarget: IntegrationTargetResolution = { state: "unresolved" };
      return { cwd, integrationTarget, drift: false };
    }
    const integrationTarget: IntegrationTargetResolution = {
      state: "resolved",
      ref: target.ref,
      oid: target.oid,
    };

    // porcelain（dirty判定）
    const status = await this.runStatusPorcelain(toplevel);
    if (status === "exec-failed") {
      const integrationProof: IntegrationProofResult = { kind: "probe-failed" };
      return { cwd, integrationTarget, integrationProof, drift: false };
    }
    if (status === "dirty") {
      const integrationProof: IntegrationProofResult = { kind: "dirty" };
      return { cwd, integrationTarget, integrationProof, drift: false };
    }

    // §74.2.2 統合証明（clean のときだけ実行）
    const proof = await this.computeIntegrationProof(toplevel, headPin.oid, target.oid);
    if (proof.kind === "probe-failed") {
      const integrationProof: IntegrationProofResult = { kind: "probe-failed" };
      return { cwd, integrationTarget, integrationProof, drift: false };
    }
    if (proof.kind === "none") {
      const integrationProof: IntegrationProofResult = { kind: "clean", proof: "none" };
      return { cwd, integrationTarget, integrationProof, drift: false };
    }

    // 行10/11相当（A成立 or B成立）を確定させる直前にだけ drift の最終確認を行う
    const drift = await this.checkDrift(taskCwd, identity, headPin.oid, target.ref, target.oid);
    const integrationProof: IntegrationProofResult = { kind: "clean", proof: proof.kind };
    return { cwd, integrationTarget, integrationProof, drift };
  }
}

const DEFAULT_PROBE = new NodeStewardArchiveIntegrationProbe();

export function stewardArchiveIntegrationProbe(deps: StageDeps): StewardArchiveIntegrationProbe {
  return (deps as StageDepsWithStewardArchiveIntegrationProbe).stewardArchiveIntegrationProbe ?? DEFAULT_PROBE;
}
