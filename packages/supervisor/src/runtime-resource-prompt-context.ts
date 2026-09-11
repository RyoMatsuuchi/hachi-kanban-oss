import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createRuntimeResourceReadView } from "@hachi/core";
import type { RuntimeBundleKind, TaskRow } from "@hachi/core";
import type { RuntimeResourceBundleKind, WorkerRuntimeResourceContext } from "./prompt.js";
import type { RuntimeResourceBinding } from "./runtime-resource-dispatch.js";

const WORKER_VISIBLE_BUNDLE_KINDS = new Set<RuntimeResourceBundleKind>([
  "worktree_postgres",
  "worktree_preview",
  "shared_main_db_exception",
]);

function isWorkerVisibleBundleKind(kind: RuntimeBundleKind): kind is RuntimeResourceBundleKind {
  return WORKER_VISIBLE_BUNDLE_KINDS.has(kind as RuntimeResourceBundleKind);
}

/**
 * worker 起動直前のDB snapshotから、promptへ公開してよい非secret lease参照だけを構築する。
 * run bind済み・別worktree・非active・legacy leaseは、新しいworkerへ引き継がない。
 */
export function readRuntimeResourcePromptContext(
  dbPath: string,
  home: string,
  task: TaskRow,
  cwd: string,
  allowedBindings?: readonly RuntimeResourceBinding[],
): WorkerRuntimeResourceContext | undefined {
  const canonicalWorktree = realpathSync.native(cwd);
  const view = createRuntimeResourceReadView(dbPath);
  try {
    const readyLeaseIds = new Set(
      view
        .requirementsForTask(task.id)
        .filter((requirement) => requirement.status === "ready" && requirement.leaseId !== "")
        .map((requirement) => requirement.leaseId),
    );
    let manifestPath: string | undefined;
    const allowedLeaseIds = allowedBindings === undefined
      ? null
      : new Set(allowedBindings.map((binding) => binding.leaseId));
    const leases = view
      .leasesForTask(task.id)
      .filter(
        (lease) =>
          lease.state === "active" &&
          lease.ownerTaskId === task.id &&
          (allowedLeaseIds === null ? lease.ownerRunId === null : allowedLeaseIds.has(lease.id)) &&
          lease.controllerOrchestratorId !== null &&
          lease.canonicalWorktree === canonicalWorktree &&
          readyLeaseIds.has(lease.id),
      )
      .flatMap((lease) => {
        if (!isWorkerVisibleBundleKind(lease.bundleKind)) {
          return [];
        }
        if (lease.bundleKind === "worktree_postgres") {
          const candidate = join(home, "runtime-manifests", `${lease.id}.json`);
          const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
          const secretFilePath = parsed["secretFilePath"];
          const endpoint = view.members(lease.id).find((member) => member.kind === "postgres_endpoint" && member.state === "active");
          const secretRoot = realpathSync.native(join(home, "runtime-secrets", lease.id));
          if (
            parsed["version"] !== 1 ||
            parsed["leaseId"] !== lease.id ||
            parsed["fence"] !== lease.fence ||
            parsed["host"] !== "127.0.0.1" ||
            !Number.isInteger(parsed["port"]) ||
            endpoint === undefined ||
            endpoint.hostIp !== parsed["host"] ||
            endpoint.hostPort !== parsed["port"] ||
            typeof parsed["database"] !== "string" ||
            !/^hachi_[a-z0-9]+$/u.test(parsed["database"]) ||
            typeof parsed["role"] !== "string" ||
            !/^hachi_[a-z0-9]+$/u.test(parsed["role"]) ||
            typeof secretFilePath !== "string" ||
            !isAbsolute(secretFilePath) ||
            relative(secretRoot, realpathSync.native(secretFilePath)).startsWith("..") ||
            lstatSync(secretFilePath).isSymbolicLink() ||
            (lstatSync(secretFilePath).mode & 0o077) !== 0
          ) {
            throw new Error("worktree PostgreSQL manifest/secret reference の検証に失敗しました");
          }
          manifestPath = candidate;
        }
        return [{ leaseId: lease.id, bundleKind: lease.bundleKind, fence: lease.fence }];
      });

    return leases.length === 0
      ? undefined
      : { ...(manifestPath === undefined ? {} : { manifestPath }), leases };
  } finally {
    view.close();
  }
}
