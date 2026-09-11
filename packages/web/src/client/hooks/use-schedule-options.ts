// =============================================================================
// GET /api/schedule-options のフェッチ（docs/contract.md §29.5）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { ScheduleFormOptionsResponse } from "../../shared/api-types.js";
import { fetchScheduleOptions } from "../lib/api.js";

export interface UseScheduleOptionsResult {
  data: ScheduleFormOptionsResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useScheduleOptions(): UseScheduleOptionsResult {
  const [data, setData] = useState<ScheduleFormOptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchScheduleOptions(signal)
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

  return { data, error, loading, reload: () => load() };
}
