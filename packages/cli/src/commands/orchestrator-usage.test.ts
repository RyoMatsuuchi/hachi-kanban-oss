// =============================================================================
// hachi orchestrator usage の CLI（runbooks/orchestrator-playbook.md §0.7）。
// fixture は実ログを縮小したもので、claude / codex の両方を実 parser に通す。
// 検証の主眼は「推測しないこと」「読み書きしないこと」「フックを静かに保つこと」の3つ。
//
// 2026-08-22 改訂: 旧3軸（turns / cumulativeInputTokens / contextTokens）を新4軸
// （turns / contextSaturation / handoffValue / effectiveCostUsd）へ差し替えた。
// =============================================================================

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_BOOT_GENERATIONS,
  DEFAULT_SESSION_BOOT_OVERHEAD_USD,
  DEFAULT_SESSION_BUDGET_C0,
  DEFAULT_SESSION_TURNS_PER_TASK,
  PRICE_TABLE_REF,
  type HachiConfig,
  type OrchestratorSessionRow,
  type Provider,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

const CLAUDE_SESSION_ID = "199a85b5-5975-4998-8dc0-9f4d4d29508c";
const CODEX_SESSION_ID = "019fca67-dea1-79c0-98af-ce4b3f029264";

interface UsagePayload {
  session: OrchestratorSessionRow | null;
  stage: string | null;
  reason?: string;
  firedAxes?: string[];
  axes?: Array<{
    axis: string;
    informational: boolean;
    value: number | undefined;
    stage: string | null;
    unmeasured?: { reason: string };
  }>;
  measurement: {
    turns: number;
    contextTokens: number;
    contextModel?: string;
    contextWindowTokens?: number;
    contextSaturation?: number;
    handoffValueTurns?: number;
    handoffValueCacheReadCostPerToken?: number;
    handoffValueCacheReadPriceSource?: "context-model" | "dominant" | "default";
    costModel: {
      c0: number;
      c0Source: "measured" | "config";
      s: number | null;
      sSource: "measured" | "config" | "config-legacy" | "unmeasured";
      bootOverheadUsd: number;
      bootOverheadSource: "measured" | "config";
      writePriceUsdPerToken: number | null;
      writePriceSource: "cacheCreation1h" | "cacheCreation5m" | "input" | null;
      priceSource: "override" | "table" | "codex-credits" | null;
      generations: number;
    };
    cumulativeInputTokens: number;
    effectiveCostUsd?: number;
    effectiveCostCredits?: number;
    priceSource: "override" | "table" | "codex-credits" | null;
    priceTableRef?: string;
    ledger: "api" | "chatgpt" | "unknown";
    unpricedModels?: string[];
    averageInputTokensPerTurn: number | null;
    elapsedMs: number | null;
    totalTurns: number;
    totalInputTokens: number;
  } | null;
  remaining?: {
    r: number;
    rBasis: "scoped-with-todo";
    breakdown: { todo: number; ready: number; inProgress: number; review: number; inbox: number };
  };
  recommendation?: {
    action: "continue" | "handoff-at-boundary" | "handoff-now";
    n: number | null;
    r: number;
    model: string | null;
    effort: string | null;
    reasons: string[];
    idle: {
      ttlSeconds: number;
      rewriteUsd: number | null;
      savingsUsd: number | null;
      action: "continue" | "handoff-before-idle";
    };
  };
  effortAdvisory?: unknown | null;
  missionTaskIds?: string[];
  exitCode: number;
}

// ---------------------------------------------------------------------------
// 期待値の独立導出（model-prices.generated.ts / orchestrator-session-budget.ts の式を
// テスト側で再実装する。estimateCostUsd / computeHandoffBreakEvenTurns 自体は呼ばない
// ——呼ぶと「テスト対象で期待値を作る」循環になり検出力が無くなるため）。
// ---------------------------------------------------------------------------

/** claude-opus-5 の単価（packages/core/src/model-prices.generated.ts 11行目以降）。 */
const CLAUDE_OPUS_5_PRICE = {
  input: 0.000005,
  output: 0.000025,
  cacheWrite1h: 0.00001,
  cacheRead: 0.0000005,
};
/** gpt-5.6-sol の単価（同ファイル 102行目以降。2026-08-21〜11-21 のプロモ価格 $4/$20、cache read $0.40）。cacheCreation1h は null（このテストでは cache write 自体を使わない）。 */
const GPT_5_6_SOL_PRICE = {
  input: 0.000004,
  output: 0.00002,
  cacheWrite5m: 0.000005,
  cacheRead: 0.0000004,
};
const CLAUDE_SONNET_5_PRICE = { cacheWrite1h: 0.000004, cacheRead: 0.0000002 };

function expectedCostModel(
  writePriceUsdPerToken: number,
  writePriceSource: "cacheCreation1h" | "cacheCreation5m" | "input",
  c0 = DEFAULT_SESSION_BUDGET_C0,
  bootOverheadUsd = DEFAULT_SESSION_BOOT_OVERHEAD_USD,
  priceSource: "override" | "table" | "codex-credits" = "table",
): NonNullable<UsagePayload["measurement"]>["costModel"] {
  return {
    c0,
    c0Source: "config",
    s: c0 * writePriceUsdPerToken + bootOverheadUsd,
    sSource: "config",
    bootOverheadUsd,
    bootOverheadSource: "config",
    writePriceUsdPerToken,
    writePriceSource,
    priceSource,
    generations: DEFAULT_SESSION_BOOT_GENERATIONS,
  };
}

const DEFAULT_CLAUDE_COST_MODEL = expectedCostModel(
  CLAUDE_OPUS_5_PRICE.cacheWrite1h,
  "cacheCreation1h",
);
const DEFAULT_CODEX_COST_MODEL = expectedCostModel(
  GPT_5_6_SOL_PRICE.cacheWrite5m,
  "cacheCreation5m",
);
const DEFAULT_SONNET_COST_MODEL = expectedCostModel(
  CLAUDE_SONNET_5_PRICE.cacheWrite1h,
  "cacheCreation1h",
);

/**
 * seedClaudeLog(turns, cacheReadPerTurn, outputTokensPerTurn) が生む effectiveCostUsd の期待値。
 * claudeRow は毎ターン input_tokens=1 固定・cache_creation=0 固定なので、この2項と cacheRead だけが効く。
 */
function expectedClaudeCost(turns: number, cacheReadPerTurn: number, outputTokensPerTurn = 10): number {
  return (
    turns * 1 * CLAUDE_OPUS_5_PRICE.input +
    turns * outputTokensPerTurn * CLAUDE_OPUS_5_PRICE.output +
    turns * cacheReadPerTurn * CLAUDE_OPUS_5_PRICE.cacheRead
  );
}

/**
 * seedCodexLog(turns, inputPerTurn) が生む effectiveCostUsd の期待値。
 * total_token_usage の output は毎ターン差分10固定（10*index の累積差分）、cached/cacheWrite は常に0。
 */
function expectedCodexCost(turns: number, inputPerTurn: number): number {
  return turns * inputPerTurn * GPT_5_6_SOL_PRICE.input + turns * 10 * GPT_5_6_SOL_PRICE.output;
}

/**
 * 損益分岐ターン数 N の期待値（orchestrator-session-budget.ts の式 N = S / ((C - C0) * r) を
 * 独立に再実装する。r は context model の cache read 単価で、既定は claude-opus-5 の $0.50/MTok）。C <= C0 なら undefined。
 */
function expectedHandoffValueN(
  contextTokens: number,
  costModel: { c0: number; s: number | null },
  cacheReadPerToken: number = CLAUDE_OPUS_5_PRICE.cacheRead,
): number | undefined {
  if (costModel.s === null) {
    return undefined;
  }
  const overCostPerTurn = (contextTokens - costModel.c0) * cacheReadPerToken;
  return overCostPerTurn > 0 ? costModel.s / overCostPerTurn : undefined;
}

describe("hachi orchestrator usage（playbook §0.7 の自己計測）", () => {
  let ctx: TestDeps;
  const tempDirs: string[] = [];

  afterEach(() => {
    ctx.cleanup();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "hachi-usage-cli-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeJsonl(path: string, rows: readonly unknown[]): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  }

  /** 実ログと同じ形の assistant 行。turns 分だけ繰り返して任意の消費量を作る。 */
  function claudeRow(
    index: number,
    cacheRead: number,
    outputTokens = 10,
    model = "claude-opus-5",
  ): Record<string, unknown> {
    return {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      uuid: `uuid-${index}`,
      requestId: `req_${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 19, 14, index % 60, 0)).toISOString(),
      message: {
        id: `msg_${index}`,
        model,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
          output_tokens: outputTokens,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    };
  }

  /**
   * claude の transcript を用意し、nativeUsageRoots をそこへ向ける。
   * outputTokensPerTurn は effectiveCostUsd を contextTokens/handoffValue に影響させずに
   * 単独で駆動するためのノブ（output 単価だけが高く、latestMessageInputTokens には乗らない）。
   */
  function seedClaudeLog(
    turns: number,
    cacheReadPerTurn: number,
    outputTokensPerTurn = 10,
    model = "claude-opus-5",
  ): string {
    const root = makeRoot();
    const projectsRoot = join(root, "projects");
    const path = join(projectsRoot, "-Users-someone-worktrees-example", `${CLAUDE_SESSION_ID}.jsonl`);
    writeJsonl(
      path,
      Array.from({ length: turns }, (_, index) => claudeRow(index, cacheReadPerTurn, outputTokensPerTurn, model)),
    );
    ctx.deps.nativeUsageRoots = { claudeProjectsRoot: projectsRoot };
    return path;
  }

  /** cache write（cache_creation）中心の行。cache read を一切使わないシナリオ（F1 edge case）用。 */
  function claudeCacheCreationRow(
    index: number,
    cacheCreationTokens: number,
    outputTokens = 10,
    model = "claude-opus-5",
  ): Record<string, unknown> {
    return {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      uuid: `uuid-cc-${index}`,
      requestId: `req_cc_${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 19, 14, index % 60, 0)).toISOString(),
      message: {
        id: `msg_cc_${index}`,
        model,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: 0,
          output_tokens: outputTokens,
          cache_creation: { ephemeral_5m_input_tokens: cacheCreationTokens, ephemeral_1h_input_tokens: 0 },
        },
      },
    };
  }

  /** cache read を一度も使わず、cache write だけで contextTokens を作る transcript。 */
  function seedClaudeCacheCreationLog(cacheCreationTokens: number, model = "claude-opus-5"): string {
    const root = makeRoot();
    const projectsRoot = join(root, "projects");
    const path = join(projectsRoot, "-Users-someone-worktrees-example", `${CLAUDE_SESSION_ID}.jsonl`);
    writeJsonl(path, [claudeCacheCreationRow(0, cacheCreationTokens, 10, model)]);
    ctx.deps.nativeUsageRoots = { claudeProjectsRoot: projectsRoot };
    return path;
  }

  /**
   * codex の rollout を用意する。total_token_usage は累積値なので差分が1ターン分になる。
   * `model_context_window` は実ログ同様毎ターン報告する（既定 258,400。null 指定で省略を再現できる）。
   */
  function seedCodexLog(
    turns: number,
    inputPerTurn: number,
    options: {
      modelContextWindow?: number | null;
      model?: string;
      omitTurnContextModel?: boolean;
      sessionMetaModel?: string;
      auth?: unknown;
    } = {},
  ): string {
    const root = makeRoot();
    const sessionsRoot = join(root, "sessions");
    const path = join(sessionsRoot, "2026", "08", "04", `rollout-2026-08-04T10-33-52-${CODEX_SESSION_ID}.jsonl`);
    const model = options.model ?? "gpt-5.6-sol";
    const modelContextWindow = options.modelContextWindow === undefined ? 258_400 : options.modelContextWindow;
    const rows: unknown[] = [];
    if (options.sessionMetaModel !== undefined) {
      rows.push({
        timestamp: "2026-08-04T01:34:00.000Z",
        type: "session_meta",
        payload: { model: options.sessionMetaModel },
      });
    }
    rows.push({
      timestamp: "2026-08-04T01:34:03.000Z",
      type: "turn_context",
      payload: options.omitTurnContextModel === true ? {} : { model },
    });
    for (let index = 1; index <= turns; index += 1) {
      rows.push({
        timestamp: new Date(Date.UTC(2026, 7, 4, 1, 34 + (index % 26), 0)).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: inputPerTurn * index,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 10 * index,
              reasoning_output_tokens: 0,
              total_tokens: (inputPerTurn + 10) * index,
            },
            ...(modelContextWindow !== null ? { model_context_window: modelContextWindow } : {}),
          },
        },
      });
    }
    writeJsonl(path, rows);
    const codexAuthPath = join(root, "auth.json");
    if (Object.hasOwn(options, "auth")) {
      writeFileSync(codexAuthPath, JSON.stringify(options.auth), "utf8");
    }
    ctx.deps.nativeUsageRoots = { codexSessionsRoot: sessionsRoot, codexAuthPath };
    return path;
  }

  /** session を1つ作り、provider / provider session id を登録する。 */
  function startSession(provider: Provider | "", providerSessionId: string): OrchestratorSessionRow {
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "self", project: "hachi", repoCommonDir: "/tmp/repo",
    });
    return ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id, provider, providerSessionId,
    });
  }

  async function run(argv: string[]): Promise<string> {
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(argv, { from: "user" });
    return ctx.stdout.text();
  }

  async function runJson(argv: string[]): Promise<UsagePayload> {
    return JSON.parse(await run([...argv, "--json"])) as UsagePayload;
  }

  /** --check の終了コード。exit が呼ばれなければ 0（プロセスは正常終了する）。 */
  async function runCheck(sessionId: string): Promise<{ out: string; exit: number }> {
    ctx.exitCodes.length = 0;
    const out = await run(["orchestrator", "usage", "--session", sessionId, "--check"]);
    return { out, exit: ctx.exitCodes.at(-1) ?? 0 };
  }

  describe("計測", () => {
    it("claude の fixture から turn 数と累計入力を返す", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(12, 5_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.stage).toBe("ok");
      expect(payload.measurement).toEqual({
        turns: 12,
        // 1ターンあたり input 1 + cacheRead 5,000。
        cumulativeInputTokens: 60_012,
        contextTokens: 5_001,
        contextModel: "claude-opus-5",
        // claude の transcript には context window 情報が無いため常に undefined（既知の割り切り）。
        contextWindowTokens: undefined,
        contextSaturation: undefined,
        // contextTokens(5,001) <= c0(101,231) なので損益分岐点が無い＝undefined。
        handoffValueTurns: undefined,
        handoffValueCacheReadCostPerToken: 0.5e-6,
        handoffValueCacheReadPriceSource: "context-model",
        costModel: DEFAULT_CLAUDE_COST_MODEL,
        effectiveCostUsd: expectedClaudeCost(12, 5_000),
        priceSource: "table",
        priceTableRef: PRICE_TABLE_REF,
        ledger: "unknown",
        averageInputTokensPerTurn: 5_001,
        elapsedMs: 11 * 60_000,
        totalTurns: 12,
        totalInputTokens: 60_012,
      });
      expect(payload.remaining).toMatchObject({
        r: 0,
        rBasis: "scoped-with-todo",
        breakdown: { todo: 0, ready: 0, inProgress: 0, review: 0, inbox: 0 },
      });
      expect(payload.recommendation).toMatchObject({
        action: "continue",
        n: null,
        r: 0,
        model: "claude-opus-5",
        effort: null,
        reasons: ["N-undefined"],
      });
      expect(payload.effortAdvisory).toBeNull();
    });

    it("codex の fixture から turn 数と累計入力を返す", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(8, 30_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.measurement?.turns).toBe(8);
      expect(payload.measurement?.cumulativeInputTokens).toBe(240_000);
      expect(payload.measurement?.contextTokens).toBe(30_000);
      // codex の token_count は毎ターン model_context_window を報告する（実ログ例 258,400）。
      expect(payload.measurement?.contextWindowTokens).toBe(258_400);
      expect(payload.measurement?.contextSaturation).toBe(30_000 / 258_400);
      // contextTokens(30,000) <= c0(101,231) なので損益分岐点が無い。
      expect(payload.measurement?.handoffValueTurns).toBeUndefined();
      expect(payload.measurement?.costModel).toEqual(DEFAULT_CODEX_COST_MODEL);
      expect(payload.measurement?.effectiveCostUsd).toBe(expectedCodexCost(8, 30_000));
      expect(payload.measurement?.priceSource).toBe("table");
      expect(payload.measurement?.ledger).toBe("unknown");
    });

    it("orchestrator.pricing.overrides を cost と handoff の両方へ適用する", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: {
          pricing: {
            overrides: {
              "gpt-5.6-sol": {
                inputCostPerToken: 1e-6,
                outputCostPerToken: 2e-6,
                cacheCreationCostPerToken: 1e-6,
                cacheCreation1hCostPerToken: null,
                cacheReadCostPerToken: 3e-6,
                source: "test fixture",
              },
            },
          },
        },
      };
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(3, 231_231, { modelContextWindow: 1_000_000 });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.measurement?.effectiveCostUsd).toBeCloseTo(3 * 231_231e-6 + 3 * 10 * 2e-6, 12);
      expect(payload.measurement?.handoffValueCacheReadCostPerToken).toBe(3e-6);
      expect(payload.measurement?.priceSource).toBe("override");
      expect(payload.measurement?.priceTableRef).toBe(PRICE_TABLE_REF);
    });

    it("サブエージェントのターンは軸に入れず、総額として別に見せる", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const parentPath = seedClaudeLog(3, 1_000);
      // 親と同じ projects 配下へサブエージェントのログを置く。
      writeJsonl(
        join(parentPath, "..", CLAUDE_SESSION_ID, "subagents", "agent-aaa.jsonl"),
        Array.from({ length: 40 }, (_, index) => claudeRow(1_000 + index, 100)),
      );

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      // 自己計測は親の3ターン。総額（43 ターン・入力 7,043）は隠さず併記する。
      expect(payload.measurement?.turns).toBe(3);
      expect(payload.measurement?.cumulativeInputTokens).toBe(3_003);
      expect(payload.measurement?.totalTurns).toBe(43);
      expect(payload.measurement?.totalInputTokens).toBe(3_003 + 40 * 101);
      expect(payload.stage).toBe("ok");
    });

    it("発火した軸を出力に含める（effectiveCostUsd で駆動）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // cacheRead=0 で contextTokens=1（handoffValue は未計算のまま）。output を積むと
      // effectiveCostUsd だけを contextTokens に触れずに引き上げられる
      // （output 単価は latestMessageInputTokens に乗らないため）。
      // 3 * (1*0.000005 + 400,000*0.000025) = 30.000015 → recommend(>=30) かつ urgent(60) 未満。
      seedClaudeLog(3, 0, 400_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("recommend");
      expect(payload.firedAxes).toEqual(["effectiveCostUsd"]);

      const text = await run(["orchestrator", "usage", "--session", session.id]);
      expect(text).toContain("fired=effectiveCostUsd");
      expect(text).toContain("effectiveCostUsd=$30.00 -> recommend");
    });

    it("turns の config 上書きは軸の段階と表示だけを変え、総合段階には寄与しない", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { turns: { notice: 3 } } },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 100);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("ok");
      expect(payload.firedAxes).toEqual([]);
      expect(payload.axes?.find((axis) => axis.axis === "turns")).toMatchObject({
        value: 3,
        stage: "notice",
        informational: true,
      });

      const text = await run(["orchestrator", "usage", "--session", session.id]);
      expect(text).toContain("turns=3 -> notice [informational: 総合判定には不使用]");
    });

    it("costModel（損益分岐 N の c0/s）を config で上書きできる", async () => {
      // HachiConfig 型のまま渡す。types.ts と config-schema.ts が乖離すると
      // ここが型エラーになるのが期待動作なので、テスト側で型を広げてはならない。
      ctx = createTestDeps();
      const configOverride: HachiConfig = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { costModel: { c0: 5_000 } } },
      };
      ctx.deps.config = configOverride;
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // contextTokens=10,000。既定 c0=101,231 なら未計算だが、上書き c0=5,000 なら計算できる。
      seedClaudeLog(3, 9_999);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      // S = 5,000 * $10/MTok + $0.40 = $0.45、N = 0.45 / ((10,000 - 5,000) * 0.5e-6) = 180。
      const expected = expectedCostModel(CLAUDE_OPUS_5_PRICE.cacheWrite1h, "cacheCreation1h", 5_000);
      expect(payload.measurement?.handoffValueTurns).toBe(expectedHandoffValueN(10_000, expected));
      expect(payload.measurement?.costModel).toEqual(expected);
    });

    it("JSON に config TTL から算出した idle の書き直し額・節約額・推奨を載せる", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { costModel: { c0: 100, cacheTtlSeconds: 300 } } },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 100_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const expectedRewriteUsd = 100_001 * 0.00000625;
      const expectedS = 100 * CLAUDE_OPUS_5_PRICE.cacheWrite1h + DEFAULT_SESSION_BOOT_OVERHEAD_USD;

      expect(payload.recommendation?.idle).toEqual({
        ttlSeconds: 300,
        rewriteUsd: expectedRewriteUsd,
        savingsUsd: expectedRewriteUsd - expectedS,
        action: "handoff-before-idle",
      });
    });

    it("新4軸（effectiveCostUsd）の閾値も config で上書きできる", async () => {
      ctx = createTestDeps();
      // 部分指定は向きの整合（notice<=recommend<=urgent）を要求するため、3段そろえて上書きする。
      const configOverride: HachiConfig = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { effectiveCostUsd: { notice: 5, recommend: 15, urgent: 25 } } },
      };
      ctx.deps.config = configOverride;
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // 既定閾値なら recommend（30.000015 は既定 urgent=60 未満）だが、上書き urgent=25 で urgent になる。
      seedClaudeLog(3, 0, 400_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("urgent");
      expect(payload.firedAxes).toEqual(["effectiveCostUsd"]);
    });
  });

  describe("Codex 台帳", () => {
    const codexCredits = {
      "gpt-5.6-sol": { input: 2, cached: 1, output: 4, source: "test fixture" },
    };

    it("ChatGPT サインインで USD 換算率が無ければ両コスト軸を欠測にし credits だけを出す", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { pricing: { codexCredits } },
      };
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(3, 231_231, {
        modelContextWindow: 1_000_000,
        auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null },
      });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.measurement?.ledger).toBe("chatgpt");
      expect(payload.measurement?.priceSource).toBe("codex-credits");
      expect(payload.measurement?.effectiveCostCredits).toBeCloseTo((3 * 231_231 * 2 + 3 * 10 * 4) / 1_000_000, 12);
      expect(payload.measurement?.effectiveCostUsd).toBeUndefined();
      expect(payload.measurement?.handoffValueTurns).toBeUndefined();
      expect(payload.measurement?.handoffValueCacheReadCostPerToken).toBeUndefined();
      expect(payload.axes?.find((entry) => entry.axis === "effectiveCostUsd")?.unmeasured).toEqual({
        reason: "codex-credit-ledger-unpriced",
      });
      expect(payload.axes?.find((entry) => entry.axis === "handoffValue")?.unmeasured).toEqual({
        reason: "codex-credit-ledger-unpriced",
      });
    });

    it("ChatGPT サインインで credits と換算率が揃えば credits 由来の USD と r を使う", async () => {
      ctx = createTestDeps();
      const codexCreditUsdRate = 0.25;
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { pricing: { codexCredits, codexCreditUsdRate } },
      };
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(3, 231_231, {
        modelContextWindow: 1_000_000,
        auth: { auth_mode: "chatgpt", OPENAI_API_KEY: "" },
      });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const expectedCredits = (3 * 231_231 * 2 + 3 * 10 * 4) / 1_000_000;
      const expectedCacheReadUsdPerToken = codexCreditUsdRate / 1_000_000;

      expect(payload.measurement?.ledger).toBe("chatgpt");
      expect(payload.measurement?.priceSource).toBe("codex-credits");
      expect(payload.measurement?.effectiveCostCredits).toBeCloseTo(expectedCredits, 12);
      expect(payload.measurement?.effectiveCostUsd).toBeCloseTo(expectedCredits * codexCreditUsdRate, 12);
      expect(payload.measurement?.handoffValueCacheReadCostPerToken).toBe(expectedCacheReadUsdPerToken);
      const expectedS = DEFAULT_SESSION_BUDGET_C0 * (2 * codexCreditUsdRate / 1_000_000)
        + DEFAULT_SESSION_BOOT_OVERHEAD_USD;
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(
        expectedS / ((231_231 - DEFAULT_SESSION_BUDGET_C0) * expectedCacheReadUsdPerToken),
        12,
      );
      expect(payload.axes?.find((entry) => entry.axis === "effectiveCostUsd")?.unmeasured).toBeUndefined();
      expect(payload.axes?.find((entry) => entry.axis === "handoffValue")?.unmeasured).toBeUndefined();
    });
  });

  describe("4軸: contextSaturation（文脈 / context window）", () => {
    it("codex は context window に対する比率を計算する", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextTokens は毎ターン同じ 155,040（累積差分が一定のため）。155,040/258,400=0.6=notice閾値ちょうど。
      seedCodexLog(3, 155_040, { modelContextWindow: 258_400 });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("notice");
      expect(payload.firedAxes).toEqual(["contextSaturation"]);
      expect(payload.axes?.find((axis) => axis.axis === "contextSaturation")).toMatchObject({
        value: 0.6,
        stage: "notice",
        informational: false,
      });

      const text = await run(["orchestrator", "usage", "--session", session.id]);
      expect(text).toContain("contextSaturation=60% -> notice");
    });

    it("claude セッションでは contextSaturation が常に undefined になる（既知の割り切り）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const axis = payload.axes?.find((entry) => entry.axis === "contextSaturation");
      expect(axis?.value).toBeUndefined();
      expect(axis?.stage).toBeNull();
    });

    it("claude セッションでも config.contextWindowTokens を分母にすれば contextSaturation を計算できる", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { contextWindowTokens: 300_000 } },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000); // contextTokens=1,001

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const axis = payload.axes?.find((entry) => entry.axis === "contextSaturation");
      expect(axis?.value).toBe(1_001 / 300_000);
      expect(axis?.stage).not.toBeNull();
      expect(axis?.unmeasured).toBeUndefined();
      expect(payload.measurement?.contextWindowTokens).toBe(300_000);
    });

    it("codex セッションでは adapters の観測値が config の contextWindowTokens より優先される", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { contextWindowTokens: 100_000 } },
      };
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextTokens は毎ターン同じ 155,040。rollout の model_context_window=258,400 が観測値。
      seedCodexLog(3, 155_040, { modelContextWindow: 258_400 });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      // 観測値（258,400）を分母にした比率になっており、config 値（100,000）を分母にした値とは異なる。
      expect(payload.measurement?.contextWindowTokens).toBe(258_400);
      expect(payload.measurement?.contextSaturation).toBe(155_040 / 258_400);
      expect(payload.measurement?.contextSaturation).not.toBe(155_040 / 100_000);
    });

    it("観測値も config も無ければ contextSaturation は missing 分類で unmeasured になり、stderr にだけ理由が出る", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // turns=3(ok)・handoffValue は not-applicable（contextTokens<=c0）・effectiveCostUsd も ok 範囲。
      seedClaudeLog(3, 1_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const axis = payload.axes?.find((entry) => entry.axis === "contextSaturation");
      expect(axis?.unmeasured).toEqual({ reason: "context-window-unknown" });

      const { out, exit } = await runCheck(session.id);
      expect(exit).toBe(0);
      expect(out).toBe("");
      const err = ctx.stderr.text();
      expect(err).toContain("軸 contextSaturation を判定できません");
      expect(err).toContain("context-window-unknown");
      // 直し方まで書く。ヒントの無い警告は毎回同じ文面で出続けるだけになり読まれなくなる
      // （playbook §0.7.2）。設定キー名が出ていないと、読み手は有効化の方法へ辿り着けない。
      expect(err).toContain("orchestrator.sessionBudget.contextWindowTokens");
    });

    it("config.contextWindowTokens を設定すると --check の欠測行そのものが消える（肯定側）", async () => {
      // 欠測時に出ること（上のテスト）だけでは「設定すれば黙る」ことは担保できない。
      // 本変更の目的は claude の欠測を塞ぐことなので、塞がった状態をフックが見る出力面で確認する。
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { contextWindowTokens: 300_000 } },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000);

      const { out, exit } = await runCheck(session.id);
      expect(exit).toBe(0);
      expect(out).toBe("");
      expect(ctx.stderr.text()).not.toContain("軸 contextSaturation を判定できません");
    });
  });

  describe("4軸: handoffValue（損益分岐ターン数 N。D2 cross-validation）", () => {
    it("導出 S で contextTokens=195,386 → N<30 → notice", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 195_385);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("notice");
      expect(payload.firedAxes).toEqual(["handoffValue"]);
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(30, 3);
    });

    it("導出 S で contextTokens=242,463 → N<20 → recommend", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 242_462);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("recommend");
      expect(payload.firedAxes).toEqual(["handoffValue"]);
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(20, 3);
    });

    it("導出 S で contextTokens=383,694 → N<10 → urgent", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 383_693);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBe("urgent");
      expect(payload.firedAxes).toEqual(["handoffValue"]);
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(10, 3);
    });

    it("C<=C0（損益分岐点なし）のとき unmeasured は cost-model-floor-not-exceeded になり、stderr には出ない", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // contextTokens=1,001 <= c0(101,231) なので損益分岐点が存在しない（良性の not-applicable）。
      seedClaudeLog(3, 1_000);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      const axis = payload.axes?.find((entry) => entry.axis === "handoffValue");
      expect(axis?.unmeasured).toEqual({ reason: "cost-model-floor-not-exceeded" });

      await runCheck(session.id);
      const err = ctx.stderr.text();
      expect(err).not.toContain("cost-model-floor-not-exceeded");
      expect(err).not.toContain("軸 handoffValue を判定できません");
    });
  });

  describe("F1: cache read 単価をモデル別に引く（レビュー指摘 #1 のリワーク）", () => {
    it("直近 Sonnet と累計最大 Fable が混在しても Sonnet の S/r で N を導く", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const path = seedClaudeLog(1, 1);
      // 過去 Fable は活動量 300,001 で累計最大。直近 Sonnet は contextTokens=231,231 を作る。
      // S と r はどちらも直近 Sonnet の単価を使い、累計最大 Fable へ寄せない。
      writeJsonl(path, [
        claudeRow(0, 300_000, 10, "claude-fable-5"),
        claudeRow(1, 231_230, 10, "claude-sonnet-5"),
      ]);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.contextModel).toBe("claude-sonnet-5");
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(
        expectedHandoffValueN(231_231, DEFAULT_SONNET_COST_MODEL, CLAUDE_SONNET_5_PRICE.cacheRead)!,
        12,
      );
      expect(payload.measurement?.handoffValueCacheReadCostPerToken).toBe(0.2e-6);
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("context-model");
      expect(payload.stage).toBe("ok");
      expect(payload.firedAxes).toEqual([]);
    });

    it("単一モデルのセッションは同モデルの S/r で N を導く", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 231_230, 10, "claude-sonnet-5");

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(
        expectedHandoffValueN(231_231, DEFAULT_SONNET_COST_MODEL, CLAUDE_SONNET_5_PRICE.cacheRead)!,
        12,
      );
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("context-model");
      expect(payload.stage).toBe("ok");
    });

    it("contextModel が価格表に無ければ dominant へ落ち、JSON とテキストへ出所を記録する", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const path = seedClaudeLog(1, 1);
      writeJsonl(path, [
        claudeRow(0, 300_000, 10, "claude-sonnet-5"),
        claudeRow(1, 231_230, 10, "unknown-latest-model"),
      ]);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.contextModel).toBe("unknown-latest-model");
      expect(payload.measurement?.handoffValueTurns).toBeUndefined();
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("dominant");
      const output = await run(["orchestrator", "usage", "--session", session.id]);
      expect(output).toContain("source=dominant");
    });

    it("contextModel が観測できなければ dominant へ落ちる（累計から contextModel 自体は推測しない）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const path = seedClaudeLog(1, 1);
      const latest = claudeRow(1, 231_230, 10, "unused-placeholder");
      const latestMessage = latest.message as Record<string, unknown>;
      delete latestMessage.model;
      writeJsonl(path, [claudeRow(0, 300_000, 10, "claude-sonnet-5"), latest]);

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.contextModel).toBeUndefined();
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(
        expectedHandoffValueN(231_231, DEFAULT_SONNET_COST_MODEL, CLAUDE_SONNET_5_PRICE.cacheRead)!,
        12,
      );
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("dominant");
    });

    it("Codex の turn_context.model が欠落したら session_meta から補完せず dominant へ落ちる", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(1, 231_231, {
        omitTurnContextModel: true,
        sessionMetaModel: "gpt-5.6-sol",
      });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.contextModel).toBeUndefined();
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("dominant");
    });

    it("cache read が一度も発生していない（cache write のみ）セッションでも、既知モデルなら代表単価が引ける", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // 累計 cacheReadTokens=0(cache read 行が1件も無い)だが、cache write(cache_creation)が
      // 大きいため contextTokens=231,231 を作れる。旧実装(cacheReadTokens の大小だけで代表を選ぶ)
      // はここで代表モデルを選べず既定単価(0.5e-6)へフォールバックし N=30 になっていた。
      // 新実装は入出力/cache write の活動量からも代表モデルを特定できるため、claude-sonnet-5 の
      // 実測された Sonnet の write/read 単価で S と N を導く。
      seedClaudeCacheCreationLog(231_230, "claude-sonnet-5");

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.handoffValueTurns).toBeCloseTo(
        expectedHandoffValueN(231_231, DEFAULT_SONNET_COST_MODEL, CLAUDE_SONNET_5_PRICE.cacheRead)!,
        12,
      );
      expect(payload.measurement?.handoffValueCacheReadPriceSource).toBe("context-model");
      expect(payload.stage).toBe("ok");
    });
  });

  describe("4軸: effectiveCostUsd（価格表に無いモデル）", () => {
    it("1モデルでも価格表に無ければ effectiveCostUsd を出さず unpricedModels を表示する", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(3, 1_000, { model: "unknown-model-x" });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.measurement?.effectiveCostUsd).toBeUndefined();
      expect(payload.measurement?.unpricedModels).toEqual(["unknown-model-x"]);

      const text = await run(["orchestrator", "usage", "--session", session.id]);
      expect(text).toContain("実効コスト=不明（価格表に無いモデル: unknown-model-x）");

      // 価格表に無いモデルのときは unmeasured.reason=cost-model-unpriced が付く（missing 分類。
      // contextSaturation で塞いだのと同じ形の silent dropout をここで塞いだ）。
      const axis = payload.axes?.find((entry) => entry.axis === "effectiveCostUsd");
      expect(axis?.unmeasured).toEqual({ reason: "cost-model-unpriced" });
    });

    it("--check の stderr に理由行が出る。stdout の行数契約・exit code は不変", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // turns=3(ok)・contextSaturation は既定の model_context_window で ok 範囲・
      // handoffValue は contextTokens<=c0 で not-applicable（stderr に出ない）。
      // effectiveCostUsd だけが unpriced で missing になる、他軸への影響が無い fixture。
      seedCodexLog(3, 1_000, { model: "unknown-model-x" });

      const { out, exit } = await runCheck(session.id);

      // stage=ok のまま：effectiveCostUsd は判定から除外されるだけで、stdout 契約・exit code は動かない。
      expect(exit).toBe(0);
      expect(out).toBe("");
      const err = ctx.stderr.text();
      expect(err).toContain("軸 effectiveCostUsd を判定できません");
      expect(err).toContain("cost-model-unpriced");
      expect(err).toContain("使用モデルが価格表に無く、コストを算出できません");
      // 直し方まで書く。ヒントの無い警告は毎回同じ文面で出続けるだけになり読まれなくなる（playbook §0.7.2）。
      expect(err).toContain("node scripts/update-model-prices.mjs");
    });

    it("価格表にあるモデルへ戻せば --check の欠測行そのものが消える（肯定側）", async () => {
      // 欠測時に出ること（上のテスト）だけでは「価格表にあれば黙る」ことは担保できない。
      // 塞いだ状態をフックが見る出力面で確認する。
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      seedCodexLog(3, 1_000, { model: "gpt-5.6-sol" });

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe("");
      expect(ctx.stderr.text()).not.toContain("軸 effectiveCostUsd を判定できません");
    });
  });

  describe("推測しない", () => {
    it("provider session id が未登録なら unknown を返す", async () => {
      ctx = createTestDeps();
      const session = startSession("", "");

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.stage).toBeNull();
      expect(payload.reason).toBe("provider-session-id-unregistered");
      // 推測値を出さない。数値は一切載せない。
      expect(payload.measurement).toBeNull();
    });

    it("ログが無ければ unknown を返す（0 ターンと言わない）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      ctx.deps.nativeUsageRoots = { claudeProjectsRoot: join(makeRoot(), "projects") };

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.stage).toBeNull();
      expect(payload.reason).toBe("log-not-found");
      expect(payload.measurement).toBeNull();
    });

    it("テキスト出力でも段階を断定しない", async () => {
      ctx = createTestDeps();
      const session = startSession("", "");

      const text = await run(["orchestrator", "usage", "--session", session.id]);

      expect(text).toContain("stage=unknown");
      expect(text).toContain("推測値は出しません");
    });

    it("config の sessionBudget 上書きが不正でもクラッシュせず unknown を返す（fail-open）", async () => {
      // notice(500) は既定 recommend(100) を上回るため resolveSessionBudgetThresholds が
      // notice<=recommend<=urgent 違反で throw する。measure() 側で catch できていないと
      // withErrorHandling まで伝播し deps.exit(1) が呼ばれる（契約外の終了コード）。
      ctx = createTestDeps();
      const configOverride: HachiConfig = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { turns: { notice: 500 } } },
      };
      ctx.deps.config = configOverride;
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000);

      ctx.exitCodes.length = 0;
      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      // withErrorHandling の catch（exit(1)）まで落ちていないことを確認する。
      expect(ctx.exitCodes).toEqual([]);
      expect(payload.stage).toBeNull();
      expect(payload.reason).toBe("session-budget-config-invalid");
      expect(payload.measurement).toBeNull();
      expect(payload.exitCode).toBe(0);
    });

    it("集約3軸が全欠測でも専用 reason と turns を含む計測結果を保持する", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // claude は context window を観測できず、序盤なので N は not-applicable、未知モデルなので cost も欠測する。
      seedClaudeLog(3, 1_000, 10, "unknown-model-x");

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);

      expect(payload.stage).toBeNull();
      expect(payload.reason).toBe("all-aggregated-axes-unmeasured");
      expect(payload.measurement?.turns).toBe(3);
      expect(payload.axes?.find((axis) => axis.axis === "turns")).toMatchObject({
        value: 3,
        stage: "ok",
        informational: true,
      });

      const text = await run(["orchestrator", "usage", "--session", session.id]);
      expect(text).toContain("stage=unknown reason=all-aggregated-axes-unmeasured");
      expect(text).toContain("turns=3 -> ok [informational: 総合判定には不使用]");

      const { out, exit } = await runCheck(session.id);
      expect(exit).toBe(0);
      expect(out).toBe("");
      const err = ctx.stderr.text();
      expect(err).toContain("all-aggregated-axes-unmeasured");
      expect(err).toContain("orchestrator.sessionBudget.contextWindowTokens");
      expect(err).toContain("node scripts/update-model-prices.mjs");
    });
  });

  describe("--check の終了コードと出力", () => {
    it("ok は exit 0 で無出力（フックを静かに保つ）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000);

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe("");
      expect(out).not.toContain("idle:");
    });

    it("idle の引き継ぎ推奨を1行追加し、既存 stage の exit code は変えない", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { costModel: { c0: 100, cacheTtlSeconds: 300 } } },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 100_000);

      const { out, exit } = await runCheck(session.id);
      const idleLines = out.trimEnd().split("\n").filter((line) => line.startsWith("idle:"));

      expect(exit).toBe(12);
      expect(idleLines).toEqual([
        "idle: TTL 超の待ちに入るなら $0.63 の書き直し。引き継げば $0.22 節約 → handoff-before-idle",
      ]);
    });

    it("stage=null でも idle の引き継ぎ推奨が計測できれば1行出す", async () => {
      ctx = createTestDeps();
      ctx.deps.config = {
        ...ctx.deps.config,
        orchestrator: {
          sessionBudget: { costModel: { s: 0.1, cacheTtlSeconds: 300 } },
        },
      };
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const root = makeRoot();
      const projectsRoot = join(root, "projects");
      const path = join(projectsRoot, "-Users-someone-worktrees-example", `${CLAUDE_SESSION_ID}.jsonl`);
      writeJsonl(path, [
        claudeRow(0, 1, 10, "unknown-model-x"),
        claudeRow(1, 100_000),
      ]);
      ctx.deps.nativeUsageRoots = { claudeProjectsRoot: projectsRoot };

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.stage).toBeNull();
      expect(payload.recommendation?.idle.action).toBe("handoff-before-idle");

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe(
        "idle: TTL 超の待ちに入るなら $0.63 の書き直し。引き継げば $0.53 節約 → handoff-before-idle\n",
      );
    });

    it("判定不能は exit 0 のまま（fail-open）だが、理由を必ず出す", async () => {
      // 無出力 + exit 0 は「消費 ok」と区別できず、壊れた計測が健全に見える。
      // 実際 provider session id の登録漏れに気付かないままセッションを使い続けた事例がある。
      ctx = createTestDeps();
      const session = startSession("", "");

      const { exit } = await runCheck(session.id);

      expect(exit).toBe(0); // 計測できないことでオーケストレーターを止めない
      const err = ctx.stderr.text();
      expect(err).toContain("判定できません");
      expect(err).toContain("provider-session-id-unregistered");
      expect(err).toContain("ok ではありません");
    });

    it("判定不能のうち自分で直せるものは対処方法を出す", async () => {
      ctx = createTestDeps();
      const session = startSession("", "");

      await runCheck(session.id);

      expect(ctx.stderr.text()).toContain("--provider-session-id");
    });

    it("config の sessionBudget 上書きが不正でも --check は exit 0 のまま（fail-open）で理由を出す", async () => {
      // 契約: --check は判定不能で必ず exit 0（ファイル冒頭コメント）。config 自体が壊れていても
      // measure() が catch せず throw を伝播させると withErrorHandling が deps.exit(1) を呼び、
      // SESSION_BUDGET_EXIT_CODES に無い契約外コードでフックから見て原因不明のクラッシュになる。
      ctx = createTestDeps();
      const configOverride: HachiConfig = {
        ...ctx.deps.config,
        orchestrator: { sessionBudget: { turns: { notice: 500 } } },
      };
      ctx.deps.config = configOverride;
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 1_000);

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0); // 計測できないことでオーケストレーターを止めない
      expect(out).toBe("");
      const err = ctx.stderr.text();
      expect(err).toContain("判定できません");
      expect(err).toContain("session-budget-config-invalid");
      expect(err).toContain("ok ではありません");
    });

    it("turns だけが閾値を超えて総合が ok のとき、--check の引き継ぎ理由に turns を一切出さない", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // 集約対象は contextSaturation=未計測・handoffValue=not-applicable・effectiveCostUsd=ok。
      // turns 自身は recommend だが、引き継ぎを促す理由にはしない。
      seedClaudeLog(100, 1_000);

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe("");
      const err = ctx.stderr.text();
      expect(err).not.toContain("turns");
      expect(err).not.toContain("引き継ぎを検討");
      expect(err).not.toContain("引き継ぎをユーザーへ提案");
    });

    it("notice は exit 10 で1行。N が計算不能なら N=- を出す", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextSaturation=60% で notice。contextTokens=60,000<=c0 のため N は計算不能。
      seedCodexLog(3, 60_000, { modelContextWindow: 100_000 });

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(10);
      expect(out.trimEnd().split("\n")).toHaveLength(1);
      expect(out.startsWith("[codex/gpt-5.6-sol/unset] ")).toBe(true);
      expect(out).toContain("notice");
      expect(out).toContain("contextSaturation=60% (>=60%)");
      expect(out).toContain("N=-");
    });

    it("stdout が非空のとき、書き込み順は stdout → stderr になる（フックの抑制キーが先頭1行から作られるため）", async () => {
      // hachi-orchestrator-usage-check.sh（このリポジトリ外）は stdout+stderr を 2>&1 でマージし、
      // 先頭1行から抑制キーを作って15分間同じ通知を抑制する。stderr の missing 軸の行が stdout より
      // 先に書かれると、段階が変わっても先頭行（stderr側）が変わらず再通知が抑制されてしまう
      // （playbook §0.7.3.2「段階が変われば必ず再通知される」という約束を壊す）。
      // ここでは deps.stdout/stderr.write をテスト専用にラップし、呼ばれた順序だけを記録する
      // （CliDeps のインターフェースは変えず、BufferWriter 本体の蓄積挙動もそのまま活かす）。
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextSaturation=60% で notice が発火し stdout が非空になる。価格表に無いモデルを使い、
      // effectiveCostUsd は missing として stderr に出る。
      seedCodexLog(3, 60_000, { model: "unknown-model-x", modelContextWindow: 100_000 });

      const order: Array<"stdout" | "stderr"> = [];
      const originalStdoutWrite = ctx.deps.stdout.write.bind(ctx.deps.stdout);
      const originalStderrWrite = ctx.deps.stderr.write.bind(ctx.deps.stderr);
      ctx.deps.stdout.write = (text: string): void => {
        order.push("stdout");
        originalStdoutWrite(text);
      };
      ctx.deps.stderr.write = (text: string): void => {
        order.push("stderr");
        originalStderrWrite(text);
      };

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(10);
      expect(out).not.toBe("");
      expect(order).toEqual(["stdout", "stderr", "stderr"]);
      // 呼び出し順序だけでなく、それぞれの中身も従来どおり確認する。
      expect(out).toContain("notice");
      const err = ctx.stderr.text();
      expect(err).toContain("軸 effectiveCostUsd を判定できません");
    });

    it("notice では発火していない N も常に出す（値が算出できるとき）", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextSaturation=約61% で notice。contextTokens=121,231 の N（gpt-5.6-sol の cache read 単価で導出）は既定 notice=30 より安全域。
      seedCodexLog(3, 121_231, { modelContextWindow: 200_000 });

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(10);
      expect(out.trimEnd().split("\n")).toHaveLength(1);
      expect(out).toContain("contextSaturation=61% (>=60%)");
      // 実装は N を小数第1位まで出す（整数へ丸めると閾値ちょうどに達したように読めるため）。
      expect(out).toContain(
        `N=${(expectedHandoffValueN(121_231, DEFAULT_CODEX_COST_MODEL, GPT_5_6_SOL_PRICE.cacheRead) ?? Number.NaN).toFixed(1).replace(/\.0$/, "")}`,
      );
      expect(out).not.toContain("N=-");
    });

    it("remaining.breakdown を JSON と --check の R 内訳に1回だけ出す", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      const todo = ctx.deps.store.createTask(
        { title: "todo", body: "cwd: /repo/todo", tenant: "dev", status: "todo" },
        "test",
      );
      ctx.deps.store.bindTaskToOrchestrator(todo.id, session.orchestratorId, "primary");
      seedCodexLog(3, 60_000, { modelContextWindow: 100_000 });

      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.remaining).toMatchObject({
        r: DEFAULT_SESSION_TURNS_PER_TASK,
        rBasis: "scoped-with-todo",
        breakdown: { todo: 1, ready: 0, inProgress: 0, review: 0, inbox: 0 },
      });
      expect(payload.recommendation?.r).toBe(DEFAULT_SESSION_TURNS_PER_TASK);

      const { out, exit } = await runCheck(session.id);
      expect(exit).toBe(10);
      expect(out).toContain("R=8 (todo 1 / ready 0 / in-progress 0 / review 0 / inbox 0)");
      expect(out.match(/\(todo 1 \/ ready 0 \/ in-progress 0 \/ review 0 \/ inbox 0\)/g)).toHaveLength(1);
    });

    it("recommend は exit 11 で3行以内、ミッション task ID を含める", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const mission = ctx.deps.store.createTask(
        { title: "ミッション本体", body: "", tenant: "dev", status: "triage" },
        "test",
      ).id;
      ctx.deps.store.addOrchestratorWatch({
        orchestratorId: session.orchestratorId, scope: "subtree", selector: mission, role: "primary",
      });
      seedClaudeLog(3, 0, 400_000);

      const { out, exit } = await runCheck(session.id);
      const lines = out.trimEnd().split("\n");

      expect(exit).toBe(11);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines[0]).toContain("recommend");
      expect(out).toContain(mission);
      // stage だけで引き継ぎを促さず、N 未定義なら recommendation=continue を優先する。
      expect(out).toContain("このセッションを継続");
    });

    /** headline に contextSaturation が現れたかで、その軸が発火したかを判定する。 */
    const evaluationFiredContextSaturation = (out: string): boolean => out.includes("contextSaturation=");

    it("urgent は exit 12 で3行以内。文脈以外の軸が引き金なら文脈欠落に言及しない", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      // 導出 S の urgent 点（contextTokens=383,694 → N<10）で駆動する。
      seedClaudeLog(3, 383_693);

      const { out, exit } = await runCheck(session.id);
      const lines = out.trimEnd().split("\n");

      expect(exit).toBe(12);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines[0]).toContain("urgent");
      expect(lines[0]).toContain("N=10 (<=10)");
      // 発火軸は handoffValue であって contextSaturation ではない。文脈が溢れている根拠が無いのに
      // 「序盤の指示が失われている」と断じると、誤った理由で判断させることになる。
      expect(evaluationFiredContextSaturation(out)).toBe(false);
      expect(out).not.toContain("失われている可能性");
    });

    it("urgent は exit 12 で3行以内。contextSaturation が引き金なら『失われている可能性』の文言が出る", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      // contextWindowTokens=100,000・contextTokens=90,000 → 90% ≧ urgent閾値0.85。
      // contextTokens(90,000) <= c0(101,231) なので handoffValue は not-applicable のまま urgent を発火しない。
      // turns=3(<60)・effectiveCostUsd も僅少（<15）で ok のまま。firedAxes=["contextSaturation"] だけになる。
      seedCodexLog(3, 90_000, { modelContextWindow: 100_000 });

      const { out, exit } = await runCheck(session.id);
      const lines = out.trimEnd().split("\n");

      expect(exit).toBe(12);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(evaluationFiredContextSaturation(out)).toBe(true);
      expect(out).toContain("失われている可能性");

      // 上記はテキスト出力の間接判定に留まるため、--json で firedAxes を直接断言し、
      // 「contextSaturation だけが発火する」という設計意図をリグレッションに強く検出する。
      const payload = await runJson(["orchestrator", "usage", "--session", session.id]);
      expect(payload.firedAxes).toEqual(["contextSaturation"]);
    });

    it("subtree watch が無ければミッション行を省いて2行にする", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 0, 400_000);

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(11);
      expect(out.trimEnd().split("\n")).toHaveLength(2);
    });
  });

  describe("フラグの優先順位", () => {
    it("--check は --json より優先し、フック用の体裁のままにする", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(3, 383_693);

      ctx.exitCodes.length = 0;
      const out = await run(["orchestrator", "usage", "--session", session.id, "--check", "--json"]);

      expect(ctx.exitCodes.at(-1)).toBe(12);
      expect(out).toContain("[hachi] セッション消費 urgent");
      expect(() => JSON.parse(out)).toThrow();
    });
  });

  describe("判定不能は fail-open", () => {
    it("provider session id が未登録でも exit 0 で静かに抜ける", async () => {
      ctx = createTestDeps();
      const session = startSession("", "");

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe("");
    });

    it("ログが無くても exit 0 で静かに抜ける", async () => {
      ctx = createTestDeps();
      const session = startSession("codex", CODEX_SESSION_ID);
      ctx.deps.nativeUsageRoots = { codexSessionsRoot: join(makeRoot(), "sessions") };

      const { out, exit } = await runCheck(session.id);

      expect(exit).toBe(0);
      expect(out).toBe("");
    });

    it("session 自体が無くても exit 0 で静かに抜ける（計測不能で止めない）", async () => {
      ctx = createTestDeps();

      const { out, exit } = await runCheck("os_missing");

      expect(exit).toBe(0);
      expect(out).toBe("");
    });
  });

  describe("読み取り専用", () => {
    it("ネイティブログを書き換えない", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      const path = seedClaudeLog(120, 200_000);
      // mtime は秒境界で揺れるため、内容そのもの（hash とサイズ）で固定する。
      const before = readFileSync(path);
      const beforeHash = createHash("sha256").update(before).digest("hex");

      await run(["orchestrator", "usage", "--session", session.id, "--json"]);
      await runCheck(session.id);

      const after = readFileSync(path);
      expect(createHash("sha256").update(after).digest("hex")).toBe(beforeHash);
      expect(statSync(path).size).toBe(before.byteLength);
    });

    it("session row を書き換えない（heartbeat も generation も動かさない）", async () => {
      ctx = createTestDeps();
      const session = startSession("claude", CLAUDE_SESSION_ID);
      seedClaudeLog(5, 1_000);

      await run(["orchestrator", "usage", "--session", session.id, "--json"]);

      expect(ctx.deps.store.getOrchestratorSession(session.id)).toEqual(session);
    });
  });
});
