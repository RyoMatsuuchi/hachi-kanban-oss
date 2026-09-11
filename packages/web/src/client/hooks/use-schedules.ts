// =============================================================================
// GET /api/schedules のフェッチ + 30秒ポーリング（docs/contract.md §29.4）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { SchedulesResponse } from "../../shared/api-types.js";
import { fetchSchedules } from "../lib/api.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseSchedulesResult {
  data: SchedulesResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useSchedules(): UseSchedulesResult {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchSchedules(signal)
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useVisiblePolling(() => load(), POLL_INTERVAL_MS);

  return { data, error, loading, reload: () => load() };
}
