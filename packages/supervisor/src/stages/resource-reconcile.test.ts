import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeHostResourceAdapter,
  HostResourceAdapterError,
  type ProvisionContainerParams,
} from "@hachi/adapters";
import {
  createRuntimeProjectHostAdapterSnapshot,
  createRuntimeResourceReadView,
  runtimeResourcesSchema,
  type RuntimeResourcesConfig,
  type StageDeps,
} from "@hachi/core";
import { taskInput } from "@hachi/testing";
import { setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { resourceReconcileStage, type RuntimeResourceReconcileConfig } from "./resource-reconcile.js";

interface ReconcileDeps extends StageDeps {
  runtimeResourceReconcile: RuntimeResourceReconcileConfig;
}

describe("resourceReconcileStage", () => {
  let harness: TestHarness;
  let cwdDir: string;
  let adapter: FakeHostResourceAdapter;

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  function baseRuntimeResources(): RuntimeResourcesConfig {
    return runtimeResourcesSchema.parse({
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      rolloutGeneration: 1,
      dockerContext: "test-context",
      worktreePostgres: {
        image: "postgres:test",
        containerPort: 5432,
        healthCheck: {
          command: ["pg_isready", "-U", "hachi"],
          intervalMs: 1_000,
          timeoutMs: 1_000,
          retries: 3,
        },
      },
      projects: [],
    });
  }

  function setCurrentRuntimeResources(runtimeResources: RuntimeResourcesConfig): void {
    const reconcile = (harness.deps as ReconcileDeps).runtimeResourceReconcile;
    reconcile.runtimeResources = runtimeResources;
    reconcile.mode = runtimeResources.mode;
    reconcile.provisioningEnabled = runtimeResources.provisioningEnabled;
    reconcile.leaseTtlSeconds = runtimeResources.leaseTtlSeconds;
    if (runtimeResources.heartbeatIntervalSeconds === undefined) {
      delete reconcile.heartbeatIntervalSeconds;
    } else {
      reconcile.heartbeatIntervalSeconds = runtimeResources.heartbeatIntervalSeconds;
    }
    reconcile.rolloutGeneration = runtimeResources.rolloutGeneration ?? 1;
    reconcile.scopeKey = runtimeResources.dockerContext!;
    reconcile.worktreePostgres = runtimeResources.worktreePostgres!;
  }

  beforeEach(async () => {
    harness = await setupHarness();
    cwdDir = join(harness.home.home, "worktree");
    mkdirSync(cwdDir, { recursive: true });
    adapter = new FakeHostResourceAdapter({ scopeKey: "test-context", clock: () => 1_700_000_000_000 });
    (harness.deps as ReconcileDeps).runtimeResourceReconcile = {
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      rolloutGeneration: 1,
      scopeKey: "test-context",
      worktreePostgres: {
        image: "postgres:test",
        containerPort: 5432,
        healthCheck: {
          command: ["pg_isready", "-U", "hachi"],
          intervalMs: 1_000,
          timeoutMs: 1_000,
          retries: 3,
        },
      },
      runtimeResources: baseRuntimeResources(),
      adapter,
    };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function createPendingRequirement(): { taskId: string; requirementId: string } {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "resource reconcile", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: `owner-${task.id}`,
      project: "hachi-kanban",
      repoCommonDir: cwdDir,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "postgres",
      bundleKind: "worktree_postgres",
      spec: { version: 1, requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"] },
      idempotencyKey: `${task.id}:postgres`,
    });
    return { taskId: task.id, requirementId: requirement.id };
  }

  function createProfilePendingRequirement(): { taskId: string; requirementId: string; repoCommonDir: string } {
    execFileSync("git", ["init", "--quiet", cwdDir], {
      stdio: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    });
    const repoCommonDir = realpathSync.native(join(cwdDir, ".git"));
    const current = (harness.deps as ReconcileDeps).runtimeResourceReconcile.runtimeResources;
    const runtimeResources = runtimeResourcesSchema.parse({
      ...current,
      projects: [
        {
          project: "hachi-kanban",
          repoCommonDir,
          profiles: [
            {
              id: "postgres-v1",
              bundleKind: "worktree_postgres",
              hostAdapter: "worktreePostgres",
            },
          ],
        },
      ],
    });
    setCurrentRuntimeResources(runtimeResources);
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "profile reconcile", body: `cwd: ${cwdDir}` }),
      "tester",
    );
    const orchestrator = harness.store.registerOrchestrator({
      label: `profile-owner-${task.id}`,
      project: "hachi-kanban",
      repoCommonDir,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "runtime-profile:postgres-v1",
      bundleKind: "worktree_postgres",
      spec: {
        version: 1,
        requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"],
        ownershipSnapshot: {
          version: 1,
          profileId: "postgres-v1",
          orchestratorId: orchestrator.id,
          project: "hachi-kanban",
          repoCommonDir,
          canonicalWorktree: realpathSync.native(cwdDir),
        },
        hostAdapterSnapshot: createRuntimeProjectHostAdapterSnapshot(
          runtimeResources,
          "worktreePostgres",
        ),
      },
      idempotencyKey: `${task.id}:runtime-profile:postgres-v1`,
    });
    return { taskId: task.id, requirementId: requirement.id, repoCommonDir };
  }

  it("CAS claim→adapter provision→fresh health→active/ready を成立させる", async () => {
    const setup = createPendingRequirement();
    let provisionParams: ProvisionContainerParams | undefined;
    const provision = adapter.provisionContainer.bind(adapter);
    adapter.provisionContainer = async (params: ProvisionContainerParams) => {
      provisionParams = params;
      return provision(params);
    };

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.actions).toBe(1);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    expect(requirement?.status).toBe("ready");
    const lease = harness.store.getRuntimeResourceLease(requirement!.leaseId);
    expect(lease).toMatchObject({ state: "active", ownerTaskId: setup.taskId, ownerRunId: null });
    expect(harness.store.listRuntimeResourceMembers(lease!.id).map((member) => member.kind).sort()).toEqual([
      "docker_container",
      "postgres_endpoint",
      "tcp_port",
    ]);
    expect(adapter.containerCount).toBe(1);
    expect(adapter.removeHistory).toHaveLength(0);
    expect(provisionParams?.env).toMatchObject({
      POSTGRES_PASSWORD_FILE: "/run/secrets/hachi-postgres-password",
    });
    const mount = provisionParams?.readOnlyBindMounts?.[0];
    expect(mount?.targetPath).toBe("/run/secrets/hachi-postgres-password");
    expect(mount === undefined ? null : lstatSync(mount.sourcePath).mode & 0o077).toBe(0);
    const manifestPath = join(harness.home.home, "runtime-manifests", `${lease!.id}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      leaseId: lease!.id,
      fence: lease!.fence,
      host: "127.0.0.1",
      port: 49152,
      secretFilePath: mount?.sourcePath,
    });
    expect(manifest).not.toHaveProperty("password");
  });

  it("active leaseをhost heartbeatでrenewし、manifest fenceも原子的に追従させる", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const before = harness.store.getRuntimeResourceLease(requirement.leaseId)!;
    expect(before.heartbeatAt).toBeNull();

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 1);

    const renewed = harness.store.getRuntimeResourceLease(before.id)!;
    expect(result.notes).toContainEqual(expect.stringContaining("heartbeat/fence を更新"));
    expect(renewed).toMatchObject({
      state: "active",
      heartbeatAt: now + 1,
      expiresAt: now + 301,
      fence: before.fence + 1,
    });
    const manifest = JSON.parse(
      readFileSync(join(harness.home.home, "runtime-manifests", `${renewed.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["fence"]).toBe(renewed.fence);
    expect(adapter.containerCount).toBe(1);
  });

  it("期限切れ未bind active leaseをcleanup requestと後継requirementへ収束させる", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const lease = harness.store.getRuntimeResourceLease(requirement.leaseId)!;
    expect(lease).toMatchObject({ state: "active", ownerRunId: null, expiresAt: now + 300 });
    delete (harness.deps as Partial<ReconcileDeps>).runtimeResourceReconcile;

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 300);

    expect(result.actions).toBe(1);
    expect(result.notes).toContainEqual(expect.stringContaining("期限切れ未bind leaseをdurable cleanup/replacement"));
    expect(harness.store.getRuntimeResourceLease(lease.id)).toMatchObject({
      state: "cleanup_pending",
      ownerRunId: null,
      terminalReason: "lease_expired",
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.id)).toEqual([
      expect.objectContaining({ decisionClass: "auto", status: "queued" }),
    ]);
    expect(view.requirementsForTask(setup.taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: `retry-${lease.id}`,
        status: "pending",
        leaseId: "",
      }),
    ]));
    view.close();
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("terminal taskのactive leaseをdurable cleanup requestへ移し、後継requirementを作らない", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const lease = harness.store.getRuntimeResourceLease(requirement.leaseId)!;
    harness.store.block(setup.taskId, "needs-manual: terminal lifecycle fixture", "tester");
    harness.store.transition({ taskId: setup.taskId, to: "done", actor: "tester" });
    delete (harness.deps as unknown as {
      runtimeResourceReconcile?: RuntimeResourceReconcileConfig;
    }).runtimeResourceReconcile;

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 1);

    expect(result.notes).toContainEqual(expect.stringContaining("runtime resource config が無い"));
    expect(result.notes).toContainEqual(expect.stringContaining("durable cleanup request"));
    expect(harness.store.getRuntimeResourceLease(lease.id)).toMatchObject({
      state: "cleanup_pending",
      terminalReason: "owner_terminal",
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.id)).toHaveLength(1);
    expect(view.requirementsForTask(setup.taskId)).toHaveLength(1);
    view.close();
  });

  it("cancel stoppedとrun close後にだけleaseをcleanupへ移し、replacement requirementを分離する", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const initialLease = harness.store.getRuntimeResourceLease(requirement.leaseId)!;
    const run = harness.store.startRun(setup.taskId, "codex", "cancelled-runtime-owner", {
      serverUrl: "http://example.invalid",
    });
    const bound = harness.store.bindRuntimeResourceLeaseRun({
      leaseId: initialLease.id,
      expectedFence: initialLease.fence,
      runId: run.id,
      actor: "tester",
    });
    const cancel = harness.store.createOrGetRunCancelRequest({
      taskId: setup.taskId,
      runId: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      requestNonce: "runtime-lease-cancel-stopped",
      actor: "supervisor",
      reason: "runtime lease lifecycle test",
      deadlineAt: now + 60,
    });
    harness.store.transitionRunCancelRequest({
      requestId: cancel.id,
      expectedStatus: cancel.status,
      to: "stopped",
      expectedRunId: run.id,
      expectedSessionId: run.sessionId,
      expectedCancelFence: cancel.cancelFence,
      requestNonce: cancel.requestNonce,
      actor: "supervisor",
      stopEvidence: { observedSessionState: "ended", evidenceId: "test:exact-stop" },
      now,
    });
    harness.store.endRun(run.id, "failed");
    harness.store.block(setup.taskId, "needs-manual: cancel stopped", "supervisor");

    await resourceReconcileStage.tick(harness.deps, true, now + 1);

    expect(harness.store.getRuntimeResourceLease(bound.id)).toMatchObject({
      state: "cleanup_pending",
      ownerRunId: run.id,
      terminalReason: "explicit_release",
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(setup.taskId);
    expect(view.cleanupRequests(bound.id)).toHaveLength(1);
    expect(requirements).toHaveLength(2);
    expect(requirements).toContainEqual(expect.objectContaining({
      name: `retry-${bound.id}`,
      status: "pending",
      leaseId: "",
    }));
    view.close();
  });

  it("expiry済み未bind leaseをcleanup requestと別leaseのreplacementへ収束させる", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const originalRequirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const originalLease = harness.store.getRuntimeResourceLease(originalRequirement.leaseId)!;

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 301);

    expect(result.notes).toContainEqual(expect.stringContaining("期限切れ未bind leaseをdurable cleanup/replacement"));
    expect(harness.store.getRuntimeResourceLease(originalLease.id)).toMatchObject({
      state: "cleanup_pending",
      ownerRunId: null,
      terminalReason: "lease_expired",
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(setup.taskId);
    const replacement = requirements.find(
      (candidate) => candidate.idempotencyKey === `${originalRequirement.id}:retry:${originalLease.id}`,
    );
    expect(view.cleanupRequests(originalLease.id)).toEqual([
      expect.objectContaining({ decisionClass: "auto", status: "queued" }),
    ]);
    view.close();
    expect(replacement).toMatchObject({ status: "ready" });
    expect(replacement?.leaseId).not.toBe(originalLease.id);
    expect(harness.store.getRuntimeResourceLease(replacement!.leaseId)).toMatchObject({
      state: "active",
      ownerRunId: null,
    });
    expect(adapter.containerCount).toBe(2);
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("expiry収束時にcurrent provisioningが無効ならready永久待機にせずneeds-manualへ止める", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const originalRequirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const originalLease = harness.store.getRuntimeResourceLease(originalRequirement.leaseId)!;
    const current = (harness.deps as ReconcileDeps).runtimeResourceReconcile.runtimeResources;
    setCurrentRuntimeResources(runtimeResourcesSchema.parse({
      ...current,
      provisioningEnabled: false,
    }));

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 301);

    expect(result.notes).toContainEqual(expect.stringContaining("replacement authority不成立"));
    expect(harness.store.getRuntimeResourceLease(originalLease.id)).toMatchObject({
      state: "cleanup_pending",
      terminalReason: "lease_expired",
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringContaining("replacement authority"),
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(setup.taskId);
    expect(view.cleanupRequests(originalLease.id)).toEqual([
      expect.objectContaining({ decisionClass: "auto", status: "queued" }),
    ]);
    view.close();
    expect(requirements).toContainEqual(expect.objectContaining({
      idempotencyKey: `${originalRequirement.id}:retry:${originalLease.id}`,
      status: "pending",
      leaseId: "",
    }));
    expect(adapter.containerCount).toBe(1);
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("launch後run bind前にstale claimが解放された可能性があるleaseはauto cleanupせずneeds-manualに止める", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    await resourceReconcileStage.tick(harness.deps, true, now);
    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId)!;
    const lease = harness.store.getRuntimeResourceLease(requirement.leaseId)!;

    // adapter.launch成功直後・run bind Tx前のcrashではtask_claimedだけがdurableに残る。
    expect(harness.store.claimTask(setup.taskId, "launch-before-bind-crash", "supervisor")).toBe(true);
    const heldResult = await resourceReconcileStage.tick(harness.deps, true, now + 301);
    expect(heldResult.notes).toContainEqual(expect.stringContaining("leaseをcleanupせず保留"));
    expect(harness.store.getRuntimeResourceLease(lease.id)).toMatchObject({
      state: "active",
      ownerRunId: null,
      fence: lease.fence,
    });
    const heldView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(heldView.cleanupRequests(lease.id)).toHaveLength(0);
    heldView.close();

    // claimTask は論理時刻 now ではなく実時刻で updated_at を書くため、olderThanSec を意図的に
    // 広く取って stale 判定を決定的にする（dispatch.test.ts と同じ書き方）。閾値計算そのものは
    // packages/core/src/db.test.ts の clearStaleClaims スイートで固定している。
    expect(harness.store.clearStaleClaims(-1_000_000, now + 601, "supervisor")).toBe(1);

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 602);

    expect(result.notes).toContainEqual(expect.stringContaining("exact-session stop証拠が無いためtaskをneeds-manual"));
    expect(harness.store.getRuntimeResourceLease(lease.id)).toMatchObject({
      state: "active",
      ownerRunId: null,
      fence: lease.fence,
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringContaining("worker launch済みの可能性"),
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease.id)).toHaveLength(0);
    expect(view.requirementsForTask(setup.taskId)).toHaveLength(1);
    view.close();
    expect(adapter.containerCount).toBe(1);
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("expiry済み未bind leaseでもexact member証拠が無ければcleanupせずneeds-manualに止める", async () => {
    const setup = createPendingRequirement();
    const now = nowSeconds();
    const binding = harness.store
      .listTaskOrchestratorBindings(setup.taskId)
      .find((candidate) => candidate.role === "primary")!;
    const reserved = harness.store.reserveRuntimeResourceLease({
      requirementId: setup.requirementId,
      controllerOrchestratorId: binding.orchestratorId,
      board: harness.deps.env.board,
      project: "hachi-kanban",
      repoCommonDir: cwdDir,
      worktree: cwdDir,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: now + 1,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "tester",
    });
    const provisioning = harness.store.claimRuntimeResourceLease(reserved.id, reserved.fence, "tester");
    const active = harness.store.transitionRuntimeResourceLease({
      leaseId: provisioning.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "tester",
    });

    const result = await resourceReconcileStage.tick(harness.deps, true, now + 2);

    expect(result.notes).toContainEqual(expect.stringContaining("cleanup CASが不成立"));
    expect(harness.store.getRuntimeResourceLease(active.id)).toMatchObject({
      state: "active",
      ownerRunId: null,
      fence: active.fence,
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringContaining("期限切れ未bind runtime resource lease"),
    });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(active.id)).toHaveLength(0);
    expect(view.requirementsForTask(setup.taskId)).toHaveLength(1);
    view.close();
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("provision 直前の cwd realpath 再取得で symlink 付け替えを side effect 前に拒否する", async () => {
    const original = join(harness.home.home, "original-worktree");
    const replacement = join(harness.home.home, "replacement-worktree");
    const link = join(harness.home.home, "worktree-link");
    mkdirSync(original);
    mkdirSync(replacement);
    symlinkSync(original, link);
    cwdDir = link;
    const setup = createPendingRequirement();
    const claim = harness.store.claimRuntimeResourceLease.bind(harness.store);
    harness.store.claimRuntimeResourceLease = (...args: Parameters<typeof claim>) => {
      const lease = claim(...args);
      rmSync(link);
      symlinkSync(replacement, link);
      return lease;
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    expect(harness.store.getRuntimeResourceLease(requirement!.leaseId)?.state).toBe("failed");
    expect(adapter.containerCount).toBe(0);
  });

  it("runtime profile作成後のset-cwd driftはsnapshot外のrepoへprovisionしない", async () => {
    const setup = createProfilePendingRequirement();
    const otherWorktree = join(harness.home.home, "other-repository");
    mkdirSync(otherWorktree);
    execFileSync("git", ["init", "--quiet", otherWorktree], {
      stdio: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    });
    harness.store.updateBody(setup.taskId, `cwd: ${otherWorktree}`, "tester");

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.actions).toBe(1);
    expect(result.notes?.join(" ")).toContain("snapshot/config drift");
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)).toMatchObject({
      status: "pending",
      leaseId: "",
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringMatching(/^needs-manual: runtime profile snapshot\/config drift/),
    });
    expect(adapter.containerCount).toBe(0);
  });

  it.each([
    {
      name: "profile削除",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({ ...runtimeResources, projects: [] });
      },
    },
    {
      name: "dockerContext変更",
      mutate(runtimeResources: RuntimeResourcesConfig): RuntimeResourcesConfig {
        return runtimeResourcesSchema.parse({ ...runtimeResources, dockerContext: "other-context" });
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
  ])("runtime profile作成後の$nameは別設定でprovisionしない", async ({ mutate }) => {
    const setup = createProfilePendingRequirement();
    const current = (harness.deps as ReconcileDeps).runtimeResourceReconcile.runtimeResources;
    setCurrentRuntimeResources(mutate(current));

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.actions).toBe(1);
    expect(result.notes?.join(" ")).toContain("snapshot/config drift");
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)).toMatchObject({
      status: "pending",
      leaseId: "",
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringMatching(/^needs-manual: runtime profile snapshot\/config drift/),
    });
    expect(adapter.containerCount).toBe(0);
  });

  it("runtime profile作成後にprovisioningを無効化したcurrent configでは新規side effectを行わない", async () => {
    const setup = createProfilePendingRequirement();
    const current = (harness.deps as ReconcileDeps).runtimeResourceReconcile.runtimeResources;
    setCurrentRuntimeResources(runtimeResourcesSchema.parse({
      ...current,
      provisioningEnabled: false,
    }));

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.notes?.join(" ")).toContain("provisioning disabled");
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)).toMatchObject({
      status: "pending",
      leaseId: "",
    });
    expect(adapter.containerCount).toBe(0);
  });

  it("lease予約後のhost adapter config driftもside effect直前の再検証で拒否する", async () => {
    const setup = createProfilePendingRequirement();
    const claim = harness.store.claimRuntimeResourceLease.bind(harness.store);
    harness.store.claimRuntimeResourceLease = (...args: Parameters<typeof claim>) => {
      const lease = claim(...args);
      const current = (harness.deps as ReconcileDeps).runtimeResourceReconcile.runtimeResources;
      setCurrentRuntimeResources(runtimeResourcesSchema.parse({
        ...current,
        worktreePostgres: {
          ...current.worktreePostgres!,
          image: "postgres:changed-after-reserve",
        },
      }));
      return lease;
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    expect(harness.store.getRuntimeResourceLease(requirement!.leaseId)?.state).toBe("failed");
    expect(adapter.containerCount).toBe(0);
  });

  it("runtime profile作成後にprimary bindingが競合してもprovisionしない", async () => {
    const setup = createProfilePendingRequirement();
    const competing = harness.store.registerOrchestrator({
      label: `profile-competing-${setup.taskId}`,
      project: "hachi-kanban",
      repoCommonDir: setup.repoCommonDir,
    });
    harness.store.bindTaskToOrchestrator(setup.taskId, competing.id, "primary");

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.actions).toBe(1);
    expect(result.notes?.join(" ")).toContain("primary orchestrator/controller");
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)).toMatchObject({
      status: "pending",
      leaseId: "",
    });
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringMatching(/^needs-manual: runtime resource primary orchestrator\/controller/),
    });
    expect(adapter.containerCount).toBe(0);
  });

  it("runtime profileのpartial provision後継はprofile identityを保持し次tickで再試行する", async () => {
    const setup = createProfilePendingRequirement();
    const provisionContainer = adapter.provisionContainer.bind(adapter);
    let provisionCalls = 0;
    adapter.provisionContainer = async (params: ProvisionContainerParams) => {
      provisionCalls += 1;
      if (provisionCalls === 1) {
        throw new HostResourceAdapterError("simulated profile partial failure", "inspect_failed", {
          kind: "docker_container",
          nativeId: "b".repeat(64),
          scopeKey: params.scopeKey,
          labels: params.labels,
        });
      }
      return provisionContainer(params);
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const pendingView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const pendingRequirements = pendingView.requirementsForTask(setup.taskId);
    pendingView.close();
    const original = pendingRequirements.find((requirement) => requirement.id === setup.requirementId);
    const replacement = pendingRequirements.find((requirement) => requirement.status === "pending");
    expect(pendingRequirements).toHaveLength(2);
    expect(replacement).toMatchObject({
      name: `retry-${original?.leaseId}`,
      idempotencyKey: `${setup.requirementId}:retry:${original?.leaseId}`,
    });

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds() + 1);

    const readyView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const readyRequirements = readyView.requirementsForTask(setup.taskId);
    readyView.close();
    expect(provisionCalls).toBe(2);
    expect(readyRequirements).toContainEqual(expect.objectContaining({
      name: `retry-${original?.leaseId}`,
      status: "ready",
    }));
  });

  it("secret 準備中に controller ownership が変わった場合は adapter side effect を行わない", async () => {
    const setup = createPendingRequirement();
    const getLease = harness.store.getRuntimeResourceLease.bind(harness.store);
    let changed = false;
    harness.store.getRuntimeResourceLease = (leaseId: string) => {
      if (!changed) {
        changed = true;
        const competing = harness.store.registerOrchestrator({
          label: `competing-${setup.taskId}`,
          project: "hachi-kanban",
          repoCommonDir: cwdDir,
        });
        harness.store.bindTaskToOrchestrator(setup.taskId, competing.id, "primary");
      }
      return getLease(leaseId);
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    expect(harness.store.getRuntimeResourceLease(requirement!.leaseId)?.state).toBe("failed");
    expect(adapter.containerCount).toBe(0);
  });

  it("並行 tick の requirement claim 競合でも provision は1回だけ行う", async () => {
    const setup = createPendingRequirement();

    await Promise.all([
      resourceReconcileStage.tick(harness.deps, true, nowSeconds()),
      resourceReconcileStage.tick(harness.deps, true, nowSeconds()),
    ]);

    expect(adapter.containerCount).toBe(1);
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)?.status).toBe("ready");
  });

  it("resource-reconcile.disabled は最初の adapter side effect より前に停止する", async () => {
    const setup = createPendingRequirement();
    writeFileSync(join(harness.home.home, "resource-reconcile.disabled"), "disabled\n", "utf8");

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.skipped).toBe(true);
    expect(adapter.containerCount).toBe(0);
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)?.status).toBe("pending");
  });

  it("config 欠如時は observe-only で既存 task/resource を変更しない", async () => {
    const setup = createPendingRequirement();
    delete (harness.deps as Partial<ReconcileDeps>).runtimeResourceReconcile;

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(result.actions).toBe(0);
    expect(result.notes?.join(" ")).toContain("observe-only");
    expect(harness.store.getRuntimeResourceRequirement(setup.requirementId)?.status).toBe("pending");
    expect(adapter.containerCount).toBe(0);
  });

  it("side effect 前の枯渇は durable 後継要求を残し、同一 tick の追加 provision を止める", async () => {
    const first = createPendingRequirement();
    const second = createPendingRequirement();
    let provisionCalls = 0;
    adapter.provisionContainer = async () => {
      provisionCalls += 1;
      throw new HostResourceAdapterError("host port が枯渇しています", "invalid_port");
    };

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    expect(provisionCalls).toBe(1);
    expect(result.actions).toBe(1);
    expect(result.notes?.join(" ")).toContain("backpressure");
    const requirementStatuses = [first, second].map((entry) =>
      harness.store.getRuntimeResourceRequirement(entry.requirementId)?.status
    );
    expect([...requirementStatuses].sort()).toEqual(["failed", "pending"]);
    const failedTask = requirementStatuses[0] === "failed" ? first : second;
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.requirementsForTask(failedTask.taskId).some((row) => row.status === "pending")).toBe(true);
    view.close();
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("継続する pre-create 枯渇は retry と DB 行を上限で止め、未使用 password file を残さない", async () => {
    const setup = createPendingRequirement();
    let provisionCalls = 0;
    adapter.provisionContainer = async () => {
      provisionCalls += 1;
      throw new HostResourceAdapterError("Docker address pool が枯渇しています", "invalid_id");
    };

    for (let tick = 0; tick < 5; tick += 1) {
      await resourceReconcileStage.tick(harness.deps, true, nowSeconds() + tick);
    }

    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(setup.taskId);
    view.close();
    expect(provisionCalls).toBe(3);
    expect(requirements).toHaveLength(3);
    expect(requirements.every((requirement) => requirement.status === "failed")).toBe(true);
    expect(requirements.map((requirement) => requirement.leaseId).filter((leaseId) => leaseId !== "")).toHaveLength(3);
    expect(readdirSync(join(harness.home.home, "runtime-secrets"))).toEqual([]);
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("恒久的な pre-create 検証失敗は backpressure 化せず fail-closed にする", async () => {
    const setup = createPendingRequirement();
    adapter.provisionContainer = async () => {
      throw new HostResourceAdapterError("container provision 引数が不正です", "invalid_argument");
    };

    const result = await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    const requirements = view.requirementsForTask(setup.taskId);
    view.close();
    expect(result.notes?.join(" ")).not.toContain("backpressure");
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.status).toBe("failed");
    expect(readdirSync(join(harness.home.home, "runtime-secrets"))).toEqual([]);
    expect(adapter.removeHistory).toHaveLength(0);

    const dispatchResult = await dispatchStage.tick(harness.deps, true, nowSeconds());
    expect(dispatchResult.actions).toBe(1);
    expect(harness.store.getTask(setup.taskId)).toMatchObject({
      status: "blocked",
      blockReason: expect.stringMatching(/^needs-manual: runtime resource requirement が failed/),
    });
  });

  it("adapter の部分失敗は作成済み exact ID を member 化して cleanup request を残す", async () => {
    const setup = createPendingRequirement();
    adapter.provisionContainer = async (params: ProvisionContainerParams) => {
      throw new HostResourceAdapterError("simulated partial failure", "inspect_failed", {
        kind: "docker_container",
        nativeId: "a".repeat(64),
        scopeKey: params.scopeKey,
        labels: params.labels,
      });
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    expect(requirement?.status).toBe("provisioning");
    const lease = harness.store.getRuntimeResourceLease(requirement!.leaseId);
    expect(lease?.state).toBe("cleanup_pending");
    expect(harness.store.listRuntimeResourceMembers(lease!.id)).toHaveLength(1);
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease!.id)).toHaveLength(1);
    expect(view.requirementsForTask(setup.taskId).some((row) => row.status === "pending")).toBe(true);
    view.close();
    expect(adapter.removeHistory).toHaveLength(0);

    const retryAdapter = new FakeHostResourceAdapter({ scopeKey: "test-context" });
    (harness.deps as ReconcileDeps).runtimeResourceReconcile.adapter = retryAdapter;
    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());
    const retryView = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(retryView.requirementsForTask(setup.taskId).some((row) => row.status === "ready")).toBe(true);
    retryView.close();
    expect(retryAdapter.containerCount).toBe(1);
  });

  it("adapter 成功後の最初の member 永続化失敗でも exact ID を atomic cleanup request へ残す", async () => {
    const setup = createPendingRequirement();
    const addMember = harness.store.addRuntimeResourceMember.bind(harness.store);
    let failedOnce = false;
    harness.store.addRuntimeResourceMember = (input: Parameters<typeof addMember>[0]) => {
      if (!failedOnce && input.kind === "docker_container") {
        failedOnce = true;
        throw new Error("simulated first member persistence failure");
      }
      return addMember(input);
    };

    await resourceReconcileStage.tick(harness.deps, true, nowSeconds());

    const requirement = harness.store.getRuntimeResourceRequirement(setup.requirementId);
    const lease = harness.store.getRuntimeResourceLease(requirement!.leaseId);
    const members = harness.store.listRuntimeResourceMembers(lease!.id);
    expect(lease?.state).toBe("cleanup_pending");
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ kind: "docker_container", nativeId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const view = createRuntimeResourceReadView(harness.deps.env.dbPath);
    expect(view.cleanupRequests(lease!.id)).toHaveLength(1);
    view.close();
  });
});
