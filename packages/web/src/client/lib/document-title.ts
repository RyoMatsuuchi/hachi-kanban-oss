// =============================================================================
// document.title の単一所有モジュール（docs/contract.md §37.7）。
// document.title へ書き込むのはこのファイルだけ。コンポーネントからの直接代入は禁止
// （AppShell が全ルートをラップするため、複数箇所から代入すると最後の書き手勝ちになり、
// cleanup で実行中ワーカー数のプレフィックスが消えてしまう）。
//
// 整形規則: activeCount > 0 なら `(<件数>) <ベース>`、0 件ならプレフィックス無し
// （ヘッダーの sessions バッジの `badge > 0` 表示条件と一致させる）。
// =============================================================================

import { useEffect, useRef } from "react";

/** ベース未登録時の既定タイトル。 */
export const DEFAULT_DOCUMENT_TITLE = "hachi-kanban";

// ---------------------------------------------------------------------------
// モジュール内の単一状態。登録者（owner）はユニークな symbol で識別し、
// cleanup は「自分が最後の登録者である場合のみ」クリアする。これにより
// StrictMode の二重実行や、画面遷移で旧画面の cleanup と新画面の effect が
// 交差した場合でも、新しい登録が巻き戻されない。
// ---------------------------------------------------------------------------
let currentBase: string | null = null;
let currentBaseOwner: symbol | null = null;
let currentCount = 0;
let currentCountOwner: symbol | null = null;

/**
 * ベースタイトルと実行中ワーカー数から実際の document.title を組み立てる純関数。
 */
export function formatDocumentTitle(base: string | null, activeCount: number): string {
  const resolvedBase = base ?? DEFAULT_DOCUMENT_TITLE;
  if (activeCount > 0) {
    return `(${activeCount}) ${resolvedBase}`;
  }
  return resolvedBase;
}

/** 現在の状態から document.title を再計算して反映する。 */
function applyDocumentTitle(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.title = formatDocumentTitle(currentBase, currentCount);
}

/**
 * 呼び出しごとにユニークな owner トークンを1つだけ確保する。
 * useRef なので StrictMode の再実行後も同じトークンを保つ。
 */
function useOwnerToken(description: string): symbol {
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) {
    ownerRef.current = Symbol(description);
  }
  return ownerRef.current;
}

/**
 * 画面ごとのベースタイトルを登録する。unmount 時は自分が最後の登録者のときだけ既定へ戻す。
 * hooks のルール上、条件分岐せず常に呼び、切り替えは引数側で行うこと。
 */
export function useDocumentTitleBase(base: string | null): void {
  const owner = useOwnerToken("document-title-base");

  useEffect(() => {
    currentBase = base;
    currentBaseOwner = owner;
    applyDocumentTitle();

    return () => {
      // 自分より後に別の画面が登録していれば、その登録を尊重して何もしない。
      if (currentBaseOwner !== owner) {
        return;
      }
      currentBase = null;
      currentBaseOwner = null;
      applyDocumentTitle();
    };
  }, [base, owner]);
}

/**
 * 実行中ワーカー（running session）数を登録し、タイトル先頭のプレフィックスに反映する。
 * ベースと同じく owner トークンで最後の登録者だけが cleanup できる。
 */
export function useActiveWorkerCountTitle(count: number): void {
  const owner = useOwnerToken("document-title-count");

  useEffect(() => {
    currentCount = count;
    currentCountOwner = owner;
    applyDocumentTitle();

    return () => {
      if (currentCountOwner !== owner) {
        return;
      }
      currentCount = 0;
      currentCountOwner = null;
      applyDocumentTitle();
    };
  }, [count, owner]);
}
