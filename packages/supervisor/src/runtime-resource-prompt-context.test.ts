import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "@hachi/core";
import { readRuntimeResourcePromptContext } from "./runtime-resource-prompt-context.js";

describe("readRuntimeResourcePromptContext", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ready requirementに紐づくactive・未bind・同一worktree leaseだけを返す", () => {
    const root = mkdtempSync(join(tmpdir(), "hachi-runtime-prompt-"));
    roots.push(root);
    const worktree = join(root, "worktree");
    const otherWorktree = join(root, "other");
    mkdirSync(worktree);
    mkdirSync(otherWorktree);
    const dbPath = join(root, "kanban.db");
    const store = new SqliteKanbanStore(dbPath);
    try {
      const task = store.createTask({ title: "runtime", body: `cwd: ${worktree}`, tenant: "test" }, "test");
      const orchestrator = store.registerOrchestrator({
        label: "runtime-owner",
        project: "hachi-kanban",
        repoCommonDir: worktree,
      });
      const requirement = store.createOrGetRuntimeResourceRequirement({
        taskId: task.id,
        name: "postgres",
        bundleKind: "worktree_postgres",
        spec: { version: 1, requiredMembers: ["postgres_endpoint"] },
        idempotencyKey: `${task.id}:postgres`,
      });
      const lease = store.reserveRuntimeResourceLease({
        requirementId: requirement.id,
        controllerOrchestratorId: orchestrator.id,
        board: "test",
        project: "hachi-kanban",
        repoCommonDir: worktree,
        worktree,
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
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
      const active = store.transitionRuntimeResourceLease({
        leaseId: lease.id,
        expectedFence: provisioning.fence,
        from: "provisioning",
        to: "active",
        actor: "test",
      });
      const secretDirectory = join(root, "runtime-secrets", active.id);
      const manifestDirectory = join(root, "runtime-manifests");
      mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(manifestDirectory, { mode: 0o700 });
      const secretFilePath = join(secretDirectory, "postgres-password");
      writeFileSync(secretFilePath, "test-only-password\n", { mode: 0o600 });
      const manifestPath = join(manifestDirectory, `${active.id}.json`);
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        leaseId: active.id,
        fence: active.fence,
        host: "127.0.0.1",
        port: 49152,
        database: "hachi_test",
        role: "hachi_test",
        secretFilePath,
      }), { mode: 0o600 });

      expect(readRuntimeResourcePromptContext(dbPath, root, task, worktree)).toEqual({
        manifestPath,
        leases: [{ leaseId: active.id, bundleKind: "worktree_postgres", fence: active.fence }],
      });
      expect(readRuntimeResourcePromptContext(dbPath, root, task, otherWorktree)).toBeUndefined();

      store.transitionRuntimeResourceLease({
        leaseId: active.id,
        expectedFence: active.fence,
        from: "active",
        to: "quarantined",
        actor: "test",
      });
      expect(readRuntimeResourcePromptContext(dbPath, root, task, worktree)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
