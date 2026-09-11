// =============================================================================
// GET /api/task/:id のフェッチ + 30秒ポーリング（docs/contract.md §20.2/§20 実装指示）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { TaskRow } from "@hachi/core";
import { fetchTaskDetail } from "../lib/api.js";
import type { NormalizedTaskDetailResponse } from "../../shared/api-types.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseTaskDetailResult {
  data: NormalizedTaskDetailResponse | null;
  error: string | null;
  loading: boolean;
  updateTask: (task: TaskRow) => void;
}

export function useTaskDetail(taskId: string): UseTaskDetailResult {
  const [data, setData] = useState<NormalizedTaskDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(
    (signal?: AbortSignal): void => {
      fetchTaskDetail(taskId, signal)
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
    },
    [taskId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useVisiblePolling(() => load(), POLL_INTERVAL_MS);

  const updateTask = useCallback((task: TaskRow): void => {
    setData((current) => (current === null ? current : { ...current, task }));
  }, []);

  return { data, error, loading, updateTask };
}
