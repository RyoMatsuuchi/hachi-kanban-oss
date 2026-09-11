// =============================================================================
// profile matrix によるモデル/プロバイダ・ルーティング（docs/contract.md §7）
// 設定ファイルの読み込みと、タスクに対するモデル解決を行う。fail-closed 設計。
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  PROVIDERS,
  type EffortLevel,
  type Environment,
  type ExecutionRole,
  type ExecutionSpeed,
  type HachiConfig,
  type CommunicationRolloutState,
  type ModelResolution,
  type Provider,
  type TaskRow,
  type Transport,
} from "./types.js";
import { hachiConfigSchema, LEGACY_ORCHESTRATOR_SESSION_BUDGET_KEYS } from "./config-schema.js";
export {
  hachiConfigSchema,
  runtimeResourcesSchema,
  type RuntimeResourcesConfig,
} from "./config-schema.js";

/**
 * model_override / profile の model の許容 charset（allowlist 照合より先に検査する）。
 * core 全体で共用する唯一の定義（docs/contract.md §12.16-4）。db.ts はこれを import して使う。
 */
export const MODEL_CHARSET = /^[A-Za-z0-9._-]+$/;

/** reasoning effort の閉じた語彙（docs/contract.md §35.1 / §49.3） */
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** execution speed の閉じた語彙（docs/contract.md §67.3） */
export const EXECUTION_SPEEDS: readonly ExecutionSpeed[] = ["standard", "fast"];

export function isExecutionSpeed(value: string): value is ExecutionSpeed {
  return (EXECUTION_SPEEDS as readonly string[]).includes(value);
}

/** config schema と native claim runtime が共有する bounded communication defaults。 */
export const COMMUNICATION_SECONDS_MAX = 86_400;
export const DEFAULT_COMMUNICATION_CLAIM_LEASE_SECONDS = 60;
export const DEFAULT_COMMUNICATION_BINDING_TTL_SECONDS = 300;
export const DEFAULT_COMMUNICATION_CANARY_PERCENT = 1;

/**
 * native launch と後続deliveryが同じtask cohortを選ぶための固定key。
 * messageごとに選出するとlegacy launchへnative deliveryだけが当たり、exact target binding不足になる。
 */
export function communicationCanaryCohortKey(provider: Provider): string {
  return `native-task-cohort.v1:${provider}`;
}

/**
 * task とcallerが渡すstable cohort/delivery keyだけからcanaryを決定論的に選出する。
 * caller が route を自己申告するための API ではなく、trusted config の割合を
 * 同じ入力へ適用するための pure helper である（contract §68.7）。
 */
export function isCommunicationCanaryEligible(
  taskId: string,
  deliveryKey: string,
  canaryPercent: number,
): boolean {
  if (!Number.isInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 100) {
    throw new Error("communication canaryPercent は1〜100の整数が必須です");
  }
  // Keep the same canonical key framing used by Core/ supervisor claim code.
  const digest = createHash("sha256").update(`${taskId}:${deliveryKey}`).digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  return bucket < canaryPercent;
}

/** provider の rollout 設定を finite defaults 付きで読む（未設定は off）。 */
export function resolveCommunicationProviderConfig(
  config: HachiConfig,
  provider: Provider,
): {
  rollout: CommunicationRolloutState;
  minimumRuntimeVersion?: string;
  sameHostOnly?: boolean;
  claimLeaseSeconds: number;
  bindingTtlSeconds: number;
  canaryPercent?: number;
} {
  const configured = config.communication?.[provider];
  const rollout = configured?.rollout ?? "off";
  const claimLeaseSeconds = configured?.claimLeaseSeconds ?? DEFAULT_COMMUNICATION_CLAIM_LEASE_SECONDS;
  const bindingTtlSeconds = configured?.bindingTtlSeconds ?? DEFAULT_COMMUNICATION_BINDING_TTL_SECONDS;
  if (
    !Number.isInteger(claimLeaseSeconds) || claimLeaseSeconds <= 0 || claimLeaseSeconds > COMMUNICATION_SECONDS_MAX ||
    !Number.isInteger(bindingTtlSeconds) || bindingTtlSeconds <= 0 || bindingTtlSeconds > COMMUNICATION_SECONDS_MAX
  ) {
    throw new Error("communication claim/binding TTL は1〜86400秒の整数が必須です");
  }
  if (
    configured?.canaryPercent !== undefined &&
    (!Number.isInteger(configured.canaryPercent) || configured.canaryPercent < 1 || configured.canaryPercent > 100)
  ) {
    throw new Error("communication canaryPercent は1〜100の整数が必須です");
  }
  if (rollout === "canary" && configured?.canaryPercent === undefined) {
    throw new Error("rollout=canary では canaryPercent が必須です");
  }
  return {
    rollout,
    ...(configured?.minimumRuntimeVersion === undefined ? {} : { minimumRuntimeVersion: configured.minimumRuntimeVersion }),
    ...(configured?.sameHostOnly === undefined ? {} : { sameHostOnly: configured.sameHostOnly }),
    claimLeaseSeconds,
    bindingTtlSeconds,
    ...(configured?.canaryPercent === undefined ? {} : { canaryPercent: configured.canaryPercent }),
  };
}

const STANDARD_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];
const MAX_EFFORTS: readonly EffortLevel[] = [...STANDARD_EFFORTS, "max"];
const STANDARD_SPEEDS: readonly ExecutionSpeed[] = ["standard"];
const FAST_SPEEDS: readonly ExecutionSpeed[] = ["standard", "fast"];

/** docs/contract.md §7 の既定 profile matrix */
const DEFAULT_CONFIG: HachiConfig = {
  profiles: {
    plan: { provider: "claude", model: "claude-opus-4-6" },
    review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    implement: {
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      effort: "max",
      speed: "standard",
    },
    docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
  },
  allowlist: {
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
  },
  modelTransportPolicies: [
    {
      id: "codex-direct-gpt-5.6-sol-local-2026-07-11",
      provider: "codex" as const,
      model: "gpt-5.6-sol",
      transport: "direct" as const,
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: [...MAX_EFFORTS],
      supportedSpeeds: [...STANDARD_SPEEDS],
    },
    ...["gpt-5.6-terra", "gpt-5.6-luna"].map((model) => ({
      id: `codex-direct-${model}-local-2026-07-11`,
      provider: "codex" as const,
      model,
      transport: "direct" as const,
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: [...MAX_EFFORTS],
      supportedSpeeds: [...FAST_SPEEDS],
    })),
    ...["gpt-5.5", "gpt-5.4"].map((model) => ({
      id: `codex-direct-${model}-local-2026-07-11`,
      provider: "codex" as const,
      model,
      transport: "direct" as const,
      minimumRuntimeVersion: "0.144.1",
      supportedEfforts: [...STANDARD_EFFORTS],
    })),
    ...["claude-opus-4-6", "claude-sonnet-5"].map((model) => ({
      id: `claude-direct-${model}-local-2026-07-11`,
      provider: "claude" as const,
      model,
      transport: "direct" as const,
      minimumRuntimeVersion: "2.1.207",
      supportedEfforts: [...STANDARD_EFFORTS],
    })),
    {
      id: "claude-direct-claude-opus-5-local-2026-08-18",
      provider: "claude" as const,
      model: "claude-opus-5",
      transport: "direct" as const,
      minimumRuntimeVersion: "2.1.226",
      supportedEfforts: [...MAX_EFFORTS],
      supportedSpeeds: [...FAST_SPEEDS],
    },
  ],
  resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
  defaultProfile: "implement",
};

/** provider の値が既知の Provider かどうかを実行時に検証する（DB の生値は型契約を保証しないため） */
function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * CLI の model 候補として、現 config の provider 別 allowlist を provider 順で重複除去する。
 * これは発見性のための候補一覧であり、最終的な provider/model ペアは resolveModel が検証する。
 */
export function listAllowlistedModels(config: HachiConfig): string[] {
  const models = PROVIDERS.flatMap((provider) => config.allowlist[provider]);
  return [...new Set(models)];
}

/**
 * zod の形状検証だけでは捉えられない意味的な不整合を検証する（docs/contract.md §12.6-5, fail-closed）。
 * (a) defaultProfile が profiles に存在する
 * (b) 各 profile の model が charset を満たす
 * (c) 各 profile の {provider, model} が allowlist に含まれる
 * いずれか不合格なら throw する。
 */
export function validateConfigSemantics(config: HachiConfig): void {
  if (config.profiles[config.defaultProfile] === undefined) {
    throw new Error(
      `config.json の検証に失敗しました: defaultProfile が profiles に存在しません: ${config.defaultProfile}`,
    );
  }

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!MODEL_CHARSET.test(profile.model)) {
      throw new Error(
        `config.json の検証に失敗しました: profile '${name}' の model の charset が不正です: ${profile.model}`,
      );
    }
    if (!config.allowlist[profile.provider].includes(profile.model)) {
      throw new Error(
        `config.json の検証に失敗しました: profile '${name}' の model が allowlist 外です（provider=${profile.provider}）: ${profile.model}`,
      );
    }
    // 契約 §22.1: transport=direct の provider 制約（旧 §17.1 の codex 限定）は撤廃済み。
    // provider は zod の enum(["codex", "claude"]) で既知の値に限定されているため、ここでの追加検証は不要。
  }
  const policyKeys = new Set<string>();
  const policyIds = new Set<string>();
  for (const policy of config.modelTransportPolicies ?? []) {
    if (!config.allowlist[policy.provider].includes(policy.model)) {
      throw new Error(`config.json の検証に失敗しました: modelTransportPolicy の model が allowlist 外です: ${policy.id}`);
    }
    const key = `${policy.provider}\0${policy.model}\0${policy.transport}`;
    if (policyKeys.has(key) || policyIds.has(policy.id)) {
      throw new Error(`config.json の検証に失敗しました: modelTransportPolicy が重複しています: ${policy.id}`);
    }
    policyKeys.add(key);
    policyIds.add(policy.id);
  }
}

/**
 * 旧軸キー（cumulativeInputTokens / contextTokens）の警告はプロセス内で一度だけ出す。
 * supervisor は loadConfig を per-tick で繰り返し呼ぶため、毎回警告するとログスパムになる。
 */
let hasWarnedLegacyOrchestratorSessionBudgetKeys = false;

/**
 * 検証成功後の生データから旧軸キーを検出して削除する（値は一切読まない・変換しない）。
 * 旧3軸は「誤った量を測っていた」ため互換を持たない（knowledge k_91b7cb666306, D4）。
 * 該当キーが1つでもあれば、まだ警告していなければ stderr へ一度だけ警告を出す。
 */
function stripLegacyOrchestratorSessionBudgetKeys(data: Record<string, unknown>): void {
  const orchestrator = data["orchestrator"];
  if (orchestrator === null || typeof orchestrator !== "object") {
    return;
  }
  const sessionBudget = (orchestrator as Record<string, unknown>)["sessionBudget"];
  if (sessionBudget === null || typeof sessionBudget !== "object") {
    return;
  }
  const sessionBudgetRecord = sessionBudget as Record<string, unknown>;
  const foundKeys = LEGACY_ORCHESTRATOR_SESSION_BUDGET_KEYS.filter(
    (key) => key in sessionBudgetRecord,
  );
  if (foundKeys.length === 0) {
    return;
  }
  for (const key of foundKeys) {
    delete sessionBudgetRecord[key];
  }
  if (!hasWarnedLegacyOrchestratorSessionBudgetKeys) {
    hasWarnedLegacyOrchestratorSessionBudgetKeys = true;
    process.stderr.write(
      `config.json の orchestrator.sessionBudget に旧キー（${foundKeys.join(", ")}）が見つかりましたが、` +
        "無視しました。旧3軸は互換変換されません。playbook §0.7 の新4軸" +
        "（turns / contextSaturation / handoffValue / effectiveCostUsd）へ書き換えてください。\n",
    );
  }
}

/** `$HACHI_KANBAN_HOME/config.json` を読み込む。無ければ既定値、不正な内容は throw（fail-closed） */
export function loadConfig(env: Environment): HachiConfig {
  const configPath = `${env.home}/config.json`;
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json の JSON パースに失敗しました: ${(err as Error).message}`);
  }

  const result = hachiConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`config.json の検証に失敗しました: ${result.error.message}`);
  }

  stripLegacyOrchestratorSessionBudgetKeys(result.data as Record<string, unknown>);

  // zod の `.optional()` は型上 `transport?: X | undefined` を生む一方、ProfileEntry は
  // exactOptionalPropertyTypes 下で `transport?: X`（undefined を含まない）を要求する。
  // 実行時は入力に transport が無ければキー自体が省略される（undefined を代入しない）ため
  // 形状は一致しており、この型上の差異のみを吸収するために HachiConfig へ束ねる。
  const config: HachiConfig = result.data as HachiConfig;
  validateConfigSemantics(config);
  return config;
}

/**
 * 最終的な {provider, model} ペアに対して charset → allowlist の順で検証する（docs/contract.md §12.4-3）。
 * override / profile / default のどの経路で決まった値でも、この関数を必ず通す（fail-closed）。
 */
function validateResolvedModel(
  provider: Provider,
  model: string,
  config: HachiConfig,
  source: "override" | "profile" | "default",
  transport: Transport,
  effort: EffortLevel | undefined,
  speed: ExecutionSpeed | undefined,
): ModelResolution {
  if (!MODEL_CHARSET.test(model)) {
    return {
      ok: false,
      reason: "invalid-model-charset",
      detail: `model の charset が不正です: ${model}`,
    };
  }
  if (!config.allowlist[provider].includes(model)) {
    return {
      ok: false,
      reason: "model-not-allowlisted",
      detail: `model が allowlist 外です（provider=${provider}）: ${model}`,
    };
  }
  // exactOptionalPropertyTypes 下では undefined の明示代入を避け、未指定はキー自体を省略する。
  return {
    ok: true,
    provider,
    model,
    source,
    transport,
    ...(effort === undefined ? {} : { effort }),
    ...(speed === undefined ? {} : { speed }),
  };
}

/**
 * role別のモデル/プロバイダ/effort/speed解決（docs/contract.md §67.1）。
 * worker は従来fieldとdefaultProfile、reviewerはreview_* overrideと予約profile `review`を使う。
 * 値の実配送可否は buildModelTransportRequirement/evaluateModelTransportCompatibility が
 * model/runtime/transport policy と capability snapshot に対して起動前に検証する。
 */
export function resolveExecution(
  task: TaskRow,
  config: HachiConfig,
  role: ExecutionRole,
): ModelResolution {
  const profileOverride = role === "worker" ? task.profile : task.reviewProfileOverride;
  const hasExplicitProfile = profileOverride !== "";
  const profileName = hasExplicitProfile
    ? profileOverride
    : role === "worker"
      ? config.defaultProfile
      : "review";
  const profile = config.profiles[profileName];
  if (profile === undefined) {
    return { ok: false, reason: "unknown-profile", detail: `未知の profile です: ${profileName}` };
  }

  const providerOverride = role === "worker" ? task.provider : task.reviewProviderOverride;
  const provider: Provider = providerOverride !== "" ? providerOverride : profile.provider;
  if (!isProvider(provider)) {
    return { ok: false, reason: "unknown-provider", detail: `未知の provider です: ${String(provider)}` };
  }

  // 契約 §17.3: 通常は解決に使った profile の transport を伝播する（既定 "bridge"）。
  // 契約 §49.1 / §49.3 / §67.3: model/effort/speed override は direct transport を強制する。
  const profileTransport: Transport = profile.transport ?? "bridge";
  const modelOverride = role === "worker" ? task.modelOverride : task.reviewModelOverride;
  const effortOverride = role === "worker" ? task.effortOverride : task.reviewEffortOverride;
  const speedOverride = role === "worker" ? task.speedOverride : task.reviewSpeedOverride;
  if (effortOverride !== "" && !isEffortLevel(effortOverride)) {
    return { ok: false, reason: "unknown-provider", detail: `未知の effort_override です: ${String(effortOverride)}` };
  }
  if (speedOverride !== "" && !isExecutionSpeed(speedOverride)) {
    return { ok: false, reason: "unknown-provider", detail: `未知の speed_override です: ${String(speedOverride)}` };
  }
  // 契約 §49.3: effort_override が非空なら profile effort より優先する。
  const effort: EffortLevel | undefined = effortOverride !== "" ? effortOverride : profile.effort;
  const speed: ExecutionSpeed | undefined = speedOverride !== "" ? speedOverride : profile.speed;
  const transport: Transport = modelOverride !== "" || effortOverride !== "" || speedOverride !== ""
    ? "direct"
    : profileTransport;

  if (modelOverride !== "") {
    return validateResolvedModel(provider, modelOverride, config, "override", transport, effort, speed);
  }

  return validateResolvedModel(
    provider,
    profile.model,
    config,
    hasExplicitProfile ? "profile" : "default",
    transport,
    effort,
    speed,
  );
}

/** 既存API互換: 通常worker/reworkの解決。 */
export function resolveModel(task: TaskRow, config: HachiConfig): ModelResolution {
  return resolveExecution(task, config, "worker");
}
