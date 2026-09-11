// Orchestrator session の生存契約。CLI と supervisor が同じ値を参照する。

export const ORCHESTRATOR_SESSION_STALE_SECONDS = 90;
export const ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS = 30;

/** heartbeat 間隔が stale TTL より短いことを fail-closed で検証する。 */
export function assertOrchestratorSessionHeartbeatPolicy(
  staleSeconds = ORCHESTRATOR_SESSION_STALE_SECONDS,
  heartbeatIntervalSeconds = ORCHESTRATOR_AWAIT_HEARTBEAT_INTERVAL_SECONDS,
): void {
  if (!Number.isInteger(staleSeconds) || staleSeconds <= 0) {
    throw new Error(`orchestrator session stale秒は正の整数が必須です: ${staleSeconds}`);
  }
  if (!Number.isInteger(heartbeatIntervalSeconds) || heartbeatIntervalSeconds <= 0) {
    throw new Error(`orchestrator await heartbeat秒は正の整数が必須です: ${heartbeatIntervalSeconds}`);
  }
  if (heartbeatIntervalSeconds >= staleSeconds) {
    throw new Error(
      `orchestrator await heartbeat間隔はstale TTL未満が必須です: interval=${heartbeatIntervalSeconds}, stale=${staleSeconds}`,
    );
  }
}
