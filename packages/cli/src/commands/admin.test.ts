import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActorProvenance,
  ModelResolution,
  ModelTransportCompatibilityDecision,
  TaskRow,
} from "@hachi/core";
import type { ModelTransportObservation } from "../model-transport-observability.js";
import type { LegacyImportReport } from "../legacy-import.js";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface ResolveTransportContextOutput {
  policyTransport: "direct" | "bridge" | null;
  probeTransport: "direct" | "bridge" | null;
  isLaunchEvidence: boolean;
  actualTransportSource: string;
}

/** 旧 DB 相当の最小 tasks テーブルを一時ファイルに構築する（CLI wiring テスト用） */
function createLegacyDbFile(tmpDir: string): string {
  const dbPath = join(tmpDir, "legacy.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      assignee TEXT,
      status TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      tenant TEXT,
      result TEXT
    );
  `);
  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at, tenant, result)
     VALUES ('t_cli1', 'CLI経由移行対象', '本文', 'alice', 'todo', 3, 1700000000, 'dev', NULL)`,
  ).run();
  db.close();
  return dbPath;
}

function executionActor(
  ctx: TestDeps,
  label: string,
  taskId?: string,
): { args: string[]; provenance: ActorProvenance } {
  const orchestrator = ctx.deps.store.registerOrchestrator({ label, project: "dev", repoCommonDir: "" });
  const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  if (taskId !== undefined) {
    ctx.deps.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
  }
  return {
    args: [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ],
    provenance: {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    },
  };
}

function executionActorArgs(ctx: TestDeps, label: string, taskId?: string): string[] {
  return executionActor(ctx, label, taskId).args;
}

describe("hachi admin", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("set-model: allowlist 内のモデルは設定され resolveModel が ok=true を返す", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-model", task.id, "gpt-5.6-sol", ...executionActorArgs(ctx, "set-model", task.id), "--json",
    ], {
      from: "user",
    });

    const result = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      task: TaskRow;
      resolution: ModelResolution;
    };
    expect(result).toMatchObject({ id: task.id, status: task.status });
    expect(result.task.modelOverride).toBe("gpt-5.6-sol");
    expect(result.resolution.ok).toBe(true);
    if (result.resolution.ok) {
      expect(result.resolution.provider).toBe("codex");
      expect(result.resolution.model).toBe("gpt-5.6-sol");
      expect(result.resolution.source).toBe("override");
      expect(result.resolution.transport).toBe("direct");
    }
  });

  it("set-model/set-effort は共通 principal flags を event へ伝搬する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "admin", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const flags = [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ];

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "set-model", task.id, "gpt-5.6-sol", ...flags],
      { from: "user" },
    );
    expect(ctx.deps.store.listEvents(task.id).at(-1)?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });

    await buildProgram(ctx.deps).parseAsync(["admin", "set-effort", task.id, "high", ...flags], { from: "user" });
    expect(ctx.deps.store.listEvents(task.id).at(-1)?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });
  });

  it.each([
    ["set-model", "gpt-5.6-sol"],
    ["set-effort", "high"],
  ])("%s互換aliasはstructured orchestrator principal無しを拒否する", async (command, value) => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", command, task.id, value], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--actor-kind orchestrator");
    expect(ctx.deps.store.getTask(task.id)).toMatchObject({ modelOverride: "", effortOverride: "" });
  });

  it("set-model互換aliasはprovider/model不整合を同じtransactionでrollbackする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "t", body: "b", tenant: "dev", provider: "claude" },
      "tester",
    );

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-model", task.id, "gpt-5.6-sol", ...executionActorArgs(ctx, "alias-rollback", task.id),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("model-not-allowlisted");
    expect(ctx.deps.store.getTask(task.id)?.modelOverride).toBe("");
    expect(ctx.deps.store.listEvents(task.id, "execution_overrides_changed")).toHaveLength(0);
  });

  it("set-model/set-effort help は service/unknown を actor-kind 選択肢に公開しない", async () => {
    ctx = createTestDeps();
    for (const command of ["set-model", "set-effort"]) {
      ctx.stdout.clear();
      await expect(buildProgram(ctx.deps).parseAsync(["admin", command, "--help"], { from: "user" }))
        .rejects.toMatchObject({ code: "commander.helpDisplayed" });
      expect(ctx.stdout.text()).toContain('(choices: "human", "orchestrator")');
      expect(ctx.stdout.text()).not.toContain("service");
      expect(ctx.stdout.text()).not.toContain("unknown");
    }
  });

  it("set-model --clear は model_override を空にする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const setup = executionActor(ctx, "clear-model-setup", task.id);
    ctx.deps.store.setModelOverride(task.id, "gpt-5.5", "tester", setup.provenance);

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-model", task.id, "--clear", ...setup.args, "--json",
    ], {
      from: "user",
    });

    expect(ctx.deps.store.getTask(task.id)?.modelOverride).toBe("");
  });

  it("set-effort: EffortLevel の値は設定され resolveModel が direct + effort を返す", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-effort", task.id, "high", ...executionActorArgs(ctx, "set-effort", task.id), "--json",
    ], {
      from: "user",
    });

    const result = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      task: TaskRow;
      resolution: ModelResolution;
    };
    expect(result).toMatchObject({ id: task.id, status: task.status });
    expect(result.task.effortOverride).toBe("high");
    expect(result.resolution.ok).toBe(true);
    if (result.resolution.ok) {
      expect(result.resolution.effort).toBe("high");
      expect(result.resolution.transport).toBe("direct");
    }
  });

  it("set-effort --clear は effort_override を空にする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const actorArgs = executionActorArgs(ctx, "clear-effort", task.id);
    await buildProgram(ctx.deps).parseAsync(["admin", "set-effort", task.id, "xhigh", ...actorArgs], { from: "user" });
    ctx.stdout.clear();

    await buildProgram(ctx.deps).parseAsync(["admin", "set-effort", task.id, "--clear", ...actorArgs, "--json"], {
      from: "user",
    });

    expect(ctx.deps.store.getTask(task.id)?.effortOverride).toBe("");
  });

  it("set-effort: 不正値は fail-closed でエラー終了する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", "set-effort", task.id, "ultra"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("low / medium / high / xhigh");
    expect(ctx.deps.store.getTask(task.id)?.effortOverride).toBe("");
  });

  it("set-execution はrole別overrideを一括保存しexact orchestrator provenanceを記録する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "execution", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "codex-source-session",
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const actorArgs = [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ];

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id,
      "--role", "reviewer",
      "--profile", "review",
      "--provider", "claude",
      "--model", "claude-opus-5",
      "--effort", "max",
      "--speed", "fast",
      ...actorArgs,
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const result = JSON.parse(ctx.stdout.text()) as { task: TaskRow; role: string; resolution: ModelResolution };
    expect(result.role).toBe("reviewer");
    expect(result.task).toMatchObject({
      reviewProfileOverride: "review",
      reviewProviderOverride: "claude",
      reviewModelOverride: "claude-opus-5",
      reviewEffortOverride: "max",
      reviewSpeedOverride: "fast",
    });
    expect(result.resolution).toMatchObject({
      ok: true,
      provider: "claude",
      model: "claude-opus-5",
      effort: "max",
      speed: "fast",
    });
    const event = ctx.deps.store.listEvents(task.id, "execution_overrides_changed").at(-1);
    expect(event?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });
    expect(JSON.parse(event?.payload ?? "{}") as Record<string, unknown>).toMatchObject({
      role: "reviewer",
      changes: {
        model: { field: "review_model_override", value: "claude-opus-5" },
        effort: { field: "review_effort_override", value: "max" },
        speed: { field: "review_speed_override", value: "fast" },
      },
    });
  });

  it("set-execution は解決不能なcompound patchを同じtransactionでrollbackする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "rollback", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id,
      "--role", "reviewer",
      "--provider", "claude",
      "--model", "gpt-5.6-sol",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("model-not-allowlisted");
    expect(ctx.deps.store.getTask(task.id)).toMatchObject({
      reviewProviderOverride: "",
      reviewModelOverride: "",
    });
    expect(ctx.deps.store.listEvents(task.id, "execution_overrides_changed")).toHaveLength(0);
  });

  it("set-execution はstructured orchestrator principal無しを拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "worker", "--speed", "fast",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--actor-kind orchestrator");
    expect(ctx.deps.store.getTask(task.id)?.speedOverride).toBe("");
  });

  it.each([
    ["set-execution", ["--role", "worker", "--speed", "fast"]],
    ["set-model", ["gpt-5.6-sol"]],
    ["set-effort", ["high"]],
  ])("%s はactive exact principalでも別primary ownerからの変更を拒否する", async (command, values) => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "owned", body: "b", tenant: "dev" }, "tester");
    const owner = ctx.deps.store.registerOrchestrator({ label: "owner", project: "dev", repoCommonDir: "" });
    ctx.deps.store.startOrchestratorSession({ orchestratorId: owner.id });
    ctx.deps.store.bindTaskToOrchestrator(task.id, owner.id, "primary");
    const challengerArgs = executionActorArgs(ctx, `challenger-${command}`);

    await buildProgram(ctx.deps).parseAsync(["admin", command, task.id, ...values, ...challengerArgs], {
      from: "user",
    });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("primary orchestrator authority");
    expect(ctx.deps.store.getTask(task.id)).toMatchObject({
      modelOverride: "",
      effortOverride: "",
      speedOverride: "",
    });
    expect(ctx.deps.store.listEvents(task.id, "execution_overrides_changed")).toHaveLength(0);
  });

  it("set-execution はactive primary project watch ownerを正規authorityとして受理する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "watched", body: "b", tenant: "watch-project" }, "tester");
    const actor = executionActor(ctx, "watch-owner");
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: actor.provenance.actorId,
      scope: "project",
      selector: "watch-project",
      role: "primary",
    });

    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "worker", "--speed", "fast", ...actor.args,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getTask(task.id)?.speedOverride).toBe("fast");
    expect(ctx.deps.store.listTaskOrchestratorBindings(task.id)).toHaveLength(0);
  });

  it("resolve --role all はworker/reviewerを独立して解決する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const actorArgs = executionActorArgs(ctx, "resolve-all", task.id);
    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "worker", "--speed", "fast", ...actorArgs,
    ], { from: "user" });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "reviewer",
      "--provider", "claude", "--model", "claude-opus-5", "--effort", "max", ...actorArgs,
    ], { from: "user" });
    ctx.stdout.clear();

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--role", "all", "--json"], {
      from: "user",
    });

    const result = JSON.parse(ctx.stdout.text()) as {
      role: string;
      executions: Record<"worker" | "reviewer", {
        resolution: ModelResolution;
        transportContext: ResolveTransportContextOutput;
      }>;
    };
    expect(result.role).toBe("all");
    expect(result.executions.worker.resolution).toMatchObject({ ok: true, speed: "fast" });
    expect(result.executions.reviewer.resolution).toMatchObject({
      ok: true,
      provider: "claude",
      model: "claude-opus-5",
      effort: "max",
    });
    for (const role of ["worker", "reviewer"] as const) {
      expect(result.executions[role].transportContext).toEqual({
        policyTransport: "direct",
        probeTransport: "direct",
        isLaunchEvidence: false,
        actualTransportSource: "run-meta-or-launched-event",
      });
    }
  });

  it("set-model: allowlist 候補外の値は fail-closed でエラー終了する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await expect(
      buildProgram(ctx.deps).parseAsync(["admin", "set-model", task.id, "gpt 5.4!"], { from: "user" }),
    ).rejects.toThrow(/Allowed choices/);

    expect(ctx.stderr.text()).toContain("gpt-5.6-sol");
    expect(ctx.deps.store.getTask(task.id)?.modelOverride).toBe("");
  });

  it("set-model の help は現 config の Codex 5.6 候補を列挙する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["admin", "set-model", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });

    expect(ctx.stdout.text()).toContain("gpt-5.6-sol");
    expect(ctx.stdout.text()).toContain("gpt-5.6-terra");
    expect(ctx.stdout.text()).toContain("gpt-5.6-luna");
  });

  it("set-model: model 未指定かつ --clear 無しはエラー", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", "set-model", task.id], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--clear");
  });

  it("resolve: allowlist 外の override は ok=false を表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const setup = executionActor(ctx, "invalid-model-setup", task.id);
    ctx.deps.store.setModelOverride(task.id, "not-allowlisted-model", "tester", setup.provenance);

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      task: TaskRow;
      resolution: ModelResolution;
      transportContext: ResolveTransportContextOutput;
    };
    expect(result).toMatchObject({ id: task.id, status: task.status, task: { id: task.id } });
    expect(result.resolution.ok).toBe(false);
    expect(result.transportContext).toEqual({
      policyTransport: null,
      probeTransport: null,
      isLaunchEvidence: false,
      actualTransportSource: "run-meta-or-launched-event",
    });
    if (!result.resolution.ok) {
      expect(result.resolution.reason).toBe("model-not-allowlisted");
    }
  });

  it("resolve: override の direct 強制をテキスト出力に表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const setup = executionActor(ctx, "direct-model-setup", task.id);
    ctx.deps.store.setModelOverride(task.id, "gpt-5.4", "tester", setup.provenance);

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id], { from: "user" });

    expect(ctx.stdout.text()).toContain("transport=direct (override 強制: model_override)");
  });

  it("resolve: effort_override の direct 強制と effort をテキスト出力に表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-effort", task.id, "xhigh", ...executionActorArgs(ctx, "resolve-effort", task.id),
    ], { from: "user" });
    ctx.stdout.clear();

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id], { from: "user" });

    expect(ctx.stdout.text()).toContain("effort=xhigh");
    expect(ctx.stdout.text()).toContain("transport=direct (override 強制: effort_override)");
  });

  it("resolve: 期待値・実runtime広告・supported判定をJSON表示する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.expectation).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      transport: "bridge",
    });
    expect(result.compatibility.observed?.runtime.name).toBe("codex-cli");
    expect(result.compatibility.decision).toEqual<ModelTransportCompatibilityDecision>({
      status: "supported",
      evidence: "advertised-model",
    });
  });

  it("resolve: probe失敗をunknownのまま表示しsecretをredactする", async () => {
    ctx = createTestDeps();
    ctx.deps.modelTransportProbe = async () => ({
      ok: false,
      detail: "Authorization: Bearer sk-1234567890 /Users/private/Application Support/runtime-token",
    });
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });

    const raw = ctx.stdout.text();
    const result = JSON.parse(raw) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.decision.status).toBe("unknown");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-1234567890");
    expect(raw).not.toContain("/Users/private/Application Support/runtime-token");
    expect(raw).not.toContain("Support/runtime-token");
  });

  it("resolve: bridge更新前後のruntime version境界をunsupportedからsupportedへ反映する", async () => {
    ctx = createTestDeps();
    ctx.deps.config.modelTransportPolicies = [{
      id: "codex-bridge-gpt-5.6-terra-test",
      provider: "codex",
      model: "gpt-5.6-terra",
      transport: "bridge",
      minimumRuntimeVersion: "0.144.1",
    }];
    let version = "0.143.9";
    ctx.deps.modelTransportProbe = async (provider, transport) => ({
      ok: true,
      snapshot: {
        schemaVersion: "execution-capability.v1",
        provider,
        transport,
        runtime: { name: "bridge-codex", version, source: "advertised" },
        capabilities: [],
        modelCatalog: { knowledge: "unknown", detail: "catalog is not advertised" },
        delivery: { model: "none", effort: "native" },
        observedAt: 1_700_000_000,
      },
    });
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });
    let result = JSON.parse(ctx.stdout.text()) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.decision).toMatchObject({ status: "unsupported", reason: "runtime-version-too-old" });

    version = "0.144.1";
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });
    result = JSON.parse(ctx.stdout.text()) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.decision).toMatchObject({ status: "supported", evidence: "runtime-version-policy" });
  });

  it("resolve: direct設定とbridge probeが異なっても実起動証拠として表示しない", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const setup = executionActor(ctx, "bridge-model-setup", task.id);
    ctx.deps.store.setModelOverride(task.id, "gpt-5.6-sol", "tester", setup.provenance);
    ctx.deps.modelTransportProbe = async (provider, transport) => ({
      ok: true,
      snapshot: {
        schemaVersion: "execution-capability.v1",
        provider,
        transport,
        runtime: { name: `codex-${transport}`, version: "0.144.1", source: "advertised" },
        capabilities: ["model-passthrough-v1", "effort-passthrough-v1"],
        modelCatalog: { knowledge: "known", models: ["gpt-5.6-sol"], source: "advertised" },
        delivery: { model: "native", effort: "native" },
        observedAt: 1_700_000_000,
      },
    });

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      resolution: ModelResolution;
      compatibility: ModelTransportObservation;
      transportContext: ResolveTransportContextOutput;
    };
    expect(result.resolution).toMatchObject({ ok: true, transport: "direct" });
    expect(result.compatibility.expectation.transport).toBe("bridge");
    expect(result.compatibility.observed?.transport).toBe("bridge");
    expect(result.compatibility.decision.status).toBe("supported");
    expect(result.transportContext).toEqual({
      policyTransport: "direct",
      probeTransport: "bridge",
      isLaunchEvidence: false,
      actualTransportSource: "run-meta-or-launched-event",
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id], { from: "user" });
    expect(ctx.stdout.text()).toContain("設定候補=direct probe対象=bridge");
    expect(ctx.stdout.text()).toContain("起動済み経路の証拠ではありません");
  });

  it("resolve: probe失敗時も対象経路と実起動証拠を区別する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    ctx.deps.modelTransportProbe = async () => ({ ok: false, detail: "offline fixture" });

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      compatibility: ModelTransportObservation;
      transportContext: ResolveTransportContextOutput;
    };
    expect(result.compatibility.decision.status).toBe("unknown");
    expect(result.compatibility.observed).toBeNull();
    expect(result.transportContext.probeTransport).toBe(result.compatibility.expectation.transport);
    expect(result.transportContext.isLaunchEvidence).toBe(false);
    expect(result.transportContext.actualTransportSource).toBe("run-meta-or-launched-event");
  });

  it("resolve: Claude worker overrideはbridge広告があっても実launchどおりdirectだけをprobeする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "claude direct", body: "b", tenant: "dev", provider: "claude" },
      "tester",
    );
    const actorArgs = executionActorArgs(ctx, "claude-direct-resolve", task.id);
    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "worker", "--model", "claude-opus-5", ...actorArgs,
    ], { from: "user" });
    ctx.stdout.clear();
    const originalProbe = ctx.deps.modelTransportProbe!;
    const calls: Array<{ provider: string; transport: string }> = [];
    ctx.deps.modelTransportProbe = async (provider, transport) => {
      calls.push({ provider, transport });
      return originalProbe(provider, transport);
    };

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--role", "worker", "--json"], {
      from: "user",
    });

    const result = JSON.parse(ctx.stdout.text()) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.expectation).toMatchObject({ provider: "claude", transport: "direct" });
    expect(calls).toEqual([{ provider: "claude", transport: "direct" }]);
  });

  it("resolve: reviewer overrideはCodexでもbridgeへ昇格せずconfigured directをprobeする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "reviewer direct", body: "b", tenant: "dev" }, "tester");
    const actorArgs = executionActorArgs(ctx, "reviewer-direct-resolve", task.id);
    await buildProgram(ctx.deps).parseAsync([
      "admin", "set-execution", task.id, "--role", "reviewer", "--model", "gpt-5.6-sol", ...actorArgs,
    ], { from: "user" });
    ctx.stdout.clear();
    const originalProbe = ctx.deps.modelTransportProbe!;
    const calls: Array<{ provider: string; transport: string }> = [];
    ctx.deps.modelTransportProbe = async (provider, transport) => {
      calls.push({ provider, transport });
      return originalProbe(provider, transport);
    };

    await buildProgram(ctx.deps).parseAsync(["admin", "resolve", task.id, "--role", "reviewer", "--json"], {
      from: "user",
    });

    const result = JSON.parse(ctx.stdout.text()) as { compatibility: ModelTransportObservation };
    expect(result.compatibility.expectation).toMatchObject({ provider: "codex", transport: "direct" });
    expect(calls).toEqual([{ provider: "codex", transport: "direct" }]);
  });

  describe("import-legacy", () => {
    let tmpDir: string;

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("dry-run（既定）では新ボードに書き込まず、対象一覧を JSON で表示する", async () => {
      ctx = createTestDeps();
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-cli-import-legacy-"));
      const dbPath = createLegacyDbFile(tmpDir);

      await buildProgram(ctx.deps).parseAsync(["admin", "import-legacy", "--db", dbPath, "--json"], {
        from: "user",
      });

      expect(ctx.exitCodes).toEqual([]);
      const result = JSON.parse(ctx.stdout.text()) as { report: LegacyImportReport };
      expect(result.report.apply).toBe(false);
      expect(result.report.items).toHaveLength(1);
      expect(result.report.items[0]?.legacy.legacyId).toBe("t_cli1");
      expect(result.report.items[0]?.targetStatus).toBe("todo");
      expect(ctx.deps.store.listRecent(100)).toHaveLength(0);
    });

    it("--apply で新ボードへ作成する", async () => {
      ctx = createTestDeps();
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-cli-import-legacy-"));
      const dbPath = createLegacyDbFile(tmpDir);

      await buildProgram(ctx.deps).parseAsync(["admin", "import-legacy", "--db", dbPath, "--apply", "--json"], {
        from: "user",
      });

      expect(ctx.exitCodes).toEqual([]);
      const result = JSON.parse(ctx.stdout.text()) as { report: LegacyImportReport };
      expect(result.report.applied).toHaveLength(1);
      const created = ctx.deps.store.getTask(result.report.applied[0]?.newTaskId as string);
      expect(created?.title).toBe("CLI経由移行対象");
      expect(created?.status).toBe("todo");
    });

    it("--task を複数指定すると commander が配列として集約する", async () => {
      ctx = createTestDeps();
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-cli-import-legacy-"));
      const dbPath = createLegacyDbFile(tmpDir);

      await buildProgram(ctx.deps).parseAsync(
        ["admin", "import-legacy", "--db", dbPath, "--task", "t_cli1", "--task", "t_not_exist", "--json"],
        { from: "user" },
      );

      const result = JSON.parse(ctx.stdout.text()) as { report: LegacyImportReport };
      expect(result.report.items).toHaveLength(1);
      expect(result.report.notFoundTaskIds).toEqual(["t_not_exist"]);
    });

    it("--status に done/archived を指定すると fail-closed でエラー終了する", async () => {
      ctx = createTestDeps();
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-cli-import-legacy-"));
      const dbPath = createLegacyDbFile(tmpDir);

      await buildProgram(ctx.deps).parseAsync(
        ["admin", "import-legacy", "--db", dbPath, "--status", "done"],
        { from: "user" },
      );

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("done/archived");
    });

    it("存在しない --db は fail-closed でエラー終了する", async () => {
      ctx = createTestDeps();
      tmpDir = mkdtempSync(join(tmpdir(), "hachi-cli-import-legacy-"));

      await buildProgram(ctx.deps).parseAsync(
        ["admin", "import-legacy", "--db", join(tmpDir, "not-exist.db")],
        { from: "user" },
      );

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("見つかりません");
    });
  });
});
