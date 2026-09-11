import { realpathSync } from "node:fs";
import {
  BridgeError,
  fetchSessionsByCwdAndProvider,
  type BridgeSessionCandidate,
} from "@hachi/adapters";
import { redactText } from "@hachi/core";
import type { BridgeConfig, Provider, StageDeps } from "@hachi/core";

export const LAUNCH_INDETERMINATE_PREFIX = "needs-manual: launch-indeterminate: ";

export interface LaunchCandidateSession {
  id: string;
  status: "idle" | "busy";
  timestamp: string | null;
  startedAfterAttempt: boolean | null;
}

export interface LaunchIndeterminateProbePayload {
  attemptedAt: string;
  probeCwd: string | null;
  probeProvider: Provider;
  candidateSessions: LaunchCandidateSession[];
  probedAt: string;
  probeError: string | null;
}

export type LaunchSessionProbe = (
  bridge: BridgeConfig,
  cwd: string,
  provider: Provider,
) => Promise<BridgeSessionCandidate[]>;

interface StageDepsWithLaunchSessionProbe extends StageDeps {
  launchSessionProbe?: LaunchSessionProbe;
}

export function isIndeterminateLaunchFailure(err: unknown): boolean {
  return err instanceof BridgeError && err.kind === "timeout";
}

/** session timestamp が launch 試行時刻以降かを、不正時刻を偽へ丸めず判定する。 */
function startedAfterAttempt(timestamp: string | null, attemptedAtMs: number): boolean | null {
  if (timestamp === null) {
    return null;
  }
  const sessionTimestampMs = Date.parse(timestamp);
  if (!Number.isFinite(sessionTimestampMs)) {
    return null;
  }
  return sessionTimestampMs >= attemptedAtMs;
}

/** timeout 後の read-only 照会を行い、判断を加えず durable event 用の観測値だけを組み立てる。 */
export async function probeIndeterminateLaunch(
  deps: StageDeps,
  cwd: string,
  probeProvider: Provider,
  attemptedAt: string,
): Promise<LaunchIndeterminateProbePayload> {
  const attemptedAtMs = Date.parse(attemptedAt);
  const probe = (deps as StageDepsWithLaunchSessionProbe).launchSessionProbe ??
    fetchSessionsByCwdAndProvider;
  let probeCwd: string | null = null;
  let candidateSessions: LaunchCandidateSession[] = [];
  let probeError: string | null = null;
  try {
    probeCwd = realpathSync.native(cwd);
    const sessions = await probe(deps.env.bridges[probeProvider], probeCwd, probeProvider);
    candidateSessions = sessions.map((session) => ({
      id: session.id,
      status: session.status,
      timestamp: session.timestamp,
      startedAfterAttempt: startedAfterAttempt(session.timestamp, attemptedAtMs),
    }));
  } catch (error) {
    probeError = redactText(error instanceof Error ? error.message : String(error));
  }

  return {
    attemptedAt,
    probeCwd,
    probeProvider,
    candidateSessions,
    probedAt: new Date().toISOString(),
    probeError,
  };
}
