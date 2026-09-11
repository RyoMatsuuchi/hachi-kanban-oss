// provider native communication を supervisor の durable lifecycle へ接続する局所面。
// Core の migration/API は additive に着地するため、ここでは StageDeps と Store の構造的な
// capability だけを使い、古い binary へ暗黙 fallback しない。
import {
  communicationCanaryCohortKey,
  isCommunicationCanaryEligible,
  isInProgressReason,
  nativeSessionBindingHash,
  redactJsonStrings,
  redactText,
  resolveCommunicationRoute,
  sha256Hex,
} from "@hachi/core";
import type {
  CommunicationCapabilityState,
  CommunicationDeliveryAttemptRow,
  CommunicationPreference,
  CommunicationProviderConfig,
  CommunicationRouteDecision,
  HachiConfig,
  NativeCommunicationAdapter,
  NativeCommunicationDeliveryRequest,
  NativeCommunicationProbeResult,
  NativeCommunicationSessionRef,
  NativeCommunicationSocketSnapshot,
  NativeCommunicationStore,
  NativeSessionBindingRow,
  Provider,
  RebindRecordedNativeCommunicationAttemptInput,
  RunRow,
  SessionRef,
  StageDeps,
  TaskRow,
  WorkerAdapter,
} from "@hachi/core";
import type { SteerDeliveryRow } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "./constants.js";
import { parseRunMeta } from "./session-ref.js";

const DEFAULT_CLAIM_LEASE_SECONDS = 60;

/** Supervisor 自身が target binding を作るときに用いる構造化 service principal。 */
export const SUPERVISOR_SERVICE_PROVENANCE = {
  kind: "service",
  actorId: SUPERVISOR_ACTOR,
  actorSessionId: "",
  actorGeneration: null,
} as const;

export interface StageDepsWithNativeReload extends StageDeps {
  reloadConfig?: () => HachiConfig;
}

export type NativeStoreCapability = Pick<NativeCommunicationStore,
  "createOrGetNativeTargetBinding" |
  "getNativeSessionBinding" | "listNativeSessionBindings"> & Partial<Pick<NativeCommunicationStore,
  "getCommunicationAttempt" | "listCommunicationAttempts" |
  "listNativeCommunicationRedriveCandidates" |
  "rebindRecordedNativeCommunicationAttempt" |
  "claimNativeCommunicationAttempt" |
  "beginNativeCommunicationDispatch" | "recordNativeCommunicationReceipt" |
  "recoverNativeCommunicationAttempts" | "promoteCommunicationAttemptToNative">>;

/**
 * v20 Core が neutral v0.17 attempt を同一行のまま native metadata へ promote
 * するときの構造的 capability。API 名・入力は Core の additive change と同期して
 * 解決するため、旧 Store に対しては決して create を代用しない。
 */
interface NativeAttemptPromotionInput {
  attemptId: string;
  route: Exclude<CommunicationRouteDecision["route"], null | "hachi">;
  sourceBindingId: string;
  targetBindingId: string;
  configHash: string;
  configSnapshot: {
    rollout: "canary" | "on";
    minimumRuntimeVersion: string;
    sameHostOnly: true;
    canaryPercent?: number;
  };
  capabilityHash: string;
  sourceBindingHash?: string;
  targetBindingHash?: string;
  nativeCandidate?: Exclude<CommunicationRouteDecision["route"], null | "hachi">;
  decisionReason?: string;
  decision?: CommunicationRouteDecision;
  routing?: NativeCommunicationRouting;
  actor?: string;
  provenance: typeof SUPERVISOR_SERVICE_PROVENANCE;
}

interface NativeCommunicationRouting {
  sourceProvider: Provider;
  targetProvider: Provider;
  rollout: CommunicationProviderConfig["rollout"];
  preference: CommunicationPreference;
  sameHost: boolean;
  exactSourceBinding: true;
  exactTargetBinding: true;
  capability: "supported";
  canaryEligible: boolean;
}

interface NativeStoreWithPromotion extends NativeStoreCapability {
  promoteCommunicationAttemptToNative?: (input: NativeAttemptPromotionInput) => CommunicationDeliveryAttemptRow;
}

export interface NativeTargetBindingInput {
  task: TaskRow;
  run: RunRow;
  ref: SessionRef;
  role: "worker" | "reviewer";
  expectedCancelFence: number;
  now: number;
}

export interface NativeTargetBindingResult {
  binding: NativeSessionBindingRow | null;
  reason?: string;
}

export interface NativeSteerPreparation {
  kind: "hachi" | "native" | "relay-wait" | "refused";
  decision: CommunicationRouteDecision;
  rollout: CommunicationProviderConfig["rollout"];
  configHash: string;
  capabilityHash: string;
  sourceBinding: NativeSessionBindingRow | null;
  targetBinding: NativeSessionBindingRow | null;
  /** probe と target binding が同じ exact address を見ていた証拠。 */
  targetEvidence: NativeCommunicationSessionRef | null;
  attempt: CommunicationDeliveryAttemptRow | null;
  sourceProvenance: {
    kind: "orchestrator";
    actorId: string;
    actorSessionId: string;
    actorGeneration: number;
  } | null;
  reason: string;
}

export interface NativeSteerInput {
  deps: StageDepsWithNativeReload;
  config: HachiConfig;
  task: TaskRow;
  run: RunRow;
  ref: SessionRef;
  deliveryId: string;
  messageKey: string;
  message: string;
  sourceProvider: Provider | "";
  sourceSessionId: string;
  preference: CommunicationPreference;
  now: number;
  /** CLI が先に記録した v0.17 attempt。存在時は同じ行を CAS promote する。 */
  communicationAttemptId?: string;
}

export interface NativeDeliveryResult {
  status: "transport_accepted" | "session_observed" | "acknowledged" | "rejected" | "uncertain";
  receiptId: string;
  detail?: string;
}

function workerAdapterFromNative(adapter: NativeCommunicationAdapter): WorkerAdapter | null {
  const candidate = adapter as unknown as Partial<WorkerAdapter>;
  if (
    typeof candidate.launch !== "function" ||
    typeof candidate.status !== "function" ||
    typeof candidate.inject !== "function" ||
    typeof candidate.fetchTranscript !== "function" ||
    typeof candidate.healthCheck !== "function"
  ) {
    return null;
  }
  return adapter as unknown as WorkerAdapter;
}

/** active native rollout でだけ native-capable worker adapter を launch に選ぶ。 */
export function pickNativeWorkerAdapter(
  deps: StageDeps,
  provider: Provider,
  selected: boolean,
): WorkerAdapter | null {
  if (!selected) {
    return null;
  }
  const adapter = deps.nativeCommunicationAdapters?.[provider];
  return adapter === undefined ? null : workerAdapterFromNative(adapter);
}

function nativeStore(store: StageDeps["store"]): NativeStoreCapability | null {
  const candidate = store as unknown as Partial<NativeStoreCapability>;
  if (
    typeof candidate.getNativeSessionBinding !== "function" ||
    typeof candidate.listNativeSessionBindings !== "function" ||
    typeof candidate.createOrGetNativeTargetBinding !== "function"
  ) {
    return null;
  }
  return candidate as NativeStoreCapability;
}

function communicationConfig(config: HachiConfig, provider: Provider): CommunicationProviderConfig {
  return config.communication?.[provider] ?? { rollout: "off" };
}

export function nativeRollout(config: HachiConfig, provider: Provider): CommunicationProviderConfig["rollout"] {
  return communicationConfig(config, provider).rollout;
}

export function nativeConfigHash(config: HachiConfig, provider: Provider): string {
  const entry = communicationConfig(config, provider);
  return sha256Hex(JSON.stringify({ provider, communication: entry }));
}

export function nativeCanaryEligible(taskId: string, provider: Provider, percent: number | undefined): boolean {
  if (percent === undefined || !Number.isInteger(percent) || percent < 1 || percent > 100) {
    return false;
  }
  return isCommunicationCanaryEligible(taskId, communicationCanaryCohortKey(provider), percent);
}

/** launchとsteerで共有するtask/provider単位のnative選出。 */
export function nativeLaunchSelected(config: HachiConfig, provider: Provider, taskId: string): boolean {
  const entry = communicationConfig(config, provider);
  if (entry.rollout === "on") {
    return true;
  }
  return entry.rollout === "canary" && nativeCanaryEligible(taskId, provider, entry.canaryPercent);
}

function parseVersion(value: string): [number, number, number, string] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1] ?? "0"), Number(match[2] ?? "0"), Number(match[3] ?? "0"), match[4] ?? ""];
}

function versionAtLeast(actual: string, minimum: string | undefined): boolean {
  if (minimum === undefined || minimum === "") {
    return true;
  }
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (left === null || right === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue;
    }
  }
  if (left[3] === right[3]) {
    return true;
  }
  return left[3] === "";
}

function bindingEvidence(ref: SessionRef): NativeCommunicationSessionRef | null {
  return ref.nativeCommunication ?? null;
}

function nativeReferenceKey(ref: NativeCommunicationSessionRef): string {
  return ref.route === "codex-app-server"
    ? `${ref.route}:${ref.providerSessionId}:${ref.threadId}:${ref.activeTurnId}`
    : `${ref.route}:${ref.providerSessionId}:${ref.agentRef}`;
}

/** DB に保存する route-specific exact address。provider session 名だけでは配送先にならない。 */
function nativeAddressFor(ref: NativeCommunicationSessionRef): string {
  return ref.route === "codex-app-server"
    ? JSON.stringify({
        route: ref.route,
        threadId: ref.threadId,
        activeTurnId: ref.activeTurnId,
        socketSnapshot: ref.socketSnapshot,
      })
    : JSON.stringify({ route: ref.route, agentRef: ref.agentRef });
}

function parseSocketSnapshot(value: unknown): NativeCommunicationSocketSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const stringFields = ["canonicalPath", "parentCanonicalPath"] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || record[field] === "" || !record[field].startsWith("/")) {
      return null;
    }
  }
  const numberFields = [
    "parentDev",
    "parentIno",
    "parentUid",
    "parentMode",
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
  ] as const;
  for (const field of numberFields) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      return null;
    }
  }
  const parentMode = record.parentMode as number;
  const mode = record.mode as number;
  if (parentMode > 0o777 || mode > 0o777 || (parentMode & 0o077) !== 0 || (mode & 0o077) !== 0) {
    return null;
  }
  return {
    canonicalPath: record.canonicalPath as string,
    parentCanonicalPath: record.parentCanonicalPath as string,
    parentDev: record.parentDev as number,
    parentIno: record.parentIno as number,
    parentUid: record.parentUid as number,
    parentMode: record.parentMode as number,
    dev: record.dev as number,
    ino: record.ino as number,
    uid: record.uid as number,
    gid: record.gid as number,
    mode: record.mode as number,
  };
}

function targetBindingKey(input: NativeTargetBindingInput, evidence: NativeCommunicationSessionRef): string {
  return `target:${input.task.id}:${String(input.run.id)}:${input.role}:${nativeReferenceKey(evidence)}:${evidence.capabilityHash}`;
}

/**
 * Binding row は immutable snapshot のため、同じ native address の TTL 更新は
 * 期限切れ row と key が衝突しないよう revision suffix を付けて保存する。
 * 同じ exact snapshot がまだ有効なら再作成せず、その row を再利用する。
 */
function refreshedTargetBindingKey(
  store: NativeStoreCapability,
  input: NativeTargetBindingInput,
  evidence: NativeCommunicationSessionRef,
): string {
  const stableKey = targetBindingKey(input, evidence);
  const existing = store.listNativeSessionBindings(input.task.id).filter((binding) =>
    binding.kind === "target" && binding.bindingKey === stableKey,
  );
  if (existing.some((binding) =>
    binding.status === "active" && binding.expiresAt > input.now &&
    binding.provider === input.ref.provider && binding.providerSessionId === evidence.providerSessionId &&
    binding.hostId === evidence.hostId && binding.nativeAddress === nativeAddressFor(evidence) &&
    binding.runtimeVersion === evidence.runtimeVersion && binding.capabilityHash === evidence.capabilityHash &&
    binding.observedAt === evidence.observedAt && binding.expiresAt === evidence.expiresAt &&
    binding.taskId === input.task.id && binding.runId === input.run.id &&
    binding.hachiSessionId === input.run.sessionId && binding.targetRole === input.role &&
    binding.expectedCancelFence === input.expectedCancelFence
  )) {
    return stableKey;
  }
  if (existing.length === 0) {
    return stableKey;
  }
  const revisionPrefix = `${stableKey}:refresh:${evidence.observedAt}:${evidence.expiresAt}`;
  const existingKeys = new Set(store.listNativeSessionBindings(input.task.id).map((binding) => binding.bindingKey));
  let revision = revisionPrefix;
  let suffix = 1;
  while (existingKeys.has(revision)) {
    revision = `${revisionPrefix}:${suffix}`;
    suffix += 1;
  }
  return revision;
}

function exactAddressMatches(binding: NativeSessionBindingRow, evidence: NativeCommunicationSessionRef): boolean {
  return binding.nativeAddress !== "" && binding.nativeAddress === nativeAddressFor(evidence);
}

function refWithNativeEvidence(ref: SessionRef, evidence: NativeCommunicationSessionRef): SessionRef {
  return { ...ref, nativeCommunication: evidence };
}

interface ParsedSourceEvidence {
  present: boolean;
  evidence: NativeCommunicationSessionRef | null;
}

function sourceEvidenceFromPayload(payload: Record<string, unknown>): ParsedSourceEvidence {
  const communication = payload["communication"];
  if (typeof communication !== "object" || communication === null || Array.isArray(communication)) {
    return { present: false, evidence: null };
  }
  const communicationRecord = communication as Record<string, unknown>;
  if (!Object.hasOwn(communicationRecord, "source") && !Object.hasOwn(communicationRecord, "sourceEvidence")) {
    return { present: false, evidence: null };
  }
  const source = communicationRecord["source"] ?? communicationRecord["sourceEvidence"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return { present: true, evidence: null };
  }
  const record = source as Record<string, unknown>;
  const route = record.route;
  if (route !== "codex-app-server" && route !== "claude-cross-session") {
    return { present: true, evidence: null };
  }
  const base = {
    route,
    providerSessionId: record.providerSessionId,
    runtimeVersion: record.runtimeVersion,
    capabilityHash: record.capabilityHash,
    hostId: record.hostId,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
  };
  if (
    typeof base.providerSessionId !== "string" || base.providerSessionId === "" ||
    typeof base.runtimeVersion !== "string" || base.runtimeVersion === "" ||
    typeof base.capabilityHash !== "string" || base.capabilityHash === "" ||
    typeof base.hostId !== "string" || base.hostId === "" ||
    typeof base.observedAt !== "number" || !Number.isInteger(base.observedAt) ||
    typeof base.expiresAt !== "number" || !Number.isInteger(base.expiresAt)
  ) {
    return { present: true, evidence: null };
  }
  if (route === "codex-app-server") {
    if (typeof record.threadId !== "string" || record.threadId === "" ||
      typeof record.activeTurnId !== "string" || record.activeTurnId === "") {
      return { present: true, evidence: null };
    }
    const socketSnapshot = parseSocketSnapshot(record.socketSnapshot);
    if (socketSnapshot === null) {
      return { present: true, evidence: null };
    }
    return {
      present: true,
      evidence: {
        ...base,
        route,
        threadId: record.threadId,
        activeTurnId: record.activeTurnId,
        socketSnapshot,
      } as NativeCommunicationSessionRef,
    };
  }
  if (typeof record.agentRef !== "string" || record.agentRef === "") {
    return { present: true, evidence: null };
  }
  return {
    present: true,
    evidence: { ...base, route, agentRef: record.agentRef } as NativeCommunicationSessionRef,
  };
}

function sourceBindingIdFromPayload(payload: Record<string, unknown>): string | null {
  const communication = payload["communication"];
  if (typeof communication !== "object" || communication === null || Array.isArray(communication)) {
    return null;
  }
  const id = (communication as Record<string, unknown>)["sourceBindingId"];
  return typeof id === "string" && id !== "" ? id : null;
}

function findSourceBinding(
  store: NativeStoreCapability,
  task: TaskRow,
  provider: Provider,
  sessionId: string,
  payload: Record<string, unknown>,
  now: number,
): NativeSessionBindingRow | null {
  const requestedId = sourceBindingIdFromPayload(payload);
  const sourceEvidence = sourceEvidenceFromPayload(payload);
  const matchesEvidence = (binding: NativeSessionBindingRow): boolean =>
    !sourceEvidence.present || (sourceEvidence.evidence !== null && exactAddressMatches(binding, sourceEvidence.evidence));
  if (requestedId !== null) {
    const binding = store.getNativeSessionBinding(requestedId);
    if (
      binding !== null && binding.kind === "source" && binding.status === "active" && binding.taskId === task.id &&
      binding.provider === provider && binding.providerSessionId === sessionId && binding.expiresAt > now &&
      matchesEvidence(binding)
    ) {
      return binding;
    }
    return null;
  }
  const matches = store.listNativeSessionBindings(task.id).filter((binding) =>
    binding.kind === "source" && binding.status === "active" && binding.provider === provider &&
    binding.providerSessionId === sessionId && binding.expiresAt > now && matchesEvidence(binding),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function sourceProvenanceForBinding(binding: NativeSessionBindingRow): NativeSteerPreparation["sourceProvenance"] {
  if (
    binding.orchestratorId === "" || binding.orchestratorSessionId === "" || binding.orchestratorGeneration === null ||
    !Number.isInteger(binding.orchestratorGeneration) || binding.orchestratorGeneration <= 0
  ) {
    return null;
  }
  return {
    kind: "orchestrator",
    actorId: binding.orchestratorId,
    actorSessionId: binding.orchestratorSessionId,
    actorGeneration: binding.orchestratorGeneration,
  };
}

/** launch/run bind と同じ transaction 内で target binding を作るための同期 helper。 */
export function persistNativeTargetBinding(
  store: StageDeps["store"],
  input: NativeTargetBindingInput,
): NativeTargetBindingResult {
  const evidence = bindingEvidence(input.ref);
  if (evidence === null) {
    return { binding: null, reason: "native session evidence がありません" };
  }
  if (evidence.expiresAt <= input.now) {
    return { binding: null, reason: "native session evidence が期限切れです" };
  }
  const capability = nativeStore(store);
  if (capability === null) {
    return { binding: null, reason: "Core native communication store が未実装です" };
  }
  const binding = capability.createOrGetNativeTargetBinding(
    {
      bindingKey: refreshedTargetBindingKey(capability, input, evidence),
      provider: input.ref.provider,
      hostId: evidence.hostId,
      providerSessionId: evidence.providerSessionId,
      nativeAddress: nativeAddressFor(evidence),
      runtimeVersion: evidence.runtimeVersion,
      capabilityHash: evidence.capabilityHash,
      observedAt: evidence.observedAt,
      expiresAt: evidence.expiresAt,
      taskId: input.task.id,
      runId: input.run.id,
      hachiSessionId: input.run.sessionId,
      targetRole: input.role,
      expectedCancelFence: input.expectedCancelFence,
    },
    SUPERVISOR_ACTOR,
    SUPERVISOR_SERVICE_PROVENANCE,
  );
  return { binding };
}

function adapterFor(deps: StageDeps, provider: Provider, route: NativeCommunicationSessionRef["route"]): NativeCommunicationAdapter | null {
  const adapter = deps.nativeCommunicationAdapters?.[provider];
  if (adapter === undefined || adapter.route !== route) {
    return null;
  }
  return adapter;
}

function nativeStoreMethods(store: StageDeps["store"]): NativeStoreCapability {
  const capability = nativeStore(store);
  if (capability === null) {
    throw new Error("Core native communication store が未実装です");
  }
  return capability;
}

function targetBindingFor(
  store: NativeStoreCapability,
  task: TaskRow,
  run: RunRow,
  ref: SessionRef,
  now: number,
): NativeSessionBindingRow | null {
  const evidence = bindingEvidence(ref);
  if (evidence === null) {
    return null;
  }
  const key = targetBindingKey({ task, run, ref, role: runRole(run), expectedCancelFence: 0, now }, evidence);
  const matches = store.listNativeSessionBindings(task.id).filter((binding) =>
    binding.kind === "target" && binding.status === "active" &&
    (binding.bindingKey === key || binding.bindingKey.startsWith(`${key}:refresh:`)) &&
    binding.provider === ref.provider && binding.runId === run.id && binding.hachiSessionId === run.sessionId &&
    binding.providerSessionId === evidence.providerSessionId && binding.expectedCancelFence === 0 &&
    binding.hostId === evidence.hostId && binding.runtimeVersion === evidence.runtimeVersion &&
    binding.capabilityHash === evidence.capabilityHash &&
    binding.observedAt === evidence.observedAt && binding.expiresAt === evidence.expiresAt &&
    exactAddressMatches(binding, evidence) &&
    binding.expiresAt > now,
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((left, right) => {
    if (left.expiresAt !== right.expiresAt) {
      return right.expiresAt - left.expiresAt;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.id.localeCompare(left.id);
  })[0]!;
}

function runRole(run: RunRow): "worker" | "reviewer" {
  try {
    const parsed = JSON.parse(run.meta) as unknown;
    if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["role"] === "reviewer") {
      return "reviewer";
    }
  } catch {
    // legacy meta は worker 扱い。authority は run/session/fence で担保する。
  }
  return "worker";
}

async function probeTarget(
  deps: StageDeps,
  ref: SessionRef,
  now: number,
  route: NativeCommunicationSessionRef["route"],
): Promise<{ state: CommunicationCapabilityState; target: NativeCommunicationSessionRef | null; detail: string }> {
  const evidence = bindingEvidence(ref);
  if (evidence === null || evidence.route !== route) {
    return { state: "unknown", target: null, detail: "target native evidence がありません" };
  }
  const adapter = adapterFor(deps, ref.provider, route);
  if (adapter === null) {
    return { state: "unknown", target: null, detail: "native adapter が未構成です" };
  }
  let result: NativeCommunicationProbeResult;
  try {
    result = await adapter.probe(ref, now);
  } catch (error) {
    return { state: "unknown", target: null, detail: redactText(error instanceof Error ? error.message : String(error)) };
  }
  if (result.state !== "supported" || result.target === undefined) {
    return { state: result.state, target: null, detail: redactText(result.detail) };
  }
  const nativeAddressIsStable = result.target.route === "codex-app-server"
    ? evidence.route === "codex-app-server" && result.target.threadId === evidence.threadId
    : evidence.route === "claude-cross-session" && nativeAddressFor(result.target) === nativeAddressFor(evidence);
  if (
    result.target.route !== route || result.target.providerSessionId !== ref.sessionId ||
    result.target.providerSessionId !== evidence.providerSessionId || result.target.hostId !== evidence.hostId ||
    result.target.expiresAt <= now ||
    result.target.runtimeVersion !== evidence.runtimeVersion ||
    result.target.capabilityHash !== evidence.capabilityHash ||
    !nativeAddressIsStable
  ) {
    return { state: "unknown", target: null, detail: "adapter probe の target evidence が current session binding と一致しません" };
  }
  return { state: "supported", target: result.target, detail: result.detail };
}

function promoteNativeAttempt(
  store: NativeStoreCapability,
  input: NativeAttemptPromotionInput,
): CommunicationDeliveryAttemptRow {
  const candidate = store as NativeStoreWithPromotion;
  const fn = candidate.promoteCommunicationAttemptToNative;
  if (typeof fn !== "function") {
    throw new Error("neutral communication attempt の native promote API が未実装です");
  }
  return fn.call(candidate, input);
}

function rebindNativeAttempt(
  store: NativeStoreCapability,
  input: RebindRecordedNativeCommunicationAttemptInput,
): CommunicationDeliveryAttemptRow {
  const fn = store.rebindRecordedNativeCommunicationAttempt;
  if (typeof fn !== "function") {
    throw new Error("recorded native attempt の fresh target rebind API が未実装です");
  }
  return fn.call(store, input);
}

/** fresh config/task/run/fence/binding/probe を一度に評価し、最終 route を決定する。 */
export async function prepareNativeSteer(input: NativeSteerInput, payload: Record<string, unknown>): Promise<NativeSteerPreparation> {
  const configEntry = communicationConfig(input.config, input.ref.provider);
  const rollout = configEntry.rollout;
  const configHash = nativeConfigHash(input.config, input.ref.provider);
  const initialDecision = resolveCommunicationRoute({
    sourceProvider: input.sourceProvider === "" ? input.ref.provider : input.sourceProvider,
    targetProvider: input.ref.provider,
    rollout,
    preference: input.preference,
    sameHost: false,
    exactSourceBinding: false,
    exactTargetBinding: false,
    capability: "unknown",
    canaryEligible: nativeCanaryEligible(input.task.id, input.ref.provider, configEntry.canaryPercent),
  });
  const empty = {
    configHash,
    capabilityHash: "",
    sourceBinding: null,
    targetBinding: null,
    targetEvidence: null,
    attempt: null,
    sourceProvenance: null,
  } as const;

  const sourceProvider = input.sourceProvider === "" ? input.ref.provider : input.sourceProvider;
  const canaryEligible = nativeCanaryEligible(input.task.id, input.ref.provider, configEntry.canaryPercent);
  // 初期 resolve は exact binding/probe 前なので active same-provider の refusal を
  // 最終拒否と解釈しない。cross-provider と kill-switch/observe/hachi だけここで確定する。
  if (sourceProvider !== input.ref.provider || input.preference === "hachi" ||
    rollout === "off" || rollout === "observe" || rollout === "draining" ||
    (rollout === "canary" && !canaryEligible)) {
    const earlyDecision = sourceProvider !== input.ref.provider
      ? initialDecision
      : resolveCommunicationRoute({
          sourceProvider,
          targetProvider: input.ref.provider,
          rollout,
          preference: input.preference,
          sameHost: true,
          exactSourceBinding: true,
          exactTargetBinding: true,
          capability: "supported",
          canaryEligible,
        });
    if (earlyDecision.status === "refused") {
      return { kind: "refused", decision: earlyDecision, rollout, reason: earlyDecision.reason, ...empty };
    }
    return { kind: "hachi", decision: earlyDecision, rollout, reason: earlyDecision.reason, ...empty };
  }

  // native route は same-provider / canary selection / exact evidence が揃った場合だけ到達する。
  const capability = nativeStore(input.deps.store);
  if (capability === null) {
    const decision: CommunicationRouteDecision = {
      status: "refused",
      route: null,
      nativeCandidate: initialDecision.nativeCandidate,
      reason: "native-capability-unknown",
    };
    return {
      kind: "refused",
      decision,
      rollout,
      reason: "Core native communication store が未実装です",
      ...empty,
    };
  }
  if (sourceProvider !== input.ref.provider || input.sourceSessionId === "") {
    const decision = resolveCommunicationRoute({
      sourceProvider,
      targetProvider: input.ref.provider,
      rollout,
      preference: input.preference,
      sameHost: false,
      exactSourceBinding: false,
      exactTargetBinding: false,
      capability: "unknown",
    });
    return { kind: "refused", decision, rollout, reason: "source provider/session が native route に不足しています", ...empty };
  }

  // Source bindings are registered by the canonical CLI/control-plane path. A
  // payload-supplied source evidence is only an assertion against an existing
  // binding; Supervisor never creates authority from untrusted message data.
  const sourceBinding = findSourceBinding(capability, input.task, sourceProvider, input.sourceSessionId, payload, input.now);
  const targetProbe = await probeTarget(input.deps, input.ref, input.now, initialDecision.nativeCandidate!);
  const freshTargetRef = targetProbe.target === null ? input.ref : refWithNativeEvidence(input.ref, targetProbe.target);
  let targetBinding = targetBindingFor(capability, input.task, input.run, freshTargetRef, input.now);
  if (targetBinding === null && targetProbe.target !== null) {
    const persisted = persistNativeTargetBinding(capability as unknown as StageDeps["store"], {
      task: input.task,
      run: input.run,
      // probe が再接続/turn更新/TTL更新した fresh snapshot を durable binding に保存する。
      ref: freshTargetRef,
      role: runRole(input.run),
      expectedCancelFence: 0,
      now: input.now,
    });
    targetBinding = persisted.binding;
  }

  const sourceProvenance = sourceBinding === null ? null : sourceProvenanceForBinding(sourceBinding);
  const sameHost = sourceBinding !== null && targetBinding !== null && sourceBinding.hostId === targetBinding.hostId;
  const capabilityState = targetProbe.state;
  const decision = resolveCommunicationRoute({
    sourceProvider,
    targetProvider: input.ref.provider,
    rollout,
    preference: input.preference,
    sameHost,
    exactSourceBinding: sourceBinding !== null,
    exactTargetBinding: targetBinding !== null,
    capability: capabilityState,
    canaryEligible,
  });
  if (decision.status !== "deliver" || decision.route === "hachi") {
    return {
      kind: "refused",
      decision,
      rollout,
      reason: decision.status === "refused" ? decision.reason : "native route が選択されませんでした",
      configHash,
      capabilityHash: targetBinding === null ? "" : sha256Hex(JSON.stringify({
        source: sourceBinding === null ? "" : sourceBinding.capabilityHash,
        target: targetBinding.capabilityHash,
      })),
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: null,
      sourceProvenance,
    };
  }
  if (sourceBinding === null || targetBinding === null || sourceProvenance === null) {
    return {
      kind: "refused",
      decision: { ...decision, status: "refused", route: null, reason: "exact-source-binding-missing" },
      rollout,
      reason: "native binding/provenance が不足しています",
      configHash,
      capabilityHash: "",
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: null,
      sourceProvenance,
    };
  }
  if (!versionAtLeast(targetBinding.runtimeVersion, configEntry.minimumRuntimeVersion) ||
    !versionAtLeast(sourceBinding.runtimeVersion, configEntry.minimumRuntimeVersion)) {
    return {
      kind: "refused",
      decision: { ...decision, status: "refused", route: null, reason: "native-capability-unsupported" },
      rollout,
      reason: "minimumRuntimeVersion を満たしません",
      configHash,
      capabilityHash: "",
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: null,
      sourceProvenance,
    };
  }
  if (rollout !== "canary" && rollout !== "on" || configEntry.minimumRuntimeVersion === undefined || configEntry.sameHostOnly !== true) {
    return {
      kind: "refused",
      decision: { ...decision, status: "refused", route: null, reason: "native-capability-unsupported" },
      rollout,
      reason: "native config snapshot が不完全です",
      configHash,
      capabilityHash: "",
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: null,
      sourceProvenance,
    };
  }

  const capabilityHash = sha256Hex(JSON.stringify({ source: sourceBinding.capabilityHash, target: targetBinding.capabilityHash }));
  const sourceBindingHash = nativeSessionBindingHash(sourceBinding);
  const targetBindingHash = nativeSessionBindingHash(targetBinding);
  const configSnapshot = {
    rollout,
    minimumRuntimeVersion: configEntry.minimumRuntimeVersion,
    sameHostOnly: true as const,
    ...(configEntry.canaryPercent === undefined ? {} : { canaryPercent: configEntry.canaryPercent }),
  };
  const routing: NativeCommunicationRouting = {
    sourceProvider,
    targetProvider: input.ref.provider,
    rollout,
    preference: input.preference,
    sameHost,
    exactSourceBinding: true,
    exactTargetBinding: true,
    capability: "supported",
    canaryEligible,
  };
  const attemptInput = {
    attemptKey: `native:${input.deliveryId}`,
    steerDeliveryId: input.deliveryId,
    preference: input.preference,
    route: decision.route,
    payload: redactJsonStrings({ message: input.message }),
    sourceBindingId: sourceBinding.id,
    targetBindingId: targetBinding.id,
    configHash,
    configSnapshot,
    capabilityHash,
    sourceBindingHash,
    targetBindingHash,
    nativeCandidate: decision.nativeCandidate!,
    decisionReason: decision.reason,
    decision,
    routing,
    actor: SUPERVISOR_ACTOR,
    provenance: SUPERVISOR_SERVICE_PROVENANCE,
  };
  const lifecycleReady = typeof capability.promoteCommunicationAttemptToNative === "function" &&
    (decision.route === "claude-cross-session" || (
      typeof capability.claimNativeCommunicationAttempt === "function" &&
      typeof capability.beginNativeCommunicationDispatch === "function" &&
      typeof capability.recordNativeCommunicationReceipt === "function"
    ));
  const existingAttempt = input.communicationAttemptId === undefined || typeof capability.getCommunicationAttempt !== "function"
    ? null
    : capability.getCommunicationAttempt(input.communicationAttemptId);
  let existingNativeAttempt = existingAttempt;
  let existingNativeAttemptError: string | null = null;
  if (existingAttempt !== null && existingAttempt.route !== "hachi") {
    const compatibleNativeAttempt = existingAttempt.status === "recorded" &&
      existingAttempt.route === decision.route && existingAttempt.nativeCandidate === decision.route &&
      existingAttempt.sourceBindingId === sourceBinding.id && existingAttempt.configHash === configHash &&
      existingAttempt.capabilityHash === capabilityHash && existingAttempt.sourceBindingHash === sourceBindingHash;
    if (!compatibleNativeAttempt) {
      existingNativeAttemptError = "既存 native attempt の route/config/source snapshot が fresh probe と一致しません";
    } else if (existingAttempt.targetBindingId !== targetBinding.id || existingAttempt.targetBindingHash !== targetBindingHash) {
      try {
        existingNativeAttempt = rebindNativeAttempt(capability, {
          attemptId: existingAttempt.id,
          taskId: input.task.id,
          runId: input.run.id,
          sessionId: input.run.sessionId,
          expectedCancelFence: targetBinding.expectedCancelFence ?? 0,
          targetBindingId: targetBinding.id,
          targetBindingHash,
          now: input.now,
          actor: SUPERVISOR_ACTOR,
          provenance: SUPERVISOR_SERVICE_PROVENANCE,
        });
      } catch (error) {
        existingNativeAttemptError = redactText(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const reusableNativeAttempt = existingAttempt !== null && existingAttempt.route !== "hachi" &&
    existingNativeAttemptError === null && existingNativeAttempt !== null && existingNativeAttempt.status === "recorded" &&
    existingNativeAttempt.route === decision.route && existingNativeAttempt.nativeCandidate === decision.route &&
    existingNativeAttempt.sourceBindingId === sourceBinding.id && existingNativeAttempt.targetBindingId === targetBinding.id &&
    existingNativeAttempt.configHash === configHash && existingNativeAttempt.capabilityHash === capabilityHash &&
    existingNativeAttempt.sourceBindingHash === sourceBindingHash && existingNativeAttempt.targetBindingHash === targetBindingHash;
  if (existingAttempt !== null && existingAttempt.route !== "hachi" && !reusableNativeAttempt) {
    const refusedDecision: CommunicationRouteDecision = {
      status: "refused",
      route: null,
      nativeCandidate: decision.nativeCandidate,
      reason: "native-capability-unknown",
    };
    return {
      kind: "refused",
      decision: refusedDecision,
      rollout,
      configHash,
      capabilityHash,
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: existingNativeAttempt,
      sourceProvenance,
      reason: existingNativeAttemptError ?? "既存 native attempt の binding/config snapshot が fresh probe と一致しません",
    };
  }
  if (input.communicationAttemptId === undefined || !lifecycleReady) {
    const refusedDecision: CommunicationRouteDecision = {
      status: "refused",
      route: null,
      nativeCandidate: decision.nativeCandidate,
      reason: "native-capability-unknown",
    };
    return {
      kind: "refused",
      decision: refusedDecision,
      rollout,
      configHash,
      capabilityHash,
      sourceBinding,
      targetBinding,
      targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
      attempt: null,
      sourceProvenance,
      reason: input.communicationAttemptId === undefined
        ? "neutral communication attempt ID がありません（CLIのrecorded rowを必須とします）"
        : "Core native communication lifecycle API が未実装です",
    };
  }
  const attempt = reusableNativeAttempt
    ? existingNativeAttempt!
    : promoteNativeAttempt(capability, {
        ...attemptInput,
        attemptId: input.communicationAttemptId,
      });
  return {
    kind: decision.route === "claude-cross-session" ? "relay-wait" : "native",
    decision,
    rollout,
    configHash,
    capabilityHash,
    sourceBinding,
    targetBinding,
    targetEvidence: targetProbe.target ?? bindingEvidence(input.ref),
    attempt,
    sourceProvenance,
    reason: targetProbe.detail,
  };
}

function claimAttempt(capability: NativeStoreCapability, input: {
  attemptId: string;
  configHash: string;
  capabilityHash: string;
  config: CommunicationProviderConfig;
  canaryEligible: boolean;
  now: number;
}): CommunicationDeliveryAttemptRow {
  const fn = capability.claimNativeCommunicationAttempt;
  if (typeof fn !== "function") {
    throw new Error("Core native communication claim API が未実装です");
  }
  return fn.call(capability, {
    attemptId: input.attemptId,
    configHash: input.configHash,
    capabilityHash: input.capabilityHash,
    rollout: input.config.rollout,
    ...(input.config.minimumRuntimeVersion === undefined ? {} : { minimumRuntimeVersion: input.config.minimumRuntimeVersion }),
    ...(input.config.sameHostOnly === undefined ? {} : { sameHostOnly: input.config.sameHostOnly }),
    canaryEligible: input.canaryEligible,
    ...(input.config.canaryPercent === undefined ? {} : { canaryPercent: input.config.canaryPercent }),
    leaseSeconds: input.config.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS,
    now: input.now,
    actor: SUPERVISOR_ACTOR,
    provenance: SUPERVISOR_SERVICE_PROVENANCE,
  });
}

function beginAttempt(capability: NativeStoreCapability, attemptId: string, attemptNonce: string, now: number): CommunicationDeliveryAttemptRow {
  const fn = capability.beginNativeCommunicationDispatch;
  if (typeof fn !== "function") {
    throw new Error("Core native communication begin dispatch API が未実装です");
  }
  return fn.call(capability, {
    attemptId,
    attemptNonce,
    now,
    actor: SUPERVISOR_ACTOR,
    provenance: SUPERVISOR_SERVICE_PROVENANCE,
  });
}

function recordReceipt(
  capability: NativeStoreCapability,
  attemptId: string,
  attemptNonce: string,
  result: NativeDeliveryResult,
  now: number,
): CommunicationDeliveryAttemptRow {
  const fn = capability.recordNativeCommunicationReceipt;
  if (typeof fn !== "function") {
    throw new Error("Core native communication receipt API が未実装です");
  }
  return fn.call(capability, {
    attemptId,
    attemptNonce,
    outcome: result.status,
    ...(result.receiptId === "" ? {} : { receiptId: result.receiptId }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    now,
    actor: SUPERVISOR_ACTOR,
    provenance: SUPERVISOR_SERVICE_PROVENANCE,
  });
}

/** Codex native attempt の claim → begin → adapter I/O → receipt lifecycle。begin 後 fallback はしない。 */
export async function deliverNativeCodex(
  input: NativeSteerInput,
  prepared: NativeSteerPreparation,
  message: string,
): Promise<NativeDeliveryResult> {
  if (prepared.kind !== "native" || prepared.attempt === null || prepared.sourceBinding === null || prepared.targetBinding === null || prepared.sourceProvenance === null) {
    throw new Error("Codex native delivery の準備状態が不正です");
  }
  const capability = nativeStoreMethods(input.deps.store);
  const configEntry = communicationConfig(input.config, input.ref.provider);
  const claimed = claimAttempt(capability, {
    attemptId: prepared.attempt.id,
    configHash: prepared.configHash,
    capabilityHash: prepared.capabilityHash,
    config: configEntry,
    canaryEligible: nativeCanaryEligible(input.task.id, input.ref.provider, configEntry.canaryPercent),
    now: input.now,
  });
  if (claimed.attemptNonce === null || claimed.attemptNonce === "") {
    throw new Error("native claim nonce が返されませんでした");
  }
  const nonce = claimed.attemptNonce;
  // begin dispatch succeeds only immediately before external I/O. ここから先は例外も uncertain として終端化する。
  beginAttempt(capability, claimed.id, nonce, input.now);
  const adapter = adapterFor(input.deps, input.ref.provider, "codex-app-server");
  if (adapter === null) {
    const uncertain: NativeDeliveryResult = { status: "uncertain", receiptId: "", detail: "Codex native adapter が未構成です" };
    recordReceipt(capability, claimed.id, nonce, uncertain, input.now);
    return uncertain;
  }
  // prepare 時の probe が返した fresh target snapshot を唯一の native address とする。
  // run.meta は reconnect/turn rotation/TTL 更新後には stale なので再利用しない。
  const target = prepared.targetEvidence;
  if (
    target === null || target.expiresAt <= input.now ||
    prepared.targetBinding.providerSessionId !== target.providerSessionId ||
    prepared.targetBinding.hostId !== target.hostId ||
    prepared.targetBinding.runtimeVersion !== target.runtimeVersion ||
    prepared.targetBinding.capabilityHash !== target.capabilityHash ||
    !exactAddressMatches(prepared.targetBinding, target)
  ) {
    const uncertain: NativeDeliveryResult = { status: "uncertain", receiptId: "", detail: "target native evidence が再構築後に変化しました" };
    recordReceipt(capability, claimed.id, nonce, uncertain, input.now);
    return uncertain;
  }
  const request: NativeCommunicationDeliveryRequest = {
    attemptId: claimed.id,
    attemptNonce: nonce,
    deliveryId: input.deliveryId,
    messageKey: input.messageKey,
    taskId: input.task.id,
    runId: input.run.id,
    hachiSessionId: input.run.sessionId,
    expectedCancelFence: prepared.targetBinding.expectedCancelFence ?? 0,
    message: redactText(message),
    target,
  };
  let result: NativeDeliveryResult;
  try {
    const adapterResult = await adapter.deliver(request);
    if (!("outcome" in adapterResult)) {
      result = { status: "uncertain", receiptId: "", detail: "native adapter result が不正です" };
    } else {
      const receiptId = adapterResult.receiptId ?? "";
      const positiveOutcome = adapterResult.outcome === "transport_accepted" ||
        adapterResult.outcome === "session_observed" || adapterResult.outcome === "acknowledged";
      result = positiveOutcome && receiptId === ""
        ? { status: "uncertain", receiptId: "", detail: "native adapterの受理結果にreceiptがありません" }
        : {
            status: adapterResult.outcome,
            receiptId,
            ...(adapterResult.detail === undefined ? {} : { detail: adapterResult.detail }),
          };
    }
  } catch (error) {
    result = { status: "uncertain", receiptId: "", detail: redactText(error instanceof Error ? error.message : String(error)) };
  }
  recordReceipt(capability, claimed.id, nonce, result, input.now);
  return result;
}

function nativeEvidenceFromBinding(binding: NativeSessionBindingRow): NativeCommunicationSessionRef | null {
  if (binding.nativeAddress === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(binding.nativeAddress) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const address = parsed as Record<string, unknown>;
  const common = {
    providerSessionId: binding.providerSessionId,
    runtimeVersion: binding.runtimeVersion,
    capabilityHash: binding.capabilityHash,
    hostId: binding.hostId,
    observedAt: binding.observedAt,
    expiresAt: binding.expiresAt,
  };
  if (binding.provider === "codex" && address.route === "codex-app-server" &&
    typeof address.threadId === "string" && address.threadId !== "" &&
    typeof address.activeTurnId === "string" && address.activeTurnId !== "") {
    const socketSnapshot = parseSocketSnapshot(address.socketSnapshot);
    if (socketSnapshot === null) {
      return null;
    }
    return {
      route: "codex-app-server",
      ...common,
      threadId: address.threadId,
      activeTurnId: address.activeTurnId,
      socketSnapshot,
    };
  }
  if (binding.provider === "claude" && address.route === "claude-cross-session" &&
    typeof address.agentRef === "string" && address.agentRef !== "") {
    return { route: "claude-cross-session", ...common, agentRef: address.agentRef };
  }
  return null;
}

function sessionRefFromRunWithEvidence(run: RunRow, evidence: NativeCommunicationSessionRef): SessionRef {
  const { serverUrl, model, modelDelivery } = parseRunMeta(run.meta);
  return {
    provider: run.provider,
    sessionId: run.sessionId,
    serverUrl,
    model,
    modelDelivery,
    nativeCommunication: evidence,
    startedAt: run.startedAt,
  };
}

function messageFromNativeAttempt(attempt: CommunicationDeliveryAttemptRow): string | null {
  try {
    const parsed = JSON.parse(attempt.payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const message = (parsed as Record<string, unknown>).message;
    return typeof message === "string" && message !== "" ? message : null;
  } catch {
    return null;
  }
}

/**
 * messages stage が mark-first で処理済みにした後でも、queued delivery に紐づく
 * recorded native attempt を durable row から再配送する。外部 I/O は
 * deliverNativeCodex 内の begin 後だけで行い、Hachi fallback はしない。
 */
export async function redriveRecordedNativeAttempt(
  deps: StageDepsWithNativeReload,
  attempt: CommunicationDeliveryAttemptRow,
  now: number,
): Promise<NativeDeliveryResult | null> {
  if (
    attempt.status !== "recorded" || attempt.route !== "codex-app-server" ||
    attempt.sourceBindingId === null || attempt.targetBindingId === null
  ) {
    return null;
  }
  const capability = nativeStore(deps.store);
  if (capability === null) {
    return null;
  }
  const steerStore = deps.store as unknown as KanbanStoreWithSteer;
  const delivery = steerStore.getSteerDelivery(attempt.steerDeliveryId);
  if (delivery === null || delivery.status !== "queued") {
    return null;
  }
  const task = deps.store.getTask(delivery.taskId);
  const run = task === null ? null : deps.store.getLatestOpenRun(task.id);
  if (
    task === null || task.status !== "blocked" || !isInProgressReason(task.blockReason) ||
    run === null || run.id !== delivery.runId || run.sessionId !== delivery.sessionId ||
    run.provider !== "codex" || delivery.expectedCancelFence !== 0 ||
    (deps.store as unknown as { currentRunCancelFence?: (runId: number) => number }).currentRunCancelFence?.(run.id) !== 0
  ) {
    return null;
  }
  const sourceBinding = capability.getNativeSessionBinding(attempt.sourceBindingId);
  const targetBinding = capability.getNativeSessionBinding(attempt.targetBindingId);
  const targetEvidence = targetBinding === null ? null : nativeEvidenceFromBinding(targetBinding);
  const message = messageFromNativeAttempt(attempt);
  if (
    sourceBinding === null || sourceBinding.kind !== "source" || sourceBinding.provider !== "codex" ||
    targetBinding === null || targetBinding.kind !== "target" || targetEvidence === null || message === null
  ) {
    return null;
  }

  const config = deps.reloadConfig === undefined ? deps.config : deps.reloadConfig();
  const ref = sessionRefFromRunWithEvidence(run, targetEvidence);
  const steerInput: NativeSteerInput = {
    deps,
    config,
    task,
    run,
    ref,
    deliveryId: delivery.id,
    messageKey: delivery.messageKey,
    message,
    sourceProvider: sourceBinding.provider,
    sourceSessionId: sourceBinding.providerSessionId,
    preference: attempt.preference,
    now,
    communicationAttemptId: attempt.id,
  };
  const prepared = await prepareNativeSteer(steerInput, {
    communication: { sourceBindingId: sourceBinding.id },
  });
  if (
    prepared.kind !== "native" || prepared.attempt === null || prepared.attempt.id !== attempt.id ||
    prepared.targetBinding === null || prepared.attempt.targetBindingId !== prepared.targetBinding.id
  ) {
    return null;
  }
  return deliverNativeCodex(steerInput, prepared, message);
}

interface KanbanStoreWithSteer {
  getSteerDelivery(id: string): SteerDeliveryRow | null;
}
