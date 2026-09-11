import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeLeaseTransition,
  canonicalizeRuntimeOwnerPaths,
  evaluateRuntimeAutoCleanup,
  normalizeRuntimeRequirementSpec,
  runtimeLabelsHash,
  sha256RuntimeValue,
  verifyRuntimeResourceProvenance,
  type RuntimeAutoCleanupEvidence,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceMemberRow,
} from "./runtime-resources.js";

describe("runtime resource lease transition", () => {
  it("証拠付き専用APIが必要な released と quarantine解除を汎用遷移から拒否する", () => {
    expect(() => assertRuntimeLeaseTransition("releasing", "released")).toThrow(/不正な遷移/);
    expect(() => assertRuntimeLeaseTransition("quarantined", "cleanup_pending")).toThrow(/不正な遷移/);
  });
});

function eligibleEvidence(): RuntimeAutoCleanupEvidence {
  return {
    leaseManaged: true,
    memberManaged: true,
    leaseEphemeral: true,
    memberEphemeral: true,
    leaseCleanupPolicy: "auto",
    memberCleanupPolicy: "auto",
    provenanceVerified: true,
    unused: true,
    ownerTerminal: true,
    leaseExpired: false,
    partialProvisionFailed: false,
    ownerMatches: true,
    leaseFenceMatches: true,
    memberSnapshotMatches: true,
    objectFenceMatches: true,
    memberKind: "docker_container",
    enforceMode: true,
    cleanupEnabled: true,
    budgetAvailable: true,
    backoffDue: true,
  };
}

describe("runtime resource cleanup eligibility", () => {
  it("managed+ephemeral+provenance+unused+terminal+全fence一致だけを許可する", () => {
    expect(evaluateRuntimeAutoCleanup(eligibleEvidence())).toEqual({ eligible: true, failedConditions: [] });
  });

  it.each([
    ["leaseManaged", false],
    ["memberManaged", false],
    ["leaseEphemeral", false],
    ["memberEphemeral", false],
    ["leaseCleanupPolicy", "orchestrator"],
    ["memberCleanupPolicy", "human"],
    ["provenanceVerified", null],
    ["unused", null],
    ["ownerMatches", false],
    ["leaseFenceMatches", false],
    ["memberSnapshotMatches", false],
    ["objectFenceMatches", false],
    ["enforceMode", false],
    ["cleanupEnabled", false],
    ["budgetAvailable", false],
    ["backoffDue", false],
  ] as const)("%s が欠けると fail-closed", (key, value) => {
    const evidence = { ...eligibleEvidence(), [key]: value };
    expect(evaluateRuntimeAutoCleanup(evidence).eligible).toBe(false);
  });

  it("terminal/expired/provision failed のいずれも確定しなければ拒否する", () => {
    const evidence = {
      ...eligibleEvidence(),
      ownerTerminal: null,
      leaseExpired: false,
      partialProvisionFailed: false,
    };
    expect(evaluateRuntimeAutoCleanup(evidence).failedConditions).toContain("terminal_or_expired");
  });

  it("volume は明示 ephemeral でも auto cleanup しない", () => {
    expect(evaluateRuntimeAutoCleanup({ ...eligibleEvidence(), memberKind: "docker_volume" })).toEqual({
      eligible: false,
      failedConditions: ["kind"],
    });
  });
});

describe("runtime resource owner canonicalization", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symlink spelling を realpath に正規化する", () => {
    const root = mkdtempSync(join(tmpdir(), "hachi-runtime-path-"));
    tempDirs.push(root);
    const link = `${root}-link`;
    tempDirs.push(link);
    symlinkSync(root, link);
    expect(canonicalizeRuntimeOwnerPaths(link, link)).toEqual({
      repoCommonDir: realpathSync.native(root),
      canonicalWorktree: realpathSync.native(root),
    });
  });

  it("相対パスと解決不能パスを拒否する", () => {
    expect(() => canonicalizeRuntimeOwnerPaths("relative", "/tmp")).toThrow();
    expect(() => canonicalizeRuntimeOwnerPaths("/definitely/missing/hachi", "/tmp")).toThrow();
  });
});

describe("runtime resource requirement spec", () => {
  it("profile ownership snapshotをstrictに正規化して永続化する", () => {
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

    expect(JSON.parse(normalizeRuntimeRequirementSpec(spec))).toEqual(spec);
    expect(() => normalizeRuntimeRequirementSpec({
      ...spec,
      ownershipSnapshot: {
        ...spec.ownershipSnapshot,
        command: "./repository-script.sh",
      },
    })).toThrow(/unrecognized/i);
    expect(() => normalizeRuntimeRequirementSpec({
      ...spec,
      hostAdapterSnapshot: undefined,
    })).toThrow(/snapshot/);
  });
});

describe("runtime resource provenance", () => {
  it("exact ID/context/required labels/hash が全て一致したときだけ verified", () => {
    const lease: RuntimeResourceLeaseRow = {
      id: "rl_1",
      bundleKind: "worktree_preview",
      state: "cleanup_pending",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      ownerTaskId: "t_1",
      ownerRunId: null,
      controllerOrchestratorId: "o_1",
      board: "dev",
      project: "hachi",
      repoCommonDir: "/repo/.git",
      canonicalWorktree: "/repo/worktree",
      fence: 3,
      heartbeatAt: null,
      expiresAt: null,
      terminalReason: "owner_terminal",
      provenanceVersion: 1,
      rolloutGeneration: 2,
      createdAt: 1,
      updatedAt: 1,
      releasedAt: null,
    };
    const labels = {
      "io.hachi.managed": "true",
      "io.hachi.ephemeral": "true",
      "io.hachi.provenance-version": "1",
      "io.hachi.lease-id": "rl_1",
      "io.hachi.object-fence": "2",
      "io.hachi.board": "dev",
      "io.hachi.task-id": "t_1",
      "io.hachi.run-id": "",
      "io.hachi.orchestrator-id": "o_1",
      "io.hachi.repo-common-dir-hash": sha256RuntimeValue("/repo/.git"),
      "io.hachi.worktree-hash": sha256RuntimeValue("/repo/worktree"),
      "io.hachi.bundle-kind": "worktree_preview",
      "io.hachi.rollout-generation": "2",
      "com.docker.compose.project": "hachi_rl1",
    };
    const member: RuntimeResourceMemberRow = {
      id: "rm_1",
      leaseId: "rl_1",
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      objectFence: 2,
      scopeKey: "docker:desktop-linux",
      nativeId: "sha256:exact",
      displayName: "preview",
      hostIp: "",
      hostPort: null,
      containerPort: null,
      composeProject: "hachi_rl1",
      labelsHash: runtimeLabelsHash(labels),
      provenance: "{}",
      provenanceVerifiedAt: null,
      lastObservedAt: 1,
      releasedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const observed = {
      kind: "docker_container" as const,
      scopeKey: "docker:desktop-linux",
      nativeId: "sha256:exact",
      displayName: "preview",
      labels,
      attachedNativeIds: [] as readonly string[],
      observedAt: 2,
    };

    expect(verifyRuntimeResourceProvenance({ lease, member, observed, minimumRolloutGeneration: 1 })).toEqual({
      verified: true,
      failedConditions: [],
    });
    expect(
      verifyRuntimeResourceProvenance({
        lease,
        member,
        observed: { ...observed, nativeId: "sha256:reused-name" },
        minimumRolloutGeneration: 1,
      }).verified,
    ).toBe(false);
  });
});
