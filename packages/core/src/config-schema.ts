// =============================================================================
// config.json の zod スキーマ定義（ブラウザ側の事前検証でも共有する軽量モジュール）。
// fs / DB など Node 専用依存を持ち込まないこと。
// =============================================================================

import { z } from "zod";
import { isStrictSemver } from "./model-transport-compatibility.js";

const safeRuntimeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => value === value.trim(), "前後の空白は許可されません");

const canonicalHostPathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "絶対パスが必要です")
  .refine((value) => !value.includes("\0"), "NUL は許可されません")
  .refine((value) => value === value.trim(), "前後の空白は許可されません");

const runtimeHealthCheckSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    intervalMs: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    retries: z.number().int().positive(),
  })
  .strict();

const runtimeCleanupSchema = z
  .object({
    maxRequestsPerTick: z.number().int().positive().max(100),
    maxContainerRemovalsPerTick: z.number().int().positive().max(100),
    maxNetworkRemovalsPerTick: z.number().int().positive().max(100),
    maxWallSecondsPerTick: z.number().int().positive().max(300),
    baseBackoffSeconds: z.number().int().positive().max(86_400),
    maxBackoffSeconds: z.number().int().positive().max(86_400),
    maxAttempts: z.number().int().positive().max(100),
    autoCleanupRolloutGeneration: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

const runtimeProjectProfileSchema = z
  .object({
    id: safeRuntimeIdentifierSchema,
    bundleKind: z.literal("worktree_postgres"),
    hostAdapter: z.literal("worktreePostgres"),
  })
  .strict();

const runtimeProjectSchema = z
  .object({
    project: safeRuntimeIdentifierSchema,
    repoCommonDir: canonicalHostPathSchema,
    profiles: z.array(runtimeProjectProfileSchema).min(1),
  })
  .strict()
  .superRefine((project, context) => {
    const profileIds = new Set<string>();
    for (const [index, profile] of project.profiles.entries()) {
      if (profileIds.has(profile.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `runtime profile が重複しています: ${profile.id}`,
          path: ["profiles", index, "id"],
        });
      }
      profileIds.add(profile.id);
    }
  });

/**
 * host-owned runtime resource 設定。project/profile を含む全 sub-object は strict とし、
 * repository 側から任意 command/path を profile template として注入できる余地を持たせない。
 */
export const runtimeResourcesSchema = z
  .object({
    mode: z.enum(["observe", "enforce"]),
    provisioningEnabled: z.boolean(),
    leaseTtlSeconds: z.number().int().positive(),
    heartbeatIntervalSeconds: z.number().int().positive().optional(),
    provisioningTimeoutSeconds: z.number().int().positive().optional(),
    dockerContext: z.string().min(1).optional(),
    rolloutGeneration: z.number().int().positive().optional(),
    worktreePostgres: z
      .object({
        image: z.string().min(1),
        containerPort: z.number().int().positive().max(65535),
        healthCheck: runtimeHealthCheckSchema,
      })
      .strict()
      .optional(),
    cleanup: runtimeCleanupSchema.optional(),
    projects: z.array(runtimeProjectSchema).optional(),
  })
  .strict()
  .superRefine((runtimeResources, context) => {
    const projects = new Map<string, string>();
    for (const [index, project] of (runtimeResources.projects ?? []).entries()) {
      const existingCommonDir = projects.get(project.project);
      if (existingCommonDir !== undefined) {
        const conflict = existingCommonDir === project.repoCommonDir ? "重複" : "競合";
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `runtime project が${conflict}しています: ${project.project}`,
          path: ["projects", index, "project"],
        });
      }
      projects.set(project.project, project.repoCommonDir);
    }
  });

export type RuntimeResourcesConfig = z.infer<typeof runtimeResourcesSchema>;

const profileEntrySchema = z.object({
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  // 実行トランスポート（省略時 "bridge"。"direct" は codex/claude いずれも対応。
  transport: z.enum(["bridge", "direct"]).optional(),
  // reasoning effort（閉じた enum。不正値は config 読込時に throw = fail-closed）。
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  // runtime の処理速度。省略は runtime default への委譲であり standard と同義ではない。
  speed: z.enum(["standard", "fast"]).optional(),
  reviewPolicy: z.enum(["required", "worker-outcome"]).optional(),
});

export type ProfileEntryConfig = z.infer<typeof profileEntrySchema>;

const notifyTelegramSchema = z.object({
  chatId: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  minPriority: z.number().int().optional(),
});

const notifyConfigSchema = z.object({
  // future transport を許すため string[]。未実装名は supervisor 側で fail-closed skip。
  transports: z.array(z.string().min(1)).optional(),
  telegram: notifyTelegramSchema.optional(),
});

const providerLaunchLimitsSchema = z.object({
  codex: z.number().int().positive().optional(),
  claude: z.number().int().positive().optional(),
});

const dispatchConfigSchema = z.object({
  providerLaunchLimits: providerLaunchLimitsSchema.optional(),
});

const briefTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const strictSemverSchema = z.string().refine(isStrictSemver, "strict semverが必要です");

/**
 * Native communication の lease/binding は runtime に無制限の寿命を与えない。
 * Core の claim 実装と同じ上限（1日）を schema 側でも先に検証し、config と
 * runtime の境界で異なる値を受け入れないようにする。
 */
const communicationSecondsSchema = z.number().int().positive().max(86_400);
const communicationCanaryPercentSchema = z.number().int().min(1).max(100);

const communicationProviderSchema = z
  .object({
    rollout: z.enum(["off", "observe", "canary", "on", "draining"]),
    minimumRuntimeVersion: strictSemverSchema.optional(),
    sameHostOnly: z.boolean().optional(),
    claimLeaseSeconds: communicationSecondsSchema.optional(),
    bindingTtlSeconds: communicationSecondsSchema.optional(),
    canaryPercent: communicationCanaryPercentSchema.optional(),
  })
  .strict()
  .superRefine((communication, context) => {
    if (communication.rollout !== "canary" && communication.rollout !== "on") {
      return;
    }
    if (communication.minimumRuntimeVersion === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rollout=${communication.rollout} では minimumRuntimeVersion が必須です`,
        path: ["minimumRuntimeVersion"],
      });
    }
    if (communication.sameHostOnly !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rollout=${communication.rollout} では sameHostOnly=true が必須です`,
        path: ["sameHostOnly"],
      });
    }
    if (communication.rollout === "canary" && communication.canaryPercent === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rollout=canary では canaryPercent が必須です",
        path: ["canaryPercent"],
      });
    }
  });

/**
 * direct transport の stall 判定閾値（契約 §50.2）。
 * outputStallSeconds は「.out が無成長 かつ プロセス不在」を死亡と判定するまでの秒数、
 * maxRuntimeSeconds は「生存していても長すぎる run」を打ち切るまでの秒数。
 * provider ごとに上書きでき、省略時は supervisor 側の provider 別既定を使う
 * （codex は逐次出力するが `claude -p` は完了まで無出力のため既定値が異なる）。
 */
const directStallProviderSchema = z
  .object({
    outputStallSeconds: z.number().int().positive().max(86_400).optional(),
    maxRuntimeSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

const directConfigSchema = z
  .object({
    stall: z
      .object({
        codex: directStallProviderSchema.optional(),
        claude: directStallProviderSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * オーケストレーター自己計測の閾値上書き（playbook §0.7 2026-08-22 改訂）。
 * 軸（turns / contextSaturation / handoffValue / effectiveCostUsd）ごと・段階ごとに部分指定でき、
 * 未指定は既定値のまま（additive）。段階の逆転は判定を無意味にするため、ここで fail-closed に弾く。
 * costModel は損益分岐ターン数 N を計算する2定数（c0 / s）の上書き。
 */
const sessionBudgetAxisSchema = z
  .object({
    notice: z.number().nonnegative().optional(),
    recommend: z.number().nonnegative().optional(),
    urgent: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * 旧軸（21172f2 で廃止）。値は互換変換しない（D4）。
 * `.strict()` による起動不能を避けるため、キーとしてのみ許可し値は検証しない。
 * loadConfig 側で検出して除去し、一度だけ警告する。playbook §0.7 参照。
 */
export const LEGACY_ORCHESTRATOR_SESSION_BUDGET_KEYS = [
  "cumulativeInputTokens",
  "contextTokens",
] as const;

/**
 * 契約 §77.3 の単価上書き。ModelPriceOverride（types.ts）と同形。単価は正数、cache 系は null 可
 * （価格表の ModelPrice と同じ意味）。source は空文字を許さない（推測値を置かせない）。
 */
const modelPriceOverrideSchema = z
  .object({
    inputCostPerToken: z.number().positive(),
    outputCostPerToken: z.number().positive(),
    cacheCreationCostPerToken: z.number().positive().nullable(),
    cacheCreation1hCostPerToken: z.number().positive().nullable(),
    cacheReadCostPerToken: z.number().positive().nullable(),
    source: z.string().min(1),
  })
  .strict();

/** Codex credits 台帳（1M トークンあたり credits）。CodexCreditsPerMTok（types.ts）と同形 */
const codexCreditsPerMTokSchema = z
  .object({
    input: z.number().positive(),
    cached: z.number().positive(),
    output: z.number().positive(),
    source: z.string().min(1),
  })
  .strict();

const orchestratorPricingSchema = z
  .object({
    overrides: z.record(z.string().min(1), modelPriceOverrideSchema).optional(),
    codexCreditUsdRate: z.number().positive().optional(),
    codexCredits: z.record(z.string().min(1), codexCreditsPerMTokSchema).optional(),
  })
  .strict();

const orchestratorConfigSchema = z
  .object({
    tenantDefaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    // 契約 §77.3。OrchestratorConfig.pricing（types.ts）と同形
    pricing: orchestratorPricingSchema.optional(),
    sessionBudget: z
      .object({
        turns: sessionBudgetAxisSchema.optional(),
        contextSaturation: sessionBudgetAxisSchema.optional(),
        handoffValue: sessionBudgetAxisSchema.optional(),
        effectiveCostUsd: sessionBudgetAxisSchema.optional(),
        costModel: z
          .object({
            c0: z.number().positive().optional(),
            s: z.number().positive().optional(),
            // 契約 §77.4 / §77.5。正の整数のみ（0 は「全部 measured」になり係数の意味が消える）
            minTurns: z.number().int().positive().optional(),
            profileSessions: z.number().int().positive().optional(),
            // 契約 §77.5。bootOverheadUsd は USD（正数）、generations / turnsPerTask は正の整数
            bootOverheadUsd: z.number().positive().optional(),
            generations: z.number().int().positive().optional(),
            turnsPerTask: z.number().int().positive().optional(),
            // 契約 §77.10。prompt cache の TTL（秒）。正の整数
            cacheTtlSeconds: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        // contextSaturation の分母。claude では観測できないため config で上書きできるようにする
        // （adapters が観測できた場合はそちらを優先する。呼び出し側で処理）。
        // 凍結契約（types.ts）が「正の整数のみ受理する」と宣言しているので .int() まで課す。
        // 0・負・非有限は fail-closed で弾く（非有限は z.number() が invalid_type として弾く）。
        contextWindowTokens: z.number().int().positive().optional(),
        // 契約 §77.7 / §77.8。軸ではないので sessionBudgetAxisSchema を使わない
        monitor: z
          .object({
            intervalMinutes: z.number().int().positive().optional(),
            // 契約 §77.10。0 < x < 1
            idleWarnRatio: z.number().gt(0).lt(1).optional(),
          })
          .strict()
          .optional(),
        autoHandover: z.enum(["off", "propose", "apply"]).optional(),
        // 旧軸2つ（廃止済み・21172f2）。値は一切見ない。キーとしてのみ許可し、
        // loadConfig が検証成功後に削除する（このキー一覧は
        // LEGACY_ORCHESTRATOR_SESSION_BUDGET_KEYS と同期を保つこと）。
        cumulativeInputTokens: z.unknown().optional(),
        contextTokens: z.unknown().optional(),
      })
      .strict()
      .optional(),
    codexSuccessorAttestation: z
      .object({
        // 省略時の実効値は manual。enforce は reviewed helper の host publication 後だけ明示する。
        mode: z.enum(["manual", "enforce"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const hachiConfigSchema = z.object({
  profiles: z.record(z.string(), profileEntrySchema),
  allowlist: z.object({
    codex: z.array(z.string()),
    claude: z.array(z.string()),
  }),
  modelTransportPolicies: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    provider: z.enum(["codex", "claude"]),
    model: z.string().regex(/^[A-Za-z0-9._-]+$/),
    transport: z.enum(["bridge", "direct"]),
    minimumRuntimeVersion: strictSemverSchema,
    supportedEfforts: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).optional(),
    supportedSpeeds: z.array(z.enum(["standard", "fast"])).optional(),
  }).strict()).optional(),
  // 省略時は全 provider rollout=off と解釈する。provider 固有 object は unknown key を拒否する。
  communication: z
    .object({
      codex: communicationProviderSchema.optional(),
      claude: communicationProviderSchema.optional(),
    })
    .strict()
    .optional(),
  resourceGuard: z.object({
    maxInFlight: z.number().int().positive(),
    maxLaunchesPerTick: z.number().int().positive(),
    // 1 run の最大実行秒数（省略時は既定 7200 を適用）。
    maxRunSeconds: z.number().int().positive().optional(),
  }),
  defaultProfile: z.string().min(1),
  verify: z
    .object({
      tenants: z.record(z.string(), z.string().trim().min(1)),
    })
    .optional(),
  notify: notifyConfigSchema.optional(),
  dispatch: dispatchConfigSchema.optional(),
  steward: z
    .object({
      intervalMinutes: z.number().int().positive().optional(),
    })
    .optional(),
  brief: z
    .object({
      times: z.array(briefTimeSchema),
    })
    .optional(),
  review: z
    .object({
      // 同じ routing の自動 rework は1回だけ（契約 §21.1）。省略か 1 の明示だけを受理し、
      // 旧既定値 3 などの legacy 値は fail-closed で throw する（review.ts 側のクランプは
      // 多重防御であり、受理範囲を広げる根拠にはしない）。
      maxReworkLaunches: z.literal(1).optional(),
    })
    .optional(),
  // direct transport の stall 判定閾値（省略時は supervisor 既定。契約 §50.2）
  direct: directConfigSchema.optional(),
  runtimeResources: runtimeResourcesSchema.optional(),
  // オーケストレーター自己計測の閾値（省略時は playbook §0.7 の既定。契約 §55）
  orchestrator: orchestratorConfigSchema.optional(),
});
