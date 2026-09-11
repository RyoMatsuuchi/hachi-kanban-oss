// =============================================================================
// メトリクスデータ取得フック（docs/contract.md §43.2）
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { MetricsResponse } from "../../shared/api-types.js";

interface UseMetricsResult {
  data: MetricsResponse | null;
  loading: boolean;
  error: string | null;
  /** 期間（日数）を変更して再取得 */
  setDays: (days: number) => void;
  days: number;
}

export function useMetrics(initialDays: number = 30): UseMetricsResult {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(initialDays);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(
    (d: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      fetch(`/api/metrics?days=${d}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`メトリクス取得に失敗しました (${res.status})`);
          }
          return (await res.json()) as MetricsResponse;
        })
        .then((result) => {
          setData(result);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") {
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    fetchData(days);
    return () => abortRef.current?.abort();
  }, [days, fetchData]);

  const changeDays = useCallback((d: number) => {
    setDays(d);
  }, []);

  return { data, loading, error, setDays: changeDays, days };
}
