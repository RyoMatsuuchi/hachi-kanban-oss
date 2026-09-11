// =============================================================================
// タスク本文カード（task.body）。仕様・手順・判断ブリーフ等の主要コンテンツを表示する。
// body は Markdown 記法のため Markdown コンポーネントでレンダリングする（サニタイズ必須。
// Markdown.tsx 参照）。
// =============================================================================

import type { JSX } from "react";
import { Card } from "./Card.js";
import { Markdown } from "./Markdown.js";

export function BodyCard(props: { body: string }): JSX.Element {
  const body = props.body.trim();
  return (
    <Card title="本文">
      {body === "" ? (
        <p className="text-sm text-ink-muted">本文はありません</p>
      ) : (
        <Markdown source={body} />
      )}
    </Card>
  );
}
