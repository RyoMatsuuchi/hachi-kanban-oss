// ネイティブログ parser の固定テスト。
// fixture は本機の実ログ（~/.claude/projects/**.jsonl / ~/.codex/sessions/**/rollout-*.jsonl）から
// 取った実形状を縮小したもので、キー名・入れ子・重複の出方まで実物に合わせている。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectClaudeNativeUsage,
  collectCodexNativeUsage,
  findClaudeSessionDir,
  findCodexRollout,
  isPathWithinRoot,
  isValidNativeSessionId,
  parseCodexSessionId,
} from "./native-usage.js";

const SESSION_ID = "199a85b5-5975-4998-8dc0-9f4d4d29508c";

function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

/** claude transcript の assistant 行（実物と同じ入れ子・キー名）。 */
function claudeAssistant(opts: {
  requestId: string | null;
  messageId: string;
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  timestamp: string;
  /** cache_creation の 5m/1h 内訳。省略時は実ログ同様に全量を 5m とする。 */
  cacheCreation1h?: number;
  /** `usage.iterations`。advisor が挟まる応答では実ログにこの配列が出る。 */
  iterations?: readonly Record<string, unknown>[];
  /** advisor のモデル。実ログでは message の中ではなく**行の直下**に出る。 */
  advisorModel?: string;
  /** サブエージェントの応答が親ファイルへ書かれた行。実ログでは `isSidechain: true` になる。 */
  sidechain?: boolean;
  /** assistant 行 top-level の実測 effort。 */
  effort?: unknown;
  /** usage.output_tokens_details.thinking_tokens。output の内数。 */
  thinking?: number;
}): Record<string, unknown> {
  const oneHour = opts.cacheCreation1h ?? 0;
  return {
    parentUuid: null,
    isSidechain: opts.sidechain === true,
    type: "assistant",
    uuid: `uuid-${opts.messageId}-${opts.output}`,
    timestamp: opts.timestamp,
    ...(opts.requestId !== null ? { requestId: opts.requestId } : {}),
    ...(opts.advisorModel !== undefined ? { advisorModel: opts.advisorModel } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    message: {
      id: opts.messageId,
      model: opts.model,
      usage: {
        input_tokens: opts.input,
        cache_creation_input_tokens: opts.cacheCreation,
        cache_read_input_tokens: opts.cacheRead,
        output_tokens: opts.output,
        ...(opts.thinking !== undefined ? { output_tokens_details: { thinking_tokens: opts.thinking } } : {}),
        // 実ログの内訳オブジェクト。5m/1h は単価が異なる（1h は input の 2倍）。
        cache_creation: {
          ephemeral_5m_input_tokens: opts.cacheCreation - oneHour,
          ephemeral_1h_input_tokens: oneHour,
        },
        // 実ログに同居する非トークン項目。allowlist 抽出されて無視されること。
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        inference_geo: "not_available",
        ...(opts.iterations !== undefined ? { iterations: opts.iterations } : {}),
      },
    },
  };
}

/** `usage.iterations[]` の1要素（実物と同じキー名・並び。種別は文字列でそのまま出る）。 */
function claudeIteration(opts: {
  type: string;
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
  cacheCreation1h?: number;
  /** message 以外の iteration は実ログでは自分の model を持つ。 */
  model?: string;
}): Record<string, unknown> {
  const cacheCreation = opts.cacheCreation ?? 0;
  const oneHour = opts.cacheCreation1h ?? 0;
  return {
    input_tokens: opts.input,
    output_tokens: opts.output,
    cache_read_input_tokens: opts.cacheRead ?? 0,
    cache_creation_input_tokens: cacheCreation,
    cache_creation: {
      ephemeral_5m_input_tokens: cacheCreation - oneHour,
      ephemeral_1h_input_tokens: oneHour,
    },
    type: opts.type,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  };
}

/** codex rollout の token_count イベント（total_token_usage は累積値）。 */
function codexTokenCount(opts: {
  timestamp: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
  /**
   * context window サイズ（実ログ例: docs/plans/direct-run-usage-cost-audit.md）。
   * 省略時は実ログ同様 258,400 を報告する。null を渡すとキー自体を省略する
   * （provider がこのフィールドを報告しない場合の再現）。
   */
  modelContextWindow?: number | null;
}): Record<string, unknown> {
  const modelContextWindow = opts.modelContextWindow === undefined ? 258_400 : opts.modelContextWindow;
  return {
    timestamp: opts.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: opts.input,
          cached_input_tokens: opts.cached,
          cache_write_input_tokens: opts.cacheWrite,
          output_tokens: opts.output,
          ...(opts.reasoning === undefined ? {} : { reasoning_output_tokens: opts.reasoning }),
          total_tokens: opts.input + opts.output,
        },
        last_token_usage: { input_tokens: opts.input, output_tokens: opts.output },
        ...(modelContextWindow !== null ? { model_context_window: modelContextWindow } : {}),
      },
      // アカウント面データ。RunUsage へ漏れてはいけない。
      rate_limits: { plan_type: "pro", credits: { has_credits: false, balance: "0" } },
    },
  };
}

describe("collectClaudeNativeUsage", () => {
  let root: string;
  let projectsRoot: string;
  let projectDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-claude-usage-"));
    projectsRoot = join(root, "projects");
    projectDir = join(projectsRoot, "-Users-someone-worktrees-example");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("assistant 行の effort と thinking 内数を mainSession の turn・集計へ載せる", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_effort",
        messageId: "msg_effort",
        model: "claude-opus-5",
        input: 10,
        output: 100,
        cacheCreation: 20,
        cacheRead: 30,
        effort: "high",
        thinking: 40,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect(observation.mainSession.contextEffort).toBe("high");
    expect(observation.mainSession.perModel[0]?.reasoningOutputTokens).toBe(40);
    expect(observation.mainSession.perExecution).toEqual([
      {
        provider: "claude",
        model: "claude-opus-5",
        effort: "high",
        turns: 1,
        inputTokens: 10,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        cacheCreationTokens: 20,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 30,
      },
    ]);
    expect(observation.mainSession.turnSeries[0]).toMatchObject({
      provider: "claude",
      model: "claude-opus-5",
      effort: "high",
      contextTokens: 60,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    });
  });

  it("語彙外 effort は既定値へ寄せず null として保持する", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_invalid_effort",
        messageId: "msg_invalid_effort",
        model: "claude-opus-5",
        input: 1,
        output: 2,
        cacheCreation: 0,
        cacheRead: 3,
        effort: "HIGH",
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect("contextEffort" in observation.mainSession).toBe(false);
    expect(observation.mainSession.perExecution[0]?.effort).toBeNull();
    expect(observation.mainSession.turnSeries[0]?.effort).toBeNull();
  });

  it("4系統すべてを拾い、cache read を落とさない", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      { type: "queue-operation", operation: "enqueue" },
      claudeAssistant({
        requestId: "req_1",
        messageId: "msg_1",
        model: "claude-sonnet-5",
        input: 2,
        output: 7588,
        cacheCreation: 1895,
        cacheRead: 144970,
      timestamp: "2026-08-19T14:49:41.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    expect(observation).toEqual({
      observed: true,
      turns: 1,
      durationMs: 0,
      perModel: [
        {
          model: "claude-sonnet-5",
          inputTokens: 2,
          outputTokens: 7588,
          cacheCreationTokens: 1895,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 144970,
        },
      ],
      // 親セッションだけの内訳。入力側は input + cacheCreation + cacheRead = 146,867。
      // サブエージェントが無いので perModel は観測レベルの内訳とそのまま一致する。
      mainSession: {
        turns: 1,
        inputTokens: 146_867,
        contextTokens: 146_867,
        contextModel: "claude-sonnet-5",
        elapsedMs: 0,
        perModel: [
          {
            model: "claude-sonnet-5",
            inputTokens: 2,
            outputTokens: 7588,
            cacheCreationTokens: 1895,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 144970,
          },
        ],
        perExecution: [
          {
            provider: "claude",
            model: "claude-sonnet-5",
            effort: null,
            turns: 1,
            inputTokens: 2,
            outputTokens: 7588,
            cacheCreationTokens: 1895,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 144970,
          },
        ],
        turnSeries: [
          {
            provider: "claude",
            model: "claude-sonnet-5",
            effort: null,
            contextTokens: 146_867,
            inputTokens: 2,
            outputTokens: 7588,
            cacheCreationTokens: 1895,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 144970,
            timestampMs: Date.parse("2026-08-19T14:49:41.000Z"),
          },
        ],
      },
    });
  });

  it("ストリーミング途中経過の行があっても最終値を採り、二重計上もしない", async () => {
    // 実ログ形状（本機 199a85b5 セッションから採取）: 1応答が複数行に分かれ、
    // output_tokens だけが途中経過として増加し最終行が確定値。input/cache は不変。
    // first-wins だと 5 を採って 226 を捨て、dedup 無しだと 241 を二重計上する。
    const partial = (output: number): Record<string, unknown> =>
      claudeAssistant({
        requestId: "req_dup",
        messageId: "msg_dup",
        model: "claude-sonnet-5",
        input: 2,
        output,
        cacheCreation: 27933,
        cacheRead: 33982,
        timestamp: "2026-08-19T14:50:00.000Z",
      });
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      partial(5),
      partial(5),
      partial(231),
      // 別グループ。合算されること（グループ単位の集計が効いているかの対照）。
      claudeAssistant({
        requestId: "req_second",
        messageId: "msg_second",
        model: "claude-sonnet-5",
        input: 3,
        output: 40,
        cacheCreation: 0,
        cacheRead: 11,
        timestamp: "2026-08-19T14:51:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(2);
    expect(observation.perModel).toEqual([
      {
        model: "claude-sonnet-5",
        inputTokens: 5,
        // 231（最終値）＋40。途中経過の 5 を採らず、5+5+231 の二重計上もしない。
        outputTokens: 271,
        cacheCreationTokens: 27933,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 33993,
      },
    ]);
  });

  it("0トークンの合成行（<synthetic>）を集計・モデル一覧から除外する", async () => {
    // セッション上限・ログイン切れで Claude Code が書く行。本機に 25 行/17 セッション実在し、
    // 全項目 0。これを数えると models と unpricedModels が汚染され、run 全体の cost が落ちる。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_real",
        messageId: "msg_real",
        model: "claude-opus-5",
        input: 10,
        output: 20,
        cacheCreation: 30,
        cacheRead: 40,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
      claudeAssistant({
        requestId: "req_synth",
        messageId: "msg_synth",
        model: "<synthetic>",
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:05:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
    expect(observation.perModel.map((u) => u.model)).toEqual(["claude-opus-5"]);
  });

  it("合成行しか無いセッションは no-usage-records（偽ゼロを measured にしない）", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_synth",
        messageId: "msg_synth",
        model: "<synthetic>",
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:05:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    expect(observation).toEqual({ observed: false, reason: "no-usage-records" });
  });

  it("cache_creation の 1h 内訳を保持する（1h は 5m より単価が高い）", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_1h",
        messageId: "msg_1h",
        model: "claude-opus-5",
        input: 1,
        output: 2,
        cacheCreation: 1000,
        cacheCreation1h: 400,
        cacheRead: 0,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // 合計は従来どおり flat。1h はその内数として別に持つ。
    expect(observation.perModel[0]?.cacheCreationTokens).toBe(1000);
    expect(observation.perModel[0]?.cacheCreation1hTokens).toBe(400);
  });

  it("内訳が合計と一致しない行は内訳を信用せず全量を 5m として扱う", async () => {
    // 本機の実ログに 694 行実在する。内訳を採ると取りこぼすので flat 合計を正とする。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      {
        type: "assistant",
        uuid: "u_mismatch",
        requestId: "req_mismatch",
        timestamp: "2026-08-19T14:00:00.000Z",
        message: {
          id: "msg_mismatch",
          model: "claude-opus-5",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 900,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 },
          },
        },
      },
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel[0]?.cacheCreationTokens).toBe(900);
    expect(observation.perModel[0]?.cacheCreation1hTokens).toBe(0);
  });

  it("advisor_message の iteration を落とさず advisorModel へ按分する", async () => {
    // 実ログ形状。top-level usage は `type === "message"` の iteration 合計に等しく、
    // 間に挟まる advisor_message の分を**含まない**（実測: top input 4 / output 1495 =
    // it0(2/205) + it2(2/1290)。advisor の input 88,249 / output 9,428 は不算入）。
    // top-level だけを読むと本機の実測で input が桁で狂った（91 セッションで欠落 9,216,403）。
    const iterations = [
      claudeIteration({ type: "message", input: 2, output: 205, cacheCreation: 4017, cacheCreation1h: 4017, cacheRead: 120027 }),
      // advisor は別モデル（行の advisorModel）で走るので message.model へ足してはいけない。
      claudeIteration({ type: "advisor_message", input: 88249, output: 9428, model: "claude-opus-5" }),
      claudeIteration({ type: "message", input: 2, output: 1290, cacheCreation: 2597, cacheRead: 124044 }),
    ];
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      // 同一グループのストリーミング途中経過。advisor 分を二重計上しないこと。
      claudeAssistant({
        requestId: "req_advisor",
        messageId: "msg_advisor",
        model: "claude-sonnet-5",
        advisorModel: "claude-opus-5",
        input: 2,
        output: 205,
        cacheCreation: 4017,
        cacheCreation1h: 4017,
        cacheRead: 120027,
        timestamp: "2026-08-19T15:00:00.000Z",
        iterations: iterations.slice(0, 2),
      }),
      claudeAssistant({
        requestId: "req_advisor",
        messageId: "msg_advisor",
        model: "claude-sonnet-5",
        advisorModel: "claude-opus-5",
        input: 4,
        output: 1495,
        cacheCreation: 6614,
        // 実ログの top-level 内訳は iteration の一部しか反映しておらず合計と一致しないことがある。
        // iteration ごとの内訳は自己整合しているので、合算すると 1h（4017）も正しく残る。
        cacheCreation1h: 4017,
        cacheRead: 244071,
        timestamp: "2026-08-19T15:00:10.000Z",
        iterations,
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
    expect(observation.perModel).toEqual([
      {
        // advisor 分は message.model には入らない。
        model: "claude-opus-5",
        inputTokens: 88249,
        outputTokens: 9428,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
      {
        model: "claude-sonnet-5",
        inputTokens: 4,
        outputTokens: 1495,
        cacheCreationTokens: 6614,
        cacheCreation1hTokens: 4017,
        cacheReadTokens: 244071,
      },
    ]);
  });

  it("message だけの iterations を持つ行は top-level と同値になる（合算で二重にしない）", async () => {
    // 非回帰。実ログの大半（本機 48,242 行中 47,491 行）はこの形で、合計が top-level と一致する。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_msg_only",
        messageId: "msg_msg_only",
        model: "claude-sonnet-5",
        input: 4,
        output: 1495,
        cacheCreation: 6614,
        cacheRead: 244071,
        timestamp: "2026-08-19T15:10:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 205, cacheCreation: 4017, cacheRead: 120027 }),
          claudeIteration({ type: "message", input: 2, output: 1290, cacheCreation: 2597, cacheRead: 124044 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
    expect(observation.perModel).toEqual([
      {
        model: "claude-sonnet-5",
        inputTokens: 4,
        outputTokens: 1495,
        cacheCreationTokens: 6614,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 244071,
      },
    ]);
  });

  it("未知の iteration 種別でも落とさず advisorModel へ按分する（種別のホワイトリストを持たない）", async () => {
    // 種別を列挙して足すと、新しい種別が増えた瞬間に advisor と同じ落とし方が再発する。
    // 実ログに現れていない種別名でも合算されることを固定する。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_future",
        messageId: "msg_future",
        model: "claude-sonnet-5",
        advisorModel: "claude-opus-5",
        input: 2,
        output: 10,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T15:20:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 10 }),
          claudeIteration({ type: "some_future_message", input: 5000, output: 700, cacheRead: 33 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel).toEqual([
      {
        model: "claude-opus-5",
        inputTokens: 5000,
        outputTokens: 700,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 33,
      },
      {
        model: "claude-sonnet-5",
        inputTokens: 2,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
    ]);
  });

  it("advisorModel が無ければ iteration 自身の model へ按分する（unknown へ倒さない）", async () => {
    // 価格表に無い "unknown" を作ると、その run 全体の cost が unavailable へ落ちる。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_no_advisor_model",
        messageId: "msg_no_advisor_model",
        model: "claude-sonnet-5",
        input: 2,
        output: 10,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T15:30:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 10 }),
          claudeIteration({ type: "advisor_message", input: 40, output: 3, model: "claude-opus-5" }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel.map((m) => m.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(observation.perModel[0]?.inputTokens).toBe(40);
  });

  it("iterations が空配列の行は top-level を使う（空を合算して実トークンを捨てない）", async () => {
    // 本機の実ログに 1 行実在する（top は input 2 / output 3 / cache read 98,511 なのに iterations が空）。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_empty_iterations",
        messageId: "msg_empty_iterations",
        model: "claude-fable-5",
        input: 2,
        output: 3,
        cacheCreation: 802,
        cacheRead: 98511,
        timestamp: "2026-08-19T15:40:00.000Z",
        iterations: [],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel).toEqual([
      {
        model: "claude-fable-5",
        inputTokens: 2,
        outputTokens: 3,
        cacheCreationTokens: 802,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 98511,
      },
    ]);
  });

  it("サブエージェント配下を全ファイル合算し、モデル別に内訳を保つ", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_parent",
        messageId: "msg_parent",
        model: "claude-opus-5",
        input: 10,
        output: 20,
        cacheCreation: 30,
        cacheRead: 40,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);
    const subagents = join(projectDir, SESSION_ID, "subagents");
    writeJsonl(join(subagents, "agent-aaa.jsonl"), [
      claudeAssistant({
        requestId: "req_a",
        messageId: "msg_a",
        model: "claude-sonnet-5",
        input: 1,
        output: 2,
        cacheCreation: 3,
        cacheRead: 4,
        timestamp: "2026-08-19T14:10:00.000Z",
      }),
    ]);
    writeJsonl(join(subagents, "agent-bbb.jsonl"), [
      claudeAssistant({
        requestId: "req_b",
        messageId: "msg_b",
        model: "claude-sonnet-5",
        input: 5,
        output: 6,
        cacheCreation: 7,
        cacheRead: 8,
        timestamp: "2026-08-19T14:20:00.000Z",
      }),
    ]);
    // spawnDepth>1 を想定した更に深い階層も拾う。
    writeJsonl(join(subagents, "nested", "agent-ccc.jsonl"), [
      claudeAssistant({
        requestId: "req_c",
        messageId: "msg_c",
        model: "claude-haiku-4-5",
        input: 100,
        output: 200,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:30:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(4);
    expect(observation.perModel).toEqual([
      { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0 },
      { model: "claude-opus-5", inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheCreation1hTokens: 0, cacheReadTokens: 40 },
      { model: "claude-sonnet-5", inputTokens: 6, outputTokens: 8, cacheCreationTokens: 10, cacheCreation1hTokens: 0, cacheReadTokens: 12 },
    ]);
    // 親だけを読むと 40 になってしまう cache read が、配下合算で 52 になる。
    const cacheRead = observation.perModel.reduce((acc, u) => acc + u.cacheReadTokens, 0);
    expect(cacheRead).toBe(52);
    expect(observation.durationMs).toBe(30 * 60 * 1000);
  });

  it("usage を持たない API エラー行を 0 トークンの応答として数えない", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      { type: "assistant", uuid: "u1", isApiErrorMessage: true, message: { id: "msg_err", model: "claude-opus-5" } },
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    expect(observation).toEqual({ observed: false, reason: "no-usage-records" });
  });

  it("requestId が無いレコードは message.id をキーに数える", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: null,
        messageId: "msg_norequest",
        model: "claude-opus-5",
        input: 3,
        output: 4,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
  });

  it("session id に対応するログが無ければ log-not-found（0 を書かない）", async () => {
    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });
    expect(observation).toEqual({ observed: false, reason: "log-not-found" });
  });

  it("別 session のログが同じディレクトリにあっても混ざらない（exact 相関）", async () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_mine",
        messageId: "msg_mine",
        model: "claude-opus-5",
        input: 1,
        output: 1,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);
    writeJsonl(join(projectDir, `${other}.jsonl`), [
      claudeAssistant({
        requestId: "req_other",
        messageId: "msg_other",
        model: "claude-opus-5",
        input: 999_999,
        output: 999_999,
        cacheCreation: 0,
        cacheRead: 0,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel[0]?.inputTokens).toBe(1);
  });
});

describe("parseCodexSessionId", () => {
  // 本機の実 `.out`（codex-cli 0.144.1）から採取したヘッダ。
  const REAL_HEADER = [
    "OpenAI Codex v0.144.1",
    "--------",
    "workdir: /var/folders/ql/T/hachi-steward-4TQjMD",
    "model: gpt-5.6-luna",
    "provider: openai",
    "approval: never",
    "sandbox: read-only",
    "reasoning effort: high",
    "reasoning summaries: none",
    "session id: 01A01AE2-D4B9-71F1-AFA5-8A5F681FA75A",
    "--------",
    "user",
    "こんにちは",
  ].join("\n");

  it("実ヘッダから session id を取り出す（小文字へ正規化する）", () => {
    expect(parseCodexSessionId(REAL_HEADER)).toBe("01a01ae2-d4b9-71f1-afa5-8a5f681fa75a");
  });

  it("ヘッダが無い（起動前にクラッシュした等）場合は null", () => {
    expect(parseCodexSessionId("Permission denied\n")).toBeNull();
    expect(parseCodexSessionId("")).toBeNull();
  });

  it("本文中の紛らわしい行を session id として拾わない", () => {
    expect(parseCodexSessionId("前の session id: 0000 を参照してください\n")).toBeNull();
  });
});

describe("collectCodexNativeUsage", () => {
  let root: string;
  let sessionsRoot: string;
  let dayDir: string;
  const codexSessionId = "019fca67-dea1-79c0-98af-ce4b3f029264";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-codex-usage-"));
    sessionsRoot = join(root, "sessions");
    dayDir = join(sessionsRoot, "2026", "08", "04");
    mkdirSync(dayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function rolloutPath(sessionId = codexSessionId): string {
    return join(dayDir, `rollout-2026-08-04T10-33-52-${sessionId}.jsonl`);
  }

  it("turn_context の effort と reasoning 内数を mainSession の turn・集計へ載せる", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 100,
        cacheWrite: 0,
        output: 100,
        reasoning: 60,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect(observation.mainSession.contextEffort).toBe("xhigh");
    expect(observation.mainSession.perModel[0]?.reasoningOutputTokens).toBe(60);
    expect(observation.mainSession.perExecution[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      turns: 1,
      outputTokens: 100,
      reasoningOutputTokens: 60,
    });
    expect(observation.mainSession.turnSeries[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      outputTokens: 100,
      reasoningOutputTokens: 60,
    });
  });

  it("同じ provider/model でも effort が変われば perExecution を分離する", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 40,
      }),
      { timestamp: "2026-08-04T01:35:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 3_000,
        cached: 0,
        cacheWrite: 0,
        output: 250,
        reasoning: 100,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect(observation.mainSession.perExecution).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        turns: 1,
        inputTokens: 2_000,
        outputTokens: 150,
        reasoningOutputTokens: 60,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        turns: 1,
        inputTokens: 1_000,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ]);
    expect(observation.mainSession.turnSeries.map((turn) => turn.effort)).toEqual(["xhigh", "medium"]);
  });

  it("累積 total_token_usage の差分から4系統を取り出す（cached は input の内数、reasoning は output の内数）", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:02.000Z", type: "session_meta", payload: { session_id: codexSessionId } },
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 28_093,
        cached: 1_792,
        cacheWrite: 0,
        output: 713,
        reasoning: 435,
      }),
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 60_000,
        cached: 10_000,
        cacheWrite: 500,
        output: 1_000,
        reasoning: 600,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    expect(observation).toEqual({
      observed: true,
      turns: 2,
      durationMs: 60_000,
      perModel: [
        {
          model: "gpt-5.6-sol",
          // 60,000 - 10,000。reasoning(600) は output(1,000) の内数なので加算しない。
          inputTokens: 50_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 600,
          cacheCreationTokens: 500,
          cacheReadTokens: 10_000,
        },
      ],
      // codex に子セッションは無いので rollout 全体が親セッション。perModel も観測レベルとそのまま一致する。
      // 入力側は cached を足し直さず inputDelta + cacheWrite（28,093 + 0）と（31,907 + 500）。
      // fixture の token_count イベントは実ログ同様 model_context_window を毎回報告するため
      // contextWindowTokens も乗る（最後に観測した値が勝つ。ここは両イベントとも同じ 258,400）。
      mainSession: {
        turns: 2,
        inputTokens: 60_500,
        contextTokens: 32_407,
        contextModel: "gpt-5.6-sol",
        elapsedMs: 60_000,
        perModel: [
          {
            model: "gpt-5.6-sol",
            inputTokens: 50_000,
            outputTokens: 1_000,
            reasoningOutputTokens: 600,
            cacheCreationTokens: 500,
            cacheReadTokens: 10_000,
          },
        ],
        perExecution: [
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            effort: null,
            turns: 2,
            inputTokens: 50_000,
            outputTokens: 1_000,
            reasoningOutputTokens: 600,
            cacheCreationTokens: 500,
            cacheReadTokens: 10_000,
          },
        ],
        turnSeries: [
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            effort: null,
            contextTokens: 28_093,
            inputTokens: 26_301,
            outputTokens: 713,
            reasoningOutputTokens: 435,
            cacheCreationTokens: 0,
            cacheReadTokens: 1_792,
            timestampMs: Date.parse("2026-08-04T01:34:29.000Z"),
          },
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            effort: null,
            contextTokens: 32_407,
            inputTokens: 23_699,
            outputTokens: 287,
            reasoningOutputTokens: 165,
            cacheCreationTokens: 500,
            cacheReadTokens: 8_208,
            timestampMs: Date.parse("2026-08-04T01:35:29.000Z"),
          },
        ],
        contextWindowTokens: 258_400,
      },
    });
  });

  it("同じ累積値を繰り返す重複イベントを二重計上しない", async () => {
    const event = codexTokenCount({
      timestamp: "2026-08-04T01:34:29.000Z",
      input: 1_000,
      cached: 100,
      cacheWrite: 0,
      output: 50,
      reasoning: 10,
    });
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      event,
      event,
      event,
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
    expect(observation.perModel[0]).toEqual({
      model: "gpt-5.6-sol",
      inputTokens: 900,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
    });
  });

  it("reasoning の欠落・減少だけでは既存4系統の baseline を reset しない", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 80,
      }),
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 2_000,
        cached: 0,
        cacheWrite: 0,
        output: 200,
      }),
      codexTokenCount({
        timestamp: "2026-08-04T01:36:29.000Z",
        input: 3_000,
        cached: 0,
        cacheWrite: 0,
        output: 300,
        reasoning: 20,
      }),
      codexTokenCount({
        timestamp: "2026-08-04T01:37:29.000Z",
        input: 4_000,
        cached: 0,
        cacheWrite: 0,
        output: 400,
        reasoning: 10,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect(observation.perModel[0]).toEqual({
      model: "gpt-5.6-sol",
      inputTokens: 4_000,
      outputTokens: 400,
      reasoningOutputTokens: 90,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    expect(observation.mainSession.turnSeries.map((turn) => turn.inputTokens)).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(observation.mainSession.turnSeries.map((turn) => turn.outputTokens)).toEqual([100, 100, 100, 100]);
    expect(observation.mainSession.turnSeries.map((turn) => turn.reasoningOutputTokens)).toEqual([
      80,
      undefined,
      undefined,
      10,
    ]);
  });

  it("turn 途中でモデルが切り替わったらその時点以降を新しいモデルへ按分する", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 0,
      }),
      { timestamp: "2026-08-04T01:35:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 3_000,
        cached: 0,
        cacheWrite: 0,
        output: 250,
        reasoning: 0,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel).toEqual([
      { model: "gpt-5.6-sol", inputTokens: 1_000, outputTokens: 100, reasoningOutputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { model: "gpt-5.6-terra", inputTokens: 2_000, outputTokens: 150, reasoningOutputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(observation.mainSession?.contextModel).toBe("gpt-5.6-terra");
  });

  it("最後の turn_context でモデルを観測できなければ過去値や session_meta から contextModel を補完しない", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:00.000Z", type: "session_meta", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 0,
      }),
      { timestamp: "2026-08-04T01:35:03.000Z", type: "turn_context", payload: {} },
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 3_000,
        cached: 0,
        cacheWrite: 0,
        output: 250,
        reasoning: 0,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession?.contextModel).toBeUndefined();
    expect(observation.mainSession && "contextModel" in observation.mainSession).toBe(false);
  });

  it("cached が input を超える（前提崩れ）ときは負値を作らず log-unreadable にする", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 100,
        cached: 500,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    expect(observation).toEqual({ observed: false, reason: "log-unreadable" });
  });

  it("rollout が無ければ log-not-found（時刻が近い別 session を拾わない）", async () => {
    writeJsonl(rolloutPath("ffffffff-1111-2222-3333-444444444444"), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 999_999,
        cached: 0,
        cacheWrite: 0,
        output: 999,
        reasoning: 0,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    expect(observation).toEqual({ observed: false, reason: "log-not-found" });
  });

  it("token_count が 1 件も無い rollout は no-usage-records（0 を書かない）", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-04T01:34:04.000Z", type: "response_item", payload: { type: "message" } },
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    expect(observation).toEqual({ observed: false, reason: "no-usage-records" });
  });

  it("途中で切れた行があっても残りの行から集計する", async () => {
    const path = rolloutPath();
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
        JSON.stringify(
          codexTokenCount({
            timestamp: "2026-08-04T01:34:29.000Z",
            input: 1_000,
            cached: 0,
            cacheWrite: 0,
            output: 10,
            reasoning: 0,
          }),
        ),
        '{"timestamp": "2026-08-04T01:35:00.000Z", "type": "event_ms',
      ].join("\n"),
      "utf8",
    );

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.perModel[0]?.inputTokens).toBe(1_000);
  });

  it("token_count の model_context_window を mainSession.contextWindowTokens として読む", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
        modelContextWindow: 258_400,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession?.contextWindowTokens).toBe(258_400);
  });

  it("model_context_window は最後に観測した値が勝つ（後続イベントで欠けても直前の値を保つ）", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
        modelContextWindow: 128_000,
      }),
      codexTokenCount({
        timestamp: "2026-08-04T01:35:29.000Z",
        input: 2_000,
        cached: 0,
        cacheWrite: 0,
        output: 20,
        reasoning: 0,
        modelContextWindow: 258_400,
      }),
      // 3件目はフィールド自体を欠く。直前の観測値（258,400）をクリアしないこと。
      codexTokenCount({
        timestamp: "2026-08-04T01:36:29.000Z",
        input: 3_000,
        cached: 0,
        cacheWrite: 0,
        output: 30,
        reasoning: 0,
        modelContextWindow: null,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession?.contextWindowTokens).toBe(258_400);
  });

  it("全イベントに model_context_window が無ければ mainSession.contextWindowTokens はキーごと省略する", async () => {
    writeJsonl(rolloutPath(), [
      { timestamp: "2026-08-04T01:34:03.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      codexTokenCount({
        timestamp: "2026-08-04T01:34:29.000Z",
        input: 1_000,
        cached: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
        modelContextWindow: null,
      }),
    ]);

    const observation = await collectCodexNativeUsage({ sessionsRoot, sessionId: codexSessionId });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // undefined を明示キーとして持つのと省略は別物（exactOptionalPropertyTypes）。
    // cacheCreation1hTokens の省略テストと同じ idiom で「キー自体が無い」ことを確認する。
    expect(observation.mainSession && "contextWindowTokens" in observation.mainSession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mainSession: オーケストレーターの自己計測が使う「親セッションだけ」の内訳。
// 総額（perModel/turns）とは基準が違うことを、両方を同時に見て固定する。
// ---------------------------------------------------------------------------
describe("mainSession（親セッションだけの内訳）", () => {
  let root: string;
  let projectsRoot: string;
  let projectDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-main-session-"));
    projectsRoot = join(root, "projects");
    projectDir = join(projectsRoot, "-Users-someone-worktrees-example");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("サブエージェントのターンを自分のターンに数えない（総額とは基準が違う）", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_p1", messageId: "msg_p1", model: "claude-opus-5",
        input: 10, output: 20, cacheCreation: 30, cacheRead: 40,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
      claudeAssistant({
        requestId: "req_p2", messageId: "msg_p2", model: "claude-opus-5",
        input: 1, output: 2, cacheCreation: 100, cacheRead: 5_000,
        timestamp: "2026-08-19T14:05:00.000Z",
      }),
    ]);
    writeJsonl(join(projectDir, SESSION_ID, "subagents", "agent-aaa.jsonl"), [
      claudeAssistant({
        requestId: "req_a1", messageId: "msg_a1", model: "claude-sonnet-5",
        input: 7, output: 8, cacheCreation: 9, cacheRead: 10,
        timestamp: "2026-08-19T14:02:00.000Z",
      }),
      claudeAssistant({
        requestId: "req_a2", messageId: "msg_a2", model: "claude-sonnet-5",
        input: 7, output: 8, cacheCreation: 9, cacheRead: 10,
        timestamp: "2026-08-19T14:03:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // 総額はサブエージェント込み（課金は発生している）。
    expect(observation.turns).toBe(4);
    // 自己計測は親の2ターンだけ。10+30+40=80 と 1+100+5000=5101 の合計。
    // perModel も同じ基準（親のみ）で組み立てる。claude-sonnet-5 のサブエージェント2ターン
    // （input7/output8/cc9/cr10 が2件）を意図的に除外できているかを確認する load-bearing なテスト。
    // claude-opus-5: inputTokens=10+1=11, outputTokens=20+2=22, cacheCreationTokens=30+100=130,
    // cacheReadTokens=40+5000=5040。
    expect(observation.mainSession).toEqual({
      turns: 2,
      inputTokens: 5_181,
      contextTokens: 5_101,
      contextModel: "claude-opus-5",
      elapsedMs: 300_000,
      perModel: [
        {
          model: "claude-opus-5",
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationTokens: 130,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 5_040,
        },
      ],
      perExecution: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          turns: 2,
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationTokens: 130,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 5_040,
        },
      ],
      turnSeries: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          contextTokens: 80,
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 40,
          timestampMs: Date.parse("2026-08-19T14:00:00.000Z"),
        },
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          contextTokens: 5_101,
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 100,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 5_000,
          timestampMs: Date.parse("2026-08-19T14:05:00.000Z"),
        },
      ],
    });
  });

  it("親ファイルの isSidechain 行を自分のターンにも直近ターンにも数えない", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_self", messageId: "msg_self", model: "claude-opus-5",
        input: 5, output: 10, cacheCreation: 1_000, cacheRead: 190_000,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
      // サブエージェントの応答が親ファイルへ書かれた行。文脈は小さい。
      // これを直近ターンに採ると、上限付近のセッションが「まだ余裕がある」と読めてしまう。
      claudeAssistant({
        requestId: "req_side", messageId: "msg_side", model: "claude-sonnet-5",
        input: 3, output: 4, cacheCreation: 0, cacheRead: 500,
        timestamp: "2026-08-19T14:09:00.000Z",
        sidechain: true,
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(2);
    expect(observation.mainSession).toEqual({
      turns: 1,
      inputTokens: 191_005,
      contextTokens: 191_005,
      contextModel: "claude-opus-5",
      elapsedMs: 0,
      perModel: [
        {
          model: "claude-opus-5",
          inputTokens: 5,
          outputTokens: 10,
          cacheCreationTokens: 1_000,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 190_000,
        },
      ],
      perExecution: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          turns: 1,
          inputTokens: 5,
          outputTokens: 10,
          cacheCreationTokens: 1_000,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 190_000,
        },
      ],
      turnSeries: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          contextTokens: 191_005,
          inputTokens: 5,
          outputTokens: 10,
          cacheCreationTokens: 1_000,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 190_000,
          timestampMs: Date.parse("2026-08-19T14:00:00.000Z"),
        },
      ],
    });
  });

  it("直近ターンは timestamp の最大で選ぶ（ログの並び順に依存しない）", async () => {
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_late", messageId: "msg_late", model: "claude-opus-5",
        input: 1, output: 2, cacheCreation: 0, cacheRead: 210_000,
        timestamp: "2026-08-19T15:00:00.000Z",
      }),
      claudeAssistant({
        requestId: "req_early", messageId: "msg_early", model: "claude-opus-5",
        input: 1, output: 2, cacheCreation: 0, cacheRead: 1_000,
        timestamp: "2026-08-19T14:00:00.000Z",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession?.contextTokens).toBe(210_001);
    expect(observation.mainSession?.contextModel).toBe("claude-opus-5");
  });

  it("timestamp 欠落が混在しても turnSeries はログ順を保ち、直近文脈は従来規則で選ぶ", async () => {
    const missingTimestamp = claudeAssistant({
      requestId: "req_a", messageId: "msg_a", model: "claude-a",
      input: 1, output: 10, cacheCreation: 0, cacheRead: 100,
      timestamp: "2026-08-19T10:01:00.000Z",
      effort: "low",
    });
    delete missingTimestamp.timestamp;
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      missingTimestamp,
      claudeAssistant({
        requestId: "req_b", messageId: "msg_b", model: "claude-b",
        input: 2, output: 20, cacheCreation: 0, cacheRead: 200,
        timestamp: "2026-08-19T10:00:00.000Z",
        effort: "medium",
      }),
      claudeAssistant({
        requestId: "req_c", messageId: "msg_c", model: "claude-c",
        input: 3, output: 30, cacheCreation: 0, cacheRead: 300,
        timestamp: "2026-08-19T09:59:00.000Z",
        effort: "high",
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed || observation.mainSession === undefined) {
      throw new Error("mainSession を観測できること");
    }
    expect(observation.mainSession.turnSeries.map((turn) => turn.model)).toEqual([
      "claude-a",
      "claude-b",
      "claude-c",
    ]);
    expect(observation.mainSession.contextTokens).toBe(202);
    expect(observation.mainSession.contextModel).toBe("claude-b");
    expect(observation.mainSession.contextEffort).toBe("medium");
  });

  it("ストリーミング途中経過の行があっても直近ターンの文脈サイズは変わらない", async () => {
    // input/cache はグループ内で不変で、増えるのは output だけ。どの行を採っても入力側は同じになる。
    const partial = (output: number): Record<string, unknown> =>
      claudeAssistant({
        requestId: "req_stream", messageId: "msg_stream", model: "claude-opus-5",
        input: 2, output, cacheCreation: 27_933, cacheRead: 133_982,
        timestamp: "2026-08-19T14:50:00.000Z",
      });
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [partial(5), partial(231)]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession).toEqual({
      turns: 1,
      inputTokens: 161_917,
      contextTokens: 161_917,
      contextModel: "claude-opus-5",
      elapsedMs: 0,
      // 途中経過（output:5）を捨て、最終行（output:231）だけを perModel にも反映する。
      perModel: [
        {
          model: "claude-opus-5",
          inputTokens: 2,
          outputTokens: 231,
          cacheCreationTokens: 27_933,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 133_982,
        },
      ],
      perExecution: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          turns: 1,
          inputTokens: 2,
          outputTokens: 231,
          cacheCreationTokens: 27_933,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 133_982,
        },
      ],
      turnSeries: [
        {
          provider: "claude",
          model: "claude-opus-5",
          effort: null,
          contextTokens: 161_917,
          inputTokens: 2,
          outputTokens: 231,
          cacheCreationTokens: 27_933,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 133_982,
          timestampMs: Date.parse("2026-08-19T14:50:00.000Z"),
        },
      ],
    });
  });

  it("親ファイルに自分の行が1つも無ければ mainSession を省略する（0 を書かない）", async () => {
    // 親は sidechain 行だけ。総額は観測できるが、自分の消費は切り出せない。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_side", messageId: "msg_side", model: "claude-sonnet-5",
        input: 3, output: 4, cacheCreation: 0, cacheRead: 500,
        timestamp: "2026-08-19T14:09:00.000Z",
        sidechain: true,
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.turns).toBe(1);
    expect(observation.mainSession).toBeUndefined();
  });
});

describe("mainSession の文脈サイズは advisor 分も再送分も含めない", () => {
  let root: string;
  let projectsRoot: string;
  let projectDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-main-advisor-"));
    projectsRoot = join(root, "projects");
    projectDir = join(projectsRoot, "-Users-someone-worktrees-example");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("直近ターンに advisor が挟まっても、文脈は最後の message iteration だけを数える", async () => {
    // 実ログ 1 行をそのまま写した fixture（0f8f71c0-4e25-415b-a594-c5aa4f135881 セッション、
    // requestId req_011CeCJiga5EWRE1Rt3XtXJi）。値は数えやすい丸め値ではなく実測値であることに意味がある。
    //
    // この形の要点は2つある。
    //   1. advisor_message は自分の文脈ではなく advisor 側の文脈を持つ（input 90,447 は自分の文脈ではない）
    //   2. advisor を挟んだ後段の message は**前段のプロンプトを丸ごと再送する**。
    //      it2 の cache_read 89,034 が it0 の cache_creation 664 + cache_read 88,370 と完全に一致する。
    //      本機の全ログ（message iteration 2件以上の 1,119 行）でこの一致が全件成立する。
    // したがって足すと 179,314＝実体 90,278 のほぼ2倍になる。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_advisor", messageId: "msg_advisor", model: "claude-opus-5",
        advisorModel: "claude-opus-5",
        // top-level は message iteration の合計（advisor 分を含まない）。実ログどおり。
        input: 4, output: 538, cacheCreation: 1_906, cacheRead: 177_404,
        timestamp: "2026-08-19T15:00:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 26, cacheCreation: 664, cacheRead: 88_370 }),
          // advisor は別文脈。90,447 トークンぶん自分の文脈が増えたわけではない。
          claudeIteration({ type: "advisor_message", input: 90_447, output: 9_989, model: "claude-opus-5" }),
          // 再送: cache_read 89,034 == 664 + 88,370。前段ぶんは新しく積み上がった文脈ではない。
          claudeIteration({ type: "message", input: 2, output: 512, cacheCreation: 1_242, cacheRead: 89_034 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // 文脈は最後の message iteration だけ: 2 + 1,242 + 89,034 = 90,278。合計の 179,314 ではない。
    expect(observation.mainSession?.contextTokens).toBe(90_278);
    // 累計は advisor 分（90,447）も再送分も含む。cache read として実際に課金されているので落とさない。
    expect(observation.mainSession?.inputTokens).toBe(269_761);
  });

  it("再送を合計すると段階が ok→urgent へ跳ねる（実ログ最大例を固定する）", async () => {
    // 実ログの最悪例（e9bee10c-4f1f-484f-a676-a3be45bff562 セッション）。
    // 実体 118,619 は ok（<120,000）だが、合計 236,269 は urgent（>=220,000）になる。
    // 本機では 1,119 行中 938 行で段階が変わり、うち 101 行がこの ok→urgent だった。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_ok_to_urgent", messageId: "msg_ok_to_urgent", model: "claude-opus-5",
        advisorModel: "claude-opus-5",
        input: 4, output: 2_339, cacheCreation: 1_639, cacheRead: 234_626,
        timestamp: "2026-08-19T15:00:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 72, cacheCreation: 670, cacheRead: 116_978 }),
          claudeIteration({ type: "advisor_message", input: 119_130, output: 4_144, model: "claude-opus-5" }),
          // 再送: cache_read 117,648 == 670 + 116,978。
          claudeIteration({ type: "message", input: 2, output: 2_267, cacheCreation: 969, cacheRead: 117_648 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // 2 + 969 + 117,648 = 118,619。既定閾値の notice(120,000) に届かない＝ok のままであること。
    expect(observation.mainSession?.contextTokens).toBe(118_619);
    expect(observation.mainSession?.contextTokens).toBeLessThan(120_000);
  });

  it("最大ではなく最後の message iteration を採る（ターン中に文脈が縮んだ場合）", async () => {
    // **この fixture は意図的に実ログの不変条件を破っている。** 上の2テストで確認したとおり
    // 実ログでは後段の cache_read == 前段の cc + cr（＝再送）で、1,119 行すべてで最後＝最大だった。
    // ここは it1 の cache_read を 30,000（＝前段より小さい）にして、その不変条件が崩れた場合を作っている。
    // 目的は実形状の再現ではなく**「最大」ではなく「最後」を採るという設計判断を固定すること**:
    // ターン途中で文脈が圧縮されると最大は圧縮前の値を返して今回と同じ上振れ誤報を再発させるが、
    // 最後は圧縮後＝次ターンに実際にかかる値になり、ずれるとしても過小側（fail-open）へ倒れる。
    // 実装を max へ変えるとこのテストが落ちる。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_shrink", messageId: "msg_shrink", model: "claude-opus-5",
        input: 4, output: 300, cacheCreation: 0, cacheRead: 230_000,
        timestamp: "2026-08-19T15:00:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 100, cacheRead: 200_000 }),
          claudeIteration({ type: "message", input: 2, output: 200, cacheRead: 30_000 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    // 最後 = 2 + 30,000 = 30,002。最大（200,002）でも合計（230,004）でもない。
    expect(observation.mainSession?.contextTokens).toBe(30_002);
  });

  it("message iteration があるのに top-level が 0 で潰れている行では message 側を採る", async () => {
    // 本機に4行実在する形（cache read 998,206 を持つ message iteration に対し top-level が全系統 0）。
    // top-level をそのまま信じると文脈サイズを丸ごと 0 と報告してしまう。
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [
      claudeAssistant({
        requestId: "req_zero_top", messageId: "msg_zero_top", model: "claude-opus-5",
        input: 0, output: 0, cacheCreation: 0, cacheRead: 0,
        timestamp: "2026-08-19T15:00:00.000Z",
        iterations: [
          claudeIteration({ type: "message", input: 2, output: 119, cacheCreation: 1_092, cacheRead: 998_206 }),
        ],
      }),
    ]);

    const observation = await collectClaudeNativeUsage({ projectsRoot, sessionId: SESSION_ID });

    if (!observation.observed) {
      throw new Error("observed であること");
    }
    expect(observation.mainSession?.contextTokens).toBe(999_300);
  });
});

// ---------------------------------------------------------------------------
// パス境界（契約 §28.6-2）: 形式検証と containment を両方課す
// ---------------------------------------------------------------------------

describe("ネイティブ session id のパス境界", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-native-path-boundary-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("isValidNativeSessionId は uuid を受理し、区切り文字を含む形を拒否する", () => {
    expect(isValidNativeSessionId(SESSION_ID)).toBe(true);
    expect(isValidNativeSessionId("direct-1a2b3c")).toBe(true);
    expect(isValidNativeSessionId("a".repeat(128))).toBe(true);

    expect(isValidNativeSessionId("a".repeat(129))).toBe(false);
    expect(isValidNativeSessionId("")).toBe(false);
    expect(isValidNativeSessionId("..")).toBe(false);
    expect(isValidNativeSessionId("../../etc/passwd")).toBe(false);
    expect(isValidNativeSessionId("/etc/passwd")).toBe(false);
    expect(isValidNativeSessionId("a/b")).toBe(false);
    expect(isValidNativeSessionId("a.b")).toBe(false);
    expect(isValidNativeSessionId("a\0b")).toBe(false);
  });

  it("isPathWithinRoot は接頭辞一致で誤判定しない", () => {
    expect(isPathWithinRoot("/a/b", "/a/b/c.jsonl")).toBe(true);
    expect(isPathWithinRoot("/a/b", "/a/b/c/d.jsonl")).toBe(true);
    expect(isPathWithinRoot("/a/b", "/a/b/..hidden/x.jsonl")).toBe(true);
    // 文字列の startsWith だと通ってしまう兄弟ディレクトリ。
    expect(isPathWithinRoot("/a/b", "/a/bc/d.jsonl")).toBe(false);
    expect(isPathWithinRoot("/a/b", "/a/c.jsonl")).toBe(false);
    expect(isPathWithinRoot("/a/b", "/a/b/..")).toBe(false);
    expect(isPathWithinRoot("/a/b", "/a/b/../x")).toBe(false);
    // root 自身は「配下」に含めない。
    expect(isPathWithinRoot("/a/b", "/a/b")).toBe(false);
    expect(isPathWithinRoot("/a/b", "/a/b/../../c.jsonl")).toBe(false);
  });

  it("findClaudeSessionDir は traversal 形の sessionId で projectsRoot の外へ出ない", async () => {
    const projectsRoot = join(root, "projects");
    mkdirSync(join(projectsRoot, "-Users-someone-worktrees-example"), { recursive: true });
    // projectsRoot の外側に実在する .jsonl。形式検証が無いと `../../outside/secret` で到達できる。
    writeJsonl(join(root, "outside", "secret.jsonl"), [{ type: "user" }]);

    expect(await findClaudeSessionDir(projectsRoot, "../../outside/secret")).toBeNull();
    expect(await findClaudeSessionDir(projectsRoot, "/etc/passwd")).toBeNull();
    expect(await findClaudeSessionDir(projectsRoot, "..")).toBeNull();
  });

  it("findClaudeSessionDir は通常の uuid をこれまで通り解決する", async () => {
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, "-Users-someone-worktrees-example");
    writeJsonl(join(projectDir, `${SESSION_ID}.jsonl`), [{ type: "user" }]);

    expect(await findClaudeSessionDir(projectsRoot, SESSION_ID)).toBe(projectDir);
  });

  it("findCodexRollout は不正な形の sessionId を拒否し、通常の uuid は解決する", async () => {
    const sessionsRoot = join(root, "sessions");
    const codexSessionId = "019fca67-dea1-79c0-98af-ce4b3f029264";
    const rollout = join(sessionsRoot, "2026", "08", "21", `rollout-2026-08-21T10-00-00-${codexSessionId}.jsonl`);
    writeJsonl(rollout, [{ type: "session_meta" }]);

    expect(await findCodexRollout(sessionsRoot, "../../outside/secret")).toBeNull();
    expect(await findCodexRollout(sessionsRoot, "")).toBeNull();
    expect(await findCodexRollout(sessionsRoot, codexSessionId)).toBe(rollout);
  });
});
