import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createKanbanReadView,
  createRuntimeResourceReadView,
  parseAgentMessages,
  readBoardInstanceId,
  SqliteKanbanStore,
  TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
  TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
  type DurableSteerStore,
  type LinkRow,
  type NativeCommunicationStore,
  type RuntimeResourceRequirementRow,
  type SessionRef,
  type StopResult,
  type TaskAwaitCheckpoint,
  type TaskRow,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, DummyAdapter, type TestDeps } from "../test-support.js";

class StoppableDummyAdapter extends DummyAdapter {
  readonly stopCalls: SessionRef[] = [];
  stopResult: StopResult = { stopped: true, reason: "terminated" };

  stop(ref: SessionRef): Promise<StopResult> {
    this.stopCalls.push(ref);
    return Promise.resolve(this.stopResult);
  }
}

interface TestStoreWithDb {
  db: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number };
    };
  };
}

interface RuntimeRequirementTestStore {
  createOrGetRuntimeResourceRequirement(input: {
    taskId: string;
    name: string;
    bundleKind: "worktree_postgres";
    spec: unknown;
    idempotencyKey: string;
  }): RuntimeResourceRequirementRow;
  getRuntimeResourceRequirement(id: string): RuntimeResourceRequirementRow | null;
}

interface RuntimeProfileFixture {
  worktree: string;
  repoCommonDir: string;
  orchestratorId: string;
  sessionId: string;
  generation: number;
  actorArgs: string[];
}

function runtimeRequirementStore(ctx: TestDeps): RuntimeRequirementTestStore {
  return ctx.deps.store as unknown as RuntimeRequirementTestStore;
}

function runtimeRequirementCount(ctx: TestDeps): number {
  const store = ctx.deps.store as unknown as TestStoreWithDb;
  const row = store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_resource_requirements`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function executionActorArgs(ctx: TestDeps, label: string, taskId?: string): string[] {
  const orchestrator = ctx.deps.store.registerOrchestrator({ label, project: "dev", repoCommonDir: "" });
  const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  if (taskId !== undefined) {
    ctx.deps.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
  }
  return [
    "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
    "--session", session.id, "--generation", String(session.generation),
  ];
}

function configureRuntimeProfile(
  ctx: TestDeps,
  options: {
    configProject?: string;
    orchestratorProject?: string;
    mode?: "observe" | "enforce";
    provisioningEnabled?: boolean;
    repoCommonDir?: string;
  } = {},
): RuntimeProfileFixture {
  const worktree = join(ctx.deps.env.home, "runtime-project");
  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree], {
    stdio: "ignore",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: process.env["HOME"] ?? "/",
    },
  });
  const discoveredCommonDir = execFileSync(
    "git",
    ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    },
  ).trim();
  const repoCommonDir = realpathSync.native(options.repoCommonDir ?? discoveredCommonDir);
  Object.assign(ctx.deps.config, {
    runtimeResources: {
      mode: options.mode ?? "enforce",
      provisioningEnabled: options.provisioningEnabled ?? true,
      leaseTtlSeconds: 300,
      dockerContext: "hachi-test",
      worktreePostgres: {
        image: "postgres:16",
        containerPort: 5432,
        healthCheck: {
          command: ["profile-host-only-health-check"],
          intervalMs: 1000,
          timeoutMs: 1000,
          retries: 3,
        },
      },
      projects: [
        {
          project: options.configProject ?? "hachi-kanban",
          repoCommonDir,
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
  });
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: "runtime-profile-owner",
    project: options.orchestratorProject ?? "hachi-kanban",
    repoCommonDir,
  });
  const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  return {
    worktree,
    repoCommonDir,
    orchestratorId: orchestrator.id,
    sessionId: session.id,
    generation: session.generation,
    actorArgs: [
      "--actor-kind", "orchestrator",
      "--orchestrator", orchestrator.id,
      "--session", session.id,
      "--generation", String(session.generation),
      "--bind-orchestrator", orchestrator.id,
    ],
  };
}

function createCancelableFixture(ctx: TestDeps, suffix: string = "one"): {
  task: TaskRow;
  runId: number;
  sessionId: string;
  orchestratorId: string;
  requesterSessionId: string;
  generation: number;
  args: string[];
} {
  const task = ctx.deps.store.createTask(
    { title: `cancel-${suffix}`, body: "cwd: /tmp", tenant: "dev", status: "ready" },
    "tester",
  );
  const sessionId = `worker-${suffix}`;
  const run = ctx.deps.store.startRun(task.id, "codex", sessionId, { transport: "direct", serverUrl: "direct" });
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: `cancel-owner-${suffix}`,
    project: "dev",
    repoCommonDir: `/repo/${suffix}`,
  });
  const requester = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
  return {
    task,
    runId: run.id,
    sessionId,
    orchestratorId: orchestrator.id,
    requesterSessionId: requester.id,
    generation: requester.generation,
    args: [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", requester.id, "--generation", String(requester.generation),
    ],
  };
}

function createBridgeCancelableFixture(
  ctx: TestDeps,
  suffix: string,
  serverUrl: string = "http://127.0.0.1:3456",
): ReturnType<typeof createCancelableFixture> {
  const task = ctx.deps.store.createTask(
    { title: `bridge-cancel-${suffix}`, body: "cwd: /tmp", tenant: "dev", status: "ready" },
    "tester",
  );
  const sessionId = `bridge-worker-${suffix}`;
  const run = ctx.deps.store.startRun(task.id, "codex", sessionId, { transport: "bridge", serverUrl });
  ctx.deps.store.block(task.id, `codex-in-progress: bridge-cancel-${suffix}`, "supervisor");
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: `bridge-cancel-owner-${suffix}`,
    project: "dev",
    repoCommonDir: `/repo/bridge-${suffix}`,
  });
  const requester = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
  return {
    task: ctx.deps.store.getTask(task.id)!,
    runId: run.id,
    sessionId,
    orchestratorId: orchestrator.id,
    requesterSessionId: requester.id,
    generation: requester.generation,
    args: [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", requester.id, "--generation", String(requester.generation),
    ],
  };
}

function readRunStatus(ctx: TestDeps, runId: number): string | null {
  const store = ctx.deps.store as unknown as TestStoreWithDb;
  const row = store.db.prepare(`SELECT status FROM task_runs WHERE id = ?`).get(runId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

function readRunMeta(ctx: TestDeps, runId: number): Record<string, unknown> | null {
  const store = ctx.deps.store as unknown as TestStoreWithDb;
  const row = store.db.prepare(`SELECT meta FROM task_runs WHERE id = ?`).get(runId) as
    | { meta: string }
    | undefined;
  return row === undefined ? null : JSON.parse(row.meta) as Record<string, unknown>;
}

function readAwaitCheckpoint(ctx: TestDeps, relativePath: string): TaskAwaitCheckpoint {
  const path = join(ctx.deps.env.home, "state", "task-await", relativePath);
  return JSON.parse(readFileSync(path, "utf8")) as TaskAwaitCheckpoint;
}

function readTaskEventHighwater(ctx: TestDeps): number {
  const store = ctx.deps.store as unknown as TestStoreWithDb;
  const row = store.db.prepare(`SELECT COALESCE(MAX(id), 0) AS event_cursor FROM task_events`).get() as
    | { event_cursor: number }
    | undefined;
  return row?.event_cursor ?? 0;
}

function requireTaskEventId(
  ctx: TestDeps,
  taskId: string,
  eventType: string,
  predicate: (payload: Record<string, unknown>) => boolean,
): number {
  const event = ctx.deps.store.listEvents(taskId, eventType).find((candidate) => {
    const payload = JSON.parse(candidate.payload) as Record<string, unknown>;
    return predicate(payload);
  });
  if (event === undefined) {
    throw new Error(`テスト対象イベントが見つかりません: task=${taskId} type=${eventType}`);
  }
  return event.id;
}

describe("hachi task", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("create → show → list → counts の一連が動作する", async () => {
    ctx = createTestDeps();
    const program1 = buildProgram(ctx.deps);
    await program1.parseAsync(
      [
        "task",
        "create",
        "--title",
        "検証タスク",
        "--body",
        "本文です",
        "--tenant",
        "dev-tenant",
        "--priority",
        "3",
        "--json",
      ],
      { from: "user" },
    );

    const createPayload = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      task: TaskRow;
      dependencyIds: string[];
    };
    const created = createPayload.task;
    expect(createPayload).toMatchObject({ id: created.id, status: created.status });
    expect(created.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(created.title).toBe("検証タスク");
    expect(created.priority).toBe(3);
    expect(created.status).toBe("triage");
    expect(createPayload.dependencyIds).toEqual([]);

    // show
    ctx.stdout.clear();
    const program2 = buildProgram(ctx.deps);
    await program2.parseAsync(["task", "show", created.id, "--json"], { from: "user" });
    const shown = JSON.parse(ctx.stdout.text()) as {
      id: string;
      status: string;
      task: TaskRow;
      comments: unknown[];
      events: Array<{ eventType: string }>;
    };
    expect(shown).toMatchObject({ id: created.id, status: created.status });
    expect(shown.task.id).toBe(created.id);
    expect(shown.comments).toHaveLength(0);
    expect(shown.events.some((e) => e.eventType === "task_created")).toBe(true);

    // list（status指定なし = 全状態を横断）
    ctx.stdout.clear();
    const program3 = buildProgram(ctx.deps);
    await program3.parseAsync(["task", "list", "--json"], { from: "user" });
    const listPayload = JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] };
    expect(listPayload).not.toHaveProperty("id");
    expect(listPayload).not.toHaveProperty("status");
    const listed = listPayload.tasks;
    expect(listed.map((t) => t.id)).toContain(created.id);

    // list（status指定あり）
    ctx.stdout.clear();
    const program4 = buildProgram(ctx.deps);
    await program4.parseAsync(["task", "list", "--status", "triage", "--json"], { from: "user" });
    const listedTriage = (JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] }).tasks;
    expect(listedTriage.map((t) => t.id)).toEqual([created.id]);

    // counts (board 経由)
    expect(ctx.deps.store.counts().triage).toBe(1);
  });

  it("create は literal newline escape を永続化前に構造化エラーで拒否する", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "invalid body", "--body", "cwd: /tmp\\n## 目的\\n本文", "--tenant", "dev", "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.counts().triage).toBe(0);
    expect(ctx.deps.store.counts().todo).toBe(0);
    const payload = JSON.parse(ctx.stderr.text()) as {
      error: { code: string; details: { escape: string; physicalLine: number; trigger: string } };
    };
    expect(payload.error).toMatchObject({
      code: "literal-newline-escape",
      details: { escape: "\\n", physicalLine: 1, trigger: "cwd" },
    });
  });

  it("create は literal CRLF escape も自動変換せず拒否する", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "invalid crlf", "--body", "cwd: /tmp\\r\\n本文", "--tenant", "dev",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("literal-newline-escape");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create は JSON.stringify の外側引用符付き最小入力を永続化前に拒否する", async () => {
    ctx = createTestDeps();
    const body = `${JSON.stringify("cwd: /tmp\n本文")}\n`;

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "stringified body", "--body", body, "--tenant", "dev", "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.counts().triage).toBe(0);
    expect(JSON.parse(ctx.stderr.text())).toMatchObject({
      error: {
        code: "literal-newline-escape",
        details: { physicalLine: 1, logicalLineCount: 2, trigger: "cwd" },
      },
    });
  });

  it("edit-body は不正本文を update 前に拒否し、既存 body を保持する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "edit target", body: "cwd: /old\n既存本文", tenant: "dev" },
      "tester",
    );
    const filePath = join(ctx.deps.env.home, "invalid-body.md");
    writeFileSync(filePath, "cwd: /new\\r\\n## 目的\\r\\n新本文", "utf8");

    await buildProgram(ctx.deps).parseAsync([
      "task", "edit-body", task.id, "--file", filePath, "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.getTask(task.id)?.body).toBe("cwd: /old\n既存本文");
    expect(ctx.deps.store.listEvents(task.id, "body_updated")).toHaveLength(0);
    expect(JSON.parse(ctx.stderr.text())).toMatchObject({ error: { code: "literal-newline-escape" } });
  });

  it("edit-body は末尾改行付き JSON.stringify 本文も update 前に拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "edit target", body: "cwd: /old\n既存本文", tenant: "dev" },
      "tester",
    );
    const filePath = join(ctx.deps.env.home, "stringified-body.json");
    writeFileSync(filePath, `${JSON.stringify("cwd: /new\n## 目的\n新本文")}\r\n`, "utf8");

    await buildProgram(ctx.deps).parseAsync([
      "task", "edit-body", task.id, "--file", filePath, "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.getTask(task.id)?.body).toBe("cwd: /old\n既存本文");
    expect(ctx.deps.store.listEvents(task.id, "body_updated")).toHaveLength(0);
    expect(JSON.parse(ctx.stderr.text())).toMatchObject({
      error: {
        code: "literal-newline-escape",
        details: { escape: "\\n", physicalLine: 1, logicalLineCount: 3, trigger: "cwd" },
      },
    });
  });

  it("edit-body は実改行を含む file input と意図的な通常 backslash を受理する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "edit target", body: "旧本文", tenant: "dev" }, "tester");
    const filePath = join(ctx.deps.env.home, "valid-body.md");
    const body = "cwd: /tmp\n\n## 目的\n本文には文字列 \\n を残す";
    writeFileSync(filePath, body, "utf8");

    await buildProgram(ctx.deps).parseAsync([
      "task", "edit-body", task.id, "--file", filePath, "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.deps.store.getTask(task.id)?.body).toBe(body);
  });

  it("create/show/move/block/unblock は同じtop-level id/statusを返しnested taskを維持する", async () => {
    ctx = createTestDeps();
    const assertTaskEnvelope = (payload: unknown, expectedStatus: TaskRow["status"]): TaskRow => {
      const envelope = payload as { id: string; status: string; task: TaskRow };
      expect(envelope).toMatchObject({
        id: envelope.task.id,
        status: expectedStatus,
        task: { status: expectedStatus },
      });
      return envelope.task;
    };

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "envelope",
      "--body", "cwd: /tmp",
      "--tenant", "dev",
      "--status", "todo",
      "--json",
    ], { from: "user" });
    const task = assertTaskEnvelope(JSON.parse(ctx.stdout.text()), "todo");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id, "--json"], { from: "user" });
    assertTaskEnvelope(JSON.parse(ctx.stdout.text()), "todo");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "ready", "--json"], {
      from: "user",
    });
    assertTaskEnvelope(JSON.parse(ctx.stdout.text()), "ready");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "task", "block", task.id, "--reason", "user-decision: envelope", "--json",
    ], { from: "user" });
    assertTaskEnvelope(JSON.parse(ctx.stdout.text()), "blocked");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "unblock", task.id, "--to", "ready", "--json"], {
      from: "user",
    });
    assertTaskEnvelope(JSON.parse(ctx.stdout.text()), "ready");
  });

  it("show は currentRun の6フィールドだけをJSONと人間向け出力へ追加し、open run 無しではnull/非表示にする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "current run", body: "cwd: /tmp", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id, "--json"], { from: "user" });
    const withoutRun = JSON.parse(ctx.stdout.text()) as Record<string, unknown> & { currentRun: unknown };
    expect(Object.keys(withoutRun).sort()).toEqual([
      "cancelRequests",
      "comments",
      "currentRun",
      "events",
      "id",
      "status",
      "steerDeliveries",
      "task",
    ]);
    expect(withoutRun.currentRun).toBeNull();

    const run = ctx.deps.store.startRun(task.id, "claude", "worker-current", {
      transport: "direct",
      serverUrl: "direct",
      prompt: "must not be exposed",
      transcript: "must not be exposed",
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id, "--json"], { from: "user" });
    const withRun = JSON.parse(ctx.stdout.text()) as {
      currentRun: Record<string, unknown>;
      comments: unknown[];
      events: unknown[];
      cancelRequests: unknown[];
      steerDeliveries: unknown[];
      task: TaskRow;
    };
    expect(withRun.currentRun).toEqual({
      id: run.id,
      sessionId: run.sessionId,
      provider: run.provider,
      transport: "direct",
      startedAt: run.startedAt,
      status: "running",
    });
    expect(ctx.stdout.text()).not.toContain("must not be exposed");
    expect(withRun).toMatchObject({
      task: { id: task.id },
      comments: [],
      events: expect.any(Array),
      cancelRequests: [],
      steerDeliveries: [],
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id], { from: "user" });
    const text = ctx.stdout.text();
    expect(text.match(/^currentRun:/gm)).toHaveLength(1);
    expect(text).toContain(`id=${run.id}`);
    expect(text).toContain(`sessionId=${run.sessionId}`);

    ctx.deps.store.endRun(run.id, "done");
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id], { from: "user" });
    expect(ctx.stdout.text().match(/^currentRun:/gm)).toBeNull();
  });

  it("comment は --author 単独を unknown のまま保ち、explicit human/orchestrator を構造化する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "legacy", "--author", "alice"],
      { from: "user" },
    );
    expect(ctx.deps.store.listComments(task.id).at(-1)?.provenance).toEqual({
      kind: "unknown",
      actorId: "",
      actorSessionId: "",
      actorGeneration: null,
    });

    await buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "human", "--author", "alice", "--actor-kind", "human"],
      { from: "user" },
    );
    expect(ctx.deps.store.listComments(task.id).at(-1)?.provenance).toEqual({
      kind: "human",
      actorId: "alice",
      actorSessionId: "",
      actorGeneration: null,
    });

    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "cli", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "comment", task.id, "--body", "orchestrator", "--actor-kind", "orchestrator",
        "--orchestrator", orchestrator.id, "--session", session.id, "--generation", String(session.generation),
      ],
      { from: "user" },
    );
    expect(ctx.deps.store.listComments(task.id).at(-1)?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });
  });

  it("create はexecution指定時にtask/override全eventへprovenanceを伝搬しactorをprimary bindする", async () => {
    ctx = createTestDeps();
    const prerequisite = ctx.deps.store.createTask(
      { title: "前提", body: "cwd: /tmp/prerequisite", tenant: "dev" },
      "tester",
    );
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "creator", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "created", "--body", "cwd: /tmp", "--tenant", "dev",
      "--model", "gpt-5.6-sol", "--effort", "high", "--actor-kind", "orchestrator",
      "--orchestrator", orchestrator.id, "--session", session.id,
      "--generation", String(session.generation), "--depends-on", prerequisite.id, "--json",
    ], { from: "user" });

    const task = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    const events = ctx.deps.store.listEvents(task.id);
    expect(events.map((event) => event.eventType)).toEqual(["task_created", "execution_overrides_changed"]);
    expect(events.every((event) => (
      event.provenance.kind === "orchestrator" &&
      event.provenance.actorId === orchestrator.id &&
      event.provenance.actorSessionId === session.id &&
      event.provenance.actorGeneration === session.generation
    ))).toBe(true);
    expect(ctx.deps.store.listTaskOrchestratorBindings(task.id)).toEqual([
      expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
    ]);
    expect(ctx.deps.store.dependencies(task.id).map((dependency) => dependency.id)).toEqual([prerequisite.id]);
  });

  it("create はlegacy --orchestrator bindingをunknownのまま維持し、principalと別identityへ明示bindingできる", async () => {
    ctx = createTestDeps();
    const owner = ctx.deps.store.registerOrchestrator({ label: "owner", project: "dev", repoCommonDir: "" });
    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "legacy", "--body", "cwd: /tmp", "--tenant", "dev",
      "--orchestrator", owner.id, "--json",
    ], { from: "user" });
    const legacy = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(ctx.deps.store.listEvents(legacy.id)[0]?.provenance).toEqual({
      kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null,
    });
    expect(ctx.deps.store.listTaskOrchestratorBindings(legacy.id)[0]?.orchestratorId).toBe(owner.id);

    const otherOwner = ctx.deps.store.registerOrchestrator({ label: "other", project: "dev", repoCommonDir: "" });
    const beforeConflict = ctx.deps.store.counts().triage;
    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "conflict", "--body", "cwd: /tmp", "--tenant", "dev",
      "--orchestrator", owner.id, "--bind-orchestrator", otherOwner.id,
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.counts().triage).toBe(beforeConflict);

    const actor = ctx.deps.store.registerOrchestrator({ label: "actor", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: actor.id });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "delegated", "--body", "cwd: /tmp", "--tenant", "dev",
      "--actor-kind", "orchestrator", "--orchestrator", actor.id,
      "--session", session.id, "--generation", String(session.generation),
      "--bind-orchestrator", owner.id, "--json",
    ], { from: "user" });
    const delegated = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(ctx.deps.store.listEvents(delegated.id)[0]?.provenance.actorId).toBe(actor.id);
    expect(ctx.deps.store.listTaskOrchestratorBindings(delegated.id)[0]?.orchestratorId).toBe(owner.id);

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    const before = ctx.deps.store.counts().triage;
    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "stale", "--body", "cwd: /tmp", "--tenant", "dev",
      "--actor-kind", "orchestrator", "--orchestrator", actor.id,
      "--session", session.id, "--generation", String(session.generation + 1),
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.counts().triage).toBe(before);
  });

  it("principal flags は矛盾・欠落・service・非正generationを fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const before = ctx.deps.store.listComments(task.id).length;

    await buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "bad", "--actor-kind", "orchestrator"],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(before);

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "bad", "--actor-kind", "human", "--session", "os_x"],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(before);

    await expect(buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "bad", "--actor-kind", "service"],
      { from: "user" },
    )).rejects.toThrow(/Allowed choices/);
    await expect(buildProgram(ctx.deps).parseAsync(
      [
        "task", "comment", task.id, "--body", "bad", "--actor-kind", "orchestrator",
        "--orchestrator", "o_x", "--session", "os_x", "--generation", "0",
      ],
      { from: "user" },
    )).rejects.toThrow(/正の整数/);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(before);
  });

  it("全対象mutation help は actor-kind を human/orchestrator に限定し service を公開しない", async () => {
    ctx = createTestDeps();
    for (const command of [
      "create", "move", "comment", "attach", "block", "unblock", "watch", "unwatch", "edit-body", "set-cwd", "cancel",
    ]) {
      ctx.stdout.clear();
      await expect(buildProgram(ctx.deps).parseAsync(["task", command, "--help"], { from: "user" }))
        .rejects.toMatchObject({ code: "commander.helpDisplayed" });
      expect(ctx.stdout.text()).toContain("--actor-kind <kind>");
      expect(ctx.stdout.text()).toContain('(choices: "human", "orchestrator")');
      expect(ctx.stdout.text()).not.toContain("service");
    }
  });

  it("create は --status blocked を fail-closed で拒否する（docs/contract.md §12.6-4）", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--status", "blocked"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("triage / todo / ready のみ指定できます");
    expect(ctx.deps.store.counts().blocked).toBe(0);
  });

  it("create は --status done を fail-closed で拒否する（docs/contract.md §12.6-4）", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--status", "done"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("triage / todo / ready のみ指定できます");
    expect(ctx.deps.store.counts().done).toBe(0);
  });

  it("create は --status ready を許可する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--status", "ready", "--json"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    const created = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(created.status).toBe("ready");
  });

  it("create --depends-on は依存1件を prerequisite -> created task の向きで確定する", async () => {
    ctx = createTestDeps();
    const prerequisite = ctx.deps.store.createTask(
      { title: "前提", body: "cwd: /tmp/prerequisite", tenant: "dev" },
      "tester",
    );

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "依存先", "--body", "cwd: /tmp/dependent", "--tenant", "dev",
      "--depends-on", prerequisite.id, "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const payload = JSON.parse(ctx.stdout.text()) as { task: TaskRow; dependencyIds: string[] };
    expect(payload.dependencyIds).toEqual([prerequisite.id]);
    expect(ctx.deps.store.dependencies(payload.task.id).map((task) => task.id)).toEqual([prerequisite.id]);
    expect(ctx.deps.store.listLinks(payload.task.id)).toEqual([
      expect.objectContaining({
        parentId: prerequisite.id,
        childId: payload.task.id,
        linkType: "depends-on",
      }),
    ]);
  });

  it("create --depends-on は複数依存とready・既存optionを同一transactionで確定する", async () => {
    ctx = createTestDeps();
    const first = ctx.deps.store.createTask(
      { title: "前提1", body: "cwd: /tmp/first", tenant: "dev" },
      "tester",
    );
    const second = ctx.deps.store.createTask(
      { title: "前提2", body: "cwd: /tmp/second", tenant: "dev" },
      "tester",
    );
    const owner = ctx.deps.store.registerOrchestrator({
      label: "dependency-owner",
      project: "dev",
      repoCommonDir: "",
    });
    const ownerSession = ctx.deps.store.startOrchestratorSession({ orchestratorId: owner.id });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "複数依存",
      "--body", "cwd: /tmp/dependent",
      "--tenant", "dev",
      "--profile", "review",
      "--priority", "7",
      "--status", "ready",
      "--provider", "codex",
      "--model", "gpt-5.6-sol",
      "--effort", "high",
      "--actor-kind", "orchestrator", "--orchestrator", owner.id,
      "--session", ownerSession.id, "--generation", String(ownerSession.generation),
      "--bind-orchestrator", owner.id,
      "--depends-on", first.id,
      "--depends-on", second.id,
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const payload = JSON.parse(ctx.stdout.text()) as { task: TaskRow; dependencyIds: string[] };
    expect(payload.dependencyIds).toEqual([first.id, second.id]);
    expect(payload.task).toMatchObject({
      status: "ready",
      profile: "review",
      priority: 7,
      provider: "codex",
      modelOverride: "gpt-5.6-sol",
      effortOverride: "high",
    });
    expect(ctx.deps.store.dependencies(payload.task.id).map((task) => task.id)).toEqual([first.id, second.id]);
    expect(ctx.deps.store.listTaskOrchestratorBindings(payload.task.id)).toEqual([
      expect.objectContaining({ orchestratorId: owner.id, role: "primary" }),
    ]);
  });

  it("create --depends-on は空値をtask作成前に拒否する", async () => {
    ctx = createTestDeps();
    const createTask = vi.spyOn(ctx.deps.store, "createTask");

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "空依存", "--body", "cwd: /tmp/empty", "--tenant", "dev",
      "--depends-on", "",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("空のタスク ID");
    expect(createTask).not.toHaveBeenCalled();
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create --depends-on は重複をtask作成前に拒否する", async () => {
    ctx = createTestDeps();
    const prerequisite = ctx.deps.store.createTask(
      { title: "前提", body: "cwd: /tmp/prerequisite", tenant: "dev" },
      "tester",
    );
    const createTask = vi.spyOn(ctx.deps.store, "createTask");

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "重複依存", "--body", "cwd: /tmp/duplicate", "--tenant", "dev",
      "--depends-on", prerequisite.id, "--depends-on", prerequisite.id,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("重複指定");
    expect(createTask).not.toHaveBeenCalled();
    expect(ctx.deps.store.counts().triage).toBe(1);
    expect(ctx.deps.store.listLinks(prerequisite.id)).toHaveLength(0);
  });

  it("create --depends-on は不存在を同一transaction内で拒否してpartial taskを残さない", async () => {
    ctx = createTestDeps();
    const createTask = vi.spyOn(ctx.deps.store, "createTask");

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "不存在依存", "--body", "cwd: /tmp/missing", "--tenant", "dev",
      "--depends-on", "t_0000000000000000",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("タスクが見つかりません");
    expect(createTask).not.toHaveBeenCalled();
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create --depends-on はlink途中失敗時にtask/event/override/binding/linkを全rollbackする", async () => {
    ctx = createTestDeps();
    const first = ctx.deps.store.createTask(
      { title: "前提1", body: "cwd: /tmp/first", tenant: "dev" },
      "tester",
    );
    const second = ctx.deps.store.createTask(
      { title: "前提2", body: "cwd: /tmp/second", tenant: "dev" },
      "tester",
    );
    const owner = ctx.deps.store.registerOrchestrator({
      label: "rollback-owner",
      project: "dev",
      repoCommonDir: "",
    });
    const ownerSession = ctx.deps.store.startOrchestratorSession({ orchestratorId: owner.id });
    const originalLink = ctx.deps.store.link.bind(ctx.deps.store);
    let linkCount = 0;
    let attemptedTaskId = "";
    vi.spyOn(ctx.deps.store, "link").mockImplementation(
      (parentId: string, childId: string, linkType?: string): void => {
        linkCount += 1;
        attemptedTaskId = childId;
        if (linkCount === 2) {
          throw new Error("テスト用link途中失敗");
        }
        originalLink(parentId, childId, linkType);
      },
    );

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "rollback",
      "--body", "cwd: /tmp/rollback",
      "--tenant", "dev",
      "--status", "ready",
      "--model", "gpt-5.6-sol",
      "--effort", "high",
      "--actor-kind", "orchestrator", "--orchestrator", owner.id,
      "--session", ownerSession.id, "--generation", String(ownerSession.generation),
      "--bind-orchestrator", owner.id,
      "--depends-on", first.id,
      "--depends-on", second.id,
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("テスト用link途中失敗");
    expect(attemptedTaskId).toMatch(/^t_[0-9a-f]{16}$/);
    expect(ctx.deps.store.getTask(attemptedTaskId)).toBeNull();
    expect(ctx.deps.store.listEvents(attemptedTaskId)).toHaveLength(0);
    expect(ctx.deps.store.listTaskOrchestratorBindings(attemptedTaskId)).toHaveLength(0);
    expect(ctx.deps.store.listLinks(attemptedTaskId)).toHaveLength(0);
    expect(ctx.deps.store.listLinks(first.id)).toHaveLength(0);
    expect(ctx.deps.store.listLinks(second.id)).toHaveLength(0);
    expect(ctx.deps.store.counts().ready).toBe(0);
  });

  it("create --status ready はcommit前のtask/linkを別connectionへ公開しない", async () => {
    ctx = createTestDeps();
    const prerequisite = ctx.deps.store.createTask(
      { title: "前提", body: "cwd: /tmp/prerequisite", tenant: "dev" },
      "tester",
    );
    const observer = new SqliteKanbanStore(ctx.deps.env.dbPath);
    const originalLink = ctx.deps.store.link.bind(ctx.deps.store);
    let attemptedTaskId = "";
    let readyIdsBeforeCommit: string[] | undefined;
    let linksBeforeCommit: LinkRow[] | undefined;
    vi.spyOn(ctx.deps.store, "link").mockImplementation(
      (parentId: string, childId: string, linkType?: string): void => {
        originalLink(parentId, childId, linkType);
        attemptedTaskId = childId;
        readyIdsBeforeCommit = observer.listByStatus("ready").map((task) => task.id);
        linksBeforeCommit = observer.listLinks(prerequisite.id);
      },
    );

    try {
      await buildProgram(ctx.deps).parseAsync([
        "task", "create",
        "--title", "commit可視性",
        "--body", "cwd: /tmp/visibility",
        "--tenant", "dev",
        "--status", "ready",
        "--depends-on", prerequisite.id,
        "--json",
      ], { from: "user" });

      expect(ctx.exitCodes).toEqual([]);
      expect(readyIdsBeforeCommit).toEqual([]);
      expect(linksBeforeCommit).toEqual([]);
      expect(observer.getTask(attemptedTaskId)?.status).toBe("ready");
      expect(observer.listLinks(attemptedTaskId)).toEqual([
        expect.objectContaining({
          parentId: prerequisite.id,
          childId: attemptedTaskId,
          linkType: "depends-on",
        }),
      ]);
    } finally {
      observer.close();
    }
  });

  it("create --runtime-profile はtask・exact primary binding・v1 requirementをatomicに確定する", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "runtime profile",
      "--body", `cwd: ${fixture.worktree}\n\nisolated PostgreSQL`,
      "--tenant", "dev",
      "--status", "ready",
      "--runtime-profile", "postgres-v1",
      ...fixture.actorArgs,
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const payload = JSON.parse(ctx.stdout.text()) as {
      task: TaskRow;
      runtimeProfile: { id: string; project: string; bundleKind: string };
      runtimeRequirement: Omit<RuntimeResourceRequirementRow, "spec">;
    };
    expect(payload.runtimeProfile).toEqual({
      id: "postgres-v1",
      project: "hachi-kanban",
      bundleKind: "worktree_postgres",
    });
    expect(payload.runtimeRequirement).toMatchObject({
      taskId: payload.task.id,
      name: "runtime-profile:postgres-v1",
      bundleKind: "worktree_postgres",
      status: "pending",
      idempotencyKey: `${payload.task.id}:runtime-profile:postgres-v1`,
    });
    const persistedRequirement = runtimeRequirementStore(ctx)
      .getRuntimeResourceRequirement(payload.runtimeRequirement.id);
    expect(JSON.parse(persistedRequirement!.spec)).toEqual({
      version: 1,
      requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"],
      ownershipSnapshot: {
        version: 1,
        profileId: "postgres-v1",
        orchestratorId: fixture.orchestratorId,
        project: "hachi-kanban",
        repoCommonDir: fixture.repoCommonDir,
        canonicalWorktree: realpathSync.native(fixture.worktree),
      },
      hostAdapterSnapshot: {
        version: 1,
        hostAdapter: "worktreePostgres",
        configFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(ctx.deps.store.listTaskOrchestratorBindings(payload.task.id)).toEqual([
      expect.objectContaining({
        orchestratorId: fixture.orchestratorId,
        role: "primary",
      }),
    ]);
    expect(ctx.stdout.text()).not.toContain("profile-host-only-health-check");
    expect(ctx.stdout.text()).not.toContain(fixture.repoCommonDir);
    expect(payload.runtimeRequirement).not.toHaveProperty("spec");

    const otherWorktree = join(ctx.deps.env.home, "runtime-project-after-create");
    mkdirSync(otherWorktree);
    execFileSync("git", ["init", "--quiet", otherWorktree], {
      stdio: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    });
    await buildProgram(ctx.deps).parseAsync([
      "task", "set-cwd",
      payload.task.id,
      otherWorktree,
    ], { from: "user" });

    expect(JSON.parse(
      runtimeRequirementStore(ctx).getRuntimeResourceRequirement(payload.runtimeRequirement.id)!.spec,
    )).toEqual(JSON.parse(persistedRequirement!.spec));
  });

  it.each([
    {
      name: "unknown profile",
      configure: {},
      profileId: "missing",
      error: "profile が見つかりません",
    },
    {
      name: "project mismatch",
      configure: { configProject: "other-project" },
      profileId: "postgres-v1",
      error: "project がactive orchestratorと一致しません",
    },
    {
      name: "provision disabled",
      configure: { mode: "observe" as const, provisioningEnabled: false },
      profileId: "postgres-v1",
      error: "provisioning が有効ではありません",
    },
  ])("$name はpartial task/requirementを作らず失敗する", async ({ configure, profileId, error }) => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx, configure);

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "runtime reject",
      "--body", `cwd: ${fixture.worktree}`,
      "--tenant", "dev",
      "--status", "ready",
      "--runtime-profile", profileId,
      ...fixture.actorArgs,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain(error);
    expect(ctx.deps.store.counts().ready).toBe(0);
    expect(runtimeRequirementCount(ctx)).toBe(0);
  });

  it("create --runtime-profile は別Git common-dirのbody pathを権限証拠にせず拒否する", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);
    const otherWorktree = join(ctx.deps.env.home, "other-project");
    mkdirSync(otherWorktree);
    execFileSync("git", ["init", "--quiet", otherWorktree], {
      stdio: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/",
      },
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "path mismatch",
      "--body", `cwd: ${otherWorktree}`,
      "--tenant", "dev",
      "--runtime-profile", "postgres-v1",
      ...fixture.actorArgs,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("worktree path");
    expect(ctx.deps.store.counts().triage).toBe(0);
    expect(runtimeRequirementCount(ctx)).toBe(0);
  });

  it("create --runtime-profile はduplicate flagとprincipal/binding conflictをtask作成前に拒否する", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);
    const other = ctx.deps.store.registerOrchestrator({
      label: "other-runtime-owner",
      project: "hachi-kanban",
      repoCommonDir: fixture.repoCommonDir,
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "duplicate",
      "--body", `cwd: ${fixture.worktree}`,
      "--tenant", "dev",
      "--runtime-profile", "postgres-v1",
      "--runtime-profile", "postgres-v1",
      ...fixture.actorArgs,
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("重複指定");
    expect(ctx.deps.store.counts().triage).toBe(0);

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "binding conflict",
      "--body", `cwd: ${fixture.worktree}`,
      "--tenant", "dev",
      "--runtime-profile", "postgres-v1",
      "--actor-kind", "orchestrator",
      "--orchestrator", fixture.orchestratorId,
      "--session", fixture.sessionId,
      "--generation", String(fixture.generation),
      "--bind-orchestrator", other.id,
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("同一identity");
    expect(ctx.deps.store.counts().triage).toBe(0);
    expect(runtimeRequirementCount(ctx)).toBe(0);
  });

  it("create --runtime-profile はstale session generationをtransaction内で再検証して拒否する", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "stale runtime principal",
      "--body", `cwd: ${fixture.worktree}`,
      "--tenant", "dev",
      "--runtime-profile", "postgres-v1",
      "--actor-kind", "orchestrator",
      "--orchestrator", fixture.orchestratorId,
      "--session", fixture.sessionId,
      "--generation", String(fixture.generation + 1),
      "--bind-orchestrator", fixture.orchestratorId,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("session generation が完全一致しません");
    expect(ctx.deps.store.counts().triage).toBe(0);
    expect(runtimeRequirementCount(ctx)).toBe(0);
  });

  it("create --runtime-profile はrequirement書込失敗時にtask/event/bindingを全rollbackする", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);
    let attemptedTaskId = "";
    vi.spyOn(runtimeRequirementStore(ctx), "createOrGetRuntimeResourceRequirement").mockImplementation((input) => {
      attemptedTaskId = input.taskId;
      throw new Error("テスト用requirement書込失敗");
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "requirement rollback",
      "--body", `cwd: ${fixture.worktree}`,
      "--tenant", "dev",
      "--status", "ready",
      "--runtime-profile", "postgres-v1",
      ...fixture.actorArgs,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("テスト用requirement書込失敗");
    expect(attemptedTaskId).toMatch(/^t_[0-9a-f]{16}$/);
    expect(ctx.deps.store.getTask(attemptedTaskId)).toBeNull();
    expect(ctx.deps.store.listEvents(attemptedTaskId)).toHaveLength(0);
    expect(ctx.deps.store.listTaskOrchestratorBindings(attemptedTaskId)).toHaveLength(0);
    expect(runtimeRequirementCount(ctx)).toBe(0);
    expect(ctx.deps.store.counts().ready).toBe(0);
  });

  it("create --runtime-profile --status ready はcommit前のtask/requirementを別connectionへ公開しない", async () => {
    ctx = createTestDeps();
    const fixture = configureRuntimeProfile(ctx);
    const observer = new SqliteKanbanStore(ctx.deps.env.dbPath);
    const runtimeView = createRuntimeResourceReadView(ctx.deps.env.dbPath);
    const store = runtimeRequirementStore(ctx);
    const originalCreateRequirement = store.createOrGetRuntimeResourceRequirement.bind(store);
    let attemptedTaskId = "";
    let readyIdsBeforeCommit: string[] | undefined;
    let requirementsBeforeCommit: RuntimeResourceRequirementRow[] | undefined;
    vi.spyOn(store, "createOrGetRuntimeResourceRequirement").mockImplementation((input) => {
      const requirement = originalCreateRequirement(input);
      attemptedTaskId = input.taskId;
      readyIdsBeforeCommit = observer.listByStatus("ready").map((task) => task.id);
      requirementsBeforeCommit = runtimeView.requirementsForTask(input.taskId);
      return requirement;
    });

    try {
      await buildProgram(ctx.deps).parseAsync([
        "task", "create",
        "--title", "runtime visibility",
        "--body", `cwd: ${fixture.worktree}`,
        "--tenant", "dev",
        "--status", "ready",
        "--runtime-profile", "postgres-v1",
        ...fixture.actorArgs,
        "--json",
      ], { from: "user" });

      expect(ctx.exitCodes).toEqual([]);
      expect(readyIdsBeforeCommit).toEqual([]);
      expect(requirementsBeforeCommit).toEqual([]);
      expect(observer.getTask(attemptedTaskId)?.status).toBe("ready");
      expect(runtimeView.requirementsForTask(attemptedTaskId)).toHaveLength(1);
    } finally {
      runtimeView.close();
      observer.close();
    }
  });

  it("create --orchestrator は作成と同じTxでprimary bindingを設定する", async () => {
    ctx = createTestDeps();
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "task-owner",
      project: "dev",
      repoCommonDir: "",
    });
    await buildProgram(ctx.deps).parseAsync(
      [
        "task",
        "create",
        "--title",
        "owned",
        "--body",
        "cwd: /tmp",
        "--tenant",
        "dev",
        "--orchestrator",
        orchestrator.id,
        "--json",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    const created = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(ctx.deps.store.listTaskOrchestratorBindings(created.id)).toEqual([
      expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
    ]);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "create は --model %s / --effort で作成直後に override を設定できる",
    async (model) => {
      ctx = createTestDeps();
      await buildProgram(ctx.deps).parseAsync(
        [
          "task",
          "create",
          "--title",
          "t",
          "--body",
          "b",
          "--tenant",
          "dev",
          "--model",
          model,
          "--effort",
          "high",
          ...executionActorArgs(ctx, `create-${model}`),
          "--json",
        ],
        { from: "user" },
      );

      expect(ctx.exitCodes).toEqual([]);
      const created = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
      expect(created.modelOverride).toBe(model);
      expect(created.effortOverride).toBe("high");

      const persisted = ctx.deps.store.getTask(created.id);
      expect(persisted?.modelOverride).toBe(model);
      expect(persisted?.effortOverride).toBe("high");
    },
  );

  it("create はexecution指定がある場合structured orchestrator principal無しを拒否する", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "no authority", "--body", "b", "--tenant", "dev",
      "--model", "gpt-5.6-sol",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--actor-kind orchestrator");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create はworker/reviewer execution設定を作成と同じTxで保存しprovenanceを維持する", async () => {
    ctx = createTestDeps();
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "create-execution", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "codex-orchestrator-session",
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "role execution",
      "--body", "cwd: /tmp",
      "--tenant", "dev",
      "--provider", "codex",
      "--model", "gpt-5.6-sol",
      "--effort", "max",
      "--speed", "fast",
      "--review-profile", "review",
      "--review-provider", "claude",
      "--review-model", "claude-opus-5",
      "--review-effort", "max",
      "--review-speed", "fast",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const created = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(created).toMatchObject({
      provider: "codex",
      modelOverride: "gpt-5.6-sol",
      effortOverride: "max",
      speedOverride: "fast",
      reviewProfileOverride: "review",
      reviewProviderOverride: "claude",
      reviewModelOverride: "claude-opus-5",
      reviewEffortOverride: "max",
      reviewSpeedOverride: "fast",
    });
    expect(ctx.deps.store.getTask(created.id)).toMatchObject(created);
    expect(ctx.deps.store.listTaskOrchestratorBindings(created.id)).toEqual([
      expect.objectContaining({ orchestratorId: orchestrator.id, role: "primary" }),
    ]);
    const overrideEvents = ctx.deps.store.listEvents(created.id, "execution_overrides_changed");
    expect(overrideEvents).toHaveLength(2);
    expect(overrideEvents.map((event) => event.provenance)).toEqual([
      {
        kind: "orchestrator",
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      },
      {
        kind: "orchestrator",
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      },
    ]);
  });

  it("create はexecution指定時にactorと異なる明示primary bindingを拒否してrollbackする", async () => {
    ctx = createTestDeps();
    const actor = ctx.deps.store.registerOrchestrator({ label: "execution-actor", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: actor.id });
    const other = ctx.deps.store.registerOrchestrator({ label: "other-owner", project: "dev", repoCommonDir: "" });

    await buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "wrong owner", "--body", "b", "--tenant", "dev",
      "--speed", "fast", "--bind-orchestrator", other.id,
      "--actor-kind", "orchestrator", "--orchestrator", actor.id,
      "--session", session.id, "--generation", String(session.generation),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("actor orchestratorと一致");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create はreviewer overrideの解決失敗時にtask作成ごとrollbackする", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync([
      "task", "create",
      "--title", "rollback",
      "--body", "b",
      "--tenant", "dev",
      "--review-provider", "claude",
      "--review-model", "gpt-5.6-sol",
      ...executionActorArgs(ctx, "reviewer-rollback"),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("model-not-allowlisted");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create --model は allowlist 外モデルなら fail-closed で作成前に拒否する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(
        ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--model", "not-allowlisted-model"],
        { from: "user" },
      ),
    ).rejects.toThrow(/Allowed choices/);

    expect(ctx.stderr.text()).toContain("gpt-5.6-sol");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("edit-body の help は --file 必須と literal newline 非展開を明示する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "edit-body", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });

    expect(ctx.stdout.text()).toContain("--file 必須");
    expect(ctx.stdout.text()).toContain("code=literal-newline-escape");
  });

  it("create --model の help は現 config の Codex 5.6 候補を列挙する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "create", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });

    expect(ctx.stdout.text()).toContain("gpt-5.6-sol");
    expect(ctx.stdout.text()).toContain("gpt-5.6-terra");
    expect(ctx.stdout.text()).toContain("gpt-5.6-luna");
    expect(ctx.stdout.text()).toContain('$(cat body.md)');
    expect(ctx.stdout.text()).toContain("code=literal-newline-escape で拒否");
  });

  it("create --effort は不正値なら fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--effort", "ultra"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("low / medium / high / xhigh");
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create --speed/--review-speed は未知値をparserで拒否しtaskを作らない", async () => {
    ctx = createTestDeps();
    await expect(buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--speed", "turbo",
    ], { from: "user" })).rejects.toThrow(/Allowed choices/);
    expect(ctx.deps.store.counts().triage).toBe(0);

    await expect(buildProgram(ctx.deps).parseAsync([
      "task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--review-speed", "turbo",
    ], { from: "user" })).rejects.toThrow(/Allowed choices/);
    expect(ctx.deps.store.counts().triage).toBe(0);
  });

  it("create --priority に非数値を指定すると fail-closed で拒否される（docs/contract.md §12.10-5）", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(
        ["task", "create", "--title", "t", "--body", "b", "--tenant", "dev", "--priority", "1abc"],
        { from: "user" },
      ),
    ).rejects.toThrow();
  });

  it("show は存在しない id で fail-closed エラー終了する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["task", "show", "t_deadbeef"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("タスクが見つかりません");
  });

  it("comment は既定 author=human でコメントを追加する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "comment", task.id, "--body", "テストコメント", "--json"],
      { from: "user" },
    );

    const comments = ctx.deps.store.listComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe("human");
    expect(comments[0]?.body).toBe("テストコメント");
  });

  it("steer は bridge run に agent.message.v1 packet と監査コメントを書き、--wait で message_processed を待つ", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
      ctx.deps.store.block(task.id, "codex-in-progress: 実行中 even-session=sess-bridge", "tester");
      ctx.deps.store.startRun(task.id, "codex", "sess-bridge", {
        serverUrl: "http://127.0.0.1:3456",
        model: "gpt-5.5",
        modelDelivery: "none",
        transport: "bridge",
      });

      setTimeout(() => {
        const steerStore = ctx.deps.store as typeof ctx.deps.store & DurableSteerStore;
        const comments = ctx.deps.store.listComments(task.id);
        const packetComment = comments.find((comment) => comment.body.includes("agent-message-v1"));
        if (packetComment === undefined) {
          return;
        }
        const parsed = parseAgentMessages(packetComment.body).messages[0];
        if (parsed !== undefined) {
          ctx.deps.store.markMessageProcessed(task.id, parsed.idempotencyKey, "supervisor");
          const delivery = steerStore.getSteerDeliveryByMessageKey(parsed.idempotencyKey);
          if (delivery !== null) {
            steerStore.claimSteerDispatch(
              delivery.id,
              delivery.runId,
              delivery.sessionId,
              delivery.expectedCancelFence,
              "supervisor",
            );
            steerStore.markSteerTransportAccepted(
              delivery.id,
              delivery.runId,
              delivery.sessionId,
              delivery.expectedCancelFence,
              "supervisor",
            );
          }
        }
      }, 1_000);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "steer", task.id, "追加指示です", "--wait", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      const result = JSON.parse(ctx.stdout.text()) as {
        processed: boolean;
        delivered: boolean;
        observed: boolean | "unknown";
        acknowledged: boolean | "unknown";
        message: { intent: string; from: { role: string } };
      };
      expect(result.processed).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.observed).toBe("unknown");
      expect(result.acknowledged).toBe("unknown");
      expect(result.message.intent).toBe("steer");
      expect(result.message.from.role).toBe("orchestrator");
      const comments = ctx.deps.store.listComments(task.id);
      expect(comments.some((comment) => comment.body.includes("agent-message-v1"))).toBe(true);
      expect(comments.some((comment) => comment.body.includes("steer 送信: key="))).toBe(true);
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("steer --communication auto はobserve判定を監査しstructured source principalでHachi配送する", async () => {
    ctx = createTestDeps();
    ctx.deps.config.communication = { codex: { rollout: "observe", sameHostOnly: true } };
    const task = ctx.deps.store.createTask(
      { title: "native observe", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(task.id, "codex-in-progress: observe-session", "tester");
    ctx.deps.store.startRun(task.id, "codex", "target-codex-session", {
      transport: "bridge",
      serverUrl: "http://127.0.0.1:3456",
    });
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "steer-source", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "source-codex-session",
    });
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/tmp",
      role: "primary",
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "observe steer",
      "--communication", "auto",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
      "--json",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    const result = JSON.parse(ctx.stdout.text()) as {
      routeDecision: { status: string; route: string; reason: string };
      communicationAttempt: { id: string; status: string; route: string; decisionReason: string };
      delivery: { id: string; status: string };
      message: { from: { provider: string; sessionId: string }; payload: Record<string, unknown> };
    };
    expect(result.routeDecision).toMatchObject({
      status: "deliver",
      route: "hachi",
      reason: "exact-source-binding-missing",
    });
    expect(result.message.from).toEqual({
      role: "orchestrator",
      provider: "codex",
      sessionId: "source-codex-session",
    });
    expect(result.communicationAttempt).toMatchObject({
      status: "recorded",
      route: "hachi",
      decisionReason: "exact-source-binding-missing",
    });
    expect(result.delivery.status).toBe("queued");
    const communicationStore = ctx.deps.store as typeof ctx.deps.store & NativeCommunicationStore;
    expect(communicationStore.listCommunicationAttempts(result.delivery.id)).toEqual([
      expect.objectContaining({ id: result.communicationAttempt.id, steerDeliveryId: expect.any(String) }),
    ]);
    const event = ctx.deps.store.listEvents(task.id, "communication_route_decided").at(-1);
    expect(JSON.parse(event?.payload ?? "{}") as Record<string, unknown>).toMatchObject({
      sourceProvider: "codex",
      sourceSessionId: "source-codex-session",
      preference: "auto",
      decision: { route: "hachi", reason: "exact-source-binding-missing" },
    });
    expect(event?.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });
  });

  it("structured observe steer はprimary task binding無しならdelivery/event/commentsごとrollbackする", async () => {
    ctx = createTestDeps();
    ctx.deps.config.communication = { codex: { rollout: "observe", sameHostOnly: true } };
    const task = ctx.deps.store.createTask(
      { title: "unbound observe", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(task.id, "codex-in-progress: unbound-observe", "tester");
    ctx.deps.store.startRun(task.id, "codex", "target-unbound", { transport: "bridge" });
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "unbound-source", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "source-unbound",
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "must rollback",
      "--communication", "auto",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("active primary binding/watch");
    expect((ctx.deps.store as typeof ctx.deps.store & DurableSteerStore).listSteerDeliveries(task.id)).toHaveLength(0);
    expect((ctx.deps.store as typeof ctx.deps.store & NativeCommunicationStore).listCommunicationAttempts()).toHaveLength(0);
    expect(ctx.deps.store.listEvents(task.id, "communication_route_decided")).toHaveLength(0);
    expect(ctx.deps.store.listEvents(task.id, "communication_route_recorded")).toHaveLength(0);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(0);
  });

  it("steer --communication native はbinding/capability不足をfail-closedにしHachiへfallbackしない", async () => {
    ctx = createTestDeps();
    ctx.deps.config.communication = { codex: { rollout: "on", sameHostOnly: true } };
    const task = ctx.deps.store.createTask(
      { title: "native refuse", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(task.id, "codex-in-progress: native-refuse", "tester");
    ctx.deps.store.startRun(task.id, "codex", "target-native-session", { transport: "bridge" });
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "native-source", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "source-native-session",
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "must not fallback",
      "--communication", "native",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("communication route を選択できません");
    expect(ctx.deps.store.listEvents(task.id, "communication_route_decided")).toHaveLength(0);
    expect((ctx.deps.store as typeof ctx.deps.store & DurableSteerStore).listSteerDeliveries(task.id)).toHaveLength(0);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(0);
  });

  it("steer auto はcross-providerをHachi経路としてdurable recordする", async () => {
    ctx = createTestDeps();
    ctx.deps.config.communication = {
      codex: { rollout: "on", minimumRuntimeVersion: "0.144.1", sameHostOnly: true },
    };
    const task = ctx.deps.store.createTask(
      { title: "cross provider", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(task.id, "codex-in-progress: cross-provider", "tester");
    ctx.deps.store.startRun(task.id, "codex", "target-codex", { transport: "bridge" });
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "claude-source", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: "source-claude",
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "cross provider steer",
      "--communication", "auto",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
      "--json",
    ], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      routeDecision: { route: string; reason: string };
      communicationAttempt: { status: string; route: string; decisionReason: string };
    };
    expect(result.routeDecision).toEqual(expect.objectContaining({ route: "hachi", reason: "cross-provider" }));
    expect(result.communicationAttempt).toMatchObject({ status: "recorded", route: "hachi", decisionReason: "cross-provider" });
    expect((ctx.deps.store as typeof ctx.deps.store & DurableSteerStore).listSteerDeliveries(task.id)).toHaveLength(1);
  });

  it("steer-list/showはcontractのstatusとcurrent targetをそのまま表示しappliedを推測しない", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "steer read", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const run = ctx.deps.store.startRun(task.id, "codex", "session-steer-read", { transport: "bridge" });
    const steerStore = ctx.deps.store as typeof ctx.deps.store & DurableSteerStore;

    const superseded = steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "steer-superseded",
      expectedCancelFence: 0,
      actor: "test",
    });
    steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "steer-current",
      expectedCancelFence: 0,
      supersedesId: superseded.id,
      actor: "test",
    });
    const accepted = steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "steer-accepted",
      expectedCancelFence: 0,
      actor: "test",
    });
    steerStore.claimSteerDispatch(accepted.id, run.id, run.sessionId, 0, "test");
    steerStore.markSteerTransportAccepted(accepted.id, run.id, run.sessionId, 0, "test");
    const acknowledged = steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "steer-acknowledged",
      expectedCancelFence: 0,
      actor: "test",
    });
    steerStore.claimSteerDispatch(acknowledged.id, run.id, run.sessionId, 0, "test");
    steerStore.markSteerTransportAccepted(acknowledged.id, run.id, run.sessionId, 0, "test");
    steerStore.observeSteerDelivery({
      deliveryId: acknowledged.id,
      expectedRunId: run.id,
      expectedSessionId: run.sessionId,
      expectedCancelFence: 0,
      observedMessageId: "message-ack",
      acknowledged: true,
      actor: "test",
    });
    const uncertain = steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey: "steer-uncertain",
      expectedCancelFence: 0,
      actor: "test",
    });
    steerStore.claimSteerDispatch(uncertain.id, run.id, run.sessionId, 0, "test");
    steerStore.markSteerDispatchUncertain(uncertain.id, "token=secret-value", "test");

    await buildProgram(ctx.deps).parseAsync(["task", "steer-list", task.id, "--json"], { from: "user" });
    const raw = ctx.stdout.text();
    const listed = JSON.parse(raw) as {
      taskId: string;
      steerDeliveries: Array<{
        status: string;
        targetState: string;
        lastError: string;
      }>;
    };
    expect(listed.taskId).toBe(task.id);
    expect(listed.steerDeliveries.map((delivery) => delivery.status)).toEqual([
      "superseded",
      "queued",
      "transport_accepted",
      "acknowledged",
      "uncertain",
    ]);
    expect(listed.steerDeliveries.every((delivery) => delivery.targetState === "current")).toBe(true);
    expect(listed.steerDeliveries.at(-1)?.lastError).toBe("token=[REDACTED]");
    expect(raw).not.toContain("secret-value");
    expect(raw).not.toContain("applied");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "steer-list", task.id], { from: "user" });
    const listedText = ctx.stdout.text();
    expect(listedText).toContain("key=steer-accepted");
    expect(listedText).toContain("sequence=3");
    expect(listedText).toContain("status=transport_accepted");
    expect(listedText).toContain(`run=${run.id}`);
    expect(listedText).toContain(`session=${run.sessionId}`);
    expect(listedText).toContain("fence=0/0");
    expect(listedText).toContain("created=");
    expect(listedText).toContain("acknowledged=");
    expect(listedText).not.toContain("applied");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", task.id], { from: "user" });
    const shown = ctx.stdout.text();
    expect(shown).toContain("=== steer deliveries ===");
    expect(shown).toContain("status=transport_accepted");
    expect(shown).toContain("status=acknowledged");
    expect(shown).toContain("status=superseded");
    expect(shown).toContain("target=current");
    expect(shown).not.toContain("applied");
  });

  it("steer-listはreplacement run後のdeliveryをstale_runとしてcurrentと区別する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "steer stale", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const steerStore = ctx.deps.store as typeof ctx.deps.store & DurableSteerStore;
    const firstRun = ctx.deps.store.startRun(task.id, "codex", "session-old", { transport: "bridge" });
    const accepted = steerStore.createOrGetSteerDelivery({
      taskId: task.id,
      runId: firstRun.id,
      sessionId: firstRun.sessionId,
      messageKey: "steer-old",
      expectedCancelFence: 0,
      actor: "test",
    });
    steerStore.claimSteerDispatch(accepted.id, firstRun.id, firstRun.sessionId, 0, "test");
    steerStore.markSteerTransportAccepted(accepted.id, firstRun.id, firstRun.sessionId, 0, "test");
    ctx.deps.store.endRun(firstRun.id, "released");
    const currentRun = ctx.deps.store.startRun(task.id, "codex", "session-new", { transport: "bridge" });

    await buildProgram(ctx.deps).parseAsync(["task", "steer-list", task.id, "--json"], { from: "user" });
    const delivery = (JSON.parse(ctx.stdout.text()) as {
      steerDeliveries: Array<{ targetState: string; currentRunId: number; currentSessionId: string }>;
    }).steerDeliveries[0];
    expect(delivery).toMatchObject({
      targetState: "stale_run",
      currentRunId: currentRun.id,
      currentSessionId: currentRun.sessionId,
    });
  });

  it("steer は direct run を既定拒否し、--restart なら stop/endRun/body prepend/ready を一括実行する", async () => {
    ctx = createTestDeps();
    const direct = new StoppableDummyAdapter("codex");
    ctx.deps.directAdapters = { codex: direct };
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "codex-in-progress: direct 実行中 even-session=direct-1", "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "direct-1", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const actorArgs = executionActorArgs(ctx, "direct-restart", task.id);

    await buildProgram(ctx.deps).parseAsync(["task", "steer", task.id, "途中指示"], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("direct run は実行中プロセスへの steer 注入に対応していません");

    ctx.stdout.clear();
    ctx.stderr.clear();
    ctx.exitCodes.length = 0;
    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "再投入指示", "--restart", ...actorArgs, "--json",
    ], {
      from: "user",
    });

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.body).toContain("## ⚠ オーケストレーター介入");
    expect(updated?.body).toContain("再投入指示");
    expect(ctx.deps.store.getLatestOpenRun(task.id)).toBeNull();
    expect(readRunStatus(ctx, run.id)).toBe("stopped");
    expect(ctx.deps.store.listEvents(task.id, "direct_restart_intent_created")).toHaveLength(1);
    expect(ctx.deps.store.listEvents(task.id, "task_steer_restarted")).toHaveLength(1);
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-1"]);
    const runs = ctx.deps.store.listOpenRuns();
    expect(runs).toHaveLength(0);
    expect(ctx.deps.store.listEvents(task.id).some((event) => event.eventType === "body_updated")).toBe(true);
    expect(ctx.deps.store.listEvents(task.id).some((event) => event.eventType === "status_changed")).toBe(true);
    const comments = ctx.deps.store.listComments(task.id);
    const auditComment = comments.find((comment) => comment.body.includes("direct run を停止し"));
    expect(auditComment?.body).toContain("## ⚠ オーケストレーター介入");
    expect(auditComment?.body).toContain("再投入指示");
    expect(run.status).toBe("running");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("native Codex direct run はexact native evidenceを再構築してrestartではなくdurable steer intentをqueueする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "native direct", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
    const now = Math.floor(Date.now() / 1000);
    const run = ctx.deps.store.startRun(task.id, "codex", "native-codex-session", {
      serverUrl: "direct",
      transport: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      nativeCommunication: {
        route: "codex-app-server",
        providerSessionId: "native-codex-session",
        runtimeVersion: "0.144.1",
        capabilityHash: "a".repeat(64),
        hostId: "host-local",
        observedAt: now - 1,
        expiresAt: now + 300,
        threadId: "thread-native",
        activeTurnId: "turn-native",
        socketSnapshot: {
          canonicalPath: "/private/tmp/codex/app-server.sock",
          parentCanonicalPath: "/private/tmp/codex",
          parentDev: 1,
          parentIno: 2,
          parentUid: 501,
          parentMode: 0o700,
          dev: 3,
          ino: 4,
          uid: 501,
          gid: 20,
          mode: 0o600,
        },
      },
    });
    ctx.deps.store.block(task.id, "codex-in-progress: native direct", "tester");
    ctx.deps.config.communication = {
      codex: { rollout: "on", minimumRuntimeVersion: "0.144.1", sameHostOnly: true },
    };
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "native-source", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId: "native-source-session",
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const actorArgs = [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ];

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "native direct steer", "--communication", "auto", ...actorArgs, "--json",
    ], { from: "user" });

    expect(ctx.exitCodes, ctx.stderr.text()).toEqual([]);
    expect(ctx.deps.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("blocked");
    const steerStore = ctx.deps.store as typeof ctx.deps.store & DurableSteerStore;
    const delivery = steerStore.listSteerDeliveries(task.id);
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.status).toBe("queued");
    const attempts = (ctx.deps.store as typeof ctx.deps.store & NativeCommunicationStore).listCommunicationAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      route: "hachi",
      nativeCandidate: "codex-app-server",
      status: "recorded",
      payload: expect.stringContaining("native direct steer"),
    });
  });

  it("steer --restart は別primary ownerをexternal stop前に拒否する", async () => {
    ctx = createTestDeps();
    const direct = new StoppableDummyAdapter("codex");
    ctx.deps.directAdapters = { codex: direct };
    const task = ctx.deps.store.createTask({
      title: "owned direct",
      body: "cwd: /tmp\nbody",
      tenant: "dev",
      status: "ready",
    }, "tester");
    ctx.deps.store.block(task.id, "codex-in-progress: direct 実行中 even-session=direct-owned", "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "direct-owned", { transport: "direct" });
    const owner = ctx.deps.store.registerOrchestrator({ label: "restart-owner", project: "dev", repoCommonDir: "" });
    ctx.deps.store.startOrchestratorSession({ orchestratorId: owner.id });
    ctx.deps.store.bindTaskToOrchestrator(task.id, owner.id, "primary");
    const challengerArgs = executionActorArgs(ctx, "restart-challenger");

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "越権restart", "--restart", ...challengerArgs,
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("primary orchestrator authority");
    expect(direct.stopCalls).toHaveLength(0);
    expect(ctx.deps.store.getLatestOpenRun(task.id)?.id).toBe(run.id);
    expect(ctx.deps.store.listEvents(task.id, "direct_restart_intent_created")).toHaveLength(0);
  });

  it("steer --restart は direct run が既に終了済みでも run close/body prepend/ready 再投入を続行する", async () => {
    ctx = createTestDeps();
    const direct = new StoppableDummyAdapter("codex");
    direct.stopResult = { stopped: false, reason: "already-exited" };
    ctx.deps.directAdapters = { codex: direct };
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "codex-in-progress: direct 実行中 even-session=direct-exited", "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "direct-exited", {
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    const actorArgs = executionActorArgs(ctx, "direct-restart-exited", task.id);

    await buildProgram(ctx.deps).parseAsync([
      "task", "steer", task.id, "既存終了から再投入", "--restart", ...actorArgs, "--json",
    ], {
      from: "user",
    });

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.body).toContain("既存終了から再投入");
    expect(ctx.deps.store.getLatestOpenRun(task.id)).toBeNull();
    expect(readRunStatus(ctx, run.id)).toBe("stopped");
    expect(ctx.deps.store.listEvents(task.id, "task_steer_restarted")).toHaveLength(1);
    expect(direct.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-exited"]);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("answer は worker-question に agent.message.v1 answer を投稿し状態は messages stage に委ねる", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "worker-question: どちらの仕様で進めますか", "supervisor");

    await buildProgram(ctx.deps).parseAsync(["task", "answer", task.id, "A案で進めてください", "--json"], {
      from: "user",
    });

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("worker-question: どちらの仕様で進めますか");
    expect(updated?.body).toBe("cwd: /tmp\nbody");
    expect(ctx.deps.store.listEvents(task.id, "question_answered")).toHaveLength(0);
    const comments = ctx.deps.store.listComments(task.id);
    const messageComment = comments.find((comment) => comment.body.includes("agent-message-v1"));
    expect(messageComment).toBeDefined();
    const parsed = parseAgentMessages(messageComment!.body);
    expect(parsed.messages[0]?.intent).toBe("answer");
    expect(parsed.messages[0]?.payload).toMatchObject({ message: "A案で進めてください" });
    expect(comments.some((comment) => comment.body.includes("answer 送信: key="))).toBe(true);
  });

  it("answer は transaction 内で worker-question 状態を再検証し、変化していれば上書きしない", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "cwd: /tmp\nbody", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "worker-question: どちらの仕様で進めますか", "supervisor");
    const originalTransaction = ctx.deps.store.transaction.bind(ctx.deps.store);
    let mutated = false;
    vi.spyOn(ctx.deps.store, "transaction").mockImplementation(<T>(fn: () => T): T => {
      if (!mutated) {
        mutated = true;
        ctx.deps.store.updateBlockReason(task.id, "needs-manual: 別経路で回収済み", "other", "human");
      }
      return originalTransaction(fn);
    });

    await buildProgram(ctx.deps).parseAsync(["task", "answer", task.id, "A案で進めてください"], { from: "user" });

    const updated = ctx.deps.store.getTask(task.id);
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("worker-question");
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("needs-manual: 別経路で回収済み");
    expect(updated?.body).toBe("cwd: /tmp\nbody");
    expect(ctx.deps.store.listEvents(task.id, "question_answered")).toHaveLength(0);
  });

  it("attach はファイルを artifacts 配下へ保存し --comment の末尾に保存名を追記する（docs/contract.md §32.1）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const sourcePath = join(ctx.deps.env.home, "source.png");
    const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(sourcePath, sourceBytes);

    await buildProgram(ctx.deps).parseAsync(
      [
        "task",
        "attach",
        task.id,
        "--file",
        sourcePath,
        "--name",
        "screenshot.png",
        "--comment",
        "UI を確認してください",
        "--json",
      ],
      { from: "user" },
    );

    const result = JSON.parse(ctx.stdout.text()) as {
      taskId: string;
      artifact: { name: string; path: string; sizeBytes: number };
      comment: { body: string; author: string };
    };
    const targetPath = join(ctx.deps.env.artifactsDir, task.id, "screenshot.png");
    expect(result.taskId).toBe(task.id);
    expect(result.artifact).toEqual({ name: "screenshot.png", path: targetPath, sizeBytes: sourceBytes.length });
    expect(readFileSync(targetPath)).toEqual(sourceBytes);
    expect(result.comment.body).toBe("UI を確認してください\n\n添付: screenshot.png");
    expect(result.comment.author).toBe("human");
    expect(ctx.deps.store.listEvents(task.id, "artifact_attached")).toHaveLength(1);
  });

  it("attach は current open run の runId/sessionId を event payload に記録する（docs/contract.md §32.5）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const run = ctx.deps.store.startRun(task.id, "codex", "attach-session", { transport: "direct" });
    const sourcePath = join(ctx.deps.env.home, "open-run.png");
    writeFileSync(sourcePath, "png");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "attach", task.id, "--file", sourcePath, "--name", "open-run.png"],
      { from: "user" },
    );

    const event = ctx.deps.store.listEvents(task.id, "artifact_attached")[0];
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({
      name: "open-run.png",
      sizeBytes: 3,
      runId: run.id,
      sessionId: run.sessionId,
    });
  });

  it("attach は current open run が無ければ event payload の runId/sessionId を null にする（docs/contract.md §32.5）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const sourcePath = join(ctx.deps.env.home, "no-open-run.png");
    writeFileSync(sourcePath, "png");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "attach", task.id, "--file", sourcePath, "--name", "no-open-run.png"],
      { from: "user" },
    );

    const event = ctx.deps.store.listEvents(task.id, "artifact_attached")[0];
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({
      name: "no-open-run.png",
      sizeBytes: 3,
      runId: null,
      sessionId: null,
    });
  });

  it("attach はcomment/eventへactive provenanceを伝搬し、authority失敗時はartifactもrollbackする", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const sourcePath = join(ctx.deps.env.home, "evidence.png");
    writeFileSync(sourcePath, "png");
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "attach", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const principal = [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ];

    await buildProgram(ctx.deps).parseAsync([
      "task", "attach", task.id, "--file", sourcePath, "--name", "ok.png",
      "--comment", "evidence", ...principal, "--json",
    ], { from: "user" });
    const expected = {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    } as const;
    expect(ctx.deps.store.listEvents(task.id, "artifact_attached")[0]?.provenance).toEqual(expected);
    expect(ctx.deps.store.listComments(task.id).at(-1)?.provenance).toEqual(expected);

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync([
      "task", "attach", task.id, "--file", sourcePath, "--name", "rollback.png",
      "--comment", "bad", "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation + 1),
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(existsSync(join(ctx.deps.env.artifactsDir, task.id, "rollback.png"))).toBe(false);
    expect(ctx.deps.store.listEvents(task.id, "artifact_attached")).toHaveLength(1);
    expect(ctx.deps.store.listComments(task.id)).toHaveLength(1);
  });

  it("attach はprincipal flagsの構文不整合時にartifactを作らない", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const sourcePath = join(ctx.deps.env.home, "invalid-principal.png");
    writeFileSync(sourcePath, "png");

    await buildProgram(ctx.deps).parseAsync([
      "task", "attach", task.id, "--file", sourcePath, "--name", "orphan.png",
      "--orchestrator", "o_missing_actor_kind",
    ], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(existsSync(join(ctx.deps.env.artifactsDir, task.id, "orphan.png"))).toBe(false);
    expect(ctx.deps.store.listEvents(task.id, "artifact_attached")).toHaveLength(0);
  });

  it("attach は --name 省略時に basename を sanitize して保存する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const sourcePath = join(ctx.deps.env.home, "screen shot.png");
    writeFileSync(sourcePath, "png");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "attach", task.id, "--file", sourcePath, "--json"],
      { from: "user" },
    );

    const result = JSON.parse(ctx.stdout.text()) as { artifact: { name: string } };
    expect(result.artifact.name).toBe("screen_shot.png");
    expect(existsSync(join(ctx.deps.env.artifactsDir, task.id, "screen_shot.png"))).toBe(true);
  });

  it("attach は保存名衝突時に -2 以降の連番を付ける", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const dir = join(ctx.deps.env.artifactsDir, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.png"), "old");
    const sourcePath = join(ctx.deps.env.home, "screen.png");
    writeFileSync(sourcePath, "new");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "attach", task.id, "--file", sourcePath, "--name", "screen.png", "--json"],
      { from: "user" },
    );

    const result = JSON.parse(ctx.stdout.text()) as { artifact: { name: string } };
    expect(result.artifact.name).toBe("screen-2.png");
    expect(readFileSync(join(dir, "screen.png"), "utf8")).toBe("old");
    expect(readFileSync(join(dir, "screen-2.png"), "utf8")).toBe("new");
  });

  it("attach は存在しないタスク・ファイル・不許可拡張子・不正保存名・10MB 超過を fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");
    const pngPath = join(ctx.deps.env.home, "source.png");
    const exePath = join(ctx.deps.env.home, "source.exe");
    const largePath = join(ctx.deps.env.home, "large.png");
    writeFileSync(pngPath, "png");
    writeFileSync(exePath, "exe");
    writeFileSync(largePath, Buffer.alloc(10 * 1024 * 1024 + 1));

    await buildProgram(ctx.deps).parseAsync(["task", "attach", "t_missing", "--file", pngPath], { from: "user" });
    await buildProgram(ctx.deps).parseAsync(["task", "attach", task.id, "--file", join(ctx.deps.env.home, "none.png")], {
      from: "user",
    });
    await buildProgram(ctx.deps).parseAsync(["task", "attach", task.id, "--file", exePath], { from: "user" });
    await buildProgram(ctx.deps).parseAsync(
      ["task", "attach", task.id, "--file", pngPath, "--name", "../evil.png"],
      { from: "user" },
    );
    await buildProgram(ctx.deps).parseAsync(["task", "attach", task.id, "--file", largePath], { from: "user" });

    expect(ctx.exitCodes).toEqual([1, 1, 1, 1, 1]);
    expect(existsSync(join(ctx.deps.env.artifactsDir, task.id))).toBe(false);
  });

  it("block は既知 prefix の reason を受理し blocked へ遷移する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "block", task.id, "--reason", "user-decision: 承認待ちです", "--json"],
      { from: "user" },
    );

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("user-decision: 承認待ちです");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("block は未知 prefix の reason を fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "block", task.id, "--reason", "totally-unknown: だめ"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("未知の block_reason prefix");
    // 状態は変化していないこと
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("ready");
  });

  it("block は codex-in-progress: prefix の reason を fail-closed で拒否する（in-progress は supervisor 専有, docs/contract.md §12.11-2）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "block", task.id, "--reason", "codex-in-progress: 実装中 tmux=none even-session=sess-x"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("codex-in-progress: / claude-in-progress: は指定できません");
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("ready");
  });

  it("block は claude-in-progress: prefix の reason を fail-closed で拒否する（in-progress は supervisor 専有, docs/contract.md §12.11-2）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "block", task.id, "--reason", "claude-in-progress: 実装中 tmux=none even-session=sess-y"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("codex-in-progress: / claude-in-progress: は指定できません");
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("ready");
  });

  it("list --limit に 0 を指定すると fail-closed で拒否される（docs/contract.md §12.8-6）", async () => {
    ctx = createTestDeps();

    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "list", "--limit", "0"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("list --limit に負値を指定すると fail-closed で拒否される（docs/contract.md §12.8-6）", async () => {
    ctx = createTestDeps();

    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "list", "--limit", "-1"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("show --comments / --events に非数値を指定すると fail-closed で拒否される（docs/contract.md §12.8-6）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "show", task.id, "--comments", "abc"], { from: "user" }),
    ).rejects.toThrow();
    await expect(
      buildProgram(ctx.deps).parseAsync(["task", "show", task.id, "--events", "1.5"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("list --limit に正の整数を指定すると通る", async () => {
    ctx = createTestDeps();
    ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "list", "--limit", "1", "--json"], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
  });

  it("list は --limit/--all 省略時に既定 100 件へ制限する（docs/contract.md §12.19-4）", async () => {
    ctx = createTestDeps();
    for (let i = 0; i < 105; i += 1) {
      ctx.deps.store.createTask({ title: `t${i}`, body: "b", tenant: "dev" }, "tester");
    }

    await buildProgram(ctx.deps).parseAsync(["task", "list", "--json"], { from: "user" });
    const listed = (JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] }).tasks;
    expect(listed).toHaveLength(100);
  });

  it("list --status 指定時も --limit/--all 省略時は既定 100 件へ制限する（docs/contract.md §12.19-4）", async () => {
    ctx = createTestDeps();
    for (let i = 0; i < 105; i += 1) {
      ctx.deps.store.createTask({ title: `t${i}`, body: "b", tenant: "dev", status: "ready" }, "tester");
    }

    await buildProgram(ctx.deps).parseAsync(["task", "list", "--status", "ready", "--json"], { from: "user" });
    const listed = (JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] }).tasks;
    expect(listed).toHaveLength(100);
  });

  it("list --all は既定上限を無視して全件返す（docs/contract.md §12.19-4）", async () => {
    ctx = createTestDeps();
    for (let i = 0; i < 105; i += 1) {
      ctx.deps.store.createTask({ title: `t${i}`, body: "b", tenant: "dev" }, "tester");
    }

    await buildProgram(ctx.deps).parseAsync(["task", "list", "--all", "--json"], { from: "user" });
    const listed = (JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] }).tasks;
    expect(listed).toHaveLength(105);
  });

  it("list（--status 無指定）は listRecent（updated_at 降順）で返す（docs/contract.md §12.12-4）", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const oldest = ctx.deps.store.createTask({ title: "oldest", body: "b", tenant: "dev" }, "tester");
      vi.setSystemTime(1_700_000_010_000);
      const newest = ctx.deps.store.createTask({ title: "newest", body: "b", tenant: "dev" }, "tester");

      await buildProgram(ctx.deps).parseAsync(["task", "list", "--json"], { from: "user" });
      const listed = (JSON.parse(ctx.stdout.text()) as { tasks: TaskRow[] }).tasks;
      expect(listed.map((t) => t.id)).toEqual([newest.id, oldest.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await は既に終端の指定タスクを即時に報告する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "done", body: "b", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "review-required: 確認待ち", "tester");
    ctx.deps.store.unblock(task.id, "done", "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "await", task.id, "--json"], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.stdout.text()).toBe(`${JSON.stringify({ id: task.id, status: "done", blockReason: "" })}\n`);
  });

  it("await は指定タスクが待機後に終端へ達したら報告する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask({ title: "ready", body: "b", tenant: "dev", status: "ready" }, "tester");
      setTimeout(() => {
        ctx.deps.store.block(task.id, "review-required: 確認待ち", "tester");
      }, 2_000);

      const promise = buildProgram(ctx.deps).parseAsync(["task", "await", task.id, "--interval", "2"], {
        from: "user",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(ctx.exitCodes).toEqual([]);
      expect(ctx.stdout.text()).toContain(`${task.id} [blocked] blockReason=review-required: 確認待ち`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await は複数 id のうち先に終端へ達したタスクだけを報告する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const first = ctx.deps.store.createTask({ title: "first", body: "b", tenant: "dev", status: "ready" }, "tester");
      const second = ctx.deps.store.createTask({ title: "second", body: "b", tenant: "dev", status: "ready" }, "tester");
      setTimeout(() => {
        ctx.deps.store.block(second.id, "needs-manual: 手動確認", "tester");
      }, 2_000);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", first.id, second.id, "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      const lines = ctx.stdout.text().trim().split("\n").map((line) => JSON.parse(line) as { id: string });
      expect(lines.map((line) => line.id)).toEqual([second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --all は開始時点の稼働集合に固定し途中参加タスクを対象にしない", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const initial = ctx.deps.store.createTask({ title: "initial", body: "b", tenant: "dev", status: "ready" }, "tester");
      const late = ctx.deps.store.createTask({ title: "late", body: "b", tenant: "dev", status: "triage" }, "tester");
      setTimeout(() => {
        ctx.deps.store.transition({ taskId: late.id, to: "ready", actor: "tester", eventType: "status_changed" });
        ctx.deps.store.block(late.id, "needs-manual: 途中参加", "tester");
      }, 2_000);
      setTimeout(() => {
        ctx.deps.store.block(initial.id, "needs-manual: 初期対象", "tester");
      }, 4_000);

      const promise = buildProgram(ctx.deps).parseAsync(["task", "await", "--all", "--interval", "2", "--json"], {
        from: "user",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      const result = JSON.parse(ctx.stdout.text()) as { id: string; blockReason: string };
      expect(result.id).toBe(initial.id);
      expect(result.blockReason).toBe("needs-manual: 初期対象");
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --all は開始時点に稼働タスクが無ければ何も出力せず即時成功する", async () => {
    ctx = createTestDeps();
    ctx.deps.store.createTask({ title: "todo", body: "b", tenant: "dev", status: "todo" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "await", "--all", "--json"], { from: "user" });

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.stdout.text()).toBe("");
  });

  it.each([
    {
      label: "--all 無し",
      args: ["task", "await", "--tenant", "tenant-a", "--json"],
      message: "--tenant は --all とだけ併用できます",
    },
    {
      label: "id 指定",
      args: ["task", "await", "t_0000000000000000", "--tenant", "tenant-a", "--json"],
      message: "--tenant は --all とだけ併用できます",
    },
    {
      label: "空tenant",
      args: ["task", "await", "--all", "--tenant", "   ", "--json"],
      message: "空のtenant",
    },
    {
      label: "NUL tenant",
      args: ["task", "await", "--all", "--tenant", "tenant\0a", "--json"],
      message: "NUL",
    },
  ])("await --tenant は不正な指定をfail-closedに拒否する: $label", async ({ args, message }) => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(args, { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain(message);
  });

  it("await --all --tenant は非存在tenantを受理し対象0件なら即時成功する", async () => {
    ctx = createTestDeps();
    ctx.deps.store.createTask({ title: "outside", body: "b", tenant: "tenant-b", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(
      ["task", "await", "--all", "--tenant", "future-tenant", "--json"],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([]);
    expect(ctx.stdout.text()).toBe("");
  });

  it("await snapshot は反復tenantをORで配送し無指定時に無かったtenant fieldだけを追加する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const tenantA = ctx.deps.store.createTask(
        { title: "tenant-a", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const tenantB = ctx.deps.store.createTask(
        { title: "tenant-b", body: "b", tenant: "tenant-b", status: "ready" },
        "tester",
      );
      const outside = ctx.deps.store.createTask(
        { title: "tenant-c", body: "b", tenant: "tenant-c", status: "ready" },
        "tester",
      );
      setTimeout(() => {
        ctx.deps.store.block(tenantA.id, "review-required: tenant-a", "tester");
        ctx.deps.store.block(tenantB.id, "review-required: tenant-b", "tester");
        ctx.deps.store.block(outside.id, "review-required: tenant-c", "tester");
      }, 500);

      const promise = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", " tenant-b ", "--tenant", "tenant-a",
          "--tenant", "tenant-b", "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      const results = ctx.stdout.text().trim().split("\n").map((line) => JSON.parse(line) as {
        id: string;
        tenant: string;
      });
      expect(results).toHaveLength(2);
      expect(results.map(({ id, tenant }) => ({ id, tenant })).sort((left, right) => left.id.localeCompare(right.id)))
        .toEqual([
          { id: tenantA.id, tenant: "tenant-a" },
          { id: tenantB.id, tenant: "tenant-b" },
        ].sort((left, right) => left.id.localeCompare(right.id)));
      expect(results.some((result) => result.id === outside.id)).toBe(false);
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await snapshot は稼働途中でtenant外へ移った対象を除き残対象の終端まで待つ", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const moved = ctx.deps.store.createTask(
        { title: "moved", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const remaining = ctx.deps.store.createTask(
        { title: "remaining", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      setTimeout(() => {
        const store = ctx.deps.store as unknown as TestStoreWithDb;
        store.db.prepare("UPDATE tasks SET tenant = ? WHERE id = ?").run("tenant-b", moved.id);
        ctx.deps.store.block(moved.id, "review-required: moved", "tester");
      }, 500);
      setTimeout(() => {
        ctx.deps.store.block(remaining.id, "review-required: remaining", "tester");
      }, 2_500);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--tenant", "tenant-a", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: remaining.id,
        status: "blocked",
        blockReason: "review-required: remaining",
        tenant: "tenant-a",
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --all --follow-new は arm 後に ready 化されたタスクの終端を報告する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const late = ctx.deps.store.createTask({ title: "late", body: "b", tenant: "dev", status: "triage" }, "tester");
      setTimeout(() => {
        ctx.deps.store.transition({ taskId: late.id, to: "ready", actor: "tester", eventType: "status_changed" });
      }, 2_000);
      setTimeout(() => {
        ctx.deps.store.block(late.id, "needs-manual: 後発タスク", "tester");
      }, 4_000);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: late.id,
        status: "blocked",
        blockReason: "needs-manual: 後発タスク",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --all --follow-new はポーリング間隔内に ready から終端へ進んだ短命タスクも報告する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const fixture: { task: TaskRow | null } = { task: null };
      setTimeout(() => {
        fixture.task = ctx.deps.store.createTask(
          { title: "short-lived", body: "b", tenant: "dev", status: "ready" },
          "tester",
        );
      }, 500);
      setTimeout(() => {
        if (fixture.task === null) {
          throw new Error("短命タスクが作成されていません");
        }
        ctx.deps.store.block(fixture.task.id, "review-required: 短命タスク", "tester");
      }, 1_000);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      if (fixture.task === null) {
        throw new Error("短命タスクが作成されていません");
      }
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: fixture.task.id,
        status: "blocked",
        blockReason: "review-required: 短命タスク",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --all --follow-new は初期集合が空でも待機し --max-wait 超過で exit 2 にする", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      ctx.deps.store.createTask({ title: "todo", body: "b", tenant: "dev", status: "todo" }, "tester");
      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--interval", "2", "--max-wait", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(ctx.exitCodes).toEqual([2]);
      expect(ctx.stdout.text()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --follow-new は初期0件と除外終端ではreturnせず対象tenantの後発だけを配送する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const tasks: { outside: TaskRow | null; included: TaskRow | null } = {
        outside: null,
        included: null,
      };
      setTimeout(() => {
        tasks.outside = ctx.deps.store.createTask(
          { title: "outside", body: "b", tenant: "tenant-b", status: "ready" },
          "tester",
        );
        ctx.deps.store.block(tasks.outside.id, "review-required: outside", "tester");
      }, 500);
      setTimeout(() => {
        tasks.included = ctx.deps.store.createTask(
          { title: "included", body: "b", tenant: "tenant-a", status: "ready" },
          "tester",
        );
        ctx.deps.store.block(tasks.included.id, "review-required: included", "tester");
      }, 2_500);

      const promise = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      if (tasks.outside === null || tasks.included === null) {
        throw new Error("後発タスクが作成されていません");
      }
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: tasks.included.id,
        status: "blocked",
        blockReason: "review-required: included",
        tenant: "tenant-a",
      });
      expect(ctx.stdout.text()).not.toContain(tasks.outside.id);
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --follow-new は --all 無しでは拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "ready", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "await", task.id, "--follow-new"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--follow-new は --all とだけ併用できます");
  });

  it.each([
    {
      label: "--follow-new 無し",
      args: ["task", "await", "--all", "--cursor-file", "watch.json", "--json"],
      message: "--all --follow-new とだけ併用できます",
    },
    {
      label: "id 指定",
      args: ["task", "await", "t_0000000000000000", "--follow-new", "--cursor-file", "watch.json", "--json"],
      message: "--all --follow-new とだけ併用できます",
    },
    {
      label: "--json 無し",
      args: ["task", "await", "--all", "--follow-new", "--cursor-file", "watch.json"],
      message: "--json が必須です",
    },
  ])("await --cursor-file は不正な併用を拒否する: $label", async ({ args, message }) => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(args, { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain(message);
  });

  it("await --cursor-file の初回armは過去の終端を再生せずcheckpointを待機前に保存する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const past = ctx.deps.store.createTask(
        { title: "past", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      ctx.deps.store.block(past.id, "needs-manual: 過去の終端", "tester");
      const expectedCursor = readTaskEventHighwater(ctx);

      const promise = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "first.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readAwaitCheckpoint(ctx, "first.json")).toEqual({
        schemaVersion: TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId: readBoardInstanceId(ctx.deps.env.dbPath),
        eventCursor: expectedCursor,
        targetIds: [],
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await promise;
      expect(ctx.exitCodes).toEqual([2]);
      expect(ctx.stdout.text()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --cursor-file はv2で全board targetを追跡し除外だけではreturnしない", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const tenantA = ctx.deps.store.createTask(
        { title: "tenant-a", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const tenantB = ctx.deps.store.createTask(
        { title: "tenant-b", body: "b", tenant: "tenant-b", status: "ready" },
        "tester",
      );
      const outside = ctx.deps.store.createTask(
        { title: "outside", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const armedCursor = readTaskEventHighwater(ctx);
      setTimeout(() => {
        const store = ctx.deps.store as unknown as TestStoreWithDb;
        store.db.prepare("UPDATE tasks SET tenant = ? WHERE id = ?").run("tenant-c", outside.id);
        ctx.deps.store.block(outside.id, "review-required: outside", "tester");
      }, 500);
      setTimeout(() => {
        ctx.deps.store.block(tenantA.id, "review-required: tenant-a", "tester");
        ctx.deps.store.block(tenantB.id, "review-required: tenant-b", "tester");
      }, 2_500);

      const promise = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", " tenant-b ", "--tenant", "tenant-a",
          "--tenant", "tenant-b", "--follow-new", "--cursor-file", "tenant-v2.json",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readAwaitCheckpoint(ctx, "tenant-v2.json")).toEqual({
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId: readBoardInstanceId(ctx.deps.env.dbPath),
        eventCursor: armedCursor,
        targetIds: [tenantA.id, tenantB.id, outside.id].sort((left, right) => left.localeCompare(right)),
        tenants: ["tenant-a", "tenant-b"],
        filterRevision: 1,
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      expect(readAwaitCheckpoint(ctx, "tenant-v2.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [tenantA.id, tenantB.id].sort((left, right) => left.localeCompare(right)),
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await promise;
      const results = ctx.stdout.text().trim().split("\n").map((line) => JSON.parse(line) as {
        id: string;
        tenant: string;
        dedupeKey: string;
      });
      expect(results).toHaveLength(2);
      expect(results.map((result) => ({ id: result.id, tenant: result.tenant })))
        .toEqual([
          { id: tenantA.id, tenant: "tenant-a" },
          { id: tenantB.id, tenant: "tenant-b" },
        ]);
      expect(results[0]?.dedupeKey).toMatch(new RegExp(`:${tenantA.id}:e\\d+$`));
      expect(results[1]?.dedupeKey).toMatch(new RegExp(`:${tenantB.id}:e\\d+$`));
      expect(readAwaitCheckpoint(ctx, "tenant-v2.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [],
        tenants: ["tenant-a", "tenant-b"],
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --cursor-file はA配送後の再開で除外Bを消費し後続Aを同じcheckpointから配送する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const firstTenantA = ctx.deps.store.createTask(
        { title: "first-tenant-a", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const excludedTenantB = ctx.deps.store.createTask(
        { title: "excluded-tenant-b", body: "b", tenant: "tenant-b", status: "ready" },
        "tester",
      );
      const secondTenantA = ctx.deps.store.createTask(
        { title: "second-tenant-a", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const boardInstanceId = readBoardInstanceId(ctx.deps.env.dbPath);
      const args = [
        "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
        "--cursor-file", "tenant-a-b-a.json", "--interval", "2", "--json",
      ];

      const firstRun = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(0);
      ctx.deps.store.block(firstTenantA.id, "review-required: first tenant-a", "tester");
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;

      const firstTerminalEventId = requireTaskEventId(
        ctx,
        firstTenantA.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: first tenant-a",
      );
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: firstTenantA.id,
        status: "blocked",
        blockReason: "review-required: first tenant-a",
        tenant: "tenant-a",
        dedupeKey: `${boardInstanceId}:${firstTenantA.id}:e${firstTerminalEventId}`,
      });
      expect(readAwaitCheckpoint(ctx, "tenant-a-b-a.json")).toEqual({
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId,
        eventCursor: firstTerminalEventId,
        targetIds: [excludedTenantB.id, secondTenantA.id].sort((left, right) => left.localeCompare(right)),
        tenants: ["tenant-a"],
        filterRevision: 1,
      });

      ctx.stdout.clear();
      const resumedRun = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(0);
      ctx.deps.store.block(excludedTenantB.id, "review-required: excluded tenant-b", "tester");
      await vi.advanceTimersByTimeAsync(2_000);

      const excludedTerminalEventId = requireTaskEventId(
        ctx,
        excludedTenantB.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: excluded tenant-b",
      );
      expect(ctx.stdout.text()).toBe("");
      expect(readAwaitCheckpoint(ctx, "tenant-a-b-a.json")).toEqual({
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId,
        eventCursor: excludedTerminalEventId,
        targetIds: [secondTenantA.id],
        tenants: ["tenant-a"],
        filterRevision: 1,
      });

      ctx.deps.store.block(secondTenantA.id, "review-required: second tenant-a", "tester");
      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;

      const secondTerminalEventId = requireTaskEventId(
        ctx,
        secondTenantA.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: second tenant-a",
      );
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: secondTenantA.id,
        status: "blocked",
        blockReason: "review-required: second tenant-a",
        tenant: "tenant-a",
        dedupeKey: `${boardInstanceId}:${secondTenantA.id}:e${secondTerminalEventId}`,
      });
      expect(readAwaitCheckpoint(ctx, "tenant-a-b-a.json")).toEqual({
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId,
        eventCursor: secondTerminalEventId,
        targetIds: [],
        tenants: ["tenant-a"],
        filterRevision: 1,
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --cursor-file は異なるtenant集合でcheckpointを変更せず拒否する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
          "--cursor-file", "filter.json", "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;
      const checkpointPath = join(ctx.deps.env.home, "state", "task-await", "filter.json");
      const saved = readFileSync(checkpointPath, "utf8");

      ctx.exitCodes.length = 0;
      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-b", "--follow-new",
          "--cursor-file", "filter.json", "--interval", "2", "--json",
        ],
        { from: "user" },
      );

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("tenantsがopen条件と一致しません");
      expect(readFileSync(checkpointPath, "utf8")).toBe(saved);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --cursor-file は配送候補のtaskを取得できなければcursorを消費せず失敗する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "unknown", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const promise = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
          "--cursor-file", "unknown.json", "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      const saved = readAwaitCheckpoint(ctx, "unknown.json");
      ctx.deps.store.block(task.id, "review-required: unknown", "tester");
      const getTask = ctx.deps.store.getTask.bind(ctx.deps.store);
      vi.spyOn(ctx.deps.store, "getTask").mockImplementation((taskId) =>
        taskId === task.id ? null : getTask(taskId)
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain(`タスクが見つかりません: ${task.id}`);
      expect(readAwaitCheckpoint(ctx, "unknown.json")).toEqual(saved);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file は1ページの複数終端を出力しblock_reason_updated由来のdedupeKeyを使う", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const first = ctx.deps.store.createTask(
        { title: "first", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const second = ctx.deps.store.createTask(
        { title: "second", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      setTimeout(() => {
        ctx.deps.store.block(first.id, "review-required: first", "tester");
        ctx.deps.store.block(second.id, "codex-in-progress: second", "tester");
        ctx.deps.store.updateBlockReason(second.id, "needs-manual: second", "tester");
      }, 500);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--cursor-file", "multi.json", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      const firstEventId = requireTaskEventId(
        ctx,
        first.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: first",
      );
      const secondEventId = requireTaskEventId(
        ctx,
        second.id,
        "block_reason_updated",
        (payload) => payload["reason"] === "needs-manual: second",
      );
      const boardInstanceId = readBoardInstanceId(ctx.deps.env.dbPath);
      const results = ctx.stdout.text().trim().split("\n").map((line) => JSON.parse(line) as {
        id: string;
        status: string;
        blockReason: string;
        dedupeKey: string;
      });
      expect(results).toEqual([
        {
          id: first.id,
          status: "blocked",
          blockReason: "review-required: first",
          dedupeKey: `${boardInstanceId}:${first.id}:e${firstEventId}`,
        },
        {
          id: second.id,
          status: "blocked",
          blockReason: "needs-manual: second",
          dedupeKey: `${boardInstanceId}:${second.id}:e${secondEventId}`,
        },
      ]);
      expect(readAwaitCheckpoint(ctx, "multi.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file はstdoutがページ途中で失敗したらcheckpointを前進させない", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const first = ctx.deps.store.createTask(
        { title: "first", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const second = ctx.deps.store.createTask(
        { title: "second", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const armedCursor = readTaskEventHighwater(ctx);
      const successfulWrites: string[] = [];
      let writeCount = 0;
      ctx.deps.stdout = {
        write(text: string, callback?: (error?: Error | null) => void): void {
          writeCount += 1;
          if (writeCount === 2) {
            callback?.(new Error("stdout test failure"));
            return;
          }
          successfulWrites.push(text);
          callback?.();
        },
      };
      setTimeout(() => {
        ctx.deps.store.block(first.id, "needs-manual: first", "tester");
        ctx.deps.store.block(second.id, "needs-manual: second", "tester");
      }, 500);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--cursor-file", "crash.json", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(writeCount).toBe(2);
      expect(successfulWrites).toHaveLength(1);
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("stdout test failure");
      expect(readAwaitCheckpoint(ctx, "crash.json")).toMatchObject({
        eventCursor: armedCursor,
        targetIds: [first.id, second.id].sort((left, right) => left.localeCompare(right)),
      });
    } finally {
      vi.useRealTimers();
    }
  });


  it.each([
    ["--include-orchestrator", "missing"],
    ["t_missing", "--include-orchestrator", "missing"],
    ["--all", "t_missing", "--include-orchestrator", "missing"],
    ["--all", "--include-orchestrator", "   "],
    ["--all", "--include-orchestrator", "bad\0id"],
    ["--all", "--include-orchestrator", "missing"],
    ["--all", "--follow-new", "--cursor-file", "unknown.json", "--json", "--include-orchestrator", "missing"],
  ])("await 担当引数を副作用前に拒否する: %j", async (...args) => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["task", "await", ...args], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stdout.text()).toBe("");
    expect(existsSync(join(ctx.deps.env.home, "state", "task-await"))).toBe(false);
  });

  it("await 未知担当は候補が存在してもcheckpoint作成前に拒否する", async () => {
    ctx = createTestDeps();
    ctx.deps.store.createTask({ title: "ready", body: "b", tenant: "a", status: "ready" }, "tester");
    await buildProgram(ctx.deps).parseAsync([
      "task", "await", "--all", "--tenant", "a", "--include-orchestrator", "missing",
      "--follow-new", "--cursor-file", "unknown.json", "--json",
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("未知のorchestrator identity");
    expect(ctx.stdout.text()).toBe("");
    expect(existsSync(join(ctx.deps.env.home, "state", "task-await"))).toBe(false);
  });

  it.each(["snapshot", "follow", "checkpoint"] as const)(
    "await 担当ORの両枝・重複なし・現在bindingとobserver/released watchを実配送する: %s",
    async (mode) => {
      ctx = createTestDeps();
      vi.useFakeTimers();
      try {
        const store = ctx.deps.store;
        const owner = store.registerOrchestrator({ label: "owner", project: "hachi", repoCommonDir: ctx.deps.env.home }).id;
        const observer = store.registerOrchestrator({ label: "observer", project: "hachi", repoCommonDir: ctx.deps.env.home }).id;
        store.addOrchestratorWatch({ orchestratorId: owner, scope: "worktree", selector: ctx.deps.env.home, role: "primary" });
        const make = (title: string, tenant: string): TaskRow => store.createTask(
          { title, tenant, body: `cwd: ${ctx.deps.env.home}`, status: "ready" }, "tester",
        );
        const tenant = make("tenant", "a");
        const scoped = make("scoped", "b");
        const both = make("both", "a");
        const outside = make("observer suppresses watch", "b");
        const released = make("released restores watch", "b");
        store.bindTaskToOrchestrator(tenant.id, observer, "observer");
        store.bindTaskToOrchestrator(scoped.id, owner, "primary");
        store.bindTaskToOrchestrator(both.id, owner, "collaborator");
        store.bindTaskToOrchestrator(outside.id, observer, "observer");
        store.bindTaskToOrchestrator(released.id, owner, "primary");
        const args = ["task", "await", "--all", "--tenant", " a ", "--include-orchestrator", ` ${owner} `, "--interval", "2", "--json"];
        if (mode !== "snapshot") args.push("--follow-new");
        if (mode === "checkpoint") args.push("--cursor-file", "or.json");
        const run = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
        await vi.advanceTimersByTimeAsync(0);
        // 待機中にbindingを解放し、watchへ戻る現在値を配送時に読む。
        const fixture = store as unknown as TestStoreWithDb;
        fixture.db.prepare("UPDATE task_orchestrator_bindings SET released_at = 1 WHERE task_id = ?").run(released.id);
        store.block(outside.id, "review-required: excluded", "tester");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ctx.stdout.text()).toBe("");
        for (const task of [tenant, scoped, both, released]) store.block(task.id, "review-required: included", "tester");
        await vi.advanceTimersByTimeAsync(2_000);
        await run;
        const rows = ctx.stdout.text().trim().split("\n").map((line: string): { id: string; tenant: string } => JSON.parse(line) as { id: string; tenant: string });
        expect(rows.map((row) => row.id).sort()).toEqual([tenant.id, scoped.id, both.id, released.id].sort());
        expect(rows.every((row) => row.tenant === "a" || row.tenant === "b")).toBe(true);
        expect(ctx.exitCodes).toEqual([]);
        if (mode === "checkpoint") expect(readAwaitCheckpoint(ctx, "or.json")).toMatchObject({
          schemaVersion: "task-await-checkpoint.v3", tenants: ["a"], orchestratorId: owner, filterRevision: 1,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["snapshot", "follow", "fallback", "checkpoint"] as const)(
    "await 担当単独は全件一致にせず待機中のscope変更を判定する: %s",
    async (mode) => {
      ctx = createTestDeps();
      vi.useFakeTimers();
      try {
        const store = ctx.deps.store;
        const owner = store.registerOrchestrator({ label: "owner", project: "hachi", repoCommonDir: ctx.deps.env.home }).id;
        const make = (title: string): TaskRow => store.createTask({ title, tenant: "b", body: "b", status: "ready" }, "tester");
        const removed = make("removed");
        const included = make("included");
        const outside = make("outside");
        store.bindTaskToOrchestrator(removed.id, owner, "primary");
        store.bindTaskToOrchestrator(included.id, owner, "primary");
        const args = ["task", "await", "--all", "--include-orchestrator", owner, "--interval", "2", "--json"];
        if (mode !== "snapshot") args.push("--follow-new");
        if (mode === "checkpoint") args.push("--cursor-file", "solo.json");
        const run = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
        await vi.advanceTimersByTimeAsync(0);
        const fixture = store as unknown as TestStoreWithDb;
        fixture.db.prepare("UPDATE task_orchestrator_bindings SET released_at = 1 WHERE task_id = ?").run(removed.id);
        store.block(removed.id, "review-required: removed", "tester");
        store.block(outside.id, "review-required: outside", "tester");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ctx.stdout.text()).toBe("");
        if (mode === "fallback") {
          fixture.db.prepare("UPDATE tasks SET status = 'blocked', block_reason = 'review-required: fallback' WHERE id = ?").run(included.id);
        } else {
          store.block(included.id, "review-required: included", "tester");
        }
        await vi.advanceTimersByTimeAsync(2_000);
        await run;
        expect(JSON.parse(ctx.stdout.text())).toMatchObject({ id: included.id, tenant: "b" });
        expect(ctx.exitCodes).toEqual([]);
        if (mode === "checkpoint") expect(readAwaitCheckpoint(ctx, "solo.json")).toMatchObject({
          schemaVersion: "task-await-checkpoint.v3", tenants: [], orchestratorId: owner, filterRevision: 1,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])("await 担当指定は既存v1/v2を暗黙upgradeしない: tenant=%s", async (tenant) => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const owner = ctx.deps.store.registerOrchestrator({
        label: "owner", project: "hachi", repoCommonDir: ctx.deps.env.home,
      }).id;
      const args = ["task", "await", "--all", "--follow-new", "--cursor-file", "legacy-or.json", "--json", "--max-wait", "1"];
      if (tenant) args.push("--tenant", "a");
      const run = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(1_000);
      await run;
      const file = join(ctx.deps.env.home, "state", "task-await", "legacy-or.json");
      const saved = readFileSync(file);
      ctx.exitCodes.length = 0;
      await buildProgram(ctx.deps).parseAsync([...args, "--include-orchestrator", owner], { from: "user" });
      expect(ctx.exitCodes).toEqual([1]);
      expect(readFileSync(file)).toEqual(saved);
      expect(ctx.stdout.text()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("await v3は同条件resumeのA→除外B→後発Aとstdout失敗未進行を維持する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const store = ctx.deps.store;
      const owner = store.registerOrchestrator({ label: "owner", project: "hachi", repoCommonDir: ctx.deps.env.home }).id;
      const other = store.registerOrchestrator({ label: "other", project: "hachi", repoCommonDir: ctx.deps.env.home }).id;
      const args = ["task", "await", "--all", "--include-orchestrator", owner, "--follow-new", "--cursor-file", "resume-or.json", "--interval", "2", "--json"];
      const make = (title: string, scoped: boolean): TaskRow => {
        const task = store.createTask({ title, tenant: "b", body: "b", status: "ready" }, "tester");
        if (scoped) store.bindTaskToOrchestrator(task.id, owner, "primary");
        return task;
      };
      const first = make("A1", true);
      const firstRun = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(0);
      store.block(first.id, "review-required: first", "tester");
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;
      const saved = readAwaitCheckpoint(ctx, "resume-or.json");
      const file = join(ctx.deps.env.home, "state", "task-await", "resume-or.json");
      const bytes = readFileSync(file);
      for (const changed of [
        args.map((arg) => arg === owner ? other : arg),
        [...args, "--tenant", "a"],
        args.filter((arg) => arg !== "--include-orchestrator" && arg !== owner),
        [...args.filter((arg) => arg !== "--include-orchestrator" && arg !== owner), "--tenant", "a"],
      ]) {
        ctx.exitCodes.length = 0;
        await buildProgram(ctx.deps).parseAsync(changed, { from: "user" });
        expect(ctx.exitCodes).toEqual([1]);
        expect(readFileSync(file)).toEqual(bytes);
      }
      ctx.exitCodes.length = 0;
      ctx.stdout.clear();
      const resumed = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(0);
      const excluded = make("B", false);
      store.block(excluded.id, "review-required: excluded", "tester");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      const afterExcluded = readAwaitCheckpoint(ctx, "resume-or.json");
      expect(afterExcluded.eventCursor).toBeGreaterThan(saved.eventCursor);
      expect(afterExcluded.targetIds).not.toContain(excluded.id);
      const later = make("A2", true);
      store.block(later.id, "review-required: later", "tester");
      const stdout = ctx.deps.stdout;
      ctx.deps.stdout = { write(_text: string, callback?: (error?: Error | null) => void): void { callback?.(new Error("OR stdout failure")); } };
      await vi.advanceTimersByTimeAsync(2_000);
      await resumed;
      expect(ctx.exitCodes).toEqual([1]);
      expect(readAwaitCheckpoint(ctx, "resume-or.json")).toEqual(afterExcluded);
      ctx.deps.stdout = stdout;
      ctx.exitCodes.length = 0;
      const replay = buildProgram(ctx.deps).parseAsync(args, { from: "user" });
      await vi.advanceTimersByTimeAsync(2_000);
      await replay;
      const eventId = requireTaskEventId(ctx, later.id, "status_changed", (payload) => payload["reason"] === "review-required: later");
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: later.id, status: "blocked", blockReason: "review-required: later", tenant: "b",
        dedupeKey: `${readBoardInstanceId(ctx.deps.env.dbPath)}:${later.id}:e${eventId}`,
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --tenant --cursor-file はstdout失敗後もv2 checkpointから同じdedupeKeyで再armする", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "tenant-crash", body: "b", tenant: "tenant-a", status: "ready" },
        "tester",
      );
      const captureStdout = ctx.deps.stdout;
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
          "--cursor-file", "tenant-crash.json", "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      const saved = readAwaitCheckpoint(ctx, "tenant-crash.json");
      ctx.deps.stdout = {
        write(_text: string, callback?: (error?: Error | null) => void): void {
          callback?.(new Error("tenant stdout failure"));
        },
      };
      ctx.deps.store.block(task.id, "review-required: replay", "tester");

      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;
      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain("tenant stdout failure");
      expect(readAwaitCheckpoint(ctx, "tenant-crash.json")).toEqual(saved);

      ctx.deps.stdout = captureStdout;
      ctx.exitCodes.length = 0;
      ctx.stderr.clear();
      ctx.stdout.clear();
      const resumedRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--tenant", "tenant-a", "--follow-new",
          "--cursor-file", "tenant-crash.json", "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;

      const terminalEventId = requireTaskEventId(
        ctx,
        task.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: replay",
      );
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: task.id,
        status: "blocked",
        blockReason: "review-required: replay",
        tenant: "tenant-a",
        dedupeKey: `${readBoardInstanceId(ctx.deps.env.dbPath)}:${task.id}:e${terminalEventId}`,
      });
      expect(readAwaitCheckpoint(ctx, "tenant-crash.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [],
        tenants: ["tenant-a"],
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file は同一ページの終端から再走行を挟む最後の終端eventをdedupeKeyにする", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "rerun", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      setTimeout(() => {
        ctx.deps.store.block(task.id, "needs-manual: first", "tester");
        ctx.deps.store.unblock(task.id, "ready", "tester");
        ctx.deps.store.block(task.id, "review-required: second", "tester");
      }, 500);

      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--cursor-file", "rerun.json", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      const lastTerminalEventId = requireTaskEventId(
        ctx,
        task.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: second",
      );
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: task.id,
        status: "blocked",
        blockReason: "review-required: second",
        dedupeKey: `${readBoardInstanceId(ctx.deps.env.dbPath)}:${task.id}:e${lastTerminalEventId}`,
      });
      expect(readAwaitCheckpoint(ctx, "rerun.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file の再開は保存cursorの接頭辞を維持してarm稼働集合を待機対象へ合併する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const storedTarget = ctx.deps.store.createTask(
        { title: "stored", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "resume.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;
      const saved = readAwaitCheckpoint(ctx, "resume.json");
      expect(ctx.exitCodes).toEqual([2]);

      ctx.exitCodes.length = 0;
      ctx.stdout.clear();
      ctx.deps.store.block(storedTarget.id, "needs-manual: stored", "tester");
      const armedTarget = ctx.deps.store.createTask(
        { title: "armed", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      setTimeout(() => {
        ctx.deps.store.block(armedTarget.id, "review-required: armed", "tester");
      }, 1_000);

      const resumedRun = buildProgram(ctx.deps).parseAsync(
        ["task", "await", "--all", "--follow-new", "--cursor-file", "resume.json", "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readAwaitCheckpoint(ctx, "resume.json")).toMatchObject({
        eventCursor: saved.eventCursor,
        targetIds: saved.targetIds,
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;
      const results = ctx.stdout.text().trim().split("\n").map((line) => JSON.parse(line) as { id: string });
      expect(results.map((result) => result.id)).toEqual([storedTarget.id, armedTarget.id]);
      expect(readAwaitCheckpoint(ctx, "resume.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [],
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file の再開は非稼働間の遷移を終端報告せず本物の終端だけを報告する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const dormant = ctx.deps.store.createTask(
        { title: "dormant", body: "b", tenant: "dev", status: "triage" },
        "tester",
      );
      const running = ctx.deps.store.createTask(
        { title: "running", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "non-running.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;
      const saved = readAwaitCheckpoint(ctx, "non-running.json");
      expect(saved.targetIds).toEqual([running.id]);

      ctx.exitCodes.length = 0;
      ctx.stdout.clear();
      ctx.deps.store.transition({ taskId: dormant.id, to: "todo", actor: "tester" });
      ctx.deps.store.transition({ taskId: dormant.id, to: "triage", actor: "tester" });
      ctx.deps.store.transition({ taskId: dormant.id, to: "todo", actor: "tester" });
      ctx.deps.store.transition({ taskId: dormant.id, to: "ready", actor: "tester" });
      setTimeout(() => {
        ctx.deps.store.block(running.id, "review-required: real terminal", "tester");
      }, 1_000);

      const resumedRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "non-running.json",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readAwaitCheckpoint(ctx, "non-running.json")).toEqual(saved);

      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;
      const terminalEventId = requireTaskEventId(
        ctx,
        running.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: real terminal",
      );
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: running.id,
        status: "blocked",
        blockReason: "review-required: real terminal",
        dedupeKey: `${readBoardInstanceId(ctx.deps.env.dbPath)}:${running.id}:e${terminalEventId}`,
      });
      expect(readAwaitCheckpoint(ctx, "non-running.json")).toMatchObject({
        eventCursor: readTaskEventHighwater(ctx),
        targetIds: [dormant.id],
      });
      expect(ctx.exitCodes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file の再生経路は壊れた status_changed payload を読み飛ばさず失敗する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "invalid-replay", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "invalid-replay.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;

      ctx.exitCodes.length = 0;
      ctx.stderr.clear();
      ctx.deps.store.block(task.id, "review-required: invalid replay", "tester");
      const eventId = requireTaskEventId(
        ctx,
        task.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: invalid replay",
      );
      const store = ctx.deps.store as unknown as TestStoreWithDb;
      store.db.prepare("UPDATE task_events SET payload = ? WHERE id = ?").run("{", eventId);

      const resumedRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "invalid-replay.json",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain(
        `task await が終端イベントを解釈できません: task=${task.id} event=${eventId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file のスナップショット経路も壊れた status_changed payload で同じく失敗する", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "invalid-snapshot", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "invalid-snapshot.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;

      ctx.exitCodes.length = 0;
      ctx.stderr.clear();
      ctx.deps.store.block(task.id, "review-required: invalid snapshot", "tester");
      const eventId = requireTaskEventId(
        ctx,
        task.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: invalid snapshot",
      );
      const store = ctx.deps.store as unknown as TestStoreWithDb;
      store.db.prepare("UPDATE task_events SET payload = ? WHERE id = ?").run("{", eventId);
      const checkpoint = readAwaitCheckpoint(ctx, "invalid-snapshot.json");
      writeFileSync(
        join(ctx.deps.env.home, "state", "task-await", "invalid-snapshot.json"),
        `${JSON.stringify({ ...checkpoint, eventCursor: eventId })}\n`,
      );

      const resumedRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "invalid-snapshot.json",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;

      expect(ctx.exitCodes).toEqual([1]);
      expect(ctx.stderr.text()).toContain(
        `task await が終端イベントを解釈できません: task=${task.id} event=${eventId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("await --cursor-file の再生経路は無関係なイベント種別を従来どおり読み飛ばす", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask(
        { title: "unrelated-event", body: "b", tenant: "dev", status: "ready" },
        "tester",
      );
      const firstRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "unrelated.json",
          "--interval", "2", "--max-wait", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await firstRun;

      ctx.exitCodes.length = 0;
      ctx.stdout.clear();
      ctx.deps.store.addEvent(task.id, "custom_event", "tester", { ignored: true });
      ctx.deps.store.block(task.id, "review-required: after unrelated", "tester");

      const resumedRun = buildProgram(ctx.deps).parseAsync(
        [
          "task", "await", "--all", "--follow-new", "--cursor-file", "unrelated.json",
          "--interval", "2", "--json",
        ],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await resumedRun;

      const terminalEventId = requireTaskEventId(
        ctx,
        task.id,
        "status_changed",
        (payload) => payload["reason"] === "review-required: after unrelated",
      );
      expect(ctx.exitCodes).toEqual([]);
      expect(JSON.parse(ctx.stdout.text())).toEqual({
        id: task.id,
        status: "blocked",
        blockReason: "review-required: after unrelated",
        dedupeKey: `${readBoardInstanceId(ctx.deps.env.dbPath)}:${task.id}:e${terminalEventId}`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("await は --max-wait 超過時に何も出力せず exit 2 にする", async () => {
    ctx = createTestDeps();
    vi.useFakeTimers();
    try {
      const task = ctx.deps.store.createTask({ title: "ready", body: "b", tenant: "dev", status: "ready" }, "tester");
      const promise = buildProgram(ctx.deps).parseAsync(
        ["task", "await", task.id, "--interval", "2", "--max-wait", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(ctx.exitCodes).toEqual([2]);
      expect(ctx.stdout.text()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel はactive orchestrator generationからdurable requestを作りnonceを出力しない", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      await buildProgram(ctx.deps).parseAsync(
        ["task", "cancel", fixture.task.id, "--reason", "安全に停止", "--grace", "30", ...fixture.args, "--json"],
        { from: "user" },
      );
    } finally {
      vi.useRealTimers();
    }

    const raw = ctx.stdout.text();
    const body = JSON.parse(raw) as {
      created: boolean;
      cancel: { status: string; deadlineAt: number; delivered: string; observed: string; acknowledged: string; stopped: string };
    };
    expect(body.created).toBe(true);
    expect(body.cancel).toMatchObject({
      status: "cancel_requested",
      deadlineAt: 1_700_000_030,
      delivered: "no",
      observed: "unknown",
      acknowledged: "no",
      stopped: "no",
    });
    expect(raw).not.toContain("requestNonce");
    expect(raw).not.toContain("acknowledgedNonce");
    expect(ctx.deps.store.listRunCancelRequests(fixture.task.id)).toHaveLength(1);
    const view = createKanbanReadView(ctx.deps.env.dbPath);
    try {
    expect(view.cancelRequests(fixture.task.id)).toHaveLength(1);
      expect(view.cancelRequests(fixture.task.id)[0]?.status).toBe("cancel_requested");
    } finally {
      view.close();
    }

    ctx.deps.store.addEvent(fixture.task.id, "cancel_failed", "test", {
      nested: {
        values: [
          "Authorization: Bearer cli-event-secret",
          "/Users/private/Application Support/cancel/cli-event-token suffix",
        ],
      },
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", fixture.task.id, "--json"], { from: "user" });
    const shown = JSON.parse(ctx.stdout.text()) as { cancelRequests: Array<{ requestId: string }> };
    expect(shown.cancelRequests).toHaveLength(1);
    expect(ctx.stdout.text()).not.toContain("requestNonce");
    expect(ctx.stdout.text()).toContain("[REDACTED]");
    expect(ctx.stdout.text()).toContain("[REDACTED_PATH]");
    expect(ctx.stdout.text()).not.toContain("cli-event-secret");
    expect(ctx.stdout.text()).not.toContain("cli-event-token");

    for (const command of [["cancel-status", fixture.task.id], ["show", fixture.task.id]]) {
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync(["task", ...command], { from: "user" });
      const text = ctx.stdout.text();
      expect(text).toContain(`requester=${fixture.orchestratorId}/${fixture.requesterSessionId}`);
      expect(text).toContain(`generation=${fixture.generation}`);
      expect(text).toContain("deadline=1700000030");
      expect(text).toContain("reason=安全に停止");
      expect(text).toContain("capability={}");
      expect(text).toContain("stopEvidence={}");
      expect(text).toContain("lastError=-");
      expect(text).not.toContain("requestNonce");
    }
  });

  it("cancel の expected run/session は単独指定と併用の一致を受理する", async () => {
    ctx = createTestDeps();
    const fixtures = [
      createCancelableFixture(ctx, "expect-run"),
      createCancelableFixture(ctx, "expect-session"),
      createCancelableFixture(ctx, "expect-both"),
    ];
    const expectedArgs = [
      ["--expect-run", String(fixtures[0]!.runId)],
      ["--expect-session", fixtures[1]!.sessionId],
      [
        "--expect-run", String(fixtures[2]!.runId),
        "--expect-session", fixtures[2]!.sessionId,
      ],
    ];

    for (const [index, fixture] of fixtures.entries()) {
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync([
        "task", "cancel", fixture.task.id, "--reason", "対象一致", ...expectedArgs[index]!, ...fixture.args, "--json",
      ], { from: "user" });
      expect(JSON.parse(ctx.stdout.text())).toMatchObject({ created: true, targetMatched: "yes" });
      expect(ctx.deps.store.listRunCancelRequests(fixture.task.id)).toHaveLength(1);
    }
    expect(ctx.exitCodes).toEqual([]);
  });

  it("cancel の expected target 不一致は exit 1 と matched=no を返し DB に request を作らない", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "expect-mismatch");
    ctx.deps.store.endRun(fixture.runId, "released");
    ctx.deps.store.startRun(fixture.task.id, "codex", "worker-replacement", {
      transport: "direct",
      serverUrl: "direct",
    });

    await buildProgram(ctx.deps).parseAsync([
      "task", "cancel", fixture.task.id, "--reason", "警告対象だけ停止",
      "--expect-run", String(fixture.runId), "--expect-session", fixture.sessionId,
      ...fixture.args, "--json",
    ], { from: "user" });

    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      created: false,
      cancel: null,
      targetMatched: "no",
      expectedRunId: fixture.runId,
      expectedSessionId: fixture.sessionId,
    });
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.deps.store.listRunCancelRequests(fixture.task.id)).toHaveLength(0);
    const view = createKanbanReadView(ctx.deps.env.dbPath);
    try {
      expect(view.cancelRequests(fixture.task.id)).toHaveLength(0);
    } finally {
      view.close();
    }
    expect(ctx.deps.store.listEvents(fixture.task.id, "cancel_requested")).toHaveLength(0);
  });

  it("cancel --force-if-supported はgraceなしで作成し、capabilityなしでも停止済みを偽装しない", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "force");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_100_000);
      await buildProgram(ctx.deps).parseAsync(
        ["task", "cancel", fixture.task.id, "--reason", "即時停止", "--force-if-supported", ...fixture.args, "--json"],
        { from: "user" },
      );
    } finally {
      vi.useRealTimers();
    }
    const body = JSON.parse(ctx.stdout.text()) as {
      forceIfSupported: boolean;
      cancel: { deadlineAt: number; stopped: string };
    };
    expect(body.forceIfSupported).toBe(true);
    expect(body.cancel.deadlineAt).toBe(1_700_000_100);
    expect(body.cancel.stopped).toBe("no");

    const second = createCancelableFixture(ctx, "force-grace");
    ctx.stdout.clear();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_200_000);
      await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel", second.task.id, "--reason", "grace後停止", "--force-if-supported", "--grace", "5",
        ...second.args,
      ],
      { from: "user" },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(ctx.deps.store.listRunCancelRequests(second.task.id)[0]?.deadlineAt).toBe(1_700_000_205);
  });

  it("cancel-host-stopは既定dry-runで、confirm時だけfenced cancel/run/taskをhost証拠付きで収束する", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "bridge generationを停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    const command = [
      "task", "cancel-host-stop", fixture.task.id,
      "--request", request.id,
      "--evidence-id", "launchctl:bootout:ok",
      "--process-generation", "launchctl:pid-94017",
      ...fixture.args,
      "--json",
    ];

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(command, { from: "user" });
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({ dryRun: true, requestId: request.id, runId: fixture.runId });
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
    expect(readRunStatus(ctx, fixture.runId)).toBe("running");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(command.slice(0, -1), { from: "user" });
    expect(ctx.stdout.text()).toContain(`run=${fixture.runId}`);
    expect(ctx.stdout.text()).toContain(`session=${fixture.sessionId}`);
    expect(ctx.stdout.text()).toContain(`fence=${request.cancelFence}`);
    expect(ctx.stdout.text()).toContain("processGeneration=launchctl:pid-94017");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([...command.slice(0, -1), "--confirm", "--json"], { from: "user" });
    const output = JSON.parse(ctx.stdout.text()) as {
      dryRun: boolean;
      cancel: { status: string; stopped: string; stopEvidence: string };
      task: TaskRow;
    };
    expect(output.dryRun).toBe(false);
    expect(output.cancel.status).toBe("stopped");
    expect(output.cancel.stopped).toBe("yes");
    expect(JSON.parse(output.cancel.stopEvidence)).toMatchObject({
      source: "host-process-generation",
      evidenceId: "launchctl:bootout:ok",
      processGeneration: "launchctl:pid-94017",
      runId: fixture.runId,
    });
    expect(readRunStatus(ctx, fixture.runId)).toBe("failed");
    expect(readRunMeta(ctx, fixture.runId)).toMatchObject({
      transport: "bridge",
      serverUrl: "http://127.0.0.1:3456",
      cancelRecovery: { cancelRequestId: request.id, cancelFence: request.cancelFence },
    });
    expect(output.task.blockReason).toContain("needs-manual: cancel stopped");
    expect(ctx.deps.store.listEvents(fixture.task.id, "cancel_host_stop_attested")[0]?.provenance).toMatchObject({
      kind: "orchestrator",
      actorId: fixture.orchestratorId,
      actorSessionId: fixture.requesterSessionId,
      actorGeneration: fixture.generation,
    });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync([...command.slice(0, -1), "--confirm", "--json"], { from: "user" });
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("in-progress");
    expect(ctx.deps.store.listRunCancelRequests(fixture.task.id)).toHaveLength(1);
    expect(ctx.deps.store.listEvents(fixture.task.id, "cancel_host_stop_attested")).toHaveLength(1);
  });

  it.each(["run", "session", "provider", "fence"] as const)(
    "cancel-host-stopはdry-run後の%s driftをconfirm時に拒否する",
    async (drift) => {
      ctx = createTestDeps();
      const fixture = createBridgeCancelableFixture(ctx, `host-stop-drift-${drift}`);
      await buildProgram(ctx.deps).parseAsync(
        ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
        { from: "user" },
      );
      const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
      const command = [
        "task", "cancel-host-stop", fixture.task.id,
        "--request", request.id,
        "--evidence-id", `drift:${drift}`,
        "--process-generation", "generation:before-drift",
        ...fixture.args,
        "--json",
      ];
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync(command, { from: "user" });
      expect(JSON.parse(ctx.stdout.text())).toMatchObject({ dryRun: true, requestId: request.id });

      const store = ctx.deps.store as unknown as TestStoreWithDb;
      if (drift === "run") {
        ctx.deps.store.endRun(fixture.runId, "failed");
        ctx.deps.store.startRun(fixture.task.id, "codex", "replacement-session", {
          transport: "bridge",
          serverUrl: "http://127.0.0.1:3456",
        });
      } else if (drift === "session") {
        store.db.prepare(`UPDATE task_runs SET session_id = ? WHERE id = ?`).run("drifted-session", fixture.runId);
      } else if (drift === "provider") {
        store.db.prepare(`UPDATE task_runs SET provider = ? WHERE id = ?`).run("claude", fixture.runId);
      } else {
        const transaction = ctx.deps.store.transaction.bind(ctx.deps.store);
        vi.spyOn(ctx.deps.store, "transaction").mockImplementationOnce(<T>(fn: () => T): T => {
          // CLIの事前読取とCAS transactionの間でfenceが変わる競合を再現する。
          store.db.prepare(`UPDATE run_cancel_requests SET cancel_fence = cancel_fence + 1 WHERE id = ?`).run(request.id);
          return transaction(fn);
        });
      }

      ctx.stdout.clear();
      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync([...command.slice(0, -1), "--confirm", "--json"], { from: "user" });
      expect(ctx.exitCodes.at(-1)).toBe(1);
      expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
      expect(ctx.deps.store.getTask(fixture.task.id)?.blockReason).toContain("codex-in-progress:");
      expect(ctx.deps.store.listEvents(fixture.task.id, "cancel_host_stop_attested")).toHaveLength(0);
    },
  );

  it("cancel-host-stopは空のevidence識別子を拒否する", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop-empty-evidence");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    const base = [
      "task", "cancel-host-stop", fixture.task.id,
      "--request", request.id,
      ...fixture.args,
      "--json",
    ];

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [...base, "--evidence-id", "", "--process-generation", "generation:1"],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("--evidence-id は空にできません");

    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync(
      [...base, "--evidence-id", "evidence:1", "--process-generation", ""],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("--process-generation は空にできません");
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
    expect(readRunStatus(ctx, fixture.runId)).toBe("running");
  });

  it("cancel-host-stopは同一bridgeの別open runがある場合にfail-closedする", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "competing-a");
    const competing = createBridgeCancelableFixture(ctx, "competing-b");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", fixture.task.id,
        "--request", request.id,
        "--evidence-id", "restart:one",
        "--process-generation", "generation:two",
        ...fixture.args,
        "--confirm",
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("同一bridgeに他のopen run");
    expect(ctx.stderr.text()).toContain(String(competing.runId));
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
    expect(readRunStatus(ctx, fixture.runId)).toBe("running");
  });

  it("cancel-host-stopはdirect runと別taskのrequestを拒否する", async () => {
    ctx = createTestDeps();
    const direct = createCancelableFixture(ctx, "host-stop-direct");
    ctx.deps.store.block(direct.task.id, "codex-in-progress: direct", "supervisor");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", direct.task.id, "--reason", "停止", ...direct.args, "--json"],
      { from: "user" },
    );
    const directRequest = ctx.deps.store.getActiveRunCancelRequestByTask(direct.task.id)!;
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", direct.task.id,
        "--request", directRequest.id,
        "--evidence-id", "direct:stop",
        "--process-generation", "direct:pid",
        ...direct.args,
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("bridge run限定");

    const bridge = createBridgeCancelableFixture(ctx, "host-stop-other", "http://127.0.0.1:4567");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", bridge.task.id, "--reason", "停止", ...bridge.args, "--json"],
      { from: "user" },
    );
    const bridgeRequest = ctx.deps.store.getActiveRunCancelRequestByTask(bridge.task.id)!;
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", bridge.task.id,
        "--request", directRequest.id,
        "--evidence-id", "other:stop",
        "--process-generation", "other:pid",
        ...bridge.args,
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("対象タスクの cancel request と一致しません");
    expect(ctx.deps.store.getRunCancelRequest(bridgeRequest.id)?.status).toBe("cancel_requested");
  });

  it("cancel-host-stopはstale orchestrator generationを拒否する", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop-stale");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    ctx.deps.store.closeOrchestratorSession(fixture.requesterSessionId, fixture.generation);
    ctx.deps.store.startOrchestratorSession({ orchestratorId: fixture.orchestratorId });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", fixture.task.id,
        "--request", request.id,
        "--evidence-id", "stale:stop",
        "--process-generation", "stale:pid",
        ...fixture.args,
        "--confirm",
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("active orchestrator session generation");
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
  });

  it("cancel-host-stopは別identityを拒否し、同じstable identityの新generationを許可する", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop-owner");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    const other = ctx.deps.store.registerOrchestrator({
      label: "other-host-stop-owner",
      project: "dev",
      repoCommonDir: "/repo/other-host-stop-owner",
    });
    const otherSession = ctx.deps.store.startOrchestratorSession({ orchestratorId: other.id });
    const evidenceArgs = [
      "--request", request.id,
      "--evidence-id", "owner:stop",
      "--process-generation", "owner:pid",
    ];
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", fixture.task.id, ...evidenceArgs,
        "--actor-kind", "orchestrator", "--orchestrator", other.id,
        "--session", otherSession.id, "--generation", String(otherSession.generation), "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("stable orchestrator identityと一致しません");

    ctx.deps.store.closeOrchestratorSession(fixture.requesterSessionId, fixture.generation);
    const takeover = ctx.deps.store.startOrchestratorSession({ orchestratorId: fixture.orchestratorId });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", fixture.task.id, ...evidenceArgs,
        "--actor-kind", "orchestrator", "--orchestrator", fixture.orchestratorId,
        "--session", takeover.id, "--generation", String(takeover.generation), "--json",
      ],
      { from: "user" },
    );
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({ dryRun: true, requestId: request.id });
  });

  it("cancel-host-stopは曖昧なopen run metaとunsafe evidence IDを拒否する", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop-ambiguous");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    const ambiguousTask = ctx.deps.store.createTask(
      { title: "ambiguous", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    const ambiguousRun = ctx.deps.store.startRun(ambiguousTask.id, "codex", "ambiguous-session", {});
    const base = [
      "task", "cancel-host-stop", fixture.task.id,
      "--request", request.id,
      "--evidence-id", "ambiguous:stop",
      "--process-generation", "ambiguous:pid",
      ...fixture.args,
      "--json",
    ];
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(base, { from: "user" });
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("同一bridgeに他のopen run");
    expect(ctx.stderr.text()).toContain(String(ambiguousRun.id));

    ctx.deps.store.endRun(ambiguousRun.id, "failed");
    ctx.stdout.clear();
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync(
      base.map((value) => value === "ambiguous:stop" ? "Authorization:Bearer:secret" : value),
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(ctx.stderr.text()).toContain("安全なASCII識別子");
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
  });

  it("cancel-host-stopは最終audit event失敗時にcancel/run/taskを原子的にrollbackする", async () => {
    ctx = createTestDeps();
    const fixture = createBridgeCancelableFixture(ctx, "host-stop-rollback");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const request = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
    vi.spyOn(ctx.deps.store, "addEvent").mockImplementationOnce(() => {
      throw new Error("injected audit failure");
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      [
        "task", "cancel-host-stop", fixture.task.id,
        "--request", request.id,
        "--evidence-id", "rollback:stop",
        "--process-generation", "rollback:pid",
        ...fixture.args,
        "--confirm",
        "--json",
      ],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("injected audit failure");
    expect(ctx.deps.store.getRunCancelRequest(request.id)?.status).toBe("cancel_requested");
    expect(readRunStatus(ctx, fixture.runId)).toBe("running");
    expect(ctx.deps.store.getTask(fixture.task.id)?.blockReason).toContain("codex-in-progress:");
    expect(ctx.deps.store.listEvents(fixture.task.id, "cancel_host_stop_attested")).toHaveLength(0);
  });

  it("二重cancelはfail-closedで拒否し既存requestと別sessionへ干渉しない", async () => {
    ctx = createTestDeps();
    const first = createCancelableFixture(ctx, "first");
    const second = createCancelableFixture(ctx, "second");
    const command = ["task", "cancel", first.task.id, "--reason", "停止", ...first.args, "--json"];
    await buildProgram(ctx.deps).parseAsync(command, { from: "user" });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(command, { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("既に進行中");
    expect(ctx.deps.store.listRunCancelRequests(first.task.id)).toHaveLength(1);
    expect(ctx.deps.store.listRunCancelRequests(second.task.id)).toHaveLength(0);
    expect(ctx.deps.store.getLatestOpenRun(second.task.id)?.id).toBe(second.runId);
  });

  it("cancel-statusはexact ackだけをobserved/acknowledgedと表示する", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "ack");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const requested = ctx.deps.store.listRunCancelRequests(fixture.task.id)[0]!;
    const sent = ctx.deps.store.transitionRunCancelRequest({
      requestId: requested.id,
      expectedStatus: requested.status,
      to: "cooperative_sent",
      expectedRunId: requested.runId,
      expectedSessionId: requested.sessionId,
      expectedCancelFence: requested.cancelFence,
      requestNonce: requested.requestNonce,
      actor: "test-cancel-engine",
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "cancel-status", fixture.task.id, "--json"], { from: "user" });
    expect(JSON.parse(ctx.stdout.text()).cancelRequests[0]).toMatchObject({
      status: "cooperative_sent",
      delivered: "unknown",
      observed: "unknown",
      acknowledged: "no",
    });

    ctx.deps.store.transitionRunCancelRequest({
      requestId: sent.id,
      expectedStatus: sent.status,
      to: "acknowledged",
      expectedRunId: sent.runId,
      expectedSessionId: sent.sessionId,
      expectedCancelFence: sent.cancelFence,
      requestNonce: sent.requestNonce,
      acknowledgedNonce: sent.requestNonce,
      actor: "test-cancel-engine",
    });
    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "cancel-status", fixture.task.id, "--json"], { from: "user" });
    const acknowledged = JSON.parse(ctx.stdout.text()).cancelRequests[0] as Record<string, unknown>;
    expect(acknowledged).toMatchObject({ delivered: "yes", observed: "yes", acknowledged: "yes", stopped: "no" });
    expect(ctx.stdout.text()).not.toContain(sent.requestNonce);
  });

  it("cancel-status/showはcancelFence最大・降順を正本にlatestを選ぶ", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "fence-order");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      for (const terminal of ["failed", "expired"] as const) {
        await buildProgram(ctx.deps).parseAsync(
          ["task", "cancel", fixture.task.id, "--reason", `attempt-${terminal}`, ...fixture.args, "--json"],
          { from: "user" },
        );
        const current = ctx.deps.store.getActiveRunCancelRequestByTask(fixture.task.id)!;
        ctx.deps.store.transitionRunCancelRequest({
          requestId: current.id,
          expectedStatus: current.status,
          to: terminal,
          expectedRunId: current.runId,
          expectedSessionId: current.sessionId,
          expectedCancelFence: current.cancelFence,
          requestNonce: current.requestNonce,
          actor: "test-cancel-engine",
          ...(terminal === "expired" ? { now: current.deadlineAt } : {}),
        });
        ctx.stdout.clear();
      }
      await buildProgram(ctx.deps).parseAsync(
        ["task", "cancel", fixture.task.id, "--reason", "attempt-active", ...fixture.args, "--json"],
        { from: "user" },
      );
    } finally {
      vi.useRealTimers();
    }

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel-status", fixture.task.id, "--all", "--json"],
      { from: "user" },
    );
    expect((JSON.parse(ctx.stdout.text()) as { cancelRequests: Array<{ cancelFence: number }> })
      .cancelRequests.map((request) => request.cancelFence)).toEqual([3, 2, 1]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "show", fixture.task.id, "--json"], { from: "user" });
    expect((JSON.parse(ctx.stdout.text()) as { cancelRequests: Array<{ cancelFence: number }> })
      .cancelRequests.map((request) => request.cancelFence)).toEqual([3, 2, 1]);
  });

  it("in-progress+failed cancelはtask awaitを起こさずinboxを正本にし、task終端時だけsummaryを返す", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "await-failure");
    ctx.deps.store.block(fixture.task.id, "codex-in-progress: cancel待機中", "supervisor");
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "停止", ...fixture.args, "--json"],
      { from: "user" },
    );
    const requested = ctx.deps.store.listRunCancelRequests(fixture.task.id)[0]!;
    const failed = ctx.deps.store.transitionRunCancelRequest({
      requestId: requested.id,
      expectedStatus: requested.status,
      to: "failed",
      expectedRunId: requested.runId,
      expectedSessionId: requested.sessionId,
      expectedCancelFence: requested.cancelFence,
      requestNonce: requested.requestNonce,
      actor: "test-cancel-engine",
      lastError: "exact stop unsupported",
    });
    ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: fixture.task.id,
      questionId: `cancel-failure:${failed.id}`,
      question: "exact-session stopを確認できません",
    });
    expect(ctx.deps.store.listOrchestratorRequests(fixture.orchestratorId)).toHaveLength(1);
    ctx.stdout.clear();
    vi.useFakeTimers();
    try {
      setTimeout(() => {
        ctx.deps.store.updateBlockReason(
          fixture.task.id,
          "needs-manual: cancel failureをinboxから回収",
          "orchestrator",
          "human",
        );
      }, 4_000);
      const awaiting = buildProgram(ctx.deps).parseAsync(
        ["task", "await", fixture.task.id, "--interval", "2", "--json"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.stdout.text()).toBe("");
      await vi.advanceTimersByTimeAsync(2_000);
      await awaiting;
    } finally {
      vi.useRealTimers();
    }

    const result = JSON.parse(ctx.stdout.text()) as { cancel: { status: string; stopped: string } };
    expect(result.cancel).toMatchObject({ status: "failed", stopped: "unknown" });
    expect(ctx.deps.store.listOrchestratorRequests(fixture.orchestratorId)).toHaveLength(1);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "await", fixture.task.id], { from: "user" });
    const text = ctx.stdout.text();
    expect(text).toContain("cancel=failed");
    expect(text).toContain(`generation=${fixture.generation}`);
    expect(text).toContain(`deadline=${failed.deadlineAt}`);
    expect(text).toContain("reason=停止");
    expect(text).toContain("capability={}");
    expect(text).toContain("stopEvidence={}");
    expect(text).toContain("lastError=exact stop unsupported");
  });

  it("takeover後の旧generation cancelはmutation 0で拒否する", async () => {
    ctx = createTestDeps();
    const fixture = createCancelableFixture(ctx, "stale-generation");
    const current = ctx.deps.store.listOrchestratorSessions(fixture.orchestratorId)[0]!;
    ctx.deps.store.takeoverStaleOrchestratorSession({
      orchestratorId: fixture.orchestratorId,
      staleBefore: current.heartbeatAt + 1,
    });
    await buildProgram(ctx.deps).parseAsync(
      ["task", "cancel", fixture.task.id, "--reason", "旧session", ...fixture.args],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("generation");
    expect(ctx.deps.store.listRunCancelRequests(fixture.task.id)).toHaveLength(0);
  });

  it("deps は depends-on の前提一覧を status と未充足判定付きで返す", async () => {
    ctx = createTestDeps();
    const done = ctx.deps.store.createTask({ title: "完了済み前提", body: "b", tenant: "dev", status: "ready" }, "tester");
    const ready = ctx.deps.store.createTask({ title: "未完了前提", body: "b", tenant: "dev", status: "ready" }, "tester");
    const parent = ctx.deps.store.createTask({ title: "親タスク", body: "b", tenant: "dev" }, "tester");
    const dependent = ctx.deps.store.createTask({ title: "依存先", body: "b", tenant: "dev" }, "tester");
    ctx.deps.store.block(done.id, "review-required: 確認待ち", "tester");
    ctx.deps.store.unblock(done.id, "done", "tester");
    ctx.deps.store.link(done.id, dependent.id, "depends-on");
    ctx.deps.store.link(ready.id, dependent.id, "depends-on");
    ctx.deps.store.link(parent.id, dependent.id, "subtask");

    await buildProgram(ctx.deps).parseAsync(["task", "deps", dependent.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      taskId: string;
      dependencies: Array<{ id: string; title: string; status: string; fulfilled: boolean }>;
      unmetDependencies: Array<{ id: string; title: string; status: string; fulfilled: boolean }>;
    };
    expect(result.taskId).toBe(dependent.id);
    expect(result.dependencies.map((dependency) => dependency.id)).toEqual([done.id, ready.id]);
    expect(result.dependencies[0]).toMatchObject({
      title: "完了済み前提",
      status: "done",
      fulfilled: true,
    });
    expect(result.dependencies[1]).toMatchObject({
      title: "未完了前提",
      status: "ready",
      fulfilled: false,
    });
    expect(result.unmetDependencies.map((dependency) => dependency.id)).toEqual([ready.id]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "deps", dependent.id], { from: "user" });
    expect(ctx.stdout.text()).toContain("未充足");
    expect(ctx.stdout.text()).toContain(ready.id);
  });

  it("unblock は blocked から指定状態へ戻す", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "review-required: 確認待ち", "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "unblock", task.id, "--to", "review", "--json"], {
      from: "user",
    });

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("review");
    expect(updated?.blockReason).toBe("");
  });

  it("watch/unwatch --json は watched を冪等に切り替える", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "watch", task.id, "--json"], {
      from: "user",
    });
    const watched = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(watched.watched).toBe(true);
    expect(ctx.deps.store.getTask(task.id)?.watched).toBe(true);
    expect(ctx.deps.store.listEvents(task.id, "watch_set")).toHaveLength(1);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "watch", task.id, "--json"], {
      from: "user",
    });
    expect((JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task.watched).toBe(true);
    expect(ctx.deps.store.listEvents(task.id, "watch_set")).toHaveLength(1);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["task", "unwatch", task.id, "--json"], {
      from: "user",
    });
    const unwatched = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(unwatched.watched).toBe(false);
    expect(ctx.deps.store.getTask(task.id)?.watched).toBe(false);
    expect(ctx.deps.store.listEvents(task.id, "watch_cleared")).toHaveLength(1);
  });

  it("move は triage から ready へ promote する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "triage" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "ready", "--json"], {
      from: "user",
    });

    expect(ctx.exitCodes).toEqual([]);
    const updated = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(updated.status).toBe("ready");
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("ready");
  });

  it("move は todo から ready へ promote する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "todo" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "ready", "--json"], {
      from: "user",
    });

    const updated = ctx.deps.store.getTask(task.id);
    expect(updated?.status).toBe("ready");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("move は不正遷移を core の statemachine に委ねて fail-closed で拒否する（done → ready）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");
    ctx.deps.store.block(task.id, "review-required: 確認待ち", "tester");
    ctx.deps.store.unblock(task.id, "done", "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "ready"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("不正な状態遷移です");
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("done");
  });

  it("move は --to blocked を専用エラーで拒否する（reason 必須のため task block へ誘導）", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "ready" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "blocked"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("task block コマンドを使ってください");
    expect(ctx.deps.store.getTask(task.id)?.status).toBe("ready");
  });

  it("move は --author 省略時に既定 human を actor として記録する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev", status: "triage" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "move", task.id, "--to", "ready"], { from: "user" });

    const events = ctx.deps.store.listEvents(task.id, "status_changed");
    expect(events[0]?.actor).toBe("human");
  });

  it("set-cwd は cwd 行が無い body に新規で cwd 行を付与する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "説明文だけ", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "set-cwd", task.id, "/abs/new/path", "--json"], {
      from: "user",
    });

    const updated = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(updated.body).toBe("cwd: /abs/new/path\n\n説明文だけ");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("set-cwd は既存の cwd 行を新しいパスへ置き換える", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "t", body: "cwd: /old/path\n\nタスク内容", tenant: "dev" },
      "tester",
    );

    await buildProgram(ctx.deps).parseAsync(["task", "set-cwd", task.id, "/new/path", "--json"], {
      from: "user",
    });

    const updated = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;
    expect(updated.body).toBe("cwd: /new/path\n\nタスク内容");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("set-cwd は相対パスを fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "set-cwd", task.id, "relative/path"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("絶対パスのみ指定できます");
    expect(ctx.deps.store.getTask(task.id)?.body).toBe("b");
  });

  it("link は親子タスクをリンクし永続化する", async () => {
    ctx = createTestDeps();
    const program1 = buildProgram(ctx.deps);
    await program1.parseAsync(
      ["task", "create", "--title", "親タスク", "--body", "b", "--tenant", "dev", "--json"],
      { from: "user" },
    );
    const parent = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;

    ctx.stdout.clear();
    const program2 = buildProgram(ctx.deps);
    await program2.parseAsync(
      ["task", "create", "--title", "子タスク", "--body", "b", "--tenant", "dev", "--json"],
      { from: "user" },
    );
    const child = (JSON.parse(ctx.stdout.text()) as { task: TaskRow }).task;

    ctx.stdout.clear();
    const program3 = buildProgram(ctx.deps);
    await program3.parseAsync(["task", "link", parent.id, child.id, "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { parentId: string; childId: string; type: string };
    expect(result.parentId).toBe(parent.id);
    expect(result.childId).toBe(child.id);
    expect(result.type).toBe("subtask");
    expect(ctx.exitCodes).toEqual([]);

    const links: LinkRow[] = ctx.deps.store.listLinks(parent.id);
    expect(links.some((link) => link.parentId === parent.id && link.childId === child.id && link.linkType === "subtask")).toBe(
      true,
    );
  });

  it("link は存在しないタスクを fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask({ title: "t", body: "b", tenant: "dev" }, "tester");

    await buildProgram(ctx.deps).parseAsync(["task", "link", task.id, "t_doesnotexist"], { from: "user" });

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("見つかりません");
  });
});
