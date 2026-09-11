import { describe, expect, it } from "vitest";
import type { TaskRow } from "@hachi/core";
import { extractAssistantFence, isHandoffSchema } from "./fence-extraction.js";
import { buildReviewPrompt, buildReworkPrompt, buildWorkerPrompt } from "./prompt.js";

function fakeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_00000001",
    title: "サンプルタスク",
    body: "本文です",
    status: "ready",
    priority: 0,
    tenant: "dev",
    assignee: "",
    provider: "",
    profile: "",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 3,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

describe("buildWorkerPrompt", () => {
  it("title/body/taskId/model を含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");
    expect(prompt).toContain("サンプルタスク");
    expect(prompt).toContain("本文です");
    expect(prompt).toContain("t_00000001");
    expect(prompt).toContain("gpt-5.4");
  });

  it("hachi-handoff-v1 フェンスの出力指示を含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");
    expect(prompt).toContain("```hachi-handoff-v1");
    expect(prompt).toContain('"taskId"');
    expect(prompt).toContain('"outcome"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain("done");
    expect(prompt).toContain("review");
  });

  it("同一 taskId の valid fence を body に含む prompt エコーだけでは handoff 候補にならない", () => {
    const task = fakeTask();
    const bodyHandoff = `\`\`\`hachi-handoff-v1\n{"taskId":"${task.id}","outcome":"review","summary":"body 内の例示"}\n\`\`\``;
    const prompt = buildWorkerPrompt(fakeTask({ body: bodyHandoff }), "gpt-5.4");
    const extracted = extractAssistantFence({
      transcript: prompt,
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    // fence 自体は存在する（missing ではない）が JSON 非妥当なので parse_invalid に倒れること
    expect(extracted).toMatchObject({ kind: "failure", reason: "parse_invalid" });
  });

  it("prompt エコーの後ろに worker の妥当な handoff があれば候補として抽出される", () => {
    const task = fakeTask();
    const prompt = buildWorkerPrompt(task, "gpt-5.4");
    const handoff = `{"taskId": "${task.id}", "outcome": "review", "summary": "実装した"}`;
    const transcript = `${prompt}\n\n作業が完了しました。\n\n\`\`\`hachi-handoff-v1\n${handoff}\n\`\`\`\n`;
    const extracted = extractAssistantFence({
      transcript,
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(extracted).toMatchObject({ kind: "candidate", source: "assistant_output" });
    if (extracted.kind !== "candidate") {
      throw new Error("candidate ではありません");
    }
    expect(JSON.parse(extracted.raw)).toEqual({
      taskId: task.id,
      outcome: "review",
      summary: "実装した",
    });
  });

  it("仕様不足時は outcome=question で質問する手順を含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");
    expect(prompt).toContain('outcome="question"');
    expect(prompt).toContain("推測で進めず");
    expect(prompt).toContain("回答は再起動時の body 冒頭に届きます");
    expect(prompt).toContain("質問して終了してください");
  });

  it("bridge transport では質問後に同一セッションへ回答注入される待機手順を含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4", [], { transport: "bridge" });
    expect(prompt).toContain("このセッションへ回答が注入されます");
    expect(prompt).toContain("grace 内は待機");
    expect(prompt).toContain("再起動時の body 冒頭へ届きます");
    expect(prompt).not.toContain("質問して終了してください");
  });

  it("成果物の画像添付案内を本文の後に含み taskId をコマンドへ埋め込む", () => {
    const prompt = buildWorkerPrompt(fakeTask({ id: "t_attach_worker" }), "gpt-5.4");
    const bodyIndex = prompt.indexOf("本文です");
    const sectionIndex = prompt.indexOf("## 成果物の画像添付（任意）");
    const handoffIndex = prompt.indexOf("完了時は、出力の最後に必ず");

    expect(sectionIndex).toBeGreaterThan(bodyIndex);
    expect(sectionIndex).toBeLessThan(handoffIndex);
    expect(prompt).toContain(
      "cd <repo>/packages/cli && pnpm run --silent hachi task attach t_attach_worker --file <path> --name <名前>",
    );
    expect(prompt).toContain("作業ディレクトリ直下に `ui-*.png`");
    expect(prompt).toContain("撮れない/不要なら省略");
  });

  it("worker/rework prompt に成果物の許可された置き場を明記する", () => {
    const expected =
      "成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される";

    expect(buildWorkerPrompt(fakeTask(), "gpt-5.4")).toContain(expected);
    expect(buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", [], 1)).toContain(expected);
  });

  it("shootd の localhost curl は昇格実行で行うよう案内する", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");

    expect(prompt).toContain("shootd（127.0.0.1:7331）");
    expect(prompt).toContain("curl は外部実行権限（sandbox_permissions=require_escalated）");
    expect(prompt).toContain("Operation not permitted");
  });

  it("live config.json の変更禁止を本文の後に含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");
    const bodyIndex = prompt.indexOf("本文です");
    const noticeIndex = prompt.indexOf("$HACHI_KANBAN_HOME/config.json");
    const sectionIndex = prompt.indexOf("## 成果物の画像添付（任意）");

    expect(noticeIndex).toBeGreaterThan(bodyIndex);
    expect(noticeIndex).toBeLessThan(sectionIndex);
    expect(prompt).toContain("変更権限は orchestrator/人間のみ");
  });

  it("spawn 失敗時は直列化より報告を優先する運用文言を含む", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");

    expect(prompt).toContain("ハングした子プロセスは supervisor");
    expect(prompt).toContain("os error 35");
    expect(prompt).toContain("まず handoff/コメントで報告");
  });

  it("shared main DB fallback と worker cleanup 権限を明示的に禁止する", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4");

    expect(prompt).toContain("## Runtime resource policy（必須）");
    expect(prompt).toContain("runtime manifest / resource lease: 割当なし");
    expect(prompt).toContain("`localhost:5432`");
    expect(prompt).toContain("shared main DB へ変更する自動 fallback は禁止");
    expect(prompt).toContain("専用 database/schema/role");
    expect(prompt).toContain("migration/drop/truncate を伴う例外は拒否");
    expect(prompt).toContain("専用 container/volume");
    expect(prompt).toContain("ephemeral port");
    expect(prompt).toContain("orchestrator cleanup request");
    expect(prompt).toContain("lease heartbeat/renew/release");
    expect(prompt).toContain("`docker compose down -v`");
  });

  it("task/run scope の runtime manifest と lease 参照だけを prompt へ渡す", () => {
    const prompt = buildWorkerPrompt(fakeTask({ id: "t_runtime" }), "gpt-5.4", [], {
      transport: "direct",
      runtimeResources: {
        manifestPath: "/var/lib/hachi/runtime manifests/t_runtime/run-42.json",
        ownerRunId: 42,
        leases: [
          { leaseId: "lease_pg_01", bundleKind: "worktree_postgres", fence: 7 },
          { leaseId: "lease_preview_01", bundleKind: "worktree_preview", fence: 3 },
        ],
      },
    });

    expect(prompt).toContain("scope: task=t_runtime, run=42");
    expect(prompt).toContain("runtime manifest: `/var/lib/hachi/runtime manifests/t_runtime/run-42.json`");
    expect(prompt).toContain("id=lease_pg_01 kind=worktree_postgres fence=7");
    expect(prompt).toContain("id=lease_preview_01 kind=worktree_preview fence=3");
    expect(prompt).toContain("credential を prompt・artifact・comment・ログへ転記しない");
  });

  it("runtime resource 参照が空または不正なら fail-closed で拒否する", () => {
    expect(() =>
      buildWorkerPrompt(fakeTask(), "gpt-5.4", [], {
        transport: "direct",
        runtimeResources: {},
      }),
    ).toThrow("manifestPath または lease 参照");
    expect(() =>
      buildWorkerPrompt(fakeTask(), "gpt-5.4", [], {
        transport: "direct",
        runtimeResources: { manifestPath: "relative/manifest.json" },
      }),
    ).toThrow("絶対パス");
    expect(() =>
      buildWorkerPrompt(fakeTask(), "gpt-5.4", [], {
        transport: "direct",
        runtimeResources: {
          leases: [{ leaseId: "lease_pg", bundleKind: "worktree_postgres", fence: 0 }],
        },
      }),
    ).toThrow("fence は正の整数");
  });

  it("lesson が0件の場合は過去の教訓節を出さない", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4", []);
    expect(prompt).not.toContain("## 過去の教訓");
  });

  it("lesson がある場合は過去の教訓節として本文後に注入する", () => {
    const prompt = buildWorkerPrompt(fakeTask(), "gpt-5.4", [
      {
        trigger: "rework",
        body: "レビュー fail では境界条件を先に確認する",
        sourceTaskId: "t_prev",
        cwd: "/repo/app",
        profile: "implement",
      },
    ]);
    const bodyIndex = prompt.indexOf("本文です");
    const lessonsIndex = prompt.indexOf("## 過去の教訓");
    const attachmentIndex = prompt.indexOf("## 成果物の画像添付（任意）");

    expect(lessonsIndex).toBeGreaterThan(bodyIndex);
    expect(lessonsIndex).toBeLessThan(attachmentIndex);
    expect(prompt).toContain("1. [rework] レビュー fail では境界条件を先に確認する");
    expect(prompt).toContain("source=t_prev");
    expect(prompt).toContain("cwd=/repo/app");
    expect(prompt).toContain("profile=implement");
  });

  it("先頭行は title 識別子で始まり # タスク: で始まらない", () => {
    const prompt = buildWorkerPrompt(fakeTask({ title: "識別できるタスク" }), "gpt-5.4");
    expect(firstLine(prompt)).toBe("▶ 識別できるタスク  〔t_00000001〕");
    expect(firstLine(prompt).startsWith("# タスク:")).toBe(false);
  });

  it("先頭行の title は改行と制御文字を1行に畳む", () => {
    const title = `前半\n後半\t${String.fromCharCode(0)}中間${String.fromCharCode(0x9f)}末尾`;
    const prompt = buildWorkerPrompt(fakeTask({ title }), "gpt-5.4");
    expect(firstLine(prompt)).toBe("▶ 前半 後半 中間 末尾  〔t_00000001〕");
    expect(firstLine(prompt)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });
});

describe("buildReviewPrompt（docs/contract.md §15.1）", () => {
  it("title/body/taskId/model/worker summary/change overview を含む", () => {
    const prompt = buildReviewPrompt(
      fakeTask(),
      "gpt-5.5",
      "実装完了しました",
      "## BASE\nabc123 (origin/main)\n\n## status\n M packages/app.ts",
    );
    expect(prompt).toContain("サンプルタスク");
    expect(prompt).toContain("本文です");
    expect(prompt).toContain("t_00000001");
    expect(prompt).toContain("gpt-5.5");
    expect(prompt).toContain("実装完了しました");
    expect(prompt).toContain("## 変更俯瞰（索引）");
    expect(prompt).toContain("abc123 (origin/main)");
    expect(prompt).toContain("M packages/app.ts");
    expect(prompt).not.toContain("ワーカーセッションの直近ログ");
  });

  it("hachi-verdict-v1 フェンスの出力指示を含む", () => {
    const prompt = buildReviewPrompt(fakeTask(), "gpt-5.5", "要約", "変更俯瞰");
    expect(prompt).toContain("```hachi-verdict-v1");
    expect(prompt).toContain('"taskId"');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain('"failureCause"');
    expect(prompt).toContain("worker_local");
    expect(prompt).toContain("worker_major");
    expect(prompt).toContain("spec_ambiguity");
    expect(prompt).toContain("environment_evidence");
    expect(prompt).toContain("late_requirement_change");
    expect(prompt).toContain("複数原因が混在");
    expect(prompt).toContain("読み取り専用");
  });

  it("reviewer が cwd で full diff と untracked 内容を自分で取得する必須手順を含む", () => {
    const prompt = buildReviewPrompt(fakeTask(), "gpt-5.5", "要約", "変更俯瞰");

    expect(prompt).toContain("## レビュー手順（必須）");
    expect(prompt).toContain("上の俯瞰は索引");
    expect(prompt).toContain("`git --no-pager diff <BASE>`");
    expect(prompt).toContain("committed+tracked の最終差分");
    expect(prompt).toContain("`git --no-pager diff --no-index -- /dev/null <path>`");
    expect(prompt).toContain("binary は存在/サイズ/用途を確認");
    expect(prompt).toContain("git diff が取得できない場合は pass/high の verdict を出さない");
  });

  it("成果物の画像添付案内を含まない", () => {
    const prompt = buildReviewPrompt(fakeTask({ id: "t_review_readonly" }), "gpt-5.5", "要約", "変更俯瞰");
    expect(prompt).not.toContain("## 成果物の画像添付（任意）");
    expect(prompt).not.toContain("task attach t_review_readonly");
    expect(prompt).not.toContain("ui-*.png");
  });

  it("先頭行は review marker と title/taskId を含む", () => {
    const prompt = buildReviewPrompt(fakeTask(), "gpt-5.5", "要約", "変更俯瞰");
    expect(firstLine(prompt)).toBe("🔍 review: サンプルタスク  〔t_00000001〕");
    expect(firstLine(prompt).startsWith("# レビュー対象タスク:")).toBe(false);
  });
});

describe("buildReworkPrompt（docs/contract.md §21.2）", () => {
  it("先頭行は attempt 付き rework marker と title/taskId を含む", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", ["修正してください"], 2);
    expect(firstLine(prompt)).toBe("🔁 rework(2): サンプルタスク  〔t_00000001〕");
    expect(firstLine(prompt).startsWith("# タスク")).toBe(false);
  });

  it("attempt が無い場合は番号を省略する", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", []);
    expect(firstLine(prompt)).toBe("🔁 rework: サンプルタスク  〔t_00000001〕");
  });

  it("hachi-handoff-v1 フェンスは outcome=review のまま維持する", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", ["修正してください"], 1);
    expect(prompt).toContain("```hachi-handoff-v1");
    expect(prompt).toContain('"outcome": "review"');
    expect(prompt).toContain('outcome は必ず "review"');
  });

  it("同一 taskId の valid fence を body に含む rework prompt エコーだけでは handoff 候補にならない", () => {
    const task = fakeTask();
    const bodyHandoff = `\`\`\`hachi-handoff-v1\n{"taskId":"${task.id}","outcome":"review","summary":"body 内の例示"}\n\`\`\``;
    const prompt = buildReworkPrompt(
      fakeTask({ body: bodyHandoff }),
      "gpt-5.4",
      "指摘があります",
      ["修正してください"],
      1,
    );
    const extracted = extractAssistantFence({
      transcript: prompt,
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    // fence 自体は存在する（missing ではない）が JSON 非妥当なので parse_invalid に倒れること
    expect(extracted).toMatchObject({ kind: "failure", reason: "parse_invalid" });
  });

  it("rework prompt エコーの後ろに worker の妥当な handoff があれば候補として抽出される", () => {
    const task = fakeTask();
    const prompt = buildReworkPrompt(task, "gpt-5.4", "指摘があります", ["修正してください"], 1);
    const handoff = `{"taskId": "${task.id}", "outcome": "review", "summary": "指摘を修正した"}`;
    const transcript = `${prompt}\n\n修正が完了しました。\n\n\`\`\`hachi-handoff-v1\n${handoff}\n\`\`\`\n`;
    const extracted = extractAssistantFence({
      transcript,
      assistantOnlyOutput: true,
      spec: { label: "hachi-handoff-v1", isSchemaValid: isHandoffSchema },
    });

    expect(extracted).toMatchObject({ kind: "candidate", source: "assistant_output" });
    if (extracted.kind !== "candidate") {
      throw new Error("candidate ではありません");
    }
    expect(JSON.parse(extracted.raw)).toEqual({
      taskId: task.id,
      outcome: "review",
      summary: "指摘を修正した",
    });
  });

  it("rework でも仕様不足時は outcome=question で質問する手順を含む", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", ["修正してください"], 1);
    expect(prompt).toContain('outcome="question"');
    expect(prompt).toContain("推測で進めず");
    expect(prompt).toContain("回答は再起動時の body 冒頭に届きます");
  });

  it("rework でも runtime resource policy と cleanup 権限禁止を継承する", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", ["修正してください"], 1);

    expect(prompt).toContain("## Runtime resource policy（必須）");
    expect(prompt).toContain("runtime manifest / resource lease: 割当なし");
    expect(prompt).toContain("shared main DB へ変更する自動 fallback は禁止");
    expect(prompt).toContain("`shared_main_db_exception` lease");
    expect(prompt).toContain("migration/drop/truncate を伴う例外は拒否");
    expect(prompt).toContain("専用 container/volume");
    expect(prompt).toContain("orchestrator cleanup request");
    expect(prompt).toContain("cleanup approve/apply");
    expect(prompt).toContain("`docker compose down -v`");
  });

  it("rework でも解決済み runtime lease 参照を引き継ぐ", () => {
    const prompt = buildReworkPrompt(fakeTask({ id: "t_rework_runtime" }), "gpt-5.4", "指摘があります", [], 1, {
      transport: "bridge",
      runtimeResources: {
        leases: [{ leaseId: "lease_rework_pg", bundleKind: "worktree_postgres", fence: 9 }],
      },
    });

    expect(prompt).toContain("scope: task=t_rework_runtime");
    expect(prompt).toContain("id=lease_rework_pg kind=worktree_postgres fence=9");
    expect(prompt).not.toContain("runtime manifest / resource lease: 割当なし");
  });

  it("成果物の画像添付案内を本文の後に含み taskId をコマンドへ埋め込む", () => {
    const prompt = buildReworkPrompt(fakeTask({ id: "t_attach_rework" }), "gpt-5.4", "指摘があります", [], 1);
    const bodyIndex = prompt.indexOf("本文です");
    const sectionIndex = prompt.indexOf("## 成果物の画像添付（任意）");
    const reviewIssueIndex = prompt.indexOf("## 前回作業のレビュー指摘");

    expect(sectionIndex).toBeGreaterThan(bodyIndex);
    expect(sectionIndex).toBeLessThan(reviewIssueIndex);
    expect(prompt).toContain(
      "cd <repo>/packages/cli && pnpm run --silent hachi task attach t_attach_rework --file <path> --name <名前>",
    );
    expect(prompt).toContain("作業ディレクトリ直下に `ui-*.png`");
    expect(prompt).toContain("撮れない/不要なら省略");
  });

  it("shootd の localhost curl は昇格実行で行うよう案内する", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", [], 1);

    expect(prompt).toContain("shootd（127.0.0.1:7331）");
    expect(prompt).toContain("curl は外部実行権限（sandbox_permissions=require_escalated）");
    expect(prompt).toContain("Operation not permitted");
  });

  it("live config.json の変更禁止を本文の後に含む", () => {
    const prompt = buildReworkPrompt(fakeTask(), "gpt-5.4", "指摘があります", [], 1);
    const bodyIndex = prompt.indexOf("本文です");
    const noticeIndex = prompt.indexOf("$HACHI_KANBAN_HOME/config.json");
    const reviewIssueIndex = prompt.indexOf("## 前回作業のレビュー指摘");

    expect(noticeIndex).toBeGreaterThan(bodyIndex);
    expect(noticeIndex).toBeLessThan(reviewIssueIndex);
    expect(prompt).toContain("変更権限は orchestrator/人間のみ");
  });
});
