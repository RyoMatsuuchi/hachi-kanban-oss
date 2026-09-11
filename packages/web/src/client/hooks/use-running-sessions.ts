// =============================================================================
// GET /api/sessions のフェッチ + 短周期ポーリング（docs/contract.md §26/§28）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { fetchSessions, type SessionsScope } from "../lib/api.js";
import type { SessionsResponse } from "../../shared/api-types.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 5_000;

export interface UseRunningSessionsResult {
  data: SessionsResponse | null;
  error: string | null;
  loading: boolean;
}

export interface UseRunningSessionsOptions {
  /**
   * 指定すると、タブ非表示中もこの間隔で件数を取り直す（docs/contract.md §37.7）。
   * タブタイトルの実行中ワーカー数を裏でも更新するための低頻度ポーリング。
   */
  hiddenIntervalMs?: number;
}

export function useRunningSessions(
  scope: SessionsScope = "running",
  options: UseRunningSessionsOptions = {},
): UseRunningSessionsResult {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchSessions(scope, signal)
      .then((res) => {
        setData(res);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useVisiblePolling(() => load(), POLL_INTERVAL_MS, options.hiddenIntervalMs);

  return { data, error, loading };
}
