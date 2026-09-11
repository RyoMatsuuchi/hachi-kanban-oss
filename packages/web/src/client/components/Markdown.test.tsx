// =============================================================================
// Markdown.tsx の単体テスト（DOMPurify によるサニタイズが実際に効いていることの担保）。
// task.body / コメント本文は worker 由来の自由文＝信頼できない入力のため、
// <script>・on* イベントハンドラ・javascript: リンク等が確実に除去されることを検証する。
// DOMPurify はブラウザ DOM を前提とするため jsdom 環境で実行する。
// =============================================================================

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderMarkdownToSafeHtml } from "./Markdown.js";

describe("renderMarkdownToSafeHtml", () => {
  it("script タグを除去する", () => {
    const html = renderMarkdownToSafeHtml('本文<script>alert("xss")</script>続き');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
  });

  it("img の onerror 属性を除去する", () => {
    const html = renderMarkdownToSafeHtml('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("javascript: リンクの href を除去する", () => {
    const html = renderMarkdownToSafeHtml("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("iframe タグを除去する", () => {
    const html = renderMarkdownToSafeHtml('<iframe src="https://evil.example/"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("style タグを除去する", () => {
    const html = renderMarkdownToSafeHtml("<style>body{display:none}</style>本文");
    expect(html).not.toContain("<style");
  });

  it("object/embed/form などの危険タグを除去する", () => {
    const html = renderMarkdownToSafeHtml(
      '<object data="https://evil.example/"></object><embed src="x"><form action="/steal">本文</form>',
    );
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<form");
    expect(html).toContain("本文");
  });

  it("通常の Markdown（見出し・リスト・コードブロック・リンク）を HTML に変換する", () => {
    const source = ["# 見出し", "", "- item1", "- item2", "", "```ts", 'const x = 1;', "```", "", "[docs](https://example.com/)"].join("\n");
    const html = renderMarkdownToSafeHtml(source);
    expect(html).toContain("<h1>見出し</h1>");
    expect(html).toContain("<li>item1</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1;");
    expect(html).toContain('href="https://example.com/"');
  });

  it("外部リンクに target=_blank と rel=noopener noreferrer を付与する（tabnabbing対策）", () => {
    const html = renderMarkdownToSafeHtml("[docs](https://example.com/)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("改行を <br> に変換する（breaks:true）", () => {
    const html = renderMarkdownToSafeHtml("1行目\n2行目");
    expect(html).toContain("<br>");
  });
});
