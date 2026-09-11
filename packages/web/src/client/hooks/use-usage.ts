// =============================================================================
// usage 集計データ取得フック（契約 §14.5.1）。
// 期間と集計軸を切り替えて /api/usage を引き直す。read-only なので write token は不要。
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUsage } from "../lib/api.js";
import type { UsageGroupByAxis, UsageResponse } from "../../shared/api-types.js";

interface UseUsageResult {
  data: UsageResponse | null;
  loading: boolean;
  error: string | null;
  days: number;
  setDays: (days: number) => void;
  groupBy: UsageGroupByAxis;
  setGroupBy: (groupBy: UsageGroupByAxis) => void;
}

export function useUsage(initialDays = 30, initialGroupBy: UsageGroupByAxis = "task"): UseUsageResult {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(initialDays);
  const [groupBy, setGroupBy] = useState<UsageGroupByAxis>(initialGroupBy);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    fetchUsage({ by: groupBy, days }, controller.signal)
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

    return () => controller.abort();
  }, [days, groupBy]);

  const changeDays = useCallback((next: number) => setDays(next), []);
  const changeGroupBy = useCallback((next: UsageGroupByAxis) => setGroupBy(next), []);

  return { data, loading, error, days, setDays: changeDays, groupBy, setGroupBy: changeGroupBy };
}
