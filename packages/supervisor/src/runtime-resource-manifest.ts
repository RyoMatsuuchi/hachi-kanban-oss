import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { RuntimeResourceLeaseRow } from "@hachi/core";

/**
 * lease fence の更新をworker公開用manifestへ原子的に追従させる。
 * lease IDと既存fenceの単調性を検証し、別lease/future fenceのファイルは上書きしない。
 */
export function synchronizeRuntimeResourceManifestFence(
  home: string,
  lease: RuntimeResourceLeaseRow,
): boolean {
  if (lease.bundleKind !== "worktree_postgres" || lease.state !== "active") {
    return true;
  }
  const manifestRootPath = join(home, "runtime-manifests");
  const manifestPath = join(manifestRootPath, `${lease.id}.json`);
  let temporaryPath = "";
  try {
    const manifestRoot = realpathSync.native(manifestRootPath);
    const manifestStat = lstatSync(manifestPath);
    const canonicalManifest = realpathSync.native(manifestPath);
    if (
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      (manifestStat.mode & 0o077) !== 0 ||
      canonicalManifest !== join(manifestRoot, `${lease.id}.json`) ||
      relative(manifestRoot, canonicalManifest) !== `${lease.id}.json`
    ) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(canonicalManifest, "utf8")) as Record<string, unknown>;
    const currentFence = parsed["fence"];
    if (
      parsed["version"] !== 1 ||
      parsed["leaseId"] !== lease.id ||
      parsed["bundleKind"] !== "worktree_postgres" ||
      parsed["host"] !== "127.0.0.1" ||
      !Number.isSafeInteger(currentFence) ||
      (currentFence as number) > lease.fence
    ) {
      return false;
    }
    if (currentFence === lease.fence) {
      return true;
    }
    parsed["fence"] = lease.fence;
    temporaryPath = `${manifestPath}.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, manifestPath);
    return true;
  } catch {
    if (temporaryPath !== "" && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // exact temporary fileだけを対象にし、回収不能なら次tick/doctorへ残す。
      }
    }
    return false;
  }
}
