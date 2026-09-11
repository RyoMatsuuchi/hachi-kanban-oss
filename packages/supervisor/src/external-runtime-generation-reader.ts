// External runtime generation status のbounded read-only reader（docs/contract.md §75.11）。
import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import {
  EXTERNAL_RUNTIME_GENERATION_LANES,
  EXTERNAL_RUNTIME_GENERATION_MAX_FUTURE_MS,
  canonicalJson,
  externalRuntimeGenerationAttestationIsFresh,
  externalRuntimeGenerationEndpointIdentityHash,
  externalRuntimeGenerationStatusIsFresh,
  parseExternalRuntimeGenerationStatus,
  validateExternalRuntimeGenerationAttestation,
  type ExternalRuntimeGenerationAttestationV1,
  type ExternalRuntimeGenerationIdentityV1,
  type Provider,
  type ValidatedExternalRuntimeGenerationStatus,
} from "@hachi/core";
import type {
  ExternalRuntimeGenerationDirectorySnapshot,
  ExternalRuntimeGenerationRootResolution,
} from "./external-runtime-generation-root.js";

const MAX_STATUS_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const OPENED_PATH_READ_TIMEOUT_MS = 2_000;

export type ExternalRuntimeGenerationReadCode =
  | "root_invalid"
  | "missing"
  | "permission_denied"
  | "path_invalid"
  | "file_invalid"
  | "size_invalid"
  | "read_failed"
  | "utf8_invalid"
  | "payload_invalid"
  | "time_invalid"
  | "status_stale"
  | "attestation_invalid"
  | "attestation_missing"
  | "attestation_stale"
  | "endpoint_mismatch"
  | "process_mismatch";

export type ExternalRuntimeGenerationReadResult =
  | {
      state: "valid";
      sample: ValidatedExternalRuntimeGenerationStatus;
      launchAttestation?: ExternalRuntimeGenerationAttestationV1;
    }
  | { state: "unknown"; code: ExternalRuntimeGenerationReadCode };

export interface ExternalRuntimeGenerationReader {
  read(
    provider: Provider,
    nowMs: number,
    responseAttestation?: unknown,
  ): Promise<ExternalRuntimeGenerationReadResult>;
}

export interface ExternalRuntimeGenerationProcessIdentityReader {
  read(pid: number): Promise<string | null>;
}

export interface ExternalRuntimeGenerationOpenedPathReader {
  read(fds: readonly number[]): Promise<ReadonlyMap<number, string> | null>;
}

export interface ExternalRuntimeGenerationReaderOptions {
  root: ExternalRuntimeGenerationRootResolution;
  endpoints: Readonly<Record<Provider, string>>;
  processIdentityReader?: ExternalRuntimeGenerationProcessIdentityReader;
  openedPathReader?: ExternalRuntimeGenerationOpenedPathReader;
}

export class NodeExternalRuntimeGenerationProcessIdentityReader
implements ExternalRuntimeGenerationProcessIdentityReader {
  async read(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const output = await new Promise<string | null>((resolve) => {
      execFile(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 4_096,
          env: { LC_ALL: "C", LANG: "C" },
        },
        (error, stdout) => resolve(error === null ? stdout : null),
      );
    });
    if (output === null) return null;
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length !== 1 || /[\u0000-\u001f\u007f]/.test(lines[0]!)) return null;
    return `darwin-ps-lstart:${lines[0]!}`;
  }
}

/** kernelがopened fdへ保持するpathを読み、途中component差替えをfail-closedにする（Darwin: lsof / Linux: /proc/self/fd）。 */
export class NodeExternalRuntimeGenerationOpenedPathReader
implements ExternalRuntimeGenerationOpenedPathReader {
  async read(fds: readonly number[]): Promise<ReadonlyMap<number, string> | null> {
    const uniqueFds = [...new Set(fds)];
    if (
      uniqueFds.length === 0 || uniqueFds.length !== fds.length ||
      uniqueFds.some((fd) => !Number.isSafeInteger(fd) || fd < 0)
    ) return null;
    if (process.platform === "darwin") return this.readDarwin(uniqueFds);
    if (process.platform === "linux") return this.readLinux(uniqueFds);
    return null;
  }

  private async readDarwin(uniqueFds: number[]): Promise<ReadonlyMap<number, string> | null> {
    const output = await new Promise<string | null>((resolve) => {
      execFile(
        "/usr/sbin/lsof",
        ["-a", "-p", String(process.pid), "-d", uniqueFds.join(","), "-Fn"],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 8_192,
          env: { LC_ALL: "C", LANG: "C" },
        },
        (error, stdout) => resolve(error === null ? stdout : null),
      );
    });
    if (output === null) return null;
    const lines = output.split(/\r?\n/).filter((line) => line !== "");
    if (!lines.includes(`p${process.pid}`)) return null;
    const requested = new Set(uniqueFds);
    const paths = new Map<number, string>();
    let currentFd: number | null = null;
    for (const line of lines) {
      if (line.startsWith("f")) {
        const rawFd = line.slice(1);
        const fd = Number(rawFd);
        currentFd = Number.isSafeInteger(fd) && String(fd) === rawFd && requested.has(fd) ? fd : null;
      } else if (line.startsWith("n") && currentFd !== null) {
        const path = line.slice(1);
        if (path === "" || /[\u0000-\u001f\u007f]/.test(path) || paths.has(currentFd)) return null;
        paths.set(currentFd, path);
      }
    }
    return paths.size === uniqueFds.length ? paths : null;
  }

  /**
   * 全fdのreadlinkに開始直後拒否handlerを付けて単一2秒deadlineへPromise.raceする。期限時はnullとして扱い、
   * late settle（期限後のreject/resolve）は破棄してunhandled rejectionも結果の復活も起こさない。
   */
  private async readLinux(uniqueFds: number[]): Promise<ReadonlyMap<number, string> | null> {
    const timeoutMarker = Symbol("external-runtime-generation-opened-path-timeout");
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMarker), OPENED_PATH_READ_TIMEOUT_MS);
    });
    try {
      const settled = await Promise.all(uniqueFds.map(async (fd) => {
        const safeReadlink = readlink(`/proc/self/fd/${fd}`, "utf8").then(
          (value): string | null => value,
          (): string | null => null,
        );
        const raced = await Promise.race([safeReadlink, deadline]);
        if (raced === timeoutMarker || raced === null) return null;
        if (raced === "" || /[\u0000-\u001f\u007f]/.test(raced) || !raced.startsWith("/")) return null;
        return raced;
      }));
      const paths = new Map<number, string>();
      for (const [index, fd] of uniqueFds.entries()) {
        const value = settled[index]!;
        if (value === null) return null;
        paths.set(fd, value);
      }
      return paths;
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorCode(error: unknown): ExternalRuntimeGenerationReadCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ELOOP") return "path_invalid";
  return "read_failed";
}

function exactMode(stat: Stats, expected: number): boolean {
  return (stat.mode & 0o777) === expected;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwnerAndMode(left: Stats, right: Stats): boolean {
  return left.uid === right.uid && left.mode === right.mode;
}

function validAncestryDirectory(stat: Stats, uid: number, isHermesRoot: boolean): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (isHermesRoot ? stat.uid === uid : stat.uid === 0 || stat.uid === uid) &&
    (stat.mode & 0o022) === 0;
}

function validLaneDirectory(stat: Stats, uid: number): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && exactMode(stat, 0o700);
}

function validStatusFile(stat: Stats, uid: number): ExternalRuntimeGenerationReadCode | null {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || !exactMode(stat, 0o600) || stat.nlink !== 1) {
    return "file_invalid";
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_STATUS_BYTES) return "size_invalid";
  return null;
}

async function readBounded(handle: FileHandle, initial: Stats): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_STATUS_BYTES) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_STATUS_BYTES + 1 - total));
    const result = await handle.read(buffer, 0, buffer.length, null);
    if (result.bytesRead === 0) break;
    chunks.push(buffer.subarray(0, result.bytesRead));
    total += result.bytesRead;
  }
  if (total > MAX_STATUS_BYTES) return null;
  const final = await handle.stat();
  if (
    !sameFile(initial, final) || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs ||
    initial.ctimeMs !== final.ctimeMs || total !== final.size
  ) return null;
  return Buffer.concat(chunks, total);
}

function allTimesBounded(sample: ValidatedExternalRuntimeGenerationStatus, nowMs: number): boolean {
  const limit = nowMs + EXTERNAL_RUNTIME_GENERATION_MAX_FUTURE_MS;
  return sample.status.observedAt <= limit &&
    sample.status.attestations.every((attestation) => attestation.observedAt <= limit) &&
    sample.status.transitions.every((transition) => transition.observedAt <= limit);
}

function identityMatches(left: ExternalRuntimeGenerationIdentityV1, right: ExternalRuntimeGenerationIdentityV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class NodeExternalRuntimeGenerationReader implements ExternalRuntimeGenerationReader {
  private readonly processIdentityReader: ExternalRuntimeGenerationProcessIdentityReader;
  private readonly openedPathReader: ExternalRuntimeGenerationOpenedPathReader;

  constructor(private readonly options: ExternalRuntimeGenerationReaderOptions) {
    this.processIdentityReader = options.processIdentityReader ?? new NodeExternalRuntimeGenerationProcessIdentityReader();
    this.openedPathReader = options.openedPathReader ?? new NodeExternalRuntimeGenerationOpenedPathReader();
  }

  async read(
    provider: Provider,
    nowMs: number,
    responseAttestation?: unknown,
  ): Promise<ExternalRuntimeGenerationReadResult> {
    if (!this.options.root.ok || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      return { state: "unknown", code: "root_invalid" };
    }
    const injectedRootSnapshot = this.options.root.ancestry.at(-1);
    if (
      injectedRootSnapshot === undefined || injectedRootSnapshot.path !== this.options.root.root ||
      injectedRootSnapshot.dev !== this.options.root.dev || injectedRootSnapshot.ino !== this.options.root.ino ||
      injectedRootSnapshot.uid !== this.options.root.uid
    ) return { state: "unknown", code: "root_invalid" };
    const spec = EXTERNAL_RUNTIME_GENERATION_LANES[provider];
    const statusPath = join(this.options.root.root, spec.relativeStatusPath);
    const laneDirectory = dirname(statusPath);
    const directoryFences: Array<{
      path: string;
      handle: FileHandle;
      stat: Stats;
      snapshot: ExternalRuntimeGenerationDirectorySnapshot | null;
      kind: "ancestry" | "root" | "lane";
    }> = [];
    let statusHandle: FileHandle | null = null;
    let bytes: Buffer;
    try {
      // 起動時に固定したOS ancestryをreadごとにdirectory fdで再openし、sample完了まで保持する。
      for (let index = 0; index < this.options.root.ancestry.length; index += 1) {
        const snapshot = this.options.root.ancestry[index]!;
        const kind = index === this.options.root.ancestry.length - 1 ? "root" as const : "ancestry" as const;
        const [initialRealpath, initialStat] = await Promise.all([realpath(snapshot.path), lstat(snapshot.path)]);
        if (
          initialRealpath !== snapshot.path ||
          !validAncestryDirectory(initialStat, this.options.root.uid, kind === "root") ||
          initialStat.dev !== snapshot.dev || initialStat.ino !== snapshot.ino ||
          initialStat.uid !== snapshot.uid || initialStat.mode !== snapshot.mode
        ) return { state: "unknown", code: "path_invalid" };
        const directoryHandle = await open(
          snapshot.path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const openedStat = await directoryHandle.stat();
        if (
          !validAncestryDirectory(openedStat, this.options.root.uid, kind === "root") ||
          !sameFile(initialStat, openedStat) || !sameOwnerAndMode(initialStat, openedStat)
        ) {
          await directoryHandle.close().catch((): void => undefined);
          return { state: "unknown", code: "path_invalid" };
        }
        directoryFences.push({ path: snapshot.path, handle: directoryHandle, stat: openedStat, snapshot, kind });
      }

      const [initialLaneRealpath, initialLaneStat] = await Promise.all([
        realpath(laneDirectory),
        lstat(laneDirectory),
      ]);
      if (initialLaneRealpath !== laneDirectory || !validLaneDirectory(initialLaneStat, this.options.root.uid)) {
        return { state: "unknown", code: "path_invalid" };
      }
      const laneHandle = await open(
        laneDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const openedLaneStat = await laneHandle.stat();
      if (
        !validLaneDirectory(openedLaneStat, this.options.root.uid) ||
        !sameFile(initialLaneStat, openedLaneStat) || !sameOwnerAndMode(initialLaneStat, openedLaneStat)
      ) {
        await laneHandle.close().catch((): void => undefined);
        return { state: "unknown", code: "path_invalid" };
      }
      directoryFences.push({
        path: laneDirectory,
        handle: laneHandle,
        stat: openedLaneStat,
        snapshot: null,
        kind: "lane",
      });

      const [initialStatusRealpath, initialPathStat] = await Promise.all([
        realpath(statusPath),
        lstat(statusPath),
      ]);
      if (initialStatusRealpath !== statusPath) return { state: "unknown", code: "path_invalid" };
      const pathValidation = validStatusFile(initialPathStat, this.options.root.uid);
      if (pathValidation !== null) return { state: "unknown", code: pathValidation };

      statusHandle = await open(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedStat = await statusHandle.stat();
      const openValidation = validStatusFile(openedStat, this.options.root.uid);
      if (openValidation !== null || !sameFile(initialPathStat, openedStat)) {
        return { state: "unknown", code: openValidation ?? "path_invalid" };
      }
      const openedFds = [...directoryFences.map((fence) => fence.handle.fd), statusHandle.fd];
      const initialOpenedPaths = await this.openedPathReader.read(openedFds);
      if (
        initialOpenedPaths === null ||
        directoryFences.some((fence) => initialOpenedPaths.get(fence.handle.fd) !== fence.path) ||
        initialOpenedPaths.get(statusHandle.fd) !== statusPath
      ) return { state: "unknown", code: "path_invalid" };
      const read = await readBounded(statusHandle, openedStat);
      if (read === null) return { state: "unknown", code: "read_failed" };

      const finalOpenedPaths = await this.openedPathReader.read(openedFds);
      if (
        finalOpenedPaths === null ||
        directoryFences.some((fence) => finalOpenedPaths.get(fence.handle.fd) !== fence.path) ||
        finalOpenedPaths.get(statusHandle.fd) !== statusPath
      ) return { state: "unknown", code: "path_invalid" };

      for (const fence of directoryFences) {
        const [finalRealpath, finalPathStat, finalHandleStat] = await Promise.all([
          realpath(fence.path),
          lstat(fence.path),
          fence.handle.stat(),
        ]);
        const validDirectory = fence.kind === "lane"
          ? validLaneDirectory(finalPathStat, this.options.root.uid) &&
            validLaneDirectory(finalHandleStat, this.options.root.uid)
          : validAncestryDirectory(finalPathStat, this.options.root.uid, fence.kind === "root") &&
            validAncestryDirectory(finalHandleStat, this.options.root.uid, fence.kind === "root");
        if (
          finalRealpath !== fence.path || !validDirectory ||
          !sameFile(fence.stat, finalPathStat) || !sameFile(fence.stat, finalHandleStat) ||
          !sameOwnerAndMode(fence.stat, finalPathStat) || !sameOwnerAndMode(fence.stat, finalHandleStat) ||
          (fence.snapshot !== null &&
            (finalPathStat.dev !== fence.snapshot.dev || finalPathStat.ino !== fence.snapshot.ino ||
              finalPathStat.uid !== fence.snapshot.uid || finalPathStat.mode !== fence.snapshot.mode))
        ) return { state: "unknown", code: "path_invalid" };
      }

      const [finalStatusRealpath, finalPathStat, finalOpenedStat] = await Promise.all([
        realpath(statusPath),
        lstat(statusPath),
        statusHandle.stat(),
      ]);
      const finalPathValidation = validStatusFile(finalPathStat, this.options.root.uid);
      if (
        finalStatusRealpath !== statusPath || finalPathValidation !== null ||
        validStatusFile(finalOpenedStat, this.options.root.uid) !== null ||
        !sameFile(openedStat, finalPathStat) || !sameFile(openedStat, finalOpenedStat)
      ) return { state: "unknown", code: finalPathValidation ?? "path_invalid" };
      bytes = read;
    } catch (error) {
      return { state: "unknown", code: errorCode(error) };
    } finally {
      await statusHandle?.close().catch((): void => undefined);
      for (const fence of directoryFences.reverse()) {
        await fence.handle.close().catch((): void => undefined);
      }
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { state: "unknown", code: "utf8_invalid" };
    }
    let sample: ValidatedExternalRuntimeGenerationStatus;
    try {
      sample = parseExternalRuntimeGenerationStatus(text, provider);
    } catch {
      return { state: "unknown", code: "payload_invalid" };
    }
    if (!allTimesBounded(sample, nowMs)) return { state: "unknown", code: "time_invalid" };
    const unexpiredTransition = sample.status.transitions.some((transition) =>
      (transition.kind === "stopped" || transition.kind === "replaced") && nowMs <= transition.expiresAt);
    if (!externalRuntimeGenerationStatusIsFresh(sample.status, nowMs) && !unexpiredTransition) {
      return { state: "unknown", code: "status_stale" };
    }
    if (responseAttestation === undefined) return { state: "valid", sample };

    let attestation: ExternalRuntimeGenerationAttestationV1;
    try {
      attestation = validateExternalRuntimeGenerationAttestation(responseAttestation, provider);
    } catch {
      return { state: "unknown", code: "attestation_invalid" };
    }
    if (
      !externalRuntimeGenerationStatusIsFresh(sample.status, nowMs) ||
      !externalRuntimeGenerationAttestationIsFresh(attestation, nowMs)
    ) return { state: "unknown", code: "attestation_stale" };

    const current = sample.status.attestations.find((candidate) => canonicalJson(candidate) === canonicalJson(attestation));
    const terminal = sample.status.transitions.find((transition) =>
      (transition.kind === "stopped" || transition.kind === "replaced") &&
      transition.oldIdentity !== null && nowMs <= transition.expiresAt &&
      identityMatches(transition.oldIdentity, attestation.identity));
    const replacement = sample.status.transitions.find((transition) =>
      transition.kind === "replaced" && transition.newIdentity !== null &&
      nowMs <= transition.expiresAt && identityMatches(transition.newIdentity, attestation.identity));
    if (current === undefined && terminal === undefined && replacement === undefined) {
      return { state: "unknown", code: "attestation_missing" };
    }
    let expectedEndpointHash: string;
    try {
      expectedEndpointHash = externalRuntimeGenerationEndpointIdentityHash(provider, this.options.endpoints[provider]);
    } catch {
      return { state: "unknown", code: "endpoint_mismatch" };
    }
    if (attestation.identity.endpointIdentityHash !== expectedEndpointHash) {
      return { state: "unknown", code: "endpoint_mismatch" };
    }
    if (current !== undefined || replacement !== undefined) {
      const writerStart = await this.processIdentityReader.read(attestation.identity.writerPid);
      const runtimeStart = attestation.identity.runtimePid === attestation.identity.writerPid
        ? writerStart
        : await this.processIdentityReader.read(attestation.identity.runtimePid);
      if (
        writerStart !== attestation.identity.writerProcessStart ||
        runtimeStart !== attestation.identity.runtimeProcessStart
      ) return { state: "unknown", code: "process_mismatch" };
    }
    return { state: "valid", sample, launchAttestation: attestation };
  }
}
