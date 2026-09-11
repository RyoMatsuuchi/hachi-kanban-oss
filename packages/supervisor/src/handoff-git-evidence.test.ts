import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeHandoffGitEvidenceProbe,
  type HandoffGitLaunchSnapshot,
} from "./handoff-git-evidence.js";

/**
 * 実 git subprocess を 1 test あたり 20 回前後起動するため、workspace 全体を並列実行すると
 * 既定の 5s では待ち時間だけで溢れる（実測: 単体 0.3s / 全体並列時 5s 超で timeout）。
 * 実 git を触る他の suite（packages/cli の fanout 等）と同じく明示 timeout を置く。
 */
describe("NodeHandoffGitEvidenceProbe", { timeout: 120_000 }, () => {
  const tmpPaths: string[] = [];
  const probe = new NodeHandoffGitEvidenceProbe();

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

  function createRepository(): string {
    const repo = makeTmpPath("hachi-handoff-git-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    return repo;
  }

  async function availableSnapshot(repo: string): Promise<Extract<HandoffGitLaunchSnapshot, { state: "available" }>> {
    const snapshot = await probe.captureLaunchSnapshot(repo);
    expect(snapshot.state).toBe("available");
    if (snapshot.state !== "available") {
      throw new Error(`launch snapshot unavailable: ${snapshot.reason}`);
    }
    return snapshot;
  }

  it("launch時のcanonical worktree/common-dir/HEADからcleanを判定する", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(snapshot.canonicalWorktree).toBe(realpathSync(repo));
    expect(snapshot.repoCommonDir).toBe(realpathSync(join(repo, ".git")));
    expect(snapshot.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence).toMatchObject({
      state: "clean",
      dirtyFileCount: 0,
      paths: [],
      commitCount: 0,
      commitSummaries: [],
    });
  });

  it("tracked/untracked変更をrepo-relative pathのdirty evidenceとして返す", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "README.md"), "dirty\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "new.ts"), "export {};\n");

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({
      state: "dirty",
      dirtyFileCount: 2,
      dirtyFileCountTruncated: false,
      commitCount: 0,
    });
    expect(evidence.paths).toEqual(["README.md", "src/new.ts"]);
  });

  it("working treeがcleanでもbase後のcommitをcommit-only dirtyとして短く記録する", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "README.md"), "committed\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "fix sk-supersecret1234"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({
      state: "dirty",
      dirtyFileCount: 0,
      commitCount: 1,
    });
    expect(evidence.commitSummaries).toHaveLength(1);
    expect(evidence.commitSummaries[0]).toContain("[REDACTED]");
    expect(evidence.commitSummaries[0]).not.toContain("supersecret1234");
  });

  /**
   * task branch から見て main が先行している repository を作る。run 中に `git merge` させることで
   * 「取り込んだ上流 commit」を再現する。publishToOrigin=false は、上流がまだ push されておらず
   * remote-tracking ref から到達できない場合（ローカル branch だけが上流を持つ場合）。
   */
  function createRepositoryWithUpstreamAhead(publishToOrigin: boolean): string {
    const repo = createRepository();
    git(repo, ["branch", "feature/task"]);
    writeFileSync(join(repo, "README.md"), "upstream\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "upstream change"]);
    if (publishToOrigin) {
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    }
    git(repo, ["checkout", "-q", "feature/task"]);
    return repo;
  }

  for (const publishToOrigin of [true, false]) {
    const label = publishToOrigin ? "remote-tracking refから到達できる" : "ローカルbranchだけが持つ";
    it(`${label}上流commitをmergeで取り込んでもrun内commitとして数えない`, async () => {
      const repo = createRepositoryWithUpstreamAhead(publishToOrigin);
      const snapshot = await availableSnapshot(repo);
      git(repo, ["merge", "--ff-only", "main"]);

      const evidence = await probe.captureEndEvidence(snapshot);

      expect(evidence).toMatchObject({
        state: "dirty",
        commitCount: 1,
        localCommitCount: 0,
      });
      expect(evidence.localCommitOids).toEqual([]);
    });
  }

  it("現在のbranchで作ったcommitはrun内commitとしてoidまで記録する", async () => {
    const repo = createRepositoryWithUpstreamAhead(true);
    const snapshot = await availableSnapshot(repo);
    git(repo, ["merge", "--ff-only", "main"]);
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "実装を反映"]);
    const headOid = git(repo, ["rev-parse", "HEAD"]).trim();

    const evidence = await probe.captureEndEvidence(snapshot);

    // 取り込んだ上流 1 件は除外し、自分で作った 1 件だけを run 内 commit として数える
    expect(evidence).toMatchObject({ commitCount: 2, localCommitCount: 1 });
    expect(evidence.localCommitOids).toEqual([headOid]);
  });

  /**
   * push すると `origin/<branch>` が前進する。これを「run 前から在った証拠」と扱うと、worker が
   * 自分で作った commit を自分の push で打ち消してしまい no-commit 違反を見逃す。
   */
  it("task branchで作ったcommitはpushしてもrun内commitとして数える", async () => {
    const repo = createRepositoryWithUpstreamAhead(true);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "実装を反映"]);
    const headOid = git(repo, ["rev-parse", "HEAD"]).trim();
    // push 相当: 現在 branch と同名の remote-tracking ref を前進させる
    git(repo, ["update-ref", "refs/remotes/origin/feature/task", headOid]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 1 });
    expect(evidence.localCommitOids).toEqual([headOid]);
  });

  /**
   * 既定 branch 上では同名 ref の前進が push か上流前進かを区別できない。区別できない側では
   * 誤検出を避ける（正当な worker を block しない）ため、除外を維持する。
   */
  it("既定branch上で上流が前進した場合はrun内commitとして数えない", async () => {
    const repo = createRepository();
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const snapshot = await availableSnapshot(repo);
    // run 中に上流が前進し、worker が fetch + fast-forward で取り込んだ状況
    writeFileSync(join(repo, "README.md"), "upstream\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "upstream change"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 0 });
    expect(evidence.localCommitOids).toEqual([]);
  });

  /**
   * 判別できない側へ倒したことを黙って隠さない。`ambiguous` は「remote-tracking ref で引いたが、
   * それが上流前進か worker の push かを判別できていない」ことを host-finalize へ伝える signal。
   */
  it("既定branch上でremote-trackingにより引いた場合はattributionをambiguousとして残す", async () => {
    const repo = createRepository();
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "README.md"), "upstream\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "upstream change"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 0, localCommitAttribution: "ambiguous" });
  });

  it("task branchで判別できている場合のattributionはexact", async () => {
    const repo = createRepositoryWithUpstreamAhead(true);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const snapshot = await availableSnapshot(repo);
    git(repo, ["merge", "--ff-only", "main"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 0, localCommitAttribution: "exact" });
  });

  it("引かれたcommitが無ければattributionはexact（判別の余地が無い）", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "実装を反映"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 1, localCommitAttribution: "exact" });
  });

  it("既定branchを特定できない場合は自branchのremote-trackingも除外源に残す（保守側に倒す）", async () => {
    const repo = createRepositoryWithUpstreamAhead(true);
    // origin/HEAD を設定しない = 既定 branch 不明
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "実装を反映"]);
    git(repo, ["update-ref", "refs/remotes/origin/feature/task", git(repo, ["rev-parse", "HEAD"]).trim()]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 0 });
  });

  it("main上で直接作ったcommitもrun内commitとして数える（自branchを除外源にしない）", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "main へ直接反映"]);

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({ commitCount: 1, localCommitCount: 1 });
    expect(evidence.localCommitOids).toEqual([git(repo, ["rev-parse", "HEAD"]).trim()]);
  });

  it("path一覧と変更file数を上限で切り、secret候補をredactする", async () => {
    const repo = createRepository();
    const snapshot = await availableSnapshot(repo);
    for (let index = 0; index < 205; index += 1) {
      const name =
        index === 0
          ? "000-sk-supersecret1234.ts"
          : `${String(index).padStart(3, "0")}-generated.ts`;
      writeFileSync(join(repo, name), `${index}\n`);
    }

    const evidence = await probe.captureEndEvidence(snapshot);

    expect(evidence).toMatchObject({
      state: "dirty",
      dirtyFileCount: 200,
      dirtyFileCountTruncated: true,
      pathsTruncated: true,
    });
    expect(evidence.paths).toHaveLength(20);
    expect(evidence.paths.join("\n")).toContain("[REDACTED]");
    expect(evidence.paths.join("\n")).not.toContain("supersecret1234");
  });

  it("launch snapshotと現在のcommon-dir ownershipが一致しなければunavailableに倒す", async () => {
    const repo = createRepository();
    const otherRepo = createRepository();
    const snapshot = await availableSnapshot(repo);
    const driftedSnapshot: HandoffGitLaunchSnapshot = {
      ...snapshot,
      repoCommonDir: join(otherRepo, ".git"),
    };

    const evidence = await probe.captureEndEvidence(driftedSnapshot);

    expect(evidence).toMatchObject({
      state: "unavailable",
      dirtyFileCount: null,
      commitCount: null,
      unavailableReason: "ownership-mismatch",
    });
  });

  it("Git外のcwdはcleanへ丸めずunavailable snapshotにする", async () => {
    const directory = makeTmpPath("hachi-handoff-non-git-");

    const snapshot = await probe.captureLaunchSnapshot(directory);
    const evidence = await probe.captureEndEvidence(snapshot);

    expect(snapshot).toMatchObject({ state: "unavailable", reason: "not-git" });
    expect(evidence).toMatchObject({
      state: "unavailable",
      unavailableReason: "not-git",
    });
  });
});
