import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeStewardArchiveIntegrationGitExecutor,
  NodeStewardArchiveIntegrationProbe,
  type GitExecResult,
  type GitExecutor,
} from "./steward-archive-integration-probe.js";
import { decideArchiveIntegration } from "./steward-archive-integration.js";

/**
 * 実 git subprocess を多数起動するため、既定 5s では待ち時間だけで溢れる。
 * handoff-git-evidence.test.ts と同じく明示 timeout を置く。
 */
describe("NodeStewardArchiveIntegrationProbe", { timeout: 120_000 }, () => {
  const tmpPaths: string[] = [];
  const probe = new NodeStewardArchiveIntegrationProbe();

  afterEach(() => {
    for (const path of tmpPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function makeTmpPath(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    tmpPaths.push(path);
    return path;
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  }

  function createRepository(defaultBranch = "main"): string {
    const repo = makeTmpPath("hachi-swi-repo-");
    git(repo, ["init", "-q", "-b", defaultBranch]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    writeFileSync(join(repo, "f.txt"), "base\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    return repo;
  }

  /** repo から派生した branch を linked worktree として作る（cwd は toplevel が repo と異なる worktree path）。 */
  function addWorktree(repo: string, branch: string, startPoint = "HEAD"): string {
    const worktreePath = join(makeTmpPath("hachi-swi-wtparent-"), branch.replaceAll("/", "-"));
    git(repo, ["worktree", "add", "-q", "-b", branch, worktreePath, startPoint]);
    return worktreePath;
  }

  function headOid(cwd: string): string {
    return git(cwd, ["rev-parse", "HEAD"]).trim();
  }

  // ---------------------------------------------------------------------
  // §74.2.0 cwd 正規化
  // ---------------------------------------------------------------------

  describe("cwd正規化", () => {
    it("空文字のcwdはgitを一切呼ばずno-cwdになる", async () => {
      const observation = await probe.observe({ cwd: "", canonicalWorktreeRoot: "/does/not/matter" });
      expect(observation).toEqual({ cwd: { kind: "no-cwd" }, drift: false });
    });

    it("canonical worktree root配下に存在しないパスはworktree-missing(underCanonicalRoot:true)になる", async () => {
      const root = makeTmpPath("hachi-swi-root-");
      const missing = join(root, "not-created-yet");

      const observation = await probe.observe({ cwd: missing, canonicalWorktreeRoot: root });

      expect(observation).toEqual({
        cwd: { kind: "worktree-missing", underCanonicalRoot: true },
        drift: false,
      });
    });

    it("canonical worktree root配下でない不在パスはworktree-missing(underCanonicalRoot:false)になる", async () => {
      const root = makeTmpPath("hachi-swi-root-");
      const otherRoot = makeTmpPath("hachi-swi-other-root-");
      const missing = join(otherRoot, "not-created-yet");

      const observation = await probe.observe({ cwd: missing, canonicalWorktreeRoot: root });

      expect(observation).toEqual({
        cwd: { kind: "worktree-missing", underCanonicalRoot: false },
        drift: false,
      });
    });

    it("canonicalWorktreeRootがsymlink越しでも、実体（symlink解決後）が配下なら不在パスはunderCanonicalRoot:trueになる（F3）", async () => {
      // F3修正前は「不在パスは symlink 解決できないので root 側も絶対化のみで比較する」という
      // 実装だった。root が symlink 越しの絶対パスを持つ環境では、symlink解決後は明らかに
      // 配下にある missing path を lexical 不一致だけで「配下ではない」と誤判定し得た
      // （＝allowされるべき行5が誤って行6のvetoに倒れる fail-closed 側の誤り。
      // 逆方向の fail-open は起こらないが、正しい統合観測ゲートの動作を壊す点で回帰である）。
      const realRoot = makeTmpPath("hachi-swi-f3-real-root-");
      // 別の場所に、realRoot を指す symlink を作る（root 側だけ symlink 越しにする非対称構成）
      const aliasParent = makeTmpPath("hachi-swi-f3-alias-parent-");
      const aliasRoot = join(aliasParent, "alias-root");
      symlinkSync(realRoot, aliasRoot, "dir");

      // cwd は symlink を経由せず、実パス側から直接構築した不在パス
      const missing = join(realRoot, "not-created-yet");

      const observation = await probe.observe({ cwd: missing, canonicalWorktreeRoot: aliasRoot });

      expect(observation).toEqual({
        cwd: { kind: "worktree-missing", underCanonicalRoot: true },
        drift: false,
      });
    });

    it("canonical worktree root内の外部向きsymlink配下にある不在パスは行5へ逃げず行6のvetoになる（F3攻撃形）", async () => {
      const canonicalRoot = makeTmpPath("hachi-swi-f3-canonical-root-");
      const outsideRoot = makeTmpPath("hachi-swi-f3-outside-root-");
      const externalLink = join(canonicalRoot, "link");
      symlinkSync(outsideRoot, externalLink, "dir");
      const missing = join(externalLink, "missing");

      const observation = await probe.observe({ cwd: missing, canonicalWorktreeRoot: canonicalRoot });

      expect(observation).toEqual({
        cwd: { kind: "worktree-missing", underCanonicalRoot: false },
        drift: false,
      });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:cwd-not-a-worktree",
      });
    });

    it("canonical worktree root配下でもパス途中がファイルで不在を確認できないcwdはnot-a-worktree(行2)になる", async () => {
      // 直前のテスト（配下内不在）とは異なり、これは絶対に存在しないパス（ENOENT）ではなく、
      // 途中のパスコンポーネントがディレクトリではなくファイルであるため realpath が ENOTDIR で
      // 失敗するケースである。§74.2 3906行目「エラーで不在を確認できなかったものはここへ倒さない」
      // により、canonical worktree root 配下であっても worktree-missing（行5）ではなく
      // not-a-worktree（行2）にならなければならない。
      // chmod による EACCES 再現は root 権限で実行される CI では機能しない（root は権限チェックを
      // バイパスするため）ため、dispatch.test.ts の既存パターンに倣い、途中コンポーネントを
      // 通常ファイルにして ENOTDIR を発生させる（root 実行でも確実に失敗する）。
      const root = makeTmpPath("hachi-swi-root-");
      const blockerFile = join(root, "blocker");
      writeFileSync(blockerFile, "not a directory");
      const targetPath = join(blockerFile, "target");

      const observation = await probe.observe({ cwd: targetPath, canonicalWorktreeRoot: root });

      expect(observation).toEqual({ cwd: { kind: "not-a-worktree" }, drift: false });
    });

    it("git管理下でないディレクトリはnot-a-worktreeになる", async () => {
      const directory = makeTmpPath("hachi-swi-non-git-");

      const observation = await probe.observe({ cwd: directory, canonicalWorktreeRoot: directory });

      expect(observation).toEqual({ cwd: { kind: "not-a-worktree" }, drift: false });
    });

    it("ディレクトリではなく通常ファイルを指すcwdはgitを呼ばずnot-a-worktreeになる", async () => {
      const directory = makeTmpPath("hachi-swi-file-parent-");
      const filePath = join(directory, "plain-file.txt");
      writeFileSync(filePath, "not a directory\n");
      let calls = 0;
      const countingExecutor: GitExecutor = {
        run: async (cwd, args) => {
          calls += 1;
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const countingProbe = new NodeStewardArchiveIntegrationProbe(countingExecutor);

      const observation = await countingProbe.observe({ cwd: filePath, canonicalWorktreeRoot: directory });

      expect(observation).toEqual({ cwd: { kind: "not-a-worktree" }, drift: false });
      expect(calls).toBe(0);
    });

    it("bare repositoryを指すcwdはnot-a-worktreeになる", async () => {
      const parent = makeTmpPath("hachi-swi-bare-parent-");
      const bareRepo = join(parent, "bare.git");
      git(parent, ["init", "-q", "--bare", bareRepo]);

      const observation = await probe.observe({ cwd: bareRepo, canonicalWorktreeRoot: parent });

      expect(observation).toEqual({ cwd: { kind: "not-a-worktree" }, drift: false });
    });

    it("repo rootではstatus以外のgitコマンドを一切実行しない（clean）", async () => {
      const repo = createRepository();
      const commands: string[][] = [];
      const spyExecutor: GitExecutor = {
        run: async (cwd, args) => {
          commands.push([...args]);
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const spyProbe = new NodeStewardArchiveIntegrationProbe(spyExecutor);

      const observation = await spyProbe.observe({ cwd: repo, canonicalWorktreeRoot: repo });

      expect(observation).toEqual({ cwd: { kind: "repo-root", dirty: false }, drift: false });
      expect(commands).toHaveLength(2);
      expect(commands[0]?.[0]).toBe("rev-parse");
      expect(commands[1]?.[0]).toBe("status");
    });

    it("repo rootではstatus以外のgitコマンドを一切実行しない（dirty）", async () => {
      const repo = createRepository();
      writeFileSync(join(repo, "f.txt"), "dirty\n");
      const commands: string[][] = [];
      const spyExecutor: GitExecutor = {
        run: async (cwd, args) => {
          commands.push([...args]);
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const spyProbe = new NodeStewardArchiveIntegrationProbe(spyExecutor);

      const observation = await spyProbe.observe({ cwd: repo, canonicalWorktreeRoot: repo });

      expect(observation).toEqual({ cwd: { kind: "repo-root", dirty: true }, drift: false });
      expect(commands).toHaveLength(2);
      expect(commands.every((call) => call[0] === "rev-parse" || call[0] === "status")).toBe(true);
    });

    it("status.showUntrackedFiles=noでも未追跡ファイルをdirtyとして検出する（--untracked-files=allの効果）", async () => {
      const repo = createRepository();
      git(repo, ["config", "status.showUntrackedFiles", "no"]);
      writeFileSync(join(repo, "untracked.txt"), "new\n");

      const observation = await probe.observe({ cwd: repo, canonicalWorktreeRoot: repo });

      expect(observation).toEqual({ cwd: { kind: "repo-root", dirty: true }, drift: false });
    });

    it("linked worktreeのサブディレクトリを指定してもtoplevelへ正規化され、worktree root指定時と同じ結果になる（別扱いにしない）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/subdir-normalize");
      const subdir = join(worktree, "nested", "deeper");
      mkdirSync(subdir, { recursive: true });

      const observation = await probe.observe({ cwd: subdir, canonicalWorktreeRoot: worktree });

      // repo-root や worktree-missing ではなく、worktree root指定時と同じ worktree-present + ancestor証明になる
      expect(observation.cwd).toEqual({ kind: "worktree-present" });
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "ancestor" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "allow",
        integrationEvidence: "clean-head-reachable",
      });
    });
  });

  // ---------------------------------------------------------------------
  // §74.2.1 統合先 ref 解決
  // ---------------------------------------------------------------------

  describe("統合先ref解決", () => {
    it("origin/HEADが無くローカルmainも無い場合はunresolvedになる（候補が1つも解決しない）", async () => {
      const repo = createRepository("trunk");
      const worktree = addWorktree(repo, "feature/no-target");

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.cwd).toEqual({ kind: "worktree-present" });
      expect(observation.integrationTarget).toEqual({ state: "unresolved" });
    });

    it("origin/HEADが無い場合はrefs/remotes/origin/mainへフォールバックする（symbolic-refのexit1はprobe失敗ではない）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/fallback-origin-main");

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationTarget).toEqual({
        state: "resolved",
        ref: "refs/remotes/origin/main",
        oid: headOid(repo),
      });
    });

    it("origin/mainが無い場合はrefs/heads/mainへフォールバックする", async () => {
      const repo = createRepository();
      const worktree = addWorktree(repo, "feature/fallback-local-main");

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationTarget).toEqual({
        state: "resolved",
        ref: "refs/heads/main",
        oid: headOid(repo),
      });
    });

    it("ローカルmainがorigin/mainより遅れていてもorigin/main(候補2)を優先する", async () => {
      const repo = createRepository();
      const localMainOid = headOid(repo);
      writeFileSync(join(repo, "f.txt"), "origin-ahead\n");
      git(repo, ["commit", "-q", "-am", "origin ahead commit"]);
      const originMainOid = headOid(repo);
      git(repo, ["update-ref", "refs/remotes/origin/main", originMainOid]);
      // ローカル main を古いOIDへ巻き戻す（origin/mainとは異なるOIDにする）
      git(repo, ["update-ref", "refs/heads/main", localMainOid]);
      const worktree = addWorktree(repo, "feature/local-behind", originMainOid);

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      // toEqual自体がoidの厳密一致（=originMainOid、localMainOidではない）を保証する
      expect(observation.integrationTarget).toEqual({
        state: "resolved",
        ref: "refs/remotes/origin/main",
        oid: originMainOid,
      });
      expect(originMainOid).not.toBe(localMainOid);
    });

    it("origin/HEADがdevelopを指す場合はrefs/remotes/origin/developを優先し、main側だけにある変更を統合済みと誤判定しない", async () => {
      const repo = createRepository();
      const baseOid = headOid(repo);
      // origin/develop: baseから分岐した別内容
      git(repo, ["branch", "develop-ref", baseOid]);
      writeFileSync(join(repo, "develop-only.txt"), "develop\n");
      git(repo, ["checkout", "-q", "develop-ref"]);
      git(repo, ["add", "develop-only.txt"]);
      git(repo, ["commit", "-q", "-m", "develop only change"]);
      const developOid = headOid(repo);
      git(repo, ["update-ref", "refs/remotes/origin/develop", developOid]);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
      // main側はbaseのまま。origin/mainも設定するが、origin/HEADはdevelopを指すため候補1が優先される
      git(repo, ["checkout", "-q", "main"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", baseOid]);
      const worktree = addWorktree(repo, "feature/from-main", "main");

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      // toEqual自体がoidの厳密一致（=developOid、baseOidではない）を保証する
      expect(observation.integrationTarget).toEqual({
        state: "resolved",
        ref: "refs/remotes/origin/develop",
        oid: developOid,
      });
      expect(developOid).not.toBe(baseOid);
    });
  });

  // ---------------------------------------------------------------------
  // §74.2.2 統合証明（A: ancestor / B: patch-equivalent）
  // ---------------------------------------------------------------------

  describe("統合証明", () => {
    it("worktree HEADが統合先の祖先ならancestorとして証明される（行10相当）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/ancestor");

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "ancestor" });
      expect(observation.drift).toBe(false);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "allow",
        integrationEvidence: "clean-head-reachable",
      });
    });

    it("cherry-pickで統合されたbranchはpatch-equivalentとして証明される（行11相当）", async () => {
      const repo = createRepository();
      writeFileSync(join(repo, "g.txt"), "shared\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "add shared file"]);
      const worktree = addWorktree(repo, "feature/cherry-pick");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);
      const featureHeadOid = headOid(worktree);

      // main 側は無関係な自分の変更を積んでから、feature の commit を cherry-pick する
      writeFileSync(join(repo, "g.txt"), "main-own\n");
      git(repo, ["commit", "-q", "-am", "main own change"]);
      execFileSync("git", ["-C", repo, "cherry-pick", featureHeadOid], { encoding: "utf8" });
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "patch-equivalent" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "allow",
        integrationEvidence: "clean-patch-equivalent",
      });
    });

    it("rebaseで統合されたbranchはpatch-equivalentとして証明される（行11相当）", async () => {
      const repo = createRepository();
      writeFileSync(join(repo, "g.txt"), "shared\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "add shared file"]);
      const worktree = addWorktree(repo, "feature/rebase");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);
      const featureHeadOid = headOid(worktree);

      writeFileSync(join(repo, "g.txt"), "main-own\n");
      git(repo, ["commit", "-q", "-am", "main own change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const mainOid = headOid(repo);

      // rebase相当: featureの変更をmain上に単純適用した別commitを作る（worktree HEADはrebase前のまま）
      execFileSync("git", ["-C", repo, "cherry-pick", featureHeadOid], { encoding: "utf8" });
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      expect(headOid(repo)).not.toBe(mainOid);

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "patch-equivalent" });
    });

    it("mergeで取り込まれたbranchはpatch-equivalentにならない（Mが非空 → 行12相当。内容一致でも成立しない）", async () => {
      const repo = createRepository();
      const worktree = addWorktree(repo, "feature/merge-commit");
      writeFileSync(join(worktree, "f2.txt"), "feature-only\n");
      git(worktree, ["add", "f2.txt"]);
      git(worktree, ["commit", "-q", "-m", "feature own commit"]);

      writeFileSync(join(repo, "g.txt"), "main-change\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "main change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      // worktree 側で main を merge することで、worktree HEAD 自体に merge commit を作る
      git(worktree, ["merge", "main", "-m", "merge main into feature"]);

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "none" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unintegrated:branch-commits-not-in-main",
      });
    });

    it("空白の扱いだけが異なる変更はpatch-idが一致してもnoneになる（cherry単独のfalse positiveを内容一致で補強）", async () => {
      const repo = createRepository();
      // main側: 対象行を変更
      writeFileSync(join(repo, "f.txt"), "line1\nline2X\nline3\n");
      git(repo, ["commit", "-q", "-am", "main change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      // baseへ戻ってfeatureを分岐し、同じ行を空白付きで変更する
      const worktree = addWorktree(repo, "feature/whitespace-only", "HEAD~1");
      writeFileSync(join(worktree, "f.txt"), "line1\n line2X \nline3\n");
      git(worktree, ["commit", "-q", "-am", "feature change with whitespace diff"]);

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "none" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unintegrated:branch-commits-not-in-main",
      });
    });

    it("非mergeコミットが空commitでpathを持たない場合、条件3をスキップしてもツリー全体比較へ退行しない", async () => {
      const repo = createRepository();
      // target: base に対して無関係な独自変更を積む（このファイルは全体比較なら差分として検出されてしまう）
      writeFileSync(join(repo, "f.txt"), "main-only-change\n");
      git(repo, ["commit", "-q", "-am", "main only change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const mainOid = headOid(repo);

      // worktree: base から分岐し、ファイルを一切変更しない空commitだけを積む
      const worktree = addWorktree(repo, "feature/empty-commit", "HEAD~1");
      git(worktree, ["commit", "-q", "--allow-empty", "-m", "empty commit, touches nothing"]);

      const commands: string[][] = [];
      const spyExecutor: GitExecutor = {
        run: async (cwd, args) => {
          commands.push([...args]);
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const spyProbe = new NodeStewardArchiveIntegrationProbe(spyExecutor);

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      // 空commitはcherryにとって「upstreamに等価なものが無い」ためcondition2で+判定されnoneになる。
      // ここで確認したいのはverdictの妥当性ではなく、以下のdiff呼び出し回数（regression guard）。
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "none" });
      // path集合が空のまま条件3を評価する（=diffが呼ばれる）と、main側だけの無関係な変更(f.txt)を
      // 理由にveto(none)されてしまう。パスが空の場合はdiffそのものを呼ばないことを確認する。
      const diffCalls = commands.filter((call) => call[0] === "diff");
      expect(diffCalls).toHaveLength(0);
      // diffが呼ばれたとしても必ずpathspecを伴う不変条件も併せて確認する（将来diffが増えても壊れない）
      for (const call of diffCalls) {
        const separatorIndex = call.indexOf("--");
        expect(separatorIndex).toBeGreaterThanOrEqual(0);
        expect(call.length).toBeGreaterThan(separatorIndex + 1);
      }
      void mainOid;
    });
  });

  // ---------------------------------------------------------------------
  // §74.2.3 実行制約・セキュリティ
  // ---------------------------------------------------------------------

  describe("実行制約・セキュリティ", () => {
    // F5: allowlist化した sanitizedGitEnv() の回帰ガード。テストごとに汚染した process.env を
    // 必ず afterEach で復元する（次のテストへ漏れると誤検知の原因になる）。
    let pollutedEnvBackup: NodeJS.ProcessEnv | null = null;

    afterEach(() => {
      if (pollutedEnvBackup !== null) {
        const backup = pollutedEnvBackup;
        pollutedEnvBackup = null;
        for (const key of Object.keys(process.env)) {
          delete process.env[key];
        }
        Object.assign(process.env, backup);
      }
    });

    it("危険なGIT_*環境変数を汚染してもallowlistにより無視され判定に影響しない（F5）", async () => {
      // repo/worktreeのセットアップ自体もこのファイルの`git`ヘルパー（execFileSync、process.env継承）を
      // 使うため、汚染は probe.observe() の直前だけに限定する。先にセットアップを終わらせておく。
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/env-allowlist-guard");

      pollutedEnvBackup = { ...process.env };
      // 存在しないディレクトリを指す値で汚染する。allowlist化前は denylist 漏れの
      // GIT_COMMON_DIR / GIT_OBJECT_DIRECTORY / GIT_SHALLOW_FILE / GIT_REPLACE_REF_BASE /
      // GIT_EXEC_PATH を継承してしまい、実 repo とは無関係なパスを参照しにいく可能性があった。
      // 旧 denylist が対象にしていた GIT_DIR 等も含め、GIT_* を一切継承しないことを保証する。
      const poisoned = join(tmpdir(), "hachi-swi-poisoned-env-should-not-exist");
      Object.assign(process.env, {
        GIT_DIR: poisoned,
        GIT_WORK_TREE: poisoned,
        GIT_INDEX_FILE: join(poisoned, "index"),
        GIT_COMMON_DIR: poisoned,
        GIT_OBJECT_DIRECTORY: poisoned,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: poisoned,
        GIT_SHALLOW_FILE: join(poisoned, "shallow"),
        GIT_REPLACE_REF_BASE: "refs/does-not-exist/",
        GIT_EXTERNAL_DIFF: "false",
        GIT_EXEC_PATH: poisoned,
        GIT_CONFIG: join(poisoned, "gitconfig"),
        GIT_CONFIG_GLOBAL: join(poisoned, "gitconfig-global"),
        GIT_CONFIG_SYSTEM: join(poisoned, "gitconfig-system"),
        GIT_CONFIG_NOSYSTEM: "1",
      });

      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      // 汚染前提のancestorテスト（316行目付近）と同一の判定結果になること。
      // 汚染された値のいずれかが継承されていれば、存在しないディレクトリ参照によって
      // git実行自体が失敗しprobe-failed等に化けるはずである。
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "ancestor" });
      expect(observation.drift).toBe(false);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "allow",
        integrationEvidence: "clean-head-reachable",
      });
    });

    it("diff.externalが設定されていても外部コマンドを実行しない（--no-ext-diffの効果）", async () => {
      const repo = createRepository();
      const markerPath = join(repo, "external-diff-executed.marker");
      // 実行されたら marker file を作るスクリプトを diff.external として登録する
      const scriptPath = join(repo, "malicious-external-diff.sh");
      writeFileSync(
        scriptPath,
        `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`,
      );
      execFileSync("chmod", ["+x", scriptPath]);
      git(repo, ["config", "diff.external", scriptPath]);

      writeFileSync(join(repo, "f.txt"), "main-change\n");
      git(repo, ["commit", "-q", "-am", "main change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/ext-diff-guard", "HEAD~1");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);

      await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(existsSync(markerPath)).toBe(false);
    });

    it("textconvフィルタが設定されていても差分判定に影響しない（--no-textconvの効果）", async () => {
      // 検証メモ: git 2.53時点の実測では `git diff --quiet` は blob oid の直接比較で判定を確定させ、
      // --no-textconv の有無に関わらず textconv ドライバ自体を一切呼ばない高速経路を取る
      // （--quiet は表示用のテキスト生成を必要としないため）。そのため「スクリプトが実行されるか」
      // 「判定結果が変わるか」だけでは --no-textconv 欠落を検知できない（常に通ってしまう）。
      // §74.2.3 は diff系コマンドへの --no-textconv 付与そのものを要求しているため、
      // 実引数に --no-textconv が含まれることを構造的に検証し、将来 --quiet の実装が変わった場合や
      // 他のgitバージョンでの防御としても機能することを保証する。
      const repo = createRepository();
      const markerPath = join(repo, "textconv-executed.marker");
      // 実行されたら marker file を作り、常に同じ内容を返す（＝入力に関わらず差分無しに見せかける）
      // スクリプトを textconv として登録する。
      const scriptPath = join(repo, "malicious-textconv.sh");
      writeFileSync(scriptPath, `#!/bin/sh\ntouch "${markerPath}"\necho "normalized"\nexit 0\n`);
      execFileSync("chmod", ["+x", scriptPath]);
      // .gitattributes は分岐前にコミットしておく（worktree側で未追跡ファイルにするとporcelainが
      // dirtyになり、diffが評価されるcondition3まで到達できなくなるため）。
      writeFileSync(join(repo, ".gitattributes"), "f.txt diff=hachi-textconv-guard\n");
      git(repo, ["add", ".gitattributes"]);
      git(repo, ["commit", "-q", "-m", "add gitattributes for textconv guard"]);
      git(repo, ["config", "diff.hachi-textconv-guard.textconv", scriptPath]);

      // main側: 対象行を変更
      writeFileSync(join(repo, "f.txt"), "line1\nline2X\nline3\n");
      git(repo, ["commit", "-q", "-am", "main change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      // baseへ戻ってfeatureを分岐し、同じ行を空白付きで変更する
      // （cherryのpatch-idは一致するが生バイトの内容は異なる。既存の「空白の扱いだけが異なる変更」
      // テストと同じ構図を使い、条件3（生バイト比較）まで到達させる）
      const worktree = addWorktree(repo, "feature/textconv-guard", "HEAD~1");
      writeFileSync(join(worktree, "f.txt"), "line1\n line2X \nline3\n");
      git(worktree, ["commit", "-q", "-am", "feature change with whitespace diff"]);

      const diffCommands: string[][] = [];
      const spyExecutor: GitExecutor = {
        run: async (cwd, args) => {
          if (args[0] === "diff") {
            diffCommands.push([...args]);
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const spyProbe = new NodeStewardArchiveIntegrationProbe(spyExecutor);

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      // condition3のdiff --quiet呼び出しが実際に発生し、その実引数に--no-textconvが
      // 含まれていること（regression guard: このフラグが抜けるとここで検知する）
      expect(diffCommands.length).toBeGreaterThan(0);
      for (const call of diffCommands) {
        expect(call).toContain("--no-textconv");
      }
      // textconvスクリプトが一切実行されていないこと（現在のgit挙動下でも成立する不変条件）
      expect(existsSync(markerPath)).toBe(false);
      // 生バイトの差分が正しく検出され、条件3は不成立のままnoneに倒れる
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "none" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unintegrated:branch-commits-not-in-main",
      });
    });

    it("diff-tree呼び出しの実引数に--no-ext-diff/--no-textconvが含まれる（F5: args[0]==='diff'前方一致だけでは捕捉できないサブコマンド）", async () => {
      // 上のtextconvテストは args[0] === "diff" のみをフィルタしており、condition3で
      // 先に呼ばれる `diff-tree` サブコマンドへのフラグ付与は別途検証していなかった。
      // cherry-pickで統合されたbranchのシナリオ（331行目付近）を再利用し、Bの評価が
      // condition3（diff-tree → diff）まで到達することを保証したうえで実引数を検証する。
      const repo = createRepository();
      writeFileSync(join(repo, "g.txt"), "shared\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "add shared file"]);
      const worktree = addWorktree(repo, "feature/diff-tree-flags");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);
      const featureHeadOid = headOid(worktree);

      writeFileSync(join(repo, "g.txt"), "main-own\n");
      git(repo, ["commit", "-q", "-am", "main own change"]);
      execFileSync("git", ["-C", repo, "cherry-pick", featureHeadOid], { encoding: "utf8" });
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      const diffTreeCommands: string[][] = [];
      const spyExecutor: GitExecutor = {
        run: async (cwd, args) => {
          if (args[0] === "diff-tree") {
            diffTreeCommands.push([...args]);
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      };
      const spyProbe = new NodeStewardArchiveIntegrationProbe(spyExecutor);

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(diffTreeCommands.length).toBeGreaterThan(0);
      for (const call of diffTreeCommands) {
        expect(call).toContain("--no-ext-diff");
        expect(call).toContain("--no-textconv");
      }
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "patch-equivalent" });
    });

    it("pathspec magicに見えるファイル名でも--literal-pathspecsにより文字どおり扱われる", async () => {
      const repo = createRepository();
      const weirdName = ":(icase)weird-name.txt";
      writeFileSync(join(repo, "f.txt"), "main-change\n");
      writeFileSync(join(repo, weirdName), "main-weird\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "main change with weird pathspec-like filename"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/weird-pathspec", "HEAD~1");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      writeFileSync(join(worktree, weirdName), "feature-weird\n");
      git(worktree, ["add", "."]);
      git(worktree, ["commit", "-q", "-m", "feature change with same weird filename, different content"]);

      // 例外を投げずに完走し、内容差分としてnoneへ倒れることを確認する（クラッシュしない = literal解釈できている）
      const observation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.cwd).toEqual({ kind: "worktree-present" });
      expect(observation.integrationProof?.kind).toBe("clean");
    });
  });

  // ---------------------------------------------------------------------
  // probe失敗・timeout・maxBuffer（DIによるシミュレーション）
  // ---------------------------------------------------------------------

  describe("probe失敗・timeout・maxBuffer（DI）", () => {
    /** 指定コマンド（先頭引数）だけを偽装し、それ以外は実executorへ委譲するラッパー。 */
    function makeSelectiveFakeExecutor(
      shouldFake: (args: readonly string[]) => boolean,
      fakeResult: GitExecResult,
    ): GitExecutor {
      const real = new NodeStewardArchiveIntegrationGitExecutor();
      return {
        run: async (cwd, args) => (shouldFake(args) ? fakeResult : real.run(cwd, args)),
      };
    }

    it("HEAD取得自体が失敗する場合はprobe-failedになる（行8相当）", async () => {
      const repo = createRepository();
      const worktree = addWorktree(repo, "feature/head-fail");
      // toplevel/common-dir解決（cwd正規化）は通す。worktree HEADのpinだけを失敗させる。
      const fakeExecutor = makeSelectiveFakeExecutor(
        (args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
        { kind: "failed" },
      );
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(fakeExecutor);

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.cwd).toEqual({ kind: "worktree-present" });
      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("symbolic-ref解決自体が失敗する場合、targetがunresolvedでも行7ではなく行8になる", async () => {
      const repo = createRepository();
      const worktree = addWorktree(repo, "feature/symref-fail");
      // cwd正規化・HEAD pinは通し、統合先解決の入口（symbolic-ref origin/HEAD）だけを失敗させる。
      // resolveIntegrationTargetの実装上、symbolic-refがfailedを返した時点でフォールバック候補
      // （refs/remotes/origin/main等）を試さず即failedへ倒れるため、他コマンドは呼ばれない想定。
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "symbolic-ref", { kind: "failed" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationTarget).toEqual({ state: "unresolved" });
      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("statusがmaxBufferを超過した場合はdirtyとして扱う（probe-failedにしない。行9）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/status-maxbuffer");
      const fakeProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          if (args[0] === "status") {
            return { kind: "max-buffer" };
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      });

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "dirty" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unintegrated:worktree-dirty",
      });
    });

    it("merge-base --is-ancestorのexit1はprobe失敗と混同せずB評価へ進む", async () => {
      const repo = createRepository();
      writeFileSync(join(repo, "g.txt"), "shared\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "add shared"]);
      const worktree = addWorktree(repo, "feature/is-ancestor-exit1");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);
      const featureHeadOid = headOid(worktree);
      writeFileSync(join(repo, "g.txt"), "main-own\n");
      git(repo, ["commit", "-q", "-am", "main own change"]);
      execFileSync("git", ["-C", repo, "cherry-pick", featureHeadOid], { encoding: "utf8" });
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      let ancestorCalls = 0;
      const spyProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          if (args[0] === "merge-base") {
            ancestorCalls += 1;
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      });

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(ancestorCalls).toBe(1);
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "patch-equivalent" });
    });

    it("merge-base --is-ancestorが0/1以外で終了した場合はprobe-failedになる", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/ancestor-crash");
      const fakeProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          if (args[0] === "merge-base") {
            return { kind: "failed" };
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      });

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
    });

    /**
     * §74.2.3.1: rev-list/cherry/diff-tree は status --porcelain とは異なり、maxBuffer 超過を
     * dirty（行9）とはせず probe-failed（行8）として扱わなければならない（出力を保守的に諦める）。
     * B経路（rev-list --merges/--no-merges・cherry・diff-tree を実際に呼ぶ）まで到達させるため、
     * 「cherry-pickで統合されたbranch」のセットアップを流用する。
     */
    function createPatchEquivalentWorktree(): { repo: string; worktree: string } {
      const repo = createRepository();
      writeFileSync(join(repo, "g.txt"), "shared\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "add shared file"]);
      const worktree = addWorktree(repo, "feature/maxbuffer-b-path");
      writeFileSync(join(worktree, "f.txt"), "feature-change\n");
      git(worktree, ["commit", "-q", "-am", "feature change"]);
      const featureHeadOid = headOid(worktree);

      writeFileSync(join(repo, "g.txt"), "main-own\n");
      git(repo, ["commit", "-q", "-am", "main own change"]);
      execFileSync("git", ["-C", repo, "cherry-pick", featureHeadOid], { encoding: "utf8" });
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      return { repo, worktree };
    }

    it("rev-listがmaxBufferを超過した場合はdirty(行9)ではなくprobe-failed(行8)になる", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "rev-list", { kind: "max-buffer" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("cherryがmaxBufferを超過した場合はdirty(行9)ではなくprobe-failed(行8)になる", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "cherry", { kind: "max-buffer" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("diff-treeがmaxBufferを超過した場合はdirty(行9)ではなくprobe-failed(行8)になる", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "diff-tree", { kind: "max-buffer" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    /**
     * F2: §74.2.3.1 の表では rev-list/cherry/diff-tree は exit 0 のときだけ「出力で判定」対象
     * であり、exit 1 は行8（probe失敗）である。修正前は 0/1 双方を成功扱いにしており、
     * 実際の git エラー（不正な revision range 等）を「出力が空」と誤解釈し得た。
     * ここでは exit1 を直接偽装し、probe-failed へ倒れることを検証する（0との混同の回帰ガード）。
     */
    it("rev-listがexit1で終了した場合はprobe-failedになる（0/1混同の回帰ガード）", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "rev-list", { kind: "exit", code: 1, stdout: "" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("cherryがexit1で終了した場合はprobe-failedになる（0/1混同の回帰ガード）", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "cherry", { kind: "exit", code: 1, stdout: "" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });

    it("diff-treeがexit1で終了した場合はprobe-failedになる（0/1混同の回帰ガード）", async () => {
      const { worktree } = createPatchEquivalentWorktree();
      const fakeProbe = new NodeStewardArchiveIntegrationProbe(
        makeSelectiveFakeExecutor((args) => args[0] === "diff-tree", { kind: "exit", code: 1, stdout: "" }),
      );

      const observation = await fakeProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "probe-failed" });
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:probe-failed",
      });
    });
  });

  // ---------------------------------------------------------------------
  // §74.4 drift 最終確認
  // ---------------------------------------------------------------------

  describe("drift最終確認", () => {
    it("判定途中にtask cwdのsymlinkが別のdirty worktreeへ付け替わったらstaleなallowへ倒さずobservation-driftでvetoする（F4実測fail-open）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const originalWorktree = addWorktree(repo, "feature/cwd-symlink-original");
      const dirtyWorktree = addWorktree(repo, "feature/cwd-symlink-dirty");
      writeFileSync(join(dirtyWorktree, "untracked-result.txt"), "not integrated\n");

      const aliasParent = makeTmpPath("hachi-swi-f4-cwd-alias-parent-");
      const taskCwd = join(aliasParent, "task-cwd");
      symlinkSync(originalWorktree, taskCwd, "dir");

      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            rmSync(taskCwd);
            symlinkSync(dirtyWorktree, taskCwd, "dir");
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: taskCwd, canonicalWorktreeRoot: aliasParent });

      expect(raceTriggered).toBe(true);
      expect(git(dirtyWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).not.toBe("");
      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "ancestor" });
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("判定途中にtask cwdが別のclean worktree identityを指すようになってもobservation-driftでvetoする", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const originalWorktree = addWorktree(repo, "feature/cwd-identity-original");
      const replacementWorktree = addWorktree(repo, "feature/cwd-identity-replacement");

      const aliasParent = makeTmpPath("hachi-swi-f4-identity-alias-parent-");
      const taskCwd = join(aliasParent, "task-cwd");
      symlinkSync(originalWorktree, taskCwd, "dir");

      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            rmSync(taskCwd);
            symlinkSync(replacementWorktree, taskCwd, "dir");
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: taskCwd, canonicalWorktreeRoot: aliasParent });

      expect(raceTriggered).toBe(true);
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("task cwdのsymlinkが付け替わらない正常系は直接指定と同じevidenceでallowされる", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/cwd-symlink-stable");
      const aliasParent = makeTmpPath("hachi-swi-f4-stable-alias-parent-");
      const taskCwd = join(aliasParent, "task-cwd");
      symlinkSync(worktree, taskCwd, "dir");

      const directObservation = await probe.observe({ cwd: worktree, canonicalWorktreeRoot: aliasParent });
      const aliasObservation = await probe.observe({ cwd: taskCwd, canonicalWorktreeRoot: aliasParent });

      expect(aliasObservation).toEqual(directObservation);
      expect(aliasObservation.drift).toBe(false);
      expect(decideArchiveIntegration(aliasObservation)).toEqual({
        verdict: "allow",
        integrationEvidence: "clean-head-reachable",
      });
    });

    it("A(ancestor)確定直前にHEADが前進していたらdrift:trueで倒す", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/drift-race");

      // merge-base --is-ancestor 呼び出し（A判定）の直後に、レース相当でHEADを前進させる
      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            writeFileSync(join(worktree, "race.txt"), "race\n");
            execFileSync("git", ["-C", worktree, "add", "race.txt"], { encoding: "utf8" });
            execFileSync(
              "git",
              ["-C", worktree, "-c", "user.email=race@example.com", "-c", "user.name=Race", "commit", "-q", "-m", "race commit"],
              { encoding: "utf8" },
            );
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(raceTriggered).toBe(true);
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("A(ancestor)確定直前に統合先refがforce-updateされたらdrift:trueで倒す（統合先ref変化の検出）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/target-ref-drift-race");
      // 統合先refをforce-updateする先のcommitをrepo側に用意しておく（pin時点ではまだ反映しない）
      writeFileSync(join(repo, "h.txt"), "advanced\n");
      git(repo, ["add", "h.txt"]);
      git(repo, ["commit", "-q", "-m", "advance main after target pin"]);
      const advancedOid = headOid(repo);

      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            // worktree HEADは動かさず、統合先ref（origin/main）だけをレース的にforce-updateする
            execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", advancedOid], {
              encoding: "utf8",
            });
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(raceTriggered).toBe(true);
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("A(ancestor)確定直前にworktree identity（common-dir）が変化していたらdrift:trueで倒す（identity再検証、F4）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/identity-drift-race");

      // rev-parse --show-toplevel --git-common-dir の2回目の呼び出し（checkDrift のidentity再検証）
      // だけ、common-dirが別の実在ディレクトリへ変わったことにする。worktreeが同一パスで
      // remove→add し直され、別リポジトリの一部になった場合等を模擬する。
      let identityCalls = 0;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
            identityCalls += 1;
            if (identityCalls === 2 && result.kind === "exit" && result.code === 0) {
              const [toplevelLine] = result.stdout.trim().split(/\r?\n/);
              return { kind: "exit", code: 0, stdout: `${toplevelLine}\n${tmpdir()}\n` };
            }
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(identityCalls).toBe(2);
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("A(ancestor)確定直前に統合先refのsymbolic-refが別ブランチへ付け替えられたら、pinしたref名自体のOIDが不変でもdrift:trueで倒す（順序付きフォールバック再実行による検出、F4）", async () => {
      const repo = createRepository();
      const baseOid = headOid(repo);
      git(repo, ["update-ref", "refs/remotes/origin/main", baseOid]);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const worktree = addWorktree(repo, "feature/target-repoint-race");

      // 付け替え先となる別ブランチをあらかじめ用意しておく（pin時点ではまだ origin/HEAD から見えない）
      git(repo, ["branch", "develop-ref", baseOid]);
      writeFileSync(join(repo, "develop-only.txt"), "develop\n");
      git(repo, ["checkout", "-q", "develop-ref"]);
      git(repo, ["add", "develop-only.txt"]);
      git(repo, ["commit", "-q", "-m", "develop only change"]);
      const developOid = headOid(repo);
      git(repo, ["update-ref", "refs/remotes/origin/develop", developOid]);
      git(repo, ["checkout", "-q", "main"]);

      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            // pinしたref名（origin/main）自体のOIDは変えず、origin/HEADの向き先だけをdevelopへ付け替える。
            // 旧実装（pinしたref名のOIDを直接引き直すだけ）ならここを検出できない。
            execFileSync(
              "git",
              ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"],
              { encoding: "utf8" },
            );
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(raceTriggered).toBe(true);
      // pin していた ref 名（origin/main）自体のOIDは不変であることを確認する
      expect(git(repo, ["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(baseOid);
      expect(observation.integrationTarget).toEqual({
        state: "resolved",
        ref: "refs/remotes/origin/main",
        oid: baseOid,
      });
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("A(ancestor)確定直前にporcelainがdirty化したらdrift:trueで倒す（porcelain変化の検出）", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/porcelain-drift-race");

      let raceTriggered = false;
      const racingProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          const result = await new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
          if (args[0] === "merge-base" && !raceTriggered) {
            raceTriggered = true;
            // HEAD・統合先refは動かさず、未追跡ファイルを置いてporcelainだけをdirty化する
            writeFileSync(join(worktree, "race-untracked.txt"), "race\n");
          }
          return result;
        },
      });

      const observation = await racingProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(raceTriggered).toBe(true);
      expect(observation.drift).toBe(true);
      expect(decideArchiveIntegration(observation)).toEqual({
        verdict: "veto",
        integrationEvidence: "unobservable:observation-drift",
      });
    });

    it("drift再確認は行10/11確定直前のみ行われ、dirty(行9)には影響しない", async () => {
      const repo = createRepository();
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const worktree = addWorktree(repo, "feature/dirty-no-drift-check");
      writeFileSync(join(worktree, "dirty.txt"), "dirty\n");

      let statusCalls = 0;
      const spyProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          if (args[0] === "status") {
            statusCalls += 1;
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      });

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "dirty" });
      expect(observation.drift).toBe(false);
      // dirty判定用の1回だけであり、drift再確認用のstatus呼び出しは発生しない
      expect(statusCalls).toBe(1);
    });

    it("行12(none)確定にはdrift再確認が発生しない", async () => {
      const repo = createRepository();
      const worktree = addWorktree(repo, "feature/none-no-drift-check");
      writeFileSync(join(worktree, "f2.txt"), "feature-only\n");
      git(worktree, ["add", "f2.txt"]);
      git(worktree, ["commit", "-q", "-m", "feature own commit"]);
      writeFileSync(join(repo, "g.txt"), "main-change\n");
      git(repo, ["add", "g.txt"]);
      git(repo, ["commit", "-q", "-m", "main change"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(worktree, ["merge", "main", "-m", "merge main into feature"]);

      let statusCalls = 0;
      const spyProbe = new NodeStewardArchiveIntegrationProbe({
        run: async (cwd, args) => {
          if (args[0] === "status") {
            statusCalls += 1;
          }
          return new NodeStewardArchiveIntegrationGitExecutor().run(cwd, args);
        },
      });

      const observation = await spyProbe.observe({ cwd: worktree, canonicalWorktreeRoot: worktree });

      expect(observation.integrationProof).toEqual({ kind: "clean", proof: "none" });
      expect(observation.drift).toBe(false);
      expect(statusCalls).toBe(1);
    });
  });
});
