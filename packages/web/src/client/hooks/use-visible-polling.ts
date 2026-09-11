// =============================================================================
// 一定間隔で callback を呼ぶポーリング hook。タブが非表示（document.hidden）の間は
// スキップする（docs/contract.md §20 実装指示: 「タブ非表示時は skip」）。
//
// 任意の hiddenIntervalMs を渡した場合のみ、非表示中に限って低頻度で callback を呼ぶ
// 2本目の interval を張る（docs/contract.md §37.7）。タブを開いていなくても更新が
// 要る用途（タブタイトルの実行中ワーカー数）のための逃がし口で、帯域節約のため
// 通常間隔より十分低頻度にすること。
// なお、ブラウザはバックグラウンドタブの setInterval をスロットリングするため
// （Chrome では数分後に約1分間隔まで落ちる）、厳密な間隔は保証されない。
// =============================================================================

import { useEffect, useRef } from "react";

export function useVisiblePolling(
  callback: () => void,
  intervalMs: number,
  hiddenIntervalMs?: number,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      callbackRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  useEffect(() => {
    if (hiddenIntervalMs === undefined) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      // 表示中は1本目の interval が担当するため、二重フェッチを避けて何もしない。
      if (!document.hidden) {
        return;
      }
      callbackRef.current();
    }, hiddenIntervalMs);
    return () => window.clearInterval(timer);
  }, [hiddenIntervalMs]);
}
