// =============================================================================
// /api/board・/api/task/:id への fetch ラッパー（docs/contract.md §20.2）。
// =============================================================================

import type {
  BoardResponse,
  ConfigGetResponse,
  ConfigPutRequest,
  ConfigPutResponse,
  HumanDecisionAnswerRequest,
  HumanDecisionListResponse,
  HumanDecisionResponse,
  KnowledgeListResponse,
  KillSwitchRequest,
  ScheduleFormOptionsResponse,
  SchedulePatchRequest,
  ScheduleWriteRequest,
  SchedulesResponse,
  ScheduleWithNextFire,
  SessionLiveResponse,
  SessionResponse,
  SessionMessagesResponse,
  SessionTranscriptRawResponse,
  SessionTranscriptResponse,
  SessionsResponse,
  SupervisorStatus,
  RuntimeResourcesResponse,
  NormalizedTaskDetailResponse,
  TaskDetailWireResponse,
  TaskWatchResponse,
  UsageGroupByAxis,
  UsageResponse,
} from "../../shared/api-types.js";
import type { HumanDecisionStatus, TaskRow } from "@hachi/core";

/** fetch 失敗（ネットワークエラー・非 2xx）を表す例外 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly issues?: readonly string[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 非 2xx 応答から ApiError を組み立てる。
 * body が `{ error, issues }` 形状の JSON であれば message/issues をそこから採る。
 * JSON でない、または期待した形状でなければ fallbackMessage・issues=undefined へ倒す。
 */
async function buildApiError(res: Response, fallbackMessage: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new ApiError(fallbackMessage, res.status);
  }
  if (typeof body !== "object" || body === null) {
    return new ApiError(fallbackMessage, res.status);
  }
  const record = body as { error?: unknown; issues?: unknown };
  const message = typeof record.error === "string" && record.error !== "" ? record.error : fallbackMessage;
  const issues = Array.isArray(record.issues)
    ? record.issues.filter((item): item is string => typeof item === "string")
    : undefined;
  return new ApiError(message, res.status, issues !== undefined && issues.length > 0 ? issues : undefined);
}

export const WRITE_TOKEN_STORAGE_KEY = "hachi.webWriteToken";

export type WriteTokenPrompt = () => Promise<string | null>;

let writeTokenPrompt: WriteTokenPrompt | null = null;
let pendingWriteTokenPrompt: Promise<string | null> | null = null;

export function setWriteTokenPrompt(prompt: WriteTokenPrompt | null): void {
  writeTokenPrompt = prompt;
}

export function clearStoredWriteToken(): void {
  try {
    globalThis.localStorage?.removeItem(WRITE_TOKEN_STORAGE_KEY);
  } catch {
    // localStorage が使えない環境では保存済み token は無いものとして扱う。
  }
}

function readStoredWriteToken(): string | null {
  try {
    const token = globalThis.localStorage?.getItem(WRITE_TOKEN_STORAGE_KEY) ?? null;
    if (token === null || token.trim() === "") {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function saveWriteToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(WRITE_TOKEN_STORAGE_KEY, token);
  } catch {
    // 保存に失敗しても、その場のリトライには入力値を使う。
  }
}

async function requestWriteToken(): Promise<string | null> {
  if (pendingWriteTokenPrompt !== null) {
    return pendingWriteTokenPrompt;
  }
  if (writeTokenPrompt === null) {
    return null;
  }
  pendingWriteTokenPrompt = writeTokenPrompt()
    .then((token) => {
      const normalized = token?.trim() ?? "";
      if (normalized === "") {
        return null;
      }
      saveWriteToken(normalized);
      return normalized;
    })
    .catch(() => null)
    .finally(() => {
      pendingWriteTokenPrompt = null;
    });
  return pendingWriteTokenPrompt;
}

function withWriteAuthorization(headers: HeadersInit | undefined, tokenOverride?: string): Headers {
  const headersWithAuth = new Headers(headers);
  const token = tokenOverride ?? readStoredWriteToken();
  if (token !== null) {
    headersWithAuth.set("authorization", `Bearer ${token}`);
  }
  return headersWithAuth;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  // exactOptionalPropertyTypes: true のため、signal 未指定時はプロパティ自体を省略する
  const init: RequestInit = signal === undefined ? {} : { signal };
  const res = await fetch(path, init);
  if (!res.ok) {
    throw new ApiError(`API リクエストに失敗しました (${res.status}): ${path}`, res.status);
  }
  return (await res.json()) as T;
}

export interface FetchHumanDecisionsParams {
  taskId?: string;
  tenant?: string;
  statuses?: readonly HumanDecisionStatus[];
}

/** GET /api/human-decisions（docs/contract.md §80.5） */
export function fetchHumanDecisions(
  params: FetchHumanDecisionsParams = {},
  signal?: AbortSignal,
): Promise<HumanDecisionListResponse> {
  const query = new URLSearchParams();
  if (params.taskId !== undefined) {
    query.set("taskId", params.taskId);
  }
  if (params.tenant !== undefined && params.tenant !== "") {
    query.set("tenant", params.tenant);
  }
  if (params.statuses !== undefined && params.statuses.length > 0) {
    query.set("statuses", params.statuses.join(","));
  }
  const qs = query.toString();
  return fetchJson<HumanDecisionListResponse>(`/api/human-decisions${qs === "" ? "" : `?${qs}`}`, signal);
}

/** GET /api/human-decisions/:id（docs/contract.md §80.5） */
export function fetchHumanDecision(
  requestId: string,
  tenant?: string,
  signal?: AbortSignal,
): Promise<HumanDecisionResponse> {
  const query = new URLSearchParams();
  if (tenant !== undefined && tenant !== "") {
    query.set("tenant", tenant);
  }
  const qs = query.toString();
  return fetchJson<HumanDecisionResponse>(
    `/api/human-decisions/${encodeURIComponent(requestId)}${qs === "" ? "" : `?${qs}`}`,
    signal,
  );
}

export interface FetchBoardParams {
  tenant?: string;
  q?: string;
}

/** GET /api/board?tenant=&q= */
export function fetchBoard(params: FetchBoardParams, signal?: AbortSignal): Promise<BoardResponse> {
  const query = new URLSearchParams();
  if (params.tenant !== undefined && params.tenant !== "") {
    query.set("tenant", params.tenant);
  }
  if (params.q !== undefined && params.q !== "") {
    query.set("q", params.q);
  }
  const qs = query.toString();
  return fetchJson<BoardResponse>(`/api/board${qs === "" ? "" : `?${qs}`}`, signal);
}

export interface FetchKnowledgeParams {
  tag?: string;
  source?: string;
  q?: string;
  limit?: number;
}

/** GET /api/knowledge?tag=&source=&q=&limit=（docs/contract.md §47.5） */
export function fetchKnowledge(params: FetchKnowledgeParams = {}, signal?: AbortSignal): Promise<KnowledgeListResponse> {
  const query = new URLSearchParams();
  if (params.tag !== undefined && params.tag !== "") {
    query.set("tag", params.tag);
  }
  if (params.source !== undefined && params.source !== "") {
    query.set("source", params.source);
  }
  if (params.q !== undefined && params.q !== "") {
    query.set("q", params.q);
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }
  const qs = query.toString();
  return fetchJson<KnowledgeListResponse>(`/api/knowledge${qs === "" ? "" : `?${qs}`}`, signal);
}

/** GET /api/task/:id */
export function fetchTaskDetail(taskId: string, signal?: AbortSignal): Promise<NormalizedTaskDetailResponse> {
  return fetchJson<TaskDetailWireResponse>(`/api/task/${encodeURIComponent(taskId)}`, signal).then((response) => ({
    ...response,
    cancelRequests: response.cancelRequests ?? [],
    steerDeliveries: response.steerDeliveries ?? [],
  }));
}

export type SessionsScope = "running" | "recent";

/** GET /api/sessions?scope=（docs/contract.md §28.2） */
export function fetchSessions(scope: SessionsScope, signal?: AbortSignal): Promise<SessionsResponse> {
  const query = new URLSearchParams();
  query.set("scope", scope);
  return fetchJson<SessionsResponse>(`/api/sessions?${query.toString()}`, signal);
}

/** GET /api/sessions（docs/contract.md §26.1） */
export function fetchRunningSessions(signal?: AbortSignal): Promise<SessionsResponse> {
  return fetchSessions("running", signal);
}

/** GET /api/session/:sessionId（docs/contract.md §27.2/§28.2） */
export function fetchSession(sessionId: string, signal?: AbortSignal): Promise<SessionResponse> {
  return fetchJson<SessionResponse>(`/api/session/${encodeURIComponent(sessionId)}`, signal);
}

export interface FetchSessionMessagesParams {
  sessionId: string;
  provider: string;
  server: string;
}

/** GET /api/session/:sessionId/messages?provider=&server=（docs/contract.md §26.1） */
export function fetchSessionMessages(
  params: FetchSessionMessagesParams,
  signal?: AbortSignal,
): Promise<SessionMessagesResponse> {
  const query = new URLSearchParams();
  query.set("provider", params.provider);
  query.set("server", params.server);
  return fetchJson<SessionMessagesResponse>(
    `/api/session/${encodeURIComponent(params.sessionId)}/messages?${query.toString()}`,
    signal,
  );
}

export interface FetchSessionTranscriptParams {
  sessionId: string;
  taskId: string;
}

export interface FetchSessionLiveParams {
  sessionId: string;
  taskId: string;
  tail?: number;
}

/** GET /api/session/:sessionId/transcript?taskId=（docs/contract.md §28.2） */
export function fetchSessionTranscript(
  params: FetchSessionTranscriptParams,
  signal?: AbortSignal,
): Promise<SessionTranscriptResponse> {
  const query = new URLSearchParams();
  query.set("taskId", params.taskId);
  return fetchJson<SessionTranscriptResponse>(
    `/api/session/${encodeURIComponent(params.sessionId)}/transcript?${query.toString()}`,
    signal,
  );
}

/** GET /api/session/:sessionId/live?taskId=&tail=（docs/contract.md §54.4） */
export function fetchSessionLive(
  params: FetchSessionLiveParams,
  signal?: AbortSignal,
): Promise<SessionLiveResponse> {
  const query = new URLSearchParams();
  query.set("taskId", params.taskId);
  if (params.tail !== undefined) {
    query.set("tail", String(params.tail));
  }
  return fetchJson<SessionLiveResponse>(
    `/api/session/${encodeURIComponent(params.sessionId)}/live?${query.toString()}`,
    signal,
  );
}

export interface FetchSessionTranscriptRawParams {
  sessionId: string;
  taskId: string;
  after?: number;
  before?: number;
  limit?: number;
}

/** GET /api/session/:sessionId/transcript-raw?taskId=&after=&before=&limit=（docs/contract.md §28） */
export function fetchSessionTranscriptRaw(
  params: FetchSessionTranscriptRawParams,
  signal?: AbortSignal,
): Promise<SessionTranscriptRawResponse> {
  const query = new URLSearchParams();
  query.set("taskId", params.taskId);
  if (params.after !== undefined) {
    query.set("after", String(params.after));
  }
  if (params.before !== undefined) {
    query.set("before", String(params.before));
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }
  return fetchJson<SessionTranscriptRawResponse>(
    `/api/session/${encodeURIComponent(params.sessionId)}/transcript-raw?${query.toString()}`,
    signal,
  );
}

/** GET /api/supervisor（docs/contract.md §23.1） */
export function fetchSupervisorStatus(signal?: AbortSignal): Promise<SupervisorStatus> {
  return fetchJson<SupervisorStatus>("/api/supervisor", signal);
}

/** GET /api/runtime-resources（docs/contract.md §56.6） */
export function fetchRuntimeResources(signal?: AbortSignal): Promise<RuntimeResourcesResponse> {
  return fetchJson<RuntimeResourcesResponse>("/api/runtime-resources", signal);
}

/** GET /api/schedules（docs/contract.md §29.4） */
export function fetchSchedules(signal?: AbortSignal): Promise<SchedulesResponse> {
  return fetchJson<SchedulesResponse>("/api/schedules", signal);
}

export interface FetchUsageParams {
  by: UsageGroupByAxis;
  days: number;
  tenant?: string;
}

/** GET /api/usage?by=&days=&tenant=（契約 §14.5.1） */
export function fetchUsage(params: FetchUsageParams, signal?: AbortSignal): Promise<UsageResponse> {
  const query = new URLSearchParams({ by: params.by, days: String(params.days) });
  if (params.tenant !== undefined && params.tenant !== "") {
    query.set("tenant", params.tenant);
  }
  return fetchJson<UsageResponse>(`/api/usage?${query.toString()}`, signal);
}

/** GET /api/schedule-options（docs/contract.md §29.5） */
export function fetchScheduleOptions(signal?: AbortSignal): Promise<ScheduleFormOptionsResponse> {
  return fetchJson<ScheduleFormOptionsResponse>("/api/schedule-options", signal);
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetchWrite(path, init);
  if (!res.ok) {
    throw new ApiError(`API リクエストに失敗しました (${res.status}): ${path}`, res.status);
  }
  return (await res.json()) as T;
}

async function fetchWrite(path: string, init: RequestInit): Promise<Response> {
  const firstRes = await fetch(path, {
    ...init,
    headers: withWriteAuthorization(init.headers),
  });
  if (firstRes.status !== 401) {
    return firstRes;
  }

  const token = await requestWriteToken();
  if (token === null) {
    return firstRes;
  }
  return await fetch(path, {
    ...init,
    headers: withWriteAuthorization(init.headers, token),
  });
}

/** POST /api/human-decisions/:id/answer（docs/contract.md §80.5） */
export function postHumanDecisionAnswer(
  requestId: string,
  requestBody: HumanDecisionAnswerRequest,
  tenant?: string,
): Promise<HumanDecisionResponse> {
  const query = new URLSearchParams();
  if (tenant !== undefined && tenant !== "") {
    query.set("tenant", tenant);
  }
  const qs = query.toString();
  return sendJson<HumanDecisionResponse>(
    `/api/human-decisions/${encodeURIComponent(requestId)}/answer${qs === "" ? "" : `?${qs}`}`,
    "POST",
    requestBody,
  );
}

/** GET /api/config（docs/contract.md §45.1。read だが write token 認可対象） */
export async function fetchConfig(signal?: AbortSignal): Promise<ConfigGetResponse> {
  const init: RequestInit = signal === undefined ? { method: "GET" } : { method: "GET", signal };
  const res = await fetchWrite("/api/config", init);
  if (!res.ok) {
    throw new ApiError(`config の取得に失敗しました (${res.status})`, res.status);
  }
  return (await res.json()) as ConfigGetResponse;
}

/**
 * PUT /api/config（docs/contract.md §45.1）
 * サーバは 400 時に `{ error, issues }` でどのフィールドが allowlist/zod のどこに
 * 違反したかを返す（app.ts の zod 失敗・validateConfigSemantics 失敗の 2 経路）。
 * 共通の sendJson は body を読まず捨てるため、ここだけ専用に body を読んで ApiError へ載せる。
 */
export async function putConfig(requestBody: ConfigPutRequest): Promise<ConfigPutResponse> {
  const res = await fetchWrite("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    throw await buildApiError(res, `API リクエストに失敗しました (${res.status}): /api/config`);
  }
  return (await res.json()) as ConfigPutResponse;
}

/** POST /api/schedules */
export async function postSchedule(requestBody: ScheduleWriteRequest): Promise<ScheduleWithNextFire> {
  const body = await sendJson<{ schedule: ScheduleWithNextFire }>("/api/schedules", "POST", requestBody);
  return body.schedule;
}

/** PATCH /api/schedules/:id */
export async function patchSchedule(id: string, requestBody: SchedulePatchRequest): Promise<ScheduleWithNextFire> {
  const body = await sendJson<{ schedule: ScheduleWithNextFire }>(
    `/api/schedules/${encodeURIComponent(id)}`,
    "PATCH",
    requestBody,
  );
  return body.schedule;
}

/** DELETE /api/schedules/:id */
export async function deleteSchedule(id: string): Promise<void> {
  await sendJson<{ deleted: boolean; id: string }>(`/api/schedules/${encodeURIComponent(id)}`, "DELETE");
}

/** POST/DELETE /api/tasks/:id/watch（docs/contract.md §46.3） */
export async function setTaskWatched(taskId: string, watched: boolean): Promise<TaskRow> {
  const method = watched ? "POST" : "DELETE";
  const body = await sendJson<TaskWatchResponse>(`/api/tasks/${encodeURIComponent(taskId)}/watch`, method);
  return body.task;
}

export function watchTask(taskId: string): Promise<TaskRow> {
  return setTaskWatched(taskId, true);
}

export function unwatchTask(taskId: string): Promise<TaskRow> {
  return setTaskWatched(taskId, false);
}

/** POST /api/supervisor/killswitch のレスポンス（更新後の該当ステージ状態。§23.2） */
export interface KillSwitchResponse {
  name: string;
  disabled: boolean;
}

/** POST /api/supervisor/killswitch（docs/contract.md §23.2） */
export async function postKillSwitch(stage: string, disabled: boolean): Promise<KillSwitchResponse> {
  const requestBody: KillSwitchRequest = { stage, disabled };
  const res = await fetchWrite("/api/supervisor/killswitch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    throw new ApiError(`kill-switch の更新に失敗しました (${res.status})`, res.status);
  }
  return (await res.json()) as KillSwitchResponse;
}
