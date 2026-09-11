// task_runs（正本）から SessionRef を再構築するヘルパー。block_reason は人間/G2 monitor 向けの
// 表示専用フィールドであり、機械的な情報源にしない（title 注入で汚染されうるため。docs/contract.md §12.5-1）。
// monitor / finalize / messages(steer) ステージが共用する。
import type {
  EventRow,
  KanbanStore,
  ModelDelivery,
  NativeCommunicationSessionRef,
  NativeCommunicationSocketSnapshot,
  Provider,
  SessionRef,
  StageDeps,
  Transport,
  WorkerAdapter,
} from "@hachi/core";

/** run.meta（JSON文字列）から取り出す SessionRef 由来フィールド */
export interface RunMeta {
  serverUrl: string;
  model: string;
  modelDelivery: ModelDelivery;
  nativeCommunication?: NativeCommunicationSessionRef;
}

function parseSocketSnapshot(value: unknown): NativeCommunicationSocketSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stringFields = ["canonicalPath", "parentCanonicalPath"] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || record[field] === "" || !record[field].startsWith("/")) {
      return undefined;
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
      return undefined;
    }
  }
  const parentMode = record.parentMode as number;
  const mode = record.mode as number;
  if (parentMode > 0o777 || mode > 0o777 || (parentMode & 0o077) !== 0 || (mode & 0o077) !== 0) {
    return undefined;
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

function parseNativeCommunication(value: unknown): NativeCommunicationSessionRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const route = record.route;
  const providerSessionId = record.providerSessionId;
  const runtimeVersion = record.runtimeVersion;
  const capabilityHash = record.capabilityHash;
  const hostId = record.hostId;
  const observedAt = record.observedAt;
  const expiresAt = record.expiresAt;
  if (
    (route !== "codex-app-server" && route !== "claude-cross-session") ||
    typeof providerSessionId !== "string" || providerSessionId === "" ||
    typeof runtimeVersion !== "string" || runtimeVersion === "" ||
    typeof capabilityHash !== "string" || capabilityHash === "" ||
    typeof hostId !== "string" || hostId === "" ||
    typeof observedAt !== "number" || !Number.isInteger(observedAt) || observedAt <= 0 ||
    typeof expiresAt !== "number" || !Number.isInteger(expiresAt) || expiresAt <= observedAt
  ) {
    return undefined;
  }
  if (route === "codex-app-server") {
    const threadId = record.threadId;
    const activeTurnId = record.activeTurnId;
    const socketSnapshot = parseSocketSnapshot(record.socketSnapshot);
    if (
      typeof threadId !== "string" || threadId === "" ||
      typeof activeTurnId !== "string" || activeTurnId === "" ||
      socketSnapshot === undefined
    ) {
      return undefined;
    }
    return {
      route,
      providerSessionId,
      runtimeVersion,
      capabilityHash,
      hostId,
      observedAt,
      expiresAt,
      threadId,
      activeTurnId,
      socketSnapshot,
    };
  }
  const agentRef = record.agentRef;
  if (typeof agentRef !== "string" || agentRef === "") {
    return undefined;
  }
  return {
    route,
    providerSessionId,
    runtimeVersion,
    capabilityHash,
    hostId,
    observedAt,
    expiresAt,
    agentRef,
  };
}

/** result watermark 判定に必要な adapter.status() の拡張面。core の SessionStatus は凍結中のため局所型で扱う。 */
export interface ResultWatermarkSessionStatus {
  resultCount?: number;
  lastResultId?: number;
  lastEntryId?: number;
}

export interface SessionEndSnapshot {
  resultCount: number;
  lastResultId: number;
  resultWatermark: number;
  lastEntryId: number;
  observedAt: number;
}

/**
 * run.meta（JSON文字列）を安全にパースする。
 * パース失敗・非オブジェクトの場合は空扱い（serverUrl/model は空文字、modelDelivery は 'none'）にする。
 * modelDelivery は 'native' の場合のみ 'native' を採用し、欠如・不正はすべて 'none' とする。
 * review ステージ（reviewer run 専用の SessionRef 再構築）とも共用する。
 */
export function parseRunMeta(meta: string): RunMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { serverUrl: "", model: "", modelDelivery: "none" };
  }
  const record = parsed as Record<string, unknown>;
  const serverUrl = typeof record.serverUrl === "string" ? record.serverUrl : "";
  const model = typeof record.model === "string" ? record.model : "";
  const modelDelivery: ModelDelivery = record.modelDelivery === "native" ? "native" : "none";
  const nativeCommunication = parseNativeCommunication(record.nativeCommunication);
  return nativeCommunication === undefined
    ? { serverUrl, model, modelDelivery }
    : { serverUrl, model, modelDelivery, nativeCommunication };
}

/**
 * task_runs（正本）から当該タスクの最新 open run を選び SessionRef を再構築する。
 * - open run（status='running'）が 0 件なら null を返す
 * - 複数ある場合は startedAt が最新（同着なら id が最大）の run を採用する
 * - provider/sessionId/startedAt は run 行から、serverUrl/model/modelDelivery は run.meta から取り出す
 * block_reason は一切参照しない（docs/contract.md §12.5-1）。
 * 最新 open run の選定は KanbanStore.getLatestOpenRun に委譲する（全 open run 走査の排除, §12.7-6）。
 */
export function reconstructSessionRef(store: KanbanStore, taskId: string): SessionRef | null {
  const latest = store.getLatestOpenRun(taskId);
  if (latest === null) {
    return null;
  }

  const { serverUrl, model, modelDelivery, nativeCommunication } = parseRunMeta(latest.meta);
  return {
    provider: latest.provider,
    sessionId: latest.sessionId,
    serverUrl,
    model,
    modelDelivery,
    ...(nativeCommunication === undefined ? {} : { nativeCommunication }),
    startedAt: latest.startedAt,
  };
}

/**
 * 再構築済み SessionRef に対応する WorkerAdapter を選択する（契約 §17.3）。
 * ref.serverUrl==="direct"（direct transport で起動した run の印）なら directAdapters を、
 * それ以外は従来どおり bridge adapters を返す。direct 指定で adapter が未構成の場合は
 * bridge へ silent fallback せず throw する（fail-closed）。
 * monitor / finalize / review の status / fetchTranscript 参照がこれを介して adapter を得る。
 */
export function pickAdapter(deps: StageDeps, ref: SessionRef): WorkerAdapter {
  if (ref.nativeCommunication !== undefined) {
    const native = deps.nativeCommunicationAdapters?.[ref.provider];
    if (native !== undefined) {
      const candidate = native as unknown as Partial<WorkerAdapter>;
      if (
        typeof candidate.status === "function" &&
        typeof candidate.fetchTranscript === "function" &&
        typeof candidate.healthCheck === "function"
      ) {
        return native as unknown as WorkerAdapter;
      }
    }
    throw new Error(`native communication の worker adapter が未構成です (provider=${ref.provider})`);
  }
  if (ref.serverUrl === "direct") {
    const adapter = deps.directAdapters?.[ref.provider];
    if (adapter === undefined) {
      throw new Error(`direct transport の adapter が未構成です (provider=${ref.provider})`);
    }
    return adapter;
  }
  return deps.adapters[ref.provider];
}

/**
 * 起動時（launch）の WorkerAdapter を transport 指定に基づき選択する（契約 §17.3）。
 * transport==="direct" なら directAdapters を、それ以外は bridge adapters を返す。
 * direct 指定で adapter が未構成の場合は throw する（fail-closed。bridge fallback 禁止）。
 * review ステージのレビュアー起動が profiles["review"].transport を尊重するために使う。
 */
export function pickLaunchAdapter(deps: StageDeps, provider: Provider, transport: Transport): WorkerAdapter {
  if (transport === "direct") {
    const adapter = deps.directAdapters?.[provider];
    if (adapter === undefined) {
      throw new Error(`direct transport の adapter が未構成です (provider=${provider})`);
    }
    return adapter;
  }
  return deps.adapters[provider];
}

/**
 * task_events.payload（JSON文字列）から sessionId を安全に取り出す共通ヘルパー。
 * monitor / finalize がイベントのセッションスコープ照合（docs/contract.md §12.5-3）に使う。
 * パース失敗・型不一致の場合は null を返す。
 */
export function extractEventSessionId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * session_ended payload の resultCount watermark を取り出す。
 * legacy payload（resultCount 欠如）は contract §52.4 に従い 1 相当として扱う。
 */
export function extractSessionEndedResultCount(payload: string): number {
  const parsed = parsePayload(payload);
  if (parsed === null) {
    return 0;
  }
  if (!Object.hasOwn(parsed, "resultCount")) {
    return 1;
  }
  return nonNegativeInteger(parsed.resultCount) ?? 0;
}

/** session_ended payload の lastResultId を取り出す。無い/不正/0 は 0。 */
export function extractSessionEndedLastResultId(payload: string): number {
  const parsed = parsePayload(payload);
  if (parsed === null) {
    return 0;
  }
  return positiveInteger(parsed.lastResultId) ?? 0;
}

/** session_end_candidate / session_ended payload の静穏確認 snapshot を取り出す。 */
export function extractSessionEndSnapshot(payload: string): SessionEndSnapshot | null {
  const parsed = parsePayload(payload);
  if (parsed === null) {
    return null;
  }
  const resultCount = nonNegativeInteger(parsed.resultCount);
  const lastResultId = nonNegativeInteger(parsed.lastResultId);
  const resultWatermark = positiveInteger(parsed.resultWatermark);
  const lastEntryId = nonNegativeInteger(parsed.lastEntryId);
  const observedAt = nonNegativeInteger(parsed.observedAt);
  if (
    resultCount === null ||
    lastResultId === null ||
    resultWatermark === null ||
    lastEntryId === null ||
    observedAt === null
  ) {
    return null;
  }
  return { resultCount, lastResultId, resultWatermark, lastEntryId, observedAt };
}

/**
 * session_ended payload の比較用 watermark。
 * lastResultId が正なら優先し、無ければ legacy resultCount に fallback する。
 */
export function extractSessionEndedResultWatermark(payload: string): number {
  const parsed = parsePayload(payload);
  if (parsed === null) {
    return 0;
  }
  const lastResultId = positiveInteger(parsed.lastResultId);
  if (lastResultId !== null) {
    return lastResultId;
  }
  if (!Object.hasOwn(parsed, "resultCount")) {
    return 1;
  }
  return nonNegativeInteger(parsed.resultCount) ?? 0;
}

/** adapter.status() の戻り値から lastResultId を取り出す。 */
export function sessionStatusLastResultId(status: ResultWatermarkSessionStatus): number {
  return positiveInteger(status.lastResultId) ?? 0;
}

/** adapter.status() の戻り値から lastEntryId を取り出す。欠如・不正は 0。 */
export function sessionStatusLastEntryId(status: ResultWatermarkSessionStatus): number {
  return nonNegativeInteger(status.lastEntryId) ?? 0;
}

/** adapter.status() の戻り値から比較用 watermark を取り出す。lastResultId が正なら優先する。 */
export function sessionStatusResultWatermark(status: ResultWatermarkSessionStatus): number {
  const lastResultId = positiveInteger(status.lastResultId);
  if (lastResultId !== null) {
    return lastResultId;
  }
  return nonNegativeInteger(status.resultCount) ?? 0;
}

/** 同一 sessionId の session_ended 群から最大 watermark のイベントを選ぶ（同値は後勝ち）。 */
export function latestSessionEndedEvent(events: EventRow[]): EventRow | null {
  let latest: EventRow | null = null;
  for (const event of events) {
    if (latest === null) {
      latest = event;
      continue;
    }
    const resultWatermark = extractSessionEndedResultWatermark(event.payload);
    const latestResultWatermark = extractSessionEndedResultWatermark(latest.payload);
    if (resultWatermark > latestResultWatermark || (resultWatermark === latestResultWatermark && event.id > latest.id)) {
      latest = event;
    }
  }
  return latest;
}
