import { homedir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFanoutPlan,
  hashFanoutParentBody,
  normalizeFanoutParentBody,
  type FanoutPlanInput,
} from "./fanout-plan.js";

function inputFixture(): FanoutPlanInput {
  const base = `${homedir()}/.hachi-kanban/worktrees`;
  return {
    version: "fanout-plan-input.v1",
    parentTaskId: "t_abc123",
    parentSnapshot: {
      taskId: "t_abc123",
      updatedAt: 123,
      bodyHash: "a".repeat(64),
    },
    repoCommonDir: "/repo/.git",
    scopeRoots: ["packages/cli/src/fanout.ts", "packages/core/src/b.ts", "packages/core/src/a.ts"],
    children: [
      {
        key: "core-a",
        title: "Core A",
        body: "Aを実装する",
        tenant: "dev",
        profile: "implement",
        worktree: `${base}/fanout-core-a`,
        ownership: ["packages/core/src/a.ts"],
        dependsOn: [],
      },
      {
        key: "core-b",
        title: "Core B",
        body: "Bを実装する",
        tenant: "dev",
        profile: "implement",
        worktree: `${base}/fanout-core-b`,
        ownership: ["packages/core/src/b.ts"],
        dependsOn: ["core-a"],
      },
      {
        key: "cli",
        title: "CLI",
        body: "CLIを実装する",
        tenant: "dev",
        profile: "implement",
        worktree: `${base}/fanout-cli`,
        ownership: ["packages/cli/src/fanout.ts"],
        dependsOn: ["core-b", "core-a"],
      },
    ],
    integrationGate: { requiredChildren: ["cli", "core-b", "core-a"] },
  };
}

describe("createFanoutPlan", () => {
  it("意味が同じ入力は配列順によらず同じcanonical JSONとplanHashになる", () => {
    const firstInput = inputFixture();
    const secondInput = inputFixture();
    firstInput.parentSnapshot.bodyHash = hashFanoutParentBody("cwd: /repo\r\n\r\n親scope\r\n");
    secondInput.parentSnapshot.bodyHash = hashFanoutParentBody("cwd: /repo\n\n親scope\n\n");
    secondInput.scopeRoots.reverse();
    secondInput.children.reverse();
    const cli = secondInput.children.find((child) => child.key === "cli");
    cli?.dependsOn.reverse();
    secondInput.integrationGate.requiredChildren.reverse();

    const first = createFanoutPlan(firstInput);
    const second = createFanoutPlan(secondInput);

    expect(second.canonicalJson).toBe(first.canonicalJson);
    expect(second.planHash).toBe(first.planHash);
    expect(first.plan.children.map((child) => child.key)).toEqual(["cli", "core-a", "core-b"]);
    expect(first.plan.planHash).toBe(first.planHash);
  });

  it("親bodyはCRLF/LFと末尾改行差を正規化してhashする", () => {
    expect(normalizeFanoutParentBody("a\r\n\r\n")).toBe("a\n");
    expect(hashFanoutParentBody("a\r\n")).toBe(hashFanoutParentBody("a\n\n"));
  });

  it("未知fieldをfail-closedで拒否する", () => {
    let message = "";
    try {
      createFanoutPlan({ ...inputFixture(), unknown: "secret-value" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("入力schemaが不正です");
    expect(message).not.toContain("secret-value");
  });

  it("childのsecret-like値を置換・反射せず汎用エラーで拒否する", () => {
    const secret = "sk-abcdefghijklmnop";
    const input = inputFixture();
    input.children[0]!.body = `API key ${secret} を使う`;
    let message = "";
    try {
      createFanoutPlan(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("secret-like value is not allowed");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("[REDACTED]");
  });

  it("child数が2件または7件なら拒否する", () => {
    const two = inputFixture();
    two.children = two.children.slice(0, 2);
    two.integrationGate.requiredChildren = ["core-a", "core-b"];
    expect(() => createFanoutPlan(two)).toThrow("入力schemaが不正です");

    const seven = inputFixture();
    for (const key of ["d", "e", "f", "g"]) {
      seven.scopeRoots.push(`packages/extra/${key}.ts`);
      seven.children.push({
        key,
        title: key,
        body: `${key}を実装する`,
        tenant: "dev",
        profile: "implement",
        worktree: `${homedir()}/.hachi-kanban/worktrees/fanout-${key}`,
        ownership: [`packages/extra/${key}.ts`],
        dependsOn: [],
      });
      seven.integrationGate.requiredChildren.push(key);
    }
    expect(() => createFanoutPlan(seven)).toThrow("入力schemaが不正です");
  });

  it("別childの祖先・子孫ownership重複を拒否する", () => {
    const input = inputFixture();
    input.scopeRoots = ["packages/core", "packages/cli/src/fanout.ts"];
    input.children[0]!.ownership = ["packages/core"];
    input.children[1]!.ownership = ["packages/core/src/b.ts"];
    expect(() => createFanoutPlan(input)).toThrow("別child間のownershipが重複");
  });

  it("scopeの未被覆とscope外ownershipを拒否する", () => {
    const uncovered = inputFixture();
    uncovered.scopeRoots.push("packages/web/src/page.ts");
    expect(() => createFanoutPlan(uncovered)).toThrow("exactly one child");

    const outside = inputFixture();
    outside.children[0]!.ownership.push("README.md");
    expect(() => createFanoutPlan(outside)).toThrow("scopeRoots外");
  });

  it("absolute・glob・escape・dot ownershipを拒否する", () => {
    for (const ownership of ["/absolute/path", "packages/**/*.ts", "../escape", ".", ".."]) {
      const input = inputFixture();
      input.children[0]!.ownership = [ownership];
      expect(() => createFanoutPlan(input)).toThrow("ownership path");
    }
  });

  it("未知依存・重複依存・循環を拒否する", () => {
    const unknown = inputFixture();
    unknown.children[0]!.dependsOn = ["missing"];
    expect(() => createFanoutPlan(unknown)).toThrow("未知childまたは自己参照");

    const duplicate = inputFixture();
    duplicate.children[1]!.dependsOn = ["core-a", "core-a"];
    expect(() => createFanoutPlan(duplicate)).toThrow("dependsOnに重複");

    const self = inputFixture();
    self.children[0]!.dependsOn = ["core-a"];
    expect(() => createFanoutPlan(self)).toThrow("未知childまたは自己参照");

    const cycle = inputFixture();
    cycle.children[0]!.dependsOn = ["cli"];
    expect(() => createFanoutPlan(cycle)).toThrow("循環");
  });

  it("integration gateの欠落・重複とworker向けmerge命令を拒否する", () => {
    const missing = inputFixture();
    missing.integrationGate.requiredChildren = ["core-a", "core-b", "core-b"];
    expect(() => createFanoutPlan(missing)).toThrow("requiredChildrenに重複");

    const merge = inputFixture();
    merge.children[0]!.body = "git merge main を実行する";
    expect(() => createFanoutPlan(merge)).toThrow("merge/main操作");
  });

  it.each([
    "git pull origin main",
    "git push origin HEAD:main",
    "git cherry-pick abc123",
    "git merge feature",
    "git rebase main",
    "git reset --hard HEAD",
    "git checkout main",
    "git checkout -- main",
    "git checkout -b repair main",
    "git switch master",
    "git switch -c repair master",
    "git --no-pager pull origin main",
    "git -C /repo push origin main",
    "git -c advice.detachedHead=false checkout master",
    "/usr/bin/git push origin main",
    "/opt/tools/git.exe cherry-pick abc123",
    "env /usr/bin/git pull origin main",
    "env -i PATH=/usr/bin /usr/bin/git --no-pager reset --hard HEAD",
    "sh -c 'git pull origin main'",
    'bash -lc "git push origin HEAD:main"',
    "eval 'git cherry-pick abc123'",
    "env sh -c '/usr/bin/git merge feature'",
  ])("worker specの禁止Git操作を構造的に拒否する: %s", (instruction) => {
    const input = inputFixture();
    input.children[0]!.body = instruction;
    expect(() => createFanoutPlan(input)).toThrow("merge/main操作");
  });

  it("worktreeの重複・範囲外と非canonical repo pathを拒否する", () => {
    const duplicate = inputFixture();
    duplicate.children[1]!.worktree = duplicate.children[0]!.worktree;
    expect(() => createFanoutPlan(duplicate)).toThrow("相互に一意");

    const outside = inputFixture();
    outside.children[0]!.worktree = "/tmp/fanout";
    expect(() => createFanoutPlan(outside)).toThrow("worktrees配下");

    const tmpImitation = inputFixture();
    tmpImitation.children[0]!.worktree = "/tmp/.hachi-kanban/worktrees/fanout";
    expect(() => createFanoutPlan(tmpImitation)).toThrow("worktrees配下");

    const anotherHome = inputFixture();
    anotherHome.children[0]!.worktree = `${dirname(homedir())}/another-user/.hachi-kanban/worktrees/fanout`;
    expect(() => createFanoutPlan(anotherHome)).toThrow("worktrees配下");

    const rootItself = inputFixture();
    rootItself.children[0]!.worktree = `${homedir()}/.hachi-kanban/worktrees`;
    expect(() => createFanoutPlan(rootItself)).toThrow("worktrees配下");

    const nonCanonical = inputFixture();
    nonCanonical.repoCommonDir = "/repo/../repo/.git";
    expect(() => createFanoutPlan(nonCanonical)).toThrow("canonical path");
  });

  it("child bodyの意味差は別planHashになる", () => {
    const first = createFanoutPlan(inputFixture());
    const changed = inputFixture();
    changed.children[0]!.body = "別の意味を持つ実装指示";
    const second = createFanoutPlan(changed);
    expect(second.planHash).not.toBe(first.planHash);
  });

  it("成功planは入力の意味文字列を保持する", () => {
    const result = createFanoutPlan(inputFixture());
    expect(result.canonicalJson).toContain("Aを実装する");
    expect(result.canonicalJson).not.toContain("sk-abcdefghijklmnop");
  });

  it("絶対pathのNULを入力値へ反射せず拒否する", () => {
    const input = inputFixture();
    input.repoCommonDir = "/repo/\0secret-path";
    let message = "";
    try {
      createFanoutPlan(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("canonical path");
    expect(message).not.toContain("secret-path");
  });
});
