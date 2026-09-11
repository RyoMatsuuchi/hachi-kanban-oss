import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RuntimeCleanupRequestRow, type RuntimeResourceMemberRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import type { RuntimeMemberInspection, RuntimeResourceInspector } from "../resource-inspector.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface ResourceStore {
  createOrGetRuntimeResourceRequirement(input: {
    taskId: string;
    name: string;
    bundleKind: "worktree_preview" | "worktree_postgres";
    spec: unknown;
    idempotencyKey: string;
  }): { id: string };
  reserveRuntimeResourceLease(input: {
    requirementId: string;
    controllerOrchestratorId: string;
    board: string;
    project: string;
    repoCommonDir: string;
    worktree: string;
    cleanupPolicy: "auto" | "orchestrator" | "human" | "never";
    managed: boolean;
    ephemeral: boolean;
    expiresAt: number | null;
    provenanceVersion: number;
    rolloutGeneration: number;
    actor: string;
  }): { id: string; fence: number };
  claimRuntimeResourceLease(leaseId: string, expectedFence: number, actor: string): { fence: number };
  addRuntimeResourceMember(input: {
    leaseId: string;
    expectedLeaseFence: number;
    kind: "docker_container" | "tcp_port" | "postgres_endpoint";
    state: "observed" | "active" | "released";
    cleanupPolicy: "auto";
    managed: boolean;
    ephemeral: boolean;
    scopeKey: string;
    nativeId?: string;
    displayName?: string;
    hostIp?: string;
    hostPort?: number;
    containerPort?: number;
    labelsHash: string;
    provenance: unknown;
    observedAt: number;
    actor: string;
  }): RuntimeResourceMemberRow;
  transitionRuntimeResourceLease(input: {
    leaseId: string;
    expectedFence: number;
    from: "provisioning";
    to: "active";
    actor: string;
  }): { fence: number };
  getRuntimeResourceLease(id: string): { state: string; fence: number; terminalReason: string } | null;
  getRuntimeCleanupRequest(id: string): RuntimeCleanupRequestRow | null;
  prepareOrchestratorHandoff(sessionId: string, generation: number, tokenHash: string, expiresAt: number): unknown;
  acceptOrchestratorHandoff(input: { oldSessionId: string; tokenHash: string }): { id: string; generation: number };
}

interface LeaseFixture {
  taskId: string;
  leaseId: string;
  fence: number;
  orchestratorId: string;
}

interface SetupLeaseOptions {
  includePort?: boolean;
  dockerPublishedPort?: boolean;
  dockerId?: string;
  containerState?: "observed" | "active" | "released";
}

function store(ctx: TestDeps): ResourceStore {
  return ctx.deps.store as unknown as ResourceStore;
}

function setupActiveLease(ctx: TestDeps, options: SetupLeaseOptions = {}): LeaseFixture {
  const task = ctx.deps.store.createTask(
    { title: "runtime resource", body: `cwd: ${ctx.deps.env.home}`, tenant: "dev", status: "ready" },
    "test",
  );
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: "resource owner",
    project: "hachi",
    repoCommonDir: ctx.deps.env.home,
  });
  const requirement = store(ctx).createOrGetRuntimeResourceRequirement({
    taskId: task.id,
    name: "preview",
    bundleKind: options.dockerPublishedPort === true ? "worktree_postgres" : "worktree_preview",
    spec: {
      version: 1,
      requiredMembers: options.dockerPublishedPort === true
        ? ["docker_container", "tcp_port", "postgres_endpoint"]
        : ["docker_container"],
    },
    idempotencyKey: `${task.id}:preview`,
  });
  const reserved = store(ctx).reserveRuntimeResourceLease({
    requirementId: requirement.id,
    controllerOrchestratorId: orchestrator.id,
    board: "dev",
    project: "hachi",
    repoCommonDir: ctx.deps.env.home,
    worktree: ctx.deps.env.home,
    cleanupPolicy: "auto",
    managed: true,
    ephemeral: true,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    provenanceVersion: 1,
    rolloutGeneration: 1,
    actor: "supervisor",
  });
  const provisioning = store(ctx).claimRuntimeResourceLease(reserved.id, reserved.fence, "supervisor");
  store(ctx).addRuntimeResourceMember({
    leaseId: reserved.id,
    expectedLeaseFence: provisioning.fence,
    kind: "docker_container",
    state: options.containerState ?? "active",
    cleanupPolicy: "auto",
    managed: true,
    ephemeral: true,
    scopeKey: "docker:test",
    nativeId: options.dockerId ?? "container-test",
    displayName: "preview-token=secret-preview-token",
    labelsHash: "a".repeat(64),
    provenance: { version: 1, labels: {} },
    observedAt: Math.floor(Date.now() / 1000),
    actor: "supervisor",
  });
  if (options.includePort === true) {
    store(ctx).addRuntimeResourceMember({
      leaseId: reserved.id,
      expectedLeaseFence: provisioning.fence,
      kind: "tcp_port",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: options.dockerPublishedPort === true ? "docker:test" : "host:local",
      nativeId: options.dockerPublishedPort === true ? "" : "pid:42:start:100:port:43123",
      displayName: "127.0.0.1:43123",
      hostIp: "127.0.0.1",
      hostPort: 43123,
      containerPort: options.dockerPublishedPort === true ? 5432 : 3000,
      labelsHash: (options.dockerPublishedPort === true ? "a" : "b").repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "supervisor",
    });
    if (options.dockerPublishedPort === true) {
      store(ctx).addRuntimeResourceMember({
        leaseId: reserved.id,
        expectedLeaseFence: provisioning.fence,
        kind: "postgres_endpoint",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: "docker:test",
        displayName: "127.0.0.1:43123",
        hostIp: "127.0.0.1",
        hostPort: 43123,
        containerPort: 5432,
        labelsHash: "a".repeat(64),
        provenance: { version: 1, labels: {} },
        observedAt: Math.floor(Date.now() / 1000),
        actor: "supervisor",
      });
    }
  }
  const active = store(ctx).transitionRuntimeResourceLease({
    leaseId: reserved.id,
    expectedFence: provisioning.fence,
    from: "provisioning",
    to: "active",
    actor: "supervisor",
  });
  return { taskId: task.id, leaseId: reserved.id, fence: active.fence, orchestratorId: orchestrator.id };
}

function parseJson(ctx: TestDeps): unknown {
  return JSON.parse(ctx.stdout.text()) as unknown;
}

function fakeInspector(): RuntimeResourceInspector {
  return {
    inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
      return Promise.resolve({
        memberId: member.id,
        available: true,
        error: "",
        portOwner: member.kind === "tcp_port" ? { pid: 42, startTime: "Fri Jul 10 10:00:00 2026", cwd: "/tmp/worktree" } : null,
        docker: member.kind === "docker_container"
          ? {
            objectId: member.nativeId,
            name: "preview",
            composeProject: "preview-project",
            composeService: "web",
            publishedPorts: [{ hostIp: "127.0.0.1", hostPort: 43123, containerPort: 5432 }],
            attachedNetworkIds: ["network-1"],
            subnets: [],
          }
          : null,
      });
    },
    inventory(): ReturnType<RuntimeResourceInspector["inventory"]> {
      return Promise.resolve({
        available: true,
        error: "",
        inspectionErrors: [],
        dockerContext: "desktop-linux",
        networks: [{
          nativeId: "legacy-network",
          displayName: "legacy-network",
          driver: "bridge",
          scope: "local",
          composeProject: "",
          composeService: "",
          attachedNativeIds: [],
          subnets: ["172.28.0.0/16"],
          hachiManaged: false,
        }],
      });
    },
  };
}

describe("hachi resource", () => {
  let ctx: TestDeps;

  beforeEach(() => {
    ctx = createTestDeps();
    ctx.deps.runtimeResourceInspector = fakeInspector();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("list/show は lease と legacy quarantine candidate を read-only 表示し、secret を redact する", async () => {
    const fixture = setupActiveLease(ctx, { includePort: true });

    await buildProgram(ctx.deps).parseAsync(["resource", "list", "--inventory", "--json"], { from: "user" });
    const list = parseJson(ctx) as {
      leases: Array<{ lease: { id: string } }>;
      inventory: { legacyCandidates: Array<{ managed: boolean; cleanupPolicy: string; state: string }> };
    };
    expect(list).not.toHaveProperty("id");
    expect(list).not.toHaveProperty("status");
    expect(list.leases).toHaveLength(1);
    expect(list.leases[0]?.lease.id).toBe(fixture.leaseId);
    expect(list.inventory.legacyCandidates).toEqual([
      expect.objectContaining({ managed: false, cleanupPolicy: "never", state: "quarantined" }),
    ]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["resource", "show", fixture.leaseId, "--json"], { from: "user" });
    const output = ctx.stdout.text();
    const show = JSON.parse(output) as {
      id: string;
      lease: { id: string };
      inspections: RuntimeMemberInspection[];
      members: Array<{ displayName: string }>;
    };
    expect(show.id).toBe(fixture.leaseId);
    expect(show.lease.id).toBe(fixture.leaseId);
    expect(show).not.toHaveProperty("status");
    expect(show.inspections).toEqual(expect.arrayContaining([
      expect.objectContaining({ portOwner: expect.objectContaining({ pid: 42, cwd: "/tmp/worktree" }) }),
      expect.objectContaining({ docker: expect.objectContaining({ composeProject: "preview-project", composeService: "web" }) }),
    ]));
    expect(show.members).toContainEqual(expect.objectContaining({ displayName: expect.stringContaining("[REDACTED]") }));
    expect(output).not.toContain("secret-preview-token");
  });

  it("request-release は既定 dry-run で、confirm 後も active lease を遷移させず fenced request だけを作る", async () => {
    const fixture = setupActiveLease(ctx);

    await buildProgram(ctx.deps).parseAsync([
      "resource", "request-release", fixture.leaseId, "--fence", String(fixture.fence), "--reason", "作業完了", "--json",
    ], { from: "user" });
    expect(parseJson(ctx)).toMatchObject({
      dryRun: true,
      transition: {
        applies: false,
        from: "active",
        to: "active",
        expectedFence: fixture.fence,
        nextFence: fixture.fence,
      },
      projectedLease: { state: "active", fence: fixture.fence, terminalReason: "" },
      projectedRequest: { decisionClass: "orchestrator", status: "queued", expectedLeaseFence: fixture.fence },
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "request-release", fixture.leaseId, "--fence", String(fixture.fence), "--reason", "作業完了", "--confirm", "--json",
    ], { from: "user" });
    const created = parseJson(ctx) as {
      id: string;
      status: string;
      dryRun: boolean;
      request: { id: string; expectedLeaseFence: number; decisionClass: string };
    };
    expect(created).toMatchObject({
      id: created.request.id,
      status: "queued",
      dryRun: false,
      request: { decisionClass: "orchestrator" },
    });
    expect(created.request.expectedLeaseFence).toBe(fixture.fence);
    expect(store(ctx).getRuntimeCleanupRequest(created.request.id)?.status).toBe("queued");
    expect(store(ctx).getRuntimeResourceLease(fixture.leaseId)).toMatchObject({
      state: "active",
      fence: fixture.fence,
      terminalReason: "",
    });
  });

  it("claim/approve/reject/release は old generation・fence mismatch・expired claim を fail-closed で拒否する", async () => {
    const fixture = setupActiveLease(ctx);
    await buildProgram(ctx.deps).parseAsync([
      "resource", "request-release", fixture.leaseId, "--fence", String(fixture.fence), "--reason", "作業完了", "--confirm", "--json",
    ], { from: "user" });
    const request = parseJson(ctx) as { request: { id: string; expectedLeaseFence: number } };
    const oldSession = ctx.deps.store.startOrchestratorSession({ orchestratorId: fixture.orchestratorId });
    const handoffHash = createHash("sha256").update("handoff").digest("hex");
    store(ctx).prepareOrchestratorHandoff(oldSession.id, oldSession.generation, handoffHash, Date.now() + 600_000);
    const current = store(ctx).acceptOrchestratorHandoff({ oldSessionId: oldSession.id, tokenHash: handoffHash });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "claim", request.request.id,
      "--session", oldSession.id,
      "--generation", String(oldSession.generation),
      "--fence", String(request.request.expectedLeaseFence),
      "--confirm",
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("generation");

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "claim", request.request.id,
      "--session", current.id,
      "--generation", String(current.generation),
      "--fence", String(request.request.expectedLeaseFence),
      "--confirm", "--json",
    ], { from: "user" });
    const claimedOutput = ctx.stdout.text();
    const claimed = JSON.parse(claimedOutput) as {
      id: string;
      status: string;
      claimTokenPath: string;
      request: { id: string; status: string };
    };
    expect(claimed).toMatchObject({ id: claimed.request.id, status: "claimed" });
    expect(claimed.request.status).toBe("claimed");
    expect(claimedOutput).not.toContain(readFileSync(claimed.claimTokenPath, "utf8").trim());
    expect(statSync(claimed.claimTokenPath).mode & 0o077).toBe(0);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "approve", request.request.id,
      "--session", current.id,
      "--generation", String(current.generation),
      "--claim-file", claimed.claimTokenPath,
      "--fence", String(request.request.expectedLeaseFence + 1),
      "--confirm",
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("fence");

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "release", request.request.id,
      "--session", current.id,
      "--generation", String(current.generation),
      "--claim-file", claimed.claimTokenPath,
      "--fence", String(request.request.expectedLeaseFence),
      "--confirm", "--json",
    ], { from: "user" });
    expect(parseJson(ctx)).toMatchObject({
      id: request.request.id,
      status: "queued",
      request: { status: "queued" },
    });
    expect(existsSync(claimed.claimTokenPath)).toBe(false);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "claim", request.request.id,
      "--session", current.id,
      "--generation", String(current.generation),
      "--fence", String(request.request.expectedLeaseFence),
      "--confirm", "--json",
    ], { from: "user" });
    const reclaimed = parseJson(ctx) as { claimTokenPath: string };
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "resource", "cleanup", "reject", request.request.id,
      "--session", current.id,
      "--generation", String(current.generation),
      "--claim-file", reclaimed.claimTokenPath,
      "--fence", String(request.request.expectedLeaseFence),
      "--reason", "token=secret-reject-token",
      "--confirm", "--json",
    ], { from: "user" });
    const rejectedOutput = ctx.stdout.text();
    expect(JSON.parse(rejectedOutput)).toMatchObject({
      id: request.request.id,
      status: "rejected",
      request: { status: "rejected", lastError: expect.stringContaining("[REDACTED]") },
    });
    expect(rejectedOutput).not.toContain("secret-reject-token");
    expect(existsSync(reclaimed.claimTokenPath)).toBe(false);
  });

  it("doctor は stale lease を read-only NG として報告し、offline では外部 inspector を呼ばない", async () => {
    const fixture = setupActiveLease(ctx);
    const resourceStore = store(ctx) as ResourceStore & {
      renewRuntimeResourceLease(input: {
        leaseId: string;
        expectedFence: number;
        controllerOrchestratorId: string;
        repoCommonDir: string;
        worktree: string;
        heartbeatAt: number;
        expiresAt: number;
        actor: string;
      }): unknown;
    };
    resourceStore.renewRuntimeResourceLease({
      leaseId: fixture.leaseId,
      expectedFence: fixture.fence,
      controllerOrchestratorId: fixture.orchestratorId,
      repoCommonDir: ctx.deps.env.home,
      worktree: ctx.deps.env.home,
      heartbeatAt: 1,
      expiresAt: 2,
      actor: "supervisor",
    });

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--offline", "--json"], { from: "user" });
    const result = parseJson(ctx) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "runtime resource lease freshness", ok: false }));
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "runtime external inspection", ok: true }));
  });

  it("doctor は live worktree_postgres の Docker ID と published port mapping を誤検出せず、raw ID を公開しない", async () => {
    const dockerId = "0123456789abcdef".repeat(4);
    setupActiveLease(ctx, {
      includePort: true,
      dockerPublishedPort: true,
      dockerId,
    });
    const defaultInspector = fakeInspector();
    const inspectedKinds: RuntimeResourceMemberRow["kind"][] = [];
    ctx.deps.runtimeResourceInspector = {
      async inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        inspectedKinds.push(member.kind);
        const inspection = await defaultInspector.inspectMember(member);
        return inspection.docker === null
          ? inspection
          : {
            ...inspection,
            docker: {
              ...inspection.docker,
              name: "postgres-token=secret-inspection-token",
            },
          };
      },
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const output = ctx.stdout.text();
    const result = JSON.parse(output) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      invalidPortIdentityMemberIds: string[];
      publishedPortMappingConflicts: Array<{ reason: string }>;
      inspections: RuntimeMemberInspection[];
    };

    expect(result.ok).toBe(true);
    expect(result.invalidPortIdentityMemberIds).toEqual([]);
    expect(result.publishedPortMappingConflicts).toEqual([]);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime external inspection",
      ok: true,
      detail: expect.stringContaining("idDrift=0 mappingDrift=0"),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime listener ownership",
      ok: true,
      detail: expect.stringContaining("checked=0"),
    }));
    expect(inspectedKinds).not.toContain("tcp_port");
    expect(result.inspections).toContainEqual(expect.objectContaining({
      docker: expect.objectContaining({
        objectId: "[REDACTED]",
        name: "postgres-token=[REDACTED]",
      }),
    }));
    expect(output).not.toContain(dockerId);
    expect(output).not.toContain("secret-inspection-token");
  });

  it("doctor は non-active docker_container を published port owner として採用しない", async () => {
    setupActiveLease(ctx, {
      includePort: true,
      dockerPublishedPort: true,
      dockerId: "observed-container",
      containerState: "observed",
    });

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
      invalidPortIdentityMemberIds: string[];
    };

    expect(result.ok).toBe(false);
    expect(result.invalidPortIdentityMemberIds).toHaveLength(1);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime port bindings",
      ok: false,
    }));
  });

  it("doctor は Docker published port の wildcard/duplicate mapping drift を fail-closed で報告する", async () => {
    setupActiveLease(ctx, {
      includePort: true,
      dockerPublishedPort: true,
      dockerId: "container-postgres",
    });
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        if (member.kind !== "docker_container") {
          return defaultInspector.inspectMember(member);
        }
        return Promise.resolve({
          memberId: member.id,
          available: true,
          error: "",
          portOwner: null,
          docker: {
            objectId: member.nativeId,
            name: "postgres",
            composeProject: "",
            composeService: "postgres",
            publishedPorts: [
              { hostIp: "127.0.0.1", hostPort: 43123, containerPort: 5432 },
              { hostIp: "0.0.0.0", hostPort: 43123, containerPort: 5432 },
            ],
            attachedNetworkIds: [],
            subnets: [],
          },
        });
      },
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      publishedPortMappingConflicts: Array<{ reason: string }>;
    };

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime external inspection",
      ok: false,
      detail: expect.stringContaining("mappingDrift=1"),
    }));
    expect(result.publishedPortMappingConflicts).toEqual([
      expect.objectContaining({ reason: "multiple_mappings" }),
    ]);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("doctor は released member を live external inspection 対象にせず、missing object を unavailable に数えない", async () => {
    setupActiveLease(ctx, {
      dockerId: "released-container",
      containerState: "released",
    });
    let inspectionCalls = 0;
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        inspectionCalls += 1;
        return Promise.resolve({
          memberId: member.id,
          available: false,
          error: "released object missing",
          portOwner: null,
          docker: null,
        });
      },
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      inspections: RuntimeMemberInspection[];
    };

    expect(result.ok).toBe(true);
    expect(inspectionCalls).toBe(0);
    expect(result.inspections).toEqual([]);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime external inspection",
      ok: true,
      detail: expect.stringContaining("members=0 unavailable=0"),
    }));
  });

  it("doctor は実 listener の PID/start-time が lease identity と異なると衝突として報告する", async () => {
    setupActiveLease(ctx, { includePort: true });

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
      listenerOwnershipConflicts: Array<{ reason: string; expectedPid: number; actualPid: number | null }>;
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "runtime listener ownership", ok: false }));
    expect(result.listenerOwnershipConflicts).toEqual([
      expect.objectContaining({ reason: "start_time_mismatch", expectedPid: 42, actualPid: 42 }),
    ]);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("doctor は listener 不在を inspection unavailable とせず ownership conflict として報告する", async () => {
    setupActiveLease(ctx, { includePort: true });
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
      inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        if (member.kind === "tcp_port") {
          return Promise.resolve({ memberId: member.id, available: true, error: "", portOwner: null, docker: null });
        }
        return defaultInspector.inspectMember(member);
      },
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      checks: Array<{ name: string; ok: boolean }>;
      listenerOwnershipConflicts: Array<{ reason: string }>;
    };
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "runtime external inspection", ok: true }));
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "runtime listener ownership", ok: false }));
    expect(result.listenerOwnershipConflicts).toEqual([expect.objectContaining({ reason: "listener_missing" })]);
  });

  it("doctor は実 listener の PID が異なる場合も衝突として報告する", async () => {
    setupActiveLease(ctx, { includePort: true });
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
      inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        if (member.kind === "tcp_port") {
          return Promise.resolve({
            memberId: member.id,
            available: true,
            error: "",
            portOwner: { pid: 99, startTime: "Fri Jul 10 10:00:00 2026", cwd: "/tmp/other-worktree" },
            docker: null,
          });
        }
        return defaultInspector.inspectMember(member);
      },
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as { listenerOwnershipConflicts: Array<{ reason: string; expectedPid: number; actualPid: number | null }> };
    expect(result.listenerOwnershipConflicts).toEqual([
      expect.objectContaining({ reason: "pid_mismatch", expectedPid: 42, actualPid: 99 }),
    ]);
  });

  it("doctor は同一portの複数listenerを衝突として報告する", async () => {
    setupActiveLease(ctx, { includePort: true });
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => defaultInspector.inventory(),
      inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
        if (member.kind === "tcp_port") {
          const expected = { pid: 42, startTime: "100", cwd: "/tmp/worktree" };
          return Promise.resolve({
            memberId: member.id,
            available: true,
            error: "",
            portOwner: expected,
            portOwners: [expected, { pid: 99, startTime: "200", cwd: "/tmp/rogue" }],
            docker: null,
          });
        }
        return defaultInspector.inspectMember(member);
      },
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as { listenerOwnershipConflicts: Array<{ reason: string; actualPid: number | null }> };
    expect(result.listenerOwnershipConflicts).toEqual([
      expect.objectContaining({ reason: "multiple_listeners", actualPid: 99 }),
    ]);
  });

  it("doctor は未知bindと不正なport owner identityをfail-closedで拒否する", async () => {
    const fixture = setupActiveLease(ctx);
    store(ctx).addRuntimeResourceMember({
      leaseId: fixture.leaseId,
      expectedLeaseFence: fixture.fence,
      kind: "tcp_port",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: "host:unknown",
      nativeId: "unknown-listener",
      displayName: "unknown",
      hostIp: "",
      hostPort: 43124,
      containerPort: 3001,
      labelsHash: "c".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "supervisor",
    });

    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--offline", "--json"], { from: "user" });
    const result = parseJson(ctx) as {
      ok: boolean;
      invalidPortIdentityMemberIds: string[];
      wildcardMemberIds: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.invalidPortIdentityMemberIds).toHaveLength(1);
    expect(result.wildcardMemberIds).toHaveLength(1);
  });

  it("doctor は Docker network inventory が不完全なら NG として報告する", async () => {
    const defaultInspector = fakeInspector();
    ctx.deps.runtimeResourceInspector = {
      inspectMember: (member): Promise<RuntimeMemberInspection> => defaultInspector.inspectMember(member),
      inventory: (): ReturnType<RuntimeResourceInspector["inventory"]> => Promise.resolve({
        available: false,
        error: "network inspect unavailable",
        inspectionErrors: ["network legacy inspect unavailable"],
        dockerContext: "desktop-linux",
        networks: [],
      }),
    };

    await buildProgram(ctx.deps).parseAsync(["resource", "list", "--inventory", "--json"], { from: "user" });
    expect(parseJson(ctx)).toMatchObject({ inventory: { available: false, legacyCandidates: [] } });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["resource", "doctor", "--json"], { from: "user" });
    const result = parseJson(ctx) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "runtime Docker inventory",
      ok: false,
      detail: expect.stringContaining("inspection に失敗"),
    }));
  });

  it("help は Docker mutator を公開しない", () => {
    const program = buildProgram(ctx.deps);
    const resource = program.commands.find((command) => command.name() === "resource");
    const help = resource?.helpInformation() ?? "";
    expect(help).not.toContain("delete");
    expect(help).not.toContain("prune");
    expect(help).not.toContain("adopt");
  });
});
