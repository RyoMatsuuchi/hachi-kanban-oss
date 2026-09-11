// =============================================================================
// Runtime resource inventory の取得。30秒 visible polling と abort は既存 hook 流儀に揃える。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { RuntimeResourcesResponse } from "../../shared/api-types.js";
import { ApiError, fetchRuntimeResources } from "../lib/api.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseRuntimeResourcesResult {
  data: RuntimeResourcesResponse | null;
  error: string | null;
  degraded: boolean;
  loading: boolean;
}

export function useRuntimeResources(): UseRuntimeResourcesResult {
  const [data, setData] = useState<RuntimeResourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchRuntimeResources(signal)
      .then((response) => {
        setData(response);
        setError(null);
        setDegraded(false);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setError(error instanceof Error ? error.message : String(error));
        setDegraded(error instanceof ApiError && error.status === 503);
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

  return { data, error, degraded, loading };
}
