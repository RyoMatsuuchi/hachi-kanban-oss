import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import { createRuntimeResourceReadView, type ActorProvenance, type SessionRef } from "@hachi/core";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { resolveTransport, type DispatchBridgeCapabilities } from "./dispatch.js";

const MODEL_CAP = "model-passthrough-v1";
const EFFORT_CAP = "effort-passthrough-v1";
const MAX_TURNS_CAP = "max-turns-passthrough-v1";

function nativeDirectRef(sessionId: string): SessionRef {
  return {
    provider: "codex",
    sessionId,
    serverUrl: "direct",
    model: "gpt-5.4",
    modelDelivery: "native",
    startedAt: 1_800_000_000,
  };
}

function fakeDirect(sessionId = "direct-1"): FakeAdapter {
  const adapter = new FakeAdapter("codex");
  adapter.launchResponse = nativeDirectRef(sessionId);
  return adapter;
}

function runMeta(meta: string): Record<string, unknown> {
  return JSON.parse(meta) as Record<string, unknown>;
}

describe("resolveTransport", () => {
  const resolution = {
    ok: true,
    provider: "codex",
    model: "gpt-5.4",
    source: "override",
    transport: "direct",
    effort: "low",
  } as const;

  it("model override の capability があれば bridge へ昇格する", () => {
    const capabilities: DispatchBridgeCapabilities = { status: "known", capabilities: [MODEL_CAP] };
    expect(resolveTransport(resolution, capabilities, { model: true, effort: false })).toMatchObject({
      transport: "bridge",
      reason: "passthrough-promoted",
      passthrough: { model: true },
    });
  });

  it("effort override の capability があれば bridge へ昇格する", () => {
    const capabilities: DispatchBridgeCapabilities = { status: "known", capabilities: [EFFORT_CAP] };
    expect(resolveTransport(resolution, capabilities, { model: false, effort: true })).toMatchObject({
      transport: "bridge",
      reason: "passthrough-promoted",
      passthrough: { effort: true },
    });
  });

  it("model/effort 両方の override は両 capability が揃う場合だけ bridge へ昇格する", () => {
    const partial: DispatchBridgeCapabilities = { status: "known", capabilities: [MODEL_CAP] };
    const full: DispatchBridgeCapabilities = { status: "known", capabilities: [MODEL_CAP, EFFORT_CAP] };
    expect(resolveTransport(resolution, partial, { model: true, effort: true }).transport).toBe("direct");
    expect(resolveTransport(resolution, full, { model: true, effort: true })).toMatchObject({
      transport: "bridge",
      passthrough: { model: true, effort: true },
    });
  });

  it("capability 不明は direct のままにする", () => {
    const capabilities: DispatchBridgeCapabilities = { status: "unknown", detail: "http:404" };
    expect(resolveTransport(resolution, capabilities, { model: true, effort: false })).toMatchObject({
      transport: "direct",
      reason: "passthrough-unknown",
    });
  });

  it("maxTurns を要求する claude bridge は capability 非広告なら direct を選ぶ", () => {
    const claudeResolution = {
      ok: true,
      provider: "claude",
      model: "claude-opus-4-6",
      source: "default",
      transport: "bridge",
    } as const;

    expect(resolveTransport(
      claudeResolution,
      { status: "known", capabilities: [] },
      { model: false, effort: false, maxTurns: true },
    )).toMatchObject({ transport: "direct", reason: "passthrough-unavailable" });
    expect(resolveTransport(
      claudeResolution,
      { status: "known", capabilities: [MAX_TURNS_CAP] },
      { model: false, effort: false, maxTurns: true },
    )).toMatchObject({ transport: "bridge", reason: "configured" });
  });
});

describe("dispatch bridge passthrough fallback table", () => {
  let harness: TestHarness;
  let cwdDir: string;

  beforeEach(async () => {
    harness = await setupHarness();
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function activeOrchestratorProvenance(taskId: string): ActorProvenance {
    const orchestrator = harness.store.registerOrchestrator({
      label: "bridge-passthrough-override",
      project: "hachi-kanban",
      repoCommonDir: cwdDir,
    });
    harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const session = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    return {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
  }

  function readyOverrideTask(overrides: { model?: boolean; effort?: boolean } = { model: true }): string {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "bridge passthrough", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const provenance = activeOrchestratorProvenance(task.id);
    if (overrides.model === true) {
      harness.store.setModelOverride(task.id, "gpt-5.4", "tester", provenance);
    }
    if (overrides.effort === true) {
      harness.store.setEffortOverride(task.id, "low", "tester", provenance);
    }
    return task.id;
  }

  function activatePreviewLease(taskId: string): { leaseId: string; fence: number } {
    const existingPrimary = harness.store.listTaskOrchestratorBindings(taskId)
      .find((binding) => binding.role === "primary");
    const orchestrator = existingPrimary === undefined
      ? harness.store.registerOrchestrator({
          label: `passthrough-owner-${taskId}`,
          project: "hachi-kanban",
          repoCommonDir: cwdDir,
        })
      : harness.store.getOrchestrator(existingPrimary.orchestratorId)!;
    if (existingPrimary === undefined) {
      harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    }
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${taskId}:preview`,
    });
    const reserved = harness.store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "test",
      project: "hachi-kanban",
      repoCommonDir: cwdDir,
      worktree: cwdDir,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: 1_800_000_600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "test",
    });
    const provisioning = harness.store.claimRuntimeResourceLease(reserved.id, reserved.fence, "test");
    harness.store.addRuntimeResourceMember({
      leaseId: reserved.id,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: `preview:${taskId}`,
      nativeId: `preview-${taskId}`,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: 1_800_000_000,
      actor: "test",
    });
    const active = harness.store.transitionRuntimeResourceLease({
      leaseId: reserved.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "test",
    });
    return { leaseId: active.id, fence: active.fence };
  }

  it("capability なしは POST せず direct を起動する", async () => {
    const direct = fakeDirect("direct-no-cap");
    harness.deps.directAdapters = { codex: direct };
    const taskId = readyOverrideTask({ model: true });

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.actions).toBe(1);
    expect(direct.launchCalls).toHaveLength(1);
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt" && r.method === "POST")).toBe(false);
    const run = harness.store.getLatestOpenRun(taskId);
    expect(runMeta(run!.meta).transport).toBe("direct");
  });

  it("claude maxTurns capability なしは POST せず applied 無しの direct run を bind する", async () => {
    harness.deps.config = {
      ...harness.deps.config,
      profiles: {
        ...harness.deps.config.profiles,
        "claude-bridge": { provider: "claude", model: "claude-opus-4-6", transport: "bridge" },
      },
    };
    harness.claudeBridge.setCapabilities([]);
    const direct = new FakeAdapter("claude");
    direct.launchResponse = {
      provider: "claude",
      sessionId: "claude-direct-no-max-cap",
      serverUrl: "direct",
      model: "claude-opus-4-6",
      modelDelivery: "native",
      startedAt: 1_800_000_000,
    };
    harness.deps.directAdapters = { claude: direct };
    const task = harness.store.createTask(
      taskInput({
        status: "ready",
        profile: "claude-bridge",
        title: "claude maxTurns capability なし",
        body: `cwd: ${cwdDir}`,
      }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(direct.launchCalls).toHaveLength(1);
    expect(harness.claudeBridge.requests.some(
      (request) => request.path === "/api/prompt" && request.method === "POST",
    )).toBe(false);
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    expect(runMeta(run!.meta)).toMatchObject({ transport: "direct", modelDelivery: "native" });
    expect(runMeta(run!.meta)).not.toHaveProperty("appliedModel");
    expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(0);
  });

  it("409 sessionCreated:false は同一 claim 内で direct へフォールバックする", async () => {
    harness.codexBridge.setCapabilities([MODEL_CAP]);
    harness.codexBridge.setPassthroughMode("reject");
    const direct = fakeDirect("direct-rejected");
    harness.deps.directAdapters = { codex: direct };
    const taskId = readyOverrideTask({ model: true });

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.actions).toBe(1);
    expect(harness.codexBridge.sessions()).toEqual([]);
    expect(direct.launchCalls).toHaveLength(1);
    expect(direct.launchCalls[0]!.options.promptText).toContain("質問して終了してください");
    expect(direct.launchCalls[0]!.options.promptText).not.toContain("このセッションへ回答が注入されます");
    const promptFiles = readdirSync(join(harness.home.env.artifactsDir, taskId)).filter((name) =>
      name.startsWith("prompt-"),
    );
    expect(promptFiles).toHaveLength(1);
    const savedPrompt = readFileSync(join(harness.home.env.artifactsDir, taskId, promptFiles[0]!), "utf8");
    expect(savedPrompt).toContain("質問して終了してください");
    expect(savedPrompt).not.toContain("このセッションへ回答が注入されます");
    const run = harness.store.getLatestOpenRun(taskId);
    expect(run?.sessionId).toBe("direct-rejected");
    expect(runMeta(run!.meta).transport).toBe("direct");
  });

  it("fallback artifact 保存後に controller ownership が変わった場合は direct launch しない", async () => {
    harness.codexBridge.setCapabilities([MODEL_CAP]);
    harness.codexBridge.setPassthroughMode("reject");
    const direct = fakeDirect("direct-must-not-launch");
    harness.deps.directAdapters = { codex: direct };
    const taskId = readyOverrideTask({ model: true });
    const lease = activatePreviewLease(taskId);
    const getTask = harness.store.getTask.bind(harness.store);
    let ownershipChanged = false;
    harness.store.getTask = (id: string) => {
      if (id === taskId && !ownershipChanged) {
        const artifactDir = join(harness.home.env.artifactsDir, taskId);
        const directPromptSaved = existsSync(artifactDir) && readdirSync(artifactDir)
          .filter((name) => name.startsWith("prompt-"))
          .some((name) => readFileSync(join(artifactDir, name), "utf8").includes("質問して終了してください"));
        if (directPromptSaved) {
          const competing = harness.store.registerOrchestrator({
            label: `passthrough-competing-${taskId}`,
            project: "hachi-kanban",
            repoCommonDir: cwdDir,
          });
          harness.store.bindTaskToOrchestrator(taskId, competing.id, "primary");
          ownershipChanged = true;
        }
      }
      return getTask(id);
    };

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.notes?.join(" ")).toContain("direct fallback launch 直前");
    expect(direct.launchCalls).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(taskId)).toBeNull();
    expect(readdirSync(join(harness.home.env.artifactsDir, taskId)).some((name) => name.startsWith("prompt-"))).toBe(true);
    expect(harness.store.getTask(taskId)).toMatchObject({ status: "blocked", claimLock: "" });
    expect(harness.store.getTask(taskId)?.blockReason).toContain("needs-manual:");
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)).toMatchObject({
      state: "cleanup_pending",
      fence: lease.fence + 1,
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.leaseId)).toHaveLength(1);
    view.close();

    const nextTick = await dispatchStage.tick(harness.deps, true, 1_800_000_001);
    expect(nextTick.actions).toBe(0);
    expect(direct.launchCalls).toHaveLength(0);
    expect(harness.store.getTask(taskId)?.claimLock).toBe("");
  });

  it("override が無い profile 由来の model でも native delivery を欠けば bind せず停止する", async () => {
    // profile 由来の model も native 配送を要求する（2026-08-21〜）。以前は task override が
    // あるときだけ検査していたため、runtime が黙って既定モデルへ落としても素通りしていた。
    // 実際に bridge で起き、profile で sonnet-5 を選んだつもりのタスクが opus-4-6 で走っていた。
    // effort を持たない bridge profile を使う。effort があると effort 側の検査でも止まってしまい、
    // model 検査の有無で結果が変わらなくなる（判別できないテストになる）。
    harness.deps.config = {
      ...harness.deps.config,
      profiles: {
        ...harness.deps.config.profiles,
        "bridge-no-override": { provider: "codex", model: "gpt-5.4", transport: "bridge" },
      },
    };
    harness.codexBridge.setCapabilities([MODEL_CAP]);
    harness.codexBridge.setPassthroughMode("legacy");
    harness.deps.directAdapters = { codex: fakeDirect("direct-unused") };
    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "bridge-no-override", title: "profile model 欠落", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    expect(task.modelOverride).toBe("");
    expect(task.effortOverride).toBe("");

    await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
    expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(1);
  });

  it("その他 non-2xx は direct fallback せず launch_failed 経路に入る", async () => {
    harness.codexBridge.setCapabilities([MODEL_CAP]);
    harness.codexBridge.setPassthroughMode("native");
    harness.codexBridge.failNextPrompt(500);
    harness.deps.directAdapters = { codex: fakeDirect("direct-unused") };
    const taskId = readyOverrideTask({ model: true });

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(taskId)?.blockReason.startsWith("auto-launch-failed:")).toBe(true);
    expect(harness.store.listEvents(taskId, "launch_failed")).toHaveLength(1);
    expect(harness.store.getLatestOpenRun(taskId)).toBeNull();
  });

  it("202 だが native 確認欠落なら run へbindせず needs-manual に落とし中断注入する", async () => {
    harness.codexBridge.setCapabilities([MODEL_CAP]);
    harness.codexBridge.setPassthroughMode("legacy");
    harness.deps.directAdapters = { codex: fakeDirect("direct-unused") };
    const taskId = readyOverrideTask({ model: true });

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.actions).toBe(1);
    const task = harness.store.getTask(taskId);
    expect(task?.status).toBe("blocked");
    expect(task?.blockReason).toBe("needs-manual: bridge native 確認欠落");
    expect(task?.assignee).toBe("human");
    expect(harness.store.getLatestOpenRun(taskId)).toBeNull();
    const missingEvents = harness.store.listEvents(taskId, "bridge_native_missing");
    expect(missingEvents).toHaveLength(1);
    const missing = JSON.parse(missingEvents[0]!.payload) as { sessionId: string; modelDelivery: string };
    expect(missing).toMatchObject({ modelDelivery: "none" });
    expect(harness.store.listEvents(taskId, "bridge_native_missing_interrupt")).toHaveLength(1);
    const promptPosts = harness.codexBridge.requests.filter((r) => r.path === "/api/prompt" && r.method === "POST");
    expect(promptPosts).toHaveLength(2);
    expect(promptPosts[1]?.body).toMatchObject({ sessionId: missing.sessionId });
  });

  it("claude allowlist 外モデル相当の appliedModel:null は確認欠落となり direct fallback しない", async () => {
    harness.deps.config = {
      ...harness.deps.config,
      profiles: {
        ...harness.deps.config.profiles,
        "claude-bridge": { provider: "claude", model: "claude-opus-4-6", transport: "bridge" },
      },
    };
    harness.claudeBridge.setPassthroughMode("native");
    harness.claudeBridge.setAppliedResponse("model", { kind: "null" });
    const direct = new FakeAdapter("claude");
    harness.deps.directAdapters = { claude: direct };
    const task = harness.store.createTask(
      taskInput({
        status: "ready",
        profile: "claude-bridge",
        title: "claude allowlist 外モデル応答",
        body: `cwd: ${cwdDir}`,
      }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(direct.launchCalls).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      assignee: "human",
      blockReason: "needs-manual: bridge native 確認欠落",
    });
    expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(1);
    expect(harness.claudeBridge.requests.filter(
      (request) => request.path === "/api/prompt" && request.method === "POST",
    )).toHaveLength(2);
  });

  it("202 + native 確認ありなら bridge のまま run meta に native delivery を記録する", async () => {
    harness.codexBridge.setCapabilities([MODEL_CAP, EFFORT_CAP]);
    harness.codexBridge.setPassthroughMode("native");
    const taskId = readyOverrideTask({ model: true, effort: true });

    const result = await dispatchStage.tick(harness.deps, true, 1_800_000_000);

    expect(result.actions).toBe(1);
    const run = harness.store.getLatestOpenRun(taskId);
    expect(run).not.toBeNull();
    expect(runMeta(run!.meta)).toMatchObject({
      transport: "bridge",
      modelDelivery: "native",
      effortDelivery: "native",
      appliedModel: "gpt-5.4",
      appliedEffort: "low",
    });
    const task = harness.store.getTask(taskId);
    expect(task?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    const promptRequest = harness.codexBridge.requests.find((r) => r.path === "/api/prompt" && r.method === "POST");
    expect(promptRequest?.body).toMatchObject({ model: "gpt-5.4", effort: "low" });
  });
});
