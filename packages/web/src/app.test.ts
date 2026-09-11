// =============================================================================
// @hachi/web の Hono アプリケーションのテスト（docs/contract.md §20。JSON API 版）。
// KanbanReadView は本テスト内のフェイク実装（FakeReadView）で差し替え、
// 実 DB へは一切接続しない。artifacts / 静的配信は一時ディレクトリを使う。
// =============================================================================

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempHome, MockBridgeServer, type TempHome } from "@hachi/testing";
import type {
  BridgeConfig,
  CommentRow,
  EventRow,
  HachiConfig,
  KanbanReadView,
  KnowledgeListOptions,
  KnowledgeRow,
  LinkRow,
  RunRow,
  RunCancelRequestRow,
  RunningSession,
  RuntimeCleanupRequestRow,
  RuntimeResourceLeaseRow,
  RuntimeResourceMemberRow,
  RuntimeResourceReadView,
  ScheduleCreateInput,
  ScheduleFormOptions,
  ScheduleRow,
  SteerDeliveryReadModel,
  TaskRow,
  TaskStatus,
  VisibilityBucket,
} from "@hachi/core";
import { TASK_STATUSES, SqliteKanbanStore, runtimeMembersHash, sha256Hex } from "@hachi/core";
import { buildApp, type WebDeps } from "./app.js";
import { STAGE_NAMES } from "./supervisor-status.js";
import type {
  BoardResponse,
  ConfigGetResponse,
  ConfigPutResponse,
  MetricsResponse,
  ScheduleFormOptionsResponse,
  ScheduleWithNextFire,
  SchedulesResponse,
  SessionLiveResponse,
  SessionResponse,
  SessionMessagesResponse,
  SessionTranscriptResponse,
  SessionTranscriptRawResponse,
  SessionsResponse,
  SupervisorStatus,
  RuntimeResourcesResponse,
  TaskDetailResponse,
  UsageResponse,
} from "./shared/api-types.js";

function makeRuntimeLease(overrides: Partial<RuntimeResourceLeaseRow> = {}): RuntimeResourceLeaseRow {
  return {
    id: "lease-default",
    bundleKind: "worktree_postgres",
    state: "active",
    cleanupPolicy: "auto",
    managed: true,
    ephemeral: true,
    ownerTaskId: "t_889ded5d3079df58",
    ownerRunId: 12,
    controllerOrchestratorId: "orch-main",
    board: "dev",
    project: "hachi-kanban",
    repoCommonDir: "/private/repo",
    canonicalWorktree: "/private/worktree",
    fence: 7,
    heartbeatAt: 1_700_000_000,
    expiresAt: 1_700_000_300,
    terminalReason: "",
    provenanceVersion: 1,
    rolloutGeneration: 1,
    createdAt: 1_699_999_000,
    updatedAt: 1_700_000_000,
    releasedAt: null,
    ...overrides,
  };
}

function makeRuntimeMember(overrides: Partial<RuntimeResourceMemberRow> = {}): RuntimeResourceMemberRow {
  return {
    id: "member-default",
    leaseId: "lease-default",
    kind: "docker_container",
    state: "active",
    cleanupPolicy: "auto",
    managed: true,
    ephemeral: true,
    objectFence: 3,
    scopeKey: "desktop-linux",
    nativeId: "sha256:exact-object-id",
    displayName: "postgres-container",
    hostIp: "127.0.0.1",
    hostPort: 49152,
    containerPort: 5432,
    composeProject: "hachi-runtime",
    labelsHash: "labels-hash",
    provenance: '{"version":1,"secret":"provenance-body-must-not-leak"}',
    provenanceVerifiedAt: 1_700_000_010,
    lastObservedAt: 1_700_000_020,
    releasedAt: null,
    createdAt: 1_699_999_000,
    updatedAt: 1_700_000_020,
    ...overrides,
  };
}

function makeRuntimeRequest(overrides: Partial<RuntimeCleanupRequestRow> = {}): RuntimeCleanupRequestRow {
  return {
    id: "cleanup-default",
    leaseId: "lease-default",
    decisionClass: "auto",
    reason: "owner terminal",
    status: "queued",
    expectedLeaseFence: 7,
    expectedMembersHash: "",
    claimantSessionId: "session-main",
    claimantGeneration: 4,
    claimTokenHash: "claim-token-hash-must-not-leak",
    claimLeaseUntil: 1_700_000_400,
    approvedBy: "orchestrator",
    approvalGeneration: 4,
    executorId: "host-supervisor",
    executorGeneration: 2,
    executorLeaseUntil: 1_700_000_500,
    executionNonce: "execution-nonce-must-not-leak",
    attempts: 1,
    nextAttemptAt: 1_700_000_100,
    lastError: "",
    escalationGeneration: 0,
    humanAnswer: "human-answer-must-not-leak",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_020,
    resolvedAt: null,
    ...overrides,
  };
}

class FakeRuntimeResourceView implements RuntimeResourceReadView {
  constructor(
    private readonly leaseRows: RuntimeResourceLeaseRow[],
    private readonly memberRows: RuntimeResourceMemberRow[],
    private readonly requestRows: RuntimeCleanupRequestRow[],
  ) {}

  leases(): RuntimeResourceLeaseRow[] {
    return this.leaseRows;
  }

  members(leaseId: string): RuntimeResourceMemberRow[] {
    return this.memberRows.filter((member) => member.leaseId === leaseId);
  }

  cleanupRequests(leaseId: string): RuntimeCleanupRequestRow[] {
    return this.requestRows.filter((request) => request.leaseId === leaseId);
  }

  requirement(): never { throw new Error("unexpected requirement call"); }
  requirementsForTask(): never { throw new Error("unexpected requirementsForTask call"); }
  lease(): never { throw new Error("unexpected lease call"); }
  leasesForTask(): never { throw new Error("unexpected leasesForTask call"); }
  events(): never { throw new Error("unexpected events call"); }
  close(): void {}
}

// ---------- テスト用フィクスチャ ----------

let taskSeq = 0;
let scheduleSeq = 0;
let knowledgeSeq = 0;

/** テスト用 TaskRow を生成する（既定値入り、overrides で上書き可能） */
function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  taskSeq += 1;
  const now = 1_700_000_000 + taskSeq;
  return {
    id: `t_${String(taskSeq).padStart(8, "0")}`,
    title: `テストタスク${taskSeq}`,
    body: "",
    status: "triage",
    priority: 0,
    tenant: "tenant-a",
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
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeCancelRequest(taskId: string, overrides: Partial<RunCancelRequestRow> = {}): RunCancelRequestRow {
  return {
    id: "cr_web_cancel_1",
    taskId,
    runId: 42,
    sessionId: "worker-session",
    provider: "codex",
    status: "cooperative_sent",
    requestNonce: "secret-request-nonce",
    actor: "orchestrator",
    reason: "安全に停止",
    orchestratorId: "o_web_owner",
    requesterSessionId: "os_web_owner",
    requesterGeneration: 3,
    cancelFence: 1,
    deadlineAt: 1_700_000_060,
    acknowledgedNonce: "",
    capabilitySnapshot: "{}",
    stopEvidence: "{}",
    lastError: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_010,
    resolvedAt: null,
    ...overrides,
  };
}

function makeSteerDelivery(
  taskId: string,
  overrides: Partial<SteerDeliveryReadModel> = {},
): SteerDeliveryReadModel {
  return {
    id: "sd_web_steer_1",
    taskId,
    runId: 42,
    sessionId: "worker-session",
    messageKey: "steer-web-key",
    sequence: 1,
    status: "transport_accepted",
    supersedesId: null,
    expectedCancelFence: 0,
    observedMessageId: "",
    lastError: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_010,
    observedAt: null,
    acknowledgedAt: null,
    resolvedAt: null,
    targetState: "current",
    currentRunId: 42,
    currentSessionId: "worker-session",
    runCancelFence: 0,
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  scheduleSeq += 1;
  const now = 1_700_010_000 + scheduleSeq;
  return {
    id: `s_${String(scheduleSeq).padStart(16, "0")}`,
    name: `テストスケジュール${scheduleSeq}`,
    enabled: true,
    cadenceKind: "daily",
    atMinute: 0,
    atHour: 9,
    weekday: null,
    dayOfMonth: null,
    runDate: null,
    tenant: "tenant-a",
    profile: "implement",
    cwd: "/tmp/hk-scheduler",
    prompt: "run",
    priority: 0,
    lastRunAt: null,
    lastTaskId: null,
    consecutiveFailures: 0,
    autoDisabledReason: "",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeKnowledge(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
  knowledgeSeq += 1;
  const now = 1_700_020_000 + knowledgeSeq;
  return {
    id: `k_${String(knowledgeSeq).padStart(12, "0")}`,
    title: `知見${knowledgeSeq}`,
    body: "",
    source: "manual",
    tags: [],
    importance: 50,
    expiresAt: null,
    originPath: "",
    contentHash: `hash-${knowledgeSeq}`,
    actor: "tester",
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function transcriptArtifactName(sessionId: string): string {
  return `transcript-${sanitizeForFilename(sessionId)}-${sha256Hex(sessionId).slice(0, 8)}.txt`;
}

function fullTranscriptArtifactName(sessionId: string): string {
  return `transcript-full-${sanitizeForFilename(sessionId)}-${sha256Hex(sessionId).slice(0, 8)}.txt`;
}

function reviewTranscriptArtifactName(sessionId: string): string {
  return `transcript-review-${sanitizeForFilename(sessionId)}-${sha256Hex(sessionId).slice(0, 8)}.txt`;
}

/** blocked 状態タスクの可視性分類（KanbanReadView.bucketOf の再現。docs/contract.md §14.4） */
function bucketOfBlocked(reason: string): VisibilityBucket {
  if (
    reason.startsWith("user-decision:") ||
    reason.startsWith("user-feedback:") ||
    reason.startsWith("review-required:") ||
    reason.startsWith("needs-manual:")
  ) {
    return "human_queue";
  }
  if (reason.startsWith("codex-in-progress:") || reason.startsWith("claude-in-progress:")) {
    return "autonomous_in_progress";
  }
  if (reason.startsWith("auto-launch-failed:")) {
    return "retry_pending";
  }
  return "blocked_other";
}

/** KanbanReadView のフェイク実装。DB を持たずメモリ上の配列だけで応答する */
class FakeReadView implements KanbanReadView {
  constructor(
    private readonly tasks: TaskRow[] = [],
    private readonly commentsByTask: Record<string, CommentRow[]> = {},
    private readonly eventsByTask: Record<string, EventRow[]> = {},
    private readonly runsByTask: Record<string, RunRow[]> = {},
    private readonly linksByTask: Record<string, { parents: LinkRow[]; children: LinkRow[] }> = {},
    private readonly runningSessionRows: RunningSession[] = [],
    private readonly scheduleRows: ScheduleRow[] = [],
    private readonly recentSessionRows: RunningSession[] = [],
    private readonly knowledgeRows: KnowledgeRow[] = [],
    private readonly cancelRequestsByTask: Record<string, RunCancelRequestRow[]> = {},
    private readonly steerDeliveryRows: SteerDeliveryReadModel[] = [],
  ) {}

  tenants(): string[] {
    return [...new Set(this.tasks.map((t) => t.tenant))].filter((t) => t !== "").sort();
  }

  counts(tenant?: string): Record<TaskStatus, number> {
    const result = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const task of this.tasks) {
      if (tenant !== undefined && task.tenant !== tenant) continue;
      result[task.status] += 1;
    }
    return result;
  }

  runningSessions(): RunningSession[] {
    return this.runningSessionRows;
  }

  schedules(): ScheduleRow[] {
    return this.scheduleRows;
  }

  scheduleFormOptions(): ScheduleFormOptions {
    const cwds = [...new Set(this.scheduleRows.map((schedule) => schedule.cwd))];
    const tenants = [
      ...new Set([...this.tasks.map((task) => task.tenant), ...this.scheduleRows.map((schedule) => schedule.tenant)]),
    ]
      .filter((tenant) => tenant !== "")
      .sort();
    return { cwds, tenants };
  }

  schedule(id: string): ScheduleRow | null {
    return this.scheduleRows.find((schedule) => schedule.id === id) ?? null;
  }

  listKnowledge(options: KnowledgeListOptions = {}): KnowledgeRow[] {
    const now = Math.floor(Date.now() / 1000);
    const search = options.search?.trim().toLowerCase();
    const rows = this.knowledgeRows
      .filter((row) => options.source === undefined || row.source === options.source.trim())
      .filter((row) => options.tag === undefined || row.tags.includes(options.tag.trim()))
      .filter((row) => options.includeExpired === true || row.expiresAt === null || row.expiresAt >= now)
      .filter((row) => {
        if (search === undefined || search === "") {
          return true;
        }
        return row.title.toLowerCase().includes(search) || row.body.toLowerCase().includes(search);
      })
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return rows.slice(0, options.limit ?? 20);
  }

  recentSessions(limit: number): RunningSession[] {
    return this.recentSessionRows.slice(0, Math.max(0, Math.trunc(limit)));
  }

  runningSession(sessionId: string): RunningSession | null {
    return (
      this.runningSessionRows.find((session) => session.sessionId === sessionId) ??
      this.recentSessionRows.find((session) => session.sessionId === sessionId) ??
      null
    );
  }

  humanQueue(tenant?: string): TaskRow[] {
    return this.tasks.filter(
      (t) => (tenant === undefined || t.tenant === tenant) && this.bucketOf(t) === "human_queue",
    );
  }

  inProgress(tenant?: string): TaskRow[] {
    return this.tasks.filter(
      (t) => (tenant === undefined || t.tenant === tenant) && this.bucketOf(t) === "autonomous_in_progress",
    );
  }

  byStatus(status: TaskStatus, tenant?: string, limit?: number): TaskRow[] {
    const filtered = this.tasks.filter(
      (t) => t.status === status && (tenant === undefined || t.tenant === tenant),
    );
    return limit === undefined ? filtered : filtered.slice(0, limit);
  }

  bucketOf(task: TaskRow): VisibilityBucket {
    if (task.status !== "blocked") {
      return task.status;
    }
    return bucketOfBlocked(task.blockReason);
  }

  task(id: string): TaskRow | null {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  comments(taskId: string, limit?: number): CommentRow[] {
    const all = this.commentsByTask[taskId] ?? [];
    return limit === undefined ? all : all.slice(-limit);
  }

  events(taskId: string, limit?: number): EventRow[] {
    const all = this.eventsByTask[taskId] ?? [];
    return limit === undefined ? all : all.slice(-limit);
  }

  runs(taskId: string): RunRow[] {
    return this.runsByTask[taskId] ?? [];
  }

  cancelRequests(taskId: string): RunCancelRequestRow[] {
    return this.cancelRequestsByTask[taskId] ?? [];
  }

  steerDeliveries(taskId?: string): SteerDeliveryReadModel[] {
    return taskId === undefined
      ? this.steerDeliveryRows
      : this.steerDeliveryRows.filter((delivery) => delivery.taskId === taskId);
  }

  links(taskId: string): { parents: LinkRow[]; children: LinkRow[] } {
    return this.linksByTask[taskId] ?? { parents: [], children: [] };
  }

  close(): void {
    // フェイク実装のため何もしない
  }
}

type ScheduleStore = WebDeps["store"];

class FakeScheduleStore implements ScheduleStore {
  constructor(
    private readonly scheduleRows: ScheduleRow[] = [],
    private readonly taskRows: TaskRow[] = [],
  ) {}

  createSchedule(input: ScheduleCreateInput, actor: string): ScheduleRow {
    void actor;
    const schedule = this.applyInput(
      makeSchedule({
        tenant: "",
        profile: "",
        priority: 0,
      }),
      input,
    );
    this.scheduleRows.push(schedule);
    return schedule;
  }

  updateSchedule(id: string, patch: Partial<ScheduleCreateInput>, actor: string): ScheduleRow {
    void actor;
    const index = this.findIndex(id);
    const updated = this.applyInput(this.scheduleRows[index] as ScheduleRow, patch);
    this.scheduleRows[index] = updated;
    return updated;
  }

  setScheduleEnabled(id: string, enabled: boolean, actor: string, autoDisabledReason?: string): ScheduleRow {
    void actor;
    const index = this.findIndex(id);
    const current = this.scheduleRows[index] as ScheduleRow;
    const updated: ScheduleRow = {
      ...current,
      enabled,
      autoDisabledReason: enabled ? "" : autoDisabledReason ?? "",
      updatedAt: current.updatedAt + 1,
    };
    this.scheduleRows[index] = updated;
    return updated;
  }

  deleteSchedule(id: string, actor: string): void {
    void actor;
    const index = this.findIndex(id);
    this.scheduleRows.splice(index, 1);
  }

  setWatched(taskId: string, watched: boolean, actor: string): TaskRow {
    void actor;
    const index = this.taskRows.findIndex((task) => task.id === taskId);
    if (index === -1) {
      throw new Error(`タスクが見つかりません: ${taskId}`);
    }
    const current = this.taskRows[index] as TaskRow;
    if (current.watched === watched) {
      return current;
    }
    const updated = { ...current, watched, updatedAt: current.updatedAt + 1 };
    this.taskRows[index] = updated;
    return updated;
  }

  private findIndex(id: string): number {
    const index = this.scheduleRows.findIndex((schedule) => schedule.id === id);
    if (index === -1) {
      throw new Error(`スケジュールが見つかりません: ${id}`);
    }
    return index;
  }

  private applyInput(base: ScheduleRow, input: Partial<ScheduleCreateInput>): ScheduleRow {
    const cadenceKind = input.cadenceKind ?? base.cadenceKind;
    const updated: ScheduleRow = {
      ...base,
      name: input.name ?? base.name,
      cadenceKind,
      atHour: input.atHour ?? base.atHour,
      atMinute: input.atMinute ?? base.atMinute,
      tenant: input.tenant ?? base.tenant,
      profile: input.profile ?? base.profile,
      cwd: input.cwd ?? base.cwd,
      prompt: input.prompt ?? base.prompt,
      priority: input.priority ?? base.priority,
      weekday: null,
      dayOfMonth: null,
      runDate: null,
      updatedAt: base.updatedAt + 1,
    };

    if (cadenceKind === "weekly") {
      updated.weekday = input.weekday ?? base.weekday;
    }
    if (cadenceKind === "monthly") {
      updated.dayOfMonth = input.dayOfMonth ?? base.dayOfMonth;
    }
    if (cadenceKind === "once") {
      updated.runDate = input.runDate ?? base.runDate;
    }
    return updated;
  }
}

let tempHome: TempHome;

beforeEach(() => {
  tempHome = makeTempHome();
});

afterEach(() => {
  vi.restoreAllMocks();
  tempHome.cleanup();
});

/** テスト用 launchd ラベル既定値。実機に存在しないラベルを使い degrade（null）を再現しやすくする */
const TEST_LAUNCHD_LABEL = "com.hachi-kanban.supervisor.test-nonexistent";
const TEST_WRITE_TOKEN = "test-web-write-token";

const TEST_CONFIG: HachiConfig = {
  profiles: {
    implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
    review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
  },
  allowlist: {
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    claude: ["claude-sonnet-5"],
  },
  resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
  defaultProfile: "implement",
};

function buildDeps(
  view: KanbanReadView,
  staticDir?: string,
  bridges?: Record<"codex" | "claude", BridgeConfig>,
  store?: WebDeps["store"],
  config?: HachiConfig,
  metricsDbPath?: string,
  nativeLogRoots?: WebDeps["nativeLogRoots"],
): WebDeps {
  const deps: WebDeps = {
    view,
    store: store ?? new FakeScheduleStore(),
    artifactsDir: tempHome.env.artifactsDir,
    home: tempHome.env.home,
    launchdLabel: TEST_LAUNCHD_LABEL,
    bridges: bridges ?? tempHome.env.bridges,
    config: config ?? TEST_CONFIG,
    writeToken: TEST_WRITE_TOKEN,
  };
  if (staticDir !== undefined) {
    deps.staticDir = staticDir;
  }
  if (metricsDbPath !== undefined) {
    deps.metricsDbPath = metricsDbPath;
  }
  if (nativeLogRoots !== undefined) {
    deps.nativeLogRoots = nativeLogRoots;
  }
  return deps;
}

function withWriteAuth(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TEST_WRITE_TOKEN}`, ...headers };
}

function withJsonWriteAuth(headers: Record<string, string> = {}): Record<string, string> {
  return withWriteAuth({ "content-type": "application/json", ...headers });
}

function configFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profiles: {
      implement: { provider: "codex", model: "gpt-5.4" },
      review: { provider: "codex", model: "gpt-5.5" },
      docs: { provider: "claude", model: "claude-sonnet-5" },
    },
    allowlist: {
      codex: ["gpt-5.4", "gpt-5.5"],
      claude: ["claude-sonnet-5"],
    },
    resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
    defaultProfile: "implement",
    ...overrides,
  };
}

function writeConfigFixture(config: Record<string, unknown>): string {
  const filePath = join(tempHome.env.home, "config.json");
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return filePath;
}

// ---------- 設定 API ----------

describe("GET/PUT /api/config", () => {
  it("read も write token 認可を要求する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await app.request("/api/config");

    expect(res.status).toBe(401);
  });

  it("config 未存在時は exists:false を返し、baseEtag=null の PUT で新規作成する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const getRes = await app.request("/api/config", { headers: withWriteAuth() });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as ConfigGetResponse;
    expect(getBody).toEqual({ exists: false, config: null, etag: null });

    const config = configFixture({ steward: { intervalMinutes: 30 } });
    const putRes = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: JSON.stringify({ config, baseEtag: getBody.etag }),
    });

    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as ConfigPutResponse;
    expect(putBody.etag).not.toBeNull();
    expect(putBody.meta).toEqual({ applies: "next-tick" });
    expect(readFileSync(join(tempHome.env.home, "config.json"), "utf-8")).toContain("\"intervalMinutes\": 30");
    expect(existsSync(join(tempHome.env.home, "backups"))).toBe(false);
  });

  it("不正な JSON body は 400、zod 検証失敗は issues 要約付き 400", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const malformedRes = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: "{",
    });
    expect(malformedRes.status).toBe(400);

    const invalidRes = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: JSON.stringify({ config: { profiles: {} }, baseEtag: null }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidBody = (await invalidRes.json()) as { issues?: string[] };
    expect(invalidBody.issues?.some((issue) => issue.includes("allowlist"))).toBe(true);
  });

  it("core の意味検証で拒否される config は保存せず 400 にする", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const invalid = configFixture({ defaultProfile: "missing-profile" });

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: JSON.stringify({ config: invalid, baseEtag: null }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: string[] };
    expect(body.issues?.some((issue) => issue.includes("defaultProfile が profiles に存在しません"))).toBe(true);
    expect(existsSync(join(tempHome.env.home, "config.json"))).toBe(false);
    expect(existsSync(join(tempHome.env.home, "backups"))).toBe(false);
  });

  it("baseEtag 不一致は 409 で現在 etag を返す", async () => {
    const filePath = writeConfigFixture(configFixture());
    utimesSync(filePath, new Date(0), new Date(0));
    const app = buildApp(buildDeps(new FakeReadView([])));
    const getRes = await app.request("/api/config", { headers: withWriteAuth() });
    const getBody = (await getRes.json()) as ConfigGetResponse;

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: JSON.stringify({ config: configFixture(), baseEtag: "stale-etag" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { currentEtag?: string | null };
    expect(body.currentEtag).toBe(getBody.etag);
  });

  it("正常 PUT は backup を生成し、atomic rename 後の新 etag と変更セクションを返す", async () => {
    const initial = configFixture({ steward: { intervalMinutes: 10 } });
    const filePath = writeConfigFixture(initial);
    utimesSync(filePath, new Date(0), new Date(0));
    const initialRaw = readFileSync(filePath, "utf-8");
    const app = buildApp(buildDeps(new FakeReadView([])));
    const getRes = await app.request("/api/config", { headers: withWriteAuth() });
    const getBody = (await getRes.json()) as ConfigGetResponse;
    const next = configFixture({
      steward: { intervalMinutes: 20 },
      "future-section": { preserved: true },
    });

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: withJsonWriteAuth(),
      body: JSON.stringify({ config: next, baseEtag: getBody.etag }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigPutResponse;
    expect(body.etag).not.toBe(getBody.etag);
    expect(body.changedSections).toEqual(["future-section", "steward"]);
    const saved = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    expect(saved.steward).toEqual({ intervalMinutes: 20 });
    expect(saved["future-section"]).toEqual({ preserved: true });
    const backupNames = readdirSync(join(tempHome.env.home, "backups")).filter((name) =>
      /^config-\d{8}T\d{9}Z\.json$/.test(name),
    );
    expect(backupNames).toHaveLength(1);
    expect(readFileSync(join(tempHome.env.home, "backups", backupNames[0] as string), "utf-8")).toBe(initialRaw);
    expect(readdirSync(tempHome.env.home).some((name) => name.startsWith(".config."))).toBe(false);
  });

  it("同一 baseEtag の並行 PUT は片方だけ成功し、もう片方は 409 にする", async () => {
    const filePath = writeConfigFixture(configFixture({ steward: { intervalMinutes: 10 } }));
    utimesSync(filePath, new Date(0), new Date(0));
    const app = buildApp(buildDeps(new FakeReadView([])));
    const getRes = await app.request("/api/config", { headers: withWriteAuth() });
    const getBody = (await getRes.json()) as ConfigGetResponse;
    const first = configFixture({ steward: { intervalMinutes: 20 } });
    const second = configFixture({ steward: { intervalMinutes: 30 } });

    const [firstRes, secondRes] = await Promise.all([
      app.request("/api/config", {
        method: "PUT",
        headers: withJsonWriteAuth(),
        body: JSON.stringify({ config: first, baseEtag: getBody.etag }),
      }),
      app.request("/api/config", {
        method: "PUT",
        headers: withJsonWriteAuth(),
        body: JSON.stringify({ config: second, baseEtag: getBody.etag }),
      }),
    ]);

    expect([firstRes.status, secondRes.status].sort()).toEqual([200, 409]);
    const saved = JSON.parse(readFileSync(filePath, "utf-8")) as { steward?: { intervalMinutes?: number } };
    expect([20, 30]).toContain(saved.steward?.intervalMinutes);
    const rejected = firstRes.status === 409 ? firstRes : secondRes;
    const rejectedBody = (await rejected.json()) as { currentEtag?: string | null };
    expect(rejectedBody.currentEtag).not.toBe(getBody.etag);
    const backupNames = readdirSync(join(tempHome.env.home, "backups")).filter((name) =>
      /^config-\d{8}T\d{9}Z\.json$/.test(name),
    );
    expect(backupNames).toHaveLength(1);
  });
});

// ---------- ボード API ----------

describe("GET /api/board", () => {
  it("状態レーン（triage/todo/ready/review/needs-integration/done）にタスクを分類して返す", async () => {
    const tasks = [
      makeTask({ status: "triage", title: "triage タスク" }),
      makeTask({ status: "todo", title: "todo タスク" }),
      makeTask({ status: "ready", title: "ready タスク" }),
      makeTask({ status: "review", title: "review タスク" }),
      makeTask({ status: "needs-integration", title: "統合待ちタスク" }),
      makeTask({ status: "done", title: "完了タスク" }),
    ];
    const app = buildApp(buildDeps(new FakeReadView(tasks)));

    const res = await app.request("/api/board");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BoardResponse;
    expect(body.lanes.byStatus.triage.map((t) => t.title)).toContain("triage タスク");
    expect(body.lanes.byStatus.todo.map((t) => t.title)).toContain("todo タスク");
    expect(body.lanes.byStatus.ready.map((t) => t.title)).toContain("ready タスク");
    expect(body.lanes.byStatus.review.map((t) => t.title)).toContain("review タスク");
    expect(body.lanes.byStatus["needs-integration"].map((t) => t.title)).toContain("統合待ちタスク");
    expect(body.lanes.byStatus.done.map((t) => t.title)).toContain("完了タスク");
  });

  it("人間確認キューを判断待ちと回収待ちに分類して返す", async () => {
    const decisionTask = makeTask({
      status: "blocked",
      title: "判断待ち",
      blockReason: "user-decision: 承認が必要です",
    });
    const feedbackTask = makeTask({
      status: "blocked",
      title: "フィードバック待ち",
      blockReason: "user-feedback: 追記してください",
    });
    const reviewTask = makeTask({
      status: "blocked",
      title: "レビュー回収",
      blockReason: "review-required: 指摘確認",
    });
    const manualTask = makeTask({
      status: "blocked",
      title: "手動回収",
      blockReason: "needs-manual: transcript 取得不能",
    });
    const retryTask = makeTask({
      status: "blocked",
      title: "起動失敗回収",
      blockReason: "auto-launch-failed: bridge unavailable",
    });
    const unknownTask = makeTask({
      status: "blocked",
      title: "未知 prefix 回収",
      blockReason: "unknown-prefix: 旧理由",
    });
    const inProgressTask = makeTask({
      status: "blocked",
      title: "進行中は除外",
      blockReason: "codex-in-progress: 実行中",
    });
    const app = buildApp(
      buildDeps(
        new FakeReadView([
          decisionTask,
          feedbackTask,
          reviewTask,
          manualTask,
          retryTask,
          unknownTask,
          inProgressTask,
        ]),
      ),
    );

    const res = await app.request("/api/board");
    const body = (await res.json()) as BoardResponse;
    expect(body.lanes.humanDecisionQueue.map((task) => task.title)).toEqual([
      "判断待ち",
      "フィードバック待ち",
    ]);
    expect(body.lanes.orchestratorRecoveryQueue.map((task) => task.title)).toEqual([
      "レビュー回収",
      "手動回収",
      "起動失敗回収",
      "未知 prefix 回収",
    ]);
    expect(body.lanes.humanQueue.map((task) => task.title)).toEqual([
      "判断待ち",
      "フィードバック待ち",
      "レビュー回収",
      "手動回収",
      "起動失敗回収",
      "未知 prefix 回収",
    ]);
  });

  it("自律進行中タスクを inProgress レーンに返す", async () => {
    const inProgressTask = makeTask({
      status: "blocked",
      title: "実行中タスク",
      provider: "codex",
      blockReason: "codex-in-progress: 実装中 tmux=none even-session=abc server=http://127.0.0.1:3456",
    });
    const app = buildApp(buildDeps(new FakeReadView([inProgressTask])));

    const res = await app.request("/api/board");
    const body = (await res.json()) as BoardResponse;
    expect(body.lanes.inProgress).toHaveLength(1);
    expect(body.lanes.inProgress[0]?.provider).toBe("codex");
  });

  it("tenant クエリでレーンが絞り込まれる", async () => {
    const taskA = makeTask({ status: "todo", tenant: "tenant-a", title: "A タスク" });
    const taskB = makeTask({ status: "todo", tenant: "tenant-b", title: "B タスク" });
    const app = buildApp(buildDeps(new FakeReadView([taskA, taskB])));

    const res = await app.request("/api/board?tenant=tenant-a");
    const body = (await res.json()) as BoardResponse;
    expect(body.currentTenant).toBe("tenant-a");
    const titles = body.lanes.byStatus.todo.map((t) => t.title);
    expect(titles).toContain("A タスク");
    expect(titles).not.toContain("B タスク");
  });

  it("q クエリで title/ID 部分一致（大小無視）に絞り込まれる", async () => {
    const alpha = makeTask({ status: "todo", title: "Alpha task" });
    const beta = makeTask({ status: "todo", title: "Beta task" });
    const app = buildApp(buildDeps(new FakeReadView([alpha, beta])));

    const byTitle = await app.request(`/api/board?q=${encodeURIComponent("alpha")}`);
    const byTitleBody = (await byTitle.json()) as BoardResponse;
    const byTitleIds = byTitleBody.lanes.byStatus.todo.map((t) => t.id);
    expect(byTitleIds).toContain(alpha.id);
    expect(byTitleIds).not.toContain(beta.id);

    const byId = await app.request(`/api/board?q=${encodeURIComponent(beta.id.toUpperCase())}`);
    const byIdBody = (await byId.json()) as BoardResponse;
    const byIdIds = byIdBody.lanes.byStatus.todo.map((t) => t.id);
    expect(byIdIds).toEqual([beta.id]);
  });

  it("retry_pending（auto-launch-failed）件数を返す", async () => {
    const retryTask = makeTask({
      status: "blocked",
      title: "起動失敗タスク",
      blockReason: "auto-launch-failed: bridge unreachable",
    });
    const app = buildApp(buildDeps(new FakeReadView([retryTask])));

    const res = await app.request("/api/board");
    const body = (await res.json()) as BoardResponse;
    expect(body.retryPending).toBe(1);
  });

  it("現在doneのoriginを確定event列から集約しactor表示文字列を無視する", async () => {
    const automatic = makeTask({ status: "done", title: "自動完走" });
    const unknown = makeTask({ status: "done", title: "legacy完了" });
    const events: Record<string, EventRow[]> = {
      [automatic.id]: [{
        id: 1,
        taskId: automatic.id,
        eventType: "finalized",
        actor: "human",
        payload: JSON.stringify({ from: "blocked", to: "done", outcome: "done", sessionId: "sess-1" }),
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: automatic.completedAt ?? automatic.updatedAt,
      }],
      [unknown.id]: [{
        id: 2,
        taskId: unknown.id,
        eventType: "status_changed",
        actor: "human",
        payload: JSON.stringify({ from: "todo", to: "done" }),
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: unknown.completedAt ?? unknown.updatedAt,
      }],
    };
    const app = buildApp(buildDeps(new FakeReadView([automatic, unknown], {}, events)));

    const res = await app.request("/api/board");
    const body = (await res.json()) as BoardResponse;
    expect(body.doneOrigins).toEqual({
      total: 2,
      counts: { gatePassed: 1, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 1 },
      automaticCompletionRate: 0.5,
      manualRecoveryRate: 0,
      unknownRate: 0.5,
    });
  });
});

// ---------- knowledge API ----------

describe("GET /api/knowledge", () => {
  it("knowledge 一覧を importance 降順で返し、write token 認可を要求しない", async () => {
    const rows = [
      makeKnowledge({ title: "低重要度", importance: 10, createdAt: 1_700_000_001 }),
      makeKnowledge({ title: "高重要度", importance: 90, createdAt: 1_700_000_000 }),
    ];
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], [], [], rows)));

    const res = await app.request("/api/knowledge");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge: KnowledgeRow[] };
    expect(body.knowledge.map((row) => row.title)).toEqual(["高重要度", "低重要度"]);
  });

  it("tag/source/q で title/body を絞り込む", async () => {
    const matched = makeKnowledge({
      title: "Bridge handover",
      body: "restart procedure",
      source: "session-handover",
      tags: ["bridge", "handover"],
      importance: 80,
    });
    const bodyMatched = makeKnowledge({
      title: "Daily note",
      body: "Bridge restart memo",
      source: "steward",
      tags: ["bridge"],
      importance: 90,
    });
    const other = makeKnowledge({
      title: "Other note",
      body: "unrelated",
      source: "session-handover",
      tags: ["other"],
      importance: 100,
    });
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], [], [], [matched, bodyMatched, other])));

    const byTagSource = await app.request("/api/knowledge?tag=bridge&source=session-handover");
    const byTagSourceBody = (await byTagSource.json()) as { knowledge: KnowledgeRow[] };
    expect(byTagSourceBody.knowledge.map((row) => row.id)).toEqual([matched.id]);

    const byQuery = await app.request(`/api/knowledge?q=${encodeURIComponent("restart")}`);
    const byQueryBody = (await byQuery.json()) as { knowledge: KnowledgeRow[] };
    expect(byQueryBody.knowledge.map((row) => row.id)).toEqual([bodyMatched.id, matched.id]);
  });

  it("limit を適用し、不正な limit は 400 にする", async () => {
    const rows = [
      makeKnowledge({ title: "one", importance: 30 }),
      makeKnowledge({ title: "two", importance: 20 }),
      makeKnowledge({ title: "three", importance: 10 }),
    ];
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], [], [], rows)));

    const limited = await app.request("/api/knowledge?limit=2");
    const limitedBody = (await limited.json()) as { knowledge: KnowledgeRow[] };
    expect(limitedBody.knowledge).toHaveLength(2);

    const invalid = await app.request("/api/knowledge?limit=0");
    expect(invalid.status).toBe(400);
  });
});

// ---------- 実行中セッション API ----------

describe("GET /api/sessions", () => {
  it("runningSessions() の結果を返し、curlCommand に token 生値を含めない", async () => {
    writeFileSync(tempHome.env.bridges.codex.tokenFile, "secret-proxy-token\n", { mode: 0o600 });
    const task = makeTask({ title: "実行中セッション対象" });
    const runningSession: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-live",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
    };
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [runningSession])),
    );

    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.taskTitle).toBe("実行中セッション対象");
    expect(body.sessions[0]?.role).toBe("worker");
    expect(body.sessions[0]?.taskStatus).toBe("triage");
    expect(body.sessions[0]?.tenant).toBe("tenant-a");
    expect(body.sessions[0]?.liveSupported).toBe(true);
    expect(body.sessions[0]?.curlCommand).toContain("$(cat ");
    expect(body.sessions[0]?.curlCommand).toContain(tempHome.env.bridges.codex.tokenFile);
    expect(body.sessions[0]?.curlCommand).not.toContain("secret-proxy-token");
  });

  it("scope=recent は recentSessions() の終了済みセッションを返す", async () => {
    const runningTask = makeTask({ title: "実行中" });
    const endedTask = makeTask({ title: "以前のもの" });
    const runningSession: RunningSession = {
      taskId: runningTask.id,
      taskTitle: runningTask.title,
      taskStatus: runningTask.status,
      tenant: runningTask.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-running",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: runningTask.createdAt,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
    };
    const endedSession: RunningSession = {
      taskId: endedTask.id,
      taskTitle: endedTask.title,
      taskStatus: endedTask.status,
      tenant: endedTask.tenant,
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "bridge",
      sessionId: "sess-ended",
      serverUrl: tempHome.env.bridges.claude.url,
      startedAt: endedTask.createdAt,
      state: "ended",
      role: "reviewer",
      effort: null,
      effortDelivery: null,
    };
    const app = buildApp(
      buildDeps(new FakeReadView([runningTask, endedTask], {}, {}, {}, {}, [runningSession], [], [endedSession])),
    );

    const defaultRes = await app.request("/api/sessions");
    const defaultBody = (await defaultRes.json()) as SessionsResponse;
    expect(defaultBody.sessions.map((session) => session.sessionId)).toEqual(["sess-running"]);

    const recentRes = await app.request("/api/sessions?scope=recent");
    expect(recentRes.status).toBe(200);
    const recentBody = (await recentRes.json()) as SessionsResponse;
    expect(recentBody.sessions).toHaveLength(1);
    expect(recentBody.sessions[0]?.sessionId).toBe("sess-ended");
    expect(recentBody.sessions[0]?.state).toBe("ended");
    expect(recentBody.sessions[0]?.role).toBe("reviewer");
    expect(recentBody.sessions[0]?.taskStatus).toBe("triage");
    expect(recentBody.sessions[0]?.tenant).toBe("tenant-a");
  });

  it("effort/effortDelivery が非 null のセッションをレスポンスに含める", async () => {
    const task = makeTask({ title: "effort セッション" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-effort",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: "high",
      effortDelivery: "native",
    };
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session])),
    );

    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.effort).toBe("high");
    expect(body.sessions[0]?.effortDelivery).toBe("native");
  });

  it("scope=recent でも effort/effortDelivery を保持して返す", async () => {
    const task = makeTask({ title: "effort 終了済み" });
    const endedSession: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "bridge",
      sessionId: "sess-effort-ended",
      serverUrl: tempHome.env.bridges.claude.url,
      startedAt: task.createdAt,
      state: "ended",
      role: "worker",
      effort: "medium",
      effortDelivery: "none",
    };
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [], [], [endedSession])),
    );

    const res = await app.request("/api/sessions?scope=recent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.effort).toBe("medium");
    expect(body.sessions[0]?.effortDelivery).toBe("none");
  });

  it("scope が running/recent 以外なら 400", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/sessions?scope=all");
    expect(res.status).toBe(400);
  });
});

// ---------- セッションメタ API ----------

describe("GET /api/session/:sessionId", () => {
  it("sessionId 単体のメタ情報を返す", async () => {
    const task = makeTask({ title: "単体セッション" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-meta",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "running",
      role: "reviewer",
      effort: null,
      effortDelivery: null,
    };
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session])));

    const res = await app.request("/api/session/sess-meta");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse;
    expect(body.session.taskTitle).toBe("単体セッション");
    expect(body.session.role).toBe("reviewer");
    expect(body.session.taskStatus).toBe("triage");
    expect(body.session.tenant).toBe("tenant-a");
    expect(body.session.liveSupported).toBe(true);
    expect(body.session.state).toBe("running");
  });

  it("effort/effortDelivery が非 null のセッション詳細を返す", async () => {
    const task = makeTask({ title: "effort 詳細" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "direct",
      sessionId: "sess-effort-detail",
      serverUrl: "direct",
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: "xhigh",
      effortDelivery: "none",
    };
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session])));

    const res = await app.request("/api/session/sess-effort-detail");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse;
    expect(body.session.effort).toBe("xhigh");
    expect(body.session.effortDelivery).toBe("none");
  });

  it("存在しない sessionId は 404", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/session/sess-missing");
    expect(res.status).toBe(404);
  });
});

// ---------- セッション transcript fallback ----------

describe("GET /api/session/:sessionId/transcript", () => {
  it("transcript-full artifact を従来 transcript より優先して返す", async () => {
    const task = makeTask({ title: "完全ログ対象" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-full-priority",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "ended",
      role: "worker",
      effort: null,
      effortDelivery: null,
    };
    const dir = join(tempHome.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, transcriptArtifactName(session.sessionId)), "[assistant] thin transcript\n");
    writeFileSync(join(dir, fullTranscriptArtifactName(session.sessionId)), "[tool] exec_command pnpm test\n");
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [], [], [session])));

    const res = await app.request(
      `/api/session/${encodeURIComponent(session.sessionId)}/transcript?taskId=${task.id}`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptResponse;
    expect(body.text).toContain("[tool] exec_command");
    expect(body.text).not.toContain("thin transcript");
  });

  it("該当 session の transcript artifact を redaction 済み JSON で返す", async () => {
    const task = makeTask({ title: "保存ログ対象" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess:fallback",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "ended",
      role: "worker",
      effort: null,
      effortDelivery: null,
    };
    const dir = join(tempHome.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, transcriptArtifactName(session.sessionId)),
      "[assistant] Authorization: Bearer sk-transcriptsecret1234567890\n",
    );
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [], [], [session])));

    const res = await app.request(
      `/api/session/${encodeURIComponent(session.sessionId)}/transcript?taskId=${task.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptResponse;
    expect(body).toMatchObject({
      taskId: task.id,
      sessionId: session.sessionId,
      source: "artifact",
    });
    expect(body.text).toContain("[assistant]");
    expect(body.text).toContain("[REDACTED]");
    expect(body.text).not.toContain("sk-transcriptsecret1234567890");
  });

  it("reviewer session の transcript-review artifact を返す", async () => {
    const task = makeTask({ title: "レビュー保存ログ対象" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "review:sess:fallback",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "ended",
      role: "reviewer",
      effort: null,
      effortDelivery: null,
    };
    const dir = join(tempHome.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, reviewTranscriptArtifactName(session.sessionId)), "[assistant] レビュー結果\n");
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [], [], [session])));

    const res = await app.request(
      `/api/session/${encodeURIComponent(session.sessionId)}/transcript?taskId=${task.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptResponse;
    expect(body).toMatchObject({
      taskId: task.id,
      sessionId: session.sessionId,
      source: "artifact",
      text: "[assistant] レビュー結果\n",
    });
  });

  it("taskId が不正・session と task が不一致・artifact 不在なら 404", async () => {
    const task = makeTask({ title: "保存ログ対象" });
    const otherTask = makeTask({ title: "別タスク" });
    const session: RunningSession = {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "bridge",
      sessionId: "sess-no-file",
      serverUrl: tempHome.env.bridges.codex.url,
      startedAt: task.createdAt,
      state: "ended",
      role: "worker",
      effort: null,
      effortDelivery: null,
    };
    const app = buildApp(buildDeps(new FakeReadView([task, otherTask], {}, {}, {}, {}, [], [], [session])));

    const invalidTaskId = await app.request(
      `/api/session/${session.sessionId}/transcript?taskId=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(invalidTaskId.status).toBe(404);

    const mismatchedTask = await app.request(`/api/session/${session.sessionId}/transcript?taskId=${otherTask.id}`);
    expect(mismatchedTask.status).toBe(404);

    const missingArtifact = await app.request(`/api/session/${session.sessionId}/transcript?taskId=${task.id}`);
    expect(missingArtifact.status).toBe(404);
  });
});

// ---------- direct セッション live fallback ----------

describe("GET /api/session/:sessionId/live", () => {
  function directSession(task: TaskRow, overrides: Partial<RunningSession> = {}): RunningSession {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "codex",
      model: "gpt-5.4",
      transport: "direct",
      sessionId: "direct-live-1",
      serverUrl: "direct",
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
      ...overrides,
    };
  }

  function writeDirectOut(sessionId: string, text: string): void {
    const dir = join(tempHome.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sanitizeForFilename(sessionId)}.out`), text);
  }

  it("direct run の .out 末尾を redaction 済みで返す", async () => {
    const task = makeTask({ title: "direct live 対象" });
    const session = directSession(task);
    writeDirectOut(session.sessionId, "one\nAuthorization: Bearer sk-directsecret1234567890\nthree\n");
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session])));

    const res = await app.request(`/api/session/${session.sessionId}/live?taskId=${task.id}&tail=2`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionLiveResponse;
    expect(body).toMatchObject({
      taskId: task.id,
      sessionId: session.sessionId,
      source: "direct-live",
      truncated: true,
    });
    expect(body.text).toContain("…1行省略…");
    expect(body.text).not.toContain("one");
    expect(body.text).toContain("[REDACTED]");
    expect(body.text).not.toContain("sk-directsecret1234567890");
    expect(body.text).toContain("three");
  });

  it("bridge run と他タスク sessionId は 404", async () => {
    const task = makeTask({ title: "direct live 対象" });
    const otherTask = makeTask({ title: "別タスク" });
    const bridgeSession = directSession(task, {
      transport: "bridge",
      sessionId: "bridge-live",
      serverUrl: tempHome.env.bridges.codex.url,
    });
    const direct = directSession(task, { sessionId: "direct-mismatch" });
    writeDirectOut(bridgeSession.sessionId, "bridge\n");
    writeDirectOut(direct.sessionId, "direct\n");
    const app = buildApp(buildDeps(new FakeReadView([task, otherTask], {}, {}, {}, {}, [bridgeSession, direct])));

    const bridgeRes = await app.request(`/api/session/${bridgeSession.sessionId}/live?taskId=${task.id}`);
    const mismatchRes = await app.request(`/api/session/${direct.sessionId}/live?taskId=${otherTask.id}`);

    expect(bridgeRes.status).toBe(404);
    expect(mismatchRes.status).toBe(404);
  });

  it("tail は 2000 行で上限し、truncated と省略注記を返す", async () => {
    const task = makeTask({ title: "tail 対象" });
    const session = directSession(task, { sessionId: "direct-tail-limit" });
    const lines = Array.from({ length: 2_002 }, (_, index) => `line-${index + 1}`);
    writeDirectOut(session.sessionId, `${lines.join("\n")}\n`);
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session])));

    const res = await app.request(`/api/session/${session.sessionId}/live?taskId=${task.id}&tail=999999`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionLiveResponse;
    expect(body.truncated).toBe(true);
    expect(body.text).toContain("…2行省略…");
    expect(body.text).not.toContain("line-1\n");
    expect(body.text).toContain("line-3\n");
    expect(body.text).toContain("line-2002\n");
  });

  it("ファイル不在・taskId 不正・パストラバーサル形 sessionId は 404", async () => {
    const task = makeTask({ title: "拒否対象" });
    const missing = directSession(task, { sessionId: "direct-missing-file" });
    const traversal = directSession(task, { sessionId: "../../etc/passwd" });
    const app = buildApp(buildDeps(new FakeReadView([task], {}, {}, {}, {}, [missing, traversal])));

    const missingFile = await app.request(`/api/session/${missing.sessionId}/live?taskId=${task.id}`);
    const invalidTask = await app.request(
      `/api/session/${missing.sessionId}/live?taskId=${encodeURIComponent("../../etc/passwd")}`,
    );
    const traversalRes = await app.request(
      `/api/session/${encodeURIComponent(traversal.sessionId)}/live?taskId=${task.id}`,
    );

    expect(missingFile.status).toBe(404);
    expect(invalidTask.status).toBe(404);
    expect(traversalRes.status).toBe(404);
  });
});

// ---------- ネイティブ transcript（走行中でも辿れる生 JSONL） ----------

describe("GET /api/session/:sessionId/transcript-raw", () => {
  let nativeLogRoot: string;
  let claudeProjectsRoot: string;
  let codexSessionsRoot: string;

  beforeEach(() => {
    nativeLogRoot = mkdtempSync(join(tmpdir(), "hachi-transcript-raw-"));
    claudeProjectsRoot = join(nativeLogRoot, "claude-projects");
    codexSessionsRoot = join(nativeLogRoot, "codex-sessions");
  });

  afterEach(() => {
    rmSync(nativeLogRoot, { recursive: true, force: true });
  });

  function nativeLogRoots(): WebDeps["nativeLogRoots"] {
    return { claudeProjectsRoot, codexSessionsRoot };
  }

  function bridgeRawSession(task: TaskRow, overrides: Partial<RunningSession> = {}): RunningSession {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "bridge",
      sessionId: "bridge-raw-1",
      serverUrl: tempHome.env.bridges.claude.url,
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
      ...overrides,
    };
  }

  function directRawSession(task: TaskRow, overrides: Partial<RunningSession> = {}): RunningSession {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tenant: task.tenant,
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "direct",
      sessionId: "direct-raw-1",
      serverUrl: "direct",
      startedAt: task.createdAt,
      state: "running",
      role: "worker",
      effort: null,
      effortDelivery: null,
      ...overrides,
    };
  }

  function writeClaudeProjectJsonl(sessionId: string, rows: readonly unknown[]): void {
    const dir = join(claudeProjectsRoot, "-Users-someone-worktrees-example");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  }

  function writeCodexRollout(sessionId: string, rows: readonly unknown[]): void {
    const dayDir = join(codexSessionsRoot, "2026", "08", "21");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, `rollout-2026-08-21T10-00-00-${sessionId}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
  }

  function directStateDir(): string {
    const dir = join(tempHome.env.home, "state", "direct-sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeDirectState(sessionId: string, state: Record<string, unknown>): void {
    writeFileSync(join(directStateDir(), `${sessionId}.json`), JSON.stringify(state), "utf8");
  }

  it.each([
    { direction: "after", query: "&after=0", forward: true },
    { direction: "before", query: "&before=51", forward: false },
    { direction: "tail", query: "", forward: false },
  ])(
    "R1: $direction はmulti-byte JSON envelopeを8MiB以下に保ち連続cursorにgapを作らない",
    async ({ query, forward }) => {
      const task = makeTask({ title: "response budget 反例" });
      const session = bridgeRawSession(task, { sessionId: `bridge-raw-budget-${forward ? "after" : query === "" ? "tail" : "before"}` });
      const rows = Array.from({ length: 50 }, (_, index) => ({
        type: "assistant",
        message: { content: `${index + 1}:${"界".repeat(70_000)}` },
      }));
      writeClaudeProjectJsonl(session.sessionId, rows);
      const app = buildApp(
        buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
      );
      const base = `/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}&limit=1000`;

      const res = await app.request(`${base}${query}`);
      const serialized = await res.text();
      const body = JSON.parse(serialized) as SessionTranscriptRawResponse;

      expect(res.status).toBe(200);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(body.found).toBe(true);
      if (!body.found) throw new Error("unreachable");
      expect(body.limitedBy).toContain("response-bytes");
      expect(body.entries.length).toBeGreaterThan(0);
      expect(body.entries.length).toBeLessThan(rows.length);

      if (forward) {
        expect(body.startLine).toBe(1);
        expect(body.entries[0]?.line).toBe(1);
        expect(body.entries[body.entries.length - 1]?.line).toBe(body.endLine);
        expect(body.hasMoreAfter).toBe(true);
        const next = (await (await app.request(`${base}&after=${body.endLine}`)).json()) as SessionTranscriptRawResponse;
        if (!next.found) throw new Error("unreachable");
        expect(next.entries[0]?.line).toBe(body.endLine + 1);
      } else {
        expect(body.endLine).toBe(rows.length);
        expect(body.entries[0]?.line).toBe(body.startLine);
        expect(body.entries[body.entries.length - 1]?.line).toBe(rows.length);
        expect(body.hasMoreBefore).toBe(true);
        const older = (await (await app.request(`${base}&before=${body.startLine}`)).json()) as SessionTranscriptRawResponse;
        if (!older.found) throw new Error("unreachable");
        expect(older.endLine).toBe(body.startLine - 1);
      }
    },
  );

  it("走行中でも読める: bridge session の claude project jsonl を artifact 無しで返す", async () => {
    const task = makeTask({ title: "走行中閲覧" });
    const session = bridgeRawSession(task);
    writeClaudeProjectJsonl(session.sessionId, [
      { type: "user", timestamp: "2026-08-21T00:00:00Z", message: { content: "hello" } },
      { type: "assistant", timestamp: "2026-08-21T00:00:01Z", message: { content: [{ type: "text", text: "hi" }] } },
    ]);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    expect(body.totalLines).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ line: 1, kind: "user", unparsed: false });
    expect(body.entries[1]).toMatchObject({ line: 2, kind: "assistant", unparsed: false });
    expect(body.entries[1]?.text).toContain("hi");
  });

  it("ページングが効き全文を返さない", async () => {
    const task = makeTask({ title: "ページング対象" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-paging" });
    const rows = Array.from({ length: 700 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      message: { content: `line-${index + 1}` },
    }));
    writeClaudeProjectJsonl(session.sessionId, rows);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    expect(body.totalLines).toBe(700);
    expect(body.entries.length).toBeLessThan(body.totalLines);
    expect(body.entries.length).toBeLessThanOrEqual(200);
  });

  it("before を繰り返すと先頭行まで遡れる（hasMoreBefore が最終的に false）", async () => {
    const task = makeTask({ title: "遡り対象" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-before" });
    const rows = Array.from({ length: 250 }, (_, index) => ({ type: "user", message: { content: `line-${index + 1}` } }));
    writeClaudeProjectJsonl(session.sessionId, rows);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    let res = await app.request(`/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}&limit=100`);
    let body = (await res.json()) as SessionTranscriptRawResponse;
    if (!body.found) throw new Error("unreachable");
    expect(body.startLine).toBe(151);
    expect(body.hasMoreBefore).toBe(true);

    let cursor = body.startLine;
    let guard = 0;
    while (body.found && body.hasMoreBefore && guard < 10) {
      res = await app.request(
        `/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}&limit=100&before=${cursor}`,
      );
      body = (await res.json()) as SessionTranscriptRawResponse;
      if (!body.found) throw new Error("unreachable");
      cursor = body.startLine;
      guard += 1;
    }

    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    expect(body.startLine).toBe(1);
    expect(body.hasMoreBefore).toBe(false);
  });

  it("redaction が効く", async () => {
    const task = makeTask({ title: "redaction 対象" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-redact" });
    writeClaudeProjectJsonl(session.sessionId, [
      { type: "user", message: { content: "Authorization: Bearer sk-transcriptrawsecret1234567890" } },
    ]);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    const text = body.entries[0]?.text ?? "";
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-transcriptrawsecret1234567890");
  });

  it("direct-claude: board sessionId とは異なる nativeSessionId 経由で解決する", async () => {
    const task = makeTask({ title: "direct claude 対象" });
    const boardSessionId = "direct-claude-raw-1";
    const nativeSessionId = "22222222-3333-4444-5555-666677778888";
    const session = directRawSession(task, { sessionId: boardSessionId, provider: "claude" });
    // board sessionId 名のファイルにはあえて別内容を用意し、混同していないことを確認する。
    writeClaudeProjectJsonl(boardSessionId, [{ type: "assistant", message: { content: [{ type: "text", text: "WRONG board-named file" }] } }]);
    writeClaudeProjectJsonl(nativeSessionId, [
      { type: "assistant", message: { content: [{ type: "text", text: "correct native session content" }] } },
    ]);
    writeDirectState(boardSessionId, {
      pid: 1234,
      taskId: task.id,
      outFile: join(tempHome.env.home, "state", "direct-sessions", `${boardSessionId}.out`),
      exitFile: join(tempHome.env.home, "state", "direct-sessions", `${boardSessionId}.exit`),
      model: "claude-sonnet-5",
      startedAt: task.createdAt,
      nativeSessionId,
    });
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${boardSessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    expect(body.entries[0]?.text).toContain("correct native session content");
    expect(body.entries[0]?.text).not.toContain("WRONG board-named file");
  });

  it("direct-codex: .out ヘッダの session id から rollout を解決する", async () => {
    const task = makeTask({ title: "direct codex 対象" });
    const boardSessionId = "direct-codex-raw-1";
    const codexSessionId = "99999999-8888-7777-6666-555544443333";
    const session = directRawSession(task, { sessionId: boardSessionId, provider: "codex", model: "gpt-5.4" });
    const stateDir = directStateDir();
    const outFile = join(stateDir, `${boardSessionId}.out`);
    writeFileSync(outFile, `session id: ${codexSessionId}\nsome output...\n`, "utf8");
    writeDirectState(boardSessionId, {
      pid: 1234,
      taskId: task.id,
      outFile,
      exitFile: join(stateDir, `${boardSessionId}.exit`),
      model: "gpt-5.4",
      startedAt: task.createdAt,
    });
    writeCodexRollout(codexSessionId, [
      { type: "event_msg", timestamp: "2026-08-21T00:00:00Z", payload: { type: "agent_message", message: "codex hello" } },
    ]);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${boardSessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(true);
    if (!body.found) throw new Error("unreachable");
    expect(body.entries[0]).toMatchObject({ kind: "assistant" });
    expect(body.entries[0]?.text).toContain("codex hello");
  });

  it("見つからない場合は 404 ではなく 200 + found:false + reason を返す", async () => {
    const task = makeTask({ title: "見つからない対象" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-missing" });
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(`/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(false);
    if (body.found) throw new Error("unreachable");
    expect(body.reason).toBe("log-not-found");
    expect(body.reasonText.length).toBeGreaterThan(0);
  });

  it("limit の境界: 1000 は成功し、1001 と 0 は 400 で拒否する（契約 §28.6-4）", async () => {
    const task = makeTask({ title: "limit 境界" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-limit" });
    writeClaudeProjectJsonl(session.sessionId, [{ type: "user", message: { content: "x" } }]);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const base = `/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}`;

    expect((await app.request(`${base}&limit=1`)).status).toBe(200);
    expect((await app.request(`${base}&limit=1000`)).status).toBe(200);
    expect((await app.request(`${base}&limit=1001`)).status).toBe(400);
    expect((await app.request(`${base}&limit=0`)).status).toBe(400);
    expect((await app.request(`${base}&limit=-1`)).status).toBe(400);
    expect((await app.request(`${base}&limit=abc`)).status).toBe(400);
    // 未指定は既定値（200 行）で成功する。
    expect((await app.request(base)).status).toBe(200);
  });

  it("before=0 は 400 で拒否する", async () => {
    const task = makeTask({ title: "before 境界" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-before-zero" });
    writeClaudeProjectJsonl(session.sessionId, [{ type: "user", message: { content: "x" } }]);
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    const res = await app.request(
      `/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}&before=0`,
    );

    expect(res.status).toBe(400);
  });

  it("traversal 形の sessionId は境界外の .jsonl を返さず session-id-invalid で拒否する（契約 §28.6-2）", async () => {
    const task = makeTask({ title: "traversal 対象" });
    // claudeProjectsRoot の外側に実ファイルを置く。修正前は `../../outside/secret` で読み出せた。
    const outsideDir = join(nativeLogRoot, "outside");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, "secret.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: "TOP SECRET OUTSIDE ROOT" } })}\n`,
      "utf8",
    );
    // findClaudeSessionDir が走査するプロジェクトディレクトリを1つ用意する。
    mkdirSync(join(claudeProjectsRoot, "-Users-someone-worktrees-example"), { recursive: true });

    const boardSessionId = "../../outside/secret";
    const session = bridgeRawSession(task, { sessionId: boardSessionId });
    const app = buildApp(
      buildDeps(new FakeReadView([task], {}, {}, {}, {}, [session]), undefined, undefined, undefined, undefined, undefined, nativeLogRoots()),
    );

    // 外部からの実際の攻撃経路は percent-encode 済みの形（c.req.param が復号する）。
    const res = await app.request(
      `/api/session/${encodeURIComponent(boardSessionId)}/transcript-raw?taskId=${task.id}`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTranscriptRawResponse;
    expect(body.found).toBe(false);
    if (body.found) throw new Error("unreachable");
    // 「見つからない」ではなく明示的な拒否として区別する。
    expect(body.reason).toBe("session-id-invalid");
    expect(JSON.stringify(body)).not.toContain("TOP SECRET OUTSIDE ROOT");
  });

  it("after と before の同時指定・不正な taskId・session/task 不一致は正しく弾く", async () => {
    const task = makeTask({ title: "バリデーション対象" });
    const otherTask = makeTask({ title: "別タスク" });
    const session = bridgeRawSession(task, { sessionId: "bridge-raw-validate" });
    writeClaudeProjectJsonl(session.sessionId, [{ type: "user", message: { content: "x" } }]);
    const app = buildApp(
      buildDeps(
        new FakeReadView([task, otherTask], {}, {}, {}, {}, [session]),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        nativeLogRoots(),
      ),
    );

    const both = await app.request(
      `/api/session/${session.sessionId}/transcript-raw?taskId=${task.id}&after=1&before=2`,
    );
    expect(both.status).toBe(400);

    const invalidTaskId = await app.request(
      `/api/session/${session.sessionId}/transcript-raw?taskId=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(invalidTaskId.status).toBe(404);

    const mismatchedTask = await app.request(
      `/api/session/${session.sessionId}/transcript-raw?taskId=${otherTask.id}`,
    );
    expect(mismatchedTask.status).toBe(404);
  });
});

// ---------- セッション live proxy ----------

describe("GET /api/session/:sessionId/messages", () => {
  let bridge: MockBridgeServer | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  async function launchMockSession(server: MockBridgeServer, token: string): Promise<string> {
    const res = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hello", provider: "codex", cwd: "/tmp/hk-sessions" }),
    });
    const body = (await res.json()) as { sessionId?: string };
    if (typeof body.sessionId !== "string") {
      throw new Error("mock session 起動に失敗しました");
    }
    return body.sessionId;
  }

  it("server 側で token を読み Authorization を付与して /api/messages をプロキシする", async () => {
    const token = "web-proxy-token";
    bridge = new MockBridgeServer({ token, provider: "codex" });
    await bridge.start();
    writeFileSync(tempHome.env.bridges.codex.tokenFile, `${token}\n`, { mode: 0o600 });
    const bridges = {
      ...tempHome.env.bridges,
      codex: { ...tempHome.env.bridges.codex, url: bridge.url },
    };
    const sessionId = await launchMockSession(bridge, token);
    bridge.completeSession(sessionId, "done");
    const app = buildApp(buildDeps(new FakeReadView([]), undefined, bridges));

    const res = await app.request(
      `/api/session/${encodeURIComponent(sessionId)}/messages?provider=codex&server=${encodeURIComponent(
        bridge.url,
      )}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionMessagesResponse;
    expect(body.messages.some((entry) => entry.type === "result")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(bridge.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/api/messages",
      hasAuthorizationHeader: true,
    });
  });

  it("server が既知 bridge URL と完全一致しない場合は SSRF 防止で拒否する", async () => {
    bridge = new MockBridgeServer({ token: "unused", provider: "codex" });
    await bridge.start();
    const bridges = {
      ...tempHome.env.bridges,
      codex: { ...tempHome.env.bridges.codex, url: bridge.url },
    };
    const app = buildApp(buildDeps(new FakeReadView([]), undefined, bridges));

    const res = await app.request(
      `/api/session/sess-x/messages?provider=codex&server=${encodeURIComponent("http://127.0.0.1:1")}`,
    );
    expect(res.status).toBe(400);
    expect(bridge.requests).toHaveLength(0);
  });

  it("既知 bridge URL でも loopback 以外は opt-in 無しで拒否し token を送らない", async () => {
    const previousAllowRemote = process.env.HACHI_BRIDGE_ALLOW_REMOTE;
    delete process.env.HACHI_BRIDGE_ALLOW_REMOTE;
    const secretToken = "remote-bridge-secret-token";
    writeFileSync(tempHome.env.bridges.codex.tokenFile, `${secretToken}\n`, { mode: 0o600 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called"));
    const remoteServer = "http://example.com";
    const bridges = {
      ...tempHome.env.bridges,
      codex: { ...tempHome.env.bridges.codex, url: remoteServer },
    };
    const app = buildApp(buildDeps(new FakeReadView([]), undefined, bridges));

    try {
      const res = await app.request(
        `/api/session/sess-remote/messages?provider=codex&server=${encodeURIComponent(remoteServer)}`,
      );
      expect(res.status).toBe(502);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain(secretToken);
    } finally {
      if (previousAllowRemote === undefined) {
        delete process.env.HACHI_BRIDGE_ALLOW_REMOTE;
      } else {
        process.env.HACHI_BRIDGE_ALLOW_REMOTE = previousAllowRemote;
      }
    }
  });

  it("server=direct はライブ閲覧非対応として 501 を返し、bridge へ接続しない", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await app.request("/api/session/direct-abc/messages?provider=codex&server=direct");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("live-view-unsupported");
    expect(body.message).toContain("direct transport");
  });
});

// ---------- タスク詳細 API ----------

describe("GET /api/task/:id", () => {
  it("存在しない task id は 404", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/task/t_missing");
    expect(res.status).toBe(404);
  });

  it("形状不一致の task id（エンコード済み ../ 含む）は 404", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request(`/api/task/${encodeURIComponent("../../etc/passwd")}`);
    expect(res.status).toBe(404);
  });

  it("artifactDetails に stat と attach event/run の帰属を返す", async () => {
    const task = makeTask();
    const run: RunRow = {
      id: 42,
      taskId: task.id,
      provider: "codex",
      sessionId: "artifact-session",
      status: "running",
      meta: '{"role":"rework"}',
      startedAt: task.createdAt - 10,
      endedAt: null,
    };
    const event: EventRow = {
      id: 1,
      taskId: task.id,
      eventType: "artifact_attached",
      actor: "worker",
      payload: JSON.stringify({ name: "evidence.png", sizeBytes: 3, runId: run.id, sessionId: run.sessionId }),
      provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
      createdAt: task.createdAt,
    };
    const dir = join(tempHome.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evidence.png"), "png");
    const view = new FakeReadView([task], {}, { [task.id]: [event] }, { [task.id]: [run] });

    const res = await buildApp(buildDeps(view)).request(`/api/task/${task.id}`);
    const body = (await res.json()) as TaskDetailResponse;

    expect(res.status).toBe(200);
    expect(body.artifacts).toEqual(["evidence.png"]);
    expect(body.artifactDetails).toEqual([{
      name: "evidence.png",
      kind: "image",
      sizeBytes: 3,
      attachedAt: task.createdAt,
      attachedAtSource: "event",
      runId: 42,
      sessionId: "artifact-session",
      role: "rework",
      attributionSource: "event-run",
    }]);
  });

  it("task 全項目・コメント・イベント・runs・親子リンクを返す", async () => {
    const parent = makeTask({ title: "親タスク" });
    const child = makeTask({ title: "子タスク" });
    const prerequisite = makeTask({ title: "前提タスク", status: "ready" });
    const task = makeTask({
      title: "詳細対象タスク",
      status: "blocked",
      blockReason: "user-decision: 確認してください",
      assignee: "human",
      provider: "codex",
      profile: "implement",
      modelOverride: "gpt-5.4",
    });

    const comments: CommentRow[] = [
      {
        id: 1,
        taskId: task.id,
        author: "worker",
        body: "作業を開始しました",
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: task.createdAt,
      },
    ];
    const events: EventRow[] = [
      {
        id: 1,
        taskId: task.id,
        eventType: "status_changed",
        actor: "supervisor",
        payload: '{"to":"blocked"}',
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: task.createdAt,
      },
      {
        id: 2,
        taskId: task.id,
        eventType: "model_transport_compatibility_unknown",
        actor: "supervisor",
        payload: JSON.stringify({
          status: "unknown",
          reason: "capability-probe-failed",
          detail: "Authorization: Bearer sk-1234567890 /Users/private/Application Support/runtime-token",
          observed: null,
        }),
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: task.createdAt,
      },
    ];
    const runs: RunRow[] = [
      {
        id: 1,
        taskId: task.id,
        provider: "codex",
        sessionId: "session-123",
        status: "running",
        meta: '{"model":"gpt-5.4","modelDelivery":"none","lastResult":{"costUsd":0.42,"inputTokens":1200,"outputTokens":340,"durationMs":56000}}',
        startedAt: task.createdAt,
        endedAt: null,
      },
    ];
    const links: Record<string, { parents: LinkRow[]; children: LinkRow[] }> = {
      [task.id]: {
        parents: [
          { id: 1, parentId: parent.id, childId: task.id, linkType: "subtask", createdAt: task.createdAt },
          {
            id: 3,
            parentId: prerequisite.id,
            childId: task.id,
            linkType: "depends-on",
            createdAt: task.createdAt,
          },
        ],
        children: [{ id: 2, parentId: task.id, childId: child.id, linkType: "subtask", createdAt: task.createdAt }],
      },
    };

    const view = new FakeReadView(
      [task, parent, child, prerequisite],
      { [task.id]: comments },
      { [task.id]: events },
      { [task.id]: runs },
      links,
    );
    const app = buildApp(buildDeps(view));

    const res = await app.request(`/api/task/${task.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskDetailResponse;

    expect(body.task.title).toBe("詳細対象タスク");
    expect(body.task.blockReason).toBe("user-decision: 確認してください");
    expect(body.task.modelOverride).toBe("gpt-5.4");
    expect(body.comments[0]?.body).toBe("作業を開始しました");
    expect(body.events[0]?.eventType).toBe("status_changed");
    expect(body.events[1]?.payload).toContain("[REDACTED]");
    expect(body.events[1]?.payload).not.toContain("Application Support");
    expect(body.events[1]?.payload).not.toContain("sk-1234567890");
    expect(body.events[1]?.payload).not.toContain("/Users/private/Application Support/runtime-token");
    expect(body.events[1]?.payload).not.toContain("Support/runtime-token");
    expect(body.runs[0]?.sessionId).toBe("session-123");
    const lastResult = (JSON.parse(body.runs[0]?.meta ?? "{}") as { lastResult?: Record<string, number> })
      .lastResult;
    expect(lastResult?.costUsd).toBe(0.42);
    expect(lastResult?.inputTokens).toBe(1200);
    expect(lastResult?.outputTokens).toBe(340);
    expect(lastResult?.durationMs).toBe(56000);
    expect(body.links.parents[0]?.title).toBe("親タスク");
    expect(body.links.children[0]?.title).toBe("子タスク");
    expect(body.links.parents[0]?.link.parentId).toBe(parent.id);
    expect(body.links.children[0]?.link.childId).toBe(child.id);
    expect(body.dependencies).toEqual([
      { id: prerequisite.id, title: "前提タスク", status: "ready" },
    ]);
    expect(body.orchestratorRequest).toBeNull();
    expect(body.orchestratorBindings).toEqual([]);
  });

  it("cancel lifecycleをnonceなし・tri-state・redaction済みで詳細APIへ返す", async () => {
    const task = makeTask({ title: "cancel可視化" });
    const requests = [
      makeCancelRequest(task.id, {
        id: "rc_z_random",
        reason: "token sk-proj-12345678901234567890 を含む理由",
        capabilitySnapshot: JSON.stringify({
          protocol: "session-stop-v1",
          detail: "Authorization: Bearer secret-value /Users/private/runtime-token",
        }),
        stopEvidence: "{}",
      }),
      makeCancelRequest(task.id, {
        id: "rc_a_random",
        status: "stopped",
        requestNonce: "second-secret-nonce",
        acknowledgedNonce: "second-secret-nonce",
        cancelFence: 3,
        stopEvidence: JSON.stringify({
          source: "forced",
          observedSessionState: "ended",
          resultWatermark: 1,
          lastEntryId: 42,
          stopState: "stopped",
          evidenceId: "stop-42",
          childProcessTreeCovered: true,
        }),
        resolvedAt: 1_700_000_090,
      }),
      makeCancelRequest(task.id, {
        id: "rc_m_random",
        status: "stopped",
        requestNonce: "third-secret-nonce",
        cancelFence: 2,
        stopEvidence: JSON.stringify({ sessionState: "ended", evidenceId: "not-exact" }),
      }),
    ];
    const cancelEvents: EventRow[] = [{
      id: 10,
      taskId: task.id,
      eventType: "cancel_failed",
      actor: "supervisor",
      payload: JSON.stringify({
        nested: { values: [
          "Authorization: Bearer event-secret",
          "/Users/private/Application Support/cancel/event-token suffix",
        ] },
      }),
      provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
      createdAt: task.createdAt,
    }];
    const view = new FakeReadView(
      [task], {}, { [task.id]: cancelEvents }, {}, {}, [], [], [], [], { [task.id]: requests },
    );
    const response = await buildApp(buildDeps(view)).request(`/api/task/${task.id}`);
    const raw = await response.text();
    const body = JSON.parse(raw) as TaskDetailResponse;

    expect(response.status).toBe(200);
    expect(body.cancelRequests.map((request) => request.cancelFence)).toEqual([3, 2, 1]);
    expect(body.cancelRequests[2]).toMatchObject({
      status: "cooperative_sent",
      delivered: "unknown",
      observed: "unknown",
      acknowledged: "no",
      stopped: "no",
    });
    expect(body.cancelRequests[0]).toMatchObject({
      status: "stopped",
      delivered: "yes",
      observed: "yes",
      acknowledged: "yes",
      stopped: "yes",
    });
    expect(body.cancelRequests[0]?.stopEvidence).toContain("stop-42");
    expect(body.cancelRequests[1]).toMatchObject({ status: "stopped", stopped: "unknown" });
    expect(body.events[0]?.payload).toContain("[REDACTED]");
    expect(body.events[0]?.payload).toContain("[REDACTED_PATH]");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("[REDACTED_PATH]");
    expect(raw).not.toContain("secret-request-nonce");
    expect(raw).not.toContain("second-secret-nonce");
    expect(raw).not.toContain("third-secret-nonce");
    expect(raw).not.toContain("secret-value");
    expect(raw).not.toContain("event-secret");
    expect(raw).not.toContain("runtime-token");
  });

  it("durable steer read modelをboard/detailへ同じstatusとtargetのまま返す", async () => {
    const task = makeTask({ title: "steer可視化", tenant: "tenant-a", status: "ready" });
    const otherTask = makeTask({ title: "別tenant", tenant: "tenant-b", status: "ready" });
    const deliveries = [
      makeSteerDelivery(task.id),
      makeSteerDelivery(task.id, {
        id: "sd_web_steer_2",
        sequence: 2,
        status: "acknowledged",
        observedMessageId: "message-ack",
        observedAt: 1_700_000_020,
        acknowledgedAt: 1_700_000_030,
        resolvedAt: 1_700_000_030,
        targetState: "stale_run",
        currentRunId: 43,
        currentSessionId: "replacement-session",
      }),
      makeSteerDelivery(otherTask.id, {
        id: "sd_web_other",
        status: "uncertain",
      }),
    ];
    const view = new FakeReadView(
      [task, otherTask], {}, {}, {}, {}, [], [], [], [], {}, deliveries,
    );
    const app = buildApp(buildDeps(view));

    const boardResponse = await app.request("/api/board?tenant=tenant-a");
    const boardRaw = await boardResponse.text();
    const board = JSON.parse(boardRaw) as BoardResponse;
    expect(board.steerDeliveriesByTask[task.id]?.map((delivery) => delivery.status)).toEqual([
      "transport_accepted",
      "acknowledged",
    ]);
    expect(board.steerDeliveriesByTask[task.id]?.[1]).toMatchObject({
      targetState: "stale_run",
      currentRunId: 43,
      currentSessionId: "replacement-session",
    });
    expect(board.steerDeliveriesByTask[otherTask.id]).toBeUndefined();
    expect(boardRaw).not.toContain("applied");

    const detailResponse = await app.request(`/api/task/${task.id}`);
    const detailRaw = await detailResponse.text();
    const detail = JSON.parse(detailRaw) as TaskDetailResponse;
    expect(detail.steerDeliveries).toEqual(board.steerDeliveriesByTask[task.id]);
    expect(detailRaw).not.toContain("applied");
  });

  it("active orchestrator requestとtask bindingを詳細APIへ返す", async () => {
    const store = new SqliteKanbanStore(":memory:");
    try {
      const task = store.createTask(
        { title: "routing対象", body: "cwd: /tmp", tenant: "dev", status: "ready" },
        "tester",
      );
      store.block(task.id, "worker-question: 方針を確認してください", "supervisor");
      const orchestrator = store.registerOrchestrator({ label: "web-owner", project: "dev", repoCommonDir: "" });
      store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
      const request = store.createOrGetOrchestratorRequest({
        taskId: task.id,
        questionId: "q_web_detail",
        question: "方針を確認してください",
      });
      const view = new FakeReadView([store.getTask(task.id)!]);
      const app = buildApp(buildDeps(view, undefined, undefined, store));

      const res = await app.request(`/api/task/${task.id}`);
      const body = (await res.json()) as TaskDetailResponse;

      expect(body.orchestratorRequest).toMatchObject({ id: request.id, status: "queued" });
      expect(body.orchestratorBindings).toEqual([
        expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
      ]);
    } finally {
      store.close();
    }
  });

  it("agent.message.v1 フェンスドブロックを comment.id をキーにパースして返す", async () => {
    const task = makeTask({ title: "メッセージ対象タスク" });
    const messageBody = [
      "作業完了報告です",
      "",
      "```agent-message-v1",
      JSON.stringify({
        schema: "agent.message.v1",
        from: { role: "worker", provider: "codex", sessionId: "sess-1" },
        to: { role: "orchestrator", taskId: task.id },
        intent: "escalate",
        payload: { question: "どちらを優先しますか" },
        idempotencyKey: "idem-1",
        createdAt: 1700000000,
      }),
      "```",
    ].join("\n");

    const comments: CommentRow[] = [
      {
        id: 1,
        taskId: task.id,
        author: "worker",
        body: messageBody,
        provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
        createdAt: task.createdAt,
      },
    ];
    const view = new FakeReadView([task], { [task.id]: comments });
    const app = buildApp(buildDeps(view));

    const res = await app.request(`/api/task/${task.id}`);
    const body = (await res.json()) as TaskDetailResponse;

    expect(body.messages[1]?.messages[0]?.intent).toBe("escalate");
    expect(body.messages[1]?.messages[0]?.from.role).toBe("worker");
    expect(body.messages[1]?.messages[0]?.to.role).toBe("orchestrator");
    expect(body.messages[1]?.messages[0]?.idempotencyKey).toBe("idem-1");
    expect(body.messages[1]?.errors).toHaveLength(0);
  });
});

// ---------- ウォッチフラグ write API（docs/contract.md §46.3） ----------

describe("POST/DELETE /api/tasks/:id/watch", () => {
  it("Authorization 欠落は 401 で拒否し、watched を変更しない", async () => {
    const tasks = [makeTask({ watched: false })];
    const store = new FakeScheduleStore([], tasks);
    const app = buildApp(buildDeps(new FakeReadView(tasks), undefined, undefined, store));

    const res = await app.request(`/api/tasks/${tasks[0]?.id ?? ""}/watch`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(res.status).toBe(401);
    expect(tasks[0]?.watched).toBe(false);
  });

  it("存在しない task id と形状不正 id は 404", async () => {
    const tasks = [makeTask()];
    const store = new FakeScheduleStore([], tasks);
    const app = buildApp(buildDeps(new FakeReadView(tasks), undefined, undefined, store));

    const missing = await app.request("/api/tasks/t_99999999/watch", {
      method: "POST",
      headers: withWriteAuth({ "sec-fetch-site": "same-origin" }),
    });
    expect(missing.status).toBe(404);

    const invalid = await app.request(`/api/tasks/${encodeURIComponent("../../etc/passwd")}/watch`, {
      method: "POST",
      headers: withWriteAuth({ "sec-fetch-site": "same-origin" }),
    });
    expect(invalid.status).toBe(404);
  });

  it("POST で watch、DELETE で unwatch する", async () => {
    const tasks = [makeTask({ watched: false })];
    const store = new FakeScheduleStore([], tasks);
    const app = buildApp(buildDeps(new FakeReadView(tasks), undefined, undefined, store));
    const id = tasks[0]?.id ?? "";

    const watchedRes = await app.request(`/api/tasks/${id}/watch`, {
      method: "POST",
      headers: withWriteAuth({ "sec-fetch-site": "same-origin" }),
    });
    expect(watchedRes.status).toBe(200);
    const watchedBody = (await watchedRes.json()) as { task: TaskRow };
    expect(watchedBody.task.watched).toBe(true);
    expect(tasks[0]?.watched).toBe(true);

    const clearedRes = await app.request(`/api/tasks/${id}/watch`, {
      method: "DELETE",
      headers: withWriteAuth({ "sec-fetch-site": "same-origin" }),
    });
    expect(clearedRes.status).toBe(200);
    const clearedBody = (await clearedRes.json()) as { task: TaskRow };
    expect(clearedBody.task.watched).toBe(false);
    expect(tasks[0]?.watched).toBe(false);
  });
});

// ---------- artifact 表示 ----------

describe("GET /task/:id/artifact/:name", () => {
  it("画像 artifact を Content-Type + nosniff 付きのバイナリで返す（docs/contract.md §32.2）", async () => {
    const task = makeTask({ title: "artifact 対象タスク" });
    const dir = `${tempHome.env.artifactsDir}/${task.id}`;
    mkdirSync(dir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(`${dir}/screen.png`, pngBytes);

    const app = buildApp(buildDeps(new FakeReadView([task])));
    const res = await app.request(`/task/${task.id}/artifact/screen.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes);
  });

  it("存在する artifact を redact 済みで text/plain 表示する", async () => {
    const task = makeTask({ title: "artifact 対象タスク" });
    const dir = `${tempHome.env.artifactsDir}/${task.id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/transcript-session-1.txt`,
      "[user] hello\n[assistant] Authorization: Bearer sk-verysecrettoken1234567890\n",
    );

    const app = buildApp(buildDeps(new FakeReadView([task])));
    const res = await app.request(`/task/${task.id}/artifact/transcript-session-1.txt`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[user] hello");
    expect(text).not.toContain("sk-verysecrettoken1234567890");
    expect(text).toContain("[REDACTED]");
  });

  it("形状不一致の task id（パストラバーサル）は 404", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request(
      `/task/${encodeURIComponent("../../etc/passwd")}/artifact/passwd`,
    );
    expect(res.status).toBe(404);
  });

  it("../ 系の name パストラバーサルは 404（fail-closed）", async () => {
    const task = makeTask({ title: "artifact 対象タスク" });
    mkdirSync(`${tempHome.env.artifactsDir}/${task.id}`, { recursive: true });

    const app = buildApp(buildDeps(new FakeReadView([task])));

    const res1 = await app.request(`/task/${task.id}/artifact/..`);
    expect(res1.status).toBe(404);

    const res2 = await app.request(
      `/task/${task.id}/artifact/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res2.status).toBe(404);
  });
});

// ---------- healthz ----------

describe("GET /healthz", () => {
  it("ok と taskCount を返す", async () => {
    const tasks = [makeTask({ status: "todo" }), makeTask({ status: "done" }), makeTask({ status: "triage" })];
    const app = buildApp(buildDeps(new FakeReadView(tasks)));

    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; taskCount: number };
    expect(body.ok).toBe(true);
    expect(body.taskCount).toBe(3);
  });
});

// ---------- schedules API（docs/contract.md §29.4） ----------

describe("GET /api/schedules", () => {
  it("schedule 一覧に次回発火予定を epoch 秒で付与して返す", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-04T00:00:00+09:00"));
      const schedules = [
        makeSchedule({
          name: "朝会",
          cadenceKind: "daily",
          atHour: 9,
          atMinute: 30,
          tenant: "dev",
        }),
      ];
      const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules)));

      const res = await app.request("/api/schedules");
      expect(res.status).toBe(200);
      const body = (await res.json()) as SchedulesResponse;
      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0]?.name).toBe("朝会");
      expect(body.schedules[0]?.nextFireAt).toBe(
        Math.floor(Date.parse("2026-07-04T09:30:00+09:00") / 1000),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/schedule-options", () => {
  it("ReadView の候補と config profiles を合成して返す", async () => {
    const tasks = [makeTask({ tenant: "dev" }), makeTask({ tenant: "" })];
    const schedules = [makeSchedule({ cwd: "/tmp/hk-scheduler", tenant: "ops" })];
    const app = buildApp(buildDeps(new FakeReadView(tasks, {}, {}, {}, {}, [], schedules)));

    const res = await app.request("/api/schedule-options");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScheduleFormOptionsResponse;
    expect(body.cwds).toEqual(["/tmp/hk-scheduler"]);
    expect(body.tenants).toEqual(["dev", "ops"]);
    expect(body.profiles).toEqual([
      { name: "implement", provider: "codex", model: "gpt-5.6-terra", isDefault: true },
      { name: "review", provider: "codex", model: "gpt-5.6-sol", isDefault: false },
      { name: "docs", provider: "codex", model: "gpt-5.6-luna", isDefault: false },
    ]);
  });
});

describe("POST /api/schedules", () => {
  it("same-origin の作成リクエストを KanbanStore 経由で反映する", async () => {
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({
        name: "週次レビュー",
        cadenceKind: "weekly",
        at: "09:30",
        weekday: 1,
        cwd: "/tmp/hk-scheduler",
        tenant: "dev",
        profile: "review",
        prompt: "レビューしてください",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { schedule: ScheduleWithNextFire };
    expect(body.schedule.id).toMatch(/^s_[0-9a-f]{16}$/);
    expect(body.schedule.cadenceKind).toBe("weekly");
    expect(body.schedule.weekday).toBe(1);
    expect(schedules).toHaveLength(1);
  });

  it("未知 profile は 400 で拒否し、schedule を作らない", async () => {
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({
        name: "bad profile",
        cadenceKind: "daily",
        at: "09:00",
        cwd: "/tmp/hk-scheduler",
        profile: "unknown-profile",
        prompt: "run",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "未知の profile です: unknown-profile" });
    expect(schedules).toHaveLength(0);
  });

  it("cwd が相対パスなら 400 で拒否し、schedule を作らない", async () => {
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({
        name: "bad",
        cadenceKind: "daily",
        at: "09:00",
        cwd: "relative/path",
        prompt: "run",
      }),
    });

    expect(res.status).toBe(400);
    expect(schedules).toHaveLength(0);
  });

  it("Sec-Fetch-Site: cross-site は 403 で拒否する", async () => {
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "cross-site" }),
      body: JSON.stringify({
        name: "blocked",
        cadenceKind: "daily",
        at: "09:00",
        cwd: "/tmp/hk-scheduler",
        prompt: "run",
      }),
    });

    expect(res.status).toBe(403);
    expect(schedules).toHaveLength(0);
  });

  it("Sec-Fetch-Site 未送信でも token が正しければ作成を許可する", async () => {
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "curl compatible",
        cadenceKind: "daily",
        at: "09:00",
        cwd: "/tmp/hk-scheduler",
        prompt: "run",
      }),
    });

    expect(res.status).toBe(201);
    expect(schedules).toHaveLength(1);
  });

  it("Authorization 欠落/不一致は 401 で拒否し、token をレスポンスへ含めない", async () => {
    const secretWriteToken = "secret-web-token-value";
    const schedules: ScheduleRow[] = [];
    const store = new FakeScheduleStore(schedules);
    const deps = buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store);
    deps.writeToken = secretWriteToken;
    const app = buildApp(deps);

    const requestBody = {
      name: "blocked",
      cadenceKind: "daily",
      at: "09:00",
      cwd: "/tmp/hk-scheduler",
      prompt: "run",
    };
    const missingAuth = await app.request("/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(requestBody),
    });
    expect(missingAuth.status).toBe(401);
    const missingAuthText = await missingAuth.text();
    expect(missingAuthText).not.toContain(secretWriteToken);

    const wrongAuth = await app.request("/api/schedules", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        authorization: "Bearer wrong-web-token",
      },
      body: JSON.stringify(requestBody),
    });
    expect(wrongAuth.status).toBe(401);
    const wrongAuthText = await wrongAuth.text();
    expect(wrongAuthText).not.toContain(secretWriteToken);
    expect(wrongAuthText).not.toContain("wrong-web-token");
    expect(schedules).toHaveLength(0);
  });
});

describe("PATCH /api/schedules/:id", () => {
  it("enabled トグルと編集を反映する", async () => {
    const schedules = [makeSchedule({ name: "daily", cadenceKind: "daily" })];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));
    const id = schedules[0]?.id ?? "";

    const disabledRes = await app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledRes.status).toBe(200);
    const disabledBody = (await disabledRes.json()) as { schedule: ScheduleWithNextFire };
    expect(disabledBody.schedule.enabled).toBe(false);
    expect(disabledBody.schedule.nextFireAt).toBeNull();

    const editRes = await app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({
        name: "月末処理",
        cadenceKind: "monthly",
        at: "22:15",
        day: 31,
        cwd: "/tmp/hk-scheduler",
        prompt: "月末処理を実行してください",
      }),
    });
    expect(editRes.status).toBe(200);
    const editBody = (await editRes.json()) as { schedule: ScheduleWithNextFire };
    expect(editBody.schedule.name).toBe("月末処理");
    expect(editBody.schedule.cadenceKind).toBe("monthly");
    expect(editBody.schedule.dayOfMonth).toBe(31);
    expect(editBody.schedule.weekday).toBeNull();
  });

  it("未知 profile の編集は 400 で拒否し、既存 schedule を変更しない", async () => {
    const schedules = [makeSchedule({ profile: "implement" })];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));
    const id = schedules[0]?.id ?? "";

    const res = await app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({ profile: "unknown-profile" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "未知の profile です: unknown-profile" });
    expect(schedules[0]?.profile).toBe("implement");
  });

  it("id 形状不正は 404、cadence 必須フィールド欠落は 400", async () => {
    const schedules = [makeSchedule()];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));

    const badId = await app.request("/api/schedules/not-a-schedule", {
      method: "PATCH",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(badId.status).toBe(404);

    const missing = await app.request(`/api/schedules/${schedules[0]?.id ?? ""}`, {
      method: "PATCH",
      headers: withWriteAuth({ "content-type": "application/json", "sec-fetch-site": "same-origin" }),
      body: JSON.stringify({ cadenceKind: "weekly" }),
    });
    expect(missing.status).toBe(400);
  });
});

describe("DELETE /api/schedules/:id", () => {
  it("schedule を削除する", async () => {
    const schedules = [makeSchedule()];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));
    const id = schedules[0]?.id ?? "";

    const res = await app.request(`/api/schedules/${id}`, {
      method: "DELETE",
      headers: withWriteAuth({ "sec-fetch-site": "same-origin" }),
    });

    expect(res.status).toBe(200);
    expect(schedules).toHaveLength(0);
    expect(await res.json()).toEqual({ deleted: true, id });
  });

  it("PATCH/DELETE schedules と supervisor write も Authorization を必須にする", async () => {
    const schedules = [makeSchedule()];
    const store = new FakeScheduleStore(schedules);
    const app = buildApp(buildDeps(new FakeReadView([], {}, {}, {}, {}, [], schedules), undefined, undefined, store));
    const id = schedules[0]?.id ?? "";

    const patchRes = await app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(401);

    const deleteRes = await app.request(`/api/schedules/${id}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(deleteRes.status).toBe(401);

    const supervisorRes = await app.request("/api/supervisor/killswitch", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ stage: "dispatch", disabled: true }),
    });
    expect(supervisorRes.status).toBe(401);
    expect(schedules[0]?.enabled).toBe(true);
    expect(existsSync(join(tempHome.env.home, "dispatch.disabled"))).toBe(false);
  });
});

// ---------- メトリクス API（docs/contract.md §43.2） ----------

describe("GET /api/metrics", () => {
  it("metricsDbPath 未指定時は 503 で degrade する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await app.request("/api/metrics");

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({ error: "メトリクスは未設定です" });
  });

  it("days が不正なら 400、正常なら MetricsResponse を返す", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const metricsStore = new SqliteKanbanStore(tempHome.env.dbPath);
      metricsStore.recordTickMetrics([{ stage: "dispatch", actions: 2, durationMs: 15 }], 1_800_000_000);
      metricsStore.close();
      const app = buildApp(
        buildDeps(new FakeReadView([]), undefined, undefined, undefined, undefined, tempHome.env.dbPath),
      );

      const badRes = await app.request("/api/metrics?days=not-number");
      expect(badRes.status).toBe(400);

      const res = await app.request("/api/metrics?days=7");
      expect(res.status).toBe(200);
      const body = (await res.json()) as MetricsResponse;
      expect(body.period).toEqual({ from: 1_800_000_000 - 7 * 24 * 60 * 60, to: 1_800_000_000 });
      expect(body.tickMetrics).toEqual([{ ts: 1_800_000_000, stage: "dispatch", actions: 2, durationMs: 15 }]);
      expect(body.doneOrigins).toEqual({
        total: 0,
        counts: { gatePassed: 0, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 0 },
        automaticCompletionRate: 0,
        manualRecoveryRate: 0,
        unknownRate: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- usage 集計 API（契約 §14.5.1） ----------

describe("GET /api/usage", () => {
  const measured = (value: number): unknown => ({
    state: "measured",
    value,
    provenance: "cli-native-session-log",
  });
  const ESTIMATED = { state: "estimated", value: 2.5, basis: "price-table", priceTableRef: "litellm@2026-08-01" };

  function usageMeta(costUsd: unknown, inputTokens: number, extra: Record<string, unknown> = {}): unknown {
    return {
      costUsd,
      inputTokens: measured(inputTokens),
      outputTokens: measured(10),
      cacheCreationTokens: measured(0),
      cacheReadTokens: measured(0),
      turns: measured(1),
      durationMs: measured(1000),
      collectedBy: "direct-claude@native-log-v1",
      ...extra,
    };
  }

  /** measured / estimated / 除外 を含む run を temp DB へ差し込み、作成したタスク id を返す。 */
  function seedUsageRuns(dbPath: string): { pricedTaskId: string; unpricedTaskId: string } {
    const store = new SqliteKanbanStore(dbPath);
    try {
      const priced = store.createTask({ title: "価格表内のタスク", body: "", tenant: "dev" }, "tester");
      const unpriced = store.createTask({ title: "価格表外のタスク", body: "", tenant: "tenant-a" }, "tester");
      const workerRun = store.startRun(priced.id, "claude", "s1", { role: "worker", model: "claude-opus-5" });
      store.endRun(workerRun.id, "done", {
        role: "worker",
        model: "claude-opus-5",
        usage: usageMeta(ESTIMATED, 1000),
      });
      const reviewerRun = store.startRun(priced.id, "claude", "s2", { role: "reviewer", model: "claude-sonnet-5" });
      store.endRun(reviewerRun.id, "done", {
        role: "reviewer",
        model: "claude-sonnet-5",
        usage: usageMeta(ESTIMATED, 200),
      });
      const unpricedRun = store.startRun(unpriced.id, "codex", "s3", { role: "worker", model: "gpt-5.6-terra" });
      store.endRun(unpricedRun.id, "done", {
        role: "worker",
        model: "gpt-5.6-terra",
        usage: usageMeta({ state: "unavailable-by-design" }, 50, {
          unpricedModels: ["claude-haiku-4-5-20251001"],
        }),
      });
      return { pricedTaskId: priced.id, unpricedTaskId: unpriced.id };
    } finally {
      store.close();
    }
  }

  it("metricsDbPath 未指定時は 503 で degrade する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await app.request("/api/usage");

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({ error: "usage 集計は未設定です" });
  });

  it("未知の集計軸は 400 にする（既定へ黙って倒さない）", async () => {
    seedUsageRuns(tempHome.env.dbPath);
    const app = buildApp(
      buildDeps(new FakeReadView([]), undefined, undefined, undefined, undefined, tempHome.env.dbPath),
    );

    const res = await app.request("/api/usage?by=nonexistent");

    expect(res.status).toBe(400);
  });

  it("task 軸で worker + reviewer を合算し、推定と実測を別フィールドで返す", async () => {
    const { pricedTaskId, unpricedTaskId } = seedUsageRuns(tempHome.env.dbPath);
    const app = buildApp(
      buildDeps(new FakeReadView([]), undefined, undefined, undefined, undefined, tempHome.env.dbPath),
    );

    const res = await app.request("/api/usage?by=task&days=7");

    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageResponse;
    const priced = body.rows.find((r) => r.key === pricedTaskId);
    expect(priced?.runCount).toBe(2);
    expect(priced?.costUsd.estimated.total).toBeCloseTo(5, 10);
    // cost は常に推定。実測列を 0 で埋めない
    expect(priced?.costUsd.measured.runCount).toBe(0);
    expect(priced?.inputTokens.measured.total).toBe(1200);
    // 価格表に無いモデルを含む run は cost 全体が unavailable-by-design になる
    const unpriced = body.rows.find((r) => r.key === unpricedTaskId);
    expect(unpriced?.costUsd.excluded.unavailableByDesign).toBe(1);
    expect(body.total.unpricedModels).toEqual(["claude-haiku-4-5-20251001"]);
    expect(body.coverage.withUsageRuns).toBe(3);
    expect(body.priceTableRefs).toEqual(["litellm@2026-08-01"]);
    expect(body.priceTableMixed).toBe(false);
  });

  it("model 軸と tenant 絞り込みが効く", async () => {
    const { unpricedTaskId } = seedUsageRuns(tempHome.env.dbPath);
    const app = buildApp(
      buildDeps(new FakeReadView([]), undefined, undefined, undefined, undefined, tempHome.env.dbPath),
    );

    const byModel = (await (await app.request("/api/usage?by=model&days=7")).json()) as UsageResponse;
    expect(byModel.rows.map((r) => r.key).sort()).toEqual(["claude-opus-5", "claude-sonnet-5", "gpt-5.6-terra"]);

    const tenantA = (await (await app.request("/api/usage?by=task&days=7&tenant=tenant-a")).json()) as UsageResponse;
    expect(tenantA.rows.map((r) => r.key)).toEqual([unpricedTaskId]);
  });
});

// ---------- supervisor 状態パネル（docs/contract.md §23） ----------

describe("GET /api/supervisor", () => {
  it("kill-switch ファイルが無ければ全ステージ disabled:false を返す", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/supervisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SupervisorStatus;

    expect(body.stages.map((s) => s.name)).toEqual([...STAGE_NAMES]);
    expect(body.stages.every((s) => s.disabled === false)).toBe(true);
    expect(body.killSwitchDir).toBe(tempHome.env.home);
  });

  it("<home>/<stage>.disabled が存在するステージのみ disabled:true を返す", async () => {
    writeFileSync(join(tempHome.env.home, "notify.disabled"), "", { mode: 0o600 });
    writeFileSync(join(tempHome.env.home, "reap.disabled"), "", { mode: 0o600 });
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await app.request("/api/supervisor");
    const body = (await res.json()) as SupervisorStatus;

    const disabledNames = body.stages.filter((s) => s.disabled).map((s) => s.name);
    expect(disabledNames.sort()).toEqual(["notify", "reap"]);
    expect(body.stages.find((s) => s.name === "dispatch")?.disabled).toBe(false);
  });

  it("launchd が未ロードのラベルは launchd:null で degrade する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/supervisor");
    const body = (await res.json()) as SupervisorStatus;
    expect(body.launchd).toBeNull();
  });

  it("supervisor.jsonl が無ければ lastTick は null を返す", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/api/supervisor");
    const body = (await res.json()) as SupervisorStatus;
    expect(body.lastTick).toBeNull();
  });
});

describe("POST /api/supervisor/killswitch", () => {
  async function postKillswitch(
    app: ReturnType<typeof buildApp>,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return await app.request("/api/supervisor/killswitch", {
      method: "POST",
      headers: withWriteAuth({ "content-type": "application/json", ...headers }),
      body: JSON.stringify(body),
    });
  }

  it("許可された全ステージで disabled:true → home 配下にファイルを作成する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));

    for (const stage of STAGE_NAMES) {
      const res = await postKillswitch(app, { stage, disabled: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; disabled: boolean };
      expect(body).toEqual({ name: stage, disabled: true });

      // ファイル操作が home 配下のみに限定されていること（containment）
      const filePath = resolve(tempHome.env.home, `${stage}.disabled`);
      expect(filePath.startsWith(`${resolve(tempHome.env.home)}${sep}`)).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("disabled:false で既存の kill-switch ファイルを削除する", async () => {
    writeFileSync(join(tempHome.env.home, "monitor.disabled"), "", { mode: 0o600 });
    const app = buildApp(buildDeps(new FakeReadView([])));

    const res = await postKillswitch(app, { stage: "monitor", disabled: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; disabled: boolean };
    expect(body).toEqual({ name: "monitor", disabled: false });
    expect(existsSync(join(tempHome.env.home, "monitor.disabled"))).toBe(false);
  });

  it("disabled:false は対象ファイルが存在しなくてもエラーにならない", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await postKillswitch(app, { stage: "finalize", disabled: false });
    expect(res.status).toBe(200);
  });

  it("許可リストに無い stage 名は 400（fail-closed）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await postKillswitch(app, { stage: "not-a-real-stage", disabled: true });
    expect(res.status).toBe(400);
    expect(existsSync(join(tempHome.env.home, "not-a-real-stage.disabled"))).toBe(false);
  });

  it("パストラバーサル系の stage 名は 400 で home 外にファイルを作らない（fail-closed）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const traversalNames = ["../evil", "../../etc/passwd", "..", "dispatch/../../evil"];

    for (const stage of traversalNames) {
      const res = await postKillswitch(app, { stage, disabled: true });
      expect(res.status).toBe(400);
    }
    // home の親ディレクトリに何も作られていないこと
    expect(existsSync(resolve(tempHome.env.home, "..", "evil.disabled"))).toBe(false);
  });

  it("stage/disabled の型が不正な body は 400", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res1 = await postKillswitch(app, { stage: "dispatch", disabled: "true" });
    expect(res1.status).toBe(400);
    const res2 = await postKillswitch(app, { stage: 123, disabled: true });
    expect(res2.status).toBe(400);
  });

  it("Sec-Fetch-Site: cross-site は 403 で拒否し、ファイルも作らない", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await postKillswitch(app, { stage: "dispatch", disabled: true }, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(existsSync(join(tempHome.env.home, "dispatch.disabled"))).toBe(false);
  });

  it("Sec-Fetch-Site: same-origin は許可される", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await postKillswitch(app, { stage: "dispatch", disabled: true }, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
  });
});

// ---------- SPA 静的配信 ----------

describe("SPA fallback", () => {
  let staticDir: string;

  beforeEach(() => {
    staticDir = mkdtempSync(join(tmpdir(), "hachi-web-dist-"));
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    mkdirSync(join(staticDir, "icons"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
    writeFileSync(join(staticDir, "assets", "main.js"), "console.log('ok');");
    writeFileSync(join(staticDir, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    writeFileSync(join(staticDir, "favicon-16x16.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(staticDir, "favicon-32x32.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(staticDir, "apple-touch-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(staticDir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(staticDir, "icon-512.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(staticDir, "manifest.webmanifest"), "{\"name\":\"hachi-kanban\"}");
    writeFileSync(join(staticDir, "icons", "shiba.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  });

  afterEach(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  it("staticDir 未指定時は / が 404（テスト用に無効化されている）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([])));
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });

  it("/ は index.html を text/html で返す", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/task/:id は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/task/t_deadbeefdeadbeef");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/schedules は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/schedules");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/sessions と /session/:sessionId は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const sessionsRes = await app.request("/sessions");
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.headers.get("content-type")).toContain("text/html");
    expect(await sessionsRes.text()).toContain("<div id=\"root\">");

    const sessionRes = await app.request("/session/sess-live");
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.headers.get("content-type")).toContain("text/html");
    expect(await sessionRes.text()).toContain("<div id=\"root\">");
  });

  it("/metrics は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/usage は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/settings は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/knowledge は index.html を text/html で返す（SPA fallback）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/knowledge");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("/assets/* は静的ファイルを配信する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res = await app.request("/assets/main.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("console.log");
  });

  it("favicon・PWA manifest・ロゴを静的アセットallowlistから正しいContent-Typeで配信する", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const expected = [
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon-16x16.png", "image/png"],
      ["/favicon-32x32.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"],
      ["/icon-192.png", "image/png"],
      ["/icon-512.png", "image/png"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/icons/shiba.svg", "image/svg+xml"],
    ] as const;

    for (const [path, contentType] of expected) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(contentType);
    }
  });

  it("allowlist外のアセットはroot・サブディレクトリともdistに存在しても配信しない", async () => {
    writeFileSync(join(staticDir, "secret.txt"), "must-not-be-served");
    writeFileSync(join(staticDir, "icons", "secret.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const rootRes = await app.request("/secret.txt");
    expect(rootRes.status).toBe(404);
    const nestedRes = await app.request("/icons/secret.svg");
    expect(nestedRes.status).toBe(404);
  });

  it("存在しないアセットや encode 済み .. を含むパスは 404（fail-closed）", async () => {
    const app = buildApp(buildDeps(new FakeReadView([]), staticDir));
    const res1 = await app.request("/assets/does-not-exist.js");
    expect(res1.status).toBe(404);
    const res2 = await app.request(`/assets/${encodeURIComponent("../../etc/passwd")}`);
    expect(res2.status).toBe(404);
  });
});

describe("GET /api/runtime-resources", () => {
  it("read view 未注入時は 503 で安全に degrade する", async () => {
    const response = await buildApp(buildDeps(new FakeReadView([]))).request("/api/runtime-resources");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "runtime resource read view は未注入です" });
  });

  it("lease/member/request を集約し secret と provenance 本文と human answer を公開しない", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    const lease = makeRuntimeLease({ terminalReason: "owner_terminal" });
    const member = makeRuntimeMember();
    const request = makeRuntimeRequest({ expectedMembersHash: runtimeMembersHash([member]) });
    const deps = buildDeps(new FakeReadView([]));
    deps.runtimeResourceView = new FakeRuntimeResourceView([lease], [member], [request]);
    const response = await buildApp(deps).request("/api/runtime-resources");
    const body = (await response.json()) as RuntimeResourcesResponse;

    expect(response.status).toBe(200);
    expect(body.generatedAt).toBe(1_700_000_100);
    expect(body.leases[0]?.cleanupRequests[0]).toMatchObject({ leaseFenceMatches: true, memberSnapshotMatches: true });
    expect(body.leases[0]?.members[0]?.eligibility).toMatchObject({
      provenance: "pass",
      unused: "unknown",
      freshInspect: "unknown",
      objectFence: "unknown",
      enforceMode: "unknown",
      killSwitch: "unknown",
      budget: "unknown",
      autoEligible: false,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("provenance-body-must-not-leak");
    expect(serialized).not.toContain("claim-token-hash-must-not-leak");
    expect(serialized).not.toContain("execution-nonce-must-not-leak");
    expect(serialized).not.toContain("human-answer-must-not-leak");
  });

  it("request fence/member hash の不一致を evidence へ fail-closed で反映する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    const lease = makeRuntimeLease({ terminalReason: "lease_expired" });
    const member = makeRuntimeMember();
    const request = makeRuntimeRequest({ expectedLeaseFence: 6, expectedMembersHash: "stale-snapshot" });
    const deps = buildDeps(new FakeReadView([]));
    deps.runtimeResourceView = new FakeRuntimeResourceView([lease], [member], [request]);
    const response = await buildApp(deps).request("/api/runtime-resources");
    const body = (await response.json()) as RuntimeResourcesResponse;

    expect(body.leases[0]?.cleanupRequests[0]).toMatchObject({ leaseFenceMatches: false, memberSnapshotMatches: false });
    expect(body.leases[0]?.members[0]?.eligibility).toMatchObject({
      leaseFence: "fail",
      memberSnapshot: "fail",
      autoEligible: false,
    });
  });

  it("固定 clock で active/stale/expired/cleanup待ち/quarantined/legacy を集計する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    const leases = [
      makeRuntimeLease({ id: "lease-active", expiresAt: 1_700_000_200 }),
      makeRuntimeLease({ id: "lease-stale", expiresAt: 1_700_000_099 }),
      makeRuntimeLease({ id: "lease-expired", state: "expired", terminalReason: "lease_expired" }),
      makeRuntimeLease({ id: "lease-quarantined", state: "quarantined" }),
      makeRuntimeLease({
        id: "lease-legacy",
        bundleKind: "legacy_observation",
        state: "quarantined",
        managed: false,
        ephemeral: false,
        cleanupPolicy: "never",
      }),
    ];
    const requests = [makeRuntimeRequest({ leaseId: "lease-expired", status: "waiting_human" })];
    const deps = buildDeps(new FakeReadView([]));
    deps.runtimeResourceView = new FakeRuntimeResourceView(leases, [], requests);
    const response = await buildApp(deps).request("/api/runtime-resources");
    const body = (await response.json()) as RuntimeResourcesResponse;

    expect(body.summary).toEqual({
      total: 5,
      byState: {
        requested: 0,
        provisioning: 0,
        active: 2,
        cleanup_pending: 0,
        expired: 1,
        releasing: 0,
        released: 0,
        quarantined: 2,
        failed: 0,
        cancelled: 0,
        unknown: 0,
      },
      active: 1,
      stale: 1,
      expired: 1,
      cleanupPending: 1,
      quarantined: 2,
      legacyNever: 1,
    });
    expect(body.leases.find((lease) => lease.id === "lease-stale")?.staleReasons).toEqual([
      "expiry_exceeded",
      "heartbeat_deadline_unknown",
    ]);
  });

  it("read view 例外は redaction 済み 500 としプロセスを落とさない", async () => {
    const deps = buildDeps(new FakeReadView([]));
    const runtimeView = new FakeRuntimeResourceView([], [], []);
    vi.spyOn(runtimeView, "leases").mockImplementation(() => {
      throw new Error("failure sk-proj-12345678901234567890");
    });
    deps.runtimeResourceView = runtimeView;
    const response = await buildApp(deps).request("/api/runtime-resources");
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("runtime resource の取得に失敗しました");
    expect(text).not.toContain("sk-proj-12345678901234567890");
  });
});
