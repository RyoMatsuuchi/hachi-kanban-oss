import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@hachi/core";
import { makeTempHome, type TempHome } from "@hachi/testing";
import {
  saveReviewPromptArtifact,
  saveReviewTranscriptArtifact,
  saveFullTranscriptArtifact,
  savePromptArtifact,
  saveTranscriptArtifact,
} from "./artifacts.js";

describe("artifacts", () => {
  let home: TempHome;

  afterEach(() => {
    home.cleanup();
  });

  it("savePromptArtifact は <prefix>-<sanitized>-<sha256先頭8hex>.txt 形式で保存する（docs/contract.md §12.19-1）", () => {
    home = makeTempHome();
    savePromptArtifact(home.env, "t_abc", "claim-token-1", "プロンプト全文");

    const digest = sha256Hex("claim-token-1").slice(0, 8);
    const filePath = join(home.env.artifactsDir, "t_abc", `prompt-claim-token-1-${digest}.txt`);
    expect(readFileSync(filePath, "utf8")).toBe("プロンプト全文");
  });

  it("saveTranscriptArtifact は <prefix>-<sanitized>-<sha256先頭8hex>.txt 形式で保存し保存先パスを返す（docs/contract.md §12.19-1）", () => {
    home = makeTempHome();
    const filePath = saveTranscriptArtifact(home.env, "t_abc", "sess-1", "会話ログ全文");

    const digest = sha256Hex("sess-1").slice(0, 8);
    const expected = join(home.env.artifactsDir, "t_abc", `transcript-sess-1-${digest}.txt`);
    expect(filePath).toBe(expected);
    expect(readFileSync(filePath, "utf8")).toBe("会話ログ全文");
  });

  it("saveFullTranscriptArtifact は codex rollout jsonl を完全記録形式に整形して保存する（docs/contract.md §54.1）", () => {
    home = makeTempHome();
    const sessionsDir = join(home.home, "codex-sessions", "2026", "07", "08");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "rollout-sess-full-1.jsonl"),
      [
        JSON.stringify({ type: "user_prompt", text: "実装して" }),
        JSON.stringify({ type: "agent_message", text: "進めます" }),
        JSON.stringify({ type: "custom_tool_call", name: "exec_command", arguments: { cmd: "pnpm test" } }),
        JSON.stringify({ type: "patch_apply", path: "packages/web/src/app.ts" }),
        JSON.stringify({ type: "unknown_event", payload: { value: "残す" } }),
      ].join("\n"),
    );

    const filePath = saveFullTranscriptArtifact(
      home.env,
      "t_abc",
      "sess-full-1",
      "codex",
      "http://127.0.0.1:3456",
      "[assistant] fallback",
      { codexSessionsDir: join(home.home, "codex-sessions") },
    );

    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("[user] 実装して");
    expect(text).toContain("[assistant] 進めます");
    expect(text).toContain("[tool] exec_command");
    expect(text).toContain("pnpm test");
    expect(text).toContain("[patch] packages/web/src/app.ts");
    expect(text).toContain("[event:unknown_event]");
    expect(text).toContain("残す");
  });

  it("saveFullTranscriptArtifact は direct session の .out を保存し redact する（docs/contract.md §54.1）", () => {
    home = makeTempHome();
    const directDir = join(home.env.home, "state", "direct-sessions");
    mkdirSync(directDir, { recursive: true });
    writeFileSync(join(directDir, "direct-abc.out"), "Authorization: Bearer direct-secret-token-123\n");

    const filePath = saveFullTranscriptArtifact(
      home.env,
      "t_abc",
      "direct-abc",
      "codex",
      "direct",
      "[assistant] fallback",
    );

    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("direct-secret-token-123");
  });

  it("saveFullTranscriptArtifact は rollout/out 不在時に fallback transcript を注記付きで保存する（docs/contract.md §54.1）", () => {
    home = makeTempHome();

    const filePath = saveFullTranscriptArtifact(
      home.env,
      "t_abc",
      "sess-missing-full",
      "codex",
      "http://127.0.0.1:3456",
      "[assistant] 500件窓からの保存",
      { codexSessionsDir: join(home.home, "missing-codex-sessions") },
    );

    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("完全記録の保存元");
    expect(text).toContain("[assistant] 500件窓からの保存");
  });

  it("saveFullTranscriptArtifact は 2MB 超のログを末尾優先で保存する（docs/contract.md §54.1）", () => {
    home = makeTempHome();
    const huge = `${"a".repeat(2 * 1024 * 1024 + 100)}TAIL-END`;

    const filePath = saveFullTranscriptArtifact(home.env, "t_abc", "sess-huge", "codex", "direct", huge);

    const text = readFileSync(filePath, "utf8");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(text).toContain("先頭を省略");
    expect(text.endsWith("TAIL-END")).toBe(true);
  });

  it("サニタイズ後に衝突する id（'a/b' と 'a_b'）は sha256 先頭8hex により別ファイルになる（docs/contract.md §12.19-1）", () => {
    home = makeTempHome();
    saveTranscriptArtifact(home.env, "t_collide", "a/b", "1つ目");
    saveTranscriptArtifact(home.env, "t_collide", "a_b", "2つ目");

    const dir = join(home.env.artifactsDir, "t_collide");
    const files = readdirSync(dir);
    // サニタイズ後はどちらも 'a_b' になるが、元 ID の sha256 先頭 8 hex が異なるため2ファイルに分かれる
    expect(files).toHaveLength(2);

    const digestSlash = sha256Hex("a/b").slice(0, 8);
    const digestUnderscore = sha256Hex("a_b").slice(0, 8);
    expect(digestSlash).not.toBe(digestUnderscore);

    expect(readFileSync(join(dir, `transcript-a_b-${digestSlash}.txt`), "utf8")).toBe("1つ目");
    expect(readFileSync(join(dir, `transcript-a_b-${digestUnderscore}.txt`), "utf8")).toBe("2つ目");
  });

  it("taskId が artifactsDir 外を指す場合（'../evil'）は throw し何も書き込まない（fail-closed, docs/contract.md §12.19-1）", () => {
    home = makeTempHome();

    expect(() => savePromptArtifact(home.env, "../evil", "id-1", "text")).toThrow(
      /artifactsDir 配下に収まりません/,
    );
    expect(() => saveTranscriptArtifact(home.env, "../evil", "sess-1", "text")).toThrow(
      /artifactsDir 配下に収まりません/,
    );

    // artifactsDir の親（home 直下）に 'evil' ディレクトリが作られていないこと
    expect(existsSync(join(home.env.artifactsDir, "..", "evil"))).toBe(false);
  });

  it("saveReviewPromptArtifact は prompt-review-<sanitized>-<hash> 形式で保存する（docs/contract.md §15.1）", () => {
    home = makeTempHome();
    saveReviewPromptArtifact(home.env, "t_abc", "nonce-1", "レビュープロンプト全文");

    const digest = sha256Hex("nonce-1").slice(0, 8);
    const filePath = join(home.env.artifactsDir, "t_abc", `prompt-review-nonce-1-${digest}.txt`);
    expect(readFileSync(filePath, "utf8")).toBe("レビュープロンプト全文");
  });

  it("saveReviewTranscriptArtifact は transcript-review-<sanitized>-<hash> 形式で保存し保存先パスを返す（docs/contract.md §15.2）", () => {
    home = makeTempHome();
    const filePath = saveReviewTranscriptArtifact(home.env, "t_abc", "review-sess-1", "レビューログ全文");

    const digest = sha256Hex("review-sess-1").slice(0, 8);
    const expected = join(home.env.artifactsDir, "t_abc", `transcript-review-review-sess-1-${digest}.txt`);
    expect(filePath).toBe(expected);
    expect(readFileSync(filePath, "utf8")).toBe("レビューログ全文");
  });

});
