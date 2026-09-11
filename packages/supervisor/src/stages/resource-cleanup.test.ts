import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeHostResourceAdapter,
  HACHI_LABELS,
  HostResourceAdapterError,
  type ProvisionContainerResult,
  type ProvisionNetworkResult,
} from "@hachi/adapters";
import {
  runtimeLabelsHash,
  sha256RuntimeValue,
  type RuntimeCleanupExecutionAttempt,
  type RuntimeCleanupRequestRow,
  type RuntimeResourceLeaseRow,
  type RunRow,
  type StageDeps,
} from "@hachi/core";
import { taskInput } from "@hachi/testing";
import { setupHarness, type TestHarness } from "../test-support.js";
import {
  resourceCleanupStage,
  runtimeCleanupBackoffSeconds,
  type RuntimeResourceCleanupConfig,
} from "./resource-cleanup.js";

interface CleanupDeps extends StageDeps {
  runtimeResourceCleanup: RuntimeResourceCleanupConfig;
}

interface CleanupExecutionStore {
  beginRuntimeCleanupAttempt(input: {
    requestId: string;
    executorId: string;
    executorLeaseSeconds: number;
    now?: number;
  }): RuntimeCleanupExecutionAttempt;
  markRuntimeCleanupEffectStarted(input: {
    requestId: string;
    executionNonce: string;
    executorId: string;
    executorGeneration: number;
    expectedLeaseFence: number;
    expectedMembersHash: string;
    memberId: string;
    now?: number;
  }): void;
}

interface CleanupFixture {
  request: RuntimeCleanupRequestRow;
  lease: RuntimeResourceLeaseRow;
  container: ProvisionContainerResult;
  network?: ProvisionNetworkResult;
  run?: RunRow;
}

describe("resourceCleanupStage", () => {
  let harness: TestHarness;
  let adapter: FakeHostResourceAdapter;
  let now: number;
  let clockMs: number;
  let fixtureSequence: number;

  beforeEach(async () => {
    harness = await setupHarness();
    adapter = new FakeHostResourceAdapter({ scopeKey: "cleanup-test", clock: () => now * 1_000 });
    now = 1_900_000_000;
    clockMs = 0;
    fixtureSequence = 0;
    (harness.deps as CleanupDeps).runtimeResourceCleanup = {
      mode: "enforce",
      maxRequestsPerTick: 2,
      maxContainerRemovalsPerTick: 2,
      maxNetworkRemovalsPerTick: 1,
      maxWallSecondsPerTick: 15,
      baseBackoffSeconds: 60,
      maxBackoffSeconds: 3_600,
      maxAttempts: 5,
      autoCleanupRolloutGeneration: 1,
      executorId: "cleanup-test-executor",
      adapter,
      clockMs: () => clockMs,
    };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function labels(lease: RuntimeResourceLeaseRow): Record<string, string> {
    return {
      [HACHI_LABELS.MANAGED]: "true",
      [HACHI_LABELS.EPHEMERAL]: "true",
      [HACHI_LABELS.PROVENANCE_VERSION]: "1",
      [HACHI_LABELS.LEASE_ID]: lease.id,
      [HACHI_LABELS.OBJECT_FENCE]: String(lease.fence),
      [HACHI_LABELS.BOARD]: lease.board,
      [HACHI_LABELS.TASK_ID]: lease.ownerTaskId ?? "",
      [HACHI_LABELS.RUN_ID]: "",
      [HACHI_LABELS.ORCHESTRATOR_ID]: lease.controllerOrchestratorId ?? "",
      [HACHI_LABELS.REPO_COMMON_DIR_HASH]: sha256RuntimeValue(lease.repoCommonDir),
      [HACHI_LABELS.WORKTREE_HASH]: sha256RuntimeValue(lease.canonicalWorktree),
      [HACHI_LABELS.BUNDLE_KIND]: lease.bundleKind,
      [HACHI_LABELS.ROLLOUT_GENERATION]: "1",
    };
  }

  async function createFixture(
    options: {
      network?: boolean;
      extraContainers?: number;
      cancelledOpenRun?: boolean;
      cancelStoppedBeforeCleanup?: boolean;
      cancelFailedBeforeCleanup?: boolean;
      openRunWithoutCancel?: boolean;
      expiredUnbound?: boolean;
    } = {},
  ): Promise<CleanupFixture> {
    fixtureSequence += 1;
    const cwd = join(harness.home.home, `worktree-${String(fixtureSequence)}`);
    mkdirSync(cwd, { recursive: true });
    const task = harness.store.createTask(
      taskInput({
        status: options.expiredUnbound === true ? "ready" : "todo",
        title: "cleanup fixture",
        body: `cwd: ${cwd}`,
      }),
      "tester",
    );
    const cancellationRun: RunRow | null =
      options.cancelledOpenRun === true ||
        options.cancelStoppedBeforeCleanup === true ||
        options.cancelFailedBeforeCleanup === true ||
        options.openRunWithoutCancel === true
      ? harness.store.startRun(task.id, "codex", `cleanup-cancel-${task.id}`, { serverUrl: "http://x" })
      : null;
    const orchestrator = harness.store.registerOrchestrator({
      label: `owner-${task.id}`,
      project: "hachi-kanban",
      repoCommonDir: cwd,
    });
    harness.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "postgres",
      bundleKind: "worktree_postgres",
      spec: { version: 1, requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"] },
      idempotencyKey: `${task.id}:postgres`,
    });
    const reserved = harness.store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: harness.deps.env.board,
      project: "hachi-kanban",
      repoCommonDir: cwd,
      worktree: cwd,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: options.expiredUnbound === true ? now - 1 : Math.floor(Date.now() / 1_000) + 3_600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "tester",
    });
    const lease = harness.store.claimRuntimeResourceLease(reserved.id, reserved.fence, "tester");
    const expectedLabels = {
      ...labels(lease),
      ...(cancellationRun === null ? {} : { [HACHI_LABELS.RUN_ID]: String(cancellationRun.id) }),
    };
    let network: ProvisionNetworkResult | undefined;
    if (options.network === true) {
      network = await adapter.provisionNetwork({
        scopeKey: "cleanup-test",
        name: `network-${task.id}`,
        labels: expectedLabels,
      });
      harness.store.addRuntimeResourceMember({
        leaseId: lease.id,
        expectedLeaseFence: lease.fence,
        kind: "docker_network",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: "cleanup-test",
        nativeId: network.nativeId,
        labelsHash: runtimeLabelsHash(network.labels),
        provenance: { version: 1, labels: network.labels },
        observedAt: now,
        actor: "tester",
      });
    }
    const container = await adapter.provisionContainer({
      scopeKey: "cleanup-test",
      image: "postgres:test",
      labels: expectedLabels,
      exposePorts: [5432],
      ...(network === undefined ? {} : { networkId: network.nativeId }),
    });
    const common = {
      leaseId: lease.id,
      expectedLeaseFence: lease.fence,
      state: "active" as const,
      cleanupPolicy: "auto" as const,
      managed: true,
      ephemeral: true,
      scopeKey: "cleanup-test",
      labelsHash: runtimeLabelsHash(container.labels),
      provenance: { version: 1, labels: container.labels },
      observedAt: now,
      actor: "tester",
    };
    harness.store.addRuntimeResourceMember({
      ...common,
      kind: "docker_container",
      nativeId: container.nativeId,
    });
    harness.store.addRuntimeResourceMember({
      ...common,
      kind: "tcp_port",
      hostIp: "127.0.0.1",
      hostPort: container.portMappings[0]!.hostPort,
      containerPort: 5432,
    });
    harness.store.addRuntimeResourceMember({
      ...common,
      kind: "postgres_endpoint",
      hostIp: "127.0.0.1",
      hostPort: container.portMappings[0]!.hostPort,
      containerPort: 5432,
    });
    for (let index = 0; index < (options.extraContainers ?? 0); index += 1) {
      const extra = await adapter.provisionContainer({
        scopeKey: "cleanup-test",
        image: "postgres:test",
        labels: expectedLabels,
        exposePorts: [5432],
        ...(network === undefined ? {} : { networkId: network.nativeId }),
      });
      const extraCommon = {
        ...common,
        labelsHash: runtimeLabelsHash(extra.labels),
        provenance: { version: 1, labels: extra.labels },
      };
      harness.store.addRuntimeResourceMember({
        ...extraCommon,
        kind: "docker_container",
        nativeId: extra.nativeId,
      });
    }
    let active = harness.store.transitionRuntimeResourceLease({
      leaseId: lease.id,
      expectedFence: lease.fence,
      from: "provisioning",
      to: "active",
      actor: "tester",
    });
    if (cancellationRun !== null) {
      const run = cancellationRun!;
      active = harness.store.bindRuntimeResourceLeaseRun({
        leaseId: active.id,
        expectedFence: active.fence,
        runId: run.id,
        actor: "tester",
      });
      const cancel = options.openRunWithoutCancel === true
        ? null
        : harness.store.createOrGetRunCancelRequest({
            taskId: task.id,
            runId: run.id,
            sessionId: run.sessionId,
            provider: run.provider,
            requestNonce: `cleanup-cancel-${run.id}`,
            actor: "supervisor",
            reason: "resource cleanup gate test",
            deadlineAt: now + 60,
          });
      if (options.cancelStoppedBeforeCleanup === true) {
        if (cancel === null) {
          throw new Error("cancel fixture がありません");
        }
        harness.store.transitionRunCancelRequest({
          requestId: cancel.id,
          expectedStatus: cancel.status,
          to: "stopped",
          expectedRunId: run.id,
          expectedSessionId: run.sessionId,
          expectedCancelFence: cancel.cancelFence,
          requestNonce: cancel.requestNonce,
          actor: "supervisor",
          stopEvidence: { observedSessionState: "ended", evidenceId: "test:ended" },
          now,
        });
        harness.store.endRun(run.id, "failed");
      } else if (options.cancelFailedBeforeCleanup === true) {
        if (cancel === null) {
          throw new Error("cancel fixture がありません");
        }
        harness.store.transitionRunCancelRequest({
          requestId: cancel.id,
          expectedStatus: cancel.status,
          to: "failed",
          expectedRunId: run.id,
          expectedSessionId: run.sessionId,
          expectedCancelFence: cancel.cancelFence,
          requestNonce: cancel.requestNonce,
          actor: "supervisor",
          lastError: "test exact stop unavailable",
          now,
        });
        harness.store.endRun(run.id, "failed");
      }
    }
    if (options.expiredUnbound !== true) {
      harness.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    }
    const cleanup = harness.store.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: active.id,
      expectedFence: active.fence,
      from: "active",
      terminalReason: options.expiredUnbound === true
        ? "lease_expired"
        : cancellationRun !== null &&
            options.cancelStoppedBeforeCleanup !== true &&
            options.cancelFailedBeforeCleanup !== true
          ? "explicit_release"
          : "owner_terminal",
      decisionClass: "auto",
      reason: `fixture cleanup ${task.id}`,
      actor: "tester",
    });
    return {
      request: cleanup.request,
      lease: cleanup.lease,
      container,
      ...(network === undefined ? {} : { network }),
      ...(cancellationRun === null ? {} : { run: cancellationRun }),
    };
  }

  it("durable intent 後に container を消し、その absent 確認後だけ port/endpoint を released にする", async () => {
    const fixture = await createFixture();
    let durableIntentObserved = false;
    const removeContainer = adapter.removeContainer.bind(adapter);
    adapter.removeContainer = async (params) => {
      const request = harness.store.getRuntimeCleanupRequest(fixture.request.id);
      durableIntentObserved =
        request?.status === "executing" &&
        request.executionNonce === params.executionNonce &&
        request.executorGeneration > 0;
      return removeContainer(params);
    };

    const result = await resourceCleanupStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(durableIntentObserved).toBe(true);
    expect(adapter.removeHistory.map((entry) => entry.kind)).toEqual(["container"]);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)).toMatchObject({ status: "succeeded" });
    expect(harness.store.getRuntimeResourceLease(fixture.lease.id)?.state).toBe("released");
    expect(harness.store.listRuntimeResourceMembers(fixture.lease.id).every((member) => member.state === "released")).toBe(true);
  });

  it("expiry証拠のある未bind leaseだけをexact IDでcleanupする", async () => {
    const fixture = await createFixture({ expiredUnbound: true });

    const result = await resourceCleanupStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(adapter.removeHistory).toEqual([
      expect.objectContaining({ kind: "container", nativeId: fixture.container.nativeId }),
    ]);
    expect(harness.store.getTask(fixture.lease.ownerTaskId!)?.status).toBe("ready");
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
    expect(harness.store.getRuntimeResourceLease(fixture.lease.id)?.state).toBe("released");
  });

  it("released後にexact lease配下のmanifest/passwordだけを回収する", async () => {
    const fixture = await createFixture();
    const manifestRoot = join(harness.home.home, "runtime-manifests");
    const secretDirectory = join(harness.home.home, "runtime-secrets", fixture.lease.id);
    const manifestPath = join(manifestRoot, `${fixture.lease.id}.json`);
    const passwordPath = join(secretDirectory, "postgres-password");
    mkdirSync(manifestRoot, { recursive: true, mode: 0o700 });
    mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      leaseId: fixture.lease.id,
      fence: fixture.lease.fence,
    }), { mode: 0o600 });
    writeFileSync(passwordPath, "test-secret-value\n", { mode: 0o600 });

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(passwordPath)).toBe(false);
    expect(existsSync(secretDirectory)).toBe(false);
  });

  it("cancel stop 証拠未確認の open run が owner の間は resource 解放 effect を0件にする", async () => {
    const fixture = await createFixture({ cancelledOpenRun: true });

    const result = await resourceCleanupStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(result.notes).toContainEqual(expect.stringContaining("cancel stop 証拠未確認"));
    expect(adapter.removeHistory).toHaveLength(0);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("queued");
    expect(harness.store.getRuntimeResourceLease(fixture.lease.id)?.state).toBe("cleanup_pending");

  });

  it("cancel failed後にrun/taskがclose済みでもexact stop証拠なしではresourceを解放しない", async () => {
    const fixture = await createFixture({ cancelFailedBeforeCleanup: true });

    const result = await resourceCleanupStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(adapter.removeHistory).toHaveLength(0);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("queued");
    expect(harness.store.getRuntimeResourceLease(fixture.lease.id)?.state).toBe("cleanup_pending");
  });

  it("cleanup claim取得中にcancelが作られてもeffect前再検証でremoveを0件にする", async () => {
    const fixture = await createFixture({ openRunWithoutCancel: true });
    const run = fixture.run!;
    const executionStore = harness.store as unknown as CleanupExecutionStore;
    const begin = executionStore.beginRuntimeCleanupAttempt.bind(executionStore);
    executionStore.beginRuntimeCleanupAttempt = (input) => {
      const attempt = begin(input);
      harness.store.createOrGetRunCancelRequest({
        taskId: run.taskId,
        runId: run.id,
        sessionId: run.sessionId,
        provider: run.provider,
        requestNonce: `cleanup-claim-race-${run.id}`,
        actor: "supervisor",
        reason: "cleanup claim race",
        deadlineAt: now + 60,
      });
      return attempt;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(run.taskId)?.id).toBe(run.id);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).not.toBe("succeeded");
  });

  it("cancel stopped 証拠と run close 後だけ runtime resource を解放する", async () => {
    const fixture = await createFixture({ cancelStoppedBeforeCleanup: true });

    const result = await resourceCleanupStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    expect(adapter.removeHistory).toHaveLength(1);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
    expect(harness.store.getRuntimeResourceLease(fixture.lease.id)?.state).toBe("released");
  });

  it("container→network 順で削除し、途中 kill-switch 変更は network effect を止める", async () => {
    const fixture = await createFixture({ network: true });
    const removeContainer = adapter.removeContainer.bind(adapter);
    adapter.removeContainer = async (params) => {
      const result = await removeContainer(params);
      writeFileSync(join(harness.home.home, "resource-cleanup.disabled"), "disabled\n", "utf8");
      return result;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory.map((entry) => entry.kind)).toEqual(["container"]);
    expect(await adapter.inspectNetwork(fixture.network!.nativeId, "cleanup-test")).not.toBeNull();
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("retry_wait");
    expect(harness.store.listRuntimeResourceMembers(fixture.lease.id).find((member) => member.kind === "tcp_port")?.state)
      .not.toBe("released");
  });

  it("effect 後/commit 前 crash は expired executor lease と exact-ID absent から収束する", async () => {
    const fixture = await createFixture();
    const store = harness.store as unknown as CleanupExecutionStore;
    const attempt = store.beginRuntimeCleanupAttempt({
      requestId: fixture.request.id,
      executorId: "crashed-executor",
      executorLeaseSeconds: 30,
      now,
    });
    const member = attempt.members.find((candidate) => candidate.kind === "docker_container")!;
    store.markRuntimeCleanupEffectStarted({
      requestId: fixture.request.id,
      executionNonce: attempt.executionNonce,
      executorId: "crashed-executor",
      executorGeneration: attempt.executorGeneration,
      expectedLeaseFence: attempt.request.expectedLeaseFence,
      expectedMembersHash: attempt.request.expectedMembersHash,
      memberId: member.id,
      now,
    });
    await adapter.removeContainer({
      nativeId: member.nativeId,
      scopeKey: member.scopeKey,
      expectedLabels: (JSON.parse(member.provenance) as { labels: Record<string, string> }).labels,
      executionNonce: attempt.executionNonce,
    });

    await resourceCleanupStage.tick(harness.deps, true, now + 31);

    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);
  });

  it("effect_started 証拠のない stale intent は exact-ID absent を成功扱いしない", async () => {
    const fixture = await createFixture();
    const store = harness.store as unknown as CleanupExecutionStore;
    const attempt = store.beginRuntimeCleanupAttempt({
      requestId: fixture.request.id,
      executorId: "crashed-before-effect",
      executorLeaseSeconds: 30,
      now,
    });
    const member = attempt.members.find((candidate) => candidate.kind === "docker_container")!;
    await adapter.removeContainer({
      nativeId: member.nativeId,
      scopeKey: member.scopeKey,
      expectedLabels: (JSON.parse(member.provenance) as { labels: Record<string, string> }).labels,
      executionNonce: "independent-removal",
    });

    await resourceCleanupStage.tick(harness.deps, true, now + 31);

    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("quarantined");
    expect(harness.store.listRuntimeResourceMembers(fixture.lease.id).find((candidate) => candidate.kind === "tcp_port")?.state)
      .not.toBe("released");
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);
  });

  it("remove 後の曖昧な失敗は旧 attempt の member 証拠で retry_wait から収束する", async () => {
    const fixture = await createFixture();
    const removeContainer = adapter.removeContainer.bind(adapter);
    let first = true;
    adapter.removeContainer = async (params, options) => {
      const result = await removeContainer(params, options);
      if (first) {
        first = false;
        throw new HostResourceAdapterError("remove response timeout", "inspect_failed");
      }
      return result;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);
    const retried = harness.store.getRuntimeCleanupRequest(fixture.request.id)!;
    expect(retried.status).toBe("retry_wait");
    expect(await adapter.inspectContainer(fixture.container.nativeId, "cleanup-test")).toBeNull();

    await resourceCleanupStage.tick(harness.deps, true, retried.nextAttemptAt);

    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);
  });

  it("container remove 後の曖昧な失敗も発行時に budget を消費する", async () => {
    const first = await createFixture();
    const second = await createFixture();
    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxContainerRemovalsPerTick = 1;
    const removeContainer = adapter.removeContainer.bind(adapter);
    let failNextRemove = true;
    adapter.removeContainer = async (params, options) => {
      const result = await removeContainer(params, options);
      if (failNextRemove) {
        failNextRemove = false;
        throw new HostResourceAdapterError("remove response timeout", "inspect_failed");
      }
      return result;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);
    const containerInspections = await Promise.all([
      adapter.inspectContainer(first.container.nativeId, "cleanup-test"),
      adapter.inspectContainer(second.container.nativeId, "cleanup-test"),
    ]);
    expect(containerInspections.filter((inspection) => inspection === null)).toHaveLength(1);
    expect(containerInspections.filter((inspection) => inspection !== null)).toHaveLength(1);
    const requests = [first.request.id, second.request.id]
      .map((id) => harness.store.getRuntimeCleanupRequest(id)!);
    expect(requests.every((request) => request.status === "retry_wait")).toBe(true);
    expect(requests.map((request) => request.attempts).sort()).toEqual([0, 1]);
  });

  it("network remove 後の曖昧な失敗も発行時に budget を消費する", async () => {
    const first = await createFixture({ network: true });
    const second = await createFixture({ network: true });
    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxNetworkRemovalsPerTick = 1;
    const removeNetwork = adapter.removeNetwork.bind(adapter);
    let failNextRemove = true;
    adapter.removeNetwork = async (params, options) => {
      const result = await removeNetwork(params, options);
      if (failNextRemove) {
        failNextRemove = false;
        throw new HostResourceAdapterError("remove response timeout", "inspect_failed");
      }
      return result;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory.filter((entry) => entry.kind === "network")).toHaveLength(1);
    const networkInspections = await Promise.all([
      adapter.inspectNetwork(first.network!.nativeId, "cleanup-test"),
      adapter.inspectNetwork(second.network!.nativeId, "cleanup-test"),
    ]);
    expect(networkInspections.filter((inspection) => inspection === null)).toHaveLength(1);
    expect(networkInspections.filter((inspection) => inspection !== null)).toHaveLength(1);
    const requests = [first.request.id, second.request.id]
      .map((id) => harness.store.getRuntimeCleanupRequest(id)!);
    expect(requests.every((request) => request.status === "retry_wait")).toBe(true);
    expect(requests.map((request) => request.attempts).sort()).toEqual([0, 1]);
  });

  it("retryable inspect failure は deterministic exponential backoff、最大試行で quarantine になる", async () => {
    const fixture = await createFixture();
    adapter.inspectContainer = async () => {
      throw new HostResourceAdapterError("docker unavailable", "inspect_failed");
    };

    await resourceCleanupStage.tick(harness.deps, true, now);
    const retried = harness.store.getRuntimeCleanupRequest(fixture.request.id)!;
    expect(retried.status).toBe("retry_wait");
    expect(retried.nextAttemptAt).toBe(
      now + runtimeCleanupBackoffSeconds(retried.id, 1, 60, 3_600),
    );

    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxAttempts = 2;
    await resourceCleanupStage.tick(harness.deps, true, retried.nextAttemptAt);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("quarantined");
    expect(harness.store.listPendingRuntimeResourceOutbox().some((row) => row.kind === "cleanup_exhausted")).toBe(true);
  });

  it("label mismatch と legacy/unowned 32 network は削除せず quarantine する", async () => {
    const fixture = await createFixture();
    adapter.addContainer({
      nativeId: fixture.container.nativeId,
      scopeKey: "cleanup-test",
      labels: {},
      networkIds: ["f".repeat(64)],
    });
    for (let index = 0; index < 32; index += 1) {
      adapter.addLegacyNetwork(index.toString(16).padStart(64, "0"), "cleanup-test", `legacy-${String(index)}`);
    }

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("quarantined");
    expect(adapter.removeHistory).toHaveLength(0);
    expect(adapter.networkCount).toBe(32);
  });

  it("request budget と dry-run は durable request/effect を消費しない", async () => {
    const first = await createFixture();
    const second = await createFixture();
    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxRequestsPerTick = 1;

    const dryRun = await resourceCleanupStage.tick(harness.deps, false, now);
    expect(dryRun.actions).toBe(0);
    expect(adapter.removeHistory).toHaveLength(0);
    expect(harness.store.getRuntimeCleanupRequest(first.request.id)?.status).toBe("queued");

    await resourceCleanupStage.tick(harness.deps, true, now);
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);
    expect([
      harness.store.getRuntimeCleanupRequest(first.request.id)?.status,
      harness.store.getRuntimeCleanupRequest(second.request.id)?.status,
    ].filter((status) => status === "succeeded")).toHaveLength(1);
  });

  it("member budget による分割実行は attempt を消費せず次 tick で完了する", async () => {
    const fixture = await createFixture({ extraContainers: 1 });
    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxContainerRemovalsPerTick = 1;

    await resourceCleanupStage.tick(harness.deps, true, now);
    const deferred = harness.store.getRuntimeCleanupRequest(fixture.request.id);
    expect(deferred?.status).toBe("retry_wait");
    expect(deferred?.attempts).toBe(0);
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(1);

    await resourceCleanupStage.tick(harness.deps, true, now);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
    expect(adapter.removeHistory.filter((entry) => entry.kind === "container")).toHaveLength(2);
  });

  it("並行 tick でも execution claim CAS により同一 exact effect は1回だけ実行する", async () => {
    const fixture = await createFixture();

    await Promise.all([
      resourceCleanupStage.tick(harness.deps, true, now),
      resourceCleanupStage.tick(harness.deps, true, now),
    ]);

    expect(adapter.removeHistory.filter((entry) => entry.nativeId === fixture.container.nativeId)).toHaveLength(1);
    expect(harness.store.getRuntimeCleanupRequest(fixture.request.id)?.status).toBe("succeeded");
  });

  it("wall-clock budget が inspect 中に尽きた場合も effect を発行せず retry に残す", async () => {
    const fixture = await createFixture();
    const inspectContainer = adapter.inspectContainer.bind(adapter);
    adapter.inspectContainer = async (nativeId, scopeKey) => {
      const inspection = await inspectContainer(nativeId, scopeKey);
      clockMs = 16_000;
      return inspection;
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory).toHaveLength(0);
    const request = harness.store.getRuntimeCleanupRequest(fixture.request.id);
    expect(request?.status).toBe("retry_wait");
    expect(request?.attempts).toBe(0);
    expect(request?.nextAttemptAt).toBe(now);
  });

  it("adapter I/O は tick の AbortSignal で中断され、retry/backoff に収束する", async () => {
    const fixture = await createFixture();
    (harness.deps as CleanupDeps).runtimeResourceCleanup.maxWallSecondsPerTick = 1;
    adapter.inspectContainer = async (_nativeId, _scopeKey, options) =>
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });

    const startedAt = Date.now();
    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const request = harness.store.getRuntimeCleanupRequest(fixture.request.id);
    expect(request?.status).toBe("retry_wait");
    expect(request?.attempts).toBe(1);
    expect(request?.nextAttemptAt).toBeGreaterThan(now);
    expect(adapter.removeHistory).toHaveLength(0);
  });

  it("intent 永続化中に kill-switch が変わっても external effect は発行しない", async () => {
    const fixture = await createFixture();
    const store = harness.store as unknown as CleanupExecutionStore & {
      markRuntimeCleanupEffectStarted: CleanupExecutionStore["markRuntimeCleanupEffectStarted"];
    };
    const markStarted = store.markRuntimeCleanupEffectStarted.bind(store);
    store.markRuntimeCleanupEffectStarted = (input) => {
      markStarted(input);
      writeFileSync(join(harness.home.home, "resource-cleanup.disabled"), "disabled\n", "utf8");
    };

    await resourceCleanupStage.tick(harness.deps, true, now);

    expect(adapter.removeHistory).toHaveLength(0);
    const request = harness.store.getRuntimeCleanupRequest(fixture.request.id);
    expect(request?.status).toBe("retry_wait");
    expect(request?.attempts).toBe(0);
  });
});
