// =============================================================================
// GET /api/supervisor のフェッチ + 30秒ポーリング + kill-switch トグル
// （docs/contract.md §23.3: 「30秒ポーリングに supervisor 状態も含める（or 別 useEffect）」）。
// ボードの useBoardData とは独立させ、tenant/query 変更の再フェッチに巻き込まれないようにする。
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { fetchSupervisorStatus, postKillSwitch } from "../lib/api.js";
import type { SupervisorStatus } from "../../shared/api-types.js";
import { useVisiblePolling } from "./use-visible-polling.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseSupervisorStatusResult {
  data: SupervisorStatus | null;
  error: string | null;
  loading: boolean;
  /** kill-switch を切り替える（楽観更新 → POST → 再フェッチ。docs/contract.md §23.3） */
  toggle: (stage: string, disabled: boolean) => void;
}

export function useSupervisorStatus(): UseSupervisorStatusResult {
  const [data, setData] = useState<SupervisorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchSupervisorStatus(signal)
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

  const toggle = useCallback(
    (stage: string, disabled: boolean): void => {
      // 楽観更新: サーバ応答を待たず即座に UI へ反映する（破壊的操作ではないため確認は挟まない。§23.3）
      setData((prev) => {
        if (prev === null) {
          return prev;
        }
        return {
          ...prev,
          stages: prev.stages.map((s) => (s.name === stage ? { ...s, disabled } : s)),
        };
      });
      postKillSwitch(stage, disabled)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          // 実サーバ状態に揃えるための再フェッチ（楽観更新の後始末）
          load();
        });
    },
    [load],
  );

  return { data, error, loading, toggle };
}
