import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hachiConfigSchema } from "./config-schema.js";
import { resolveEnvironment } from "./env.js";
import {
  isCommunicationCanaryEligible,
  listAllowlistedModels,
  loadConfig,
  resolveCommunicationProviderConfig,
  resolveExecution,
  resolveModel,
} from "./policy.js";
import {
  DEFAULT_CODEX_SUCCESSOR_ATTESTATION_MODE,
  type Environment,
  type HachiConfig,
  type TaskRow,
} from "./types.js";

interface ConfigWithVerify extends HachiConfig {
  verify?: {
    tenants: Record<string, string>;
  };
}

interface NotifyConfigForTest {
  transports?: string[];
  telegram?: {
    chatId?: string;
    baseUrl?: string;
    minPriority?: number;
  };
}

interface HachiConfigWithNotify extends HachiConfig {
  notify?: NotifyConfigForTest;
}

interface ConfigWithReview extends HachiConfig {
  review?: {
    maxReworkLaunches?: number;
  };
}

interface ConfigWithDispatch extends HachiConfig {
  dispatch?: {
    providerLaunchLimits?: {
      codex?: number;
      claude?: number;
    };
  };
}

interface HachiConfigWithSteward extends HachiConfig {
  steward?: {
    intervalMinutes?: number;
  };
}

interface HachiConfigWithBrief extends HachiConfig {
  brief?: {
    times: string[];
  };
}

function buildEnv(home: string): Environment {
  return resolveEnvironment({ HACHI_KANBAN_HOME: home });
}

function buildRuntimeProfileConfig(): Record<string, unknown> {
  return {
    profiles: { solo: { provider: "codex", model: "gpt-5.6-sol" } },
    allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
    resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
    defaultProfile: "solo",
    runtimeResources: {
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      dockerContext: "hachi-test",
      worktreePostgres: {
        image: "postgres:16",
        containerPort: 5432,
        healthCheck: {
          command: ["pg_isready"],
          intervalMs: 1000,
          timeoutMs: 1000,
          retries: 3,
        },
      },
      projects: [
        {
          project: "hachi-kanban",
          repoCommonDir: "/repo/.git",
          profiles: [
            {
              id: "postgres-v1",
              bundleKind: "worktree_postgres",
              hostAdapter: "worktreePostgres",
            },
          ],
        },
      ],
    },
  };
}

function buildTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_00000000",
    title: "テストタスク",
    body: "",
    status: "ready",
    priority: 0,
    tenant: "",
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

describe("loadConfig", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("config.json が無ければ既定値を返す（docs/contract.md §7）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const config = loadConfig(buildEnv(tempRoot));

    expect(config.defaultProfile).toBe("implement");
    expect(config.profiles.review).toEqual({ provider: "codex", model: "gpt-5.6-sol", effort: "high" });
    expect(config.profiles.implement).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      effort: "max",
      speed: "standard",
    });
    expect(config.profiles.docs).toEqual({ provider: "codex", model: "gpt-5.6-luna", effort: "high" });
    expect(config.allowlist.codex).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
    ]);
    expect(config.allowlist.claude).toContain("claude-opus-5");
    expect(config.modelTransportPolicies).toContainEqual({
      id: "codex-direct-gpt-5.6-sol-local-2026-07-11",
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "direct",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard"],
    });
    expect(resolveExecution(buildTask(), config, "worker")).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      source: "default",
      transport: "direct",
      effort: "max",
      speed: "standard",
    });
    expect(config.modelTransportPolicies).toContainEqual({
      id: "codex-direct-gpt-5.6-luna-local-2026-07-11",
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard", "fast"],
    });
    expect(config.modelTransportPolicies).toContainEqual({
      id: "claude-direct-claude-opus-5-local-2026-08-18",
      provider: "claude",
      model: "claude-opus-5",
      transport: "direct",
      minimumRuntimeVersion: "2.1.226",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      supportedSpeeds: ["standard", "fast"],
    });
    const directSpeedPolicies = new Map(
      config.modelTransportPolicies
        ?.filter((policy) => policy.provider === "codex" && policy.transport === "direct")
        .map((policy) => [policy.model, policy.supportedSpeeds] as const),
    );
    expect(directSpeedPolicies.get("gpt-5.6-sol")).toEqual(["standard"]);
    expect(directSpeedPolicies.get("gpt-5.6-terra")).toEqual(["standard", "fast"]);
    expect(directSpeedPolicies.get("gpt-5.6-luna")).toEqual(["standard", "fast"]);
  });

  it("max/speed と provider native communication のstrict設定を読み込む", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: {
        implement: {
          provider: "codex",
          model: "gpt-5.6-sol",
          transport: "direct",
          effort: "max",
          speed: "fast",
        },
      },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      modelTransportPolicies: [{
        id: "codex-fast",
        provider: "codex",
        model: "gpt-5.6-sol",
        transport: "direct",
        minimumRuntimeVersion: "0.144.1",
        supportedEfforts: ["max"],
        supportedSpeeds: ["fast"],
      }],
      communication: {
        codex: { rollout: "observe", minimumRuntimeVersion: "0.144.1", sameHostOnly: true },
      },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

    const config = loadConfig(buildEnv(tempRoot));
    expect(config.profiles.implement).toMatchObject({ effort: "max", speed: "fast" });
    expect(config.communication?.codex).toEqual({
      rollout: "observe",
      minimumRuntimeVersion: "0.144.1",
      sameHostOnly: true,
    });

    custom.communication.codex = { ...custom.communication.codex, unexpected: true } as typeof custom.communication.codex;
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/unrecognized/i);
  });

  it("orchestrator.sessionBudget を軸ごとに読み込み、未知キーは fail-closed で弾く（playbook §0.7）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom: Record<string, unknown> = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
      // 軸ごと・段階ごとの部分指定を受理する（additive）。
      orchestrator: { sessionBudget: { turns: { notice: 40 }, effectiveCostUsd: { urgent: 45 } } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(loadConfig(buildEnv(tempRoot)).orchestrator?.sessionBudget).toEqual({
      turns: { notice: 40 },
      effectiveCostUsd: { urgent: 45 },
    });

    // costModel（損益分岐計算の c0/s）も軸と同じく round-trip する。
    custom.orchestrator = { sessionBudget: { costModel: { c0: 90_000, s: 1.2 } } };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(
      loadConfig(buildEnv(tempRoot)).orchestrator?.sessionBudget?.costModel,
    ).toEqual({ c0: 90_000, s: 1.2 });

    // contextWindowTokens（contextSaturation の分母。claude では観測できないため config で上書きする）も round-trip する。
    custom.orchestrator = { sessionBudget: { contextWindowTokens: 200_000 } };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(
      loadConfig(buildEnv(tempRoot)).orchestrator?.sessionBudget?.contextWindowTokens,
    ).toBe(200_000);

    // 0 や負の値は fail-closed で throw する（costModel の c0/s と同じ厳しさ）。
    custom.orchestrator = { sessionBudget: { contextWindowTokens: 0 } };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow();

    custom.orchestrator = { sessionBudget: { contextWindowTokens: -100 } };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow();

    // orchestrator を省略した config も従来どおり有効。
    delete custom.orchestrator;
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(loadConfig(buildEnv(tempRoot)).orchestrator).toBeUndefined();

    // 未知の軸名を黙って無視すると「設定したのに効かない」が起きるため throw する。
    custom.orchestrator = { sessionBudget: { unknownAxis: { notice: 1 } } };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/unrecognized/i);
  });

  describe("orchestrator.sessionBudget の旧キー（cumulativeInputTokens / contextTokens）", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
      stderrSpy?.mockRestore();
      stderrSpy = undefined;
    });

    it("旧キーが残っていても throw せず、値を削除して読み込む（21172f2 で廃止・互換変換しない）", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
      const custom = {
        profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
        allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "implement",
        orchestrator: {
          sessionBudget: {
            turns: { notice: 40 },
            cumulativeInputTokens: { notice: 1 },
            contextTokens: { notice: 1 },
          },
        },
      };
      writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

      let config: HachiConfig | undefined;
      expect(() => {
        config = loadConfig(buildEnv(tempRoot));
      }).not.toThrow();

      expect(config?.orchestrator?.sessionBudget).toEqual({ turns: { notice: 40 } });
      expect(config?.orchestrator?.sessionBudget).not.toHaveProperty("cumulativeInputTokens");
      expect(config?.orchestrator?.sessionBudget).not.toHaveProperty("contextTokens");
    });

    it("同じ config を2回読み込んでも警告は合計1回だけ stderr に出る", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
      const custom = {
        profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
        allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "implement",
        orchestrator: {
          sessionBudget: {
            cumulativeInputTokens: { notice: 1 },
            contextTokens: { notice: 1 },
          },
        },
      };
      writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // 「一度きり警告」フラグはモジュールスコープであり、同じファイル内の他テストが
      // 先に旧キーを読み込んでいると状態が汚染される。resetModules + 動的import で
      // このテスト専用の新規モジュールインスタンスを取得し、テスト順序に依存させない。
      vi.resetModules();
      const freshPolicy = await import("./policy.js");

      freshPolicy.loadConfig(buildEnv(tempRoot));
      freshPolicy.loadConfig(buildEnv(tempRoot));

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const warnedMessage = stderrSpy.mock.calls[0]?.[0];
      expect(warnedMessage).toEqual(expect.stringContaining("cumulativeInputTokens"));
      expect(warnedMessage).toEqual(expect.stringContaining("contextTokens"));
      expect(warnedMessage).toEqual(expect.stringContaining("§0.7"));
    });

    it("旧キーに加えて本当に未知のキーが混在した場合は従来どおり throw する", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
      const custom = {
        profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
        allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "implement",
        orchestrator: {
          sessionBudget: {
            cumulativeInputTokens: { notice: 1 },
            someOtherJunk: 1,
          },
        },
      };
      writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");
      expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/unrecognized/i);
    });
  });

  it("orchestrator.sessionBudget.contextWindowTokens は正の整数だけを受理する（凍結契約の宣言と一致させる）", () => {
    // 非有限値の拒否は .finite() ではなく z.number() 自身が担っている（Infinity は invalid_type に
    // なる）。したがって「Infinity が弾かれること」を見ても contextWindowTokens 固有の制約は
    // 何も固定できない。ここで固定するのは types.ts が宣言している「正の整数のみ受理する」の方。
    const base = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };
    // 対照: orchestrator を持たない base 自体は妥当（失敗が別の理由で起きていないことを担保する）。
    expect(hachiConfigSchema.safeParse(base).success).toBe(true);

    const withTokens = (contextWindowTokens: unknown): ReturnType<typeof hachiConfigSchema.safeParse> =>
      hachiConfigSchema.safeParse({ ...base, orchestrator: { sessionBudget: { contextWindowTokens } } });

    // 整数は通る。
    expect(withTokens(1_000_000).success).toBe(true);

    // 小数・0・負・非有限はいずれも弾き、必ず contextWindowTokens 自身が原因であることまで見る。
    for (const invalid of [1.5, 0, -1, Number.POSITIVE_INFINITY]) {
      const result = withTokens(invalid);
      expect(result.success, `${String(invalid)} は弾かれるべき`).toBe(false);
      if (result.success) {
        continue;
      }
      expect(result.error.issues[0]?.path).toEqual(["orchestrator", "sessionBudget", "contextWindowTokens"]);
    }
  });

  it("orchestrator.codexSuccessorAttestation は manual/enforce だけを受理し、省略時は manual と解釈する", () => {
    const base = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };

    const withoutAttestation = hachiConfigSchema.parse(base);
    expect(
      withoutAttestation.orchestrator?.codexSuccessorAttestation?.mode
        ?? DEFAULT_CODEX_SUCCESSOR_ATTESTATION_MODE,
    ).toBe("manual");

    for (const mode of ["manual", "enforce"] as const) {
      const parsed = hachiConfigSchema.parse({
        ...base,
        orchestrator: { codexSuccessorAttestation: { mode } },
      });
      expect(parsed.orchestrator?.codexSuccessorAttestation?.mode).toBe(mode);
    }

    expect(hachiConfigSchema.safeParse({
      ...base,
      orchestrator: { codexSuccessorAttestation: { mode: "observe" } },
    }).success).toBe(false);
    expect(hachiConfigSchema.safeParse({
      ...base,
      orchestrator: { codexSuccessorAttestation: { mode: "manual", unexpected: true } },
    }).success).toBe(false);
  });

  it("direct.stall は provider 別に読み込み、省略・不在の config も従来どおり有効とする（契約 §50.2）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const base = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };

    // direct を持たない既存 config はそのまま valid（additive であることの確認）。
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(base), "utf8");
    expect(loadConfig(buildEnv(tempRoot)).direct).toBeUndefined();

    writeFileSync(
      join(tempRoot, "config.json"),
      JSON.stringify({
        ...base,
        direct: {
          stall: {
            codex: { outputStallSeconds: 900, maxRuntimeSeconds: 5400 },
            claude: { outputStallSeconds: 2700 },
          },
        },
      }),
      "utf8",
    );
    const config = loadConfig(buildEnv(tempRoot));
    expect(config.direct?.stall?.codex).toEqual({ outputStallSeconds: 900, maxRuntimeSeconds: 5400 });
    // provider 単位で片方の項目だけ上書きできる（欠落は supervisor 既定へ委譲する）。
    expect(config.direct?.stall?.claude).toEqual({ outputStallSeconds: 2700 });

    // strict: 未知キーと非正の秒数は fail-closed で throw する。
    writeFileSync(
      join(tempRoot, "config.json"),
      JSON.stringify({ ...base, direct: { stall: { codex: { unexpected: 1 } } } }),
      "utf8",
    );
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/unrecognized/i);

    writeFileSync(
      join(tempRoot, "config.json"),
      JSON.stringify({ ...base, direct: { stall: { codex: { outputStallSeconds: 0 } } } }),
      "utf8",
    );
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it.each(["canary", "on"] as const)(
    "communication rollout=%s はminimumRuntimeVersionとsameHostOnly=trueを必須にする",
    (rollout) => {
      tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
      const base = {
        profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
        allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "implement",
      };

      writeFileSync(join(tempRoot, "config.json"), JSON.stringify({
        ...base,
        communication: { codex: { rollout } },
      }), "utf8");
      expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/minimumRuntimeVersion.*必須/);

      writeFileSync(join(tempRoot, "config.json"), JSON.stringify({
        ...base,
        communication: {
          codex: { rollout, minimumRuntimeVersion: "0.144.1", sameHostOnly: false },
        },
      }), "utf8");
      expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/sameHostOnly=true.*必須/);

      writeFileSync(join(tempRoot, "config.json"), JSON.stringify({
        ...base,
        communication: {
          codex: {
            rollout,
            minimumRuntimeVersion: "0.144.1",
            sameHostOnly: true,
            ...(rollout === "canary" ? { canaryPercent: 25 } : {}),
          },
        },
      }), "utf8");
      expect(loadConfig(buildEnv(tempRoot)).communication?.codex).toEqual({
        rollout,
        minimumRuntimeVersion: "0.144.1",
        sameHostOnly: true,
        ...(rollout === "canary" ? { canaryPercent: 25 } : {}),
      });
    },
  );

  it.each(["off", "observe", "draining"] as const)(
    "communication rollout=%s は安全な非native送信状態として追加fieldを省略できる",
    (rollout) => {
      tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
      writeFileSync(join(tempRoot, "config.json"), JSON.stringify({
        profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
        allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
        communication: { codex: { rollout } },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "implement",
      }), "utf8");

      expect(loadConfig(buildEnv(tempRoot)).communication?.codex).toEqual({ rollout });
    },
  );

  it("rollout=canary は canaryPercent を要求し、TTL/canary をbounded integerにする", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const base = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };
    const configPath = join(tempRoot, "config.json");

    writeFileSync(configPath, JSON.stringify({
      ...base,
      communication: {
        codex: {
          rollout: "canary",
          minimumRuntimeVersion: "0.144.1",
          sameHostOnly: true,
          claimLeaseSeconds: 60,
          bindingTtlSeconds: 300,
        },
      },
    }), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/canaryPercent.*必須/);

    for (const field of ["claimLeaseSeconds", "bindingTtlSeconds"] as const) {
      writeFileSync(configPath, JSON.stringify({
        ...base,
        communication: {
          codex: {
            rollout: "canary",
            minimumRuntimeVersion: "0.144.1",
            sameHostOnly: true,
            canaryPercent: 25,
            [field]: 86_401,
          },
        },
      }), "utf8");
      expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/too_big|最大|86400/i);
    }

    writeFileSync(configPath, JSON.stringify({
      ...base,
      communication: {
        codex: {
          rollout: "canary",
          minimumRuntimeVersion: "0.144.1",
          sameHostOnly: true,
          claimLeaseSeconds: 60,
          bindingTtlSeconds: 300,
          canaryPercent: 25,
        },
      },
    }), "utf8");
    expect(loadConfig(buildEnv(tempRoot)).communication?.codex).toMatchObject({
      claimLeaseSeconds: 60,
      bindingTtlSeconds: 300,
      canaryPercent: 25,
    });
  });

  it("canary選出はtask/delivery keyに対して決定論的で割合をboundedに適用する", () => {
    const first = isCommunicationCanaryEligible("t_task", "delivery-1", 25);
    expect(isCommunicationCanaryEligible("t_task", "delivery-1", 25)).toBe(first);
    expect(isCommunicationCanaryEligible("t_task", "delivery-1", 100)).toBe(true);
    expect(() => isCommunicationCanaryEligible("t_task", "delivery-1", 0)).toThrow(/1〜100/);
    expect(() => isCommunicationCanaryEligible("t_task", "delivery-1", 101)).toThrow(/1〜100/);
  });

  it("communication provider config は未設定でも有限defaultsを返す", () => {
    const config: HachiConfig = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };
    expect(resolveCommunicationProviderConfig(config, "codex")).toMatchObject({
      rollout: "off",
      claimLeaseSeconds: 60,
      bindingTtlSeconds: 300,
    });
    expect(() => resolveCommunicationProviderConfig({
      ...config,
      communication: { codex: { rollout: "on", canaryPercent: 0 } },
    }, "codex")).toThrow(/canaryPercent.*1〜100/);
  });

  it("trusted model transport policyの重複とallowlist外modelを拒否する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const base: HachiConfig = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      modelTransportPolicies: [
        { id: "p1", provider: "claude", model: "claude-sonnet-5", transport: "direct", minimumRuntimeVersion: "2.1.207" },
        { id: "p2", provider: "claude", model: "claude-sonnet-5", transport: "direct", minimumRuntimeVersion: "2.1.208" },
      ],
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(base), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/modelTransportPolicy が重複/);

    base.modelTransportPolicies = [
      { id: "outside", provider: "codex", model: "gpt-outside", transport: "direct", minimumRuntimeVersion: "1.0.0" },
    ];
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(base), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/modelTransportPolicy の model が allowlist 外/);

    for (const invalidVersion of ["1.0.0-01", "9007199254740992.0.0"]) {
      base.modelTransportPolicies = [
        { id: "invalid-semver", provider: "claude", model: "claude-sonnet-5", transport: "direct", minimumRuntimeVersion: invalidVersion },
      ];
      writeFileSync(join(tempRoot, "config.json"), JSON.stringify(base), "utf8");
      expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/strict semver/);
    }
  });

  it("有効な config.json を読み込む", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom: HachiConfig = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

    const config = loadConfig(buildEnv(tempRoot));
    expect(config).toEqual(custom);
  });

  it("strictなproject-scoped runtime profile configを保持して読み込む", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = buildRuntimeProfileConfig();
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as HachiConfig & {
      runtimeResources: {
        projects: Array<{
          project: string;
          profiles: Array<{ id: string; bundleKind: string; hostAdapter: string }>;
        }>;
      };
    };

    expect(config.runtimeResources.projects[0]).toEqual({
      project: "hachi-kanban",
      repoCommonDir: "/repo/.git",
      profiles: [
        {
          id: "postgres-v1",
          bundleKind: "worktree_postgres",
          hostAdapter: "worktreePostgres",
        },
      ],
    });
  });

  it("runtime project/profileのunknown fieldとduplicate/conflictをconfig読込時に拒否する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const config = buildRuntimeProfileConfig();
    const runtimeResources = config["runtimeResources"] as {
      projects: Array<{
        project: string;
        repoCommonDir: string;
        profiles: Array<Record<string, unknown>>;
      }>;
    };
    runtimeResources.projects[0]!.profiles[0]!["command"] = "./repo-script.sh";
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(config), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/unrecognized/i);

    delete runtimeResources.projects[0]!.profiles[0]!["command"];
    runtimeResources.projects[0]!.profiles.push({
      id: "postgres-v1",
      bundleKind: "worktree_postgres",
      hostAdapter: "worktreePostgres",
    });
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(config), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/profile が重複/);

    runtimeResources.projects[0]!.profiles.pop();
    runtimeResources.projects.push({
      project: "hachi-kanban",
      repoCommonDir: "/other/.git",
      profiles: [
        {
          id: "other",
          bundleKind: "worktree_postgres",
          hostAdapter: "worktreePostgres",
        },
      ],
    });
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(config), "utf8");
    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/project が競合/);
  });

  it("steward.intervalMinutes を正の整数として読み込む（docs/contract.md §40.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      steward: { intervalMinutes: 45 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom));

    const config = loadConfig(buildEnv(tempRoot)) as HachiConfigWithSteward;

    expect(config.steward?.intervalMinutes).toBe(45);
  });

  it("steward.intervalMinutes が正の整数でなければ config 読込時に throw する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      steward: { intervalMinutes: 0 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom));

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("brief.times を HH:MM 配列として読み込む（docs/contract.md §48.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      brief: { times: ["07:30", "19:30"] },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom));

    const config = loadConfig(buildEnv(tempRoot)) as HachiConfigWithBrief;

    expect(config.brief?.times).toEqual(["07:30", "19:30"]);
  });

  it("brief.times が HH:MM でなければ config 読込時に throw する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      brief: { times: ["24:00"] },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom));

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("verify.tenants を trim して読み込む（docs/contract.md §39.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const custom = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      verify: { tenants: { "hachi-kanban": "  pnpm -r typecheck && pnpm -r test  " } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(custom), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as ConfigWithVerify;
    expect(config.verify?.tenants["hachi-kanban"]).toBe("pnpm -r typecheck && pnpm -r test");
  });

  it("verify.tenants の値が文字列でない場合は throw する（fail-closed, docs/contract.md §39.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      verify: { tenants: { "hachi-kanban": ["pnpm", "test"] } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("verify.tenants の値が空白のみの場合は throw する（fail-closed, docs/contract.md §39.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
      verify: { tenants: { "hachi-kanban": "   " } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("不正な JSON は throw する（fail-closed）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    writeFileSync(join(tempRoot, "config.json"), "{ not valid json", "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow();
  });

  it("スキーマ不整合は throw する（fail-closed）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify({ profiles: {} }), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("defaultProfile が profiles に存在しない場合は throw する（意味的検証, fail-closed, docs/contract.md §12.6-5）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "does-not-exist",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/defaultProfile が profiles に存在しません/);
  });

  it("profile の model が charset 不正な場合は throw する（意味的検証, fail-closed）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { solo: { provider: "claude", model: "invalid model!" } },
      allowlist: { codex: [], claude: ["invalid model!"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/model の charset が不正です/);
  });

  it("profile の {provider, model} が allowlist に含まれない場合は throw する（意味的検証, fail-closed）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { solo: { provider: "claude", model: "claude-sonnet-5" } },
      allowlist: { codex: [], claude: ["claude-opus-4-6"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "solo",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/model が allowlist 外です/);
  });

  it("transport=direct + provider=codex の profile は許容する（契約 §17.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4", transport: "direct" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot));
    expect(config.profiles.impl?.transport).toBe("direct");
  });

  it("transport=direct + provider=claude の profile は許容する（契約 §22.1, §17.1 の codex 限定を撤廃）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { plan: { provider: "claude", model: "claude-sonnet-5", transport: "direct" } },
      allowlist: { codex: [], claude: ["claude-sonnet-5"] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "plan",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot));
    expect(config.profiles.plan?.transport).toBe("direct");
    expect(config.profiles.plan?.provider).toBe("claude");
  });

  it("notify.transports と notify.telegram を config.json から読み込む（契約 §38）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      notify: {
        transports: ["macos", "telegram"],
        telegram: { chatId: "chat-1", baseUrl: "https://kanban.example", minPriority: 3 },
      },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as HachiConfigWithNotify;
    expect(config.notify?.transports).toEqual(["macos", "telegram"]);
    expect(config.notify?.telegram?.chatId).toBe("chat-1");
    expect(config.notify?.telegram?.baseUrl).toBe("https://kanban.example");
    expect(config.notify?.telegram?.minPriority).toBe(3);
  });

  it("notify.telegram.baseUrl が URL でない場合は throw する（fail-closed, 契約 §38）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      notify: { transports: ["telegram"], telegram: { chatId: "chat-1", baseUrl: "not-a-url" } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("review.maxReworkLaunches を config.json から読み込む（契約 §21.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      review: { maxReworkLaunches: 1 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as ConfigWithReview;
    expect(config.review?.maxReworkLaunches).toBe(1);
  });

  it("review.maxReworkLaunches が省略時は review フィールド自体がない（既定値は利用側で適用）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as ConfigWithReview;
    expect(config.review).toBeUndefined();
  });

  it("review.maxReworkLaunches が負の値の場合は throw する（fail-closed, 契約 §21.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      review: { maxReworkLaunches: -1 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("review.maxReworkLaunches が 1 超の場合は throw する（fail-closed, 契約 §21.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      review: { maxReworkLaunches: 2 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("review.maxReworkLaunches が小数の場合は throw する（fail-closed, 契約 §21.1）", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 1 },
      defaultProfile: "impl",
      review: { maxReworkLaunches: 2.5 },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });

  it("dispatch.providerLaunchLimits を config.json から読み込む", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const cfg = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 2 },
      defaultProfile: "impl",
      dispatch: { providerLaunchLimits: { claude: 1, codex: 2 } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(cfg), "utf8");

    const config = loadConfig(buildEnv(tempRoot)) as ConfigWithDispatch;
    expect(config.dispatch?.providerLaunchLimits?.claude).toBe(1);
    expect(config.dispatch?.providerLaunchLimits?.codex).toBe(2);
  });

  it("dispatch.providerLaunchLimits が正の整数でなければ throw する", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-policy-"));
    const bad = {
      profiles: { impl: { provider: "codex", model: "gpt-5.4" } },
      allowlist: { codex: ["gpt-5.4"], claude: [] },
      resourceGuard: { maxInFlight: 5, maxLaunchesPerTick: 2 },
      defaultProfile: "impl",
      dispatch: { providerLaunchLimits: { claude: 0 } },
    };
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(bad), "utf8");

    expect(() => loadConfig(buildEnv(tempRoot))).toThrow(/検証に失敗/);
  });
});

describe("listAllowlistedModels", () => {
  it("provider 順を保って重複モデルを1件にまとめる", () => {
    const config: HachiConfig = {
      profiles: { implement: { provider: "codex", model: "shared-model" } },
      allowlist: {
        codex: ["gpt-5.6-sol", "shared-model"],
        claude: ["shared-model", "claude-opus-4-6"],
      },
      resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
      defaultProfile: "implement",
    };

    expect(listAllowlistedModels(config)).toEqual(["gpt-5.6-sol", "shared-model", "claude-opus-4-6"]);
  });
});

describe("resolveModel", () => {
  const config: HachiConfig = {
    profiles: {
      implement: { provider: "codex", model: "gpt-5.4" },
      plan: { provider: "claude", model: "claude-opus-4-6" },
    },
    allowlist: {
      codex: ["gpt-5.4", "gpt-5.5"],
      claude: ["claude-opus-4-6", "claude-sonnet-5"],
    },
    resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
    defaultProfile: "implement",
  };

  it("profile 未指定は defaultProfile を使い source='default'", () => {
    const result = resolveModel(buildTask(), config);
    expect(result).toEqual({ ok: true, provider: "codex", model: "gpt-5.4", source: "default", transport: "bridge" });
  });

  it("profile 指定時は source='profile'", () => {
    const result = resolveModel(buildTask({ profile: "plan" }), config);
    expect(result).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-opus-4-6",
      source: "profile",
      transport: "bridge",
    });
  });

  it("task.provider が profile.provider より優先される（新 provider の allowlist に model があれば成功）", () => {
    const sharedModelConfig: HachiConfig = {
      profiles: {
        plan: { provider: "claude", model: "gpt-5.4" },
      },
      allowlist: {
        codex: ["gpt-5.4"],
        claude: ["gpt-5.4"],
      },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "plan",
    };
    const result = resolveModel(buildTask({ profile: "plan", provider: "codex" }), sharedModelConfig);
    expect(result).toEqual({ ok: true, provider: "codex", model: "gpt-5.4", source: "profile", transport: "bridge" });
  });

  it("task.provider の上書きにより最終 model が当該 provider の allowlist 外になる場合は ok:false（fail-closed, docs/contract.md §12.4-3）", () => {
    // profile=plan は provider=claude/model=claude-opus-4-6 だが、task.provider='codex' で上書きされる。
    // claude-opus-4-6 は codex の allowlist に無いため、provider 決定後の最終ペアで検証し ok:false になる。
    const result = resolveModel(buildTask({ profile: "plan", provider: "codex" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("model-not-allowlisted");
    }
  });

  it("未知の profile は ok:false 'unknown-profile'（fail-closed）", () => {
    const result = resolveModel(buildTask({ profile: "does-not-exist" }), config);
    expect(result).toEqual({ ok: false, reason: "unknown-profile", detail: expect.any(String) });
  });

  it("model_override が allowlist 内なら source='override'", () => {
    const result = resolveModel(buildTask({ modelOverride: "gpt-5.5" }), config);
    expect(result).toEqual({ ok: true, provider: "codex", model: "gpt-5.5", source: "override", transport: "direct" });
  });

  it("model_override の charset が不正なら ok:false（charset-first, fail-closed）", () => {
    const result = resolveModel(buildTask({ modelOverride: "gpt 5.5!" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-model-charset");
    }
  });

  it("model_override が allowlist 外なら ok:false（fail-closed）", () => {
    const result = resolveModel(buildTask({ modelOverride: "not-allowlisted-model" }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("model-not-allowlisted");
    }
  });

  // ---- transport 伝播（契約 §17.3） ----

  const directConfig: HachiConfig = {
    profiles: {
      "direct-impl": { provider: "codex", model: "gpt-5.4", transport: "direct" },
      implement: { provider: "codex", model: "gpt-5.4" },
    },
    allowlist: {
      codex: ["gpt-5.4", "gpt-5.5"],
      claude: ["claude-opus-4-6"],
    },
    resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
    defaultProfile: "implement",
  };

  it("profile の transport=direct を解決結果に伝播する（契約 §17.3）", () => {
    const result = resolveModel(buildTask({ profile: "direct-impl" }), directConfig);
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.4",
      source: "profile",
      transport: "direct",
    });
  });

  it("transport 未指定の profile は既定 'bridge' を伝播する（契約 §17.3）", () => {
    const result = resolveModel(buildTask({ profile: "implement" }), directConfig);
    if (!result.ok) {
      throw new Error("解決に失敗しました");
    }
    expect(result.transport).toBe("bridge");
  });

  it("model_override 時は profile が direct でも transport=direct を返す（契約 §49.1）", () => {
    const result = resolveModel(buildTask({ profile: "direct-impl", modelOverride: "gpt-5.5" }), directConfig);
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.5",
      source: "override",
      transport: "direct",
    });
  });

  it("model_override 時は profile が bridge でも transport=direct へ強制する（契約 §49.1）", () => {
    const result = resolveModel(buildTask({ profile: "implement", modelOverride: "gpt-5.5" }), directConfig);
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.5",
      source: "override",
      transport: "direct",
    });
  });

  it("provider=claude の transport=direct も解決できる（契約 §22.1, §17.1 の codex 限定を撤廃）", () => {
    const claudeDirectConfig: HachiConfig = {
      profiles: {
        "direct-plan": { provider: "claude", model: "claude-sonnet-5", transport: "direct" },
      },
      allowlist: {
        codex: [],
        claude: ["claude-sonnet-5"],
      },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "direct-plan",
    };
    const result = resolveModel(buildTask({ profile: "direct-plan" }), claudeDirectConfig);
    expect(result).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-sonnet-5",
      source: "profile",
      transport: "direct",
    });
  });

  it("worker と reviewer のprofile/overrideを独立して解決し、rework互換のresolveModelはworkerを使う", () => {
    const roleConfig: HachiConfig = {
      profiles: {
        implement: { provider: "codex", model: "gpt-5.4", effort: "high" },
        review: { provider: "claude", model: "claude-opus-5", transport: "direct", effort: "xhigh" },
        "review-fast": { provider: "codex", model: "gpt-5.6-luna", transport: "direct", speed: "fast" },
      },
      allowlist: {
        codex: ["gpt-5.4", "gpt-5.6-luna"],
        claude: ["claude-opus-5"],
      },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "implement",
    };
    const task = buildTask({
      effortOverride: "max",
      reviewProfileOverride: "review-fast",
      reviewModelOverride: "gpt-5.6-luna",
      reviewEffortOverride: "xhigh",
      reviewSpeedOverride: "standard",
    });

    expect(resolveExecution(task, roleConfig, "worker")).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.4",
      source: "default",
      transport: "direct",
      effort: "max",
    });
    expect(resolveModel(task, roleConfig)).toEqual(resolveExecution(task, roleConfig, "worker"));
    expect(resolveExecution(task, roleConfig, "reviewer")).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      source: "override",
      transport: "direct",
      effort: "xhigh",
      speed: "standard",
    });
  });

  it("reviewer未指定時は予約profile reviewを使い、workerのoverrideを伝播しない", () => {
    const roleConfig: HachiConfig = {
      profiles: {
        implement: { provider: "codex", model: "gpt-5.4" },
        review: { provider: "claude", model: "claude-opus-5", effort: "max" },
      },
      allowlist: { codex: ["gpt-5.4", "gpt-5.5"], claude: ["claude-opus-5"] },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "implement",
    };
    const result = resolveExecution(buildTask({
      modelOverride: "gpt-5.5",
      effortOverride: "high",
      speedOverride: "fast",
    }), roleConfig, "reviewer");

    expect(result).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-opus-5",
      source: "default",
      transport: "bridge",
      effort: "max",
    });
  });

  it("speed overrideはprofile speedより優先しdirectを強制する", () => {
    const speedConfig: HachiConfig = {
      profiles: { implement: { provider: "codex", model: "gpt-5.6-sol", speed: "standard" } },
      allowlist: { codex: ["gpt-5.6-sol"], claude: [] },
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
      defaultProfile: "implement",
    };

    expect(resolveExecution(buildTask({ speedOverride: "fast" }), speedConfig, "worker")).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.6-sol",
      source: "default",
      transport: "direct",
      speed: "fast",
    });
  });
});

describe("effort 伝搬（docs/contract.md §35）", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function writeConfig(config: unknown): Environment {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-core-effort-"));
    writeFileSync(join(tempRoot, "config.json"), JSON.stringify(config));
    return buildEnv(tempRoot);
  }

  const baseConfig = {
    profiles: {
      steward: { provider: "claude", model: "claude-sonnet-5", transport: "direct", effort: "medium" },
      implement: { provider: "codex", model: "gpt-5.4" },
    },
    allowlist: { codex: ["gpt-5.4"], claude: ["claude-sonnet-5"] },
    resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
    defaultProfile: "implement",
  };

  it("profile の effort が ModelResolution.effort として返る", () => {
    const config = loadConfig(writeConfig(baseConfig));
    const resolution = resolveModel(buildTask({ profile: "steward" }), config);
    expect(resolution).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-sonnet-5",
      source: "profile",
      transport: "direct",
      effort: "medium",
    });
  });

  it("effort 未指定の profile では effort キー自体が省略される（exactOptionalPropertyTypes）", () => {
    const config = loadConfig(writeConfig(baseConfig));
    const resolution = resolveModel(buildTask({ profile: "implement" }), config);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect("effort" in resolution).toBe(false);
    }
  });

  it("model_override は model のみを上書きし profile の effort は維持される（契約 §35.2）", () => {
    const config = loadConfig(writeConfig(baseConfig));
    const resolution = resolveModel(
      buildTask({ profile: "steward", modelOverride: "claude-sonnet-5" }),
      config,
    );
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.source).toBe("override");
      expect(resolution.transport).toBe("direct");
      expect(resolution.effort).toBe("medium");
    }
  });

  it("effort_override は profile effort より優先し、bridge profile でも direct を強制する（契約 §49.3）", () => {
    const config = loadConfig(writeConfig(baseConfig));
    const resolution = resolveModel(buildTask({ profile: "implement", effortOverride: "xhigh" }), config);
    expect(resolution).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.4",
      source: "profile",
      transport: "direct",
      effort: "xhigh",
    });
  });

  it("model_override と effort_override は併用でき、model/effort の両方を上書きして direct を強制する（契約 §49.3）", () => {
    const config = loadConfig(writeConfig(baseConfig));
    const resolution = resolveModel(
      buildTask({ profile: "steward", modelOverride: "claude-sonnet-5", effortOverride: "high" }),
      config,
    );
    expect(resolution).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-sonnet-5",
      source: "override",
      transport: "direct",
      effort: "high",
    });
  });

  it("不正な effort 値は config 読込時に throw する（fail-closed）", () => {
    const invalid = {
      ...baseConfig,
      profiles: {
        ...baseConfig.profiles,
        steward: { provider: "claude", model: "claude-sonnet-5", effort: "ultra" },
      },
    };
    const env = writeConfig(invalid);
    expect(() => loadConfig(env)).toThrow(/検証に失敗/);
  });

  it("resourceGuard.maxRunSeconds は正の整数のみ許可する（契約 §34.3）", () => {
    const valid = {
      ...baseConfig,
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2, maxRunSeconds: 3600 },
    };
    expect(loadConfig(writeConfig(valid)).resourceGuard.maxRunSeconds).toBe(3600);
    rmSync(tempRoot, { recursive: true, force: true });

    const invalid = {
      ...baseConfig,
      resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2, maxRunSeconds: -1 },
    };
    const env = writeConfig(invalid);
    expect(() => loadConfig(env)).toThrow(/検証に失敗/);
  });
});
