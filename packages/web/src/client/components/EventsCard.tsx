// =============================================================================
// イベント監査履歴（docs/contract.md §14.3）。
// サイドカラム（狭幅）でも payload が潰れないよう、テーブルではなく縦積みリストで表示する。
// 各イベントは「日時・event_type・actor」のヘッダ行 + payload の pre で構成し、
// payload は横スクロールを出さず縦スクロール枠に収める。
// =============================================================================

import type { JSX } from "react";
import type { EventRow } from "@hachi/core";
import { Card } from "./Card.js";
import { ScrollArea } from "./ui/ScrollArea.js";
import { formatTimestamp } from "../lib/format.js";

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

/** payload が実質空（{} / 空文字）なら pre を出さない判定 */
function hasPayload(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed !== "" && trimmed !== "{}";
}

export function EventsCard(props: { events: EventRow[] }): JSX.Element {
  const { events } = props;
  return (
    <Card title={`イベント（${events.length}）`}>
      {events.length === 0 ? (
        <p className="text-sm italic text-ink-muted">イベントはありません</p>
      ) : (
        // イベントは監査証跡で増え続けるため、高さ上限 + 内部スクロールに収める
        // （右端に隠れないよう pr-1 を付与）
        <ScrollArea className="min-w-0" viewportClassName="max-h-[28rem] min-w-0 pr-1">
          <ul className="min-w-0 space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="min-w-0 rounded-md border border-line p-2.5"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span
                    className="max-w-full break-all rounded-md bg-surface-muted px-1.5 py-0.5 font-medium text-ink"
                    title={event.eventType}
                  >
                    {event.eventType}
                  </span>
                  {event.actor !== "" ? (
                    <span className="min-w-0 max-w-full break-all text-ink-muted">
                      {event.actor}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 tabular-nums text-ink-muted">
                    {formatTimestamp(event.createdAt)}
                  </span>
                </div>
                {hasPayload(event.payload) ? (
                  <ScrollArea
                    className="mt-2 max-w-full rounded-md border border-line bg-surface-muted"
                    viewportClassName="max-h-40"
                  >
                    <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed text-ink">
                      {formatPayload(event.payload)}
                    </pre>
                  </ScrollArea>
                ) : null}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Card>
  );
}
