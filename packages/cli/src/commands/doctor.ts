// =============================================================================
// hachi doctor: 環境の健全性を1項目ずつ検査する。
// bridge 検査・supervisor heartbeat 検査・web healthz 検査（いずれもネットワーク/外形監視）は
// --offline で skip できる（docs/contract.md §33.3）。
// 1つでも ok=false があれば exit code 1。
// =============================================================================

import { execFile, type ExecFileException } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { probeBridgeIdentity, readBridgeToken, type BridgeIdentityFailure } from "@hachi/adapters";
import {
  countDirectResidualGroups,
  createRuntimeResourceReadView,
  evaluateBridgeProcessHygiene,
  listSystemProcesses,
  ORCHESTRATOR_SESSION_STALE_SECONDS,
  PROVIDERS,
  TASK_STATUSES,
  assertRuntimeProjectHostAdapterSnapshot,
  assertRuntimeProjectOwnershipSnapshot,
  ensureEnvironmentDirs,
  findReservedVerifyDirective,
  inspectLogRotationState,
  inspectStewardStateLocks,
  isStrictSemver,
  loadConfig,
  parseRuntimeProjectProfileSnapshots,
  redactText,
  resolveCommunicationProviderConfig,
  runtimeMembersHash,
  runtimeProjectProfileRequirementIdentityMatches,
  runtimeResourcesSchema,
  validateLogRotationConfig,
  type DirectSessionProcessRecord,
  type Provider,
  type ModelResolution,
  type RuntimeResourceLeaseRow,
  type RuntimeResourceRequirementRow,
  type RuntimeResourcesConfig,
  type RunRow,
  type TaskRow,
  type Transport,
} from "@hachi/core";
import type { CliBridgeListenerInspection, CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit } from "../output.js";
import { observeResolvedModelTransportCompatibility } from "../model-transport-observability.js";
import { SuccessorAttestationArtifactError } from "../successor-attestation-artifacts.js";
import { inspectOrchestratorHandoverPreflight } from "./orchestrator.js";

interface DoctorOptions {
  offline?: boolean;
  json?: boolean;
}

/** 検査結果1件 */
interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** 検査対象外または明示的な offline 指定で probe しなかった場合だけ付与する。 */
  skipped?: boolean;
  /** skipped=true の機械可読な理由。 */
  reason?: "offline" | "unused-transport" | "writer-not-deployed" | "bridge-not-running";
}

/** supervisor heartbeat の鮮度閾値（既定300秒。docs/contract.md §33.3） */
const HEARTBEAT_STALE_SEC = 300;
/** steward cadence の既定値（分。docs/contract.md §40.1） */
const DEFAULT_STEWARD_INTERVAL_MINUTES = 30;
const DEFAULT_MAX_RUN_SECONDS = 7200;
const PROCESS_HYGIENE_WARN_DESCENDANTS = 200;
const PROCESS_HYGIENE_REAP_LIMIT = 50;
const PASSTHROUGH_PATCH_STATUS_SCHEMA = "passthrough-patch-status/v1";
const PASSTHROUGH_PATCH_DETAIL_MAX_LENGTH = 1_000;
const MACOS_LSOF_PATH = "/usr/sbin/lsof";

/** web healthz の既定 port（docs/contract.md §14.2 と同じ既定値） */
const DEFAULT_WEB_PORT = 9131;
/** web healthz 確認のタイムアウト（docs/contract.md §33.3） */
const WEB_HEALTHZ_TIMEOUT_MS = 3_000;

/**
 * このファイル自身の位置から repo root を算出する（packages/cli/src/commands から4階層上）。
 * bin/hachi は常に tsx でこの checkout の src を直接実行するため、import.meta.url は
 * インストール先 checkout を指す（dist へビルドされない運用。README/scripts/setup-local.mjs 参照）。
 */
const DEFAULT_ORCHESTRATOR_HELPER_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * オーケストレーター運用ヘルパー5本。マシン再構築で `~/.local/bin` 配下が消えると
 * playbook の手順が実行不能になるため doctor で導入状態を検査し、欠落は警告として
 * 報告する（t_eac0371a7a1a368e）。オーケストレーター運用者以外には不要なシムなので
 * 未導入でも doctor 全体は fail させない。
 * この一覧は scripts/setup-local.mjs の ORCHESTRATOR_HELPERS と対応させること
 * （setup-local.mjs がこのシムを生成する側）。test-support.ts の createTestDeps() が
 * fixture 生成のためにこの定数を再利用する。
 */
export const ORCHESTRATOR_HELPER_SPECS: ReadonlyArray<
  { readonly name: string; readonly repoRelativeSource: string }
> = [
  { name: "hachi-handover-now", repoRelativeSource: "scripts/hachi-handover-now" },
  { name: "hhn", repoRelativeSource: "scripts/hachi-handover-now" },
  { name: "hachi-orch-enable", repoRelativeSource: "scripts/orchestrator/hachi-orch-enable" },
  { name: "cc-cache-ttl", repoRelativeSource: "scripts/orchestrator/cc-cache-ttl" },
  { name: "hachi-watch-stop", repoRelativeSource: "scripts/orchestrator/hachi-watch-stop" },
];

/** setup-local.mjs が生成する exec シム（`#!/bin/sh` + `exec "<path>" "$@"`）の形式一致を見る。 */
const ORCHESTRATOR_HELPER_SHIM_PATTERN = /^#!\/bin\/sh\nexec "([^"\n]+)" "\$@"\n$/;

function compareStrictSemver(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
    if (match === null) {
      throw new Error(`strict semverが不正です: ${value}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
  };
  const a = parse(left);
  const b = parse(right);
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) {
      return a[index] > b[index] ? 1 : -1;
    }
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === "") return 1;
  if (b[3] === "") return -1;
  return a[3] > b[3] ? 1 : -1;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/** owner/group/other のいずれかに実行bitが立っているか（chmod -x等での実行不能を検知するための簡易判定） */
function hasAnyExecuteBit(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

/** (1) HACHI_KANBAN_HOME 存在/作成可否 */
function checkHome(deps: CliDeps): DoctorCheck {
  try {
    ensureEnvironmentDirs(deps.env);
    return { name: "HACHI_KANBAN_HOME", ok: true, detail: `作成/存在確認OK: ${deps.env.home}` };
  } catch (err) {
    return { name: "HACHI_KANBAN_HOME", ok: false, detail: `作成に失敗しました: ${(err as Error).message}` };
  }
}

/** (2) config.json の zod 検証（無ければ「既定値使用」で ok） */
function checkConfig(deps: CliDeps): DoctorCheck {
  const configPath = `${deps.env.home}/config.json`;
  try {
    loadConfig(deps.env);
    const detail = existsSync(configPath)
      ? "config.json の検証に成功しました"
      : "config.json が無いため既定値を使用します";
    return { name: "config.json", ok: true, detail };
  } catch (err) {
    return { name: "config.json", ok: false, detail: (err as Error).message };
  }
}

/** (3) DB オープン + counts 取得 */
function checkDb(deps: CliDeps): DoctorCheck {
  try {
    const counts = deps.store.counts();
    return { name: "DB", ok: true, detail: `counts 取得OK: ${JSON.stringify(counts)}` };
  } catch (err) {
    return { name: "DB", ok: false, detail: (err as Error).message };
  }
}

/** local manifest / CODEX_HOME / installed hook / PATH helper を offline でも exact 照合する。 */
function checkCodexSuccessorAttestation(deps: CliDeps): DoctorCheck {
  const name = "codex successor attestation";
  const mode = deps.config.orchestrator?.codexSuccessorAttestation?.mode ?? "manual";
  const resolver = deps.successorAttestationArtifactResolver;
  if (resolver === undefined) {
    return mode === "manual"
      ? {
        name,
        ok: true,
        detail: "mode=manual publication manifest未配備; manual create_thread fallback（readiness証明ではありません）",
      }
      : { name, ok: false, detail: "mode=enforce publication resolver未構成" };
  }
  try {
    resolver.resolveInstalledArtifacts();
    return { name, ok: true, detail: `mode=${mode} static hook/helper exact一致` };
  } catch (err) {
    const code = err instanceof SuccessorAttestationArtifactError ? err.code : "resolver_failure";
    if (mode === "manual" && code === "manifest_missing") {
      return {
        name,
        ok: true,
        detail: "mode=manual publication manifest未配備; manual create_thread fallback（readiness証明ではありません）",
      };
    }
    return { name, ok: false, detail: `mode=${mode} artifact検証NG reason=${code}` };
  }
}

function readRuntimeResourcesConfig(deps: CliDeps): RuntimeResourcesConfig | undefined {
  const configPath = join(deps.env.home, "config.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config.json の root がobjectではありません");
  }
  const runtimeResources = (parsed as Record<string, unknown>)["runtimeResources"];
  return runtimeResources === undefined ? undefined : runtimeResourcesSchema.parse(runtimeResources);
}

function listDoctorTasks(deps: CliDeps): TaskRow[] {
  const byId = new Map<string, TaskRow>();
  for (const status of TASK_STATUSES) {
    for (const task of deps.store.listByStatus(status, 100_000)) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

/** 非終端タスクの verify directive を走査し、予約語に完全一致する行を可視化する。 */
function checkVerifyDirectives(deps: CliDeps): DoctorCheck {
  try {
    const invalidDirectives = listDoctorTasks(deps)
      .filter((task) => task.status !== "done" && task.status !== "archived")
      .flatMap((task) => {
        const reservedWord = findReservedVerifyDirective(task.body);
        return reservedWord === null ? [] : [{ taskId: task.id, reservedWord }];
      });

    if (invalidDirectives.length === 0) {
      return { name: "verify directives", ok: true, detail: "非終端タスクに予約語指定はありません" };
    }

    return {
      name: "verify directives",
      ok: false,
      detail: invalidDirectives
        .map(({ taskId, reservedWord }) => `taskId=${taskId} reservedWord=${reservedWord}`)
        .join(", "),
    };
  } catch (err) {
    return {
      name: "verify directives",
      ok: false,
      detail: `走査に失敗しました: ${redactText(err instanceof Error ? err.message : String(err))}`,
    };
  }
}

function listRuntimeRequirements(
  deps: CliDeps,
): {
  tasks: Map<string, TaskRow>;
  requirements: RuntimeResourceRequirementRow[];
  leases: RuntimeResourceLeaseRow[];
} {
  const view = createRuntimeResourceReadView(deps.env.dbPath);
  try {
    const tasks = new Map(listDoctorTasks(deps).map((task) => [task.id, task]));
    const leases = view.leases();
    for (const lease of leases) {
      if (lease.ownerTaskId !== null && !tasks.has(lease.ownerTaskId)) {
        const task = deps.store.getTask(lease.ownerTaskId);
        if (task !== null) {
          tasks.set(task.id, task);
        }
      }
    }
    const requirements = [...tasks.values()].flatMap((task) => view.requirementsForTask(task.id));
    return { tasks, requirements, leases };
  } finally {
    view.close();
  }
}

function formatRuntimeDoctorDetail(
  fields: Readonly<Record<string, string | number>>,
  issues: readonly string[],
): string {
  const summary = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`).join(" ");
  return issues.length === 0
    ? summary
    : `${summary} issues=${issues.slice(0, 5).join(",")}${issues.length > 5 ? `,+${String(issues.length - 5)}` : ""}`;
}

/** project profileのcurrent host config・principal・Git ownership解決をread-only再検証する。 */
function checkRuntimeResourceProfiles(deps: CliDeps): DoctorCheck {
  const name = "runtime resource profiles";
  try {
    const runtimeResources = readRuntimeResourcesConfig(deps);
    const inventory = listRuntimeRequirements(deps);
    const requirementsById = new Map(inventory.requirements.map((requirement) => [requirement.id, requirement]));
    const leasesById = new Map(inventory.leases.map((lease) => [lease.id, lease]));
    const issues: string[] = [];
    let profileRequirements = 0;

    for (const project of runtimeResources?.projects ?? []) {
      try {
        if (!isAbsolute(project.repoCommonDir) || realpathSync.native(project.repoCommonDir) !== project.repoCommonDir) {
          issues.push(`project-path:${project.project}`);
        }
      } catch {
        issues.push(`project-path:${project.project}`);
      }
    }

    for (const requirement of inventory.requirements) {
      let snapshots;
      try {
        snapshots = parseRuntimeProjectProfileSnapshots(JSON.parse(requirement.spec) as unknown);
      } catch {
        if (requirement.name.startsWith("runtime-profile:")) {
          issues.push(`snapshot:${requirement.id}`);
        }
        continue;
      }
      if (snapshots === undefined) {
        continue;
      }
      profileRequirements += 1;
      if (
        !runtimeProjectProfileRequirementIdentityMatches(
          requirement,
          snapshots.ownershipSnapshot,
          {
            requirement(id: string): RuntimeResourceRequirementRow | null {
              return requirementsById.get(id) ?? null;
            },
          },
        )
      ) {
        issues.push(`identity:${requirement.id}`);
        continue;
      }
      const lease = requirement.leaseId === "" ? null : leasesById.get(requirement.leaseId) ?? null;
      const currentAuthorityRequired =
        requirement.status === "pending" ||
        requirement.status === "provisioning" ||
        (requirement.status === "ready" && lease?.state === "active");
      if (!currentAuthorityRequired) {
        continue;
      }
      const task = inventory.tasks.get(requirement.taskId);
      const primaryBindings = deps.store
        .listTaskOrchestratorBindings(requirement.taskId)
        .filter((binding) => binding.role === "primary");
      const orchestrator = primaryBindings.length === 1
        ? deps.store.getOrchestrator(primaryBindings[0]!.orchestratorId)
        : null;
      if (runtimeResources === undefined || task === undefined || orchestrator === null) {
        issues.push(`unresolved:${requirement.id}`);
        continue;
      }
      if (requirement.bundleKind !== "worktree_postgres") {
        issues.push(`bundle:${requirement.id}`);
        continue;
      }
      try {
        assertRuntimeProjectOwnershipSnapshot({
          snapshot: snapshots.ownershipSnapshot,
          orchestrator,
          taskBody: task.body,
        });
        assertRuntimeProjectHostAdapterSnapshot({
          ownershipSnapshot: snapshots.ownershipSnapshot,
          hostAdapterSnapshot: snapshots.hostAdapterSnapshot,
          requirementBundleKind: requirement.bundleKind,
          runtimeResources,
        });
      } catch {
        issues.push(`drift:${requirement.id}`);
      }
    }
    const profileCount = (runtimeResources?.projects ?? [])
      .reduce((count, project) => count + project.profiles.length, 0);
    return {
      name,
      ok: issues.length === 0,
      detail: formatRuntimeDoctorDetail({
        mode: runtimeResources?.mode ?? "observe",
        provisioning: runtimeResources?.provisioningEnabled === true ? "enabled" : "disabled",
        profiles: profileCount,
        requirements: profileRequirements,
        unresolved: issues.length,
      }, issues),
    };
  } catch (error) {
    return { name, ok: false, detail: `診断に失敗しました: ${redactText((error as Error).message)}` };
  }
}

function inspectActivePostgresManifest(
  deps: CliDeps,
  lease: RuntimeResourceLeaseRow,
): boolean {
  const manifestRoot = realpathSync.native(join(deps.env.home, "runtime-manifests"));
  const manifestPath = join(manifestRoot, `${lease.id}.json`);
  const manifestStat = lstatSync(manifestPath);
  const canonicalManifest = realpathSync.native(manifestPath);
  const parsed = JSON.parse(readFileSync(canonicalManifest, "utf8")) as Record<string, unknown>;
  const secretPath = parsed["secretFilePath"];
  const manifestFence = parsed["fence"];
  const fenceMatches = Number.isSafeInteger(manifestFence) && manifestFence === lease.fence;
  const secretRoot = realpathSync.native(join(deps.env.home, "runtime-secrets", lease.id));
  if (
    manifestStat.isSymbolicLink() ||
    !manifestStat.isFile() ||
    (manifestStat.mode & 0o077) !== 0 ||
    canonicalManifest !== manifestPath ||
    parsed["version"] !== 1 ||
    parsed["leaseId"] !== lease.id ||
    !fenceMatches ||
    parsed["host"] !== "127.0.0.1" ||
    !Number.isSafeInteger(parsed["port"]) ||
    typeof secretPath !== "string" ||
    realpathSync.native(secretPath) !== join(secretRoot, "postgres-password") ||
    relative(secretRoot, realpathSync.native(secretPath)) !== "postgres-password"
  ) {
    return false;
  }
  const secretStat = lstatSync(secretPath);
  return secretStat.isFile() && !secretStat.isSymbolicLink() && (secretStat.mode & 0o077) === 0;
}

/** active leaseのheartbeat/expiry/task/run/member/manifest整合を外部probeなしで検査する。 */
function checkRuntimeResourceLeases(deps: CliDeps): DoctorCheck {
  const name = "runtime resource leases";
  try {
    const runtimeResources = readRuntimeResourcesConfig(deps);
    const inventory = listRuntimeRequirements(deps);
    const requirementsByLease = new Map(
      inventory.requirements
        .filter((requirement) => requirement.leaseId !== "")
        .map((requirement) => [requirement.leaseId, requirement]),
    );
    const runStore = deps.store as unknown as { getRun(id: number): RunRow | null };
    const now = Math.floor(Date.now() / 1000);
    const heartbeatGrace = runtimeResources?.heartbeatIntervalSeconds ??
      Math.max(1, Math.floor((runtimeResources?.leaseTtlSeconds ?? 300) / 3));
    const issues: string[] = [];
    for (const lease of inventory.leases) {
      const requirement = requirementsByLease.get(lease.id);
      const failedRetired =
        lease.state === "failed" &&
        requirement !== undefined &&
        inventory.requirements.some(
          (candidate) => candidate.idempotencyKey === `${requirement.id}:retry:${lease.id}`,
        );
      if (lease.state === "quarantined" || (lease.state === "failed" && !failedRetired)) {
        issues.push(`state:${lease.id}:${lease.state}`);
      }
      if (lease.state !== "active") {
        continue;
      }
      const task = lease.ownerTaskId === null ? null : inventory.tasks.get(lease.ownerTaskId) ?? null;
      const ownerRun = lease.ownerRunId === null ? null : runStore.getRun(lease.ownerRunId);
      if (
        !lease.managed ||
        lease.ownerTaskId === null ||
        lease.controllerOrchestratorId === null ||
        task === null ||
        requirement?.status !== "ready"
      ) {
        issues.push(`owner:${lease.id}`);
      }
      if (ownerRun !== null && ownerRun.taskId !== lease.ownerTaskId) {
        issues.push(`run-owner:${lease.id}`);
      } else if (lease.ownerRunId !== null && ownerRun === null) {
        issues.push(`run-missing:${lease.id}`);
      } else if (
        ownerRun !== null &&
        ownerRun.status !== "running" &&
        task !== null &&
        task.status !== "review"
      ) {
        issues.push(`stale-run:${lease.id}`);
      }
      if (task?.status === "done" || task?.status === "archived") {
        issues.push(`terminal-active:${lease.id}`);
      }
      if (
        lease.ownerRunId !== null &&
        deps.store.listRunCancelRequests(lease.ownerTaskId ?? undefined)
          .some((cancel) => cancel.runId === lease.ownerRunId && cancel.status === "stopped")
      ) {
        issues.push(`cancel-stopped-active:${lease.id}`);
      }
      if (lease.expiresAt === null || lease.expiresAt <= now) {
        issues.push(`expiry:${lease.id}`);
      }
      if (
        lease.heartbeatAt === null
          ? now - lease.createdAt > heartbeatGrace
          : lease.heartbeatAt > now || now - lease.heartbeatAt > heartbeatGrace * 2
      ) {
        issues.push(`heartbeat:${lease.id}`);
      }
      const view = createRuntimeResourceReadView(deps.env.dbPath);
      const members = view.members(lease.id);
      view.close();
      if (requirement !== undefined) {
        try {
          const parsed = JSON.parse(requirement.spec) as Record<string, unknown>;
          const requiredMembers = parsed["requiredMembers"];
          const activeKinds = new Set<string>(
            members.filter((member) => member.state === "active").map((member) => member.kind),
          );
          if (
            !Array.isArray(requiredMembers) ||
            requiredMembers.some((kind) => typeof kind !== "string" || !activeKinds.has(kind))
          ) {
            issues.push(`members:${lease.id}`);
          }
        } catch {
          issues.push(`members:${lease.id}`);
        }
      }
      if (
        runtimeResources?.dockerContext !== undefined &&
        members.some((member) => member.scopeKey !== runtimeResources.dockerContext)
      ) {
        issues.push(`scope:${lease.id}`);
      }
      if (lease.bundleKind === "worktree_postgres") {
        try {
          if (!inspectActivePostgresManifest(deps, lease)) {
            issues.push(`manifest:${lease.id}`);
          }
        } catch {
          issues.push(`manifest:${lease.id}`);
        }
      }
    }
    const active = inventory.leases.filter((lease) => lease.state === "active").length;
    return {
      name,
      ok: issues.length === 0,
      detail: formatRuntimeDoctorDetail({
        total: inventory.leases.length,
        active,
        expired: inventory.leases.filter((lease) => lease.expiresAt !== null && lease.expiresAt <= now).length,
        inconsistent: issues.length,
      }, issues),
    };
  } catch (error) {
    return { name, ok: false, detail: `診断に失敗しました: ${redactText((error as Error).message)}` };
  }
}

/** cleanup lease/request/member fenceとreleased artifact残骸をread-only診断する。 */
function checkRuntimeResourceCleanup(deps: CliDeps): DoctorCheck {
  const name = "runtime resource cleanup";
  try {
    const runtimeResources = readRuntimeResourcesConfig(deps);
    const view = createRuntimeResourceReadView(deps.env.dbPath);
    const leases = view.leases();
    const issues: string[] = [];
    let pending = 0;
    let quarantined = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const lease of leases) {
      const members = view.members(lease.id);
      const requests = view.cleanupRequests(lease.id);
      const currentRequests = requests.filter((request) =>
        !["succeeded", "rejected", "quarantined", "cancelled"].includes(request.status)
      );
      if (["cleanup_pending", "expired", "releasing"].includes(lease.state)) {
        pending += 1;
        if (currentRequests.length !== 1) {
          issues.push(`request-count:${lease.id}`);
        }
        const request = currentRequests[0];
        if (
          request !== undefined &&
          (
            request.expectedLeaseFence !== lease.fence ||
            request.expectedMembersHash !== runtimeMembersHash(members) ||
            (request.status === "executing" &&
              (request.executorLeaseUntil === null || request.executorLeaseUntil <= now))
          )
        ) {
          issues.push(`request-fence:${lease.id}`);
        }
      }
      if (lease.state === "active" && currentRequests.length > 0) {
        issues.push(`active-request:${lease.id}`);
      }
      if (lease.state === "released") {
        if (members.some((member) => member.state !== "released")) {
          issues.push(`released-members:${lease.id}`);
        }
        if (lease.bundleKind === "worktree_postgres") {
          const manifestPath = join(deps.env.home, "runtime-manifests", `${lease.id}.json`);
          const secretDirectory = join(deps.env.home, "runtime-secrets", lease.id);
          if (existsSync(manifestPath) || existsSync(secretDirectory)) {
            issues.push(`released-artifacts:${lease.id}`);
          }
        }
      }
      if (
        lease.state === "quarantined" ||
        requests.some((request) => request.status === "quarantined")
      ) {
        quarantined += 1;
        issues.push(`quarantined:${lease.id}`);
      }
    }
    view.close();
    if (
      pending > 0 &&
      (
        runtimeResources?.mode !== "enforce" ||
        runtimeResources.cleanup === undefined ||
        runtimeResources.dockerContext === undefined
      )
    ) {
      issues.push("cleanup-config");
    }
    return {
      name,
      ok: issues.length === 0,
      detail: formatRuntimeDoctorDetail({
        pending,
        quarantined,
        inconsistent: issues.length,
      }, issues),
    };
  } catch (error) {
    return { name, ok: false, detail: `診断に失敗しました: ${redactText((error as Error).message)}` };
  }
}

/** contract §55: stale session と配送先のない active request を診断する */
function checkOrchestratorRouting(deps: CliDeps): DoctorCheck {
  try {
    const now = Math.floor(Date.now() / 1000);
    const staleSessions = deps.store.listOrchestratorSessions().filter((session) =>
      session.heartbeatAt < now - ORCHESTRATOR_SESSION_STALE_SECONDS &&
      (session.status === "active" ||
        (session.status === "handoff_pending" && (session.handoffExpiresAt === null || session.handoffExpiresAt < now))),
    );
    const requests = deps.store.listOrchestratorRequests();
    const targetedRequestIds = new Set(
      deps.store.listOrchestrators().flatMap((orchestrator) =>
        deps.store.listOrchestratorRequests(orchestrator.id).map((request) => request.id),
      ),
    );
    const unavailableRequests = requests.filter((request) => !targetedRequestIds.has(request.id));
    const ok = staleSessions.length === 0 && unavailableRequests.length === 0;
    const unavailableSample = unavailableRequests.slice(0, 5).map((request) => `${request.id}:${request.taskId}`).join(",");
    const detail =
      `orchestrators=${deps.store.listOrchestrators().length}` +
      ` activeRequests=${requests.length}` +
      ` staleSessions=${staleSessions.length}` +
      ` unavailableRequests=${unavailableRequests.length}` +
      (unavailableSample === "" ? "" : ` unavailableSample=${unavailableSample}`);
    return { name: "orchestrator routing", ok, detail };
  } catch (err) {
    return { name: "orchestrator routing", ok: false, detail: (err as Error).message };
  }
}

/** web write API token のメタ情報のみ表示する（値は絶対に読まない/出さない。docs/contract.md §31.1） */
function checkWebToken(deps: CliDeps): DoctorCheck {
  const path = join(deps.env.home, "web-token");
  if (!existsSync(path)) {
    return { name: "web-token", ok: true, detail: `path=${path} exists=false mode=-` };
  }
  try {
    const mode = formatMode(statSync(path).mode);
    const ok = mode === "0600";
    const suffix = ok ? "" : " expected=0600";
    return { name: "web-token", ok, detail: `path=${path} exists=true mode=${mode}${suffix}` };
  } catch (err) {
    return { name: "web-token", ok: false, detail: `path=${path} exists=unknown mode=unknown error=${(err as Error).message}` };
  }
}

/** Telegram Bot token のメタ情報のみ表示する（値は絶対に読まない/出さない。docs/contract.md §38.2） */
function checkTelegramToken(deps: CliDeps): DoctorCheck {
  const path = join(deps.env.home, "telegram-token");
  if (!existsSync(path)) {
    return { name: "telegram-token", ok: true, detail: `path=${path} exists=false mode=-` };
  }
  try {
    const mode = formatMode(statSync(path).mode);
    const ok = mode === "0600";
    const suffix = ok ? "" : " expected=0600";
    return { name: "telegram-token", ok, detail: `path=${path} exists=true mode=${mode}${suffix}` };
  } catch (err) {
    return { name: "telegram-token", ok: false, detail: `path=${path} exists=unknown mode=unknown error=${(err as Error).message}` };
  }
}

function formatPassthroughPatchDetail(detail: string): string {
  return detail
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .slice(0, PASSTHROUGH_PATCH_DETAIL_MAX_LENGTH);
}

function isRfc3339(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
}

function parseListenerPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^p(\d+)$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids];
}

interface LsofExecutionResult {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

function executeLsof(executable: string, port: number): Promise<LsofExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
  });
}

async function inspectBridgeListener(bridge: { url: string }): Promise<CliBridgeListenerInspection> {
  let port: number;
  try {
    const url = new URL(bridge.url);
    port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new Error("port が範囲外です");
    }
  } catch (error) {
    return {
      status: "unknown",
      detail: `bridge URL から port を解決できません: ${formatPassthroughPatchDetail((error as Error).message)}`,
    };
  }

  let result = await executeLsof("lsof", port);
  if (result.error?.code === "ENOENT") {
    result = await executeLsof(MACOS_LSOF_PATH, port);
  }

  const pids = parseListenerPids(result.stdout);
  if (result.error !== null) {
    if (result.error.code === 1 && pids.length === 0 && result.stderr.trim() === "") {
      return { status: "not-listening" };
    }
    return {
      status: "unknown",
      detail: formatPassthroughPatchDetail(redactText(result.stderr.trim() || result.error.message)),
    };
  }
  if (pids.length === 0) {
    return { status: "listening", pid: null, detail: "LISTEN を検出しましたが PID を抽出できません" };
  }
  if (pids.length > 1) {
    return { status: "listening", pid: null, detail: `LISTEN PID が複数あります: ${pids.join(",")}` };
  }
  return { status: "listening", pid: pids[0] ?? null };
}

function invalidPassthroughPatchStatus(detail: string): DoctorCheck {
  return { name: "passthrough patch status", ok: false, detail };
}

interface PassthroughPatchStatusDeps extends CliDeps {
  /** status 読み取りの errno 分岐を実ファイル権限に依存せず検証するための注入口。 */
  readPassthroughPatchStatusFile?: (path: string) => string;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** hermes wrapper が書く passthrough patch 適用結果を fail-closed で診断する。 */
async function checkPassthroughPatchStatus(
  deps: PassthroughPatchStatusDeps,
  bridgeProviders: readonly Provider[],
): Promise<DoctorCheck> {
  const name = "passthrough patch status";
  const path = join(deps.hermesHome, "even-shared", "passthrough-patch-status.json");
  const readStatusFile = deps.readPassthroughPatchStatusFile ?? ((statusPath: string): string =>
    readFileSync(statusPath, "utf8"));
  let raw: string;
  try {
    raw = readStatusFile(path);
  } catch (error) {
    const errorCode = fileSystemErrorCode(error);
    if (errorCode === "ENOENT") {
      return skippedDoctorCheck(
        name,
        "writer-not-deployed",
        `${path} が存在しません（readiness の証明ではありません。wrapper 未配備の可能性があります）`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    const detail = formatPassthroughPatchDetail(
      errorCode === undefined ? message : `${errorCode}: ${message}`,
    );
    return invalidPassthroughPatchStatus(`${path} の読み込みに失敗しました: ${detail}`);
  }

  const listenerProbe = deps.bridgeListenerProbe ?? inspectBridgeListener;
  const listenerInspections = await Promise.all(bridgeProviders.map(async (provider) => {
    try {
      return await listenerProbe(deps.env.bridges[provider]);
    } catch (error) {
      return {
        status: "unknown",
        detail: formatPassthroughPatchDetail(error instanceof Error ? error.message : String(error)),
      } satisfies CliBridgeListenerInspection;
    }
  }));
  const unknown = listenerInspections.find((inspection) => inspection.status === "unknown");
  if (unknown?.status === "unknown") {
    return invalidPassthroughPatchStatus(`bridge LISTEN PID の判定に失敗しました: ${unknown.detail}`);
  }
  const listening = listenerInspections.filter((inspection) => inspection.status === "listening");
  if (listening.length === 0) {
    return skippedDoctorCheck(
      name,
      "bridge-not-running",
      "bridge が LISTEN していないためスキップしました（停止中の同一性判定は行いません）",
    );
  }
  const indeterminate = listening.find((inspection) => inspection.pid === null);
  if (indeterminate?.status === "listening") {
    const detail = indeterminate.detail ?? "PID を決定できません";
    return invalidPassthroughPatchStatus(`bridge は LISTEN していますが PID を決定できません: ${detail}`);
  }
  const listeningPids = listening.flatMap((inspection) => inspection.pid === null ? [] : [inspection.pid]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return invalidPassthroughPatchStatus(
      `${path} の JSON 解析に失敗しました: ${formatPassthroughPatchDetail((error as Error).message)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalidPassthroughPatchStatus(`${path} の必須キーが不正です: root`);
  }

  const status = parsed as Record<string, unknown>;
  const schema = status["schema"];
  if (typeof schema !== "string" || schema.length > PASSTHROUGH_PATCH_DETAIL_MAX_LENGTH) {
    return invalidPassthroughPatchStatus(`${path} の必須キーが不正です: schema`);
  }
  if (schema !== PASSTHROUGH_PATCH_STATUS_SCHEMA) {
    return invalidPassthroughPatchStatus(`未知のschemaです: ${formatPassthroughPatchDetail(schema)}`);
  }

  const requiredStrings = ["state", "evenTerminalVersion", "updatedAt", "detail"] as const;
  const invalidKeys: string[] = requiredStrings.filter((key) =>
    typeof status[key] !== "string" ||
    (key !== "detail" && status[key] === "") ||
    (typeof status[key] === "string" && status[key].length > PASSTHROUGH_PATCH_DETAIL_MAX_LENGTH)
  );
  const patchVersion = status["patchVersion"];
  if (
    patchVersion !== null &&
    (typeof patchVersion !== "string" || patchVersion === "" || patchVersion.length > PASSTHROUGH_PATCH_DETAIL_MAX_LENGTH)
  ) {
    invalidKeys.push("patchVersion");
  }
  const bridgePid = status["bridgePid"];
  if (bridgePid !== null && typeof bridgePid !== "number") {
    invalidKeys.push("bridgePid");
  }
  if (typeof status["updatedAt"] === "string" && !isRfc3339(status["updatedAt"])) {
    invalidKeys.push("updatedAt");
  }
  if (invalidKeys.length > 0) {
    return invalidPassthroughPatchStatus(
      `${path} の必須キーが不正です: ${[...new Set(invalidKeys)].join(",")}`,
    );
  }

  const state = formatPassthroughPatchDetail(status["state"] as string);
  const detail = formatPassthroughPatchDetail(status["detail"] as string);
  if (state !== "ok") {
    const applyingHint = state === "applying" ? " 数秒後に再実行してください" : "";
    return { name, ok: false, detail: `state=${state} detail=${detail}${applyingHint}` };
  }

  if (patchVersion === null) {
    return invalidPassthroughPatchStatus(`${path} は state=ok ですが patchVersion が null です`);
  }
  if (bridgePid === null || !listeningPids.includes(bridgePid as number)) {
    return invalidPassthroughPatchStatus(
      `bridgePid=${bridgePid === null ? "null" : String(bridgePid)} が LISTEN PID と一致しません`,
    );
  }
  return {
    name,
    ok: true,
    detail: `patchVersion=${formatPassthroughPatchDetail(patchVersion as string)}` +
      ` evenTerminalVersion=${formatPassthroughPatchDetail(status["evenTerminalVersion"] as string)}` +
      ` updatedAt=${formatPassthroughPatchDetail(status["updatedAt"] as string)}`,
  };
}

function formatBridgeIdentityFailure(failure: BridgeIdentityFailure): string {
  const prefix = failure.suspectPortHijack ? "ポート乗っ取りの疑い: " : "";
  return `${prefix}${failure.kind} (${failure.detail})`;
}

function skippedDoctorCheck(
  name: string,
  reason: NonNullable<DoctorCheck["reason"]>,
  detail: string,
): DoctorCheck {
  return { name, ok: true, detail, skipped: true, reason };
}

/** config profiles が実際に利用する provider×transport の集合を返す。transport 省略は bridge。 */
function configuredProviderTransports(deps: CliDeps): Record<Provider, Set<Transport>> {
  const configured: Record<Provider, Set<Transport>> = {
    codex: new Set<Transport>(),
    claude: new Set<Transport>(),
  };
  for (const profile of Object.values(deps.config.profiles)) {
    configured[profile.provider].add(profile.transport ?? "bridge");
  }
  return configured;
}

/** (4)(5) codex/claude bridge identity。未使用 bridge と --offline は probe せず構造化 skip する。 */
async function checkBridge(
  deps: CliDeps,
  provider: Provider,
  offline: boolean,
  used: boolean,
): Promise<DoctorCheck> {
  const name = `${provider} bridge`;
  if (!used) {
    return skippedDoctorCheck(
      name,
      "unused-transport",
      "config profiles で bridge transport が使用されていないためスキップしました",
    );
  }
  const tokenFile = deps.env.bridges[provider].tokenFile;
  let tokenPathExists = false;
  try {
    lstatSync(tokenFile);
    tokenPathExists = true;
  } catch {
    // full probe は欠如をfail-closedで報告する。offlineはreadiness証明ではないため従来どおりskipする。
  }
  if (tokenPathExists) {
    try {
      void readBridgeToken(tokenFile);
    } catch (error) {
      return {
        name,
        ok: false,
        detail: `bridge token file の安全性検証に失敗しました: ${redactText((error as Error).message)}`,
      };
    }
  }
  if (offline) {
    return skippedDoctorCheck(
      name,
      "offline",
      "オフラインモードのためスキップしました（readiness の証明ではありません）",
    );
  }
  try {
    const probe = deps.bridgeIdentityProbe ?? probeBridgeIdentity;
    const result = await probe(deps.env.bridges[provider]);
    if (!result.ok) {
      return { name, ok: false, detail: formatBridgeIdentityFailure(result.failure) };
    }
    return { name, ok: true, detail: `/api/sessions 本人確認OK (sessions=${result.sessionCount})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, ok: false, detail: `本人確認中にエラーが発生しました: ${redactText(message)}` };
  }
}

/** profile ごとの model×transport を実 runtime 広告と照合する。unknown は警告だが supported へ丸めない。 */
async function checkModelTransportCompatibility(
  deps: CliDeps,
  profileName: string,
  offline: boolean,
): Promise<DoctorCheck> {
  const name = `model transport (${profileName})`;
  if (offline) {
    return skippedDoctorCheck(
      name,
      "offline",
      "オフラインモードのためスキップしました（readiness の証明ではありません）",
    );
  }
  const profile = deps.config.profiles[profileName];
  if (profile === undefined) {
    return { name, ok: false, detail: "profile が存在しません" };
  }
  const transport = profile.transport ?? "bridge";
  const resolution: Extract<ModelResolution, { ok: true }> = {
    ok: true,
    provider: profile.provider,
    model: profile.model,
    source: "profile",
    transport,
    ...(profile.effort === undefined ? {} : { effort: profile.effort }),
  };
  const observation = await observeResolvedModelTransportCompatibility(
    deps,
    resolution,
    { model: false, effort: false },
  );
  const runtime = observation.observed === null
    ? "unknown"
    : `${observation.observed.runtime.name}@${observation.observed.runtime.version ?? "unknown"}`;
  const capabilities = observation.observed?.capabilities.join(",") ?? "unknown";
  if (observation.decision.status === "supported") {
    return {
      name,
      ok: true,
      detail: `supported evidence=${observation.decision.evidence} runtime=${runtime} capabilities=${capabilities}`,
    };
  }
  const detail = `${observation.decision.status} reason=${observation.decision.reason}` +
    ` detail=${observation.decision.detail} runtime=${runtime} capabilities=${capabilities}`;
  return observation.decision.status === "unknown"
    ? { name, ok: true, detail: `警告: ${detail}` }
    : { name, ok: false, detail };
}

/** heartbeat ファイルから ts（epoch 秒）のみを取り出す。壊れた JSON/型不一致は null（docs/contract.md §33.1） */
function parseHeartbeatTs(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const ts = (parsed as Record<string, unknown>).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

/**
 * (6) supervisor heartbeat: $HACHI_KANBAN_HOME/state/supervisor-heartbeat.json の存在と鮮度を検査する
 * （docs/contract.md §33.1/§33.3）。欠如/陳腐化/JSON パース失敗は NG。--offline は skip。
 */
function checkSupervisorHeartbeat(deps: CliDeps, offline: boolean): DoctorCheck {
  const name = "supervisor heartbeat";
  if (offline) {
    return skippedDoctorCheck(
      name,
      "offline",
      "オフラインモードのためスキップしました（readiness の証明ではありません）",
    );
  }

  const path = join(deps.env.home, "state", "supervisor-heartbeat.json");
  if (!existsSync(path)) {
    return { name, ok: false, detail: `${path} が存在しません（supervisor 未起動の可能性があります）` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { name, ok: false, detail: `${path} の読み込みに失敗しました: ${(err as Error).message}` };
  }

  const ts = parseHeartbeatTs(raw);
  if (ts === null) {
    return { name, ok: false, detail: `${path} の JSON 解析に失敗しました（ts が不正です）` };
  }

  const elapsedSec = Math.floor(Date.now() / 1000) - ts;
  const ok = elapsedSec <= HEARTBEAT_STALE_SEC;
  const detail = ok
    ? `最終ts=${ts}（${elapsedSec}秒前）`
    : `最終ts=${ts}（${elapsedSec}秒前、鮮度閾値${HEARTBEAT_STALE_SEC}秒を超過しています）`;
  return { name, ok, detail };
}

/** HACHI_KANBAN_WEB_PORT を解決する（docs/contract.md §14.2 と同じ既定値）。不正な値は throw（fail-closed） */
function resolveWebPort(processEnv: NodeJS.ProcessEnv): number {
  const raw = processEnv.HACHI_KANBAN_WEB_PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_WEB_PORT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`不正な HACHI_KANBAN_WEB_PORT です: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`不正な HACHI_KANBAN_WEB_PORT です: ${raw}`);
  }
  return parsed;
}

/** healthz のレスポンス body が `{ ok: true }` 形状を満たすか判定する */
function isHealthzOkBody(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).ok === true;
}

/**
 * (7) web healthz: GET http://127.0.0.1:<port>/healthz が 200 かつ body.ok===true であることを検査する
 * （docs/contract.md §14.3/§33.3）。--offline は skip。テストでは global fetch を stub する。
 */
async function checkWebHealthz(offline: boolean): Promise<DoctorCheck> {
  const name = "web healthz";
  if (offline) {
    return skippedDoctorCheck(
      name,
      "offline",
      "オフラインモードのためスキップしました（readiness の証明ではありません）",
    );
  }

  let url: string;
  try {
    url = `http://127.0.0.1:${resolveWebPort(process.env)}/healthz`;
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }

  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(WEB_HEALTHZ_TIMEOUT_MS) });
    if (response.status !== 200) {
      return { name, ok: false, detail: `${url} status=${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { name, ok: false, detail: `${url} の応答 JSON 解析に失敗しました` };
    }
    if (!isHealthzOkBody(body)) {
      return { name, ok: false, detail: `${url} の応答が ok:true ではありません` };
    }
    return { name, ok: true, detail: `${url} ok=true` };
  } catch (err) {
    return { name, ok: false, detail: `${url} への接続に失敗しました: ${(err as Error).message}` };
  }
}

/** steward 状態ファイルの型 */
interface StewardState {
  lastRunAt: number;
  lastProposalCount: number;
  lastAppliedCount: number;
  lastProposedCount: number;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  claimGeneration: number;
  /** §74.3: 直近 tick で integrationEvidence 別に自動 archive した件数（表示専用。判断ロジックは持たない） */
  lastArchivedByEvidence: Record<string, number>;
}

interface StewardConfig {
  intervalMinutes?: number;
}

interface ConfigWithSteward {
  steward?: StewardConfig;
  brief?: { times: string[] };
}

/** steward 状態の鮮度閾値（秒）。cadence + heartbeat grace で正常周期を NG にしない */
function resolveStewardStaleSec(deps: CliDeps): number {
  const config = deps.config as CliDeps["config"] & ConfigWithSteward;
  const intervalMinutes = config.steward?.intervalMinutes ?? DEFAULT_STEWARD_INTERVAL_MINUTES;
  return intervalMinutes * 60 + HEARTBEAT_STALE_SEC;
}

/**
 * state/steward.json の lastArchivedByEvidence を防御的にパースする。
 * doctor は表示専用で判断ロジックを持たないため、evidence キーの allowlist は行わず
 * value が number のものだけをそのまま採用する。壊れていれば空 object へ落とす。
 */
function parseArchivedByEvidence(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count)) {
      result[key] = count;
    }
  }
  return result;
}

/** steward 状態ファイルを安全にパースする。壊れた JSON は null */
function parseStewardState(raw: string): StewardState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.lastRunAt !== "number" || !Number.isFinite(obj.lastRunAt)) {
    return null;
  }
  const claimGeneration = parseOptionalClaimGeneration(obj.claimGeneration);
  if (claimGeneration === null) {
    return null;
  }
  return {
    lastRunAt: obj.lastRunAt,
    lastProposalCount: typeof obj.lastProposalCount === "number" ? obj.lastProposalCount : 0,
    lastAppliedCount: typeof obj.lastAppliedCount === "number" ? obj.lastAppliedCount : 0,
    lastProposedCount: typeof obj.lastProposedCount === "number" ? obj.lastProposedCount : 0,
    lastError: typeof obj.lastError === "string" ? obj.lastError : "",
    consecutiveFailures: typeof obj.consecutiveFailures === "number" ? obj.consecutiveFailures : 0,
    autoDisabled: typeof obj.autoDisabled === "boolean" ? obj.autoDisabled : false,
    autoDisabledReason: typeof obj.autoDisabledReason === "string" ? obj.autoDisabledReason : "",
    claimGeneration,
    lastArchivedByEvidence: parseArchivedByEvidence(obj.lastArchivedByEvidence),
  };
}

/** steward 状態ファイルの健全性を検査する（オフライン互換） */
function checkStewardState(deps: CliDeps): DoctorCheck {
  const name = "steward state";
  const path = join(deps.env.home, "state", "steward.json");

  // ファイルが存在しない場合は steward 未実行として OK
  if (!existsSync(path)) {
    return { name, ok: true, detail: `${path} が存在しません（steward 未実行）` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { name, ok: false, detail: `${path} の読み込みに失敗しました: ${(err as Error).message}` };
  }

  const state = parseStewardState(raw);
  if (state === null) {
    return { name, ok: false, detail: `${path} の JSON 解析に失敗しました` };
  }

  // 自動無効化されている場合は警告
  if (state.autoDisabled) {
    const reason = state.autoDisabledReason !== "" ? `: ${state.autoDisabledReason}` : "";
    return {
      name,
      ok: false,
      detail: `steward は自動無効化されています${reason} claimGeneration=${state.claimGeneration}`,
    };
  }

  // 鮮度チェック（supervisor heartbeat ほど厳密ではないため warn レベル）
  const elapsedSec = Math.floor(Date.now() / 1000) - state.lastRunAt;
  const staleSec = resolveStewardStaleSec(deps);
  if (elapsedSec > staleSec) {
    return {
      name,
      ok: false,
      detail: `最終実行=${state.lastRunAt}（${elapsedSec}秒前、鮮度閾値${staleSec}秒を超過しています） claimGeneration=${state.claimGeneration}`,
    };
  }

  // §74.3: 「統合を観測せずに archive した件数」として not-observable:* のみを可視化する。
  // clean-head-reachable / clean-patch-equivalent は統合を観測した上での archive であり、
  // ここに含めると事実誤認（観測していないのに観測済みと表示）になるため除外する（0件なら追記しない）
  const evidenceEntries = Object.entries(state.lastArchivedByEvidence).filter(([evidence]) =>
    evidence.startsWith("not-observable:"),
  );
  const archivedByEvidenceDetail =
    evidenceEntries.length === 0
      ? ""
      : ` archivedByEvidence={${evidenceEntries.map(([evidence, count]) => `${evidence}:${count}`).join(",")}}`;

  return {
    name,
    ok: true,
    detail: `最終実行=${state.lastRunAt}（${elapsedSec}秒前）proposals=${state.lastProposalCount} applied=${state.lastAppliedCount} proposed=${state.lastProposedCount} consecutiveFailures=${state.consecutiveFailures} claimGeneration=${state.claimGeneration} lastError=${state.lastError}${archivedByEvidenceDetail}`,
  };
}

interface BriefState {
  lastRunAt: number;
  lastError: string;
  consecutiveFailures: number;
  autoDisabled: boolean;
  autoDisabledReason: string;
  claimGeneration: number;
}

function parseOptionalClaimGeneration(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseBriefState(raw: string): BriefState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const claimGeneration = parseOptionalClaimGeneration(record["claimGeneration"]);
  if (typeof record["lastRunAt"] !== "number" || !Number.isSafeInteger(record["lastRunAt"]) || record["lastRunAt"] < 0 ||
      typeof record["lastError"] !== "string" ||
      typeof record["consecutiveFailures"] !== "number" || !Number.isSafeInteger(record["consecutiveFailures"]) ||
      record["consecutiveFailures"] < 0 || typeof record["autoDisabled"] !== "boolean" ||
      typeof record["autoDisabledReason"] !== "string" || claimGeneration === null) {
    return null;
  }
  return {
    lastRunAt: record["lastRunAt"],
    lastError: record["lastError"],
    consecutiveFailures: record["consecutiveFailures"],
    autoDisabled: record["autoDisabled"],
    autoDisabledReason: record["autoDisabledReason"],
    claimGeneration,
  };
}

function latestBriefSlot(now: Date, times: readonly string[]): number | null {
  const candidates: number[] = [];
  for (const dayOffset of [0, -1]) {
    for (const time of times) {
      const [hourRaw, minuteRaw] = time.split(":");
      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        continue;
      }
      const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute);
      if (slot.getTime() <= now.getTime()) {
        candidates.push(Math.floor(slot.getTime() / 1000));
      }
    }
  }
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** briefの停止をstewardと同じdoctor面へ出す。復旧mutationは専用fenced CLIが実装されるまで行わない。 */
function checkBriefState(deps: CliDeps): DoctorCheck {
  const name = "brief state";
  const config = deps.config as CliDeps["config"] & ConfigWithSteward;
  if (config.brief === undefined) {
    return { name, ok: true, detail: "brief config 未定義のためスキップしました" };
  }
  const path = join(deps.env.home, "state", "brief.json");
  if (!existsSync(path)) {
    return { name, ok: true, detail: `${path} が存在しません（brief 未実行）` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { name, ok: false, detail: `${path} の読み込みに失敗しました: ${(error as Error).message}` };
  }
  const state = parseBriefState(raw);
  if (state === null) {
    return { name, ok: false, detail: `${path} の JSON 解析に失敗しました` };
  }
  if (state.autoDisabled) {
    const reason = state.autoDisabledReason === "" ? "" : `: ${state.autoDisabledReason}`;
    return {
      name,
      ok: false,
      detail: `brief は自動無効化されています${reason} claimGeneration=${state.claimGeneration}`,
    };
  }
  const now = new Date();
  const latestSlot = latestBriefSlot(now, config.brief.times);
  const nowSec = Math.floor(now.getTime() / 1000);
  if (latestSlot !== null && nowSec > latestSlot + HEARTBEAT_STALE_SEC && state.lastRunAt < latestSlot) {
    return {
      name,
      ok: false,
      detail: `最終実行=${state.lastRunAt}（直近予定=${latestSlot}を完了していません） claimGeneration=${state.claimGeneration}`,
    };
  }
  return {
    name,
    ok: true,
    detail: `最終実行=${state.lastRunAt} consecutiveFailures=${state.consecutiveFailures} claimGeneration=${state.claimGeneration} lastError=${state.lastError}`,
  };
}

/** §40.6: main/guard lockをread-only診断し、残骸・malformedを自動削除せず可視化する。 */
function checkStewardStateLock(deps: CliDeps): DoctorCheck {
  const inspection = inspectStewardStateLocks(deps.env.home);
  return { name: "steward state lock", ok: inspection.ok, detail: inspection.detail };
}

function readDirectSessionProcessRecords(home: string): DirectSessionProcessRecord[] {
  const dir = join(home, "state", "direct-sessions");
  if (!existsSync(dir)) {
    return [];
  }

  const records: DirectSessionProcessRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const path = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.pid !== "number" || !Number.isSafeInteger(obj.pid) || obj.pid <= 1) {
      continue;
    }
    const exitFile = typeof obj.exitFile === "string" ? obj.exitFile : join(dir, entry.replace(/\.json$/, ".exit"));
    records.push({ pid: obj.pid, exitExists: existsSync(exitFile) });
  }
  return records;
}

async function checkWorkerProcessHygiene(deps: CliDeps): Promise<DoctorCheck> {
  const name = "worker process hygiene";
  const listProcesses = deps.processListProvider ?? listSystemProcesses;
  try {
    const processes = await listProcesses();
    const maxRunSeconds = deps.config.resourceGuard.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;
    const bridge = evaluateBridgeProcessHygiene(processes, maxRunSeconds, PROCESS_HYGIENE_REAP_LIMIT);
    const directResidualGroups = countDirectResidualGroups(processes, readDirectSessionProcessRecords(deps.env.home));
    const ok = bridge.bridgeDescendantCount <= PROCESS_HYGIENE_WARN_DESCENDANTS;
    const reason = bridge.failOpenReason !== "" ? ` failOpen=${bridge.failOpenReason}` : "";
    const detail =
      `bridgeDescendants=${bridge.bridgeDescendantCount} bridgeOrphans=${bridge.orphanCount}` +
      ` directResidualGroups=${directResidualGroups}${reason}`;
    return { name, ok, detail: ok ? detail : `${detail} warn: bridgeDescendants>200` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, ok: true, detail: `走査に失敗したためスキップしました: ${redactText(message)}` };
  }
}

/**
 * provider native communication の local readiness を表示する。
 * runtime probe や外部 built-in tool を doctor から起動せず、trusted config、保存済み
 * binding の鮮度/version、DIされた adapter の存在だけを検査する。canary/on は
 * adapter/bindingが無い場合にNGへ倒し、off/observe/drainingはlegacy非回帰でOKとする。
 */
function checkNativeCommunicationReadiness(deps: CliDeps, offline: boolean): DoctorCheck {
  const name = "native communication readiness";
  const configured = deps.config.communication;
  if (configured === undefined) {
    return { name, ok: true, detail: "config=unset rollout=off adapter=not-required runtime=not-required" };
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const bindings = (deps.store as CliDeps["store"] & {
      listNativeSessionBindings?: () => Array<{
        provider: Provider;
        kind: "source" | "target";
        hostId: string;
        runtimeVersion: string;
        capabilityHash: string;
        status: "active" | "released";
        expiresAt: number;
      }>;
    }).listNativeSessionBindings?.() ?? [];
    const issues: string[] = [];
    const details: string[] = [];
    for (const provider of PROVIDERS) {
      const policy = resolveCommunicationProviderConfig(deps.config, provider);
      const adapter = deps.nativeCommunicationAdapters?.[provider];
      const providerBindings = bindings.filter((binding) => binding.provider === provider);
      const active = providerBindings.filter((binding) => binding.status === "active" && binding.expiresAt > now);
      const runtimeVersions = [...new Set(active.map((binding) => binding.runtimeVersion))];
      const hosts = [...new Set(active.map((binding) => binding.hostId))];
      const adapterRoute = provider === "claude" ? "claude-cross-session" : "codex-app-server";
      const adapterReady = adapter !== undefined && adapter.provider === provider && adapter.route === adapterRoute;
      const versionReady = policy.minimumRuntimeVersion === undefined || active.length > 0 &&
        active.every((binding) => isStrictSemver(binding.runtimeVersion) &&
          compareStrictSemver(binding.runtimeVersion, policy.minimumRuntimeVersion!) >= 0);
      const runtime = runtimeVersions.length === 0 ? "none" : runtimeVersions.join(",");
      const requiredNative = policy.rollout === "canary" || policy.rollout === "on";
      if (requiredNative && !offline) {
        if (!adapterReady) issues.push(`${provider}:adapter`);
        if (active.length === 0) issues.push(`${provider}:binding`);
        if (!versionReady) issues.push(`${provider}:version`);
        if (policy.sameHostOnly === true && hosts.length > 1) issues.push(`${provider}:host`);
      }
      details.push(
        `${provider}{rollout=${policy.rollout} config=ok minVersion=${policy.minimumRuntimeVersion ?? "-"}` +
        ` claimLease=${policy.claimLeaseSeconds}s bindingTtl=${policy.bindingTtlSeconds}s` +
        ` canary=${policy.canaryPercent ?? "-"} adapter=${adapterReady ? "ready" : "absent"}` +
        ` runtime=${runtime} activeBindings=${active.length}${offline && requiredNative ? " probe=offline" : ""}}`,
      );
    }
    return {
      name,
      ok: issues.length === 0,
      detail: `${details.join(" ")}${issues.length === 0 ? "" : ` issues=${issues.join(",")}`}`,
      ...(offline && PROVIDERS.some((provider) => {
        const rollout = resolveCommunicationProviderConfig(deps.config, provider).rollout;
        return rollout === "canary" || rollout === "on";
      }) ? { skipped: true, reason: "offline" as const } : {}),
    };
  } catch (err) {
    return { name, ok: false, detail: `native readiness診断に失敗しました: ${redactText((err as Error).message)}` };
  }
}

/** (8) kill-switch ファイル列挙 */
function checkKillSwitches(deps: CliDeps): DoctorCheck {
  try {
    if (!existsSync(deps.env.home)) {
      return { name: "kill-switch", ok: true, detail: "0件（home ディレクトリなし）" };
    }
    const entries = readdirSync(deps.env.home).filter((entry) => entry.endsWith(".disabled"));
    const detail = entries.length === 0 ? "0件" : `${entries.length}件: ${entries.join(", ")}`;
    return { name: "kill-switch", ok: true, detail };
  } catch (err) {
    return { name: "kill-switch", ok: false, detail: (err as Error).message };
  }
}

/**
 * live session を持つ identity だけを対象に、handover の副作用ゼロ preflight を実行する。
 * delivery attest は --apply 専用なので、この検査では実行せず合否にも含めない。
 */
function checkHandoverPreflight(deps: CliDeps): DoctorCheck {
  const name = "handover preflight";
  const targets = deps.store.listOrchestrators().filter((orchestrator) =>
    deps.store.listOrchestratorSessions(orchestrator.id).some((session) => session.status === "active"),
  );
  if (targets.length === 0) {
    return {
      name,
      ok: true,
      detail: "対象0件（live session を持つ identity なし）。handover preflight のみ、delivery は未検査です",
    };
  }

  const failures = targets.flatMap((orchestrator) => {
    try {
      const inspection = inspectOrchestratorHandoverPreflight(deps, orchestrator.id);
      return inspection.preflight
        .filter((check) => !check.ok)
        .map((check) => ({
          orchestrator,
          checkName: check.name,
          reason: check.reason ?? check.name,
        }));
    } catch (err) {
      return [{
        orchestrator,
        checkName: "preflight-evaluation",
        reason: err instanceof Error ? err.message : String(err),
      }];
    }
  });
  if (failures.length === 0) {
    return {
      name,
      ok: true,
      detail: `${targets.length} identity の handover preflight が green です。delivery は未検査です`,
    };
  }

  const failedIdentityCount = new Set(failures.map((failure) => failure.orchestrator.id)).size;
  const failureDetail = failures.map((failure) =>
    `identity=${failure.orchestrator.id} label=${failure.orchestrator.label}` +
    ` check=${failure.checkName} reason=${redactText(failure.reason)}`,
  ).join(" | ");
  return {
    name,
    ok: false,
    detail:
      `対象=${targets.length} identity、NG=${failedIdentityCount} identity。` +
      `${failureDetail}。handover preflight のみ、delivery は未検査です`,
  };
}

/**
 * (9) supervisor.jsonl の size-based rotation 状態を検査する。
 * 現行ファイルが閾値到達（rotate が機能していない）、世代ファイルが上限数を超えて残留
 * （cleanup が機能していない）、または config.json の logging セクション自体が壊れている
 * 場合を NG にする（logger 側は動作継続を優先し既定値へ fail-open するが、doctor は
 * 壊れた設定を検知するのが役目なので握りつぶさない）。ファイル/ログ未作成は OK。
 * 実効の閾値・保持世代数に加え、その出所（config.json 明示指定 or スキーマ既定値）も
 * 表示する（R2: config.json に logging が無くても、doctor を見れば「今の実効値は何か」
 * 「変更するにはどうすればよいか」が分かるようにする。ここが 643MB まで誰も気づけなかった
 * 実害への対処の核心）。ネットワークに出ないため --offline でも常に実行する。
 */
function checkLogRotation(deps: CliDeps): DoctorCheck {
  const name = "log rotation";
  try {
    const validation = validateLogRotationConfig(deps.env);
    if (!validation.ok) {
      return { name, ok: false, detail: validation.error };
    }
    const config = validation.config;
    const source = validation.source;

    const filePath = join(deps.env.home, "logs", "supervisor.jsonl");
    const state = inspectLogRotationState(filePath);

    const issues: string[] = [];
    // rotate 側のトリガー条件（size >= maxSizeBytes）と揃える。閾値到達直後〜次回書き込みまでの
    // 短い間は正常運用でも到達状態が観測されうる（その回の書き込みで rotate される）。
    if (state.currentSizeBytes >= config.maxSizeBytes) {
      issues.push(`現行ファイルが閾値到達(${state.currentSizeBytes}B >= ${config.maxSizeBytes}B)`);
    }
    if (state.generationCount > config.maxGenerations) {
      issues.push(`世代数が上限超過(${state.generationCount} > ${config.maxGenerations})`);
    }

    const totalBytes = state.currentSizeBytes + state.rotatedSizeBytes;
    const sourceDetail =
      source === "config"
        ? "source=config(config.jsonのloggingセクションで指定)"
        : "source=schema-default(config.jsonにloggingセクションを追加すると変更可能)";
    const detail =
      `current=${state.currentSizeBytes}B generations=${state.generationCount} total=${totalBytes}B ` +
      `threshold=${config.maxSizeBytes}B/${config.maxGenerations}世代 ${sourceDetail}` +
      (issues.length === 0 ? "" : ` issues=${issues.join(",")}`);

    return { name, ok: issues.length === 0, detail };
  } catch (err) {
    return { name, ok: false, detail: `診断に失敗しました: ${(err as Error).message}` };
  }
}

/**
 * オーケストレーターヘルパー1本の検査状態。判定に使うのは必ずこの `state`（完全一致）であり、
 * `detail` は表示専用の文字列（エラー詳細に任意のパスが混じるため判定に使ってはならない）。
 * 過去に `results.every((r) => r.endsWith("=ok"))` という suffix 判定を使っていたことがあり、
 * `outside-repo:/tmp/outside=ok` のように解決先パス自体が偶然 `=ok` で終わると異常なのに
 * ok 扱いされる fail-open があった（t_eac0371a7a1a368e rework 2周目）。state は固定の
 * literal union なので、判定対象パスの中身がどんな文字列であっても誤判定しない。
 */
type OrchestratorHelperState =
  | "ok"
  | "missing"
  | "stat-error"
  | "not-a-shim-file"
  | "shim-not-executable"
  | "read-error"
  | "not-a-shim"
  | "unexpected-source"
  | "outside-repo"
  | "source-missing"
  | "source-stat-error"
  | "source-not-a-file"
  | "source-not-executable";

/** オーケストレーターヘルパー1本の検査結果。`state` が判定用、`detail` は表示専用。 */
interface OrchestratorHelperResult {
  readonly name: string;
  readonly state: OrchestratorHelperState;
  readonly detail: string;
}

/** `OrchestratorHelperResult` を組み立てる（表示用 detail は `<name>=<state>[:<extra>]` 形式に統一）。 */
function orchestratorHelperResult(
  name: string,
  state: OrchestratorHelperState,
  extra?: string,
): OrchestratorHelperResult {
  return { name, state, detail: extra === undefined ? `${name}=${state}` : `${name}=${state}:${extra}` };
}

/**
 * 1本のオーケストレーターヘルパーシムを検査し、構造化した結果（`state` + 表示用 `detail`）を返す。
 * `state === "ok"` とみなすのは、exec シム形式・解決先が repo 内の期待 script と exact 一致・
 * かつシム自身と解決先実体の両方が実行可能（execute bit あり）な場合だけ。
 * シムだけ実行可能で解決先実体が `chmod -x` されていた場合、シム経由の実行は
 * `exec: Permission denied` で失敗するため、解決先側の実行権限も見る必要がある
 * （t_eac0371a7a1a368e レビュー: 実行権限欠落を取りこぼしてokになる問題への対応）。
 */
function inspectOrchestratorHelper(
  binDir: string,
  repoRoot: string,
  spec: { readonly name: string; readonly repoRelativeSource: string },
): OrchestratorHelperResult {
  const target = join(binDir, spec.name);
  const expectedSource = resolve(repoRoot, spec.repoRelativeSource);
  if (!existsSync(target)) {
    return orchestratorHelperResult(spec.name, "missing");
  }
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    return orchestratorHelperResult(
      spec.name,
      "stat-error",
      fileSystemErrorCode(error) ?? (error as Error).message,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return orchestratorHelperResult(spec.name, "not-a-shim-file");
  }
  if (!hasAnyExecuteBit(stat.mode)) {
    return orchestratorHelperResult(spec.name, "shim-not-executable", formatMode(stat.mode));
  }
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch (error) {
    return orchestratorHelperResult(
      spec.name,
      "read-error",
      fileSystemErrorCode(error) ?? (error as Error).message,
    );
  }
  const match = ORCHESTRATOR_HELPER_SHIM_PATTERN.exec(content);
  if (match === null) {
    return orchestratorHelperResult(spec.name, "not-a-shim");
  }
  const resolvedSource = resolve(match[1] as string);
  if (resolvedSource !== expectedSource) {
    const withinRepo = resolvedSource === repoRoot || resolvedSource.startsWith(`${repoRoot}${sep}`);
    return orchestratorHelperResult(spec.name, withinRepo ? "unexpected-source" : "outside-repo", resolvedSource);
  }
  let sourceStat;
  try {
    sourceStat = statSync(expectedSource);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") {
      return orchestratorHelperResult(spec.name, "source-missing", expectedSource);
    }
    return orchestratorHelperResult(
      spec.name,
      "source-stat-error",
      fileSystemErrorCode(error) ?? (error as Error).message,
    );
  }
  if (!sourceStat.isFile()) {
    return orchestratorHelperResult(spec.name, "source-not-a-file", expectedSource);
  }
  if (!hasAnyExecuteBit(sourceStat.mode)) {
    return orchestratorHelperResult(
      spec.name,
      "source-not-executable",
      `${formatMode(sourceStat.mode)}:${expectedSource}`,
    );
  }
  return orchestratorHelperResult(spec.name, "ok");
}

/**
 * (N) `~/.local/bin` 配下のオーケストレーター運用ヘルパー
 * （hachi-handover-now/hhn/hachi-orch-enable/cc-cache-ttl/hachi-watch-stop）が
 * repo内のexecシムとして導入されているかを「警告として」報告する。マシン再構築でこれらが
 * 失われるとplaybookの引き継ぎ・消費監視の立ち上げ手順が実行不能になる（t_eac0371a7a1a368e）。
 * ただしこの5本はオーケストレーター運用者だけが必要とするもので、一般利用者の環境には
 * 存在しないのが正常なため、欠落でも `ok: false` にはせず `detail` に `警告: ` を付けて
 * 報告する（`model transport (*)` の decision=unknown と同じ扱い）。
 * 警告を出すかの判定は必ず構造化された `state` の完全一致で行い、表示用の `detail` 文字列
 * （解決先パスなど任意の内容を含み得る）は判定に使わない（t_eac0371a7a1a368e rework 2周目）。
 * 欠落内容はオーケストレーター運用者に見えないと困るので、`state` ごとの内訳
 * （missing / not-a-shim / unexpected-source 等）は警告時も `detail` にそのまま残す。
 */
function checkOrchestratorHelpers(deps: CliDeps): DoctorCheck {
  const name = "orchestrator helpers";
  const binDir = deps.orchestratorHelperBinDir ?? join(homedir(), ".local", "bin");
  const repoRoot = resolve(deps.orchestratorHelperRepoRoot ?? DEFAULT_ORCHESTRATOR_HELPER_REPO_ROOT);
  const results = ORCHESTRATOR_HELPER_SPECS.map((spec) => inspectOrchestratorHelper(binDir, repoRoot, spec));
  const allInstalled = results.every((result) => result.state === "ok");
  const breakdown = `binDir=${binDir} repoRoot=${repoRoot} ${results.map((result) => result.detail).join(" ")}`;
  const detail = allInstalled
    ? breakdown
    : `警告: オーケストレーター運用ヘルパーが未導入または不一致です` +
      `（オーケストレーター運用者以外は無視可。導入は scripts/setup-local.mjs --apply）: ${breakdown}`;
  return { name, ok: true, detail };
}

/** hachi doctor の action 本体 */
async function runDoctor(deps: CliDeps, options: DoctorOptions): Promise<void> {
  const offline = options.offline === true;
  const json = options.json === true;

  const checks: DoctorCheck[] = [
    checkHome(deps),
    checkConfig(deps),
    checkDb(deps),
    checkVerifyDirectives(deps),
    checkCodexSuccessorAttestation(deps),
    checkOrchestratorRouting(deps),
    checkRuntimeResourceProfiles(deps),
    checkRuntimeResourceLeases(deps),
    checkRuntimeResourceCleanup(deps),
    checkWebToken(deps),
    checkTelegramToken(deps),
  ];
  // Legacy config (communication omitted) keeps the existing doctor surface unchanged.
  // Once the pilot section is present, expose its config/runtime/version/adapter readiness.
  if (deps.config.communication !== undefined) {
    checks.push(checkNativeCommunicationReadiness(deps, offline));
  }
  const configuredTransports = configuredProviderTransports(deps);
  for (const provider of PROVIDERS) {
    checks.push(await checkBridge(deps, provider, offline, configuredTransports[provider].has("bridge")));
  }
  const bridgeProviders = PROVIDERS.filter((provider) => configuredTransports[provider].has("bridge"));
  if (bridgeProviders.length > 0) {
    checks.push(await checkPassthroughPatchStatus(deps, bridgeProviders));
  }
  for (const profileName of Object.keys(deps.config.profiles).sort()) {
    checks.push(await checkModelTransportCompatibility(deps, profileName, offline));
  }
  checks.push(checkSupervisorHeartbeat(deps, offline));
  checks.push(await checkWebHealthz(offline));
  checks.push(checkStewardState(deps));
  checks.push(checkStewardStateLock(deps));
  checks.push(checkBriefState(deps));
  checks.push(await checkWorkerProcessHygiene(deps));
  checks.push(checkKillSwitches(deps));
  checks.push(checkLogRotation(deps));
  checks.push(checkHandoverPreflight(deps));
  checks.push(checkOrchestratorHelpers(deps));

  const ok = checks.every((check) => check.ok);
  const textLines = checks.map((check) => `[${check.ok ? "OK" : "NG"}] ${check.name}: ${check.detail}`);

  emit(deps, json, { checks, ok }, textLines);

  if (!ok) {
    deps.exit(1);
  }
}

/** hachi doctor コマンドを登録する */
export function registerDoctorCommand(program: Command, deps: CliDeps): void {
  program
    .command("doctor")
    .description("環境の健全性を検査する")
    .option("--offline", "外形監視と runtime probe をスキップする（実ネットワークに出ない・readiness 証明にはならない）")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: DoctorOptions): Promise<void> => runDoctor(deps, options)));
}
