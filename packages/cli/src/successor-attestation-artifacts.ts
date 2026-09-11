// =============================================================================
// Codex successor attestation の review 済み静的 hook と host publication resolver。
// publication manifest 以外から CODEX_HOME / hooks / PATH helper を推測せず、arm・attest・
// doctor が同じ exact canonical path/hash 判定を共有する。
// =============================================================================

import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  SuccessorAttestationArtifactHashes,
  SuccessorAttestationHashProbe,
} from "./deps.js";
import { parseStrictJson } from "./strict-json.js";

export const CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH =
  "state/codex-successor-attestation-manifest.json";
export const CODEX_SUCCESSOR_HOOK_COMMAND = "hachi orchestrator successor-launch attest";
export const CODEX_SUCCESSOR_HOOK_MATCHER = "startup|resume|clear|compact";
export const CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS = 10;
export const CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT = 1_024;
export const CODEX_SUCCESSOR_MANIFEST_SCHEMA = "codex-successor-attestation-publication.v1";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MANIFEST_MAX_BYTES = 16_384;
const HOOKS_MAX_BYTES = 1_048_576;
const HELPER_MAX_BYTES = 4_194_304;
const AUTHORITY_JSON_MAX_DEPTH = 64;

interface StaticCommandHook {
  type: "command";
  command: typeof CODEX_SUCCESSOR_HOOK_COMMAND;
  timeout: typeof CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS;
  additionalContextLimit: typeof CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT;
}

export interface StaticSessionStartGroup {
  matcher: typeof CODEX_SUCCESSOR_HOOK_MATCHER;
  hooks: readonly [StaticCommandHook];
}

/** async field を持たない command hook は公式契約上同期実行される。 */
export const CODEX_SUCCESSOR_SESSION_START_GROUP: StaticSessionStartGroup = Object.freeze({
  matcher: CODEX_SUCCESSOR_HOOK_MATCHER,
  hooks: Object.freeze([Object.freeze({
    type: "command" as const,
    command: CODEX_SUCCESSOR_HOOK_COMMAND,
    timeout: CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS,
    additionalContextLimit: CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT,
  })]) as readonly [StaticCommandHook],
});

export interface CodexSuccessorAttestationManifest {
  schemaVersion: typeof CODEX_SUCCESSOR_MANIFEST_SCHEMA;
  codexHome: string;
  installedHooksPath: string;
  helperExecutablePath: string;
  expectedHookDefinitionHash: string;
  expectedHelperExecutableHash: string;
}

export interface SuccessorAttestationArtifactResolution
  extends SuccessorAttestationArtifactHashes {
  codexHome: string;
  installedHooksPath: string;
  helperExecutablePath: string;
}

export interface SuccessorAttestationArtifactResolver extends SuccessorAttestationHashProbe {
  resolveInstalledArtifacts(): SuccessorAttestationArtifactResolution;
}

export type SuccessorAttestationArtifactErrorCode =
  | "manifest_missing"
  | "manifest_unsafe"
  | "manifest_schema"
  | "codex_home_mismatch"
  | "hooks_path_mismatch"
  | "helper_path_mismatch"
  | "hook_definition_missing"
  | "hook_definition_duplicate"
  | "hook_definition_drift"
  | "hook_hash_mismatch"
  | "helper_hash_mismatch"
  | "artifact_unsafe"
  | "artifact_unstable";

/** path/hash を通常出力へ載せない、分類済みの安全な resolver error。 */
export class SuccessorAttestationArtifactError extends Error {
  readonly code: SuccessorAttestationArtifactErrorCode;

  constructor(code: SuccessorAttestationArtifactErrorCode, message: string) {
    super(message);
    this.name = "SuccessorAttestationArtifactError";
    this.code = code;
  }
}

export interface SuccessorAttestationArtifactFileSystem {
  lstat(path: string): BigIntStats;
  realpath(path: string): string;
  openNoFollow(path: string): number;
  readFile(fd: number): Buffer;
  fstat(fd: number): BigIntStats;
  close(fd: number): void;
  canExecute(path: string): boolean;
}

const defaultFileSystem: SuccessorAttestationArtifactFileSystem = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  realpath: (path) => realpathSync.native(path),
  openNoFollow: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  readFile: (fd) => readFileSync(fd),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  close: (fd) => closeSync(fd),
  canExecute(path): boolean {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export interface CreateSuccessorAttestationArtifactResolverOptions {
  hachiStateHome: string;
  processEnv: Readonly<NodeJS.ProcessEnv>;
  osHome: string;
  fileSystem?: SuccessorAttestationArtifactFileSystem;
}

interface StableFilePolicy {
  label: "manifest" | "hooks" | "helper";
  minBytes: number;
  maxBytes: number;
  validateMode(mode: number): boolean;
}

interface StableFile {
  bytes: Buffer;
  canonicalPath: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON に非有限numberは使えません");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON に未対応の値があります");
}

export function canonicalizeCodexSuccessorHookGroup(group: unknown): Buffer {
  return Buffer.from(canonicalJson(group), "utf8");
}

export function expectedCodexSuccessorHookDefinitionHash(): string {
  return sha256(canonicalizeCodexSuccessorHookGroup(CODEX_SUCCESSOR_SESSION_START_GROUP));
}

export function renderCodexSuccessorHookTemplate(): string {
  return `${JSON.stringify({ hooks: { SessionStart: [CODEX_SUCCESSOR_SESSION_START_GROUP] } }, null, 2)}\n`;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function readStableRegularFile(
  fs: SuccessorAttestationArtifactFileSystem,
  path: string,
  policy: StableFilePolicy,
): StableFile {
  let before: BigIntStats;
  let canonicalBefore: string;
  try {
    before = fs.lstat(path);
    canonicalBefore = fs.realpath(path);
  } catch (err) {
    if (policy.label === "manifest" && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SuccessorAttestationArtifactError(
        "manifest_missing",
        "Codex successor attestation publication manifest は未配備です",
      );
    }
    throw new SuccessorAttestationArtifactError(
      policy.label === "manifest" ? "manifest_unsafe" : "artifact_unsafe",
      `${policy.label} artifact を安全に読み取れません`,
    );
  }
  const mode = Number(before.mode & 0o7777n);
  if (!isAbsolute(path) || normalize(path) !== path || canonicalBefore !== path ||
      before.isSymbolicLink() || !before.isFile() ||
      before.size < BigInt(policy.minBytes) || before.size > BigInt(policy.maxBytes) ||
      !policy.validateMode(mode)) {
    throw new SuccessorAttestationArtifactError(
      policy.label === "manifest" ? "manifest_unsafe" : "artifact_unsafe",
      `${policy.label} artifact のpath/type/size/modeが安全条件に一致しません`,
    );
  }

  let fd: number | null = null;
  try {
    fd = fs.openNoFollow(path);
    const opened = fs.fstat(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new SuccessorAttestationArtifactError(
        "artifact_unstable",
        `${policy.label} artifact のidentityがread前に変化しました`,
      );
    }
    const bytes = fs.readFile(fd);
    const afterRead = fs.fstat(fd);
    const afterPath = fs.lstat(path);
    const canonicalAfter = fs.realpath(path);
    if (BigInt(bytes.byteLength) !== opened.size ||
        !sameIdentity(opened, afterRead) ||
        !sameIdentity(opened, afterPath) ||
        canonicalAfter !== canonicalBefore) {
      throw new SuccessorAttestationArtifactError(
        "artifact_unstable",
        `${policy.label} artifact のidentityがread中に変化しました`,
      );
    }
    return { bytes, canonicalPath: canonicalBefore };
  } catch (err) {
    if (err instanceof SuccessorAttestationArtifactError) throw err;
    throw new SuccessorAttestationArtifactError(
      "artifact_unstable",
      `${policy.label} artifact のatomic readに失敗しました`,
    );
  } finally {
    if (fd !== null) {
      try {
        fs.close(fd);
      } catch {
        throw new SuccessorAttestationArtifactError(
          "artifact_unstable",
          `${policy.label} artifact のclose確認に失敗しました`,
        );
      }
    }
  }
}

function parseManifest(bytes: Buffer): CodexSuccessorAttestationManifest {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes.toString("utf8"), {
      maxBytes: MANIFEST_MAX_BYTES,
      maxDepth: AUTHORITY_JSON_MAX_DEPTH,
      maxTokens: MANIFEST_MAX_BYTES,
    });
  } catch {
    throw new SuccessorAttestationArtifactError("manifest_schema", "publication manifest のJSONが不正です");
  }
  const keys = [
    "schemaVersion",
    "codexHome",
    "installedHooksPath",
    "helperExecutablePath",
    "expectedHookDefinitionHash",
    "expectedHelperExecutableHash",
  ].sort();
  if (!isRecord(parsed) || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(keys) ||
      parsed["schemaVersion"] !== CODEX_SUCCESSOR_MANIFEST_SCHEMA ||
      typeof parsed["codexHome"] !== "string" ||
      typeof parsed["installedHooksPath"] !== "string" ||
      typeof parsed["helperExecutablePath"] !== "string" ||
      typeof parsed["expectedHookDefinitionHash"] !== "string" ||
      typeof parsed["expectedHelperExecutableHash"] !== "string" ||
      !SHA256_HEX.test(parsed["expectedHookDefinitionHash"]) ||
      !SHA256_HEX.test(parsed["expectedHelperExecutableHash"])) {
    throw new SuccessorAttestationArtifactError("manifest_schema", "publication manifest のschemaが不正です");
  }
  return {
    schemaVersion: CODEX_SUCCESSOR_MANIFEST_SCHEMA,
    codexHome: parsed["codexHome"],
    installedHooksPath: parsed["installedHooksPath"],
    helperExecutablePath: parsed["helperExecutablePath"],
    expectedHookDefinitionHash: parsed["expectedHookDefinitionHash"],
    expectedHelperExecutableHash: parsed["expectedHelperExecutableHash"],
  };
}

function requireCanonicalDirectory(
  fs: SuccessorAttestationArtifactFileSystem,
  path: string,
  code: "manifest_unsafe" | "codex_home_mismatch" | "helper_path_mismatch",
  label: string,
  missingCode?: "manifest_missing",
): string {
  // resolve/normalize の結果を検証先として使う前に、raw spelling 自体を固定する。
  // symlink/.. のOS解決先とlexical解決先が分かれる入力もここで閉じる。
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    throw new SuccessorAttestationArtifactError(code, `${label} はcanonical absolute pathが必須です`);
  }
  try {
    const stat = fs.lstat(path);
    const canonical = fs.realpath(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) {
      throw new Error("unsafe directory");
    }
    return canonical;
  } catch (err) {
    if (missingCode !== undefined && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SuccessorAttestationArtifactError(
        missingCode,
        "Codex successor attestation publication manifest は未配備です",
      );
    }
    throw new SuccessorAttestationArtifactError(
      code,
      `${label} をcanonical directoryとして確認できません`,
    );
  }
}

function resolveActiveCodexHome(
  fs: SuccessorAttestationArtifactFileSystem,
  processEnv: Readonly<NodeJS.ProcessEnv>,
  osHome: string,
): string {
  const configured = processEnv.CODEX_HOME;
  const active = configured === undefined || configured === ""
    ? join(requireCanonicalDirectory(fs, osHome, "codex_home_mismatch", "OS home"), ".codex")
    : configured;
  return requireCanonicalDirectory(fs, active, "codex_home_mismatch", "active CODEX_HOME");
}

function resolvePathHelper(
  fs: SuccessorAttestationArtifactFileSystem,
  processEnv: Readonly<NodeJS.ProcessEnv>,
): string {
  const pathValue = processEnv.PATH;
  if (pathValue === undefined || pathValue === "") {
    throw new SuccessorAttestationArtifactError("helper_path_mismatch", "PATH 上の hachi helper を確認できません");
  }
  for (const entry of pathValue.split(delimiter)) {
    const canonicalEntry = requireCanonicalDirectory(
      fs,
      entry,
      "helper_path_mismatch",
      "PATH entry",
    );
    const candidate = join(canonicalEntry, "hachi");
    let stat: BigIntStats;
    try {
      stat = fs.lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SuccessorAttestationArtifactError("helper_path_mismatch", "PATH helper のlookupに失敗しました");
    }
    if (stat.isSymbolicLink()) {
      throw new SuccessorAttestationArtifactError("artifact_unsafe", "PATH helper にsymlinkは使用できません");
    }
    if (!stat.isFile() || !fs.canExecute(candidate)) continue;
    const normalized = normalize(candidate);
    if (fs.realpath(candidate) !== normalized) {
      throw new SuccessorAttestationArtifactError("artifact_unsafe", "PATH helper はcanonical pathが必須です");
    }
    return normalized;
  }
  throw new SuccessorAttestationArtifactError("helper_path_mismatch", "PATH 上の hachi helper を確認できません");
}

function isHachiGroupCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hooks = value["hooks"];
  return Array.isArray(hooks) && hooks.some((hook) => {
    if (!isRecord(hook) || typeof hook["command"] !== "string") return false;
    return hook["command"] === CODEX_SUCCESSOR_HOOK_COMMAND ||
      (hook["command"].includes("successor-launch") && hook["command"].includes("attest"));
  });
}

function extractInstalledHookDefinition(bytes: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes.toString("utf8"), {
      maxBytes: HOOKS_MAX_BYTES,
      maxDepth: AUTHORITY_JSON_MAX_DEPTH,
      maxTokens: HOOKS_MAX_BYTES,
    });
  } catch {
    throw new SuccessorAttestationArtifactError("hook_definition_drift", "installed hooks.json のJSONが不正です");
  }
  const hooks = isRecord(parsed) ? parsed["hooks"] : undefined;
  const groups = isRecord(hooks) ? hooks["SessionStart"] : undefined;
  if (!Array.isArray(groups)) {
    throw new SuccessorAttestationArtifactError(
      "hook_definition_missing",
      "exact Hachi SessionStart group が見つかりません",
    );
  }
  const candidates = groups.filter((group) => isHachiGroupCandidate(group));
  if (candidates.length === 0) {
    throw new SuccessorAttestationArtifactError(
      "hook_definition_missing",
      "exact Hachi SessionStart group が見つかりません",
    );
  }
  if (candidates.length !== 1) {
    throw new SuccessorAttestationArtifactError(
      "hook_definition_duplicate",
      "Hachi SessionStart group が重複しています",
    );
  }
  const canonical = canonicalizeCodexSuccessorHookGroup(candidates[0]);
  const expected = canonicalizeCodexSuccessorHookGroup(CODEX_SUCCESSOR_SESSION_START_GROUP);
  if (!canonical.equals(expected)) {
    throw new SuccessorAttestationArtifactError(
      "hook_definition_drift",
      "Hachi SessionStart group にfieldまたは意味差分があります",
    );
  }
  return canonical;
}

export function createSuccessorAttestationArtifactResolver(
  options: CreateSuccessorAttestationArtifactResolverOptions,
): SuccessorAttestationArtifactResolver {
  const fs = options.fileSystem ?? defaultFileSystem;

  const resolveInstalledArtifacts = (): SuccessorAttestationArtifactResolution => {
    const hachiStateHome = requireCanonicalDirectory(
      fs,
      options.hachiStateHome,
      "manifest_unsafe",
      "HACHI_KANBAN_HOME",
      "manifest_missing",
    );
    const manifestPath = join(hachiStateHome, CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH);
    const manifestFile = readStableRegularFile(fs, manifestPath, {
      label: "manifest",
      minBytes: 2,
      maxBytes: MANIFEST_MAX_BYTES,
      validateMode: (mode) => mode === 0o600,
    });
    const manifest = parseManifest(manifestFile.bytes);
    const codexHome = resolveActiveCodexHome(fs, options.processEnv, options.osHome);
    if (manifest.codexHome !== codexHome) {
      throw new SuccessorAttestationArtifactError("codex_home_mismatch", "manifest と active CODEX_HOME が一致しません");
    }

    const expectedHooksPath = join(codexHome, "hooks.json");
    if (manifest.installedHooksPath !== expectedHooksPath || !isAbsolute(manifest.installedHooksPath)) {
      throw new SuccessorAttestationArtifactError("hooks_path_mismatch", "manifest の installed hooks path が一致しません");
    }
    const pathHelper = resolvePathHelper(fs, options.processEnv);
    if (manifest.helperExecutablePath !== pathHelper || !isAbsolute(manifest.helperExecutablePath)) {
      throw new SuccessorAttestationArtifactError("helper_path_mismatch", "manifest と PATH helper entrypoint が一致しません");
    }

    const hooksFile = readStableRegularFile(fs, manifest.installedHooksPath, {
      label: "hooks",
      minBytes: 2,
      maxBytes: HOOKS_MAX_BYTES,
      validateMode: (mode) => (mode & 0o7133) === 0 && (mode & 0o400) !== 0,
    });
    const helperFile = readStableRegularFile(fs, manifest.helperExecutablePath, {
      label: "helper",
      minBytes: 1,
      maxBytes: HELPER_MAX_BYTES,
      validateMode: (mode) => (mode & 0o7122) === 0o100 && (mode & 0o400) !== 0,
    });
    if (hooksFile.canonicalPath !== manifest.installedHooksPath ||
        helperFile.canonicalPath !== manifest.helperExecutablePath) {
      throw new SuccessorAttestationArtifactError("artifact_unsafe", "artifact のcanonical pathが一致しません");
    }

    const hookDefinitionBytes = extractInstalledHookDefinition(hooksFile.bytes);
    const hookDefinitionHash = sha256(hookDefinitionBytes);
    const hookExecutableHash = sha256(helperFile.bytes);
    if (manifest.expectedHookDefinitionHash !== expectedCodexSuccessorHookDefinitionHash() ||
        manifest.expectedHookDefinitionHash !== hookDefinitionHash) {
      throw new SuccessorAttestationArtifactError("hook_hash_mismatch", "review済み hook definition hash が一致しません");
    }
    if (manifest.expectedHelperExecutableHash !== hookExecutableHash) {
      throw new SuccessorAttestationArtifactError("helper_hash_mismatch", "review済み helper executable hash が一致しません");
    }
    return {
      codexHome,
      installedHooksPath: manifest.installedHooksPath,
      helperExecutablePath: manifest.helperExecutablePath,
      hookDefinitionHash,
      hookExecutableHash,
    };
  };

  return {
    resolveInstalledArtifacts,
    readInstalledHashes(): SuccessorAttestationArtifactHashes {
      const resolution = resolveInstalledArtifacts();
      return {
        hookDefinitionHash: resolution.hookDefinitionHash,
        hookExecutableHash: resolution.hookExecutableHash,
      };
    },
  };
}
