import { execFile } from "node:child_process";
import type { ExecutionCapabilitySnapshot, Provider } from "@hachi/core";

export interface DirectRuntimeCommandRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type DirectRuntimeCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: "not-found" | "timeout" | "execution" };

export interface DirectRuntimeCapabilityRunner {
  run(request: DirectRuntimeCommandRequest): Promise<DirectRuntimeCommandResult>;
}

export interface DirectRuntimeCapabilityProbeOptions {
  provider: Provider;
  executable?: string;
  timeoutMs?: number;
  observedAt?: number;
}

export type DirectRuntimeCapabilityProbeResult =
  | { ok: true; provider: Provider; snapshot: ExecutionCapabilitySnapshot }
  | {
      ok: false;
      provider: Provider;
      failure: {
        kind: "not-found" | "timeout" | "execution" | "invalid-output";
        detail: string;
      };
    };

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4_096;
export const DIRECT_SPEED_CONTROL_CAPABILITY = "speed-control-v1";
const MINIMUM_SPEED_CONTROL_VERSION: Record<Provider, string> = {
  codex: "0.144.1",
  claude: "2.1.226",
};
const SEMVER_SOURCE =
  "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

function extractRuntimeVersion(provider: Provider, output: string): string | null {
  const patterns = provider === "codex"
    ? [new RegExp(`^(?:codex|codex-cli)\\s+(${SEMVER_SOURCE})$`, "i")]
    : [
        new RegExp(`^(?:claude|claude-code|Claude Code)\\s+(${SEMVER_SOURCE})$`, "i"),
        new RegExp(`^(${SEMVER_SOURCE})\\s+\\(Claude Code\\)$`, "i"),
      ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

/** strict semver として抽出済みの runtime version が最低版以上かを比較する。 */
function supportsSpeedControl(provider: Provider, version: string): boolean {
  const parseCore = (value: string): readonly [number, number, number, boolean] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(value);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      return [0, 0, 0, true];
    }
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] !== undefined];
  };
  const actual = parseCore(version);
  const minimum = parseCore(MINIMUM_SPEED_CONTROL_VERSION[provider]);
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }
  // 同じcore versionのprereleaseはrelease版より古い。
  return !actual[3] || minimum[3];
}

/** bounded・read-only の既定 `--version` runner。 */
export class SystemDirectRuntimeCapabilityRunner implements DirectRuntimeCapabilityRunner {
  run(request: DirectRuntimeCommandRequest): Promise<DirectRuntimeCommandResult> {
    return new Promise((resolve) => {
      execFile(request.executable, [...request.args], {
        encoding: "utf8",
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ ok: false, kind: "not-found" });
          return;
        }
        if (error.killed || code === "ETIMEDOUT") {
          resolve({ ok: false, kind: "timeout" });
          return;
        }
        resolve({ ok: false, kind: "execution" });
      });
    });
  }
}

function failure(
  provider: Provider,
  kind: "not-found" | "timeout" | "execution" | "invalid-output",
  detail: string,
): DirectRuntimeCapabilityProbeResult {
  return { ok: false, provider, failure: { kind, detail } };
}

/** contract §59.1 の direct executable capability probe。 */
export async function probeDirectRuntimeCapabilities(
  options: DirectRuntimeCapabilityProbeOptions,
  runner: DirectRuntimeCapabilityRunner = new SystemDirectRuntimeCapabilityRunner(),
): Promise<DirectRuntimeCapabilityProbeResult> {
  const executable = options.executable ?? options.provider;
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(requestedTimeout, MAX_TIMEOUT_MS))
    : DEFAULT_TIMEOUT_MS;
  let result: DirectRuntimeCommandResult;
  try {
    result = await runner.run({
      executable,
      args: ["--version"],
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } catch {
    return failure(options.provider, "execution", "runtime version probe failed");
  }
  if (!result.ok) {
    const details: Record<typeof result.kind, string> = {
      "not-found": "runtime executable was not found",
      timeout: "runtime version probe timed out",
      execution: "runtime version probe failed",
    };
    return failure(options.provider, result.kind, details[result.kind]);
  }
  if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > MAX_OUTPUT_BYTES) {
    return failure(options.provider, "invalid-output", "runtime version output exceeds size limit");
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const output = stdout === "" ? stderr : stderr === "" ? stdout : "";
  const version = extractRuntimeVersion(options.provider, output);
  if (version === null) {
    return failure(options.provider, "invalid-output", "runtime version is not strict semver");
  }
  const speedControl = supportsSpeedControl(options.provider, version);
  return {
    ok: true,
    provider: options.provider,
    snapshot: {
      schemaVersion: "execution-capability.v1",
      provider: options.provider,
      transport: "direct",
      runtime: { name: `${options.provider}-cli`, version, source: "local-probe" },
      capabilities: speedControl ? [DIRECT_SPEED_CONTROL_CAPABILITY] : [],
      modelCatalog: { knowledge: "unknown", detail: "runtime does not advertise a model catalog" },
      delivery: { model: "native", effort: "native", speed: speedControl ? "native" : "unknown" },
      observedAt: options.observedAt ?? Date.now(),
    },
  };
}
