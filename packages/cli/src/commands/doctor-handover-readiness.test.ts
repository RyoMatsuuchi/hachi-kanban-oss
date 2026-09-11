import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorRow, OrchestratorSessionRow, TaskRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface HandoverReadinessFixture {
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
  mission: TaskRow;
}

interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

describe("hachi doctor handover preflight", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  function preparePreflightProbes(): void {
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.claudeTrustProbe = { isTrusted: () => true };
    ctx.deps.isDirectory = () => true;
  }

  function createHandoverReadinessFixture(label: string): HandoverReadinessFixture {
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label,
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: `claude-${label}`,
    });
    const mission = ctx.deps.store.createTask(
      {
        title: `${label} mission`,
        body: "cwd: /repo\n\nfixture",
        tenant: "dev",
        status: "ready",
      },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, orchestrator.id, "primary");
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "subtree",
      selector: mission.id,
      role: "primary",
    });
    return { orchestrator, session, mission };
  }

  function archiveTask(taskId: string): void {
    ctx.deps.store.transition({
      taskId,
      to: "blocked",
      reason: "needs-manual: handover readiness fixture",
      actor: "tester",
    });
    ctx.deps.store.transition({ taskId, to: "done", actor: "tester" });
    ctx.deps.store.transition({ taskId, to: "archived", actor: "tester" });
  }

  async function runDoctor(): Promise<{ checks: DoctorCheckResult[]; ok: boolean }> {
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });
    return JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
  }

  it("全 identity の handover preflight が green なら OK になり、identity は羅列しない", async () => {
    ctx = createTestDeps();
    preparePreflightProbes();
    const first = createHandoverReadinessFixture("green-first");
    const second = createHandoverReadinessFixture("green-second");

    const result = await runDoctor();

    const check = result.checks.find((candidate) => candidate.name === "handover preflight");
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain("2 identity");
    expect(check?.detail).toContain("preflight");
    expect(check?.detail).toContain("delivery は未検査");
    expect(check?.detail).not.toContain(first.orchestrator.id);
    expect(check?.detail).not.toContain(second.orchestrator.id);
    expect(check?.skipped).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("1件が mission-valid で落ちると NG になり、失敗 identity・検査名・理由だけを出す", async () => {
    ctx = createTestDeps();
    preparePreflightProbes();
    const green = createHandoverReadinessFixture("green");
    const archived = createHandoverReadinessFixture("archived");
    archiveTask(archived.mission.id);
    const sessionsBefore = ctx.deps.store.listOrchestratorSessions(archived.orchestrator.id);

    const result = await runDoctor();

    const check = result.checks.find((candidate) => candidate.name === "handover preflight");
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("対象=2 identity、NG=1 identity");
    expect(check?.detail).toContain(`identity=${archived.orchestrator.id}`);
    expect(check?.detail).toContain("check=mission-valid");
    expect(check?.detail).toContain(`ミッション task は archived です: ${archived.mission.id}`);
    expect(check?.detail).not.toContain(green.orchestrator.id);
    expect(check?.detail).toContain("delivery は未検査");
    expect(result.ok).toBe(false);
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.listOrchestratorSessions(archived.orchestrator.id)).toEqual(sessionsBefore);
  });

  it("live session が無い identity しか居なければ対象0件として OK にする", async () => {
    ctx = createTestDeps();
    preparePreflightProbes();
    const inactive = ctx.deps.store.registerOrchestrator({
      label: "inactive",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
    });

    const result = await runDoctor();

    const check = result.checks.find((candidate) => candidate.name === "handover preflight");
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain("対象0件");
    expect(check?.detail).toContain("live session を持つ identity なし");
    expect(check?.detail).not.toContain(inactive.id);
    expect(check?.skipped).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(ctx.exitCodes).toEqual([]);
  });
});
