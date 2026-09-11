// HERMES_HOME のhost authority解決（docs/contract.md §75.7）。
// main.ts だけが起動時envを渡し、reader/stageはprocess.envを再読込しない。
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, normalize, parse, sep } from "node:path";

export type ExternalRuntimeGenerationRootFailureCode =
  | "empty"
  | "relative"
  | "noncanonical"
  | "control"
  | "missing"
  | "symlink"
  | "not_directory"
  | "owner_mismatch"
  | "mode_mismatch"
  | "permission_denied"
  | "filesystem_error";

export interface ExternalRuntimeGenerationDirectorySnapshot {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

export type ExternalRuntimeGenerationRootResolution =
  | {
      ok: true;
      root: string;
      source: "environment" | "default";
      uid: number;
      dev: number;
      ino: number;
      ancestry: readonly ExternalRuntimeGenerationDirectorySnapshot[];
    }
  | { ok: false; code: ExternalRuntimeGenerationRootFailureCode; source: "environment" | "default"; uid: number };

export interface ExternalRuntimeGenerationRootFs {
  lstat(path: string): Stats;
  realpath(path: string): string;
}

export interface ResolveExternalRuntimeGenerationRootOptions {
  env: NodeJS.ProcessEnv;
  accountHome: string;
  uid?: number;
  fs?: ExternalRuntimeGenerationRootFs;
}

const nodeRootFs: ExternalRuntimeGenerationRootFs = {
  lstat: (path: string): Stats => lstatSync(path),
  realpath: (path: string): string => realpathSync.native(path),
};

function failureCode(error: unknown): ExternalRuntimeGenerationRootFailureCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ELOOP") return "symlink";
  return "filesystem_error";
}

function lexicalFailure(value: string): ExternalRuntimeGenerationRootFailureCode | null {
  if (value === "") return "empty";
  if (!isAbsolute(value)) return "relative";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "control";
  if (value !== parse(value).root && value.endsWith(sep)) return "noncanonical";
  if (value.includes(`${sep}${sep}`)) return "noncanonical";
  const components = value.slice(parse(value).root.length).split(sep);
  if (components.some((component) => component === "." || component === ".." || component === "")) {
    return "noncanonical";
  }
  if (normalize(value) !== value) return "noncanonical";
  return null;
}

function pathAncestry(value: string): string[] {
  const root = parse(value).root;
  const components = value.slice(root.length).split(sep).filter((component) => component !== "");
  const ancestry = [root];
  let current = root;
  for (const component of components) {
    current = join(current, component);
    ancestry.push(current);
  }
  return ancestry;
}

/** host launch env/defaultを固定し、canonical filesystem rootだけをDIへ渡す。 */
export function resolveExternalRuntimeGenerationRoot(
  options: ResolveExternalRuntimeGenerationRootOptions,
): ExternalRuntimeGenerationRootResolution {
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const source = Object.hasOwn(options.env, "HERMES_HOME") ? "environment" as const : "default" as const;
  const configured = source === "environment"
    ? options.env["HERMES_HOME"]
    : join(options.accountHome, ".hermes-hachi-dev");
  if (typeof configured !== "string") return { ok: false, code: "empty", source, uid };
  const lexical = lexicalFailure(configured);
  if (lexical !== null) return { ok: false, code: lexical, source, uid };

  const fs = options.fs ?? nodeRootFs;
  let canonical: string;
  try {
    canonical = fs.realpath(configured);
  } catch (error) {
    return { ok: false, code: failureCode(error), source, uid };
  }
  if (canonical !== configured) return { ok: false, code: "noncanonical", source, uid };

  const ancestry = pathAncestry(configured);
  const initialStats: Stats[] = [];
  for (let index = 0; index < ancestry.length; index += 1) {
    let stat: Stats;
    try {
      stat = fs.lstat(ancestry[index]!);
    } catch (error) {
      return { ok: false, code: failureCode(error), source, uid };
    }
    if (stat.isSymbolicLink()) return { ok: false, code: "symlink", source, uid };
    if (!stat.isDirectory()) return { ok: false, code: "not_directory", source, uid };
    const isHermesRoot = index === ancestry.length - 1;
    if (isHermesRoot ? stat.uid !== uid : stat.uid !== 0 && stat.uid !== uid) {
      return { ok: false, code: "owner_mismatch", source, uid };
    }
    if ((stat.mode & 0o022) !== 0) return { ok: false, code: "mode_mismatch", source, uid };
    initialStats.push(stat);
  }
  try {
    const snapshots: ExternalRuntimeGenerationDirectorySnapshot[] = [];
    for (let index = 0; index < ancestry.length; index += 1) {
      const path = ancestry[index]!;
      const initial = initialStats[index]!;
      const finalCanonical = fs.realpath(path);
      const finalStat = fs.lstat(path);
      const isHermesRoot = index === ancestry.length - 1;
      if (
        finalCanonical !== path || finalStat.isSymbolicLink() || !finalStat.isDirectory() ||
        (isHermesRoot ? finalStat.uid !== uid : finalStat.uid !== 0 && finalStat.uid !== uid) ||
        (finalStat.mode & 0o022) !== 0 || finalStat.dev !== initial.dev || finalStat.ino !== initial.ino
      ) {
        return { ok: false, code: "filesystem_error", source, uid };
      }
      snapshots.push({
        path,
        dev: finalStat.dev,
        ino: finalStat.ino,
        uid: finalStat.uid,
        mode: finalStat.mode,
      });
    }
    const finalStat = initialStats.at(-1)!;
    return {
      ok: true,
      root: configured,
      source,
      uid,
      dev: finalStat.dev,
      ino: finalStat.ino,
      ancestry: snapshots,
    };
  } catch (error) {
    return { ok: false, code: failureCode(error), source, uid };
  }
}
