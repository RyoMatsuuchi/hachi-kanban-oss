import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFanoutPlan,
  createFanoutPlan,
  createKanbanReadView,
  hashFanoutParentBody,
  type FanoutPlanInput,
  type TaskRow,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";
import {
  assertApplyHostPreflight,
  collectFanoutGitSnapshot,
  probeGitObjectFormat,
  readRegularJsonFile,
  type FanoutGitProbe,
} from "./fanout.js";

function createParent(ctx: TestDeps): TaskRow {
  return ctx.deps.store.createTask(
    {
      title: "親タスク",
      body: "cwd: /repo\r\n\r\n親scope\r\n",
      tenant: "dev",
      profile: "plan",
      priority: 10,
      status: "todo",
    },
    "test",
  );
}

function inputFixture(ctx: TestDeps, parent: TaskRow): FanoutPlanInput {
  const root = join(homedir(), ".hachi-kanban", "worktrees");
  return {
    version: "fanout-plan-input.v1",
    parentTaskId: parent.id,
    parentSnapshot: {
      taskId: parent.id,
      updatedAt: parent.updatedAt,
      bodyHash: hashFanoutParentBody(parent.body),
    },
    repoCommonDir: "/repo/.git",
    scopeRoots: ["a", "b", "c"],
    children: [
      {
        key: "a",
        title: "A",
        body: "Aを実装",
        tenant: "dev",
        profile: "implement",
        worktree: join(root, "a"),
        ownership: ["a"],
        dependsOn: [],
      },
      {
        key: "b",
        title: "B",
        body: "Bを実装",
        tenant: "dev",
        profile: "implement",
        worktree: join(root, "b"),
        ownership: ["b"],
        dependsOn: ["a"],
      },
      {
        key: "c",
        title: "C",
        body: "Cを実装",
        tenant: "dev",
        profile: "implement",
        worktree: join(root, "c"),
        ownership: ["c"],
        dependsOn: ["b"],
      },
    ],
    integrationGate: { requiredChildren: ["a", "b", "c"] },
  };
}

function repositoryCommonDir(): string {
  const output = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  return realpathSync(isAbsolute(output) ? output : resolve(process.cwd(), output));
}

function applyFixture(ctx: TestDeps, parent: TaskRow): FanoutPlanInput {
  const input = inputFixture(ctx, parent);
  input.repoCommonDir = repositoryCommonDir();
  input.children.forEach((child) => {
    child.worktree = join(homedir(), ".hachi-kanban", "worktrees", `fanout-test-${parent.id}-${child.key}`);
  });
  return input;
}

function boardSnapshot(ctx: TestDeps, taskId: string): string {
  return JSON.stringify({
    task: ctx.deps.store.getTask(taskId),
    comments: ctx.deps.store.listComments(taskId, 100),
    events: ctx.deps.store.listEvents(taskId, undefined, 100),
    links: ctx.deps.store.listLinks(taskId),
  });
}

describe("hachi fanout plan", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("read-only snapshot照合後にcanonical planをJSON出力しboardを変更しない", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const path = join(ctx.deps.env.home, "plan.json");
    writeFileSync(path, JSON.stringify(inputFixture(ctx, parent)));
    const before = boardSnapshot(ctx, parent.id);

    await buildProgram(ctx.deps).parseAsync(
      ["fanout", "plan", "--parent", parent.id, "--file", path, "--json"],
      { from: "user" },
    );

    expect(ctx.stderr.text()).toBe("");
    const output = JSON.parse(ctx.stdout.text()) as { planHash: string; canonicalJson: string };
    expect(output.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(output.canonicalJson)).toMatchObject({ version: "fanout-plan.v1", parentTaskId: parent.id });
    expect(boardSnapshot(ctx, parent.id)).toBe(before);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("stale snapshotは失敗しboardを変更しない", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const input = inputFixture(ctx, parent);
    input.parentSnapshot.bodyHash = "f".repeat(64);
    const path = join(ctx.deps.env.home, "stale.json");
    writeFileSync(path, JSON.stringify(input));
    const before = boardSnapshot(ctx, parent.id);

    await buildProgram(ctx.deps).parseAsync(["fanout", "plan", "--parent", parent.id, "--file", path], {
      from: "user",
    });

    expect(ctx.stderr.text()).toContain("親タスクsnapshotが現在値と一致しません");
    expect(ctx.exitCodes).toEqual([1]);
    expect(boardSnapshot(ctx, parent.id)).toBe(before);
  });

  it("symlink・directory・1MiB超・異形JSONをfail-closedで拒否する", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const valid = join(ctx.deps.env.home, "valid.json");
    writeFileSync(valid, JSON.stringify(inputFixture(ctx, parent)));
    const symlink = join(ctx.deps.env.home, "link.json");
    symlinkSync(valid, symlink);
    const directory = join(ctx.deps.env.home, "directory");
    mkdirSync(directory);
    const oversized = join(ctx.deps.env.home, "oversized.json");
    writeFileSync(oversized, "x".repeat(1024 * 1024 + 1));
    const malformed = join(ctx.deps.env.home, "malformed.json");
    writeFileSync(malformed, "{");
    const before = boardSnapshot(ctx, parent.id);

    for (const [path, expected] of [
      [symlink, "symlink"],
      [directory, "通常file"],
      [oversized, "1MiB"],
      [malformed, "JSONが不正"],
    ] as const) {
      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync(["fanout", "plan", "--parent", parent.id, "--file", path], {
        from: "user",
      });
      expect(ctx.stderr.text()).toContain(expected);
    }
    expect(ctx.exitCodes).toEqual([1, 1, 1, 1]);
    expect(boardSnapshot(ctx, parent.id)).toBe(before);
  });

  it("fstat後に1MiB超へ拡張されたfileもbounded readで拒否する", () => {
    ctx = createTestDeps();
    const path = join(ctx.deps.env.home, "growing.json");
    writeFileSync(path, "{}");

    expect(() =>
      readRegularJsonFile(path, () => {
        appendFileSync(path, "x".repeat(1024 * 1024));
      }),
    ).toThrow("1MiB以下");
  });

  it("file pathのNULをopen前に汎用エラーで拒否する", () => {
    ctx = createTestDeps();
    expect(() => readRegularJsonFile("/tmp/\0secret-path")).toThrow("NUL");
  });

  it("secret-like child specはstdoutへ平文もplanも出さず拒否する", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const secret = "ghp_1234567890abcdEFGH";
    const input = inputFixture(ctx, parent);
    input.children[0]!.body = `token ${secret}`;
    const path = join(ctx.deps.env.home, "secret.json");
    writeFileSync(path, JSON.stringify(input));
    const before = boardSnapshot(ctx, parent.id);

    await buildProgram(ctx.deps).parseAsync(
      ["fanout", "plan", "--parent", parent.id, "--file", path, "--json"],
      { from: "user" },
    );

    expect(ctx.stdout.text()).toBe("");
    expect(ctx.stderr.text()).toContain("secret-like value is not allowed");
    expect(ctx.stderr.text()).not.toContain(secret);
    expect(boardSnapshot(ctx, parent.id)).toBe(before);
  });

  it("存在しないsecret-like pathのOSエラーをstderrへ反射しない", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const secretPath = "/tmp/token=supersecret";
    const before = boardSnapshot(ctx, parent.id);

    await buildProgram(ctx.deps).parseAsync(
      ["fanout", "plan", "--parent", parent.id, "--file", secretPath],
      { from: "user" },
    );

    expect(ctx.stdout.text()).toBe("");
    expect(ctx.stderr.text()).toContain("--file を安全に読み取れません");
    expect(ctx.stderr.text()).not.toContain("supersecret");
    expect(ctx.stderr.text()).not.toContain(secretPath);
    expect(boardSnapshot(ctx, parent.id)).toBe(before);
  });
});

describe("hachi fanout apply", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("canonicalな任意directoryをGit common-dirとして受理せず、GIT_* spoofも無視する", () => {
    ctx = createTestDeps();
    const arbitrary = join(ctx.deps.env.home, "not-a-git-common-dir");
    mkdirSync(arbitrary, { recursive: true });
    const previousGitDir = process.env["GIT_DIR"];
    const previousGitWorkTree = process.env["GIT_WORK_TREE"];
    process.env["GIT_DIR"] = repositoryCommonDir();
    process.env["GIT_WORK_TREE"] = process.cwd();
    try {
      expect(() => assertApplyHostPreflight(realpathSync(arbitrary), [])).toThrow(/Git repository/);
    } finally {
      if (previousGitDir === undefined) {
        delete process.env["GIT_DIR"];
      } else {
        process.env["GIT_DIR"] = previousGitDir;
      }
      if (previousGitWorkTree === undefined) {
        delete process.env["GIT_WORK_TREE"];
      } else {
        process.env["GIT_WORK_TREE"] = previousGitWorkTree;
      }
    }
  });

  it("active generationと承認hashを照合し、同一planの再実行をno-opにする", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const input = applyFixture(ctx, parent);
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "fanout-test",
      project: "hachi-kanban",
      repoCommonDir: input.repoCommonDir,
    });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(parent.id, orchestrator.id, "primary");
    const path = join(ctx.deps.env.home, "apply.json");
    writeFileSync(path, JSON.stringify(input));
    const planHash = createFanoutPlan(input).planHash;
    const args = [
      "fanout",
      "apply",
      "--parent",
      parent.id,
      "--file",
      path,
      "--approved-plan-hash",
      planHash,
      "--orchestrator",
      orchestrator.id,
      "--session",
      session.id,
      "--generation",
      String(session.generation),
      "--json",
    ];

    const previousGitDir = process.env["GIT_DIR"];
    const previousGitWorkTree = process.env["GIT_WORK_TREE"];
    process.env["GIT_DIR"] = "/spoofed/not-a-repository";
    process.env["GIT_WORK_TREE"] = "/spoofed/not-a-worktree";
    try {
      await buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      const first = JSON.parse(ctx.stdout.text()) as { applied: boolean; children: Array<{ task: TaskRow }> };
      expect(first.applied).toBe(true);
      expect(first.children).toHaveLength(3);
      const count = ctx.deps.store.listRecent(100).length;
      ctx.stdout.clear();

      await buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      const second = JSON.parse(ctx.stdout.text()) as { applied: boolean; children: Array<{ task: TaskRow }> };
      expect(second.applied).toBe(false);
      expect(second.children.map((child) => child.task.id)).toEqual(first.children.map((child) => child.task.id));
      expect(ctx.deps.store.listRecent(100)).toHaveLength(count);
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      if (previousGitDir === undefined) {
        delete process.env["GIT_DIR"];
      } else {
        process.env["GIT_DIR"] = previousGitDir;
      }
      if (previousGitWorkTree === undefined) {
        delete process.env["GIT_WORK_TREE"];
      } else {
        process.env["GIT_WORK_TREE"] = previousGitWorkTree;
      }
    }
  });

  it("未承認hashは子taskを作らず拒否する", async () => {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const input = applyFixture(ctx, parent);
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "fanout-test",
      project: "hachi-kanban",
      repoCommonDir: input.repoCommonDir,
    });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(parent.id, orchestrator.id, "primary");
    const path = join(ctx.deps.env.home, "apply-rejected.json");
    writeFileSync(path, JSON.stringify(input));

    await buildProgram(ctx.deps).parseAsync(
      [
        "fanout",
        "apply",
        "--parent",
        parent.id,
        "--file",
        path,
        "--approved-plan-hash",
        "f".repeat(64),
        "--orchestrator",
        orchestrator.id,
        "--session",
        session.id,
        "--generation",
        String(session.generation),
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.listRecent(100)).toHaveLength(1);
    expect(ctx.stderr.text()).toContain("承認済みplan hash");
  });
});

describe("fanout integration-check Git証拠", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  function fixture(): { planResult: ReturnType<typeof createFanoutPlan>; probe: FanoutGitProbe } {
    ctx = createTestDeps();
    const parent = createParent(ctx);
    const planResult = createFanoutPlan(applyFixture(ctx, parent));
    const mainHead = "a".repeat(64);
    const byWorktree = new Map(planResult.plan.children.map((child) => [child.worktree, child.key]));
    const probe: FanoutGitProbe = {
      canonicalRepoCommonDir: (repo) => repo,
      objectFormat: () => "sha256",
      resolveMain: () => mainHead,
      registeredWorktrees: () => new Set(planResult.plan.children.map((child) => child.worktree)),
      canonicalWorktree: (worktree) => worktree,
      worktreeCommonDir: () => planResult.plan.repoCommonDir,
      branch: (worktree) => `codex/${byWorktree.get(worktree)}`,
      head: (worktree) => (byWorktree.get(worktree) ?? "f").repeat(64),
      clean: () => true,
      mainIsAncestor: () => true,
      changedPaths: (worktree) => [`packages/${byWorktree.get(worktree)}/index.ts`],
    };
    return { planResult, probe };
  }

  it("固定main SHAと登録worktreeのread-only証拠snapshotを返す", () => {
    const { planResult, probe } = fixture();

    const snapshot = collectFanoutGitSnapshot(planResult, "refs/heads/main", probe);

    expect(snapshot.mainHead).toBe("a".repeat(64));
    expect(snapshot.objectFormat).toBe("sha256");
    expect(snapshot.mainHeadAfterProbe).toBe(snapshot.mainHead);
    expect(snapshot.children).toHaveLength(3);
    expect(snapshot.children[0]).toMatchObject({
      registeredWorktree: planResult.plan.children[0]!.worktree,
      clean: true,
      mainIsAncestor: true,
    });
  });

  it("実repositoryのsha1 object formatをprobeする", () => {
    expect(probeGitObjectFormat(repositoryCommonDir())).toBe("sha1");
  });

  it("未知object formatをOID取得前に拒否する", () => {
    const { planResult, probe } = fixture();
    let resolveCalls = 0;
    probe.objectFormat = () => "sha512";
    probe.resolveMain = (): string => {
      resolveCalls += 1;
      return "a".repeat(64);
    };

    expect(() => collectFanoutGitSnapshot(planResult, "refs/heads/main", probe)).toThrow(/object format/);
    expect(resolveCalls).toBe(0);
  });

  it("危険なmain refをGit probe前に拒否する", () => {
    const { planResult, probe } = fixture();
    let calls = 0;
    probe.resolveMain = (): string => {
      calls += 1;
      return "a".repeat(64);
    };

    expect(() => collectFanoutGitSnapshot(planResult, "--upload-pack=evil", probe)).toThrow(/main-ref/);
    expect(() => collectFanoutGitSnapshot(planResult, "refs/heads/../main", probe)).toThrow(/main-ref/);
    expect(calls).toBe(0);
  });

  it("mainがprobe中に進んだことをsnapshotへ残し、Core gateが拒否できる", () => {
    const { planResult, probe } = fixture();
    let calls = 0;
    probe.resolveMain = (): string => {
      calls += 1;
      return (calls === 1 ? "a" : "b").repeat(64);
    };

    const snapshot = collectFanoutGitSnapshot(planResult, "refs/heads/main", probe);

    expect(snapshot.mainHead).toBe("a".repeat(64));
    expect(snapshot.mainHeadAfterProbe).toBe("b".repeat(64));
  });
});

type RenameMode = "none" | "outside-to-inside" | "inside-to-inside";

interface IntegrationE2eFixture {
  ctx: TestDeps;
  parentId: string;
  childTaskIds: string[];
  sessionId: string;
  generation: number;
  args: string[];
  boardSnapshot: () => string;
  gitSnapshot: () => string;
  cleanup: () => void;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setupIntegrationE2e(mode: RenameMode): IntegrationE2eFixture {
  const ctx = createTestDeps();
  const repo = mkdtempSync(join(tmpdir(), "hachi-f3-repo-"));
  const worktreeRoot = join(homedir(), ".hachi-kanban", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const fixtureRoot = mkdtempSync(join(worktreeRoot, "f3-e2e-"));
  const worktrees = ["a", "b", "c"].map((key) => join(fixtureRoot, key));
  let cleaned = false;
  try {
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.name", "F3 Test"]);
    runGit(repo, ["config", "user.email", "f3@example.invalid"]);
    runGit(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    writeFileSync(join(repo, "outside.txt"), "outside\n");
    mkdirSync(join(repo, "a"), { recursive: true });
    writeFileSync(join(repo, "a", "original.txt"), "inside\n");
    runGit(repo, ["add", "--", "."]);
    runGit(repo, ["commit", "-m", "seed"]);

    for (const [index, key] of ["a", "b", "c"].entries()) {
      const worktree = worktrees[index]!;
      runGit(repo, ["worktree", "add", "-b", `codex/f3-${key}-${Date.now()}-${index}`, worktree, "main"]);
      if (key === "a" && mode === "outside-to-inside") {
        runGit(worktree, ["mv", "outside.txt", "a/moved.txt"]);
      } else if (key === "a" && mode === "inside-to-inside") {
        runGit(worktree, ["mv", "a/original.txt", "a/moved.txt"]);
      } else {
        mkdirSync(join(worktree, key), { recursive: true });
        writeFileSync(join(worktree, key, "feature.ts"), `export const ${key} = true;\n`);
        runGit(worktree, ["add", "--", `${key}/feature.ts`]);
      }
      runGit(worktree, ["commit", "-m", `child ${key}`]);
    }

    const parent = createParent(ctx);
    const commonDirOutput = runGit(repo, ["rev-parse", "--git-common-dir"]);
    const commonDir = realpathSync(isAbsolute(commonDirOutput) ? commonDirOutput : resolve(repo, commonDirOutput));
    const input: FanoutPlanInput = {
      version: "fanout-plan-input.v1",
      parentTaskId: parent.id,
      parentSnapshot: {
        taskId: parent.id,
        updatedAt: parent.updatedAt,
        bodyHash: hashFanoutParentBody(parent.body),
      },
      repoCommonDir: commonDir,
      scopeRoots: ["a", "b", "c"],
      children: ["a", "b", "c"].map((key, index) => ({
        key,
        title: key.toUpperCase(),
        body: `${key}を実装`,
        tenant: "dev",
        profile: "implement",
        worktree: worktrees[index]!,
        ownership: [key],
        dependsOn: index === 0 ? [] : [["a", "b", "c"][index - 1]!],
      })),
      integrationGate: { requiredChildren: ["a", "b", "c"] },
    };
    const planResult = createFanoutPlan(input);
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "f3-e2e",
      project: "hachi-kanban",
      repoCommonDir: commonDir,
    });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(parent.id, orchestrator.id, "primary");
    const applied = applyFanoutPlan(ctx.deps.store, {
      planResult,
      approvedPlanHash: planResult.planHash,
      orchestratorId: orchestrator.id,
      sessionId: session.id,
      generation: session.generation,
      actor: "orchestrator",
    });
    for (const child of applied.children) {
      const run = ctx.deps.store.startRun(child.task.id, "codex", `review-${child.key}`, { role: "reviewer" });
      ctx.deps.store.endRun(run.id, "done", {
        role: "reviewer",
        verify: { status: "passed", exitCode: 0 },
      });
      ctx.deps.store.transition({ taskId: child.task.id, to: "done", actor: "test" });
    }
    const planPath = join(ctx.deps.env.home, "integration-plan.json");
    writeFileSync(planPath, JSON.stringify(input));
    const args = [
      "fanout",
      "integration-check",
      "--parent",
      parent.id,
      "--file",
      planPath,
      "--approved-plan-hash",
      planResult.planHash,
      "--orchestrator",
      orchestrator.id,
      "--session",
      session.id,
      "--generation",
      String(session.generation),
    ];
    const childTaskIds = applied.children.map((child) => child.task.id);
    return {
      ctx,
      parentId: parent.id,
      childTaskIds,
      sessionId: session.id,
      generation: session.generation,
      args,
      boardSnapshot: (): string => {
        const view = createKanbanReadView(ctx.deps.env.dbPath);
        try {
          const ids = [parent.id, ...childTaskIds];
          return JSON.stringify(ids.map((taskId) => ({
            task: ctx.deps.store.getTask(taskId),
            comments: ctx.deps.store.listComments(taskId),
            events: ctx.deps.store.listEvents(taskId),
            links: ctx.deps.store.listLinks(taskId),
            bindings: ctx.deps.store.listTaskOrchestratorBindings(taskId),
            runs: view.runs(taskId),
          })));
        } finally {
          view.close();
        }
      },
      gitSnapshot: (): string => JSON.stringify({
        refs: runGit(repo, ["for-each-ref", "--sort=refname", "--format=%(refname):%(objectname)"]),
        worktrees: worktrees.map((worktree) => ({
          head: runGit(worktree, ["rev-parse", "HEAD"]),
          branch: runGit(worktree, ["symbolic-ref", "--short", "HEAD"]),
          status: runGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
        })),
      }),
      cleanup: (): void => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        ctx.cleanup();
        for (const worktree of worktrees) {
          try {
            runGit(repo, ["worktree", "remove", "--force", worktree]);
          } catch {
            // setup途中の未登録pathも最後にfixture rootごと除去する。
          }
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      },
    };
  } catch (error) {
    ctx.cleanup();
    for (const worktree of worktrees) {
      try {
        runGit(repo, ["worktree", "remove", "--force", worktree]);
      } catch {
        // setup失敗時のbest-effort cleanup。
      }
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

describe("hachi fanout integration-check E2E", () => {
  let fixture: IntegrationE2eFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("実Git/temp DBでJSON/text passし、host再検証表示とboard/Git mutation 0を保つ", { timeout: 120_000 }, async () => {
    fixture = setupIntegrationE2e("none");
    const beforeBoard = fixture.boardSnapshot();
    const beforeGit = fixture.gitSnapshot();

    await buildProgram(fixture.ctx.deps).parseAsync([...fixture.args, "--json"], { from: "user" });
    const json = JSON.parse(fixture.ctx.stdout.text()) as {
      ready: boolean;
      requestedAction: string;
      hostRecheckRequired: boolean;
      objectFormat: string;
    };
    expect(json).toMatchObject({
      ready: true,
      requestedAction: "host-ff-only-integration",
      hostRecheckRequired: true,
      objectFormat: "sha1",
    });
    fixture.ctx.stdout.clear();
    await buildProgram(fixture.ctx.deps).parseAsync(fixture.args, { from: "user" });
    expect(fixture.ctx.stdout.text()).toContain("host_recheck_required: true");
    expect(fixture.ctx.exitCodes).toEqual([]);
    expect(fixture.boardSnapshot()).toBe(beforeBoard);
    expect(fixture.gitSnapshot()).toBe(beforeGit);
  });

  it("ownership外から内へのrenameをD+A両pathで検出しmutation 0で拒否する", { timeout: 120_000 }, async () => {
    fixture = setupIntegrationE2e("outside-to-inside");
    const beforeBoard = fixture.boardSnapshot();
    const beforeGit = fixture.gitSnapshot();

    await buildProgram(fixture.ctx.deps).parseAsync([...fixture.args, "--json"], { from: "user" });

    expect(fixture.ctx.exitCodes).toEqual([1]);
    expect(fixture.ctx.stderr.text()).toContain("ownership外");
    expect(fixture.boardSnapshot()).toBe(beforeBoard);
    expect(fixture.gitSnapshot()).toBe(beforeGit);
  });

  it("ownership内から内へのrenameは両pathがownership内なので許可する", { timeout: 120_000 }, async () => {
    fixture = setupIntegrationE2e("inside-to-inside");

    await buildProgram(fixture.ctx.deps).parseAsync([...fixture.args, "--json"], { from: "user" });

    expect(fixture.ctx.exitCodes).toEqual([]);
    expect(JSON.parse(fixture.ctx.stdout.text())).toMatchObject({ ready: true, hostRecheckRequired: true });
  });

  it("handoff後の旧generationを実DBで拒否しboard/Gitを変更しない", { timeout: 120_000 }, async () => {
    fixture = setupIntegrationE2e("none");
    fixture.ctx.deps.store.prepareOrchestratorHandoff(
      fixture.sessionId,
      fixture.generation,
      "a".repeat(64),
      Math.floor(Date.now() / 1000) + 300,
    );
    const beforeBoard = fixture.boardSnapshot();
    const beforeGit = fixture.gitSnapshot();

    await buildProgram(fixture.ctx.deps).parseAsync([...fixture.args, "--json"], { from: "user" });

    expect(fixture.ctx.exitCodes).toEqual([1]);
    expect(fixture.ctx.stderr.text()).toContain("active fence");
    expect(fixture.boardSnapshot()).toBe(beforeBoard);
    expect(fixture.gitSnapshot()).toBe(beforeGit);
  });
});
