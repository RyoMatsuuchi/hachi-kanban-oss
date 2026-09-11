import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError, type BridgeLaunchSessionRef } from "@hachi/adapters";
import { taskInput } from "@hachi/testing";
import {
  EXTERNAL_RUNTIME_GENERATION_SCHEMA,
  EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
  EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  createRuntimeProjectHostAdapterSnapshot,
  loadConfig,
  parseExternalRuntimeGenerationStatus,
  runtimeResourcesSchema,
  type ActorProvenance,
  type ExecutionCapabilitySnapshot,
  type HachiConfig,
  type Provider,
  type RuntimeResourcesConfig,
  type StageDeps,
  type TaskRow,
  type Transport,
  type ExternalRuntimeGenerationAttestationV1,
} from "@hachi/core";
import type { ExternalRuntimeGenerationReader } from "../external-runtime-generation-reader.js";
import {
  HANDOFF_GIT_LAUNCH_META_KEY,
  type HandoffGitEvidenceProbe,
} from "../handoff-git-evidence.js";
import { DEFAULT_TEST_CONFIG, FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import type { LaunchSessionProbe } from "./launch-outcome.js";

interface StageDepsWithConfigReloader extends StageDeps {
  reloadConfig: () => HachiConfig;
}

interface StageDepsWithCompatibilityProbe extends StageDeps {
  modelTransportPreflight: {
    probe(provider: Provider, transport: Transport): Promise<
      | { ok: true; snapshot: ExecutionCapabilitySnapshot }
      | { ok: false; detail: string }
    >;
  };
}

interface StageDepsWithHandoffGitEvidenceProbe extends StageDeps {
  handoffGitEvidenceProbe: HandoffGitEvidenceProbe;
}

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

interface StageDepsWithLaunchSessionProbe extends StageDeps {
  launchSessionProbe?: LaunchSessionProbe;
}

function externalGenerationFixture(model: string): {
  attestation: ExternalRuntimeGenerationAttestationV1;
  sample: ReturnType<typeof parseExternalRuntimeGenerationStatus>;
} {
  const observedAt = Date.now() - 1_000;
  const identity = {
    kind: "external-shared-runtime" as const,
    generationId: "1".repeat(32),
    runtimeModelId: model,
    modelReadbackSource: "codex-applied-model" as const,
    writerPid: 101,
    writerProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    runtimePid: 202,
    runtimeProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    bootNonce: "2".repeat(32),
    endpointIdentityHash: `sha256:${"3".repeat(64)}`,
    startedAt: observedAt - 10_000,
  };
  const attestation: ExternalRuntimeGenerationAttestationV1 = {
    version: 1,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    statusRevision: 1,
    state: "running",
    identity,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  const status = {
    schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
    schemaVersion: 1 as const,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex" as const,
    lane: "even-shared" as const,
    runtimeKey: "external-shared-runtime/codex/even-shared",
    revision: 1,
    state: "running" as const,
    attestations: [attestation],
    transitions: [{
      version: 1 as const,
      revision: 1,
      kind: "running" as const,
      oldIdentity: null,
      newIdentity: identity,
      lastSeenAt: null,
      stoppedAt: null,
      replacementFirstSeenAt: null,
      observedAt,
      ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      source: "endpoint-observer" as const,
    }],
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  return { attestation, sample: parseExternalRuntimeGenerationStatus(JSON.stringify(status), "codex") };
}

function activeOrchestratorProvenance(
  harness: TestHarness,
  cwdDir: string,
  taskId: string,
  label: string,
): ActorProvenance {
  const orchestrator = harness.store.registerOrchestrator({
    label,
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

describe("dispatchStage", () => {
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

  function writeConfig(config: HachiConfig): void {
    writeFileSync(join(harness.home.home, "config.json"), JSON.stringify(config), "utf8");
  }

  function configWithImplementProfile(profile: HachiConfig["profiles"][string]): HachiConfig {
    return {
      ...DEFAULT_TEST_CONFIG,
      profiles: {
        ...DEFAULT_TEST_CONFIG.profiles,
        implement: profile,
      },
      allowlist: {
        codex: [...DEFAULT_TEST_CONFIG.allowlist.codex],
        claude: [...DEFAULT_TEST_CONFIG.allowlist.claude],
      },
      resourceGuard: { ...DEFAULT_TEST_CONFIG.resourceGuard },
    };
  }

  function enableConfigReload(): void {
    (harness.deps as StageDepsWithConfigReloader).reloadConfig = () => loadConfig(harness.deps.env);
  }

  function setCompatibilityProbe(
    probe: StageDepsWithCompatibilityProbe["modelTransportPreflight"]["probe"],
  ): void {
    (harness.deps as StageDepsWithCompatibilityProbe).modelTransportPreflight = { probe };
  }

  function capabilitySnapshot(
    provider: Provider,
    transport: Transport,
    models: readonly string[],
    knowledge: "known" | "unknown" = "known",
  ): ExecutionCapabilitySnapshot {
    return {
      schemaVersion: "execution-capability.v1",
      provider,
      transport,
      runtime: { name: `${provider}-dispatch-test`, version: "1.0.0", source: "advertised" },
      capabilities: [],
      modelCatalog: knowledge === "known"
        ? { knowledge: "known", models, source: "advertised" }
        : { knowledge: "unknown", detail: "catalog is not advertised" },
      delivery: { model: "native", effort: "native" },
      observedAt: Date.now(),
    };
  }

  function activateRuntimeLease(
    taskId: string,
    expiresInSeconds = 600,
    runtimeProfileId?: string,
  ): { leaseId: string; fence: number; runtimeResources?: RuntimeResourcesConfig } {
    if (runtimeProfileId !== undefined) {
      execFileSync("git", ["init", "--quiet", cwdDir], { stdio: "ignore" });
    }
    const canonicalWorktree = realpathSync.native(cwdDir);
    const repoCommonDir = runtimeProfileId === undefined
      ? canonicalWorktree
      : realpathSync.native(join(cwdDir, ".git"));
    const runtimeResources = runtimeProfileId === undefined
      ? undefined
      : runtimeResourcesSchema.parse({
          mode: "enforce",
          provisioningEnabled: true,
          leaseTtlSeconds: 300,
          rolloutGeneration: 1,
          dockerContext: "dispatch-profile-context",
          worktreePostgres: {
            image: "postgres:test",
            containerPort: 5432,
            healthCheck: { command: ["pg_isready"], intervalMs: 1_000, timeoutMs: 1_000, retries: 3 },
          },
          projects: [{
            project: "hachi-kanban",
            repoCommonDir,
            profiles: [{
              id: runtimeProfileId,
              bundleKind: "worktree_postgres",
              hostAdapter: "worktreePostgres",
            }],
          }],
        });
    if (runtimeResources !== undefined) {
      writeFileSync(
        join(harness.home.home, "config.json"),
        JSON.stringify({ ...harness.deps.config, runtimeResources }),
        "utf8",
      );
    }
    const orchestrator = harness.store.registerOrchestrator({
      label: `runtime-owner-${taskId}`,
      project: "hachi-kanban",
      repoCommonDir,
    });
    harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const requirementName = runtimeProfileId === undefined
      ? "postgres"
      : `runtime-profile:${runtimeProfileId}`;
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId,
      name: requirementName,
      bundleKind: "worktree_postgres",
      spec: {
        version: 1,
        requiredMembers: ["postgres_endpoint"],
        ...(runtimeProfileId === undefined
          ? {}
          : {
              ownershipSnapshot: {
                version: 1,
                profileId: runtimeProfileId,
                orchestratorId: orchestrator.id,
                project: "hachi-kanban",
                repoCommonDir,
                canonicalWorktree,
              },
              hostAdapterSnapshot: createRuntimeProjectHostAdapterSnapshot(
                runtimeResources!,
                "worktreePostgres",
              ),
            }),
      },
      idempotencyKey: `${taskId}:${requirementName}`,
    });
    const lease = harness.store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "test",
      project: "hachi-kanban",
      repoCommonDir,
      worktree: canonicalWorktree,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "test",
    });
    const provisioning = harness.store.claimRuntimeResourceLease(lease.id, lease.fence, "test");
    harness.store.addRuntimeResourceMember({
      leaseId: lease.id,
      expectedLeaseFence: provisioning.fence,
      kind: "postgres_endpoint",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: `postgres:${taskId}`,
      hostIp: "127.0.0.1",
      hostPort: 49152,
      containerPort: 5432,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "test",
    });
    const active = harness.store.transitionRuntimeResourceLease({
      leaseId: lease.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "test",
    });
    const secretDirectory = join(harness.home.home, "runtime-secrets", active.id);
    const manifestDirectory = join(harness.home.home, "runtime-manifests");
    mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
    const secretFilePath = join(secretDirectory, "postgres-password");
    writeFileSync(secretFilePath, "dispatch-test-password\n", { mode: 0o600 });
    writeFileSync(join(manifestDirectory, `${active.id}.json`), JSON.stringify({
      version: 1,
      leaseId: active.id,
      fence: active.fence,
      bundleKind: "worktree_postgres",
      host: "127.0.0.1",
      port: 49152,
      database: "hachi_dispatch",
      role: "hachi_dispatch",
      secretFilePath,
    }), { mode: 0o600 });
    return {
      leaseId: active.id,
      fence: active.fence,
      ...(runtimeResources === undefined ? {} : { runtimeResources }),
    };
  }

  it("cwd あり + model 解決OK のタスクを起動し blocked(in-progress) にする", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "実装タスク", body: `cwd: ${cwdDir}\n作業内容の説明` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.skipped).toBe(false);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(updated?.blockReason).toContain("even-session=");
    expect(updated?.blockReason).toContain("実装タスク");

    // task_runs に記録される
    const runs = harness.store.listOpenRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.taskId).toBe(task.id);
    expect(runs[0]?.provider).toBe("codex");

    // launched イベントが記録される
    const events = harness.store.listEvents(task.id, "launched");
    expect(events).toHaveLength(1);

    // bridge に prompt が届いている
    const promptRequests = harness.codexBridge.requests.filter(
      (request) => request.path === "/api/prompt" && request.method === "POST",
    );
    expect(promptRequests).toHaveLength(1);
    const promptRequest = promptRequests[0];
    const promptBody = promptRequest?.body as { text?: string };
    expect(promptBody.text).toContain("## Runtime resource policy（必須）");
    expect(promptBody.text).toContain("runtime manifest / resource lease: 割当なし");
    expect(promptBody.text).toContain("shared main DB へ変更する自動 fallback は禁止");
    expect(harness.store.getExternalRuntimeGenerationBinding(runs[0]!.id)).toBeNull();
  });

  it("bridge response/status exact attestationをworker run開始と同じCASへbindする", async () => {
    const model = DEFAULT_TEST_CONFIG.profiles.implement!.model;
    const fixture = externalGenerationFixture(model);
    const fakeCodex = new FakeAdapter("codex");
    const launchResponse: BridgeLaunchSessionRef = {
      provider: "codex",
      sessionId: "external-generation-worker",
      serverUrl: harness.deps.env.bridges.codex.url,
      model,
      modelDelivery: "native",
      appliedModel: model,
      runtimeGenerationAttestation: fixture.attestation,
      startedAt: Math.floor(Date.now() / 1_000),
    };
    fakeCodex.launchResponse = launchResponse;
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    (harness.deps as StageDepsWithExternalRuntimeGenerationReader).externalRuntimeGenerationReader = {
      read: async () => ({ state: "valid", sample: fixture.sample, launchAttestation: fixture.attestation }),
    };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "external binding", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1_000));

    const run = harness.store.getLatestOpenRun(task.id)!;
    expect(harness.store.getExternalRuntimeGenerationBinding(run.id)).toMatchObject({
      taskId: task.id,
      role: "worker",
      provider: "codex",
      identity: { runtimeModelId: model },
    });
  });

  it("prompt成功後にattestationが欠けても再送やdirect fallbackをせずlegacy runとして一度だけ開始する", async () => {
    const model = DEFAULT_TEST_CONFIG.profiles.implement!.model;
    const bridge = new FakeAdapter("codex");
    const launchResponse: BridgeLaunchSessionRef = {
      provider: "codex",
      sessionId: "external-generation-missing",
      serverUrl: harness.deps.env.bridges.codex.url,
      model,
      modelDelivery: "native",
      appliedModel: model,
      startedAt: Math.floor(Date.now() / 1_000),
    };
    bridge.launchResponse = launchResponse;
    const direct = new FakeAdapter("codex");
    harness.deps.adapters = { ...harness.deps.adapters, codex: bridge };
    harness.deps.directAdapters = { ...harness.deps.directAdapters, codex: direct };
    let readCalls = 0;
    (harness.deps as StageDepsWithExternalRuntimeGenerationReader).externalRuntimeGenerationReader = {
      read: async () => {
        readCalls += 1;
        return { state: "unknown", code: "attestation_missing" };
      },
    };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "missing external attestation", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1_000));

    expect(bridge.launchCalls).toHaveLength(1);
    expect(direct.launchCalls).toHaveLength(0);
    expect(readCalls).toBe(0);
    const run = harness.store.getLatestOpenRun(task.id)!;
    expect(harness.store.getExternalRuntimeGenerationBinding(run.id)).toBeNull();
  });

  it("worker launch直前のGit base snapshotをrun metaへ保存する（docs/contract.md §65.3）", async () => {
    const snapshot = {
      schemaVersion: "handoff-git-launch.v1" as const,
      state: "available" as const,
      canonicalWorktree: cwdDir,
      repoCommonDir: join(cwdDir, ".git"),
      headOid: "a".repeat(40),
    };
    let launchSnapshotCalls = 0;
    (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
      captureLaunchSnapshot: async (cwd) => {
        launchSnapshotCalls += 1;
        expect(cwd).toBe(cwdDir);
        return snapshot;
      },
      captureEndEvidence: async () => {
        throw new Error("dispatch は終端 evidence を取得しません");
      },
    };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "Git snapshot 対象", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(launchSnapshotCalls).toBe(1);
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    expect(JSON.parse(run!.meta)).toMatchObject({
      [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
    });
  });

  it("停止証拠未確認の cancelled run と同一 worktree への replacement を起動しない", async () => {
    const owner = harness.store.createTask(
      taskInput({ status: "ready", title: "cancel owner", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.block(
      owner.id,
      "codex-in-progress: 実装中 tmux=none even-session=cancel-owner server=http://x",
      "tester",
    );
    const ownerRun = harness.store.startRun(owner.id, "codex", "cancel-owner", { serverUrl: "http://x" });
    harness.store.createOrGetRunCancelRequest({
      taskId: owner.id,
      runId: ownerRun.id,
      sessionId: ownerRun.sessionId,
      provider: ownerRun.provider,
      requestNonce: "dispatch-replacement-gate",
      actor: "supervisor",
      reason: "replacement gate test",
      deadlineAt: Math.floor(Date.now() / 1000) + 60,
    });
    const replacement = harness.store.createTask(
      taskInput({ status: "ready", title: "replacement", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes).toContainEqual(expect.stringContaining("replacement を拒否"));
    expect(harness.store.getTask(replacement.id)?.status).toBe("ready");
    expect(harness.store.getLatestOpenRun(replacement.id)).toBeNull();
  });

  it("launch中に同一worktreeのcancelが作られた場合は新sessionをrun bindせずdirect exact stopする", async () => {
    const owner = harness.store.createTask(
      taskInput({ status: "ready", title: "cancel race owner", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.block(
      owner.id,
      "codex-in-progress: 実装中 tmux=none even-session=cancel-race-owner server=http://x",
      "tester",
    );
    const ownerRun = harness.store.startRun(owner.id, "codex", "cancel-race-owner", { serverUrl: "http://x" });
    const replacement = harness.store.createTask(
      taskInput({ status: "ready", title: "replacement race", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const direct = new FakeAdapter("codex");
    direct.launchResponse = {
      provider: "codex",
      sessionId: "replacement-race-session",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    direct.launchHook = (): void => {
      harness.store.createOrGetRunCancelRequest({
        taskId: owner.id,
        runId: ownerRun.id,
        sessionId: ownerRun.sessionId,
        provider: ownerRun.provider,
        requestNonce: "dispatch-launch-race",
        actor: "supervisor",
        reason: "dispatch race",
        deadlineAt: Math.floor(Date.now() / 1000) + 60,
      });
    };
    harness.deps.directAdapters = { codex: direct };
    harness.deps.config = configWithImplementProfile({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
    });

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(replacement.id)).toBeNull();
    expect(harness.store.getTask(replacement.id)).toMatchObject({ status: "blocked" });
    expect(harness.store.listEvents(replacement.id, "orphan_session")).toHaveLength(1);
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["replacement-race-session"]);
    // 契約 §34.2.1: 成功2値（terminated/killed）も reason を証拠として記録する（デフォルトの
    // stopResponse は stopped:true, reason:"terminated"）。stopped:false のときだけ記録すると
    // 成功経路の reason が欠落するため、成功経路でも記録されることをここで確認する。
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("cancel fence 競合で孤児化した direct session の exact stopが完了しました");
    expect(log).toContain('"reason":"terminated"');
  });

  it("cancel fence競合で孤児化したdirect sessionのstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
    const owner = harness.store.createTask(
      taskInput({ status: "ready", title: "cancel race owner unsignalable", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.block(
      owner.id,
      "codex-in-progress: 実装中 tmux=none even-session=cancel-race-owner-unsignalable server=http://x",
      "tester",
    );
    const ownerRun = harness.store.startRun(owner.id, "codex", "cancel-race-owner-unsignalable", { serverUrl: "http://x" });
    const replacement = harness.store.createTask(
      taskInput({ status: "ready", title: "replacement race unsignalable", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const direct = new FakeAdapter("codex");
    direct.launchResponse = {
      provider: "codex",
      sessionId: "replacement-race-session-unsignalable",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    direct.stopResponse = { stopped: false, reason: "unsignalable" };
    direct.launchHook = (): void => {
      harness.store.createOrGetRunCancelRequest({
        taskId: owner.id,
        runId: ownerRun.id,
        sessionId: ownerRun.sessionId,
        provider: ownerRun.provider,
        requestNonce: "dispatch-launch-race-unsignalable",
        actor: "supervisor",
        reason: "dispatch race",
        deadlineAt: Math.floor(Date.now() / 1000) + 60,
      });
    };
    harness.deps.directAdapters = { codex: direct };
    harness.deps.config = configWithImplementProfile({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
    });

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(replacement.id)).toBeNull();
    expect(harness.store.getTask(replacement.id)).toMatchObject({ status: "blocked" });
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["replacement-race-session-unsignalable"]);
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("停止を確認できませんでした");
    expect(log).toContain('"reason":"unsignalable"');
  });

  it("capability preflight中にconfig snapshotが変わった場合はworkerをlaunchしない", async () => {
    let changed = false;
    setCompatibilityProbe(async (provider, transport) => {
      if (!changed) {
        changed = true;
        writeConfig({
          ...harness.deps.config,
          resourceGuard: {
            ...harness.deps.config.resourceGuard,
            maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
          },
        });
      }
      return {
        ok: true,
        snapshot: capabilitySnapshot(provider, transport, ["gpt-5.6-terra"]),
      };
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "preflight config drift", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      claimLock: "",
      blockReason: expect.stringContaining("snapshot/config drift"),
    });
  });

  it("direct launch中にtask bodyが変わった場合はrun/resourceへbindせずsessionを停止する", async () => {
    harness.deps.config = configWithImplementProfile({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "task settings drift", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const direct = new FakeAdapter("codex");
    direct.launchResponse = {
      provider: "codex",
      sessionId: "task-settings-drift-session",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    direct.launchHook = (): void => {
      harness.store.updateBody(task.id, `cwd: ${cwdDir}\nlaunch中の仕様変更`, "tester");
    };
    harness.deps.directAdapters = { codex: direct };

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human", claimLock: "" });
    expect(harness.store.listEvents(task.id, "orphan_session").map((event) => JSON.parse(event.payload)))
      .toContainEqual(expect.objectContaining({ reason: "execution-settings-or-config-drift", settingsChanged: true }));
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["task-settings-drift-session"]);
  });

  it("direct launch中にconfig fileが変わった場合はrun/resourceへbindせずsessionを停止する", async () => {
    harness.deps.config = configWithImplementProfile({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch config drift", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const direct = new FakeAdapter("codex");
    direct.launchResponse = {
      provider: "codex",
      sessionId: "config-drift-session",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    direct.launchHook = (): void => {
      writeConfig({
        ...harness.deps.config,
        resourceGuard: {
          ...harness.deps.config.resourceGuard,
          maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
        },
      });
    };
    harness.deps.directAdapters = { codex: direct };

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human", claimLock: "" });
    expect(harness.store.listEvents(task.id, "orphan_session").map((event) => JSON.parse(event.payload)))
      .toContainEqual(expect.objectContaining({ reason: "execution-settings-or-config-drift", configFileChanged: true }));
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["config-drift-session"]);
  });

  it("execution設定driftで孤児化したdirect sessionのstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
    harness.deps.config = configWithImplementProfile({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch config drift unsignalable", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const direct = new FakeAdapter("codex");
    direct.launchResponse = {
      provider: "codex",
      sessionId: "config-drift-session-unsignalable",
      serverUrl: "direct",
      model: "gpt-5.6-sol",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    direct.stopResponse = { stopped: false, reason: "unsignalable" };
    direct.launchHook = (): void => {
      writeConfig({
        ...harness.deps.config,
        resourceGuard: {
          ...harness.deps.config.resourceGuard,
          maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
        },
      });
    };
    harness.deps.directAdapters = { codex: direct };

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human", claimLock: "" });
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["config-drift-session-unsignalable"]);
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("停止を確認できませんでした");
    expect(log).toContain('"reason":"unsignalable"');
  });

  it("overrideなしprofileのsupported判定をclaim前に通して起動する", async () => {
    const probes: Array<{ provider: Provider; transport: Transport }> = [];
    setCompatibilityProbe(async (provider, transport) => {
      probes.push({ provider, transport });
      return { ok: true, snapshot: capabilitySnapshot(provider, transport, ["gpt-5.6-terra"]) };
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "profile互換", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(probes).toEqual([{ provider: "codex", transport: "bridge" }]);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("codex-in-progress:");
    expect(harness.store.listOpenRuns()).toHaveLength(1);
    const compatibilityEvents = harness.store.listEvents(task.id, "model_transport_compatibility_checked");
    expect(compatibilityEvents).toHaveLength(1);
    expect(JSON.parse(compatibilityEvents[0]?.payload ?? "{}") as unknown).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      transport: "bridge",
      status: "supported",
      evidence: "advertised-model",
      expectation: { provider: "codex", model: "gpt-5.6-terra", transport: "bridge" },
      observed: { runtime: { name: "codex-dispatch-test" } },
    });
  });

  it("bridge更新後の再dispatchでunsupported履歴の後にsupported判定を記録する", async () => {
    let runtimeUpdated = false;
    setCompatibilityProbe(async (provider, transport) => ({
      ok: true,
      snapshot: capabilitySnapshot(
        provider,
        transport,
        runtimeUpdated ? ["gpt-5.6-terra"] : ["gpt-5.4"],
      ),
    }));
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "bridge更新回復", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(harness.store.getTask(task.id)?.blockReason).toContain("incompatible_model_transport");

    runtimeUpdated = true;
    harness.store.unblock(task.id, "ready", "tester");
    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000) + 1);

    expect(harness.store.getTask(task.id)?.blockReason).toContain("codex-in-progress:");
    const observations = harness.store.listEvents(task.id).filter((event) =>
      event.eventType === "incompatible_model_transport" ||
      event.eventType === "model_transport_compatibility_checked");
    expect(observations.map((event) => event.eventType)).toEqual([
      "incompatible_model_transport",
      "model_transport_compatibility_checked",
    ]);
    expect(JSON.parse(observations[1]?.payload ?? "{}") as unknown).toMatchObject({
      status: "supported",
      evidence: "advertised-model",
      observed: { modelCatalog: { models: ["gpt-5.6-terra"] } },
    });
  });

  it("supported判定のevent記録時にclaim fenceが変化したら重複記録もlaunchもしない", async () => {
    setCompatibilityProbe(async (provider, transport) => ({
      ok: true,
      snapshot: capabilitySnapshot(provider, transport, ["gpt-5.6-terra"]),
    }));
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "supported CAS競合", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const originalGetTask = harness.store.getTask.bind(harness.store);
    let claimedReads = 0;
    harness.store.getTask = (id: string): TaskRow | null => {
      const current = originalGetTask(id);
      if (id === task.id && current?.status === "ready" && current.claimLock !== "") {
        claimedReads += 1;
        if (claimedReads === 2) {
          return { ...current, claimLock: "other-writer-token" };
        }
      }
      return current;
    };

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    harness.store.getTask = originalGetTask;

    expect(result.notes?.some((note) => note.includes("supported互換性記録の claim CAS が不成立"))).toBe(true);
    expect(harness.store.listEvents(task.id, "model_transport_compatibility_checked")).toHaveLength(0);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("unsupportedはincompatible_model_transportでclaim/run/session/workerを作らずblockする", async () => {
    setCompatibilityProbe(async (provider, transport) => ({
      ok: true,
      snapshot: capabilitySnapshot(provider, transport, ["gpt-5.4"]),
    }));
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "非互換", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      claimLock: "",
      assignee: "human",
    });
    expect(harness.store.getTask(task.id)?.blockReason).toContain("incompatible_model_transport");
    const events = harness.store.listEvents(task.id, "incompatible_model_transport");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload ?? "{}") as unknown).toMatchObject({
      status: "unsupported",
      expectation: { provider: "codex", model: "gpt-5.6-terra", transport: "bridge" },
      observed: { runtime: { name: "codex-dispatch-test" }, modelCatalog: { knowledge: "known" } },
    });
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("unknownはunsupportedへ丸めず回収可能な明示reasonで起動前blockする", async () => {
    setCompatibilityProbe(async (provider, transport) => ({
      ok: true,
      snapshot: capabilitySnapshot(provider, transport, [], "unknown"),
    }));
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "互換性不明", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)?.blockReason).toContain("model_transport_compatibility_unknown");
    expect(harness.store.getTask(task.id)?.blockReason).not.toContain("incompatible_model_transport");
    expect(harness.store.listEvents(task.id, "model_transport_compatibility_unknown")).toHaveLength(1);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
  });

  it("auto-launch retry候補が同じ非互換ならcircuit breakerでretry開始せず固定blockする", async () => {
    setCompatibilityProbe(async (provider, transport) => ({
      ok: true,
      snapshot: capabilitySnapshot(provider, transport, []),
    }));
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "反復停止", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.block(task.id, "auto-launch-failed: model is unsupported by transport", "supervisor", "human");

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    const second = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000) + 120);

    expect(harness.store.getTask(task.id)?.blockReason).toContain("incompatible_model_transport");
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(0);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(second.actions).toBe(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("0-tokenでincompatible_model_transport分類済みのhuman blockはdispatch retry対象にしない", async () => {
    let probes = 0;
    setCompatibilityProbe(async (provider, transport) => {
      probes += 1;
      return { ok: true, snapshot: capabilitySnapshot(provider, transport, ["gpt-5.6-terra"]) };
    });
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "0-token分類済み", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.block(
      task.id,
      "needs-manual: 実行失敗 incompatible_model_transport (session=zero-token)",
      "supervisor",
      "human",
    );
    harness.store.addEvent(task.id, "incompatible_model_transport", "supervisor", {
      sessionId: "zero-token",
      diagnostic: "model is incompatible with transport",
    });

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000) + 120);

    expect(result.actions).toBe(0);
    expect(probes).toBe(0);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("incompatible_model_transport");
  });

  it("ready+active+同一worktreeのruntime leaseを実dispatch promptへ渡す", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "runtime付き実装", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const promptRequest = harness.codexBridge.requests.find((request) => request.path === "/api/prompt");
    const promptBody = promptRequest?.body as { text?: string };
    expect(promptBody.text).toContain(`id=${lease.leaseId} kind=worktree_postgres fence=${lease.fence}`);
    expect(promptBody.text).not.toContain("runtime manifest / resource lease: 割当なし");
    const run = harness.store.listOpenRuns().find((entry) => entry.taskId === task.id);
    expect(run).toBeDefined();
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)).toMatchObject({
      ownerRunId: run?.id,
      fence: lease.fence + 1,
    });
    const manifest = JSON.parse(
      readFileSync(join(harness.home.home, "runtime-manifests", `${lease.leaseId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["fence"]).toBe(lease.fence + 1);
  });

  it.each([
    {
      name: "profile削除",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({ ...runtimeResources, projects: [] });
      },
    },
    {
      name: "provision無効化",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({ ...runtimeResources, provisioningEnabled: false });
      },
    },
    {
      name: "Docker context変更",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({ ...runtimeResources, dockerContext: "dispatch-changed-context" });
      },
    },
    {
      name: "image変更",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({
          ...runtimeResources,
          worktreePostgres: {
            ...runtimeResources.worktreePostgres!,
            image: "postgres:changed",
          },
        });
      },
    },
    {
      name: "healthCheck変更",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({
          ...runtimeResources,
          worktreePostgres: {
            ...runtimeResources.worktreePostgres!,
            healthCheck: {
              ...runtimeResources.worktreePostgres!.healthCheck,
              retries: runtimeResources.worktreePostgres!.healthCheck.retries + 1,
            },
          },
        });
      },
    },
  ])("active profile leaseでもcurrent $name後はdispatchしない", async ({ mutate }) => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "profile drift dispatch", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id, 600, "postgres-v1");
    const changed = mutate(lease.runtimeResources!);
    writeFileSync(
      join(harness.home.home, "config.json"),
      JSON.stringify({ ...harness.deps.config, runtimeResources: changed }),
      "utf8",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringContaining("snapshot/config drift"),
    });
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)).toMatchObject({
      state: "active",
      ownerRunId: null,
      fence: lease.fence,
    });
  });

  it("claim後にcurrent host adapter設定がdriftした場合もlaunch前に拒否する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "post-claim profile drift", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id, 600, "postgres-v1");
    const claimTask = harness.store.claimTask.bind(harness.store);
    harness.store.claimTask = (...args: Parameters<typeof claimTask>): boolean => {
      const claimed = claimTask(...args);
      if (claimed) {
        const changed = runtimeResourcesSchema.parse({
          ...lease.runtimeResources!,
          worktreePostgres: {
            ...lease.runtimeResources!.worktreePostgres!,
            image: "postgres:changed-after-claim",
          },
        });
        writeFileSync(
          join(harness.home.home, "config.json"),
          JSON.stringify({ ...harness.deps.config, runtimeResources: changed }),
          "utf8",
        );
      }
      return claimed;
    };

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      claimLock: "",
      blockReason: expect.stringContaining("snapshot/config drift"),
    });
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)).toMatchObject({
      state: "active",
      ownerRunId: null,
      fence: lease.fence,
    });
  });

  it("pending runtime requirement があるタスクは claim せず dispatch しない", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "resource待ち", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "postgres",
      bundleKind: "worktree_postgres",
      spec: { version: 1, requiredMembers: ["postgres_endpoint"] },
      idempotencyKey: `${task.id}:pending-postgres`,
    });

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "ready", claimLock: "" });
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("launch 中に lease fence が進んだ場合は run bind を拒否して孤児を fail-closed block する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "stale fence", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchResponse = {
      provider: "codex",
      sessionId: "stale-fence-session",
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    fakeCodex.launchHook = () => {
      harness.store.transitionRuntimeResourceLease({
        leaseId: lease.leaseId,
        expectedFence: lease.fence,
        from: "active",
        to: "active",
        actor: "racing-supervisor",
      });
    };
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("runtime resource bind に失敗");
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)).toMatchObject({
      ownerRunId: null,
      state: "cleanup_pending",
    });
    const { createRuntimeResourceReadView } = await import("@hachi/core");
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.leaseId)).toEqual([
      expect.objectContaining({ decisionClass: "human", status: "waiting_human" }),
    ]);
    view.close();
  });

  it("manifest 検証例外は claim を残さず fail-closed block する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "invalid manifest", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);
    writeFileSync(
      join(harness.home.home, "runtime-manifests", `${lease.leaseId}.json`),
      JSON.stringify({ version: 1, leaseId: lease.leaseId, fence: lease.fence + 1 }),
      { mode: 0o600 },
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      claimLock: "",
    });
    expect(harness.store.getTask(task.id)?.blockReason).toContain("manifest/secret reference の検証に失敗");
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("resource 付き task の launch 失敗は lease を cleanup_pending にして request を残す", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch partial failure", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchError = new Error("simulated launch failure");
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const updatedLease = harness.store.getRuntimeResourceLease(lease.leaseId);
    expect(updatedLease?.state).toBe("cleanup_pending");
    const { createRuntimeResourceReadView } = await import("@hachi/core");
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.leaseId)).toEqual([
      expect.objectContaining({ decisionClass: "auto", status: "queued" }),
    ]);
    const requirements = view.requirementsForTask(task.id);
    expect(requirements).toHaveLength(2);
    expect(requirements.some((requirement) => requirement.status === "pending")).toBe(true);
    view.close();
  });

  it("resource 付き task の launch timeout は indeterminate で block し cleanup request を作らない", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch indeterminate", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchError = new BridgeError("bridge /api/prompt がタイムアウトしました", "timeout");
    harness.deps.adapters.codex = fakeCodex;
    (harness.deps as StageDepsWithLaunchSessionProbe).launchSessionProbe = async (_bridge, cwd, provider) => {
      expect(cwd).toBe(realpathSync.native(cwdDir));
      expect(provider).toBe("codex");
      return [
        { id: "candidate-new", status: "busy", timestamp: "2999-01-01T00:00:00.000Z" },
        { id: "candidate-old", status: "idle", timestamp: "2000-01-01T00:00:00.000Z" },
        { id: "candidate-invalid", status: "idle", timestamp: "not-a-timestamp" },
        { id: "candidate-missing", status: "busy", timestamp: null },
      ];
    };

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringMatching(/^needs-manual: launch-indeterminate: /),
    });
    const events = harness.store.listEvents(task.id, "launch_indeterminate");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      probeCwd: realpathSync.native(cwdDir),
      probeProvider: "codex",
      candidateSessions: [
        {
          id: "candidate-new",
          status: "busy",
          timestamp: "2999-01-01T00:00:00.000Z",
          startedAfterAttempt: true,
        },
        {
          id: "candidate-old",
          status: "idle",
          timestamp: "2000-01-01T00:00:00.000Z",
          startedAfterAttempt: false,
        },
        {
          id: "candidate-invalid",
          status: "idle",
          timestamp: "not-a-timestamp",
          startedAfterAttempt: null,
        },
        {
          id: "candidate-missing",
          status: "busy",
          timestamp: null,
          startedAfterAttempt: null,
        },
      ],
      probeError: null,
    });
    expect(Date.parse(payload.attemptedAt as string)).not.toBeNaN();
    expect(Date.parse(payload.probedAt as string)).toBeGreaterThanOrEqual(Date.parse(payload.attemptedAt as string));
    expect(JSON.stringify(payload)).not.toContain("title");
    expect((payload.candidateSessions as Array<Record<string, unknown>>).every((session) => !("cwd" in session))).toBe(true);
    expect(harness.store.listEvents(task.id, "launch_failed")).toHaveLength(0);
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)?.state).toBe("active");
    const { createRuntimeResourceReadView } = await import("@hachi/core");
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.leaseId)).toHaveLength(0);
    view.close();
    expect(result.notes).toContain(`${task.id}: indeterminate のため cleanup request を作成しませんでした`);
  });

  it("launch timeout 後の cwd canonicalization 失敗でも indeterminate の block と event を残す", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch indeterminate missing cwd", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const fakeCodex = new FakeAdapter("codex");
    const launchErrorMessage = "bridge /api/prompt がタイムアウトしました";
    fakeCodex.launchHook = () => rmSync(cwdDir, { recursive: true, force: true });
    fakeCodex.launchError = new BridgeError(launchErrorMessage, "timeout");
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "blocked",
      blockReason: `needs-manual: launch-indeterminate: ${launchErrorMessage}`,
    });
    const events = harness.store.listEvents(task.id, "launch_indeterminate");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      probeCwd: null,
      probeProvider: "codex",
      candidateSessions: [],
      probeError: expect.stringContaining("ENOENT"),
    });
  });

  it("runtime profile付きtaskのlaunch失敗はprofile identityを保持した後継requirementを作る", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "profile launch failure", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id, 600, "postgres-v1");
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchError = new Error("simulated profile launch failure");
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getRuntimeResourceLease(lease.leaseId)?.state).toBe("cleanup_pending");
    const { createRuntimeResourceReadView } = await import("@hachi/core");
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(task.id);
    view.close();
    const original = requirements.find((requirement) => requirement.leaseId === lease.leaseId);
    expect(requirements).toHaveLength(2);
    expect(requirements.find((requirement) => requirement.status === "pending")).toMatchObject({
      name: `retry-${lease.leaseId}`,
      idempotencyKey: `${original?.id}:retry:${lease.leaseId}`,
    });
  });

  it("launch 処理中に lease が実時間で失効した場合は run bind を拒否する", async () => {
    const baseNow = Math.floor(Date.now() / 1000);
    let currentNow = baseNow * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "expires during launch", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id, 1);
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchResponse = {
      provider: "codex",
      sessionId: "expired-during-launch",
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: baseNow,
    };
    fakeCodex.launchHook = () => {
      currentNow += 2_000;
    };
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, baseNow);

    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("runtime resource bind に失敗");
    expect(harness.store.getRuntimeResourceLease(lease.leaseId)?.state).toBe("cleanup_pending");
    clock.mockRestore();
  });

  it("resource 付き launch の task claim 不一致は cleanup request を残す", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "resource orphan", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const lease = activateRuntimeLease(task.id);
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchResponse = {
      provider: "codex",
      sessionId: "resource-orphan",
      serverUrl: "http://127.0.0.1:3456",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    fakeCodex.launchHook = () => {
      harness.store.block(task.id, "user-decision: competing writer", "other-writer");
    };
    harness.deps.adapters.codex = fakeCodex;

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getRuntimeResourceLease(lease.leaseId)?.state).toBe("cleanup_pending");
    const { createRuntimeResourceReadView } = await import("@hachi/core");
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.leaseId)).toEqual([
      expect.objectContaining({ decisionClass: "human", status: "waiting_human" }),
    ]);
    view.close();
  });

  it("config.json の profile 変更を次 tick の dispatch に反映する", async () => {
    enableConfigReload();
    writeConfig(configWithImplementProfile({ provider: "codex", model: "gpt-5.4" }));

    const first = harness.store.createTask(
      taskInput({ status: "ready", title: "初回は codex", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const firstRun = harness.store.listOpenRuns().find((run) => run.taskId === first.id);
    expect(firstRun?.provider).toBe("codex");

    writeConfig(configWithImplementProfile({ provider: "claude", model: "claude-sonnet-5" }));
    const second = harness.store.createTask(
      taskInput({ status: "ready", title: "次 tick は claude", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const secondRun = harness.store.listOpenRuns().find((run) => run.taskId === second.id);
    expect(secondRun?.provider).toBe("claude");
    expect(harness.claudeBridge.requests.some((r) => r.path === "/api/prompt" && r.method === "POST")).toBe(true);
  });

  it("同 tenant の直近 lesson 3件を prompt に注入し、cwd prefix 一致を優先する", async () => {
    const genericOld = harness.store.createTask(taskInput({ title: "old", body: "cwd: /elsewhere" }), "tester");
    const prefix = harness.store.createTask(taskInput({ title: "prefix", body: `cwd: ${cwdDir}/sub` }), "tester");
    const genericNew = harness.store.createTask(taskInput({ title: "new", body: "cwd: /other" }), "tester");
    const genericNewest = harness.store.createTask(taskInput({ title: "newest", body: "cwd: /another" }), "tester");
    const otherTenant = harness.store.createTask(
      taskInput({ title: "prod", body: `cwd: ${cwdDir}`, tenant: "prod" }),
      "tester",
    );
    harness.store.recordLesson({
      trigger: "rework",
      tenant: "test-tenant",
      cwd: "/elsewhere",
      profile: "implement",
      body: "generic-old",
      sourceTaskId: genericOld.id,
    });
    harness.store.recordLesson({
      trigger: "rework",
      tenant: "test-tenant",
      cwd: `${cwdDir}/sub`,
      profile: "implement",
      body: "prefix-match",
      sourceTaskId: prefix.id,
    });
    harness.store.recordLesson({
      trigger: "user-decision",
      tenant: "test-tenant",
      cwd: "/other",
      profile: "plan",
      body: "generic-new",
      sourceTaskId: genericNew.id,
    });
    harness.store.recordLesson({
      trigger: "needs-manual",
      tenant: "test-tenant",
      cwd: "/another",
      profile: "docs",
      body: "generic-newest",
      sourceTaskId: genericNewest.id,
    });
    harness.store.recordLesson({
      trigger: "rework",
      tenant: "prod",
      cwd: cwdDir,
      profile: "implement",
      body: "other-tenant",
      sourceTaskId: otherTenant.id,
    });

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "lesson 注入", body: `cwd: ${cwdDir}\n作業内容` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    const promptRequest = harness.codexBridge.requests.find((r) => r.path === "/api/prompt" && r.method === "POST");
    expect(promptRequest).toBeDefined();
    const body = promptRequest?.body as { text?: string };
    expect(body.text).toContain("## 過去の教訓");
    expect(body.text).toContain("prefix-match");
    expect(body.text).toContain("generic-newest");
    expect(body.text).toContain("generic-new");
    expect(body.text).not.toContain("generic-old");
    expect(body.text).not.toContain("other-tenant");
    expect(body.text!.indexOf("prefix-match")).toBeLessThan(body.text!.indexOf("generic-newest"));
  });

  it("config.json のホットリロード失敗時は前回値で dispatch を継続する", async () => {
    enableConfigReload();
    writeFileSync(join(harness.home.home, "config.json"), "{ invalid json", "utf8");

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "前回値で起動", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((note) => note.includes("config hot reload failed"))).toBe(true);
    const run = harness.store.listOpenRuns().find((item) => item.taskId === task.id);
    expect(run?.provider).toBe("codex");
  });

  it("cwd 未指定のタスクは user-decision で block する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "cwdなし", body: "cwd 行が無い本文" }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: cwd 未指定のため起動できません");
    expect(updated?.assignee).toBe("human");
  });

  it("literal newline escape の本文は user-decision ではなく orchestrator recovery に分類する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "literal newline escape", body: `cwd: ${cwdDir}\\n## 目的\\n本文` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("needs-manual: task body validation failed");
    expect(updated?.blockReason).toContain("code=literal-newline-escape");
    expect(updated?.blockReason).not.toContain("user-decision:");
    expect(updated?.assignee).not.toBe("human");
    expect(harness.store.listEvents(task.id, "task_body_validation_failed")).toHaveLength(1);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("JSON.stringify の外側引用符付き本文も user-decision に誤分類しない", async () => {
    const task = harness.store.createTask(
      taskInput({
        status: "ready",
        title: "stringified literal newline escape",
        body: `${JSON.stringify(`cwd: ${cwdDir}\n本文`)}\r\n`,
      }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("needs-manual: task body validation failed");
    expect(updated?.blockReason).toContain("code=literal-newline-escape");
    expect(updated?.blockReason).not.toContain("user-decision:");
    expect(updated?.assignee).not.toBe("human");
    expect(harness.store.listEvents(task.id, "task_body_validation_failed")).toHaveLength(1);
    expect(harness.codexBridge.requests.some((request) => request.path === "/api/prompt")).toBe(false);
  });

  it("auto-launch-failed retry中の不正本文もblock reasonと監査eventを同じ分類で記録する", async () => {
    const task = harness.store.createTask(
      taskInput({
        status: "ready",
        title: "retry body validation",
        body: `cwd: ${cwdDir}\\n## 目的\\n本文`,
      }),
      "tester",
    );
    harness.store.block(task.id, "auto-launch-failed: /api/prompt timeout", "tester");

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("needs-manual: task body validation failed");
    expect(updated?.blockReason).not.toContain("user-decision:");
    expect(harness.store.listEvents(task.id, "block_reason_updated")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "task_body_validation_failed")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(0);
  });

  it("分類 transaction 内で本文が修正済みなら block せず次 tick に委ねる", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "並行 edit-body", body: `cwd: ${cwdDir}\\n## 目的\\n本文` }),
      "tester",
    );
    const fixedBody = `cwd: ${cwdDir}\n## 目的\n本文`;
    const readTask = harness.store.getTask.bind(harness.store);
    // 分類 transaction が現在の body を読み直す瞬間に、並行 edit-body が着地した状況を再現する。
    let repaired = false;
    vi.spyOn(harness.store, "getTask").mockImplementation((taskId: string) => {
      if (taskId === task.id && !repaired) {
        repaired = true;
        harness.store.updateBody(task.id, fixedBody, "concurrent-editor");
      }
      return readTask(taskId);
    });

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(repaired).toBe(true);
    const updated = readTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.blockReason).toBe("");
    expect(updated?.body).toBe(fixedBody);
    expect(harness.store.listEvents(task.id, "task_body_validation_failed")).toHaveLength(0);
    expect(result.notes?.some((note) => note.includes("並行 edit-body で本文が修正済み"))).toBe(true);
  });

  it("同一秒の並行 edit-body は body ハッシュ不一致として retry 経路の CAS を落とす", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "retry body race", body: `cwd: ${cwdDir}\\n## 目的\\n本文` }),
      "tester",
    );
    harness.store.block(task.id, "auto-launch-failed: /api/prompt timeout", "tester");
    const readTask = harness.store.getTask.bind(harness.store);
    // updatedAt は秒精度のため同一秒内の更新では変化しない。body だけが差し替わった状態を再現する。
    vi.spyOn(harness.store, "getTask").mockImplementation((taskId: string) => {
      const row = readTask(taskId);
      if (taskId !== task.id || row === null) {
        return row;
      }
      return { ...row, body: `cwd: ${cwdDir}\\n## 別の目的\\n本文` };
    });

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const updated = readTask(task.id);
    expect(updated?.blockReason).toBe("auto-launch-failed: /api/prompt timeout");
    expect(harness.store.listEvents(task.id, "task_body_validation_failed")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "block_reason_updated")).toHaveLength(0);
    expect(result.notes?.some((note) => note.includes("分類 CAS が不成立"))).toBe(true);
  });

  it("cwd が相対パスのタスクは user-decision で block する（docs/contract.md §12.4-5, fail-closed）", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "相対パス", body: "cwd: relative/path" }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: cwd が絶対パスではありません (relative/path)");
    expect(updated?.assignee).toBe("human");
  });

  it("cwd ディレクトリが存在しないタスクは user-decision で block する（fail-closed）", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "存在しないcwd", body: "cwd: /tmp/hachi-nonexistent-dir-for-test-xxxxx" }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: cwd ディレクトリが存在しません (/tmp/hachi-nonexistent-dir-for-test-xxxxx)");
    expect(updated?.assignee).toBe("human");
  });

  it("cwd が通常ファイルの場合は user-decision で block する（ディレクトリ検証, fail-closed）", async () => {
    const filePath = join(harness.home.home, "not-a-dir");
    writeFileSync(filePath, "dummy");
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "ファイルcwd", body: `cwd: ${filePath}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe(`user-decision: cwd がディレクトリではありません (${filePath})`);
    expect(updated?.assignee).toBe("human");
  });

  it("dry-run: cwd ディレクトリが存在しない場合は notes に記録し DB は変更しない", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "存在しないcwd(dry-run)", body: "cwd: /tmp/hachi-nonexistent-dir-for-test-xxxxx" }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("cwd ディレクトリが存在しません"))).toBe(true);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
  });

  it("dry-run: cwd が通常ファイルの場合は notes に記録し DB は変更しない", async () => {
    const filePath = join(harness.home.home, "not-a-dir-dryrun");
    writeFileSync(filePath, "dummy");
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "ファイルcwd(dry-run)", body: `cwd: ${filePath}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((n) => n.includes("cwd がディレクトリではありません"))).toBe(true);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
  });

  it("model_override が allowlist 外のタスクは user-decision で block する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "不正モデル", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.setModelOverride(
      task.id,
      "not-allowed-model",
      "tester",
      activeOrchestratorProvenance(harness, cwdDir, task.id, "allowlist-model-override"),
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason.startsWith("user-decision: モデル解決に失敗")).toBe(true);
    expect(updated?.assignee).toBe("human");
  });

  it("model 解決失敗の block 時に blockClaimedTask の CAS が不成立だった場合は fallback block せず notes にのみ記録する（docs/contract.md §12.19-2）", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "CAS不成立", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.setModelOverride(
      task.id,
      "not-allowed-model",
      "tester",
      activeOrchestratorProvenance(harness, cwdDir, task.id, "model-resolution-race"),
    );

    // blockClaimedTask 自体の CAS 判定は core 側で個別にテスト済みのため、ここでは戻り値 false
    // に対する dispatch 側の分岐（fallback で無条件 block() を呼ばないこと）だけを検証する。
    const originalBlockClaimedTask = harness.store.blockClaimedTask.bind(harness.store);
    harness.store.blockClaimedTask = (): boolean => false;

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    harness.store.blockClaimedTask = originalBlockClaimedTask;

    expect(result.actions).toBe(1);
    // CAS 不成立時は状態を変更しない（claim 直後のまま。fallback block を呼ばない）
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.claimLock).not.toBe("");
    expect(
      result.notes?.some((n) => n.includes("モデル解決失敗の block 試行時に claim 状態が変化していた")),
    ).toBe(true);
  });

  it("resource guard: maxInFlight 到達で残りの ready タスクをスキップする", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 5 } });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });

    const alreadyRunning = harness.store.createTask(taskInput({ status: "ready", title: "既存進行中" }), "tester");
    harness.store.block(alreadyRunning.id, "codex-in-progress: 実行中 even-session=sess-x", "tester");

    const pending = harness.store.createTask(
      taskInput({ status: "ready", title: "後続タスク", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes?.some((n) => n.includes("maxInFlight"))).toBe(true);

    const updated = harness.store.getTask(pending.id);
    expect(updated?.status).toBe("ready");
  });

  it("resource guard: maxInFlight は reviewer run（review ステージ由来）も加算する（docs/contract.md §15.1）", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 5 } });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });

    const reviewingTask = harness.store.createTask(taskInput({ status: "ready", title: "レビュー中" }), "tester");
    harness.store.block(reviewingTask.id, "codex-in-progress: 実装中 even-session=sess-x", "tester");
    harness.store.unblock(reviewingTask.id, "review", "tester");
    // worker run と同じく listInProgress には現れないが、review ステージが起動した reviewer run
    // （meta.role='reviewer'）は maxInFlight の枠を消費する
    harness.store.startRun(reviewingTask.id, "codex", "sess-reviewer", { role: "reviewer" });
    expect(harness.store.listInProgress()).toHaveLength(0);

    const pending = harness.store.createTask(
      taskInput({ status: "ready", title: "後続タスク", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(result.notes?.some((n) => n.includes("maxInFlight"))).toBe(true);
    expect(harness.store.getTask(pending.id)?.status).toBe("ready");
  });

  it("resource guard: maxInFlight は question_awaiting の open run も加算する（docs/contract.md §52.4）", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 5 } });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);

    const questionTask = harness.store.createTask(taskInput({ status: "ready", title: "質問待機中" }), "tester");
    harness.store.block(questionTask.id, "worker-question: 仕様確認", "tester");
    harness.store.startRun(questionTask.id, "codex", "sess-question-awaiting", {
      serverUrl: harness.codexBridge.url,
      transport: "bridge",
    });
    harness.store.addEvent(questionTask.id, "question_awaiting", "supervisor", {
      sessionId: "sess-question-awaiting",
      baselineResultCount: 1,
      deadline: now + 60,
      questionId: "q_test",
    });
    expect(harness.store.listInProgress()).toHaveLength(0);

    const pending = harness.store.createTask(
      taskInput({ status: "ready", title: "後続タスク", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(result.notes?.some((n) => n.includes("maxInFlight"))).toBe(true);
    expect(harness.store.getTask(pending.id)?.status).toBe("ready");
  });

  it("resource guard: maxLaunchesPerTick 到達で残りの ready タスクをスキップする", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 1 } });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });

    const first = harness.store.createTask(
      taskInput({ status: "ready", title: "1件目", priority: 2, body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const second = harness.store.createTask(
      taskInput({ status: "ready", title: "2件目", priority: 1, body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(first.id)?.status).toBe("blocked");
    expect(harness.store.getTask(second.id)?.status).toBe("ready");
  });

  it("resource guard: claude は既定 1/tick の provider 別起動上限を守る", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 } });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });

    const first = harness.store.createTask(
      taskInput({ status: "ready", profile: "plan", title: "claude 1件目", priority: 2, body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const second = harness.store.createTask(
      taskInput({ status: "ready", profile: "plan", title: "claude 2件目", priority: 1, body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(first.id)?.status).toBe("blocked");
    expect(harness.store.getTask(first.id)?.blockReason.startsWith("claude-in-progress:")).toBe(true);
    expect(harness.store.getTask(second.id)?.status).toBe("ready");
    expect(harness.claudeBridge.requests.filter((r) => r.path === "/api/prompt" && r.method === "POST")).toHaveLength(1);
    expect(result.notes?.some((n) => n.includes("dispatch.providerLaunchLimits.claude(1)"))).toBe(true);
  });

  describe("依存ゲート（docs/contract.md §24.2）", () => {
    function markDone(task: TaskRow): void {
      const current = harness.store.getTask(task.id);
      if (current === null) {
        throw new Error(`テスト前提タスクが見つかりません: ${task.id}`);
      }
      if (current.status !== "ready") {
        harness.store.transition({ taskId: task.id, to: "ready", actor: "tester" });
      }
      harness.store.block(task.id, "codex-in-progress: テスト前提を完了します", "tester");
      harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    }

    it("未充足依存がある ready タスクは claim せず skip し、launch 予算を消費しない", async () => {
      await harness.cleanup();
      harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 1 } });
      cwdDir = join(harness.home.home, "work");
      mkdirSync(cwdDir, { recursive: true });

      const prerequisite = harness.store.createTask(
        taskInput({ status: "todo", title: "未完了の前提", body: "前提作業" }),
        "tester",
      );
      const dependent = harness.store.createTask(
        taskInput({ status: "ready", priority: 10, title: "依存先", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      const next = harness.store.createTask(
        taskInput({ status: "ready", priority: 1, title: "後続", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.link(prerequisite.id, dependent.id, "depends-on");

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(dependent.id)?.status).toBe("ready");
      expect(harness.store.getTask(dependent.id)?.claimLock).toBe("");
      expect(harness.store.getTask(next.id)?.status).toBe("blocked");

      const events = harness.store.listEvents(dependent.id, "dependency_wait");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as { dependencyIds: string[]; payloadHash: string };
      expect(payload.dependencyIds).toEqual([prerequisite.id]);
      expect(payload.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.notes?.some((n) => n.includes("依存未充足") && n.includes(prerequisite.id))).toBe(true);
    });

    it("dry-run では依存未充足の skip 予定を notes に記録し、DB へは書き込まない", async () => {
      const prerequisite = harness.store.createTask(
        taskInput({ status: "todo", title: "未完了の前提", body: "前提作業" }),
        "tester",
      );
      const dependent = harness.store.createTask(
        taskInput({ status: "ready", title: "依存先", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.link(prerequisite.id, dependent.id, "depends-on");

      const result = await dispatchStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(0);
      expect(harness.store.getTask(dependent.id)?.status).toBe("ready");
      expect(harness.store.listEvents(dependent.id, "dependency_wait")).toHaveLength(0);
      expect(harness.codexBridge.requests).toHaveLength(0);
      expect(result.notes?.some((n) => n.includes("dry-run") && n.includes("依存未充足"))).toBe(true);
    });

    it("dependency_wait は同一未充足集合では重複記録しない", async () => {
      const prerequisite = harness.store.createTask(
        taskInput({ status: "todo", title: "未完了の前提", body: "前提作業" }),
        "tester",
      );
      const dependent = harness.store.createTask(
        taskInput({ status: "ready", title: "依存先", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.link(prerequisite.id, dependent.id, "depends-on");

      await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const events = harness.store.listEvents(dependent.id, "dependency_wait");
      expect(events).toHaveLength(1);
      expect(harness.store.getTask(dependent.id)?.status).toBe("ready");
      expect(harness.codexBridge.requests).toHaveLength(0);
    });

    it("MockBridge 統合: 前提が done になると依存タスクを通常 launch する", async () => {
      const prerequisite = harness.store.createTask(
        taskInput({ status: "todo", title: "完了させる前提", body: "前提作業" }),
        "tester",
      );
      const dependent = harness.store.createTask(
        taskInput({ status: "ready", title: "依存先", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.link(prerequisite.id, dependent.id, "depends-on");

      const beforeDone = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(beforeDone.actions).toBe(0);
      expect(harness.store.getTask(dependent.id)?.status).toBe("ready");

      markDone(prerequisite);
      const afterDone = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(afterDone.actions).toBe(1);
      const updated = harness.store.getTask(dependent.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
      expect(harness.store.listEvents(dependent.id, "launched")).toHaveLength(1);
      expect(harness.codexBridge.sessions()).toHaveLength(1);
      expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt" && r.method === "POST")).toBe(true);
    });

    it("依存が無い ready タスクは従来通り起動する", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "依存なし", body: `cwd: ${cwdDir}` }),
        "tester",
      );

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listEvents(task.id, "dependency_wait")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "launched")).toHaveLength(1);
    });
  });

  it("dry-run（apply=false）は DB に一切書き込まない", async () => {
    const withCwd = harness.store.createTask(
      taskInput({ status: "ready", title: "起動予定", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const withoutCwd = harness.store.createTask(
      taskInput({ status: "ready", title: "cwdなし", body: "本文のみ" }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(2);
    expect(harness.store.getTask(withCwd.id)?.status).toBe("ready");
    expect(harness.store.getTask(withoutCwd.id)?.status).toBe("ready");
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests).toHaveLength(0);
  });

  it("prompt artifact 保存に失敗した場合は launch されずタスクは ready のまま（docs/contract.md §12.6-3）", async () => {
    // artifactsDir の親コンポーネントをファイルにして mkdirSync を確実に失敗させる（chmod と違い root 実行でも失敗する）
    const blockerFile = join(harness.home.home, "artifacts-blocker");
    writeFileSync(blockerFile, "not a directory");
    harness.deps.env = { ...harness.deps.env, artifactsDir: join(blockerFile, "artifacts") };

    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "artifact失敗", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.blockReason).toBe("");
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
    expect(result.notes?.some((n) => n.includes("artifact保存失敗"))).toBe(true);
  });

  it("launch が throw した場合は auto-launch-failed で block する", async () => {
    harness.codexBridge.failNextRequest(500);
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "起動失敗", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason.startsWith("auto-launch-failed:")).toBe(true);

    const events = harness.store.listEvents(task.id, "launch_failed");
    expect(events).toHaveLength(1);
  });

  it.each([
    { kind: "network" as const, message: "bridge への接続に失敗しました" },
    { kind: "http" as const, message: "bridge が 500 を返しました" },
  ])("BridgeError(kind=$kind) は従来どおり auto-launch-failed で block する", async ({ kind, message }) => {
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchError = new BridgeError(message, kind);
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: `起動失敗-${kind}`, body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)?.blockReason.startsWith("auto-launch-failed:")).toBe(true);
    expect(harness.store.listEvents(task.id, "launch_failed")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "launch_indeterminate")).toHaveLength(0);
  });

  it("preflight後のlaunchが非互換を返しても同一分類でcircuitを開き自動retryしない", async () => {
    const fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchError = new Error("model is unsupported by this transport");
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "launch時非互換", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    const next = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000) + 120);

    expect(fakeCodex.launchCalls).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("incompatible_model_transport");
    expect(harness.store.listEvents(task.id, "incompatible_model_transport")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(0);
    expect(harness.store.listOpenRuns()).toHaveLength(0);
    expect(next.actions).toBe(0);
  });

  it("launch 失敗時、await 中に別 writer がタスクを遷移させていた場合は block せず stale_launch_failure を記録する（docs/contract.md §12.15-3）", async () => {
    const fakeCodex = new FakeAdapter("codex");
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "起動失敗+横取り", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    fakeCodex.launchError = new Error("起動に失敗しました");
    // adapter.launch() の await 中（auto-launch-failed block を適用する前）に別 writer が
    // タスクを横取りするケースを模擬する（orphan_session テストと同型の競合）
    fakeCodex.launchHook = (): void => {
      harness.store.block(task.id, "user-decision: 横取りされました", "other-writer");
    };
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);

    // 横取りした別 writer の状態がそのまま残り、auto-launch-failed で上書きされない
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: 横取りされました");

    // launch_failed イベントは記録されず、stale_launch_failure のみ記録される（redact 済みエラー）
    expect(harness.store.listEvents(task.id, "launch_failed")).toHaveLength(0);
    const staleEvents = harness.store.listEvents(task.id, "stale_launch_failure");
    expect(staleEvents).toHaveLength(1);
    expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({ error: expect.stringContaining("起動に失敗しました") });

    expect(result.notes?.some((n) => n.includes("stale_launch_failure"))).toBe(true);
  });

  describe("auto-launch-failed retry", () => {
    it("失敗 run が open でなければ retry し、2回目は backoff 経過後まで待つ", async () => {
      const fakeCodex = new FakeAdapter("codex");
      fakeCodex.launchError = new Error("bridge timeout");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "auto retry 対象", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(task.id, "auto-launch-failed: /api/prompt timeout", "tester");

      const firstRetry = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(firstRetry.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(1);
      const failedAgain = harness.store.getTask(task.id);
      expect(failedAgain?.status).toBe("blocked");
      expect(failedAgain?.blockReason.startsWith("auto-launch-failed:")).toBe(true);

      fakeCodex.launchError = null;
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-auto-retry-2",
        serverUrl: "http://retry-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };

      const beforeBackoff = await dispatchStage.tick(harness.deps, true, failedAgain!.updatedAt + 59);
      expect(beforeBackoff.actions).toBe(0);
      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(beforeBackoff.notes?.some((n) => n.includes("backoff 待機中"))).toBe(true);

      const afterBackoff = await dispatchStage.tick(harness.deps, true, failedAgain!.updatedAt + 60);
      expect(afterBackoff.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(2);
      expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(2);
      const relaunched = harness.store.getTask(task.id);
      expect(relaunched?.status).toBe("blocked");
      expect(relaunched?.blockReason.startsWith("codex-in-progress:")).toBe(true);
      expect(relaunched?.blockReason).toContain("sess-auto-retry-2");
    });

    it("retry 上限到達後は needs-manual へ付け替え、追加起動しない", async () => {
      const fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "retry 上限", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(task.id, "auto-launch-failed: repeated timeout", "tester");
      harness.store.addEvent(task.id, "auto_launch_retry_started", "tester", { attempt: 1 });
      harness.store.addEvent(task.id, "auto_launch_retry_started", "tester", { attempt: 2 });

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("needs-manual: auto-launch-failed retry 上限到達 (2回)");
      expect(updated?.assignee).toBe("human");
      expect(harness.store.listEvents(task.id, "auto_launch_retry_exhausted")).toHaveLength(1);
    });

    it("過去系列の retry イベントは新しい auto-launch-failed の上限判定に混ぜない", async () => {
      const fakeCodex = new FakeAdapter("codex");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-auto-retry-new-series",
        serverUrl: "http://retry-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "retry 系列リセット", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(task.id, "auto-launch-failed: old timeout", "tester");
      harness.store.addEvent(task.id, "auto_launch_retry_started", "tester", { attempt: 1 });
      harness.store.addEvent(task.id, "auto_launch_retry_started", "tester", { attempt: 2 });
      harness.store.unblock(task.id, "ready", "tester");
      harness.store.block(task.id, "auto-launch-failed: new timeout", "tester");

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
      const retryEvents = harness.store.listEvents(task.id, "auto_launch_retry_started");
      expect(retryEvents).toHaveLength(3);
      expect(JSON.parse(retryEvents[2]!.payload)).toMatchObject({ attempt: 1 });
      expect(harness.store.listEvents(task.id, "auto_launch_retry_exhausted")).toHaveLength(0);
    });

    it("open run が残る auto-launch-failed は retry せず reap に任せる", async () => {
      const fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "open run 残存", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(task.id, "auto-launch-failed: open run remains", "tester");
      harness.store.startRun(task.id, "codex", "sess-open-remains", {});

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(0);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("auto-launch-failed: open run remains");
      expect(result.notes?.some((n) => n.includes("open run") && n.includes("reap"))).toBe(true);
    });

    it("global quota で skip された retry 候補は blocked のまま retry 回数を消費しない", async () => {
      await harness.cleanup();
      harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 1 } });
      cwdDir = join(harness.home.home, "work");
      mkdirSync(cwdDir, { recursive: true });

      const fakeCodex = new FakeAdapter("codex");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-global-quota-first",
        serverUrl: "http://quota-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const first = harness.store.createTask(
        taskInput({ status: "ready", title: "通常起動が先", priority: 10, body: `cwd: ${cwdDir}` }),
        "tester",
      );
      const retry = harness.store.createTask(
        taskInput({ status: "ready", title: "retry は quota 待ち", priority: 1, body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(retry.id, "auto-launch-failed: /api/prompt timeout", "tester");

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(harness.store.getTask(first.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
      const retryAfter = harness.store.getTask(retry.id);
      expect(retryAfter?.status).toBe("blocked");
      expect(retryAfter?.blockReason).toBe("auto-launch-failed: /api/prompt timeout");
      expect(harness.store.listEvents(retry.id, "auto_launch_retry_started")).toHaveLength(0);
      expect(result.notes?.some((n) => n.includes("maxLaunchesPerTick"))).toBe(true);
    });

    it("provider quota で skip された retry 候補は blocked のまま retry 回数を消費しない", async () => {
      const fakeClaude = new FakeAdapter("claude");
      fakeClaude.launchResponse = {
        provider: "claude",
        sessionId: "sess-provider-quota-first",
        serverUrl: "http://quota-server.example",
        model: "claude-opus-4-6",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      harness.deps.adapters = { ...harness.deps.adapters, claude: fakeClaude };

      const first = harness.store.createTask(
        taskInput({ status: "ready", profile: "plan", title: "claude retry 1件目", priority: 10, body: `cwd: ${cwdDir}` }),
        "tester",
      );
      const second = harness.store.createTask(
        taskInput({ status: "ready", profile: "plan", title: "claude retry 2件目", priority: 1, body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(first.id, "auto-launch-failed: claude timeout 1", "tester");
      harness.store.block(second.id, "auto-launch-failed: claude timeout 2", "tester");

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(fakeClaude.launchCalls).toHaveLength(1);
      expect(harness.store.getTask(first.id)?.blockReason.startsWith("claude-in-progress:")).toBe(true);
      expect(harness.store.listEvents(first.id, "auto_launch_retry_started")).toHaveLength(1);
      const skipped = harness.store.getTask(second.id);
      expect(skipped?.status).toBe("blocked");
      expect(skipped?.blockReason).toBe("auto-launch-failed: claude timeout 2");
      expect(harness.store.listEvents(second.id, "auto_launch_retry_started")).toHaveLength(0);
      expect(result.notes?.some((n) => n.includes("dispatch.providerLaunchLimits.claude(1)"))).toBe(true);
    });

    it("依存ゲートで skip された retry 候補は blocked のまま retry 回数を消費しない", async () => {
      const fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const prerequisite = harness.store.createTask(
        taskInput({ status: "todo", title: "未完了の前提", body: "前提作業" }),
        "tester",
      );
      const retry = harness.store.createTask(
        taskInput({ status: "ready", title: "依存待ち retry", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(retry.id, "auto-launch-failed: dependency gated timeout", "tester");
      harness.store.link(prerequisite.id, retry.id, "depends-on");

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      const retryAfter = harness.store.getTask(retry.id);
      expect(retryAfter?.status).toBe("blocked");
      expect(retryAfter?.blockReason).toBe("auto-launch-failed: dependency gated timeout");
      expect(harness.store.listEvents(retry.id, "auto_launch_retry_started")).toHaveLength(0);
      expect(harness.store.listEvents(retry.id, "dependency_wait")).toHaveLength(1);
    });

    it("review/rework 起動失敗の auto-launch-failed は worker retry に混ぜない", async () => {
      const fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const reviewFailed = harness.store.createTask(
        taskInput({ status: "ready", title: "review 起動失敗", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(reviewFailed.id, "auto-launch-failed: レビュー起動に失敗しました (/api/prompt timeout)", "tester");
      harness.store.addEvent(reviewFailed.id, "reviewer_launch_failed", "tester", { error: "/api/prompt timeout" });

      const reworkFailed = harness.store.createTask(
        taskInput({ status: "ready", title: "rework 起動失敗", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.block(reworkFailed.id, "auto-launch-failed: rework 起動に失敗しました (/api/prompt timeout)", "tester");
      harness.store.addEvent(reworkFailed.id, "rework_launch_failed", "tester", {
        error: "/api/prompt timeout",
        attempt: 1,
      });

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.getTask(reviewFailed.id)?.blockReason).toBe(
        "auto-launch-failed: レビュー起動に失敗しました (/api/prompt timeout)",
      );
      expect(harness.store.getTask(reworkFailed.id)?.blockReason).toBe(
        "auto-launch-failed: rework 起動に失敗しました (/api/prompt timeout)",
      );
      expect(harness.store.listEvents(reviewFailed.id, "auto_launch_retry_started")).toHaveLength(0);
      expect(harness.store.listEvents(reworkFailed.id, "auto_launch_retry_started")).toHaveLength(0);
      expect(result.notes?.filter((n) => n.includes("dispatch retry 対象外"))).toHaveLength(2);
    });
  });

  describe("起動前 durable claim（docs/contract.md §12.7-1）", () => {
    it("既に claim 済み（並行変更）の ready タスクは起動せずスキップする（契約 §12.8-2, claim 自体を試みない）", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "claim済み", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      // 別プロセスが既に claim 済みの状態を再現する
      const preClaimed = harness.store.claimTask(task.id, "other-process-token", "other-supervisor");
      expect(preClaimed).toBe(true);

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // 契約 §12.8-2: claim 済み行は claim を試みずスキップするため、何も実行しておらず actions は 0
      expect(result.actions).toBe(0);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.claimLock).toBe("other-process-token");
      expect(result.notes?.some((n) => n.includes("既に claim 済み"))).toBe(true);
      expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
    });

    it("claim 済み行は起動予算を消費せず、後続の未 claim タスクが起動される（契約 §12.8-2）", async () => {
      await harness.cleanup();
      harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 1 } });
      cwdDir = join(harness.home.home, "work");
      mkdirSync(cwdDir, { recursive: true });

      const claimedHigh = harness.store.createTask(
        taskInput({ status: "ready", title: "claim済み高優先", priority: 9, body: `cwd: ${cwdDir}` }),
        "tester",
      );
      harness.store.claimTask(claimedHigh.id, "other-process-token", "other-supervisor");

      const pendingLow = harness.store.createTask(
        taskInput({ status: "ready", title: "未claim低優先", priority: 1, body: `cwd: ${cwdDir}` }),
        "tester",
      );

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // claim 済み行は予算を消費しないため、maxLaunchesPerTick=1 でも低優先タスクが起動できる
      expect(result.actions).toBe(1);
      const updatedHigh = harness.store.getTask(claimedHigh.id);
      expect(updatedHigh?.status).toBe("ready");
      expect(updatedHigh?.claimLock).toBe("other-process-token");

      const updatedLow = harness.store.getTask(pendingLow.id);
      expect(updatedLow?.status).toBe("blocked");
      expect(updatedLow?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    });

    it("claim に失敗した場合は actions を消費せず notes にのみ記録する（docs/contract.md §12.14-3）", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "claim失敗テスト", body: `cwd: ${cwdDir}` }),
        "tester",
      );

      // claimTask() 自体が並行変更により失敗するケース（他プロセスが極小window内に claim した想定）を
      // 模擬する。1回目の呼び出しのみ false を返し、それ以降は実装へ委譲する。
      const originalClaimTask = harness.store.claimTask.bind(harness.store);
      let callCount = 0;
      harness.store.claimTask = (taskId: string, claimToken: string, actor: string): boolean => {
        callCount += 1;
        if (callCount === 1 && taskId === task.id) {
          return false;
        }
        return originalClaimTask(taskId, claimToken, actor);
      };

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      harness.store.claimTask = originalClaimTask;

      // claim 失敗はスキップのみで actions を消費しない（notes 記録のみ）
      expect(result.actions).toBe(0);
      expect(result.notes?.some((n) => n.includes("claim失敗のためスキップ"))).toBe(true);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("ready");
      expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
    });

    it("claim→launch 失敗時は claim が解放され、以後の再 claim が可能になる", async () => {
      harness.codexBridge.failNextRequest(500);
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "起動失敗でclaim解放", body: `cwd: ${cwdDir}` }),
        "tester",
      );

      await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const afterFailure = harness.store.getTask(task.id);
      expect(afterFailure?.status).toBe("blocked");
      expect(afterFailure?.claimLock).toBe("");

      // 人間判断で ready へ戻すと、claim が既に解放されているため再度 claim できる
      harness.store.unblock(task.id, "ready", "human");
      const reClaimed = harness.store.claimTask(task.id, "fresh-token", "supervisor");
      expect(reClaimed).toBe(true);
      // 手動 claim を解いて dispatchStage 自身の再 dispatch が正常に成功することも確認する
      harness.store.releaseClaim(task.id, "fresh-token", "supervisor");

      const redispatched = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(redispatched.actions).toBe(1);
      const relaunched = harness.store.getTask(task.id);
      expect(relaunched?.status).toBe("blocked");
      expect(relaunched?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    });

    it("成功時の claim は ready→blocked への transition と同じ Tx でクリアされる", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "起動成功でclaimクリア", body: `cwd: ${cwdDir}` }),
        "tester",
      );

      await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.claimLock).toBe("");
    });
  });

  describe("起動後 Tx の claim 再検証（orphan 可視化, docs/contract.md §12.8-3）", () => {
    it("launch() 実行中に別 writer がタスクを変更した場合は orphan_session として記録し例外にならない", async () => {
      const fakeCodex = new FakeAdapter("codex");
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "孤児化テスト", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-orphan",
        serverUrl: "http://orphan-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      // adapter.launch() 実行中（起動後Txの前）に別 writer がタスクを横取りするケースを模擬する
      fakeCodex.launchHook = (): void => {
        harness.store.block(task.id, "user-decision: 横取りされました", "other-writer");
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // 起動自体は試みているため actions は計上される
      expect(result.actions).toBe(1);

      const events = harness.store.listEvents(task.id, "orphan_session");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        sessionId: "sess-orphan",
        serverUrl: "http://orphan-server.example",
      });

      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("孤児化しました"))).toBe(true);
      expect(comments.some((c) => c.body.includes("sess-orphan"))).toBe(true);

      // 横取りした別 writer の状態（blocked/user-decision）がそのまま残り、dispatch は上書きしない
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("user-decision: 横取りされました");

      // 孤児セッションは task_runs へ記録しない（起動済みセッションと DB の紐付けが無いことの証跡は
      // orphan_session イベント側に残す）
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

      expect(result.notes?.some((n) => n.includes("孤児化"))).toBe(true);
    });

    it("orphan 記録後も status='ready' のままなら needs-manual で fail-closed block し、次 tick の dispatch 対象にならない（docs/contract.md §12.10-2）", async () => {
      const fakeCodex = new FakeAdapter("codex");
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "孤児化fail-closedテスト", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-orphan-failclosed",
        serverUrl: "http://orphan-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      // launch() 実行中に claim_lock だけがクリアされ status='ready' のまま残る状況を模擬する
      // （stale claim の一括解放と同型の競合。他 writer が transition していないケース）
      fakeCodex.launchHook = (): void => {
        harness.store.clearStaleClaims(-1_000_000, Math.floor(Date.now() / 1000), "other-writer");
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("needs-manual:")).toBe(true);
      expect(updated?.blockReason).toContain("sess-orphan-failclosed");

      // 孤児セッションは task_runs へ記録しない
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

      // 次 tick の dispatch 対象にならない（孤児セッションの増殖を防ぐ）
      const nextTick = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(nextTick.actions).toBe(0);
    });

    it("orphan 記録後に他 token が claim 済みの場合は block せず claim を保持する（docs/contract.md §12.14-2）", async () => {
      const fakeCodex = new FakeAdapter("codex");
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "孤児化+他claimテスト", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-orphan-other-claim",
        serverUrl: "http://orphan-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: Math.floor(Date.now() / 1000),
      };
      // launch() 実行中に claim_lock が解放され、別 writer が別 token で再 claim した状況を模擬する
      // （status='ready' のまま他 token に claim されているケース）
      fakeCodex.launchHook = (): void => {
        harness.store.clearStaleClaims(-1_000_000, Math.floor(Date.now() / 1000), "other-writer");
        harness.store.claimTask(task.id, "other-writer-token", "other-supervisor");
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(result.actions).toBe(1);

      const events = harness.store.listEvents(task.id, "orphan_session");
      expect(events).toHaveLength(1);

      const updated = harness.store.getTask(task.id);
      // 他 token の claim は尊重され、block されず ready のまま claim が保持される
      expect(updated?.status).toBe("ready");
      expect(updated?.claimLock).toBe("other-writer-token");
      expect(updated?.blockReason).toBe("");

      // 孤児セッションは task_runs へ記録しない
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

      expect(result.notes?.some((n) => n.includes("他 token が claim 済み"))).toBe(true);
    });
  });

  describe("claim 後の再読込（docs/contract.md §12.11-1）", () => {
    // KanbanStore に body / model_override を直接書き換える公開 API は無いため、claim 直後に
    // dispatch が呼ぶ store.getTask() だけを「別 writer が書き換えた後の行」を返すよう差し替える。
    // pre-claim スナップショット（listByStatus 由来。差し替え前に取得済み）はそのままなので、
    // 後続の launch 結果が新しい値を反映していれば「claim 後の再読込結果を使っている」ことの証明になる
    // （supervisor.test.ts で既に使われている store メソッド差し替えと同じ手法）。
    function overrideGetTaskOnce(store: TestHarness["store"], taskId: string, patch: Partial<TaskRow>): void {
      const originalGetTask = store.getTask.bind(store);
      store.getTask = (id: string): TaskRow | null => {
        const real = originalGetTask(id);
        if (real === null || id !== taskId) {
          return real;
        }
        return { ...real, ...patch };
      };
    }

    it("claim 直前に body の cwd 行が書き換わった場合、新しい cwd で起動する（pre-claim スナップショットで launch しない）", async () => {
      // cwd 実在チェック導入後は実在するディレクトリを使用する必要がある
      const newCwdDir = join(harness.home.home, "work-new");
      mkdirSync(newCwdDir, { recursive: true });
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "cwd差し替え", body: `cwd: ${cwdDir}\n旧内容` }),
        "tester",
      );
      overrideGetTaskOnce(harness.store, task.id, { body: `cwd: ${newCwdDir}\n新内容` });

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);

      // launch に渡された cwd / prompt が claim 後の最新 body（新しい cwd）由来であることを確認する
      const promptRequest = harness.codexBridge.requests.find(
        (r) => r.path === "/api/prompt" && r.method === "POST",
      );
      expect(promptRequest).toBeDefined();
      const body = promptRequest?.body as { cwd?: string; text?: string };
      expect(body.cwd).toBe(newCwdDir);
      expect(body.text).toContain("新内容");
      expect(body.text).not.toContain("旧内容");
    });

    it("claim 後の再読込で model 解決に失敗した場合は user-decision で block し claim をクリアする", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "claim後にmodel不正化", body: `cwd: ${cwdDir}` }),
        "tester",
      );
      overrideGetTaskOnce(harness.store, task.id, { modelOverride: "not-allowed-model" });

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("user-decision: モデル解決に失敗")).toBe(true);
      // fail-closed block は ready→blocked の遷移と同一 Tx で claim をクリアする
      expect(updated?.claimLock).toBe("");
      expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
    });

    it("claim 直後の再読込で状態不一致（他 writer に横取り）を検知した場合は launch せずスキップする", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "横取りされたタスク", body: `cwd: ${cwdDir}` }),
        "tester",
      );

      // claim 直後の再読込（claimedTask 取得）の1回目だけ「別 writer に横取りされた」行を返すよう
      // 差し替える（実 DB は変更せず、dispatch がこの読み取り結果を信頼してスキップすることを検証する）
      const originalGetTask = harness.store.getTask.bind(harness.store);
      let callCount = 0;
      harness.store.getTask = (id: string): TaskRow | null => {
        callCount += 1;
        const real = originalGetTask(id);
        if (callCount === 1 && real !== null && id === task.id) {
          return { ...real, status: "blocked", claimLock: "" };
        }
        return real;
      };

      const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      harness.store.getTask = originalGetTask;

      expect(result.notes?.some((n) => n.includes("状態不一致"))).toBe(true);
      // launch も artifact 保存も行われない
      expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
      // 実 DB は変更されていない（claim_lock は claimTask により設定されたまま。reap が後で解放する）
      expect(harness.store.getTask(task.id)?.status).toBe("ready");
    });
  });
});

// direct transport（契約 §17.3）: transport=direct のタスクは directAdapters 経由で起動する。
describe("dispatchStage（direct transport, 契約 §17.3）", () => {
  let harness: TestHarness;
  let cwdDir: string;

  // direct-impl profile を含む config で harness を作る（profiles はシャローマージで丸ごと置換されるため全 profile を列挙）
  beforeEach(async () => {
    harness = await setupHarness({
      profiles: {
        plan: { provider: "claude", model: "claude-opus-4-6" },
        review: { provider: "codex", model: "gpt-5.5" },
        implement: { provider: "codex", model: "gpt-5.4" },
        docs: { provider: "claude", model: "claude-sonnet-5" },
        "direct-impl": { provider: "codex", model: "gpt-5.4", transport: "direct" },
        "direct-effort": { provider: "codex", model: "gpt-5.4", transport: "direct", effort: "high" },
      },
      modelTransportPolicies: [{
        id: "codex-direct-gpt-5.4-test",
        provider: "codex",
        model: "gpt-5.4",
        transport: "direct",
        minimumRuntimeVersion: "0.144.1",
      }],
    });
    cwdDir = join(harness.home.home, "work");
    mkdirSync(cwdDir, { recursive: true });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("transport=direct は directAdapters 経由で起動し、meta.transport=direct と G2 非表示コメントを記録する", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-abcdef0123456789",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-impl", title: "direct 実装", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    // direct adapter 経由で起動され、bridge には届いていない
    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(updated?.blockReason).toContain("server=direct");
    expect(updated?.blockReason).toContain("even-session=direct-abcdef0123456789");

    // run.meta に transport=direct / serverUrl=direct が記録される
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect(meta.transport).toBe("direct");
    expect(meta.serverUrl).toBe("direct");

    // G2 非表示コメントが1行記録される
    const hasG2Comment = harness.store
      .listComments(task.id)
      .some((c) => c.body.includes("G2") && c.body.includes("非表示"));
    expect(hasG2Comment).toBe(true);
  });

  it("directのmodel catalogがunknownでもtrusted runtime policyを満たせば起動する", async () => {
    (harness.deps as StageDepsWithCompatibilityProbe).modelTransportPreflight = {
      probe: async (provider, transport) => ({
        ok: true,
        snapshot: {
          schemaVersion: "execution-capability.v1" as const,
          provider,
          transport,
          runtime: { name: "codex-cli", version: "0.144.1", source: "local-probe" },
          capabilities: [],
          modelCatalog: { knowledge: "unknown" as const, detail: "runtime does not advertise catalog" },
          delivery: { model: "native" as const, effort: "native" as const },
          observedAt: Date.now(),
        },
      }),
    };
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-policy-supported",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };
    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-impl", title: "direct policy", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("codex-in-progress:");
  });

  it("model_override 付きタスクは profile が bridge でも direct adapter 経由で起動し modelDelivery=native を記録する", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-override012345",
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "implement", title: "override 実効", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.setModelOverride(
      task.id,
      "gpt-5.5",
      "tester",
      activeOrchestratorProvenance(harness, cwdDir, task.id, "direct-model-override"),
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect(fakeDirect.launchCalls[0]?.options.model).toBe("gpt-5.5");
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);

    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect(meta.model).toBe("gpt-5.5");
    expect(meta.modelDelivery).toBe("native");
    expect(meta.transport).toBe("direct");
  });

  it("effort_override 付きタスクは profile が bridge でも direct adapter 経由で起動し LaunchOptions.effort に載せる", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-effortoverride01",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      effortDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "implement", title: "effort override 実効", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    harness.store.setEffortOverride(
      task.id,
      "xhigh",
      "tester",
      activeOrchestratorProvenance(harness, cwdDir, task.id, "direct-effort-override"),
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect(fakeDirect.launchCalls[0]?.options.model).toBe("gpt-5.4");
    expect(fakeDirect.launchCalls[0]?.options.effort).toBe("xhigh");
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);

    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect(meta.transport).toBe("direct");
    expect(meta.effort).toBe("xhigh");
    expect(meta.effortDelivery).toBe("native");
  });

  it("transport=direct なのに directAdapters が不在なら auto-launch-failed で fail-closed する（bridge fallback 禁止）", async () => {
    // directAdapters を設定しない（deps.directAdapters は undefined のまま）
    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-impl", title: "direct 未構成", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("auto-launch-failed: direct transport 未構成");
    expect(updated?.assignee).toBe("human");

    // bridge へは一切 fallback していない
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
    // open run も作られていない
    expect(harness.store.listOpenRuns()).toHaveLength(0);
  });

  it("direct transport 未構成の auto-launch-failed retry は試行回数を記録し、上限で needs-manual にする", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-impl", title: "direct retry 上限", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const initialFailure = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(initialFailure.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toBe("auto-launch-failed: direct transport 未構成");
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(0);

    const firstRetry = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(firstRetry.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toBe("auto-launch-failed: direct transport 未構成");
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(1);

    const afterFirstRetry = harness.store.getTask(task.id);
    expect(afterFirstRetry).not.toBeNull();
    const beforeBackoff = await dispatchStage.tick(harness.deps, true, afterFirstRetry!.updatedAt + 59);
    expect(beforeBackoff.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(1);
    expect(beforeBackoff.notes?.some((n) => n.includes("backoff 待機中"))).toBe(true);

    const secondRetry = await dispatchStage.tick(harness.deps, true, afterFirstRetry!.updatedAt + 60);
    expect(secondRetry.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toBe("auto-launch-failed: direct transport 未構成");
    expect(harness.store.listEvents(task.id, "auto_launch_retry_started")).toHaveLength(2);

    const exhausted = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(exhausted.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.blockReason).toBe("needs-manual: auto-launch-failed retry 上限到達 (2回)");
    expect(updated?.assignee).toBe("human");
    expect(harness.store.listEvents(task.id, "auto_launch_retry_exhausted")).toHaveLength(1);
    expect(harness.codexBridge.requests.some((r) => r.path === "/api/prompt")).toBe(false);
  });

  it("profile.effort ありは LaunchOptions.effort に伝わり、run.meta に effort/effortDelivery が記録される（契約 §35.3）", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-effort0123456789ab",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      effortDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-effort", title: "effort 伝搬", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    // LaunchOptions.effort に profile の effort が渡っている
    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect(fakeDirect.launchCalls[0]?.options.effort).toBe("high");

    // run.meta に effort / effortDelivery が記録されている
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect(meta.effort).toBe("high");
    expect(meta.effortDelivery).toBe("native");
  });

  it("実launch echoがprofile effortのnative deliveryを欠く場合はrunへbindせず停止する", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-effort-missing",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      effortDelivery: "none",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-effort", title: "effort echo欠落", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
    expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(1);
    expect(fakeDirect.stopCalls.map((ref) => ref.sessionId)).toContain("direct-effort-missing");
  });

  it("native delivery欠落direct sessionのstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
    const fakeDirect = new FakeAdapter("codex");
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-effort-missing-unsignalable",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      effortDelivery: "none",
      startedAt: Math.floor(Date.now() / 1000),
    };
    fakeDirect.stopResponse = { stopped: false, reason: "unsignalable" };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-effort", title: "effort echo欠落 unsignalable", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
    expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(1);
    expect(fakeDirect.stopCalls.map((ref) => ref.sessionId)).toContain("direct-effort-missing-unsignalable");
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("停止を確認できませんでした");
    expect(log).toContain('"reason":"unsignalable"');
  });

  it("profile.effort 無しは LaunchOptions からも run.meta からもキー自体を省略する（契約 §35.3）", async () => {
    const fakeDirect = new FakeAdapter("codex");
    // effortDelivery を含めない SessionRef（effort 指定が無いとき adapter は記録しない）
    fakeDirect.launchResponse = {
      provider: "codex",
      sessionId: "direct-noeffort0123456789",
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.directAdapters = { codex: fakeDirect };

    const task = harness.store.createTask(
      taskInput({ status: "ready", profile: "direct-impl", title: "effort 未指定", body: `cwd: ${cwdDir}` }),
      "tester",
    );

    const result = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    // effort キーが LaunchOptions に存在しない（undefined 明示代入もされていない）
    expect(fakeDirect.launchCalls).toHaveLength(1);
    expect("effort" in fakeDirect.launchCalls[0]!.options).toBe(false);

    // run.meta にも effort / effortDelivery キーが存在しない
    const run = harness.store.getLatestOpenRun(task.id);
    expect(run).not.toBeNull();
    const meta = JSON.parse(run!.meta) as Record<string, unknown>;
    expect("effort" in meta).toBe(false);
    expect("effortDelivery" in meta).toBe(false);
  });
});
