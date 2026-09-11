import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner, CommandRunnerResult } from "@hachi/adapters";
import { setupHarness, type TestHarness } from "./test-support.js";
import {
  createRuntimeResourceCleanupConfigReloader,
  loadRuntimeResourceCleanupConfig,
  loadRuntimeResourceReconcileConfig,
  SystemCommandRunner,
} from "./runtime-resource-config.js";

class NoopCommandRunner implements CommandRunner {
  run(argv: readonly string[]): Promise<CommandRunnerResult> {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: `not invoked: ${String(argv.length)}` });
  }
}

describe("loadRuntimeResourceReconcileConfig", () => {
  let harness: TestHarness;
  let configPath: string;

  beforeEach(async () => {
    harness = await setupHarness();
    mkdirSync(harness.home.home, { recursive: true });
    configPath = join(harness.home.home, "runtime-config.json");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("runtimeResources enforce 設定を production adapter 付き stage config に変換する", () => {
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: {
        mode: "enforce",
        provisioningEnabled: true,
        leaseTtlSeconds: 300,
        dockerContext: "hachi-test",
        rolloutGeneration: 2,
        worktreePostgres: {
          image: "postgres:16",
          containerPort: 5432,
          healthCheck: { command: ["pg_isready"], intervalMs: 1000, timeoutMs: 1000, retries: 3 },
        },
        projects: [
          {
            project: "hachi-kanban",
            repoCommonDir: "/repo/.git",
            profiles: [
              {
                id: "postgres-v1",
                bundleKind: "worktree_postgres",
                hostAdapter: "worktreePostgres",
              },
            ],
          },
        ],
      },
    }), "utf8");

    const config = loadRuntimeResourceReconcileConfig(configPath, new NoopCommandRunner());

    expect(config).toMatchObject({
      mode: "enforce",
      provisioningEnabled: true,
      scopeKey: "hachi-test",
      rolloutGeneration: 2,
      runtimeResources: {
        projects: [
          {
            project: "hachi-kanban",
            profiles: [
              {
                id: "postgres-v1",
                hostAdapter: "worktreePostgres",
              },
            ],
          },
        ],
      },
    });
    expect(config?.adapter).toBeDefined();
  });

  it("section 欠如と observe mode は adapter を注入しない", () => {
    writeFileSync(configPath, JSON.stringify({}), "utf8");
    expect(loadRuntimeResourceReconcileConfig(configPath, new NoopCommandRunner())).toBeUndefined();
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: { mode: "observe", provisioningEnabled: false, leaseTtlSeconds: 300 },
    }), "utf8");
    expect(loadRuntimeResourceReconcileConfig(configPath, new NoopCommandRunner())).toBeUndefined();
  });

  it("enforce/provision で adapter 設定が欠ける場合は fail-closed に拒否する", () => {
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: { mode: "enforce", provisioningEnabled: true, leaseTtlSeconds: 300 },
    }), "utf8");
    expect(() => loadRuntimeResourceReconcileConfig(configPath, new NoopCommandRunner())).toThrow(/必須/);
  });

  it("enforce cleanup 設定を production adapter 付き stage config に変換する", () => {
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: {
        mode: "enforce",
        provisioningEnabled: false,
        leaseTtlSeconds: 300,
        dockerContext: "hachi-test",
        cleanup: {
          maxRequestsPerTick: 2,
          maxContainerRemovalsPerTick: 2,
          maxNetworkRemovalsPerTick: 1,
          maxWallSecondsPerTick: 15,
          baseBackoffSeconds: 60,
          maxBackoffSeconds: 3600,
          maxAttempts: 5,
          autoCleanupRolloutGeneration: 2,
        },
      },
    }), "utf8");

    expect(loadRuntimeResourceCleanupConfig(configPath, new NoopCommandRunner(), "test-executor")).toMatchObject({
      mode: "enforce",
      executorId: "test-executor",
      maxAttempts: 5,
      autoCleanupRolloutGeneration: 2,
    });
  });

  it("cleanup reloaderはcurrent configの削除・context変更をtick境界で反映する", () => {
    const runtimeResources = {
      mode: "enforce",
      provisioningEnabled: false,
      leaseTtlSeconds: 300,
      dockerContext: "context-a",
      cleanup: {
        maxRequestsPerTick: 2,
        maxContainerRemovalsPerTick: 2,
        maxNetworkRemovalsPerTick: 1,
        maxWallSecondsPerTick: 15,
        baseBackoffSeconds: 60,
        maxBackoffSeconds: 3600,
        maxAttempts: 5,
        autoCleanupRolloutGeneration: 2,
      },
    };
    writeFileSync(configPath, JSON.stringify({ runtimeResources }), "utf8");
    const reload = createRuntimeResourceCleanupConfigReloader(
      configPath,
      new NoopCommandRunner(),
      "reload-executor",
    );

    expect(reload()).toMatchObject({ mode: "enforce", executorId: "reload-executor" });
    writeFileSync(configPath, JSON.stringify({
      runtimeResources: { ...runtimeResources, dockerContext: "context-b" },
    }), "utf8");
    expect(reload()?.adapter).toBeDefined();
    writeFileSync(configPath, JSON.stringify({}), "utf8");
    expect(reload()).toBeUndefined();
  });

  it("production command runner は AbortSignal で child process を中断する", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new SystemCommandRunner().run(
      [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      { signal: controller.signal },
    );

    expect(result.exitCode).not.toBe(0);
  });
});
