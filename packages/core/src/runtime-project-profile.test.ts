import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeProjectHostAdapterSnapshot,
  assertRuntimeProjectOwnershipSnapshot,
  createRuntimeProjectHostAdapterSnapshot,
  parseRuntimeProjectProfileSnapshots,
  parseRuntimeProjectOwnershipSnapshot,
  resolveRuntimeProjectProfile,
  runtimeProjectProfileRequirementIdentityMatches,
  type RuntimeProjectPathProbe,
} from "./runtime-project-profile.js";
import { runtimeResourcesSchema } from "./config-schema.js";

function hostConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeResources: {
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      dockerContext: "hachi-test",
      worktreePostgres: {
        image: "postgres:16",
        containerPort: 5432,
        healthCheck: {
          command: ["pg_isready"],
          intervalMs: 1000,
          timeoutMs: 1000,
          retries: 3,
        },
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
      ...overrides,
    },
  };
}

function pathProbe(commonDir = "/repo/.git"): RuntimeProjectPathProbe {
  return {
    canonicalPath(path: string): string {
      return path;
    },
    gitCommonDir(): string {
      return commonDir;
    },
  };
}

describe("resolveRuntimeProjectProfile", () => {
  it("初回identityとexact retry lineageだけをprofile requirementとして受理する", () => {
    const snapshot = {
      version: 1 as const,
      profileId: "postgres-v1",
      orchestratorId: "o_owner",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
      canonicalWorktree: "/repo/worktree",
    };
    const spec = JSON.stringify({
      version: 1,
      requiredMembers: ["postgres_endpoint"],
      ownershipSnapshot: snapshot,
    });
    const original = {
      id: "rr_2222222222222222",
      taskId: "t_1234",
      name: "runtime-profile:postgres-v1",
      bundleKind: "worktree_postgres" as const,
      spec,
      status: "ready" as const,
      leaseId: "rl_1111111111111111",
      idempotencyKey: "t_1234:runtime-profile:postgres-v1",
      createdAt: 1,
      updatedAt: 1,
    };
    const retry = {
      ...original,
      id: "rr_3333333333333333",
      name: "retry-rl_1111111111111111",
      idempotencyKey: "rr_2222222222222222:retry:rl_1111111111111111",
      status: "pending" as const,
      leaseId: "",
    };
    const lookup = {
      requirement(id: string) {
        return id === original.id ? original : null;
      },
    };

    expect(runtimeProjectProfileRequirementIdentityMatches(original, snapshot)).toBe(true);
    expect(runtimeProjectProfileRequirementIdentityMatches(retry, snapshot)).toBe(false);
    expect(runtimeProjectProfileRequirementIdentityMatches(retry, snapshot, lookup)).toBe(true);
    const provisionedRetry = {
      ...retry,
      status: "failed" as const,
      leaseId: "rl_4444444444444444",
    };
    const secondRetry = {
      ...retry,
      id: "rr_5555555555555555",
      name: "retry-rl_4444444444444444",
      idempotencyKey: "rr_3333333333333333:retry:rl_4444444444444444",
    };
    expect(runtimeProjectProfileRequirementIdentityMatches(secondRetry, snapshot, {
      requirement(id: string) {
        if (id === provisionedRetry.id) {
          return provisionedRetry;
        }
        return id === original.id ? original : null;
      },
    })).toBe(true);
    expect(runtimeProjectProfileRequirementIdentityMatches({
      ...retry,
      idempotencyKey: "rr_2222222222222222:retry:rl_3333333333333333",
    }, snapshot, lookup)).toBe(false);
    expect(runtimeProjectProfileRequirementIdentityMatches({
      ...retry,
      spec: JSON.stringify({ version: 1, requiredMembers: ["docker_container"], ownershipSnapshot: snapshot }),
    }, snapshot, lookup)).toBe(false);
    expect(runtimeProjectProfileRequirementIdentityMatches({
      ...original,
      idempotencyKey: "forged:runtime-profile:postgres-v1",
    }, snapshot)).toBe(false);
  });

  it("host config・project・common-dir・worktreeがexact一致したv1 templateだけを返す", () => {
    const resolved = resolveRuntimeProjectProfile({
      config: hostConfig(),
      profileId: "postgres-v1",
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/worktree\n\n実装する",
      pathProbe: pathProbe(),
    });

    expect(resolved).toEqual({
      profileId: "postgres-v1",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
      canonicalWorktree: "/repo/worktree",
      hostAdapter: "worktreePostgres",
      requirement: {
        name: "runtime-profile:postgres-v1",
        bundleKind: "worktree_postgres",
        spec: {
          version: 1,
          requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"],
          ownershipSnapshot: {
            version: 1,
            profileId: "postgres-v1",
            orchestratorId: "o_owner",
            project: "hachi-kanban",
            repoCommonDir: "/repo/.git",
            canonicalWorktree: "/repo/worktree",
          },
          hostAdapterSnapshot: {
            version: 1,
            hostAdapter: "worktreePostgres",
            configFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      },
    });
  });

  it("profile snapshotの組をstrictに読み、body/binding/Git driftを再照合する", () => {
    const spec = {
      version: 1,
      requiredMembers: ["postgres_endpoint"],
      ownershipSnapshot: {
        version: 1,
        profileId: "postgres-v1",
        orchestratorId: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
        canonicalWorktree: "/repo/worktree",
      },
      hostAdapterSnapshot: {
        version: 1,
        hostAdapter: "worktreePostgres",
        configFingerprint: "a".repeat(64),
      },
    };
    const snapshot = parseRuntimeProjectOwnershipSnapshot(spec);
    expect(snapshot).toBeDefined();
    expect(parseRuntimeProjectProfileSnapshots(spec)).toEqual({
      ownershipSnapshot: snapshot,
      hostAdapterSnapshot: spec.hostAdapterSnapshot,
    });
    assertRuntimeProjectOwnershipSnapshot({
      snapshot: snapshot!,
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/worktree",
      pathProbe: pathProbe(),
    });

    expect(() => assertRuntimeProjectOwnershipSnapshot({
      snapshot: snapshot!,
      orchestrator: {
        id: "o_other",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/worktree",
      pathProbe: pathProbe(),
    })).toThrow(/primary binding/);
    expect(() => assertRuntimeProjectOwnershipSnapshot({
      snapshot: snapshot!,
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/other-worktree",
      pathProbe: pathProbe(),
    })).toThrow(/current Git worktree/);
    expect(() => parseRuntimeProjectOwnershipSnapshot({
      ownershipSnapshot: {
        version: 1,
        profileId: "postgres-v1",
        orchestratorId: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
        canonicalWorktree: "/repo/worktree",
        command: "./repo-script.sh",
      },
    })).toThrow(/ownership snapshot/);
    expect(() => parseRuntimeProjectProfileSnapshots({
      ...spec,
      hostAdapterSnapshot: undefined,
    })).toThrow(/snapshot の組/);
  });

  it("host adapter fingerprintをprovisionに影響する設定へ束縛しcurrent profile driftを拒否する", () => {
    const runtimeResources = runtimeResourcesSchema.parse(hostConfig().runtimeResources);
    const ownershipSnapshot = {
      version: 1 as const,
      profileId: "postgres-v1",
      orchestratorId: "o_owner",
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
      canonicalWorktree: "/repo/worktree",
    };
    const hostAdapterSnapshot = createRuntimeProjectHostAdapterSnapshot(
      runtimeResources,
      "worktreePostgres",
    );
    assertRuntimeProjectHostAdapterSnapshot({
      ownershipSnapshot,
      hostAdapterSnapshot,
      requirementBundleKind: "worktree_postgres",
      runtimeResources,
    });

    const adapterSettings = runtimeResources.worktreePostgres!;
    const driftedConfigs = [
      runtimeResourcesSchema.parse({ ...runtimeResources, dockerContext: "other-context" }),
      runtimeResourcesSchema.parse({
        ...runtimeResources,
        worktreePostgres: { ...adapterSettings, image: "postgres:17" },
      }),
      runtimeResourcesSchema.parse({
        ...runtimeResources,
        worktreePostgres: {
          ...adapterSettings,
          healthCheck: { ...adapterSettings.healthCheck, timeoutMs: 2_000 },
        },
      }),
      runtimeResourcesSchema.parse({ ...runtimeResources, projects: [] }),
    ];
    for (const current of driftedConfigs) {
      expect(() => assertRuntimeProjectHostAdapterSnapshot({
        ownershipSnapshot,
        hostAdapterSnapshot,
        requirementBundleKind: "worktree_postgres",
        runtimeResources: current,
      })).toThrow(/current host config|fingerprint/);
    }
  });

  it("unknown profileとproject mismatchを区別してfail-closedにする", () => {
    const input = {
      config: hostConfig(),
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/worktree",
      pathProbe: pathProbe(),
    };

    expect(() => resolveRuntimeProjectProfile({
      ...input,
      profileId: "missing",
    })).toThrow(/profile が見つかりません/);
    expect(() => resolveRuntimeProjectProfile({
      ...input,
      profileId: "postgres-v1",
      orchestrator: {
        ...input.orchestrator,
        project: "other-project",
      },
    })).toThrow(/project がactive orchestratorと一致しません/);
  });

  it("config/principal common-dirとworktree Git ownershipのdriftを拒否する", () => {
    const base = {
      config: hostConfig(),
      profileId: "postgres-v1",
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/other/.git",
      },
      taskBody: "cwd: /repo/worktree",
      pathProbe: pathProbe(),
    };

    expect(() => resolveRuntimeProjectProfile(base)).toThrow(/project\/common-dir/);
    expect(() => resolveRuntimeProjectProfile({
      ...base,
      orchestrator: {
        ...base.orchestrator,
        repoCommonDir: "/repo/.git",
      },
      pathProbe: pathProbe("/other/.git"),
    })).toThrow(/worktree path/);
  });

  it("body先頭以外のpathやcommand文字列をprobe・実行対象にしない", () => {
    const probe = pathProbe();
    const canonicalPath = vi.spyOn(probe, "canonicalPath");
    const gitCommonDir = vi.spyOn(probe, "gitCommonDir");

    expect(() => resolveRuntimeProjectProfile({
      config: hostConfig(),
      profileId: "postgres-v1",
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "echo setup\ncwd: /repo/worktree",
      pathProbe: probe,
    })).toThrow(/body 先頭/);

    expect(canonicalPath).toHaveBeenCalledTimes(1);
    expect(canonicalPath).toHaveBeenCalledWith("/repo/.git");
    expect(gitCommonDir).not.toHaveBeenCalled();
  });

  it("observe/provision disabledではprofileをrequirementへ解決しない", () => {
    expect(() => resolveRuntimeProjectProfile({
      config: hostConfig({ mode: "observe", provisioningEnabled: false }),
      profileId: "postgres-v1",
      orchestrator: {
        id: "o_owner",
        project: "hachi-kanban",
        repoCommonDir: "/repo/.git",
      },
      taskBody: "cwd: /repo/worktree",
      pathProbe: pathProbe(),
    })).toThrow(/provisioning が有効ではありません/);
  });
});
