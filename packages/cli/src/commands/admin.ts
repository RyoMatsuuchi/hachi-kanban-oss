// =============================================================================
// hachi admin: set-model / resolve
// model_override の設定と、resolveModel によるモデル/プロバイダ解決結果の表示を行う。
// =============================================================================

import { Argument, Command, InvalidArgumentError, Option } from "commander";
import {
  EFFORT_LEVELS,
  EXECUTION_SPEEDS,
  PROVIDERS,
  isEffortLevel,
  isExecutionSpeed,
  listAllowlistedModels,
  resolveExecution,
  resolveModel,
  type EffortLevel,
  type ExecutionOverridePatch,
  type ExecutionRole,
  type ExecutionSpeed,
  type ModelResolution,
  type TaskRow,
  type ActorProvenance,
  type BoardAuditEventRow,
  type BoardAuditStore,
  acquireStewardStateLock,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import { requireTask } from "../task-helpers.js";
import { formatLegacyImportReport, runLegacyImport } from "../legacy-import.js";
import { DEFAULT_BACKUP_KEEP, runBackup } from "../backup.js";
import {
  addActorPrincipalOptions,
  resolveActorProvenance,
  type ActorPrincipalOptions,
} from "../actor-provenance.js";
import {
  observeModelTransportCompatibility,
  type ModelTransportObservation,
} from "../model-transport-observability.js";
import {
  currentBriefStateHash,
  prepareBriefEnable,
  readBriefEnablePending,
  removeBriefEnablePending,
  writeBriefEnablePending,
  type BriefEnablePendingJournal,
  type BriefEnableResult,
} from "../brief-enable.js";
import {
  currentStewardStateHash,
  prepareStewardEnable,
  readStewardEnablePending,
  removeStewardEnablePending,
  writeStewardEnablePending,
  type StewardEnableResult,
  type StewardEnablePendingJournal,
} from "../steward-enable.js";

const DEFAULT_ACTOR = "human";

interface SetModelOptions extends ActorPrincipalOptions {
  clear?: boolean;
  json?: boolean;
}

interface SetEffortOptions extends ActorPrincipalOptions {
  clear?: boolean;
  json?: boolean;
}

interface SetExecutionOptions extends ActorPrincipalOptions {
  role: ExecutionRole;
  profile?: string;
  provider?: "codex" | "claude";
  model?: string;
  effort?: string;
  speed?: string;
  clearProfile?: boolean;
  clearProvider?: boolean;
  clearModel?: boolean;
  clearEffort?: boolean;
  clearSpeed?: boolean;
  json?: boolean;
}

interface ResolveOptions {
  role?: ExecutionRole | "all";
  json?: boolean;
}

interface ImportLegacyOptions {
  db: string;
  status?: string;
  task: string[];
  apply?: boolean;
  json?: boolean;
}

interface BackupOptions {
  keep?: number;
  json?: boolean;
}

interface StewardEnableOptions extends ActorPrincipalOptions {
  apply?: boolean;
  json?: boolean;
}

interface BriefEnableOptions extends ActorPrincipalOptions {
  apply?: boolean;
  json?: boolean;
}

interface StewardEnableOutput {
  apply: boolean;
  result: StewardEnableResult;
  auditEvent: BoardAuditEventRow | null;
  killSwitchChanged: false;
}

interface BriefEnableOutput {
  apply: boolean;
  result: BriefEnableResult;
  auditEvent: BoardAuditEventRow | null;
  killSwitchChanged: false;
}

type AutomationEnableAuditStore = Pick<
  BoardAuditStore,
  "assertActiveOrchestratorPrincipal" | "addBoardAuditEvent" | "listBoardAuditEvents"
>;

function requireBoardAuditStore(deps: CliDeps): AutomationEnableAuditStore {
  const candidate = deps.store as unknown as Partial<AutomationEnableAuditStore>;
  if (typeof candidate.assertActiveOrchestratorPrincipal !== "function" ||
      typeof candidate.addBoardAuditEvent !== "function" ||
      typeof candidate.listBoardAuditEvents !== "function") {
    throw new Error("この store は board audit event に対応していません");
  }
  return candidate as AutomationEnableAuditStore;
}

function stewardEnableAuditPayload(
  result: StewardEnableResult,
  operationId: string,
  recovered: boolean,
): Record<string, unknown> {
  return {
    version: "steward-enable.v1",
    operationId,
    outcome: result.outcome,
    changed: result.changed,
    lastRunAt: result.lastRunAt,
    recovered,
  };
}

function findStewardEnableAudit(
  auditStore: AutomationEnableAuditStore,
  operationId: string,
): BoardAuditEventRow | null {
  return auditStore.listBoardAuditEvents("steward_enabled")
    .find((event) => event.payload["operationId"] === operationId) ?? null;
}

interface PendingRecoveryResult {
  completed: boolean;
  result: StewardEnableResult | null;
  auditEvent: BoardAuditEventRow | null;
}

/** crash後のpendingをhash CASで完了または安全に破棄する。 */
function recoverPendingStewardEnable(
  deps: CliDeps,
  auditStore: AutomationEnableAuditStore,
  provenance: ActorProvenance,
  pending: StewardEnablePendingJournal,
): PendingRecoveryResult {
  const existing = findStewardEnableAudit(auditStore, pending.operationId);
  const recoveredResult: StewardEnableResult = {
    outcome: "changed",
    changed: true,
    lastRunAt: pending.lastRunAt,
  };
  if (existing !== null) {
    if (existing.payload["version"] !== "steward-enable.v1" ||
        existing.payload["outcome"] !== "changed" || existing.payload["changed"] !== true ||
        existing.payload["lastRunAt"] !== pending.lastRunAt) {
      throw new Error("steward-enable operationId と既存audit eventの内容が一致しません");
    }
    removeStewardEnablePending(deps.env.home);
    return { completed: true, result: recoveredResult, auditEvent: existing };
  }
  const currentHash = currentStewardStateHash(deps.env.home);
  const isCompensated = pending.version === "steward-enable-pending.v2" &&
    currentHash === pending.compensatedHash;
  if (currentHash === pending.beforeHash || isCompensated) {
    // state rename前または補償rollback後。復帰は未完了なのでevent無しで再試行する。
    removeStewardEnablePending(deps.env.home);
    return { completed: false, result: null, auditEvent: null };
  }
  if (currentHash !== pending.afterHash) {
    throw new Error("steward-enable pending中にstateが別更新されたため自動回収できません");
  }
  const auditEvent = auditStore.addBoardAuditEvent({
    eventType: "steward_enabled",
    actor: "orchestrator",
    payload: stewardEnableAuditPayload(recoveredResult, pending.operationId, true),
    provenance,
  });
  removeStewardEnablePending(deps.env.home);
  return { completed: true, result: recoveredResult, auditEvent };
}

function requireStewardOrchestratorProvenance(options: StewardEnableOptions): ActorProvenance {
  if (options.actorKind !== "orchestrator") {
    throw new Error("steward-enable は --actor-kind orchestrator が必須です");
  }
  const provenance = resolveActorProvenance(options, "orchestrator");
  if (provenance === undefined || provenance.kind !== "orchestrator") {
    throw new Error("steward-enable は active orchestrator principal が必須です");
  }
  return provenance;
}

function stewardEnableText(output: StewardEnableOutput): string[] {
  const mode = output.apply ? "apply" : "dry-run";
  const outcome = output.result.outcome === "changed"
    ? output.apply ? "auto-disable を解除しました" : "auto-disable の解除が必要です"
    : output.result.outcome === "already-enabled"
      ? "既に enabled のため変更はありません"
      : "state 未作成のため変更はありません";
  return [
    `steward-enable (${mode}): ${outcome}`,
    `lastRunAt=${output.result.lastRunAt ?? "none"} changed=${String(output.result.changed && output.apply)}`,
    "kill-switch steward.disabled は変更していません",
  ];
}

/** docs/contract.md §40.6: active exact orchestrator だけが明示 --apply で復帰できる。 */
function runStewardEnable(deps: CliDeps, options: StewardEnableOptions): void {
  const provenance = requireStewardOrchestratorProvenance(options);
  const auditStore = requireBoardAuditStore(deps);
  // dry-run を含め、fileを読む前に現在のStore authorityを再照合する。
  auditStore.assertActiveOrchestratorPrincipal(provenance);
  const apply = options.apply === true;
  if (!apply) {
    if (readStewardEnablePending(deps.env.home) !== null) {
      throw new Error("未回収の steward-enable pending があります。active orchestratorから --apply で回収してください");
    }
    const plan = prepareStewardEnable(deps.env.home);
    const output: StewardEnableOutput = {
      apply: false,
      result: plan.result,
      auditEvent: null,
      killSwitchChanged: false,
    };
    emit(deps, options.json === true, output, stewardEnableText(output));
    return;
  }

  const lock = acquireStewardStateLock(deps.env.home, "cli-steward-enable", { recoverStale: true });
  if (lock === null) {
    throw new Error("steward state lock を取得できませんでした");
  }
  let auditEvent: BoardAuditEventRow | null = null;
  let result: StewardEnableResult;
  try {
    const pending = readStewardEnablePending(deps.env.home);
    if (pending !== null) {
      const recovery = recoverPendingStewardEnable(deps, auditStore, provenance, pending);
      if (recovery.completed) {
        result = recovery.result!;
        auditEvent = recovery.auditEvent;
        const output: StewardEnableOutput = {
          apply: true,
          result,
          auditEvent,
          killSwitchChanged: false,
        };
        emit(deps, options.json === true, output, stewardEnableText(output));
        return;
      }
    }

    const plan = prepareStewardEnable(deps.env.home);
    result = plan.result;
    let applied = null as ReturnType<typeof plan.apply>;
    if (plan.result.changed) {
      if (plan.beforeHash === null || plan.afterHash === null || plan.compensatedHash === null ||
          plan.result.lastRunAt === null) {
        throw new Error("steward-enable changed plan のhash/lastRunAtが欠落しています");
      }
      writeStewardEnablePending(deps.env.home, {
        version: "steward-enable-pending.v2",
        operationId: lock.operationId,
        beforeHash: plan.beforeHash,
        afterHash: plan.afterHash,
        compensatedHash: plan.compensatedHash,
        outcome: "changed",
        lastRunAt: plan.result.lastRunAt,
        createdAt: Math.floor(Date.now() / 1_000),
      });
      applied = plan.apply();
    }
    try {
      auditEvent = auditStore.addBoardAuditEvent({
        eventType: "steward_enabled",
        actor: "orchestrator",
        payload: stewardEnableAuditPayload(plan.result, lock.operationId, false),
        provenance,
      });
    } catch (error) {
      if (applied !== null) {
        try {
          const rolledBack = applied.rollbackIfUnchanged();
          if (rolledBack) {
            removeStewardEnablePending(deps.env.home);
          } else {
            throw new Error("post-write stateが一致せず、別更新を保護するためrollbackしませんでした");
          }
        } catch (rollbackError) {
          const primary = error instanceof Error ? error.message : String(error);
          const secondary = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`board audit 記録失敗後の steward state rollback に失敗しました: ${primary}; ${secondary}`);
        }
      }
      throw error;
    }
    if (plan.result.changed) {
      removeStewardEnablePending(deps.env.home);
    }
    const output: StewardEnableOutput = {
      apply: true,
      result,
      auditEvent,
      killSwitchChanged: false,
    };
    emit(deps, options.json === true, output, stewardEnableText(output));
  } finally {
    lock.release();
  }
}

function briefEnableAuditPayload(
  result: BriefEnableResult,
  operationId: string,
  recovered: boolean,
): Record<string, unknown> {
  return {
    version: "brief-enable.v1",
    operationId,
    outcome: result.outcome,
    changed: result.changed,
    lastRunAt: result.lastRunAt,
    recovered,
  };
}

function findBriefEnableAudit(
  auditStore: AutomationEnableAuditStore,
  operationId: string,
): BoardAuditEventRow | null {
  return auditStore.listBoardAuditEvents("brief_enabled")
    .find((event) => event.payload["operationId"] === operationId) ?? null;
}

interface BriefPendingRecoveryResult {
  completed: boolean;
  result: BriefEnableResult | null;
  auditEvent: BoardAuditEventRow | null;
}

function recoverPendingBriefEnable(
  deps: CliDeps,
  auditStore: AutomationEnableAuditStore,
  provenance: ActorProvenance,
  pending: BriefEnablePendingJournal,
): BriefPendingRecoveryResult {
  const existing = findBriefEnableAudit(auditStore, pending.operationId);
  const recoveredResult: BriefEnableResult = {
    outcome: "changed",
    changed: true,
    lastRunAt: pending.lastRunAt,
  };
  if (existing !== null) {
    if (existing.payload["version"] !== "brief-enable.v1" ||
        existing.payload["outcome"] !== "changed" || existing.payload["changed"] !== true ||
        existing.payload["lastRunAt"] !== pending.lastRunAt) {
      throw new Error("brief-enable operationId と既存audit eventの内容が一致しません");
    }
    removeBriefEnablePending(deps.env.home);
    return { completed: true, result: recoveredResult, auditEvent: existing };
  }
  const currentHash = currentBriefStateHash(deps.env.home);
  const isCompensated = pending.version === "brief-enable-pending.v2" &&
    currentHash === pending.compensatedHash;
  if (currentHash === pending.beforeHash || isCompensated) {
    removeBriefEnablePending(deps.env.home);
    return { completed: false, result: null, auditEvent: null };
  }
  if (currentHash !== pending.afterHash) {
    throw new Error("brief-enable pending中にstateが別更新されたため自動回収できません");
  }
  const auditEvent = auditStore.addBoardAuditEvent({
    eventType: "brief_enabled",
    actor: "orchestrator",
    payload: briefEnableAuditPayload(recoveredResult, pending.operationId, true),
    provenance,
  });
  removeBriefEnablePending(deps.env.home);
  return { completed: true, result: recoveredResult, auditEvent };
}

function requireBriefOrchestratorProvenance(options: BriefEnableOptions): ActorProvenance {
  if (options.actorKind !== "orchestrator") {
    throw new Error("brief-enable は --actor-kind orchestrator が必須です");
  }
  const provenance = resolveActorProvenance(options, "orchestrator");
  if (provenance === undefined || provenance.kind !== "orchestrator") {
    throw new Error("brief-enable は active orchestrator principal が必須です");
  }
  return provenance;
}

function briefEnableText(output: BriefEnableOutput): string[] {
  const mode = output.apply ? "apply" : "dry-run";
  const outcome = output.result.outcome === "changed"
    ? output.apply ? "auto-disable を解除しました" : "auto-disable の解除が必要です"
    : output.result.outcome === "already-enabled"
      ? "既に enabled のため変更はありません"
      : "state 未作成のため変更はありません";
  return [
    `brief-enable (${mode}): ${outcome}`,
    `lastRunAt=${output.result.lastRunAt ?? "none"} changed=${String(output.result.changed && output.apply)}`,
    "kill-switch brief.disabled は変更していません",
  ];
}

/** docs/contract.md §48.3: active exact orchestratorだけが明示--applyで復帰できる。 */
function runBriefEnable(deps: CliDeps, options: BriefEnableOptions): void {
  const provenance = requireBriefOrchestratorProvenance(options);
  const auditStore = requireBoardAuditStore(deps);
  auditStore.assertActiveOrchestratorPrincipal(provenance);
  const apply = options.apply === true;
  if (!apply) {
    if (readBriefEnablePending(deps.env.home) !== null) {
      throw new Error("未回収の brief-enable pending があります。active orchestratorから --apply で回収してください");
    }
    const plan = prepareBriefEnable(deps.env.home);
    const output: BriefEnableOutput = {
      apply: false,
      result: plan.result,
      auditEvent: null,
      killSwitchChanged: false,
    };
    emit(deps, options.json === true, output, briefEnableText(output));
    return;
  }

  const lock = acquireStewardStateLock(deps.env.home, "cli-brief-enable", { recoverStale: true });
  if (lock === null) {
    throw new Error("automation state lock を取得できませんでした");
  }
  let auditEvent: BoardAuditEventRow | null = null;
  let result: BriefEnableResult;
  try {
    const pending = readBriefEnablePending(deps.env.home);
    if (pending !== null) {
      const recovery = recoverPendingBriefEnable(deps, auditStore, provenance, pending);
      if (recovery.completed) {
        result = recovery.result!;
        auditEvent = recovery.auditEvent;
        const output: BriefEnableOutput = {
          apply: true,
          result,
          auditEvent,
          killSwitchChanged: false,
        };
        emit(deps, options.json === true, output, briefEnableText(output));
        return;
      }
    }

    const plan = prepareBriefEnable(deps.env.home);
    result = plan.result;
    let applied = null as ReturnType<typeof plan.apply>;
    if (plan.result.changed) {
      if (plan.beforeHash === null || plan.afterHash === null || plan.compensatedHash === null ||
          plan.result.lastRunAt === null) {
        throw new Error("brief-enable changed plan のhash/lastRunAtが欠落しています");
      }
      writeBriefEnablePending(deps.env.home, {
        version: "brief-enable-pending.v2",
        operationId: lock.operationId,
        beforeHash: plan.beforeHash,
        afterHash: plan.afterHash,
        compensatedHash: plan.compensatedHash,
        outcome: "changed",
        lastRunAt: plan.result.lastRunAt,
        createdAt: Math.floor(Date.now() / 1_000),
      });
      applied = plan.apply();
    }
    try {
      auditEvent = auditStore.addBoardAuditEvent({
        eventType: "brief_enabled",
        actor: "orchestrator",
        payload: briefEnableAuditPayload(plan.result, lock.operationId, false),
        provenance,
      });
    } catch (error) {
      if (applied !== null) {
        try {
          const rolledBack = applied.rollbackIfUnchanged();
          if (rolledBack) {
            removeBriefEnablePending(deps.env.home);
          } else {
            throw new Error("post-write stateが一致せず、別更新を保護するためrollbackしませんでした");
          }
        } catch (rollbackError) {
          const primary = error instanceof Error ? error.message : String(error);
          const secondary = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`board audit 記録失敗後の brief state rollback に失敗しました: ${primary}; ${secondary}`);
        }
      }
      throw error;
    }
    if (plan.result.changed) {
      removeBriefEnablePending(deps.env.home);
    }
    const output: BriefEnableOutput = {
      apply: true,
      result,
      auditEvent,
      killSwitchChanged: false,
    };
    emit(deps, options.json === true, output, briefEnableText(output));
  } finally {
    lock.release();
  }
}

/**
 * --keep 専用の非負整数パーサ（docs/contract.md §19）。
 * task.ts の parsePositiveIntArg は 1 以上限定のため使えない（0 世代保持も許容する必要がある）。
 * Number.parseInt の部分マッチ（'3abc' → 3）を許さないよう正規表現で完全一致を確認する。
 */
function parseNonNegativeIntArg(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidArgumentError(`0 以上の整数を指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function formatOverrideForcedReason(task: TaskRow, role: ExecutionRole = "worker"): string {
  const reasons: string[] = [];
  if (role === "worker") {
    if (task.modelOverride !== "") {
      reasons.push("model_override");
    }
    if (task.effortOverride !== "") {
      reasons.push("effort_override");
    }
    if (task.speedOverride !== "") {
      reasons.push("speed_override");
    }
  } else {
    if (task.reviewProfileOverride !== "") {
      reasons.push("review_profile_override");
    }
    if (task.reviewProviderOverride !== "") {
      reasons.push("review_provider_override");
    }
    if (task.reviewModelOverride !== "") {
      reasons.push("review_model_override");
    }
    if (task.reviewEffortOverride !== "") {
      reasons.push("review_effort_override");
    }
    if (task.reviewSpeedOverride !== "") {
      reasons.push("review_speed_override");
    }
  }
  return reasons.length > 0 ? ` (override 強制: ${reasons.join(",")})` : "";
}

/** ModelResolution をテキスト表示用に整形する */
function formatResolution(
  task: TaskRow,
  resolution: ModelResolution,
  role: ExecutionRole = "worker",
): string {
  if (resolution.ok) {
    const effortText = resolution.effort !== undefined ? resolution.effort : "";
    const speedText = resolution.speed !== undefined ? resolution.speed : "";
    const transportSuffix = resolution.transport === "direct" ? formatOverrideForcedReason(task, role) : "";
    return `解決結果: role=${role} provider=${resolution.provider} model=${resolution.model} source=${resolution.source} effort=${effortText} speed=${speedText} transport=${resolution.transport}${transportSuffix}`;
  }
  return `解決失敗: role=${role} reason=${resolution.reason} detail=${resolution.detail}`;
}

/** hachi admin set-model の action 本体 */
function runSetModel(deps: CliDeps, id: string, model: string | undefined, options: SetModelOptions): void {
  const clear = options.clear === true;
  if (!clear && (model === undefined || model.length === 0)) {
    throw new Error("model を指定するか --clear を指定してください");
  }

  const value = clear ? "" : (model as string);
  const provenance = requireExecutionOrchestratorProvenance(options, "set-model");
  const { task, resolution } = applyExecutionOverrides(
    deps,
    id,
    "worker",
    { model: value },
    provenance,
  );
  const json = options.json === true;

  emit(deps, json, singularResourceEnvelope(task, { task, resolution }), [
    `model_override を設定しました: ${task.id} model_override="${task.modelOverride}"`,
    formatResolution(task, resolution),
  ]);
}

/** hachi admin set-effort の action 本体 */
function runSetEffort(deps: CliDeps, id: string, effort: string | undefined, options: SetEffortOptions): void {
  const clear = options.clear === true;
  if (!clear && (effort === undefined || effort.length === 0)) {
    throw new Error("effort を指定するか --clear を指定してください");
  }
  if (!clear && effort !== undefined && !isEffortLevel(effort)) {
    throw new Error(`effort は low / medium / high / xhigh のみ指定できます: ${effort}`);
  }

  const value: EffortLevel | "" = clear ? "" : (effort as EffortLevel);
  const provenance = requireExecutionOrchestratorProvenance(options, "set-effort");
  const { task, resolution } = applyExecutionOverrides(
    deps,
    id,
    "worker",
    { effort: value },
    provenance,
  );
  const json = options.json === true;

  emit(deps, json, singularResourceEnvelope(task, { task, resolution }), [
    `effort_override を設定しました: ${task.id} effort_override="${task.effortOverride}"`,
    formatResolution(task, resolution),
  ]);
}

function setOrClear<T extends string>(
  label: string,
  value: T | undefined,
  clear: boolean | undefined,
): T | "" | undefined {
  if (value !== undefined && clear === true) {
    throw new Error(`${label} と --clear-${label} は同時に指定できません`);
  }
  if (clear === true) {
    return "";
  }
  return value;
}

function executionPatch(options: SetExecutionOptions): ExecutionOverridePatch {
  if (options.effort !== undefined && !isEffortLevel(options.effort)) {
    throw new Error(`--effort は ${EFFORT_LEVELS.join(" / ")} のみ指定できます: ${options.effort}`);
  }
  if (options.speed !== undefined && !isExecutionSpeed(options.speed)) {
    throw new Error(`--speed は ${EXECUTION_SPEEDS.join(" / ")} のみ指定できます: ${options.speed}`);
  }
  const profile = setOrClear("profile", options.profile, options.clearProfile);
  const provider = setOrClear("provider", options.provider, options.clearProvider);
  const model = setOrClear("model", options.model, options.clearModel);
  const effort = setOrClear("effort", options.effort as EffortLevel | undefined, options.clearEffort);
  const speed = setOrClear("speed", options.speed as ExecutionSpeed | undefined, options.clearSpeed);
  const patch: ExecutionOverridePatch = {
    ...(profile === undefined ? {} : { profile }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(speed === undefined ? {} : { speed }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("execution override を1項目以上指定してください");
  }
  return patch;
}

function requireExecutionOrchestratorProvenance(
  options: ActorPrincipalOptions,
  command: string,
): ActorProvenance {
  const provenance = resolveActorProvenance(options, DEFAULT_ACTOR);
  if (provenance?.kind !== "orchestrator") {
    throw new Error(
      `${command} は --actor-kind orchestrator と --orchestrator/--session/--generation が必須です`,
    );
  }
  return provenance;
}

/** setterとrole別解決を同じouter transactionで行い、不正な組を永続化しない。 */
function applyExecutionOverrides(
  deps: CliDeps,
  id: string,
  role: ExecutionRole,
  patch: ExecutionOverridePatch,
  provenance: ActorProvenance,
): { task: TaskRow; resolution: ModelResolution } {
  let task!: TaskRow;
  let resolution!: ModelResolution;
  deps.store.transaction((): void => {
    task = deps.store.setExecutionOverrides(id, role, patch, DEFAULT_ACTOR, provenance);
    resolution = resolveExecution(task, deps.config, role);
    if (!resolution.ok) {
      throw new Error(
        `${role} execution override の解決に失敗しました: ${resolution.reason} ${resolution.detail}`,
      );
    }
  });
  return { task, resolution };
}

/** role別execution overrideを一つのStore transactionへ委譲する。 */
function runSetExecution(deps: CliDeps, id: string, options: SetExecutionOptions): void {
  const provenance = requireExecutionOrchestratorProvenance(options, "set-execution");
  const patch = executionPatch(options);
  const { task, resolution } = applyExecutionOverrides(deps, id, options.role, patch, provenance);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(task, { task, role: options.role, patch, resolution }),
    [
      `execution override を設定しました: ${task.id} role=${options.role}`,
      formatResolution(task, resolution, options.role),
    ],
  );
}

/** hachi admin resolve の action 本体 */
function formatObservation(observation: ModelTransportObservation): string[] {
  const runtime = observation.observed === null
    ? "runtime=unknown"
    : `runtime=${observation.observed.runtime.name}@${observation.observed.runtime.version ?? "unknown"}`;
  const capabilities = observation.observed?.capabilities.join(",") ?? "unknown";
  const decision = observation.decision.status === "supported"
    ? `status=supported evidence=${observation.decision.evidence}`
    : `status=${observation.decision.status} reason=${observation.decision.reason} detail=${observation.decision.detail}`;
  return [
    `互換期待: provider=${observation.expectation.provider} model=${observation.expectation.model} transport=${observation.expectation.transport} minimumRuntimeVersion=${observation.expectation.minimumRuntimeVersion ?? "none"}`,
    `実広告: ${runtime} capabilities=${capabilities}`,
    `互換判定: ${decision}`,
  ];
}

interface ResolveTransportContext {
  policyTransport: "direct" | "bridge" | null;
  probeTransport: "direct" | "bridge" | null;
  isLaunchEvidence: false;
  actualTransportSource: "run-meta-or-launched-event";
}

/** 設定とprobeを実起動証拠へ昇格させない。取得していないrun情報は返さない。 */
function resolveTransportContext(
  resolution: ModelResolution,
  compatibility: ModelTransportObservation | null,
): ResolveTransportContext {
  return {
    policyTransport: resolution.ok ? resolution.transport : null,
    probeTransport: compatibility?.expectation.transport ?? null,
    isLaunchEvidence: false,
    actualTransportSource: "run-meta-or-launched-event",
  };
}

function formatTransportContext(
  resolution: ModelResolution,
  compatibility: ModelTransportObservation | null,
): string {
  const context = resolveTransportContext(resolution, compatibility);
  return `transportの区別: 設定候補=${context.policyTransport ?? "unknown"} probe対象=${context.probeTransport ?? "none"}。起動済み経路の証拠ではありません。実行中はrun meta/launched eventを確認してください。`;
}

async function runResolve(deps: CliDeps, id: string, options: ResolveOptions): Promise<void> {
  const task = requireTask(deps, id);
  const json = options.json === true;
  const requestedRole = options.role ?? "worker";
  if (requestedRole !== "all") {
    const resolution = requestedRole === "worker"
      ? resolveModel(task, deps.config)
      : resolveExecution(task, deps.config, requestedRole);
    const compatibility = resolution.ok
      ? await observeModelTransportCompatibility(deps, task, resolution, undefined, requestedRole)
      : null;

    emit(
      deps,
      json,
      singularResourceEnvelope(task, {
        task, role: requestedRole, resolution, compatibility,
        transportContext: resolveTransportContext(resolution, compatibility),
      }),
      [
        formatResolution(task, resolution, requestedRole),
        formatTransportContext(resolution, compatibility),
        ...(compatibility === null ? [] : formatObservation(compatibility)),
      ],
    );
    return;
  }

  const workerResolution = resolveExecution(task, deps.config, "worker");
  const reviewerResolution = resolveExecution(task, deps.config, "reviewer");
  const [workerCompatibility, reviewerCompatibility] = await Promise.all([
    workerResolution.ok
      ? observeModelTransportCompatibility(deps, task, workerResolution, undefined, "worker")
      : Promise.resolve(null),
    reviewerResolution.ok
      ? observeModelTransportCompatibility(deps, task, reviewerResolution, undefined, "reviewer")
      : Promise.resolve(null),
  ]);
  const executions = {
    worker: {
      resolution: workerResolution, compatibility: workerCompatibility,
      transportContext: resolveTransportContext(workerResolution, workerCompatibility),
    },
    reviewer: {
      resolution: reviewerResolution, compatibility: reviewerCompatibility,
      transportContext: resolveTransportContext(reviewerResolution, reviewerCompatibility),
    },
  };

  emit(
    deps,
    json,
    singularResourceEnvelope(task, { task, role: "all", executions }),
    [
      formatResolution(task, workerResolution, "worker"),
      formatTransportContext(workerResolution, workerCompatibility),
      ...(workerCompatibility === null ? [] : formatObservation(workerCompatibility)),
      formatResolution(task, reviewerResolution, "reviewer"),
      formatTransportContext(reviewerResolution, reviewerCompatibility),
      ...(reviewerCompatibility === null ? [] : formatObservation(reviewerCompatibility)),
    ],
  );
}

/**
 * hachi admin import-legacy の action 本体（docs/contract.md §16）。
 * 既定 dry-run。--apply 指定時のみ新ボード（deps.store）へ書き込む。
 * 旧 DB（--db）へは legacy-import.ts が読み取り専用アクセスのみを行う。
 */
function runImportLegacy(deps: CliDeps, options: ImportLegacyOptions): void {
  const report = runLegacyImport(deps.env, deps.store, {
    dbPath: options.db,
    statusCsv: options.status,
    taskIds: options.task,
    apply: options.apply === true,
  });
  const json = options.json === true;

  emit(deps, json, { report }, formatLegacyImportReport(report));

  if (report.errors.length > 0) {
    deps.exit(1);
  }
}

/**
 * hachi admin backup の action 本体（docs/contract.md §19）。
 * ボード DB のバックアップを作成し、古い世代を keep 件まで削除する（既定 keep=DEFAULT_BACKUP_KEEP）。
 */
async function runBackupCommand(deps: CliDeps, options: BackupOptions): Promise<void> {
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  const result = await runBackup(deps.env, keep);
  const json = options.json === true;

  emit(deps, json, { result }, [
    `バックアップを作成しました: ${result.createdPath}`,
    result.deletedPaths.length > 0
      ? `古い世代を削除しました（${result.deletedPaths.length}件）: ${result.deletedPaths.join(", ")}`
      : "削除した古い世代はありません",
  ]);
}

/** hachi admin サブコマンド群を登録する */
export function registerAdminCommand(program: Command, deps: CliDeps): void {
  const admin = program.command("admin").description("管理系コマンド");

  const setExecution = admin
    .command("set-execution")
    .description("worker/reviewer の execution override を原子的に設定する")
    .argument("<id>", "タスク ID")
    .addOption(
      new Option("--role <role>", "設定対象 role").choices(["worker", "reviewer"]).makeOptionMandatory(),
    )
    .addOption(
      new Option("--profile <profile>", "profile override").choices(Object.keys(deps.config.profiles)),
    )
    .addOption(new Option("--provider <provider>", "provider override").choices(PROVIDERS))
    .addOption(
      new Option("--model <model>", "model override").choices(listAllowlistedModels(deps.config)),
    )
    .option("--effort <effort>", `effort override（${EFFORT_LEVELS.join(" / ")}）`)
    .addOption(new Option("--speed <speed>", "処理速度 override（policy非対応は起動前にfail-closed）").choices(EXECUTION_SPEEDS))
    .option("--clear-profile", "profile override をクリアする")
    .option("--clear-provider", "provider override をクリアする")
    .option("--clear-model", "model override をクリアする")
    .option("--clear-effort", "effort override をクリアする")
    .option("--clear-speed", "speed override をクリアする");
  addActorPrincipalOptions(setExecution)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, options: SetExecutionOptions): void => runSetExecution(deps, id, options),
      ),
    );

  const setModel = admin
    .command("set-model")
    .description("worker の model_override を設定する互換 alias（--clear でクリア）")
    .argument("<id>", "タスク ID")
    .addArgument(
      new Argument("[model]", "設定するモデル名（--clear 指定時は不要）").choices(
        listAllowlistedModels(deps.config),
      ),
    )
    .option("--clear", "model_override をクリアする");
  addActorPrincipalOptions(setModel)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, model: string | undefined, options: SetModelOptions): void =>
          runSetModel(deps, id, model, options),
      ),
    );

  const setEffort = admin
    .command("set-effort")
    .description("worker の effort_override を設定する互換 alias（--clear でクリア）")
    .argument("<id>", "タスク ID")
    .argument("[effort]", `設定する effort（${EFFORT_LEVELS.join(" / ")}。--clear 指定時は不要）`)
    .option("--clear", "effort_override をクリアする");
  addActorPrincipalOptions(setEffort)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (id: string, effort: string | undefined, options: SetEffortOptions): void =>
          runSetEffort(deps, id, effort, options),
      ),
    );

  admin
    .command("resolve")
    .description("worker/reviewer の設定解決と現時点の互換性probeを表示する（起動済みtransportはrun meta/launched eventで確認）")
    .argument("<id>", "タスク ID")
    .addOption(new Option("--role <role>", "表示対象 role").choices(["worker", "reviewer", "all"]))
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (id: string, options: ResolveOptions): Promise<void> => runResolve(deps, id, options)),
    );

  admin
    .command("import-legacy")
    .description(
      "旧 legacy-hermes ボードの生きタスク（triage/todo/blocked）を新ボードへ移行する（既定 dry-run）",
    )
    .requiredOption("--db <path>", "旧 DB ファイルパス（読み取り専用アクセスのみ）")
    .option("--status <csv>", "対象状態（CSV。既定 triage,todo,blocked。done/archived は指定不可）")
    .option(
      "--task <id>",
      "対象タスクの旧 ID に絞り込む（複数指定可）",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--apply", "実際に import を実行する（省略時は dry-run）")
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (options: ImportLegacyOptions): void => runImportLegacy(deps, options)),
    );

  admin
    .command("backup")
    .description(`ボード DB のバックアップを作成し、古い世代を keep 件まで削除する（既定 keep=${DEFAULT_BACKUP_KEEP}）`)
    .option("--keep <n>", `保持する世代数（0以上の整数。既定 ${DEFAULT_BACKUP_KEEP}）`, parseNonNegativeIntArg)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (options: BackupOptions): Promise<void> => runBackupCommand(deps, options)),
    );

  const stewardEnable = admin
    .command("steward-enable")
    .description("steward auto-disable を復帰する（既定 dry-run、--apply で適用）")
    .option("--apply", "steward state の auto-disable fields を実際にリセットする");
  addActorPrincipalOptions(stewardEnable)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (options: StewardEnableOptions): void => runStewardEnable(deps, options),
      ),
    );

  const briefEnable = admin
    .command("brief-enable")
    .description("brief auto-disable を復帰する（既定 dry-run、--apply で適用）")
    .option("--apply", "brief state の auto-disable fields を実際にリセットする");
  addActorPrincipalOptions(briefEnable)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(
        deps,
        (options: BriefEnableOptions): void => runBriefEnable(deps, options),
      ),
    );
}
