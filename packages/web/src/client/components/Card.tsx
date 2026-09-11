// =============================================================================
// surface トークンのカード（1px 境界・rounded-md・p-3 のフラットな面）。
// 詳細画面の各セクションはこのカード単位で区切る（追加要件: セクション間の余白確保）。
// =============================================================================

import type { JSX, ReactNode } from "react";

export interface CardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Card(props: CardProps): JSX.Element {
  return (
    <section
      className={`rounded-md border border-line bg-surface p-3 transition-colors ${props.className ?? ""}`}
    >
      {props.title !== undefined ? (
        <h2 className="mb-3 text-sm font-semibold text-ink">{props.title}</h2>
      ) : null}
      {props.children}
    </section>
  );
}
