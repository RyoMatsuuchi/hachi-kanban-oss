// =============================================================================
// GET /api/board のフェッチ + 30秒ポーリング（docs/contract.md §20.2/§20 実装指示）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { TaskRow } from "@hachi/core";
import { fetchBoard } from "../lib/api.js";
import type { BoardResponse } from "../../shared/api-types.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseBoardDataResult {
  data: BoardResponse | null;
  error: string | null;
  loading: boolean;
  updateTask: (task: TaskRow) => void;
}

function replaceTask(tasks: TaskRow[], replacement: TaskRow): TaskRow[] {
  return tasks.map((task) => (task.id === replacement.id ? replacement : task));
}

function replaceBoardTask(data: BoardResponse, task: TaskRow): BoardResponse {
  return {
    ...data,
    lanes: {
      humanQueue: replaceTask(data.lanes.humanQueue, task),
      humanDecisionQueue: replaceTask(data.lanes.humanDecisionQueue, task),
      orchestratorRecoveryQueue: replaceTask(data.lanes.orchestratorRecoveryQueue, task),
      inProgress: replaceTask(data.lanes.inProgress, task),
      byStatus: {
        triage: replaceTask(data.lanes.byStatus.triage, task),
        todo: replaceTask(data.lanes.byStatus.todo, task),
        ready: replaceTask(data.lanes.byStatus.ready, task),
        review: replaceTask(data.lanes.byStatus.review, task),
        "needs-integration": replaceTask(data.lanes.byStatus["needs-integration"], task),
        done: replaceTask(data.lanes.byStatus.done, task),
      },
    },
  };
}

export function useBoardData(tenant: string, query: string): UseBoardDataResult {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(
    (signal?: AbortSignal): void => {
      fetchBoard({ tenant, q: query }, signal)
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
    [tenant, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useVisiblePolling(() => load(), POLL_INTERVAL_MS);

  const updateTask = useCallback((task: TaskRow): void => {
    setData((current) => (current === null ? current : replaceBoardTask(current, task)));
  }, []);

  return { data, error, loading, updateTask };
}
