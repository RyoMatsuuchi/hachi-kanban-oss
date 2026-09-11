import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runtimeResourcesSchema, type RuntimeResourcesConfig } from "./config-schema.js";
import {
  sha256RuntimeValue,
  type RuntimeResourceRequirementRow,
} from "./runtime-resources.js";
import type { OrchestratorRow } from "./types.js";

const WORKTREE_POSTGRES_REQUIRED_MEMBERS = [
  "docker_container",
  "tcp_port",
  "postgres_endpoint",
] as const;

interface RuntimeConfigCarrier {
  runtimeResources?: unknown;
}

export interface RuntimeProjectPathProbe {
  canonicalPath(path: string): string;
  gitCommonDir(worktree: string): string;
}

export interface RuntimeProjectProfileRequirement {
  name: string;
  bundleKind: "worktree_postgres";
  spec: {
    version: 1;
    requiredMembers: readonly ["docker_container", "tcp_port", "postgres_endpoint"];
    ownershipSnapshot: RuntimeProjectOwnershipSnapshot;
    hostAdapterSnapshot: RuntimeProjectHostAdapterSnapshot;
  };
}

export interface RuntimeProjectOwnershipSnapshot {
  version: 1;
  profileId: string;
  orchestratorId: string;
  project: string;
  repoCommonDir: string;
  canonicalWorktree: string;
}

export interface RuntimeProjectHostAdapterSnapshot {
  version: 1;
  hostAdapter: "worktreePostgres";
  configFingerprint: string;
}

export interface RuntimeProjectProfileSnapshots {
  ownershipSnapshot: RuntimeProjectOwnershipSnapshot;
  hostAdapterSnapshot: RuntimeProjectHostAdapterSnapshot;
}

export interface ResolvedRuntimeProjectProfile {
  profileId: string;
  project: string;
  repoCommonDir: string;
  canonicalWorktree: string;
  hostAdapter: "worktreePostgres";
  requirement: RuntimeProjectProfileRequirement;
}

export interface RuntimeProjectProfileRequirementLookup {
  requirement(id: string): RuntimeResourceRequirementRow | null;
}

/**
 * 初回 requirement と既存 retry lineage のどちらも、snapshot の profile identity と
 * 退役 lease を持つ直前 requirement へ exact に束縛されている場合だけ受理する。
 */
export function runtimeProjectProfileRequirementIdentityMatches(
  requirement: RuntimeResourceRequirementRow,
  snapshot: RuntimeProjectOwnershipSnapshot,
  lookup?: RuntimeProjectProfileRequirementLookup,
  visited: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (requirement.bundleKind !== "worktree_postgres" || visited.has(requirement.id)) {
    return false;
  }
  const profileName = `runtime-profile:${snapshot.profileId}`;
  if (requirement.name === profileName) {
    return requirement.idempotencyKey === `${requirement.taskId}:${profileName}`;
  }
  const nameMatch = /^retry-(rl_[0-9a-f]{16})$/u.exec(requirement.name);
  const keyMatch = /^(rr_[0-9a-f]{16}):retry:(rl_[0-9a-f]{16})$/u.exec(requirement.idempotencyKey);
  const previousRequirementId = keyMatch?.[1];
  const retiredLeaseId = keyMatch?.[2];
  if (
    nameMatch === null ||
    previousRequirementId === undefined ||
    retiredLeaseId === undefined ||
    nameMatch[1] !== retiredLeaseId ||
    lookup === undefined
  ) {
    return false;
  }
  const previous = lookup.requirement(previousRequirementId);
  if (
    previous === null ||
    previous.taskId !== requirement.taskId ||
    previous.bundleKind !== requirement.bundleKind ||
    previous.leaseId !== retiredLeaseId ||
    previous.spec !== requirement.spec
  ) {
    return false;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(requirement.id);
  return runtimeProjectProfileRequirementIdentityMatches(previous, snapshot, lookup, nextVisited);
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/",
    LANG: "C",
    LC_ALL: "C",
  };
}

function canonicalGitCommonDir(worktree: string): string {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: safeGitEnvironment(),
      },
    ).trim();
  } catch {
    throw new Error("runtime profile の worktree Git ownership を確認できません");
  }
  if (output === "") {
    throw new Error("runtime profile の Git common-dir が空です");
  }
  const commonDir = isAbsolute(output) ? output : resolve(worktree, output);
  try {
    return realpathSync.native(commonDir);
  } catch {
    throw new Error("runtime profile の Git common-dir を canonicalize できません");
  }
}

const hostRuntimeProjectPathProbe: RuntimeProjectPathProbe = {
  canonicalPath(path: string): string {
    try {
      return realpathSync.native(path);
    } catch {
      throw new Error("runtime profile の host path を canonicalize できません");
    }
  },
  gitCommonDir: canonicalGitCommonDir,
};

function runtimeResourcesFromConfig(config: unknown): RuntimeResourcesConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("runtime profile の host config が不正です");
  }
  const runtimeResources = (config as RuntimeConfigCarrier).runtimeResources;
  if (runtimeResources === undefined) {
    throw new Error("runtime profile の host config が存在しません");
  }
  return runtimeResourcesSchema.parse(runtimeResources);
}

/**
 * requirementへ束縛するhost adapter設定のfingerprintを作る。
 * workerへ設定本文を公開せず、provisionに影響する全設定を決定論的な順序でhash化する。
 */
export function createRuntimeProjectHostAdapterSnapshot(
  runtimeResources: RuntimeResourcesConfig,
  hostAdapter: "worktreePostgres",
): RuntimeProjectHostAdapterSnapshot {
  if (
    runtimeResources.mode !== "enforce" ||
    !runtimeResources.provisioningEnabled ||
    runtimeResources.dockerContext === undefined ||
    runtimeResources.worktreePostgres === undefined
  ) {
    throw new Error("runtime profile の host adapter設定が有効ではありません");
  }
  const postgres = runtimeResources.worktreePostgres;
  const canonicalConfig = {
    version: 1,
    bundleKind: "worktree_postgres",
    hostAdapter,
    dockerContext: runtimeResources.dockerContext,
    leaseTtlSeconds: runtimeResources.leaseTtlSeconds,
    rolloutGeneration: runtimeResources.rolloutGeneration ?? 1,
    worktreePostgres: {
      image: postgres.image,
      containerPort: postgres.containerPort,
      healthCheck: {
        command: [...postgres.healthCheck.command],
        intervalMs: postgres.healthCheck.intervalMs,
        timeoutMs: postgres.healthCheck.timeoutMs,
        retries: postgres.healthCheck.retries,
      },
    },
  };
  return {
    version: 1,
    hostAdapter,
    configFingerprint: sha256RuntimeValue(JSON.stringify(canonicalConfig)),
  };
}

function declaredWorktree(taskBody: string): string {
  const firstLine = taskBody.split(/\r?\n/u, 1)[0] ?? "";
  const match = /^cwd:\s*(\S+)\s*$/u.exec(firstLine);
  const worktree = match?.[1];
  if (worktree === undefined || !isAbsolute(worktree)) {
    throw new Error("runtime profile には task body 先頭の絶対 cwd 宣言が必要です");
  }
  return worktree;
}

/**
 * requirement spec に保存された runtime profile ownership snapshot を strict に読む。
 * ownershipSnapshot が無い既存 requirement は従来 semantics のまま扱う。
 */
export function parseRuntimeProjectOwnershipSnapshot(
  spec: unknown,
): RuntimeProjectOwnershipSnapshot | undefined {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("runtime resource requirement spec が不正です");
  }
  const snapshot = (spec as Record<string, unknown>)["ownershipSnapshot"];
  if (snapshot === undefined) {
    return undefined;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("runtime profile ownership snapshot が不正です");
  }
  const record = snapshot as Record<string, unknown>;
  const expectedKeys = [
    "canonicalWorktree",
    "orchestratorId",
    "profileId",
    "project",
    "repoCommonDir",
    "version",
  ];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") ||
    record["version"] !== 1 ||
    typeof record["profileId"] !== "string" ||
    record["profileId"] === "" ||
    record["profileId"] !== record["profileId"].trim() ||
    typeof record["orchestratorId"] !== "string" ||
    record["orchestratorId"] === "" ||
    record["orchestratorId"] !== record["orchestratorId"].trim() ||
    typeof record["project"] !== "string" ||
    record["project"] === "" ||
    record["project"] !== record["project"].trim() ||
    typeof record["repoCommonDir"] !== "string" ||
    !isAbsolute(record["repoCommonDir"]) ||
    record["repoCommonDir"].includes("\0") ||
    record["repoCommonDir"] !== record["repoCommonDir"].trim() ||
    typeof record["canonicalWorktree"] !== "string" ||
    !isAbsolute(record["canonicalWorktree"]) ||
    record["canonicalWorktree"].includes("\0") ||
    record["canonicalWorktree"] !== record["canonicalWorktree"].trim()
  ) {
    throw new Error("runtime profile ownership snapshot が不正です");
  }
  return {
    version: 1,
    profileId: record["profileId"],
    orchestratorId: record["orchestratorId"],
    project: record["project"],
    repoCommonDir: record["repoCommonDir"],
    canonicalWorktree: record["canonicalWorktree"],
  };
}

/** requirement specに保存されたhost adapter snapshotをstrictに読む。 */
export function parseRuntimeProjectHostAdapterSnapshot(
  spec: unknown,
): RuntimeProjectHostAdapterSnapshot | undefined {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("runtime resource requirement spec が不正です");
  }
  const snapshot = (spec as Record<string, unknown>)["hostAdapterSnapshot"];
  if (snapshot === undefined) {
    return undefined;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("runtime profile host adapter snapshot が不正です");
  }
  const record = snapshot as Record<string, unknown>;
  const expectedKeys = ["configFingerprint", "hostAdapter", "version"];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") ||
    record["version"] !== 1 ||
    record["hostAdapter"] !== "worktreePostgres" ||
    typeof record["configFingerprint"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record["configFingerprint"])
  ) {
    throw new Error("runtime profile host adapter snapshot が不正です");
  }
  return {
    version: 1,
    hostAdapter: record["hostAdapter"],
    configFingerprint: record["configFingerprint"],
  };
}

/**
 * ownershipとhost adapterのsnapshotは一組でのみ受理する。
 * 両方が無いrequirementは既存の非profile semanticsとして扱う。
 */
export function parseRuntimeProjectProfileSnapshots(
  spec: unknown,
): RuntimeProjectProfileSnapshots | undefined {
  const ownershipSnapshot = parseRuntimeProjectOwnershipSnapshot(spec);
  const hostAdapterSnapshot = parseRuntimeProjectHostAdapterSnapshot(spec);
  if (ownershipSnapshot === undefined && hostAdapterSnapshot === undefined) {
    return undefined;
  }
  if (ownershipSnapshot === undefined || hostAdapterSnapshot === undefined) {
    throw new Error("runtime profile snapshot の組が不正です");
  }
  return { ownershipSnapshot, hostAdapterSnapshot };
}

/**
 * 作成時 snapshot と現在の stable principal / body cwd / Git ownership を再照合する。
 * body の文字列だけでなく host realpath と git common-dir の conjunction を必須にする。
 */
export function assertRuntimeProjectOwnershipSnapshot(input: {
  snapshot: RuntimeProjectOwnershipSnapshot;
  orchestrator: Pick<OrchestratorRow, "id" | "project" | "repoCommonDir">;
  taskBody: string;
  pathProbe?: RuntimeProjectPathProbe;
}): void {
  const pathProbe = input.pathProbe ?? hostRuntimeProjectPathProbe;
  const snapshot = input.snapshot;
  if (
    input.orchestrator.id !== snapshot.orchestratorId ||
    input.orchestrator.project !== snapshot.project ||
    input.orchestrator.repoCommonDir !== snapshot.repoCommonDir
  ) {
    throw new Error("runtime profile ownership snapshot と primary binding が一致しません");
  }
  const canonicalCommonDir = pathProbe.canonicalPath(snapshot.repoCommonDir);
  const canonicalWorktree = pathProbe.canonicalPath(declaredWorktree(input.taskBody));
  if (
    canonicalCommonDir !== snapshot.repoCommonDir ||
    canonicalWorktree !== snapshot.canonicalWorktree ||
    pathProbe.canonicalPath(snapshot.canonicalWorktree) !== snapshot.canonicalWorktree ||
    pathProbe.gitCommonDir(snapshot.canonicalWorktree) !== snapshot.repoCommonDir
  ) {
    throw new Error("runtime profile ownership snapshot と current Git worktree が一致しません");
  }
}

/**
 * create時にhash化したhost adapter設定とcurrent host config/profileをexactに再照合する。
 * profile削除・別projectへの移動・adapter/bundle/config driftはすべてprovision前に拒否する。
 */
export function assertRuntimeProjectHostAdapterSnapshot(input: {
  ownershipSnapshot: RuntimeProjectOwnershipSnapshot;
  hostAdapterSnapshot: RuntimeProjectHostAdapterSnapshot;
  requirementBundleKind: "worktree_postgres";
  runtimeResources: RuntimeResourcesConfig;
}): void {
  const projects = (input.runtimeResources.projects ?? []).filter(
    (project) =>
      project.project === input.ownershipSnapshot.project &&
      project.repoCommonDir === input.ownershipSnapshot.repoCommonDir,
  );
  const profiles = projects.flatMap((project) =>
    project.profiles.filter((profile) => profile.id === input.ownershipSnapshot.profileId)
  );
  const profile = profiles[0];
  if (
    projects.length !== 1 ||
    profiles.length !== 1 ||
    profile === undefined ||
    profile.bundleKind !== input.requirementBundleKind ||
    profile.hostAdapter !== input.hostAdapterSnapshot.hostAdapter
  ) {
    throw new Error("runtime profile と current host config が一致しません");
  }
  const currentSnapshot = createRuntimeProjectHostAdapterSnapshot(
    input.runtimeResources,
    profile.hostAdapter,
  );
  if (currentSnapshot.configFingerprint !== input.hostAdapterSnapshot.configFingerprint) {
    throw new Error("runtime profile の host adapter設定 fingerprint が一致しません");
  }
}

/**
 * host config・stable orchestrator identity・Git ownership の conjunction だけを
 * runtime requirement template へ解決する。task body の文字列単独は authority にしない。
 */
export function resolveRuntimeProjectProfile(input: {
  config: unknown;
  profileId: string;
  orchestrator: Pick<OrchestratorRow, "id" | "project" | "repoCommonDir">;
  taskBody: string;
  pathProbe?: RuntimeProjectPathProbe;
}): ResolvedRuntimeProjectProfile {
  const profileId = input.profileId;
  if (profileId === "" || profileId !== profileId.trim()) {
    throw new Error("--runtime-profile は空でない exact ID が必要です");
  }
  const runtimeResources = runtimeResourcesFromConfig(input.config);
  const projects = runtimeResources.projects ?? [];
  const project = projects.find((candidate) => candidate.project === input.orchestrator.project);
  if (project === undefined) {
    const existsInOtherProject = projects.some((candidate) =>
      candidate.profiles.some((profile) => profile.id === profileId)
    );
    if (existsInOtherProject) {
      throw new Error(`runtime profile の project がactive orchestratorと一致しません: ${profileId}`);
    }
    throw new Error(`runtime profile が見つかりません: ${profileId}`);
  }
  const profile = project.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    throw new Error(`runtime profile が見つかりません: ${profileId}`);
  }
  if (
    runtimeResources.mode !== "enforce" ||
    !runtimeResources.provisioningEnabled ||
    runtimeResources.dockerContext === undefined ||
    runtimeResources.worktreePostgres === undefined
  ) {
    throw new Error(`runtime profile の provisioning が有効ではありません: ${profileId}`);
  }

  const pathProbe = input.pathProbe ?? hostRuntimeProjectPathProbe;
  const configuredCommonDir = pathProbe.canonicalPath(project.repoCommonDir);
  if (
    configuredCommonDir !== project.repoCommonDir ||
    input.orchestrator.repoCommonDir !== configuredCommonDir
  ) {
    throw new Error(`runtime profile の project/common-dir がprimary bindingと一致しません: ${profileId}`);
  }
  const canonicalWorktree = pathProbe.canonicalPath(declaredWorktree(input.taskBody));
  const worktreeCommonDir = pathProbe.gitCommonDir(canonicalWorktree);
  if (worktreeCommonDir !== configuredCommonDir) {
    throw new Error(`runtime profile の worktree path がproject common-dirと一致しません: ${profileId}`);
  }
  const ownershipSnapshot: RuntimeProjectOwnershipSnapshot = {
    version: 1,
    profileId,
    orchestratorId: input.orchestrator.id,
    project: project.project,
    repoCommonDir: configuredCommonDir,
    canonicalWorktree,
  };
  const hostAdapterSnapshot = createRuntimeProjectHostAdapterSnapshot(
    runtimeResources,
    profile.hostAdapter,
  );

  return {
    profileId,
    project: project.project,
    repoCommonDir: configuredCommonDir,
    canonicalWorktree,
    hostAdapter: profile.hostAdapter,
    requirement: {
      name: `runtime-profile:${profileId}`,
      bundleKind: profile.bundleKind,
      spec: {
        version: 1,
        requiredMembers: WORKTREE_POSTGRES_REQUIRED_MEMBERS,
        ownershipSnapshot,
        hostAdapterSnapshot,
      },
    },
  };
}
