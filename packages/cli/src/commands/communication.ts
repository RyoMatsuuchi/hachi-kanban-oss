// =============================================================================
// hachi communication: v0.18 native delivery control-plane read/claim commands.
//
// CLI は native provider の最終 route を選ばない。task steer が同一 transaction
// へ記録した intent を、trusted config と Core の exact binding/authority gate
// に渡すだけにする。Claude relay の外部 built-in は、この CLI から直接呼ばない。
// =============================================================================

import { Command, InvalidArgumentError, Option } from "commander";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256,
  probeDirectRuntimeCapabilities,
} from "@hachi/adapters";
import {
  isStrictSemver,
  redactMaybeJsonText,
  redactText,
  resolveCommunicationProviderConfig,
  type ActorProvenance,
  type CommunicationDeliveryAttemptRow,
  type CommunicationRolloutState,
  type DurableSteerStore,
  type NativeCommunicationStore,
  type NativeSessionBindingKind,
  type NativeSessionBindingRow,
  type Provider,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit } from "../output.js";
import {
  addActorPrincipalOptions,
  resolveActorProvenance,
  type ActorPrincipalOptions,
} from "../actor-provenance.js";

const RELAY_OUTCOMES = [
  "transport_accepted",
  "session_observed",
  "acknowledged",
  "rejected",
  "uncertain",
] as const;

type RelayOutcome = (typeof RELAY_OUTCOMES)[number];

interface JsonOptions {
  json?: boolean;
}

interface RelayListOptions extends JsonOptions {
  task?: string;
  delivery?: string;
  route?: "claude-cross-session" | "codex-app-server";
}

interface BindingListOptions extends JsonOptions {
  task?: string;
  provider?: Provider;
  kind?: NativeSessionBindingKind;
}

interface BindingRegisterSourceOptions extends ActorPrincipalOptions, JsonOptions {
  task: string;
}

interface RelayClaimOptions extends ActorPrincipalOptions, JsonOptions {
  attempt: string;
  /** Optional assertions are checked against trusted config; they never select a route. */
  configHash?: string;
  capabilityHash?: string;
  rollout?: CommunicationRolloutState;
  minimumRuntimeVersion?: string;
  leaseSeconds?: number;
}

interface RelayBeginOptions extends ActorPrincipalOptions, JsonOptions {
  attempt: string;
  attemptNonce?: string;
  nonce?: string;
}

interface RelayReceiptOptions extends ActorPrincipalOptions, JsonOptions {
  attempt: string;
  attemptNonce?: string;
  nonce?: string;
  outcome: RelayOutcome;
  receiptId?: string;
  observedMessageId?: string;
  detail?: string;
}

interface DurableCommunicationStore extends NativeCommunicationStore, DurableSteerStore {}

function communicationStore(deps: CliDeps): DurableCommunicationStore {
  return deps.store as CliDeps["store"] & DurableCommunicationStore;
}

function parsePositiveInt(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`正の整数が必要です: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`安全な正の整数が必要です: ${value}`);
  }
  return parsed;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function communicationCapabilityHash(provider: Provider, runtimeVersion: string): string {
  // Codex App Server exposes the generated schema checksum as its capability
  // evidence. Keep the stored binding hash in Core's canonical 64-hex form;
  // the adapter's wire value may carry a `sha256:` display prefix.
  if (provider === "codex") {
    return CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256;
  }
  const route = provider === "claude" ? "claude-cross-session" : "codex-app-server";
  const capabilities = provider === "claude"
    ? ["background-session", "agents-json", "crossSessionInbound:accept"]
    : ["app-server:initialize", "app-server:thread/start", "app-server:thread/read", "app-server:turn/steer"];
  return createHash("sha256").update(stableStringify({
    schemaVersion: "communication-capability.v1",
    provider,
    route,
    runtimeVersion,
    capabilities,
  }), "utf8").digest("hex");
}

function observedEpochSeconds(observedAt: number): number {
  const now = Math.floor(Date.now() / 1000);
  const candidate = observedAt > 100_000_000_000 ? Math.floor(observedAt / 1000) : Math.floor(observedAt);
  return Math.max(1, Math.min(now, Number.isFinite(candidate) ? candidate : now));
}

function compareRuntimeVersion(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(value);
    if (match === null) throw new Error(`runtime versionがstrict semverではありません: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
  };
  const a = parse(left);
  const b = parse(right);
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  return a[3] === "" ? 1 : b[3] === "" ? -1 : a[3] > b[3] ? 1 : -1;
}

async function probeCommunicationRuntime(
  deps: CliDeps,
  provider: Provider,
): Promise<{ runtimeVersion: string; observedAt: number; capabilityHash: string }> {
  const result = deps.modelTransportProbe !== undefined
    ? await deps.modelTransportProbe(provider, "direct")
    : await probeDirectRuntimeCapabilities({ provider });
  if (!result.ok) {
    const detail = "detail" in result ? result.detail : result.failure.detail;
    throw new Error(`provider runtime version probeに失敗しました (${provider}): ${detail}`);
  }
  const runtimeVersion = result.snapshot.runtime.version;
  if (runtimeVersion === null || !isStrictSemver(runtimeVersion)) {
    throw new Error(`provider runtime versionがstrict semverではありません (${provider})`);
  }
  const observedAt = observedEpochSeconds(result.snapshot.observedAt);
  return {
    runtimeVersion,
    observedAt,
    capabilityHash: communicationCapabilityHash(provider, runtimeVersion),
  };
}

async function runBindingRegisterSource(
  deps: CliDeps,
  options: BindingRegisterSourceOptions,
): Promise<void> {
  const provenance = requireOrchestratorProvenance(options);
  const task = deps.store.getTask(options.task);
  if (task === null) {
    throw new Error(`タスクが見つかりません: ${options.task}`);
  }
  const session = deps.store.getOrchestratorSession(provenance.actorSessionId);
  if (
    session === null ||
    session.orchestratorId !== provenance.actorId ||
    session.generation !== provenance.actorGeneration ||
    session.status !== "active"
  ) {
    throw new Error("source bindingにはactive exact orchestrator sessionが必須です");
  }
  if (session.provider === "" || session.providerSessionId.trim() === "") {
    throw new Error("source bindingにはproviderとproviderSessionIdを持つorchestrator sessionが必須です");
  }

  // Provider, provider session, and host are all derived from trusted local
  // state. There are deliberately no corresponding CLI options to spoof them.
  const provider = session.provider;
  const policy = resolveCommunicationProviderConfig(deps.config, provider);
  const evidence = await probeCommunicationRuntime(deps, provider);
  if (
    policy.minimumRuntimeVersion !== undefined &&
    (policy.rollout === "canary" || policy.rollout === "on") &&
    compareRuntimeVersion(evidence.runtimeVersion, policy.minimumRuntimeVersion) < 0
  ) {
    throw new Error(
      `provider runtime versionがminimum未満です (${provider}): ${evidence.runtimeVersion} < ${policy.minimumRuntimeVersion}`,
    );
  }
  // Test/remote probes may report a stale wall-clock watermark. Core requires
  // a binding that is live at insertion time, so the local observation boundary
  // is the current bounded probe completion time rather than an old timestamp.
  const observedAt = Math.max(evidence.observedAt, Math.floor(Date.now() / 1000));
  const hostId = hostname();
  if (!nonEmptyString(hostId)) {
    throw new Error("source bindingのlocal host identityを取得できません");
  }
  // Observation/TTL timestamps are evidence fields, not identity. Keep one
  // durable source row for the same exact provider session/capability snapshot
  // instead of creating another active binding when a later invocation crosses
  // a second boundary.
  const bindingKey = `source:${task.id}:${provider}:${session.providerSessionId}:${evidence.capabilityHash}`;
  const binding = communicationStore(deps).createOrGetNativeSourceBinding({
    bindingKey,
    provider,
    hostId,
    providerSessionId: session.providerSessionId,
    runtimeVersion: evidence.runtimeVersion,
    capabilityHash: evidence.capabilityHash,
    observedAt,
    expiresAt: observedAt + policy.bindingTtlSeconds,
    taskId: task.id,
    provenance,
  });
  emit(deps, options.json === true, { binding: safeBinding(binding) }, [
    `native source bindingを登録しました: ${binding.id} provider=${binding.provider} host=${binding.hostId}`,
    `runtime=${binding.runtimeVersion} expiresAt=${binding.expiresAt}`,
  ]);
}

function requireOrchestratorProvenance(options: ActorPrincipalOptions): ActorProvenance {
  const provenance = resolveActorProvenance(options, "orchestrator");
  if (provenance?.kind !== "orchestrator") {
    throw new Error(
      "communication relay の mutation は --actor-kind orchestrator と --orchestrator/--session/--generation が必須です",
    );
  }
  return provenance;
}

/** Read-only list boundary: payload/nonce/secret-like error text are never exposed. */
function safeAttempt(row: CommunicationDeliveryAttemptRow, includeClaimNonce = false): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    id: row.id,
    attemptKey: row.attemptKey,
    steerDeliveryId: row.steerDeliveryId,
    sourceBindingId: row.sourceBindingId,
    targetBindingId: row.targetBindingId,
    preference: row.preference,
    route: row.route,
    nativeCandidate: row.nativeCandidate,
    decisionReason: row.decisionReason,
    status: row.status,
    configHash: row.configHash,
    configRollout: row.configRollout,
    configMinimumRuntimeVersion: row.configMinimumRuntimeVersion,
    configSameHostOnly: row.configSameHostOnly,
    configCanaryPercent: row.configCanaryPercent,
    capabilityHash: row.capabilityHash,
    sourceBindingHash: row.sourceBindingHash,
    targetBindingHash: row.targetBindingHash,
    claimantOrchestratorId: row.claimantOrchestratorId,
    claimantSessionId: row.claimantSessionId,
    claimantGeneration: row.claimantGeneration,
    claimLeaseUntil: row.claimLeaseUntil,
    dispatchingAt: row.dispatchingAt,
    receiptId: row.receiptId,
    lastError: redactText(row.lastError),
    provenance: row.provenance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    observedAt: row.observedAt,
    acknowledgedAt: row.acknowledgedAt,
    resolvedAt: row.resolvedAt,
  };
  // Core returns the nonce only as the immediate claim result. Never include it in
  // list/read/refetch paths; this is the one-time plaintext output boundary.
  if (includeClaimNonce && row.attemptNonce !== null && row.attemptNonce !== undefined) {
    safe.attemptNonce = row.attemptNonce;
  }
  return safe;
}

function safeBinding(row: NativeSessionBindingRow): Record<string, unknown> {
  const nativeAddress = readNativeAddress(row);
  return {
    id: row.id,
    bindingKey: row.bindingKey,
    kind: row.kind,
    provider: row.provider,
    hostId: row.hostId,
    // providerSessionId is retained as non-authoritative evidence for diagnosis.
    // It is never used as the Claude relay target; nativeAddress.agentRef is the
    // only exact target reference exposed to the handoff instructions.
    providerSessionId: row.providerSessionId,
    nativeAddress,
    ...(nativeAddress?.route === "claude-cross-session" ? { agentRef: nativeAddress.agentRef } : {}),
    runtimeVersion: row.runtimeVersion,
    capabilityHash: row.capabilityHash,
    observedAt: row.observedAt,
    expiresAt: row.expiresAt,
    taskId: row.taskId,
    runId: row.runId,
    hachiSessionId: row.hachiSessionId,
    targetRole: row.targetRole,
    expectedCancelFence: row.expectedCancelFence,
    orchestratorId: row.orchestratorId,
    orchestratorSessionId: row.orchestratorSessionId,
    orchestratorGeneration: row.orchestratorGeneration,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    releasedAt: row.releasedAt,
  };
}

type SafeNativeAddress =
  | { route: "codex-app-server"; threadId: string; activeTurnId: string }
  | { route: "claude-cross-session"; agentRef: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * nativeAddress is persisted as a JSON string by Core.  Keep this parser
 * allow-listed: read models must never echo an opaque address that could hide
 * a token or a display-name fallback.  The cast also tolerates the additive
 * Core v20 object form while old v19 rows remain null.
 */
function readNativeAddress(row: NativeSessionBindingRow): SafeNativeAddress | null {
  const raw = (row as NativeSessionBindingRow & { nativeAddress?: unknown }).nativeAddress;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.route === "claude-cross-session" && nonEmptyString(record.agentRef)) {
    return { route: "claude-cross-session", agentRef: record.agentRef };
  }
  if (
    record.route === "codex-app-server" &&
    nonEmptyString(record.threadId) &&
    nonEmptyString(record.activeTurnId)
  ) {
    return {
      route: "codex-app-server",
      threadId: record.threadId,
      activeTurnId: record.activeTurnId,
    };
  }
  return null;
}

function listAttemptRows(deps: CliDeps, options: RelayListOptions): CommunicationDeliveryAttemptRow[] {
  let rows = communicationStore(deps).listCommunicationAttempts(options.delivery);
  if (options.task !== undefined) {
    const durable = communicationStore(deps);
    const taskDeliveryIds = new Set(durable.listSteerDeliveries(options.task).map((delivery) => delivery.id));
    rows = rows.filter((row) => taskDeliveryIds.has(row.steerDeliveryId));
  }
  if (options.route !== undefined) {
    rows = rows.filter((row) => row.route === options.route || row.nativeCandidate === options.route);
  }
  return rows;
}

function runRelayList(deps: CliDeps, options: RelayListOptions): void {
  const rows = listAttemptRows(deps, options);
  const attempts = rows.map((row) => safeAttempt(row));
  emit(deps, options.json === true, { attempts }, attempts.length === 0
    ? ["communication relay attempt はありません"]
    : attempts.map((attempt) => `${String(attempt.id)} status=${String(attempt.status)} route=${String(attempt.route || "-")}`));
}

function runBindingList(deps: CliDeps, options: BindingListOptions): void {
  let rows = communicationStore(deps).listNativeSessionBindings(options.task);
  if (options.provider !== undefined) {
    rows = rows.filter((row) => row.provider === options.provider);
  }
  if (options.kind !== undefined) {
    rows = rows.filter((row) => row.kind === options.kind);
  }
  const bindings = rows.map(safeBinding);
  emit(deps, options.json === true, { bindings }, bindings.length === 0
    ? ["communication binding はありません"]
    : bindings.map((binding) => `${String(binding.id)} ${String(binding.kind)} ${String(binding.provider)} status=${String(binding.status)}`));
}

function requireAttempt(deps: CliDeps, id: string): CommunicationDeliveryAttemptRow {
  const row = communicationStore(deps).getCommunicationAttempt(id);
  if (row === null) {
    throw new Error(`communication attempt が見つかりません: ${id}`);
  }
  return row;
}

function targetProviderForAttempt(deps: CliDeps, attempt: CommunicationDeliveryAttemptRow): Provider {
  const store = communicationStore(deps);
  if (attempt.targetBindingId !== null) {
    const binding = store.getNativeSessionBinding(attempt.targetBindingId);
    if (binding !== null) {
      return binding.provider;
    }
  }
  const delivery = store.getSteerDelivery(attempt.steerDeliveryId);
  if (delivery === null) {
    throw new Error("communication attempt のsteer deliveryが見つかりません");
  }
  const run = deps.store.getOpenRunByTaskSession(delivery.taskId, delivery.sessionId);
  if (run === null) {
    throw new Error("communication attempt のcurrent open runが見つかりません");
  }
  return run.provider;
}

function assertOptionalMatches(label: string, supplied: string | number | undefined, trusted: string | number | undefined): void {
  if (supplied !== undefined && supplied !== trusted) {
    throw new Error(`${label} はtrusted configと一致しません`);
  }
}

function claimInstructions(
  attempt: CommunicationDeliveryAttemptRow,
  binding: NativeSessionBindingRow | null,
  provenance: ActorProvenance,
): Record<string, unknown> {
  if (binding === null) {
    throw new Error("Claude relay claimにはactive target bindingが必須です");
  }
  const nativeAddress = readNativeAddress(binding);
  if (nativeAddress?.route !== "claude-cross-session" || !nonEmptyString(nativeAddress.agentRef)) {
    throw new Error("Claude relay claimにはpersisted exact agentRefが必須です（providerSessionId/nameは代用不可）");
  }
  const receiptNonce = attempt.attemptNonce ?? "<attemptNonce>";
  const receiptCommand = [
    "hachi", "communication", "relay", "receipt", "--json",
    "--attempt", attempt.id,
    "--attempt-nonce", receiptNonce,
    "--outcome", "<outcome>",
    "--actor-kind", "orchestrator",
    "--orchestrator", provenance.actorId,
    "--session", provenance.actorSessionId,
    "--generation", String(provenance.actorGeneration),
  ];
  return {
    provider: "claude",
    route: "claude-cross-session",
    target: {
      bindingId: attempt.targetBindingId,
      nativeAddress,
      agentRef: nativeAddress.agentRef,
      exactAgentRef: nativeAddress.agentRef,
      refMustBeFresh: true,
    },
    discovery: {
      tool: "ListAgents",
      recheckImmediatelyBeforeSend: true,
      exactRefField: "agentRef",
      expectedAgentRef: nativeAddress.agentRef,
      nameIsNotAuthority: true,
    },
    send: {
      tool: "SendMessage",
      once: true,
      maxCalls: 1,
      payloadField: "payload",
      targetRefField: "agentRef",
      targetAgentRef: nativeAddress.agentRef,
    },
    receipt: {
      command: receiptCommand,
      outcomes: [...RELAY_OUTCOMES],
      exactAttemptNonceRequired: true,
    },
  };
}

function runRelayClaim(deps: CliDeps, options: RelayClaimOptions): void {
  const provenance = requireOrchestratorProvenance(options);
  const before = requireAttempt(deps, options.attempt);
  // A recorded intent may keep route=hachi while carrying a nativeCandidate.
  // Claim must inspect the candidate first; selecting route=hachi here would
  // make the CLI accidentally claim the wrong control-plane path.
  const candidate = before.nativeCandidate || before.route;
  if (candidate !== "claude-cross-session") {
    throw new Error("Codex automatic routeはCLIからclaimしません（Claude cross-session relayだけを対象にします）");
  }
  const provider = targetProviderForAttempt(deps, before);
  if (provider !== "claude") {
    throw new Error(`relay claim対象providerがClaudeではありません: ${provider}`);
  }
  const policy = resolveCommunicationProviderConfig(deps.config, provider);
  assertOptionalMatches("rollout", options.rollout, policy.rollout);
  assertOptionalMatches("minimumRuntimeVersion", options.minimumRuntimeVersion, policy.minimumRuntimeVersion);
  assertOptionalMatches("leaseSeconds", options.leaseSeconds, policy.claimLeaseSeconds);
  const delivery = communicationStore(deps).getSteerDelivery(before.steerDeliveryId);
  if (delivery === null) {
    throw new Error("communication attempt のsteer deliveryが見つかりません");
  }
  const targetBinding = before.targetBindingId === null
    ? null
    : communicationStore(deps).getNativeSessionBinding(before.targetBindingId);
  // Validate the exact address before mutating the claim CAS. A missing or
  // legacy v19 address must not consume the one-time nonce/lease.
  if (targetBinding === null) {
    throw new Error("Claude relay claimにはactive target bindingが必須です");
  }
  const targetAddress = readNativeAddress(targetBinding);
  if (targetAddress?.route !== "claude-cross-session" || !nonEmptyString(targetAddress.agentRef)) {
    throw new Error("Claude relay claimにはpersisted exact agentRefが必須です（providerSessionId/nameは代用不可）");
  }
  const claimed = communicationStore(deps).claimNativeCommunicationAttempt({
    attemptId: before.id,
    configHash: options.configHash ?? before.configHash,
    capabilityHash: options.capabilityHash ?? before.capabilityHash,
    rollout: policy.rollout,
    ...(policy.minimumRuntimeVersion === undefined ? {} : { minimumRuntimeVersion: policy.minimumRuntimeVersion }),
    ...(policy.sameHostOnly === undefined ? {} : { sameHostOnly: policy.sameHostOnly }),
    ...(policy.canaryPercent === undefined ? {} : { canaryPercent: policy.canaryPercent }),
    leaseSeconds: policy.claimLeaseSeconds,
    actor: "orchestrator",
    provenance,
  });
  if (claimed.attemptNonce === null || claimed.attemptNonce === undefined || claimed.attemptNonce === "") {
    throw new Error("communication claim responseにone-time nonceがありません");
  }
  const binding = claimed.targetBindingId === null ? null : communicationStore(deps).getNativeSessionBinding(claimed.targetBindingId);
  const payload = {
    attempt: {
      ...safeAttempt(claimed, true),
      // Claim is the sole payload output boundary. Core already redacts before
      // persistence; redact once more here so adapter/tool handoff cannot leak it.
      payload: redactMaybeJsonText(claimed.payload),
      messageKey: delivery.messageKey,
      delivery: {
        id: delivery.id,
        taskId: delivery.taskId,
        runId: delivery.runId,
        sessionId: delivery.sessionId,
        cancelFence: delivery.expectedCancelFence,
      },
    },
    instructions: claimInstructions(claimed, binding, provenance),
  };
  emit(deps, options.json === true, payload, [
    `communication relay claim: attempt=${claimed.id} status=${claimed.status}`,
    "ListAgentsでexact refを再確認し、SendMessageを1回だけ実行してからreceiptを返してください",
  ]);
}

function requireAttemptNonce(options: RelayBeginOptions | RelayReceiptOptions): string {
  const nonce = options.attemptNonce ?? options.nonce;
  if (nonce === undefined || nonce.trim() === "") {
    throw new Error("--attempt-nonce（または --nonce）が必須です");
  }
  return nonce;
}

function runRelayBegin(deps: CliDeps, options: RelayBeginOptions): void {
  const provenance = requireOrchestratorProvenance(options);
  const attemptNonce = requireAttemptNonce(options);
  const store = communicationStore(deps);
  const row = store.beginNativeCommunicationDispatch({
    attemptId: options.attempt,
    attemptNonce,
    actor: "orchestrator",
    provenance,
  });
  emit(deps, options.json === true, { attempt: safeAttempt(row) }, [
    `communication relay begin: attempt=${row.id} status=${row.status}`,
  ]);
}

function runRelayReceipt(deps: CliDeps, options: RelayReceiptOptions): void {
  const provenance = requireOrchestratorProvenance(options);
  const attemptNonce = requireAttemptNonce(options);
  const store = communicationStore(deps);
  const row = store.recordNativeCommunicationReceipt({
    attemptId: options.attempt,
    attemptNonce,
    outcome: options.outcome,
    ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }),
    ...(options.observedMessageId === undefined ? {} : { observedMessageId: options.observedMessageId }),
    ...(options.detail === undefined ? {} : { detail: redactText(options.detail) }),
    actor: "orchestrator",
    provenance,
  });
  emit(deps, options.json === true, { attempt: safeAttempt(row) }, [
    `communication relay receipt: attempt=${row.id} outcome=${options.outcome} status=${row.status}`,
  ]);
}

/** hachi communication command tree */
export function registerCommunicationCommand(program: Command, deps: CliDeps): void {
  const communication = program.command("communication").description("provider native communication control plane");
  const relay = communication.command("relay").description("Claude cross-session relay queue");

  relay
    .command("list")
    .description("relay attemptをpayload/nonceなしで読み取る")
    .option("--task <id>", "task IDで絞り込む")
    .option("--delivery <id>", "steer delivery IDで絞り込む")
    .addOption(new Option("--route <route>", "native routeで絞り込む").choices(["claude-cross-session", "codex-app-server"]))
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: RelayListOptions): void => runRelayList(deps, options)));

  const claim = relay
    .command("claim")
    .description("Claude relay attemptをexact actor provenanceでclaimする")
    .requiredOption("--attempt <id>", "communication attempt ID")
    .option("--config-hash <sha256>", "stored config hashとの一致をassertする")
    .option("--capability-hash <sha256>", "stored capability hashとの一致をassertする")
    .addOption(new Option("--rollout <state>", "trusted configとの一致をassertする").choices(["off", "observe", "canary", "on", "draining"]))
    .option("--minimum-runtime-version <semver>", "trusted configとの一致をassertする")
    .option("--lease-seconds <seconds>", "trusted configとの一致をassertする", parsePositiveInt);
  addActorPrincipalOptions(claim)
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: RelayClaimOptions): void => runRelayClaim(deps, options)));

  const begin = relay
    .command("begin")
    .description("claim済みrelayをdispatchingへ進める")
    .requiredOption("--attempt <id>", "communication attempt ID")
    .option("--attempt-nonce <nonce>", "claim responseのone-time nonce")
    .option("--nonce <nonce>", "--attempt-nonceの別名");
  addActorPrincipalOptions(begin)
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: RelayBeginOptions): void => runRelayBegin(deps, options)));

  const receipt = relay
    .command("receipt")
    .description("native relayのtransport/session/ack receiptを記録する")
    .requiredOption("--attempt <id>", "communication attempt ID")
    .option("--attempt-nonce <nonce>", "claim responseのone-time nonce")
    .option("--nonce <nonce>", "--attempt-nonceの別名")
    .addOption(new Option("--outcome <outcome>", "receipt outcome").choices(RELAY_OUTCOMES).makeOptionMandatory())
    .option("--receipt-id <id>", "provider receipt ID")
    .option("--observed-message-id <id>", "receiver exact message key")
    .option("--detail <text>", "redacted diagnostic detail");
  addActorPrincipalOptions(receipt)
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: RelayReceiptOptions): void => runRelayReceipt(deps, options)));

  const binding = communication.command("binding").description("native session binding read model");
  binding
    .command("list")
    .description("native bindingをsecret/payloadなしで読み取る")
    .option("--task <id>", "task IDで絞り込む")
    .addOption(new Option("--provider <provider>", "providerで絞り込む").choices(["codex", "claude"]))
    .addOption(new Option("--kind <kind>", "binding kindで絞り込む").choices(["source", "target"]))
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: BindingListOptions): void => runBindingList(deps, options)));

  const registerSource = binding
    .command("register-source")
    .description("active exact orchestrator sessionからnative source bindingを登録する")
    .requiredOption("--task <id>", "task ID");
  addActorPrincipalOptions(registerSource)
    .option("--json", "JSON形式で出力する")
    .action(withErrorHandling(deps, (options: BindingRegisterSourceOptions): Promise<void> =>
      runBindingRegisterSource(deps, options)));
}
