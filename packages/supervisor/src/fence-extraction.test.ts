import { describe, expect, it } from "vitest";
import {
  classifyExecutionFailure,
  extractAssistantFence,
  isFenceForTask,
  isHandoffSchema,
  isVerdictSchema,
} from "./fence-extraction.js";

function handoff(taskId: string, summary: string): string {
  return [
    "```hachi-handoff-v1",
    JSON.stringify({ taskId, outcome: "done", summary }),
    "```",
  ].join("\n");
}

function verdict(taskId: string, summary: string): string {
  return [
    "```hachi-verdict-v1",
    JSON.stringify({ taskId, verdict: "pass", confidence: "high", summary, issues: [] }),
    "```",
  ].join("\n");
}

describe("extractAssistantFence", () => {
  it("user prompt のフェンスを無視し、構造化 assistant 最終 result のフェンスを選ぶ", () => {
    const promptFence = handoff("t_prompt", "<作業内容の要約>");
    const resultFence = handoff("t_actual", "実作業完了");
    const extracted = extractAssistantFence({
      transcript: `[user] ${promptFence}\n\n[assistant] ${resultFence}`,
      structuredStatusRaw: {
        messages: [
          { type: "user_prompt", text: promptFence },
          { type: "result", success: true, text: resultFence },
        ],
      },
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(extracted).toMatchObject({ kind: "candidate", source: "structured_result" });
    if (extracted.kind === "candidate") {
      expect(JSON.parse(extracted.raw)).toMatchObject({ taskId: "t_actual", summary: "実作業完了" });
    }
  });

  it("bridge は structured result が無ければ role marker らしき文字列があっても fail-closed にする", () => {
    expect(
      extractAssistantFence({
        transcript: `[user] 本文\n[assistant] ${handoff("t_fake", "誤抽出禁止")}`,
        spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
      }),
    ).toMatchObject({ kind: "failure", reason: "extraction_failed" });
  });

  it.each([
    ["role 不明", handoff("t_unknown", "誤抽出禁止")],
    ["未知 message role", `[assistant] 前置\n\n[tool] ${handoff("t_tool", "誤抽出禁止")}`],
  ])("%s は extraction_failed", (_label, transcript) => {
    expect(
      extractAssistantFence({
        transcript,
        spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
      }),
    ).toMatchObject({ kind: "failure", reason: "extraction_failed" });
  });

  it("同一 assistant result の複数フェンスから末尾の schema-valid 候補を選ぶ", () => {
    const text = [
      handoff("t_first", "1件目"),
      "```hachi-handoff-v1",
      "{malformed",
      "```",
      handoff("t_last", "末尾の有効候補"),
    ].join("\n");
    const extracted = extractAssistantFence({
      transcript: `[user] ${handoff("t_prompt", "例示")}\n[assistant] ${text}`,
      structuredStatusRaw: { messages: [{ type: "result", success: true, text }] },
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(extracted.kind).toBe("candidate");
    if (extracted.kind === "candidate") {
      expect(JSON.parse(extracted.raw)).toMatchObject({ taskId: "t_last" });
    }
  });

  it("全フェンスが malformed JSON なら parse_invalid", () => {
    expect(
      extractAssistantFence({
        transcript: `[user] ${verdict("t_prompt", "例示")}`,
        structuredStatusRaw: {
          messages: [{ type: "result", success: true, text: "```hachi-verdict-v1\n{malformed\n```" }],
        },
        spec: { label: "hachi-verdict-v1", isSchemaValid: isVerdictSchema },
      }),
    ).toMatchObject({ kind: "failure", reason: "parse_invalid" });
  });
});

describe("isFenceForTask", () => {
  it("schema-valid candidate の taskId が一致すれば true", () => {
    const extraction = extractAssistantFence({
      transcript: handoff("t_target", "完了"),
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(isFenceForTask(extraction, "t_target")).toBe(true);
  });

  it("taskId が一致しても summary が未置換テンプレートなら false", () => {
    const extraction = extractAssistantFence({
      transcript: handoff("t_target", "<作業内容の要約>"),
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(isFenceForTask(extraction, "t_target")).toBe(false);
  });

  it("missing と failure は false", () => {
    expect(isFenceForTask({ kind: "missing" }, "t_target")).toBe(false);
    expect(
      isFenceForTask(
        { kind: "failure", reason: "parse_invalid", diagnostic: "invalid" },
        "t_target",
      ),
    ).toBe(false);
  });

  it("candidate の taskId が別 task なら false", () => {
    const extraction = extractAssistantFence({
      transcript: handoff("t_other", "完了"),
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(isFenceForTask(extraction, "t_target")).toBe(false);
  });

  it("candidate の raw が JSON として不正でも throw せず false", () => {
    expect(
      isFenceForTask(
        { kind: "candidate", raw: "{invalid", source: "assistant_output" },
        "t_target",
      ),
    ).toBe(false);
  });
});

describe("classifyExecutionFailure", () => {
  it("0-token usage-limit を provider_capacity_exceeded に分類する", () => {
    const transcript = `usage-limit reached\n${handoff("t_prompt", "<作業内容の要約>")}`;
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
          raw: { messages: [{ type: "result", success: false, text: "usage-limit reached" }] },
        },
        transcript,
        "bridge_transcript",
      ),
    ).toEqual({ reason: "provider_capacity_exceeded", diagnostic: "usage-limit reached" });
  });

  it("bridge のターン上限打ち切りを run_truncated_max_turns に分類する", () => {
    // even-terminal は SDK の error_max_turns を受けて result.text にこの文言を載せ success=false で返す。
    // 2026-08-20 に M3a がこれで停止したが、パターンが無く worker_output_missing と誤報された。
    const truncated = "Reached max turns limit (50 turns). Try breaking the task into smaller steps.";
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 50, inputTokens: 12000, outputTokens: 3400 },
          raw: { messages: [{ type: "result", success: false, text: truncated }] },
        },
        `${truncated}\n`,
        "bridge_transcript",
      ),
    ).toEqual({ reason: "run_truncated_max_turns", diagnostic: truncated });
  });

  it("direct CLI の 'Reached maximum number of turns' も打ち切りとして分類する", () => {
    // reference §3 に既出の文言。even-terminal の "max turns limit" とは別の言い回し。
    const truncated = "Reached maximum number of turns";
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
          raw: { messages: [{ type: "result", success: false, text: truncated }] },
        },
        truncated,
        "bridge_transcript",
      )?.reason,
    ).toBe("run_truncated_max_turns");
  });

  it("maxTurns へ言及しただけの非対応診断は打ち切り扱いにしない", () => {
    // 「上限へ到達した」文型ではないので incompatible_model_transport の担当。
    // 打ち切り判定を capacity より前に置いた副作用で奪わないことを固定する。
    const unsupported = "maxTurns is not supported by this runtime";
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
          raw: { messages: [{ type: "result", success: false, text: unsupported }] },
        },
        unsupported,
        "bridge_transcript",
      )?.reason,
    ).toBe("incompatible_model_transport");
  });

  it("打ち切り文言は usage-limit より優先して分類される（'limit' 語の取り違えを防ぐ）", () => {
    const truncated = "Reached max turns limit (50 turns).";
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
          raw: { messages: [{ type: "result", success: false, text: truncated }] },
        },
        truncated,
        "bridge_transcript",
      )?.reason,
    ).toBe("run_truncated_max_turns");
  });

  it.each([
    ["model is incompatible with transport", "incompatible_model_transport"],
    ["codex: command not found", "cli_startup_failed"],
    ["process exited before output", "worker_output_missing"],
  ] as const)("0-token 診断 '%s' を %s に分類する", (diagnostic, reason) => {
    expect(
      classifyExecutionFailure(
        {
          lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
          raw: { messages: [{ type: "result", success: false, text: diagnostic }] },
        },
        diagnostic,
        "bridge_transcript",
      ),
    ).toMatchObject({ reason });
  });

  it.each(["", "(出力ファイルなし)"])(
    "raw/lastResult 未提供で実出力が無い transcript '%s' を worker_output_missing に分類する",
    (transcript) => {
      expect(classifyExecutionFailure({}, transcript, "direct_assistant_output")).toEqual({
        reason: "worker_output_missing",
        diagnostic: "実出力を取得できませんでした",
      });
    },
  );

  it("バナーを持たない短い CLI エラー transcript を cli_startup_failed に分類する", () => {
    expect(
      classifyExecutionFailure({}, "codex: command not found", "direct_assistant_output"),
    ).toMatchObject({ reason: "cli_startup_failed" });
  });

  it("バナーの workdir に capacity があっても長い通常出力の末尾からは分類しない", () => {
    const transcript = [
      "OpenAI Codex v0.0.0",
      "--------",
      "workdir: /tmp/hk-reviewer-capacity",
      "model: test-model",
      "--------",
      "user",
      "通常のタスク本文",
      "codex",
      "正常な作業ログ".repeat(100),
    ].join("\n");

    expect(classifyExecutionFailure({}, transcript, "direct_assistant_output")).toBeNull();
  });

  it("先頭500字に分類語がなくても末尾の provider capacity エラーを分類する", () => {
    const transcript = [
      "通常の作業ログ".repeat(100),
      "ERROR: Selected model is at capacity.",
    ].join("\n");

    expect(
      classifyExecutionFailure({}, transcript, "direct_assistant_output"),
    ).toMatchObject({ reason: "provider_capacity_exceeded" });
  });

  it("prompt エコーの cwd に capacity があっても通常出力の末尾からは分類しない", () => {
    const transcript = [
      "user",
      "タスク本文",
      "cwd: /tmp/hk-reviewer-capacity",
      "codex",
      "正常な作業ログ".repeat(100),
    ].join("\n");

    expect(classifyExecutionFailure({}, transcript, "direct_assistant_output")).toBeNull();
  });

  it("direct assistant-only output の provider 診断を分類する", () => {
    expect(
      classifyExecutionFailure({}, "usage-limit reached", "direct_assistant_output"),
    ).toMatchObject({ reason: "provider_capacity_exceeded" });
  });

  it("raw/lastResult 未提供で通常テキスト transcript は分類しない（fence 抽出へ委任）", () => {
    expect(
      classifyExecutionFailure({}, "作業完了しました", "direct_assistant_output"),
    ).toBeNull();
  });

  it("lastResult に turns>0 がある場合は transcript 内容に関わらず分類しない", () => {
    expect(
      classifyExecutionFailure(
        { lastResult: { turns: 1, inputTokens: 100, outputTokens: 50 } },
        "command not found",
        "bridge_transcript",
      ),
    ).toBeNull();
  });

  it.each([
    ["user", "[user] usage-limit reached"],
    ["tool", "[tool] codex: command not found"],
    ["role 不明", "usage-limit reached"],
  ])("bridge の %s failure 文言を provider/CLI 分類しない", (_label, transcript) => {
    const classified = classifyExecutionFailure(
      { lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 } },
      transcript,
      "bridge_transcript",
    );
    expect(classified?.reason).not.toBe("provider_capacity_exceeded");
    expect(classified?.reason).not.toBe("cli_startup_failed");
  });

  it("bridge の flattened assistant marker は診断に使わず extraction_failed へ倒す", () => {
    expect(
      classifyExecutionFailure(
        { lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 } },
        "[user] 本文\n[assistant] usage-limit reached\n[assistant] codex: command not found",
        "bridge_transcript",
      ),
    ).toMatchObject({ reason: "extraction_failed" });
  });

  it("0-token + direct assistant-only の未知文言は worker_output_missing に分類する", () => {
    expect(
      classifyExecutionFailure(
        { lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 } },
        "未知の理由で終了しました",
        "direct_assistant_output",
      ),
    ).toMatchObject({ reason: "worker_output_missing" });
  });

  it("transport/source が不明なら transcript の failure 文言を診断 fallback に使わない", () => {
    expect(classifyExecutionFailure({}, "usage-limit reached", "unknown")).toBeNull();
  });
});
