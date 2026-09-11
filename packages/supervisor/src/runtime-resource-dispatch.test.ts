import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeProjectHostAdapterSnapshot,
  runtimeResourcesSchema,
  SqliteKanbanStore,
} from "@hachi/core";
import {
  evaluateRuntimeResourceDispatchGate,
  evaluateRuntimeResourceReworkGate,
  validateRuntimeResourceBindings,
} from "./runtime-resource-dispatch.js";

describe("runtime resource dispatch binding", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launch 直前は task cwd の realpath と primary controller ownership を再取得する", () => {
    const root = mkdtempSync(join(tmpdir(), "hachi-runtime-dispatch-"));
    roots.push(root);
    const original = join(root, "original");
    const replacement = join(root, "replacement");
    const link = join(root, "worktree");
    mkdirSync(original);
    mkdirSync(replacement);
    symlinkSync(original, link);
    const dbPath = join(root, "kanban.db");
    const store = new SqliteKanbanStore(dbPath);
    try {
      const task = store.createTask({ title: "runtime", body: `cwd: ${link}`, tenant: "test", status: "ready" }, "test");
      const controller = store.registerOrchestrator({
        label: "runtime-owner",
        project: "hachi-kanban",
        repoCommonDir: original,
      });
      store.bindTaskToOrchestrator(task.id, controller.id, "primary");
      const requirement = store.createOrGetRuntimeResourceRequirement({
        taskId: task.id,
        name: "postgres",
        bundleKind: "worktree_postgres",
        spec: { version: 1, requiredMembers: ["postgres_endpoint"] },
        idempotencyKey: `${task.id}:postgres`,
      });
      const lease = store.reserveRuntimeResourceLease({
        requirementId: requirement.id,
        controllerOrchestratorId: controller.id,
        board: "test",
        project: "hachi-kanban",
        repoCommonDir: original,
        worktree: link,
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        expiresAt: 2_000_000_000,
        provenanceVersion: 1,
        rolloutGeneration: 1,
        actor: "test",
      });
      const provisioning = store.claimRuntimeResourceLease(lease.id, lease.fence, "test");
      store.addRuntimeResourceMember({
        leaseId: lease.id,
        expectedLeaseFence: provisioning.fence,
        kind: "postgres_endpoint",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: "test",
        hostIp: "127.0.0.1",
        hostPort: 49152,
        containerPort: 5432,
        labelsHash: "a".repeat(64),
        provenance: { version: 1, labels: {} },
        observedAt: 1,
        actor: "test",
      });
      store.transitionRuntimeResourceLease({
        leaseId: lease.id,
        expectedFence: provisioning.fence,
        from: "provisioning",
        to: "active",
        actor: "test",
      });
      const gate = evaluateRuntimeResourceDispatchGate(dbPath, task.id, link, 1);
      expect(gate.status).toBe("ready");
      if (gate.status !== "ready") {
        throw new Error("runtime resource gate が ready ではありません");
      }

      rmSync(link);
      symlinkSync(replacement, link);

      expect(validateRuntimeResourceBindings(store, task.id, gate.bindings, 1)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("reworkもactive leaseのhost adapter snapshotをcurrent configへexactに再照合する", () => {
    const root = mkdtempSync(join(tmpdir(), "hachi-runtime-rework-profile-"));
    roots.push(root);
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    execFileSync("git", ["init", "--quiet", worktree], { stdio: "ignore" });
    const repoCommonDir = realpathSync.native(join(worktree, ".git"));
    const canonicalWorktree = realpathSync.native(worktree);
    const runtimeResources = runtimeResourcesSchema.parse({
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      rolloutGeneration: 1,
      dockerContext: "runtime-rework-profile",
      worktreePostgres: {
        image: "postgres:test",
        containerPort: 5432,
        healthCheck: { command: ["pg_isready"], intervalMs: 1_000, timeoutMs: 1_000, retries: 3 },
      },
      projects: [{
        project: "hachi-kanban",
        repoCommonDir,
        profiles: [{
          id: "postgres-v1",
          bundleKind: "worktree_postgres",
          hostAdapter: "worktreePostgres",
        }],
      }],
    });
    const dbPath = join(root, "kanban.db");
    const store = new SqliteKanbanStore(dbPath);
    try {
      const task = store.createTask(
        { title: "runtime rework", body: `cwd: ${worktree}`, tenant: "test", status: "ready" },
        "test",
      );
      const controller = store.registerOrchestrator({
        label: "runtime-rework-owner",
        project: "hachi-kanban",
        repoCommonDir,
      });
      store.bindTaskToOrchestrator(task.id, controller.id, "primary");
      const requirement = store.createOrGetRuntimeResourceRequirement({
        taskId: task.id,
        name: "runtime-profile:postgres-v1",
        bundleKind: "worktree_postgres",
        spec: {
          version: 1,
          requiredMembers: ["postgres_endpoint"],
          ownershipSnapshot: {
            version: 1,
            profileId: "postgres-v1",
            orchestratorId: controller.id,
            project: "hachi-kanban",
            repoCommonDir,
            canonicalWorktree,
          },
          hostAdapterSnapshot: createRuntimeProjectHostAdapterSnapshot(runtimeResources, "worktreePostgres"),
        },
        idempotencyKey: `${task.id}:runtime-profile:postgres-v1`,
      });
      const reserved = store.reserveRuntimeResourceLease({
        requirementId: requirement.id,
        controllerOrchestratorId: controller.id,
        board: "test",
        project: "hachi-kanban",
        repoCommonDir,
        worktree: canonicalWorktree,
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        expiresAt: 2_000_000_000,
        provenanceVersion: 1,
        rolloutGeneration: 1,
        actor: "test",
      });
      const provisioning = store.claimRuntimeResourceLease(reserved.id, reserved.fence, "test");
      store.addRuntimeResourceMember({
        leaseId: reserved.id,
        expectedLeaseFence: provisioning.fence,
        kind: "postgres_endpoint",
        state: "active",
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        scopeKey: "runtime-rework-profile",
        hostIp: "127.0.0.1",
        hostPort: 49152,
        containerPort: 5432,
        labelsHash: "a".repeat(64),
        provenance: { version: 1, labels: {} },
        observedAt: 1,
        actor: "test",
      });
      const active = store.transitionRuntimeResourceLease({
        leaseId: reserved.id,
        expectedFence: provisioning.fence,
        from: "provisioning",
        to: "active",
        actor: "test",
      });
      const run = store.startRun(task.id, "codex", "ended-profile-owner", {});
      store.bindRuntimeResourceLeaseRun({
        leaseId: active.id,
        expectedFence: active.fence,
        runId: run.id,
        actor: "test",
      });
      store.endRun(run.id, "done");

      const currentGate = evaluateRuntimeResourceReworkGate(
        dbPath,
        task.id,
        worktree,
        1,
        runtimeResources,
      );
      expect(currentGate.status).toBe("ready");
      if (currentGate.status !== "ready") {
        throw new Error("runtime resource rework gate が ready ではありません");
      }
      const drifted = runtimeResourcesSchema.parse({
        ...runtimeResources,
        worktreePostgres: {
          ...runtimeResources.worktreePostgres!,
          image: "postgres:changed",
        },
      });

      expect(evaluateRuntimeResourceReworkGate(dbPath, task.id, worktree, 1, drifted)).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("snapshot/config drift"),
      });
      expect(validateRuntimeResourceBindings(store, task.id, currentGate.bindings, 1, true, drifted)).toBe(false);
    } finally {
      store.close();
    }
  });
});
