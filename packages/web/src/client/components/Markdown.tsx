// =============================================================================
// Markdown レンダリング共通コンポーネント。
// task.body / コメント本文（agent.message.v1 フェンスドブロックを除いた地の文）は
// worker 由来の自由記述テキスト＝信頼できない入力のため、marked で HTML 化した後に
// 必ず DOMPurify でサニタイズしてから描画する（生の marked 出力を直接描画しない）。
// =============================================================================

import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";
import type { JSX } from "react";

// <a target="_blank"> には rel="noopener noreferrer" を必ず付与する（tabnabbing 対策）。
// DOMPurify のフックは import 時に一度だけ登録すればよい（複数回 addHook しても副作用は無いが
// モジュール評価が複数回走らないよう関数内ではなくトップレベルで登録する）。
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// script/style/iframe 等の危険タグは DOMPurify のデフォルト許可リストにも含まれないが、
// 防御的多重化として明示的に禁止する。on* 属性・javascript: リンクはデフォルト設定で
// 常に除去される（ALLOWED_ATTR に on* が含まれない／ALLOWED_URI_REGEXP が javascript: を弾く）。
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form"],
  FORBID_ATTR: ["srcdoc"],
};

/**
 * Markdown 文字列を安全な HTML 文字列へ変換する。
 * marked でパース（GFM 有効・改行は <br>）→ DOMPurify で必ずサニタイズする。
 * サニタイズ単体でのテスト容易性のため React コンポーネントとは分離して export する。
 */
export function renderMarkdownToSafeHtml(source: string): string {
  const rawHtml = marked.parse(source, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
}

/** task.body / コメント地の文を Markdown レンダリングして表示する */
export function Markdown(props: { source: string }): JSX.Element {
  const html = renderMarkdownToSafeHtml(props.source);
  return (
    <div
      className="hk-markdown prose prose-sm max-w-none break-words text-ink
        prose-headings:text-sm prose-headings:font-semibold prose-headings:text-ink
        prose-p:leading-relaxed prose-a:text-accent-strong prose-a:no-underline hover:prose-a:underline
        prose-strong:text-ink
        prose-blockquote:border-accent/30 prose-blockquote:text-ink-muted
        prose-code:rounded-md prose-code:bg-surface-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:text-ink prose-code:before:content-none prose-code:after:content-none
        prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-line prose-pre:bg-surface-muted prose-pre:text-ink
        prose-img:rounded-md
        prose-hr:border-line
        prose-table:block prose-table:overflow-x-auto"
      // DOMPurify.sanitize 済みの HTML のみを描画する（上記コメント参照）
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
