import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, type BridgeLaunchSessionRef } from "@hachi/adapters";
import { taskInput } from "@hachi/testing";
import {
  EXTERNAL_RUNTIME_GENERATION_SCHEMA,
  EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
  EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  createKanbanReadView,
  parseExternalRuntimeGenerationStatus,
} from "@hachi/core";
import type {
  ActorProvenance,
  ExecutionCapabilitySnapshot,
  HachiConfig,
  ModelTransportPolicy,
  Provider,
  StageDeps,
  TaskRow,
  Transport,
  ExternalRuntimeGenerationAttestationV1,
} from "@hachi/core";
import type { ExternalRuntimeGenerationReader } from "../external-runtime-generation-reader.js";
import { DEFAULT_TEST_CONFIG, FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { finalizeStage } from "./finalize.js";
import { monitorStage } from "./monitor.js";
import { buildGitChangeOverview, classifyVerifyFailure, parseVerdict, reviewStage } from "./review.js";
import type { LaunchSessionProbe } from "./launch-outcome.js";
import type {
  GitOverviewCommandOptions,
  GitOverviewCommandResult,
  GitOverviewExecutor,
  RuntimePathBuilder,
  VerifyCommandOptions,
  VerifyCommandResult,
  VerifyEvidence,
  VerifyExecutor,
} from "./review.js";

const now = (): number => Math.floor(Date.now() / 1000);

interface ConfigWithVerify extends HachiConfig {
  verify?: {
    tenants: Record<string, string>;
  };
}

interface StageDepsWithVerifyExecutor extends StageDeps {
  verifyExecutor?: VerifyExecutor;
  runtimePathBuilder?: RuntimePathBuilder;
}

interface StageDepsWithGitOverviewExecutor extends StageDeps {
  gitOverviewExecutor?: GitOverviewExecutor;
}

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

interface StageDepsWithLaunchSessionProbe extends StageDeps {
  launchSessionProbe?: LaunchSessionProbe;
}

function reviewerExternalGenerationFixture(model: string): {
  attestation: ExternalRuntimeGenerationAttestationV1;
  sample: ReturnType<typeof parseExternalRuntimeGenerationStatus>;
  stopped: ReturnType<typeof parseExternalRuntimeGenerationStatus>;
} {
  const observedAt = Date.now() - 1_000;
  const identity = {
    kind: "external-shared-runtime" as const,
    generationId: "4".repeat(32),
    runtimeModelId: model,
    modelReadbackSource: "codex-applied-model" as const,
    writerPid: 301,
    writerProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    runtimePid: 302,
    runtimeProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    bootNonce: "5".repeat(32),
    endpointIdentityHash: `sha256:${"6".repeat(64)}`,
    startedAt: observedAt - 10_000,
  };
  const attestation: ExternalRuntimeGenerationAttestationV1 = {
    version: 1,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    statusRevision: 1,
    state: "running",
    identity,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  const runningTransition = {
    version: 1 as const,
    revision: 1,
    kind: "running" as const,
    oldIdentity: null,
    newIdentity: identity,
    lastSeenAt: null,
    stoppedAt: null,
    replacementFirstSeenAt: null,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    source: "endpoint-observer" as const,
  };
  const status = {
    schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
    schemaVersion: 1 as const,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex" as const,
    lane: "even-shared" as const,
    runtimeKey: "external-shared-runtime/codex/even-shared",
    revision: 1,
    state: "running" as const,
    attestations: [attestation],
    transitions: [runningTransition],
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  const terminalObservedAt = Date.now();
  const stopped = {
    ...status,
    revision: 2,
    state: "stopped" as const,
    attestations: [],
    transitions: [runningTransition, {
      version: 1 as const,
      revision: 2,
      kind: "stopped" as const,
      oldIdentity: identity,
      newIdentity: null,
      lastSeenAt: terminalObservedAt,
      stoppedAt: terminalObservedAt,
      replacementFirstSeenAt: null,
      observedAt: terminalObservedAt,
      ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      expiresAt: terminalObservedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      source: "owner-wait" as const,
    }],
    observedAt: terminalObservedAt,
    expiresAt: terminalObservedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  return {
    attestation,
    sample: parseExternalRuntimeGenerationStatus(JSON.stringify(status), "codex"),
    stopped: parseExternalRuntimeGenerationStatus(JSON.stringify(stopped), "codex"),
  };
}

interface StageDepsWithCompatibilityProbe extends StageDeps {
  modelTransportPreflight: {
    probe(provider: Provider, transport: Transport): Promise<
      | { ok: true; snapshot: ExecutionCapabilitySnapshot }
      | { ok: false; detail: string }
    >;
  };
}

interface VerifyMetaForTest {
  status?: "passed" | "failed" | "verify_environment_failed";
  skipped?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  outputTail?: string;
  runtimePathSource?: string;
}

class FakeVerifyExecutor implements VerifyExecutor {
  readonly calls: Array<{ command: string; options: VerifyCommandOptions }> = [];
  response: VerifyCommandResult = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  /** 呼び出しごとに異なる結果を返したい場合（再実行=retryのシミュレーション）はここへ積む。 */
  responses: VerifyCommandResult[] = [];
  error: Error | null = null;

  async run(command: string, options: VerifyCommandOptions): Promise<VerifyCommandResult> {
    this.calls.push({ command, options });
    if (this.error !== null) {
      throw this.error;
    }
    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }
    return this.response;
  }
}

class FakeGitOverviewExecutor implements GitOverviewExecutor {
  readonly calls: Array<{ args: readonly string[]; options: GitOverviewCommandOptions }> = [];
  responses = new Map<string, GitOverviewCommandResult>();
  errors = new Map<string, Error>();

  setResponse(args: readonly string[], stdout: string, stderr = ""): void {
    this.responses.set(this.key(args), { stdout, stderr });
  }

  setError(args: readonly string[], message: string): void {
    this.errors.set(this.key(args), new Error(message));
  }

  setMaxBufferError(args: readonly string[], stdout: string, stderr = ""): void {
    interface MaxBufferError extends Error {
      stdout: string;
      stderr: string;
      maxBufferExceeded: boolean;
    }

    const error = new Error("stdout maxBuffer length exceeded") as MaxBufferError;
    error.stdout = stdout;
    error.stderr = stderr;
    error.maxBufferExceeded = true;
    this.errors.set(this.key(args), error);
  }

  async run(args: readonly string[], options: GitOverviewCommandOptions): Promise<GitOverviewCommandResult> {
    this.calls.push({ args: [...args], options });
    const key = this.key(args);
    const error = this.errors.get(key);
    if (error !== undefined) {
      throw error;
    }
    const response = this.responses.get(key);
    if (response === undefined) {
      throw new Error(`未設定の git overview command: ${args.join(" ")}`);
    }
    return response;
  }

  private key(args: readonly string[]): string {
    return args.join("\u0000");
  }
}

function setVerifyTenants(harness: TestHarness, tenants: Record<string, string>): void {
  (harness.deps.config as ConfigWithVerify).verify = { tenants };
}

function setVerifyExecutor(harness: TestHarness, executor: VerifyExecutor): void {
  (harness.deps as StageDepsWithVerifyExecutor).verifyExecutor = executor;
}

function setRuntimePath(harness: TestHarness, path: string, sensitiveValues: readonly string[] = [path]): void {
  (harness.deps as StageDepsWithVerifyExecutor).runtimePathBuilder = {
    build: () => ({ path, source: "runtime-path-v1", sensitiveValues }),
  };
}

function setGitOverviewExecutor(harness: TestHarness, executor: GitOverviewExecutor): void {
  (harness.deps as StageDepsWithGitOverviewExecutor).gitOverviewExecutor = executor;
}

function setCompatibilityProbe(
  harness: TestHarness,
  probe: StageDepsWithCompatibilityProbe["modelTransportPreflight"]["probe"],
): void {
  (harness.deps as StageDepsWithCompatibilityProbe).modelTransportPreflight = { probe };
}

function incompatibleCapabilitySnapshot(provider: Provider, transport: Transport): ExecutionCapabilitySnapshot {
  return {
    schemaVersion: "execution-capability.v1",
    provider,
    transport,
    runtime: { name: `${provider}-review-test`, version: "1.0.0", source: "advertised" },
    capabilities: [],
    modelCatalog: { knowledge: "known", models: ["intentionally-incompatible-model"], source: "advertised" },
    delivery: { model: "native", effort: "native", speed: "native" },
    observedAt: Date.now(),
  };
}

function configureDefaultGitOverview(executor: FakeGitOverviewExecutor, cwd: string): void {
  executor.setResponse(["-C", cwd, "merge-base", "HEAD", "origin/main"], "base-origin\n");
  executor.setResponse(["-C", cwd, "--no-pager", "diff", "--stat", "base-origin", "--"], " src/app.ts | 2 +-\n");
  executor.setResponse(["-C", cwd, "status", "--porcelain=v1", "-uall"], " M src/app.ts\n?? docs/new.md\n");
  executor.setResponse(["-C", cwd, "ls-files", "--others", "--exclude-standard"], "docs/new.md\n");
}

function readRunMeta(harness: TestHarness, taskId: string, sessionId: string): Record<string, unknown> {
  const view = createKanbanReadView(harness.home.env.dbPath);
  try {
    const run = view.runs(taskId).find((item) => item.sessionId === sessionId);
    expect(run).toBeDefined();
    return JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
  } finally {
    view.close();
  }
}

function verifyMetaFromRun(harness: TestHarness, taskId: string, sessionId: string): VerifyMetaForTest {
  const meta = readRunMeta(harness, taskId, sessionId);
  return meta.verify as VerifyMetaForTest;
}

describe("parseVerdict failureCause compatibility", () => {
  const taskId = "t_parser_compat";

  it("legacy fail の cause 欠落を unknown/missing として受理する", () => {
    expect(parseVerdict(JSON.stringify({
      taskId,
      verdict: "fail",
      confidence: "high",
      summary: "legacy",
      issues: [],
    }), taskId)).toMatchObject({
      verdict: "fail",
      failureCause: "unknown",
      failureCauseSource: "missing",
    });
  });

  it("未知 cause を unknown/unrecognized へ正規化する", () => {
    expect(parseVerdict(JSON.stringify({
      taskId,
      verdict: "fail",
      confidence: "high",
      summary: "future cause",
      issues: [],
      failureCause: "future_category",
    }), taskId)).toMatchObject({
      verdict: "fail",
      failureCause: "unknown",
      failureCauseSource: "unrecognized",
    });
  });

  it("既知 cause を machine-readable のまま保持する", () => {
    expect(parseVerdict(JSON.stringify({
      taskId,
      verdict: "fail",
      confidence: "high",
      summary: "local fix",
      issues: ["fix"],
      failureCause: "worker_local",
    }), taskId)).toMatchObject({
      verdict: "fail",
      failureCause: "worker_local",
      failureCauseSource: "reported",
    });
  });

  it("legacy pass は cause 無しのまま後方互換で受理する", () => {
    expect(parseVerdict(JSON.stringify({
      taskId,
      verdict: "pass",
      confidence: "high",
      summary: "ok",
      issues: [],
    }), taskId)).toMatchObject({
      verdict: "pass",
      failureCause: null,
      failureCauseSource: "not-applicable",
    });
  });
});

describe("buildGitChangeOverview（docs/contract.md §15.1）", () => {
  let cwd: string | null = null;

  afterEach(() => {
    if (cwd !== null) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = null;
    }
  });

  it("tracked diff stat/status/untracked 一覧を含む", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const executor = new FakeGitOverviewExecutor();
    configureDefaultGitOverview(executor, cwd);

    const overview = await buildGitChangeOverview(cwd, executor);

    expect(overview).toContain("## BASE");
    expect(overview).toContain("base-origin (origin/main)");
    expect(overview).toContain("## tracked diff --stat");
    expect(overview).toContain("src/app.ts | 2 +-");
    expect(overview).toContain("## status --porcelain=v1 -uall");
    expect(overview).toContain("?? docs/new.md");
    expect(overview).toContain("## untracked files");
    expect(overview).toContain("docs/new.md");
  });

  it("origin/main の BASE 解決に失敗した場合は main に fallback する", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const executor = new FakeGitOverviewExecutor();
    executor.setError(["-C", cwd, "merge-base", "HEAD", "origin/main"], "origin/main がありません");
    executor.setResponse(["-C", cwd, "merge-base", "HEAD", "main"], "base-main\n");
    executor.setResponse(["-C", cwd, "--no-pager", "diff", "--stat", "base-main", "--"], " package.json | 1 +\n");
    executor.setResponse(["-C", cwd, "status", "--porcelain=v1", "-uall"], " M package.json\n");
    executor.setResponse(["-C", cwd, "ls-files", "--others", "--exclude-standard"], "");

    const overview = await buildGitChangeOverview(cwd, executor);

    expect(overview).toContain("base-main (main)");
    expect(overview).toContain("package.json | 1 +");
  });

  it("origin/main と main の BASE 解決に失敗しても status/untracked は取得する", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const executor = new FakeGitOverviewExecutor();
    executor.setError(["-C", cwd, "merge-base", "HEAD", "origin/main"], "origin/main がありません");
    executor.setError(["-C", cwd, "merge-base", "HEAD", "main"], "main がありません");
    executor.setResponse(["-C", cwd, "status", "--porcelain=v1", "-uall"], "?? new-file.ts\n");
    executor.setResponse(["-C", cwd, "ls-files", "--others", "--exclude-standard"], "new-file.ts\n");

    const overview = await buildGitChangeOverview(cwd, executor);

    expect(overview).toContain("(committed 範囲取得不可)");
    expect(overview).toContain("(BASE 未解決のため取得不可)");
    expect(overview).toContain("?? new-file.ts");
    expect(overview).toContain("new-file.ts");
  });

  it("overview が cap を超えた場合も各セクションを残して truncated を明記する", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const executor = new FakeGitOverviewExecutor();
    executor.setResponse(["-C", cwd, "merge-base", "HEAD", "origin/main"], "base-origin\n");
    executor.setResponse(
      ["-C", cwd, "--no-pager", "diff", "--stat", "base-origin", "--"],
      Array.from({ length: 1600 }, (_, index) => `src/file-${index}.ts | 1 +`).join("\n"),
    );
    executor.setResponse(["-C", cwd, "status", "--porcelain=v1", "-uall"], " M src/important.ts\n");
    executor.setResponse(["-C", cwd, "ls-files", "--others", "--exclude-standard"], "docs/important-new.md\n");

    const overview = await buildGitChangeOverview(cwd, executor);

    expect(overview.length).toBeLessThanOrEqual(24 * 1024);
    expect(overview).toContain("truncated");
    expect(overview).toContain("## status --porcelain=v1 -uall");
    expect(overview).toContain("M src/important.ts");
    expect(overview).toContain("## untracked files");
    expect(overview).toContain("docs/important-new.md");
  });

  it("diff --stat が execFile maxBuffer 超過相当でも status/untracked を残す", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const executor = new FakeGitOverviewExecutor();
    executor.setResponse(["-C", cwd, "merge-base", "HEAD", "origin/main"], "base-origin\n");
    executor.setMaxBufferError(
      ["-C", cwd, "--no-pager", "diff", "--stat", "base-origin", "--"],
      Array.from({ length: 1600 }, (_, index) => `src/huge-${index}.ts | 1 +`).join("\n"),
    );
    executor.setResponse(["-C", cwd, "status", "--porcelain=v1", "-uall"], " M src/important.ts\n");
    executor.setResponse(["-C", cwd, "ls-files", "--others", "--exclude-standard"], "docs/important-new.md\n");

    const overview = await buildGitChangeOverview(cwd, executor);

    expect(overview).not.toBe("(git overview 取得不可)");
    expect(overview).toContain("## tracked diff --stat");
    expect(overview).toContain("truncated");
    expect(overview).toContain("## status --porcelain=v1 -uall");
    expect(overview).toContain("M src/important.ts");
    expect(overview).toContain("## untracked files");
    expect(overview).toContain("docs/important-new.md");
  });

  it("cwd 不在や git コマンド失敗は fail-open 固定文言へ倒す", async () => {
    cwd = mkdtempSync(join(tmpdir(), "hk-review-git-overview-"));
    const missing = join(cwd, "missing");
    const missingOverview = await buildGitChangeOverview(missing, new FakeGitOverviewExecutor());
    expect(missingOverview).toBe("(git overview 取得不可)");

    const executor = new FakeGitOverviewExecutor();
    executor.setResponse(["-C", cwd, "merge-base", "HEAD", "origin/main"], "base-origin\n");
    executor.setError(["-C", cwd, "--no-pager", "diff", "--stat", "base-origin", "--"], "diff 失敗");
    const commandFailureOverview = await buildGitChangeOverview(cwd, executor);
    expect(commandFailureOverview).toBe("(git overview 取得不可)");
  });
});

/** bridge 正常系は flattened transcript ではなく structured assistant result を明示する。 */
function setStructuredBridgeResult(
  adapter: FakeAdapter,
  text: string,
  structuredText = text,
  preserveStatusRaw = false,
): void {
  adapter.transcriptResponse = text;
  if (!preserveStatusRaw) {
    adapter.statusResponse = {
      ...adapter.statusResponse,
      raw: { messages: [{ type: "result", success: true, text: structuredText }] },
    };
  }
}

describe("reviewStage", () => {
  let harness: TestHarness;
  let fakeCodex: FakeAdapter;
  let fakeGitOverview: FakeGitOverviewExecutor;
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = mkdtempSync(join(tmpdir(), "hk-review-test-"));
    harness = await setupHarness();
    fakeCodex = new FakeAdapter("codex");
    fakeGitOverview = new FakeGitOverviewExecutor();
    configureDefaultGitOverview(fakeGitOverview, tmpCwd);
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    setGitOverviewExecutor(harness, fakeGitOverview);
  });

  afterEach(async () => {
    await harness.cleanup();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  /** status='review'（reviewer 未起動）まで進んだタスクを構築する */
  function createReviewTask(title = "レビュー対象", body?: string): TaskRow {
    const taskBody = body ?? `cwd: ${tmpCwd}`;
    const task = harness.store.createTask(taskInput({ status: "ready", title, body: taskBody }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-worker server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    return harness.store.unblock(task.id, "review", "tester");
  }

  function activeOrchestratorProvenance(taskId: string, label: string): ActorProvenance {
    const orchestrator = harness.store.registerOrchestrator({
      label,
      project: "hachi-kanban",
      repoCommonDir: tmpCwd,
    });
    harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const session = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    return {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    };
  }

  /** status='review' + open reviewer run（meta.role='reviewer'）まで進んだタスクを構築する */
  /**
   * bridge transport の open reviewer run を持つタスクを構築する。
   * 既定は modelDelivery: "native"。bridge adapter が model を実配送するようになったため、
   * これが通常のケースである。配送されなかった場合の挙動を見るテストだけ "none" を渡す。
   */
  function createReviewingTask(
    sessionId: string,
    modelDelivery: "native" | "none" = "native",
  ): TaskRow {
    const task = createReviewTask();
    harness.store.startRun(task.id, "codex", sessionId, {
      role: "reviewer",
      serverUrl: "http://x",
      model: "gpt-5.5",
      modelDelivery,
    });
    return task;
  }

  /** direct transport の open reviewer run を持つタスクを構築する */
  function createDirectReviewingTask(sessionId: string): TaskRow {
    const task = createReviewTask();
    harness.store.startRun(task.id, "codex", sessionId, {
      role: "reviewer",
      serverUrl: "direct",
      model: "gpt-5.5",
      modelDelivery: "native",
      transport: "direct",
    });
    return task;
  }

  function bindPreviewLeaseToEndedWorker(
    taskId: string,
    endOldRun = true,
  ): { leaseId: string; oldRunId: number; fence: number } {
    const orchestrator = harness.store.registerOrchestrator({
      label: `rework-resource-${taskId}`,
      project: "hachi-kanban",
      repoCommonDir: tmpCwd,
    });
    harness.store.bindTaskToOrchestrator(taskId, orchestrator.id, "primary");
    const requirement = harness.store.createOrGetRuntimeResourceRequirement({
      taskId,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["docker_container"] },
      idempotencyKey: `${taskId}:preview`,
    });
    const reserved = harness.store.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "test",
      project: "hachi-kanban",
      repoCommonDir: tmpCwd,
      worktree: tmpCwd,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: now() + 600,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "test",
    });
    const provisioning = harness.store.claimRuntimeResourceLease(reserved.id, reserved.fence, "test");
    harness.store.addRuntimeResourceMember({
      leaseId: reserved.id,
      expectedLeaseFence: provisioning.fence,
      kind: "docker_container",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: `preview:${taskId}`,
      nativeId: `preview-${taskId}`,
      labelsHash: "a".repeat(64),
      provenance: { version: 1, labels: {} },
      observedAt: now(),
      actor: "test",
    });
    const active = harness.store.transitionRuntimeResourceLease({
      leaseId: reserved.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "test",
    });
    const oldRun = harness.store.startRun(taskId, "codex", `old-worker-${taskId}`, {});
    const bound = harness.store.bindRuntimeResourceLeaseRun({
      leaseId: active.id,
      expectedFence: active.fence,
      runId: oldRun.id,
      actor: "test",
    });
    if (endOldRun) {
      harness.store.endRun(oldRun.id, "done");
    }
    return { leaseId: active.id, oldRunId: oldRun.id, fence: bound.fence };
  }

  /**
   * rework ラウンド後、「rework 完了 → 次のレビュアー起動」まで直接進めるテストヘルパー
   * （createReviewingTask と同様に finalize/launchReviewers の実処理はスキップし、checkVerdicts の
   * §21.1 判定ロジックのみを対象にする。blocked(in-progress, rework 由来) → review → 新 reviewer run）。
   */
  function advanceToNextReviewer(taskId: string, reviewerSessionId: string): void {
    // 実際の finalize ステージは blocked→review 遷移と同一 Tx で直前の open run を close する。
    // ここでも同様に、次のレビュアー run を開く前に直前の rework worker run を close しておく
    // （そうしないと listOpenRuns() に rework run が残り続けてしまう）。
    const openRun = harness.store.getLatestOpenRun(taskId);
    if (openRun !== null) {
      harness.store.endRun(openRun.id, "done");
    }
    harness.store.unblock(taskId, "review", "tester");
    harness.store.startRun(taskId, "codex", reviewerSessionId, {
      role: "reviewer",
      serverUrl: "http://x",
      model: "gpt-5.5",
      modelDelivery: "native",
    });
  }

  describe("前半: レビュアーの起動（docs/contract.md §15.1）", () => {
    it("cwd あり + profile あり のタスクをレビュー起動し、reviewer run（meta.role=reviewer）を記録する", async () => {
      const task = createReviewTask();
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-reviewer-1",
        serverUrl: "http://review-server.example",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      // status は review のまま（block しない, docs/contract.md §15.1）
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("review");

      const runs = harness.store.listOpenRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.taskId).toBe(task.id);
      const meta = JSON.parse(runs[0]?.meta ?? "{}") as Record<string, unknown>;
      expect(meta.role).toBe("reviewer");
      expect(meta.serverUrl).toBe("http://review-server.example");
      expect(meta.model).toBe("gpt-5.6-sol");
      // bridge adapter が model を実配送するようになったため native が通常のケース
      expect(meta.modelDelivery).toBe("native");
      expect(meta.effort).toBe("high");
      expect(meta.effortDelivery).toBe("native");

      const events = harness.store.listEvents(task.id, "reviewer_launched");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ sessionId: "sess-reviewer-1" });

      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls[0]?.options.model).toBe("gpt-5.6-sol");
      expect(fakeCodex.launchCalls[0]?.options.effort).toBe("high");
      expect(fakeCodex.launchCalls[0]?.options.cwd).toBe(tmpCwd);
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("## 変更俯瞰（索引）");
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("base-origin (origin/main)");
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("src/app.ts | 2 +-");
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("?? docs/new.md");
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("## レビュー手順（必須）");
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain("git --no-pager diff <BASE>");
      expect(fakeCodex.launchCalls[0]?.options.promptText).not.toContain("ワーカーセッションの直近ログ");
    });

    it("bridge response/status exact attestationをreviewer run開始と同じCASへbindする", async () => {
      const task = createReviewTask("external reviewer binding");
      const model = "gpt-5.6-sol";
      const fixture = reviewerExternalGenerationFixture(model);
      const launchResponse: BridgeLaunchSessionRef = {
        provider: "codex",
        sessionId: "external-generation-reviewer",
        serverUrl: "http://review-server.example",
        model,
        modelDelivery: "native",
        effortDelivery: "native",
        appliedModel: model,
        runtimeGenerationAttestation: fixture.attestation,
        startedAt: now(),
      };
      fakeCodex.launchResponse = launchResponse;
      (harness.deps as StageDepsWithExternalRuntimeGenerationReader).externalRuntimeGenerationReader = {
        read: async () => ({ state: "valid", sample: fixture.sample, launchAttestation: fixture.attestation }),
      };

      await reviewStage.tick(harness.deps, true, now());

      const run = harness.store.getLatestOpenRun(task.id)!;
      expect(harness.store.getExternalRuntimeGenerationBinding(run.id)).toMatchObject({
        taskId: task.id,
        role: "reviewer",
        provider: "codex",
        identity: { runtimeModelId: model },
      });
    });

    it("reviewer responseのattestation欠測時もlaunchを再送せずbinding無しのlegacy runにする", async () => {
      const task = createReviewTask("missing external reviewer attestation");
      const model = "gpt-5.6-sol";
      const launchResponse: BridgeLaunchSessionRef = {
        provider: "codex",
        sessionId: "external-generation-reviewer-missing",
        serverUrl: "http://review-server.example",
        model,
        modelDelivery: "native",
        effortDelivery: "native",
        appliedModel: model,
        startedAt: now(),
      };
      fakeCodex.launchResponse = launchResponse;
      let readCalls = 0;
      (harness.deps as StageDepsWithExternalRuntimeGenerationReader).externalRuntimeGenerationReader = {
        read: async () => {
          readCalls += 1;
          return { state: "unknown", code: "attestation_missing" };
        },
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(readCalls).toBe(0);
      const run = harness.store.getLatestOpenRun(task.id)!;
      expect(harness.store.getExternalRuntimeGenerationBinding(run.id)).toBeNull();
    });

    it("reviewerのworker_output_missingもexact stopped transitionだけをconfirmed分類してat-most-onceでcloseする", async () => {
      const task = createReviewTask("external reviewer interruption");
      const model = "gpt-5.6-sol";
      const fixture = reviewerExternalGenerationFixture(model);
      const run = harness.store.startRun(task.id, "codex", "external-reviewer-interrupted", {
        role: "reviewer",
        transport: "bridge",
        serverUrl: "http://review-server.example",
        model,
        appliedModel: model,
      });
      harness.store.transaction(() => {
        expect(harness.store.acceptExternalRuntimeGenerationStatus(fixture.sample, Date.now())).toBe("accepted");
        expect(harness.store.bindExternalRuntimeGenerationLaunch({
          taskId: task.id,
          runId: run.id,
          sessionId: run.sessionId,
          role: "reviewer",
          provider: "codex",
          transport: "bridge",
          attestation: fixture.attestation,
          statusRevision: fixture.sample.status.revision,
          statusDigest: fixture.sample.canonicalDigest,
          boundAt: Date.now(),
        })).toBe(true);
      });
      fakeCodex.transcriptResponse = "";
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 1,
        lastResultId: 1,
        lastEntryId: 1,
        lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
        raw: { messages: [{ type: "result", success: false, text: "process exited before output" }] },
      };
      (harness.deps as StageDepsWithExternalRuntimeGenerationReader).externalRuntimeGenerationReader = {
        read: async () => ({ state: "valid", sample: fixture.stopped }),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.listEvents(task.id, "runtime_generation_interrupted")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.blockReason).toContain("runtime_generation_interrupted");
      const second = await reviewStage.tick(harness.deps, true, now());
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(task.id, "runtime_generation_interrupted")).toHaveLength(1);
    });

    it("reviewer launch中に同一worktree cancelが作られた場合はrun bindせずdirect sessionを停止する", async () => {
      const owner = harness.store.createTask(
        taskInput({ status: "ready", title: "review cancel owner", body: `cwd: ${tmpCwd}` }),
        "tester",
      );
      harness.store.block(
        owner.id,
        "codex-in-progress: owner tmux=none even-session=review-owner server=http://x",
        "tester",
      );
      const ownerRun = harness.store.startRun(owner.id, "codex", "review-owner", { serverUrl: "http://x" });
      const task = createReviewTask("review race");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-race-orphan",
        serverUrl: "direct",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.launchHook = (): void => {
        harness.store.createOrGetRunCancelRequest({
          taskId: owner.id,
          runId: ownerRun.id,
          sessionId: ownerRun.sessionId,
          provider: ownerRun.provider,
          requestNonce: "review-launch-cancel-race",
          actor: "supervisor",
          reason: "review launch race",
          deadlineAt: now() + 60,
        });
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "orphan_session")).toHaveLength(1);
      expect(fakeCodex.stopCalls.map((ref) => ref.sessionId)).toContain("review-race-orphan");
    });

    it("孤児化した direct reviewer の stop が unsignalable を返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
      const owner = harness.store.createTask(
        taskInput({ status: "ready", title: "review cancel owner unsignalable", body: `cwd: ${tmpCwd}` }),
        "tester",
      );
      harness.store.block(
        owner.id,
        "codex-in-progress: owner tmux=none even-session=review-owner-2 server=http://x",
        "tester",
      );
      const ownerRun = harness.store.startRun(owner.id, "codex", "review-owner-2", { serverUrl: "http://x" });
      const task = createReviewTask("review race unsignalable");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-race-orphan-unsignalable",
        serverUrl: "direct",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.stopResponse = { stopped: false, reason: "unsignalable" };
      fakeCodex.launchHook = (): void => {
        harness.store.createOrGetRunCancelRequest({
          taskId: owner.id,
          runId: ownerRun.id,
          sessionId: ownerRun.sessionId,
          provider: ownerRun.provider,
          requestNonce: "review-launch-cancel-race-unsignalable",
          actor: "supervisor",
          reason: "review launch race",
          deadlineAt: now() + 60,
        });
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(fakeCodex.stopCalls.map((ref) => ref.sessionId)).toContain("review-race-orphan-unsignalable");
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });

    it("reviewer launch中にrole設定が変わった場合はrun bindせず孤児sessionを中断する", async () => {
      const task = createReviewTask("review settings race");
      const provenance = activeOrchestratorProvenance(task.id, "review-settings-race");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-settings-orphan",
        serverUrl: "http://review-server.example",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.launchHook = (): void => {
        harness.store.setExecutionOverrides(
          task.id,
          "reviewer",
          { model: "gpt-5.5" },
          "tester",
          provenance,
        );
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "orphan_session")).toHaveLength(1);
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("review-settings-orphan");
    });

    it("review prompt準備後にtask bodyが変わった場合はreviewerをlaunchしない", async () => {
      const task = createReviewTask("review prompt body race");
      const getTask = harness.store.getTask.bind(harness.store);
      let taskReads = 0;
      harness.store.getTask = (taskId: string): TaskRow | null => {
        if (taskId === task.id) {
          taskReads += 1;
          // initial task / compatibility記録の次が、prompt artifact保存後のprelaunch再読込。
          if (taskReads === 3) {
            harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nprompt構築後の仕様変更`, "tester");
          }
        }
        return getTask(taskId);
      };

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(result.notes?.join(" ")).toContain("launch直前に変更");
    });

    it("reviewer launch中にtask bodyが変わった場合はrunへbindせず孤児sessionを中断する", async () => {
      const task = createReviewTask("review launch body race");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-body-orphan",
        serverUrl: "http://review-server.example",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.launchHook = (): void => {
        harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nlaunch中の仕様変更`, "tester");
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "orphan_session")).toHaveLength(1);
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("review-body-orphan");
    });

    it("reviewer launch中にbody変更後adapterがthrowしても古いlaunch failureでblockしない", async () => {
      const task = createReviewTask("review stale launch failure");
      fakeCodex.launchError = new Error("review launch failed after mutation");
      fakeCodex.launchHook = (): void => {
        harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nlaunch中の仕様変更`, "tester");
      };

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "reviewer_launch_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "stale_launch_failure").map((event) => JSON.parse(event.payload)))
        .toContainEqual(expect.objectContaining({ role: "reviewer", error: expect.stringContaining("launch failed") }));
      expect(result.notes?.join(" ")).toContain("stale launch failure");
    });

    it("reviewer launch timeout は launch-indeterminate で block する", async () => {
      const task = createReviewTask("review launch indeterminate");
      fakeCodex.launchError = new BridgeError("bridge /api/prompt がタイムアウトしました", "timeout");
      (harness.deps as StageDepsWithLaunchSessionProbe).launchSessionProbe = async (_bridge, cwd, provider) => {
        expect(cwd).toBe(realpathSync.native(tmpCwd));
        expect(provider).toBe("codex");
        return [];
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)).toMatchObject({
        status: "blocked",
        blockReason: expect.stringMatching(/^needs-manual: launch-indeterminate: レビュー起動 \(/),
      });
      const events = harness.store.listEvents(task.id, "reviewer_launch_indeterminate");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        probeCwd: realpathSync.native(tmpCwd),
        probeProvider: "codex",
        candidateSessions: [],
        probeError: null,
      });
      expect(Date.parse(payload.attemptedAt as string)).not.toBeNaN();
      expect(Date.parse(payload.probedAt as string)).toBeGreaterThanOrEqual(Date.parse(payload.attemptedAt as string));
      expect(harness.store.listEvents(task.id, "reviewer_launch_failed")).toHaveLength(0);
    });

    it("unsupported preflight中にconfigが変わった場合は古い理由でblockしない", async () => {
      const task = createReviewTask("review unsupported config race");
      setCompatibilityProbe(harness, async (provider, transport) => {
        writeFileSync(
          join(harness.home.home, "config.json"),
          JSON.stringify({
            ...harness.deps.config,
            resourceGuard: {
              ...harness.deps.config.resourceGuard,
              maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
            },
          }),
          "utf8",
        );
        return { ok: true, snapshot: incompatibleCapabilitySnapshot(provider, transport) };
      });

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "incompatible_model_transport")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(result.notes?.join(" ")).toContain("古い互換性判定を破棄");
    });

    it("unknown preflight中にconfigが変わった場合も古い理由でblockしない", async () => {
      const task = createReviewTask("review unknown config race");
      setCompatibilityProbe(harness, async () => {
        writeFileSync(
          join(harness.home.home, "config.json"),
          JSON.stringify({
            ...harness.deps.config,
            resourceGuard: {
              ...harness.deps.config.resourceGuard,
              maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
            },
          }),
          "utf8",
        );
        return { ok: false, detail: "capability probe unavailable" };
      });

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "model_transport_compatibility_unknown")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(result.notes?.join(" ")).toContain("古い互換性判定を破棄");
    });

    describe("異モデル二審 reviewer の fail-closed（contract §7 model表 / §59 / §67.4）", () => {
      const OPUS5_POLICY = {
        id: "claude-direct-opus5-test",
        provider: "claude" as const,
        model: "claude-opus-5",
        transport: "direct" as const,
        minimumRuntimeVersion: "2.1.226",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        supportedSpeeds: ["standard", "fast"],
      } satisfies ModelTransportPolicy;
      /** 代替候補として起動されうる model を allowlist / catalog 側へ意図的に残す。 */
      const SUBSTITUTE_MODELS = ["claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-5"];
      let fakeClaude: FakeAdapter;
      let probeCalls: Array<{ provider: Provider; transport: Transport }>;

      /** reviewer が claude-opus-5/direct へ解決されるハーネスへ組み替える。 */
      async function useOpus5ReviewerHarness(): Promise<void> {
        await harness.cleanup();
        harness = await setupHarness({
          profiles: {
            plan: { provider: "claude", model: "claude-opus-4-6" },
            review: { provider: "claude", model: "claude-opus-5", transport: "direct", effort: "xhigh" },
            implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
            docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
          },
          allowlist: {
            codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
            claude: ["claude-opus-5", ...SUBSTITUTE_MODELS],
          },
          modelTransportPolicies: [...(DEFAULT_TEST_CONFIG.modelTransportPolicies ?? []), OPUS5_POLICY],
        });
        fakeCodex = new FakeAdapter("codex");
        fakeClaude = new FakeAdapter("claude");
        harness.deps.adapters = { codex: fakeCodex, claude: fakeClaude };
        harness.deps.directAdapters = { codex: fakeCodex, claude: fakeClaude };
        setGitOverviewExecutor(harness, fakeGitOverview);
        probeCalls = [];
      }

      /** reviewer 起動が一切行われていないこと（= 暗黙の代替 model へ倒れていないこと）を確認する。 */
      function expectNoReviewerLaunch(taskId: string): void {
        expect(fakeClaude.launchCalls).toHaveLength(0);
        expect(fakeCodex.launchCalls).toHaveLength(0);
        expect(harness.store.listOpenRuns()).toHaveLength(0);
        expect(harness.store.listEvents(taskId, "reviewer_launched")).toHaveLength(0);
        // probe は claude/direct の1回だけ。別 model/provider での再判定を行わない。
        expect(probeCalls).toEqual([{ provider: "claude", transport: "direct" }]);
      }

      it("claude-opus-5 が catalog に無い場合、代替modelへfallbackせず needs-manual で停止する", async () => {
        await useOpus5ReviewerHarness();
        setCompatibilityProbe(harness, async (provider, transport) => {
          probeCalls.push({ provider, transport });
          return {
            ok: true,
            snapshot: {
              schemaVersion: "execution-capability.v1",
              provider,
              transport,
              runtime: { name: "claude-test-runtime", version: "2.1.226", source: "advertised" },
              capabilities: [],
              // 代替候補だけが広告され、claude-opus-5 だけが利用不可という状況。
              modelCatalog: { knowledge: "known", models: SUBSTITUTE_MODELS, source: "advertised" },
              delivery: { model: "native", effort: "native", speed: "native" },
              observedAt: Date.now(),
            },
          };
        });
        const task = createReviewTask("opus5 unavailable");

        await reviewStage.tick(harness.deps, true, now());

        const updated = harness.store.getTask(task.id);
        expect(updated).toMatchObject({ status: "blocked", assignee: "human" });
        expect(updated?.blockReason).toContain("needs-manual: incompatible_model_transport");
        expect(updated?.blockReason).toContain("model-not-advertised");
        expect(updated?.blockReason).toContain("claude-opus-5");
        for (const substitute of SUBSTITUTE_MODELS) {
          expect(updated?.blockReason).not.toContain(substitute);
        }
        expect(harness.store.listEvents(task.id, "incompatible_model_transport")).toHaveLength(1);
        expect(harness.store.listEvents(task.id, "model_transport_compatibility_checked")).toHaveLength(0);
        expectNoReviewerLaunch(task.id);
      });

      it("claude-opus-5 の capability probe 自体が失敗した場合も unknown で停止する", async () => {
        await useOpus5ReviewerHarness();
        setCompatibilityProbe(harness, async (provider, transport) => {
          probeCalls.push({ provider, transport });
          return { ok: false, detail: "claude runtime probe unavailable" };
        });
        const task = createReviewTask("opus5 probe failed");

        await reviewStage.tick(harness.deps, true, now());

        const updated = harness.store.getTask(task.id);
        expect(updated).toMatchObject({ status: "blocked", assignee: "human" });
        expect(updated?.blockReason).toContain("needs-manual: model_transport_compatibility_unknown");
        expect(updated?.blockReason).toContain("capability-probe-failed");
        for (const substitute of SUBSTITUTE_MODELS) {
          expect(updated?.blockReason).not.toContain(substitute);
        }
        expect(harness.store.listEvents(task.id, "model_transport_compatibility_unknown")).toHaveLength(1);
        expect(harness.store.listEvents(task.id, "model_transport_compatibility_checked")).toHaveLength(0);
        expectNoReviewerLaunch(task.id);
      });
    });

    it("profiles['review'] が未設定かつoverride無しならモデル解決失敗でblockする", async () => {
      await harness.cleanup();
      harness = await setupHarness({
        profiles: {
          plan: { provider: "claude", model: "claude-opus-4-6" },
          implement: { provider: "codex", model: "gpt-5.4" },
          docs: { provider: "claude", model: "claude-sonnet-5" },
        },
      });
      fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const task = createReviewTask();

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);
      expect(result.notes?.some((n) => n.includes("未知の profile"))).toBe(true);
      expect(harness.store.listOpenRuns()).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    });

    it("profiles['review'] が無くてもtask reviewProfileOverrideの有効profileを使う", async () => {
      await harness.cleanup();
      harness = await setupHarness({
        profiles: {
          plan: { provider: "claude", model: "claude-opus-4-6" },
          implement: { provider: "codex", model: "gpt-5.4" },
          docs: { provider: "claude", model: "claude-sonnet-5" },
        },
      });
      fakeCodex = new FakeAdapter("codex");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-profile-override",
        serverUrl: "http://review-server.example",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

      const task = createReviewTask();
      harness.store.setExecutionOverrides(
        task.id,
        "reviewer",
        { profile: "implement" },
        "tester",
        activeOrchestratorProvenance(task.id, "review-profile-override"),
      );

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls[0]?.options.model).toBe("gpt-5.4");
      const run = harness.store.getLatestOpenRun(task.id);
      expect(run).not.toBeNull();
      expect(JSON.parse(run!.meta)).toMatchObject({ role: "reviewer", profile: "implement" });
    });

    it("reviewer task overrideのmodel/max/fastをdirectへ渡しrequested/deliveryをrun metaへ記録する", async () => {
      const task = createReviewTask("review override max fast");
      harness.store.setExecutionOverrides(
        task.id,
        "reviewer",
        { provider: "codex", model: "gpt-5.6-luna", effort: "max", speed: "fast" },
        "tester",
        activeOrchestratorProvenance(task.id, "review-max-fast"),
      );
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-max-fast",
        serverUrl: "direct",
        model: "gpt-5.6-luna",
        modelDelivery: "native",
        startedAt: now(),
      };
      harness.deps.directAdapters = { codex: fakeCodex };

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls[0]?.options).toMatchObject({
        model: "gpt-5.6-luna",
        effort: "max",
        speed: "fast",
      });
      const run = harness.store.getLatestOpenRun(task.id);
      expect(run).not.toBeNull();
      expect(JSON.parse(run!.meta)).toMatchObject({
        role: "reviewer",
        source: "override",
        model: "gpt-5.6-luna",
        effort: "max",
        effortDelivery: "native",
        speed: "fast",
        speedDelivery: "native",
      });
      expect(JSON.parse(run!.meta)).not.toHaveProperty("effectiveSpeed");
    });

    it("claude maxTurns capability なしは applied 無しの direct reviewer run を bind する", async () => {
      harness.deps.config = {
        ...harness.deps.config,
        profiles: {
          ...harness.deps.config.profiles,
          review: { provider: "claude", model: "claude-opus-4-6", transport: "bridge" },
        },
      };
      harness.claudeBridge.setCapabilities([]);
      const fakeClaudeDirect = new FakeAdapter("claude");
      fakeClaudeDirect.launchResponse = {
        provider: "claude",
        sessionId: "review-claude-direct-no-applied",
        serverUrl: "direct",
        model: "claude-opus-4-6",
        modelDelivery: "native",
        startedAt: now(),
      };
      harness.deps.directAdapters = { claude: fakeClaudeDirect };
      const task = createReviewTask("review direct applied 免除");

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeClaudeDirect.launchCalls).toHaveLength(1);
      expect(harness.claudeBridge.requests.some(
        (request) => request.path === "/api/prompt" && request.method === "POST",
      )).toBe(false);
      const run = harness.store.getLatestOpenRun(task.id);
      expect(run).not.toBeNull();
      expect(JSON.parse(run!.meta)).toMatchObject({
        role: "reviewer",
        transport: "direct",
        modelDelivery: "native",
      });
      expect(JSON.parse(run!.meta)).not.toHaveProperty("appliedModel");
      expect(harness.store.listEvents(task.id, "execution_native_delivery_missing")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "bridge_native_missing")).toHaveLength(0);
    });

    it("reviewer実launch echoがprofile effortのnative deliveryを欠く場合はrunへbindせず中断する", async () => {
      const task = createReviewTask("review effort echo欠落");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-effort-missing",
        serverUrl: "http://review-server.example",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "none",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      expect(harness.store.listEvents(task.id, "execution_native_delivery_missing")).toHaveLength(1);
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("review-effort-missing");
    });

    it("direct reviewerのnative delivery欠落中断でstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
      const task = createReviewTask("review direct effort echo欠落 unsignalable");
      // override は provider/model/effort のいずれかが非空なら transport を direct へ強制する
      // （packages/core/src/policy.ts の resolveExecution 参照）。
      harness.store.setExecutionOverrides(
        task.id,
        "reviewer",
        { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
        "tester",
        activeOrchestratorProvenance(task.id, "review-direct-native-missing"),
      );
      harness.deps.directAdapters = { codex: fakeCodex };
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "review-direct-native-missing",
        serverUrl: "direct",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "none",
        startedAt: now(),
      };
      fakeCodex.stopResponse = { stopped: false, reason: "unsignalable" };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      expect(harness.store.listEvents(task.id, "execution_native_delivery_missing")).toHaveLength(1);
      expect(fakeCodex.stopCalls.map((ref) => ref.sessionId)).toContain("review-direct-native-missing");
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });

    it("reviewer bridge の appliedModel が要求と不一致ならrunへbindせず中断する", async () => {
      const task = createReviewTask("review applied model不一致");
      const launchResponse: BridgeLaunchSessionRef = {
        provider: "codex",
        sessionId: "review-applied-model-mismatch",
        serverUrl: "http://review-server.example",
        model: "gpt-5.6-sol",
        modelDelivery: "native",
        effortDelivery: "native",
        appliedModel: "gpt-5.4",
        appliedEffort: "high",
        startedAt: now(),
      };
      fakeCodex.launchResponse = launchResponse;

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      expect(harness.store.listEvents(task.id, "execution_native_delivery_missing")).toHaveLength(1);
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("review-applied-model-mismatch");
    });

    it("cwd 未指定のタスクは needs-manual で block する", async () => {
      const task = createReviewTask("cwdなし", "cwd 行が無い本文");

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("needs-manual: レビュー起動不能 (cwd 無し)");
      expect(updated?.assignee).toBe("human");
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });

    it("1 tick では最大1件しか起動しない（契約 §15.1: ハードコード上限）", async () => {
      const first = createReviewTask("1件目");
      const second = createReviewTask("2件目");
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-only-one",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);
      expect(fakeCodex.launchCalls).toHaveLength(1);

      // priority/created_at が同着になりうるため「どちらが起動されたか」は固定せず、
      // 「ちょうど1件だけ起動され、もう一方は未着手のまま」であることだけを検証する
      const runs = harness.store.listOpenRuns();
      expect(runs).toHaveLength(1);
      const launchedTaskId = runs[0]?.taskId;
      expect([first.id, second.id]).toContain(launchedTaskId);
      const untouchedId = launchedTaskId === first.id ? second.id : first.id;
      expect(harness.store.getTask(untouchedId)?.status).toBe("review");
      expect(harness.store.listOpenRuns().find((r) => r.taskId === untouchedId)).toBeUndefined();
    });

    it("dry-run は判定のみで DB に書き込まない", async () => {
      const task = createReviewTask();
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-dry",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, false, now());
      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listOpenRuns()).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });
  });

  describe("後半: verdict の検証遷移（docs/contract.md §15.2）", () => {
    it("まだレビュー未完了（busy）のタスクは対象外", async () => {
      const task = createReviewingTask("sess-busy");
      fakeCodex.statusResponse = { state: "active", lastActivityAt: null };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(0);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
    });

    it("pass + high は done へ遷移し、コメント + verdict_finalized イベントを記録し reviewer run を close する", async () => {
      const task = createReviewingTask("sess-pass-high");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "レビューログ",
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "問題なし", issues: [] }),
        "```",
      ].join("\n"));

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");

      const events = harness.store.listEvents(task.id, "verdict_finalized");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        sessionId: "sess-pass-high",
        verdict: "pass",
        confidence: "high",
      });

      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("問題なし"))).toBe(true);

      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    });

    it("direct reviewer run の正常 close 後に process group cleanup を行う", async () => {
      const directCodex = new FakeAdapter("codex");
      harness.deps.directAdapters = { codex: directCodex };
      const task = createDirectReviewingTask("direct-review-pass");
      directCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      directCodex.transcriptResponse = [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n");

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(directCodex.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-review-pass"]);
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
      // 契約 §34.2.1: 成功2値（terminated/killed）も reason を証拠として記録する（デフォルトの
      // stopResponse は stopped:true, reason:"terminated"）。stopped:false のときだけ記録すると
      // 成功経路の reason が欠落するため、成功経路でも記録されることをここで確認する。
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("direct reviewer run の process group cleanupが完了しました");
      expect(log).toContain('"reason":"terminated"');
    });

    it("direct reviewer run の正常 close 後の process group cleanup が unsignalable を返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
      const directCodex = new FakeAdapter("codex");
      harness.deps.directAdapters = { codex: directCodex };
      const task = createDirectReviewingTask("direct-review-pass-unsignalable");
      directCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      directCodex.transcriptResponse = [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n");
      directCodex.stopResponse = { stopped: false, reason: "unsignalable" };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(directCodex.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-review-pass-unsignalable"]);
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });

    it("pass + high で tenant verify が成功すると done へ遷移し、reviewer run meta に evidence を保存する（docs/contract.md §39.2）", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r typecheck && pnpm -r test" });
      setRuntimePath(harness, "/known/toolchain:/usr/bin:/bin");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 0,
        signal: null,
        stdout: "typecheck ok\nsk-abcdefghijklmnop\n",
        stderr: "",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-pass");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm -r typecheck && pnpm -r test");
      expect(fakeVerify.calls[0]?.options).toMatchObject({ cwd: tmpCwd, timeoutMs: 15 * 60 * 1000 });
      expect(fakeVerify.calls[0]?.options.env.PATH).toBe("/known/toolchain:/usr/bin:/bin");

      const verify = verifyMetaFromRun(harness, task.id, "sess-verify-pass");
      expect(verify.status).toBe("passed");
      expect(verify.exitCode).toBe(0);
      expect(verify.outputTail).toContain("typecheck ok");
      expect(verify.outputTail).toContain("[REDACTED]");
      expect(verify.runtimePathSource).toBe("runtime-path-v1");
    });

    it("§63.2 pass finalizeはreviewer runを先にcloseし、秒境界を跨いでもendedAt <= completedAtを保つ", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);
      const task = createReviewingTask("sess-review-second-boundary");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      const calls: string[] = [];
      const originalDateNow = Date.now;
      const originalEndRun = harness.store.endRun.bind(harness.store);
      const originalTransition = harness.store.transition.bind(harness.store);
      harness.store.endRun = (...args): void => {
        calls.push("endRun");
        Date.now = (): number => 1_700_000_000_900;
        try {
          originalEndRun(...args);
        } finally {
          Date.now = originalDateNow;
        }
      };
      harness.store.transition = (input) => {
        if (input.to === "done") {
          calls.push("transition:done");
        }
        Date.now = (): number => 1_700_000_001_100;
        try {
          return originalTransition(input);
        } finally {
          Date.now = originalDateNow;
        }
      };

      await reviewStage.tick(harness.deps, true, now());

      const completed = harness.store.getTask(task.id)!;
      const run = createKanbanReadView(harness.home.env.dbPath);
      try {
        const reviewer = run.runs(task.id).find((item) => item.sessionId === "sess-review-second-boundary")!;
        expect(calls).toEqual(["endRun", "transition:done"]);
        expect(reviewer.endedAt).toBe(1_700_000_000);
        expect(completed.completedAt).toBe(1_700_000_001);
        expect(completed.completedAt).toBeGreaterThanOrEqual(reviewer.endedAt!);
      } finally {
        run.close();
      }
    });

    it("verify 実行直前に stale reviewer run を検知した場合は verify コマンドを実行しない", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-stale-old");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.transcriptHook = (): void => {
        const oldRun = harness.store.getOpenRunByTaskSession(task.id, "sess-verify-stale-old");
        if (oldRun !== null) {
          harness.store.endRun(oldRun.id, "failed");
        }
        harness.store.startRun(task.id, "codex", "sess-verify-stale-new", {
          role: "reviewer",
          serverUrl: "http://x",
          model: "gpt-5.5",
          modelDelivery: "native",
        });
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeVerify.calls).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(0);
      const staleEvents = harness.store.listEvents(task.id, "stale_review_skipped");
      expect(staleEvents).toHaveLength(1);
      expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({
        sessionId: "sess-verify-stale-old",
        phase: "verify_preflight",
      });
      expect(harness.store.getOpenRunByTaskSession(task.id, "sess-verify-stale-new")).not.toBeNull();
    });

    it("transcript取得中にcancelが作られた場合は最終mutationをlate拒否しreviewer runを維持する", async () => {
      const task = createReviewingTask("sess-review-cancel-race");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.transcriptHook = (): void => {
        const run = harness.store.getOpenRunByTaskSession(task.id, "sess-review-cancel-race");
        if (run !== null && harness.store.listRunCancelRequests(task.id).length === 0) {
          harness.store.createOrGetRunCancelRequest({
            taskId: task.id,
            runId: run.id,
            sessionId: run.sessionId,
            provider: run.provider,
            requestNonce: "review-cancel-race",
            actor: "supervisor",
            reason: "review race",
            deadlineAt: now() + 60,
          });
        }
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.getOpenRunByTaskSession(task.id, "sess-review-cancel-race")).not.toBeNull();
      expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "late_result_rejected")).toHaveLength(1);
    });

    it("pass + high で tenant verify が失敗すると done せず既存 rework 経路へ流す（docs/contract.md §39.2）", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "unit failed",
        stderr: "AssertionError",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-fail");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-verify",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("even-session=sess-rework-verify");
      expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(1);
      expect(JSON.parse(harness.store.listEvents(task.id, "verdict_failed")[0]!.payload)).toMatchObject({
        failureCause: "worker_local",
        failureCauseSource: "verify",
        modelFailureCounted: true,
        routingAction: "automatic_rework",
      });
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(0);

      const verify = verifyMetaFromRun(harness, task.id, "sess-verify-fail");
      expect(verify.status).toBe("failed");
      expect(verify.exitCode).toBe(1);
      expect(verify.outputTail).toContain("AssertionError");
    });

    it("pass + high で tenant verify が失敗しても、失敗テストだけの再実行が通れば flake として review-required へ倒す（worker帰責にしない）", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        {
          exitCode: 1,
          signal: null,
          stdout: " FAIL  src/foo.test.ts > suite > test",
          stderr: "AssertionError",
          timedOut: false,
        },
        { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-flake");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("review-required: environment_evidence");
      expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);

      const failedEvents = harness.store.listEvents(task.id, "verdict_failed");
      expect(failedEvents).toHaveLength(1);
      expect(JSON.parse(failedEvents[0]!.payload)).toMatchObject({
        failureCause: "environment_evidence",
        failureCauseSource: "verify",
        modelFailureCounted: false,
        routingAction: "orchestrator_review_required",
        verifyRetry: {
          attempted: true,
          outcome: "passed",
          failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
          failingTestFiles: ["src/foo.test.ts"],
        },
      });

      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls[1]?.options.cwd).toBe(tmpCwd);
    });

    it("pass + high で tenant verify が pnpm --stream 実測形状（<package> <script>: プレフィックス＋ANSI装飾）で失敗しても、再実行が通れば flake として review-required へ倒す（実インシデント t_da7e9d7aaf3e5942 run 1334 の kill EPERM を再現）", async () => {
      // 前ラウンドの骨格は自作/合成 fixture でしか green にならず、`pnpm -r --stream test` の
      // 実出力（全行が "<package> <script>: " で始まり、ANSIで装飾される）では
      // 失敗テストを特定できていなかった。ここでは実測した prefix + ANSI の構造を
      // そのまま再現し、この形状でも判定できることを検証する。
      mkdirSync(join(tmpCwd, "packages", "adapters", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "adapters", "src", "direct-codex.test.ts"), "");
      setVerifyTenants(harness, { "test-tenant": "pnpm --stream -r test" });

      const prefix = "\x1b[36mpackages/adapters\x1b[39m \x1b[96mtest\x1b[39m: ";
      const dim = (text: string): string => `\x1b[90m${text}\x1b[39m`;
      const stdout = [
        `${prefix} RUN  v4.1.9`,
        `${prefix} ❯ src/direct-codex.test.ts (29 tests | 1 failed) 120ms`,
        `${prefix}      × 既にプロセスが終了している場合は already-exited を返す 8ms`,
        `${prefix} ${dim("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯")}`,
        `${prefix} ${dim(
          " FAIL  src/direct-codex.test.ts > stop（契約 §34.2）> 既にプロセスが終了している場合は already-exited を返す",
        )}`,
        `${prefix} ${dim("Error: kill EPERM")}`,
        `${prefix}  Test Files  1 failed | 4 passed (5)`,
        `${prefix}       Tests  1 failed | 443 passed (444)`,
      ].join("\n");

      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        { exitCode: 1, signal: null, stdout, stderr: "", timedOut: false },
        { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-flake-stream");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("review-required: environment_evidence");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);

      const failedEvents = harness.store.listEvents(task.id, "verdict_failed");
      expect(failedEvents).toHaveLength(1);
      expect(JSON.parse(failedEvents[0]!.payload)).toMatchObject({
        failureCause: "environment_evidence",
        failureCauseSource: "verify",
        modelFailureCounted: false,
        routingAction: "orchestrator_review_required",
        verifyRetry: {
          attempted: true,
          outcome: "passed",
          failingTests: [
            {
              file: "src/direct-codex.test.ts",
              test: "stop（契約 §34.2）> 既にプロセスが終了している場合は already-exited を返す",
            },
          ],
          failingTestFiles: ["src/direct-codex.test.ts"],
        },
      });

      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/direct-codex.test.ts'");
      expect(fakeVerify.calls[1]?.options.cwd).toBe(join(tmpCwd, "packages", "adapters"));
    });

    it("pass + high で tenant verify が失敗し、失敗テストの再実行も再現した場合は worker_local として既存 rework 経路へ流す（docs/contract.md §39.2）", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        {
          exitCode: 1,
          signal: null,
          stdout: " FAIL  src/foo.test.ts > suite > test",
          stderr: "AssertionError",
          timedOut: false,
        },
        {
          exitCode: 1,
          signal: null,
          stdout: " FAIL  src/foo.test.ts > suite > test",
          stderr: "AssertionError again",
          timedOut: false,
        },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-fail-confirmed");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-verify-confirmed",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("even-session=sess-rework-verify-confirmed");
      expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(0);

      const failedEvents = harness.store.listEvents(task.id, "verdict_failed");
      expect(failedEvents).toHaveLength(1);
      expect(JSON.parse(failedEvents[0]!.payload)).toMatchObject({
        failureCause: "worker_local",
        failureCauseSource: "verify",
        modelFailureCounted: true,
        routingAction: "automatic_rework",
        verifyRetry: {
          attempted: true,
          outcome: "failed",
          failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
          failingTestFiles: ["src/foo.test.ts"],
        },
      });
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);

      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
    });

    it("verify exit 127 は environment failure として記録し、同workerをreworkしない", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm run test" });
      const secretHome = "/Users/private-person";
      const secretPath = `${secretHome}/.vite-plus/bin:/usr/bin:/bin`;
      setRuntimePath(harness, secretPath, [secretPath, secretHome]);
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 127,
        signal: null,
        stdout: "",
        stderr: [
          "sh: vp: command not found",
          `PATH=${secretPath}`,
          `artifact=${secretHome}/.config/private-token`,
        ].join("\n"),
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-environment-fail");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: verify_environment_failed (exit 127)");
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);

      const verify = verifyMetaFromRun(harness, task.id, "sess-verify-environment-fail");
      expect(verify).toMatchObject({
        status: "verify_environment_failed",
        exitCode: 127,
        runtimePathSource: "runtime-path-v1",
      });
      expect(verify.outputTail).toContain("[REDACTED]");
      const persistedText = [
        updated?.blockReason ?? "",
        ...harness.store.listComments(task.id).map((comment) => comment.body),
        ...harness.store.listEvents(task.id).map((event) => event.payload),
        JSON.stringify(readRunMeta(harness, task.id, "sess-verify-environment-fail")),
      ].join("\n");
      expect(persistedText).not.toContain(secretHome);
      expect(persistedText).not.toContain(secretPath);
    });

    it("非zero出力のcommand not foundもenvironment failureとして扱う", async () => {
      setVerifyTenants(harness, { "test-tenant": "missing-tool --check" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "sh: missing-tool: command not found",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-command-not-found");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toBe(
        "review-required: verify_environment_failed (exit 1)",
      );
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-command-not-found").status).toBe(
        "verify_environment_failed",
      );
    });

    it("shell script内のcommand not foundが最終exit 1でもenvironment failureとして扱う", async () => {
      setVerifyTenants(harness, { "test-tenant": "./scripts/verify.sh" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "cleanup completed",
        stderr: "/work/scripts/verify.sh: line 7: vp: command not found",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-script-command-not-found");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toBe(
        "review-required: verify_environment_failed (exit 1)",
      );
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-script-command-not-found").status).toBe(
        "verify_environment_failed",
      );
    });

    it("stdoutへ転送されたcommand not foundもenvironment failureとして扱う", async () => {
      setVerifyTenants(harness, { "test-tenant": "./scripts/verify.sh" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "/work/scripts/verify.sh: line 7: vp: command not found",
        stderr: "",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-stdout-command-not-found");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toBe(
        "review-required: verify_environment_failed (exit 1)",
      );
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-stdout-command-not-found").status).toBe(
        "verify_environment_failed",
      );
    });

    it("stdoutのzsh形式command not foundもenvironment failureとして扱う", async () => {
      setVerifyTenants(harness, { "test-tenant": "./scripts/verify.zsh" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "zsh:1: command not found: vp",
        stderr: "",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-zsh-command-not-found");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toBe(
        "review-required: verify_environment_failed (exit 1)",
      );
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-zsh-command-not-found").status).toBe(
        "verify_environment_failed",
      );
    });

    it("stdoutのassertion文言にcommand not foundが含まれても通常verify failとしてreworkする", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm test" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: "AssertionError: expected message to contain command not found",
        stderr: "",
        timedOut: false,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-command-text");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-command-text",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-command-text").status).toBe("failed");
    });

    it("tenant verify が空白のみなら実行せず失敗 evidence として rework 経路へ流す", async () => {
      setVerifyTenants(harness, { "test-tenant": "   " });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-blank-tenant");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-blank-tenant",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeVerify.calls).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);
      const verify = verifyMetaFromRun(harness, task.id, "sess-verify-blank-tenant");
      expect(verify.status).toBe("failed");
      expect(verify.outputTail).toContain("tenant verify コマンドが空です");
    });

    it("verify 未定義 tenant は従来通り done にし、meta.verify に no-command を監査記録する", async () => {
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-skipped");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeVerify.calls).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-skipped")).toEqual({ skipped: "no-command" });
    });

    it("body の verify:none は tenant verify を上書きして免除する", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewTask("verify none", `cwd: ${tmpCwd}\nverify: none\n本文`);
      harness.store.startRun(task.id, "codex", "sess-verify-none", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeVerify.calls).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-none")).toEqual({ skipped: "verify-none" });
    });

    it("verify timeout は失敗 evidence を保存して rework 経路へ流す", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: null,
        signal: "SIGTERM",
        stdout: "x".repeat(9000),
        stderr: "timeout",
        timedOut: true,
      };
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-timeout");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-timeout",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);
      const verify = verifyMetaFromRun(harness, task.id, "sess-verify-timeout");
      expect(verify.status).toBe("failed");
      expect(verify.timedOut).toBe(true);
      expect(verify.outputTail?.length).toBeLessThanOrEqual(8 * 1024);
    });

    it("dry-run は verify コマンドを実行せず予定だけ notes に記録する", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-dry");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      const result = await reviewStage.tick(harness.deps, false, now());

      expect(fakeVerify.calls).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(result.notes?.some((note) => note.includes("dry-run") && note.includes("verify"))).toBe(true);
    });

    it("verify.disabled がある場合は verify を実行せず従来通り done にする", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      writeFileSync(join(harness.home.home, "verify.disabled"), "", { mode: 0o600 });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const task = createReviewingTask("sess-verify-disabled");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeVerify.calls).toHaveLength(0);
      expect(verifyMetaFromRun(harness, task.id, "sess-verify-disabled")).toEqual({ skipped: "disabled" });
    });

    it("pass + low は user-decision で blocked へ遷移し、reviewer run は done で close する", async () => {
      const task = createReviewingTask("sess-pass-low");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "pass",
          confidence: "low",
          summary: "要確認",
          issues: ["軽微な懸念"],
        }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("user-decision: レビュー pass (confidence=low) 人間確認要");
      expect(updated?.assignee).toBe("human");

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-pass-low");
        expect(run?.status).toBe("done");
      } finally {
        view.close();
      }
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    });

    it("bridge verdict 欠落は同一 session へ1回だけ fence 再出力を注入し review/open run を維持する", async () => {
      const tickNow = 10_000;
      const task = createReviewingTask("sess-nudge");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 500,
        lastResultId: 4420,
      };
      setStructuredBridgeResult(fakeCodex, "レビュー判断は pass です");

      const result = await reviewStage.tick(harness.deps, true, tickNow);

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listOpenRuns().find((run) => run.sessionId === "sess-nudge")).toBeDefined();
      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(fakeCodex.injectCalls[0]?.message).toContain("新たなレビュー、tool実行、verify");
      expect(fakeCodex.injectCalls[0]?.message).toContain("issues / failureCause");
      expect(fakeCodex.injectCalls[0]?.message).toContain("fail の failureCause は必須");
      expect(fakeCodex.launchCalls).toHaveLength(0);
      const events = harness.store.listEvents(task.id, "verdict_nudge_sent");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
        sessionId: "sess-nudge",
        ts: tickNow,
        baselineResultWatermark: 4420,
        baselineLastResultId: 4420,
        baselineResultCount: 500,
      });
    });

    it("verdict nudge 後の同一 watermark tick は再解析・再注入・actionを発生させない", async () => {
      const tickNow = 20_000;
      const task = createReviewingTask("sess-nudge-same-watermark");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 99 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");

      await reviewStage.tick(harness.deps, true, tickNow);
      const transcriptCalls = fakeCodex.transcriptCalls.length;
      const second = await reviewStage.tick(harness.deps, true, tickNow + 1);

      expect(second.actions).toBe(0);
      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(fakeCodex.transcriptCalls).toHaveLength(transcriptCalls);
      expect(harness.store.listEvents(task.id, "verdict_nudge_sent")).toHaveLength(1);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
    });

    it("lastResultId 増加なら resultCount が500capで減っても新resultを通常parserへ戻す", async () => {
      setVerifyTenants(harness, { "test-tenant": "pnpm test" });
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);
      const task = createReviewingTask("sess-nudge-last-result-id");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 500, lastResultId: 4420 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      await reviewStage.tick(harness.deps, true, 30_000);
      await reviewStage.tick(harness.deps, true, 30_001);

      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 480, lastResultId: 4421 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "回収成功", issues: [] }),
        "```",
      ].join("\n"));
      await reviewStage.tick(harness.deps, true, 30_002);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(fakeVerify.calls).toHaveLength(1);
    });

    it("legacy bridge は resultCount 増加を新resultとして通常parserへ戻す", async () => {
      const task = createReviewingTask("sess-nudge-legacy-count");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      await reviewStage.tick(harness.deps, true, 40_000);

      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 2 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "legacy回収", issues: [] }),
        "```",
      ].join("\n"));
      await reviewStage.tick(harness.deps, true, 40_001);

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(fakeCodex.injectCalls).toHaveLength(1);
    });

    it.each([
      ["missing", "fence はありません"],
      ["malformed", "```hachi-verdict-v1\n{broken\n```"],
      [
        "taskId不一致",
        [
          "```hachi-verdict-v1",
          JSON.stringify({ taskId: "t_deadbeef", verdict: "pass", confidence: "high", summary: "別タスク", issues: [] }),
          "```",
        ].join("\n"),
      ],
    ])("nudge後の新resultが%sなら再注入せずneeds-manualへ倒す", async (_label, nextText) => {
      const task = createReviewingTask(`sess-nudge-invalid-${_label}`);
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 100 };
      setStructuredBridgeResult(fakeCodex, "初回 fence 欠落");
      await reviewStage.tick(harness.deps, true, 50_000);

      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 2, lastResultId: 101 };
      setStructuredBridgeResult(fakeCodex, nextText);
      await reviewStage.tick(harness.deps, true, 50_001);

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.getTask(task.id)?.blockReason).toContain("needs-manual: レビュー verdict 欠落");
      expect(harness.store.listEvents(task.id, "verdict_missing")).toHaveLength(1);
      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
    });

    it("verdict nudge の10分grace超過は expired を記録し run failed + needs-manualへ倒す", async () => {
      const task = createReviewingTask("sess-nudge-expired");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 200 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      await reviewStage.tick(harness.deps, true, 60_000);

      const result = await reviewStage.tick(harness.deps, true, 60_600);

      expect(result.actions).toBe(1);
      expect(harness.store.listEvents(task.id, "verdict_nudge_expired")).toHaveLength(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        expect(view.runs(task.id).find((run) => run.sessionId === "sess-nudge-expired")?.status).toBe("failed");
      } finally {
        view.close();
      }
    });

    it.each([
      ["sessionがactive", { state: "active" as const, lastActivityAt: null, resultCount: 1, lastResultId: 200 }],
      ["resultCountが0", { state: "idle" as const, lastActivityAt: null, resultCount: 0, lastResultId: 200 }],
    ])("verdict nudge 後に%sでも10分grace超過を評価する", async (_label, waitingStatus) => {
      const task = createReviewingTask(`sess-nudge-expired-${_label}`);
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 200 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      await reviewStage.tick(harness.deps, true, 65_000);

      fakeCodex.statusResponse = waitingStatus;
      const result = await reviewStage.tick(harness.deps, true, 65_600);

      expect(result.actions).toBe(1);
      expect(harness.store.listEvents(task.id, "verdict_nudge_expired")).toHaveLength(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });

    it("verdict nudge inject失敗は failed を記録し run failed + needs-manualへ倒す", async () => {
      const task = createReviewingTask("sess-nudge-failed");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 300 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      fakeCodex.injectError = new Error("bridge rejected");

      await reviewStage.tick(harness.deps, true, 70_000);

      expect(harness.store.listEvents(task.id, "verdict_nudge_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verdict_nudge_sent")).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
    });

    it("同一sessionの不正なverdict_nudge_sent payloadは再注入せずfail-closed", async () => {
      const task = createReviewingTask("sess-nudge-invalid-event");
      harness.store.addEvent(task.id, "verdict_nudge_sent", "tester", {
        sessionId: "sess-nudge-invalid-event",
        ts: 75_000,
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 350 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");

      await reviewStage.tick(harness.deps, true, 75_001);

      expect(fakeCodex.injectCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_nudge_sent")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verdict_missing")).toHaveLength(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    });

    it("inject中にtask/run/session fenceがstale化した場合はnudge eventを記録しない", async () => {
      const task = createReviewingTask("sess-nudge-stale");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 400 };
      setStructuredBridgeResult(fakeCodex, "fence はありません");
      fakeCodex.injectHook = () => {
        harness.store.block(task.id, "needs-manual: 外部遷移", "tester", "human");
      };

      await reviewStage.tick(harness.deps, true, 80_000);

      expect(fakeCodex.injectCalls).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verdict_nudge_sent")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_missing")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "stale_review_skipped")).toHaveLength(1);
      expect(harness.store.listOpenRuns().find((run) => run.sessionId === "sess-nudge-stale")).toBeDefined();
    });

    it("古いreviewerへのlate resultは最新reviewer runを差し置いてmutationしない", async () => {
      const task = createReviewingTask("sess-reviewer-old");
      harness.store.startRun(task.id, "codex", "sess-reviewer-new", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      fakeCodex.statusResponse = { state: "active", lastActivityAt: null, resultCount: 0 };

      const result = await reviewStage.tick(harness.deps, true, 90_000);

      expect(result.actions).toBe(0);
      expect(fakeCodex.statusCalls.map((ref) => ref.sessionId)).toEqual(["sess-reviewer-new"]);
      expect(fakeCodex.injectCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_nudge_sent")).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
    });

    it("prompt の fail verdict だけを含む 0-token provider 拒否は review rework を起動しない", async () => {
      const task = createReviewingTask("sess-review-provider-rejected-prompt-fence");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 1,
        lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
        raw: {
          messages: [{ type: "result", success: false, text: "usage-limit reached" }],
        },
      };
      setStructuredBridgeResult(fakeCodex, [
        "[user] レビュー完了時は次の形式で出力してください:",
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: "テンプレート例",
          issues: ["例示"],
        }),
        "```",
      ].join("\n"), undefined, true);

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.listEvents(task.id, "provider_capacity_exceeded")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_missing")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(fakeCodex.injectCalls).toHaveLength(0);
    });

    it("capacity 診断を含む direct run でも taskId 一致の妥当な verdict があれば failure 分類しない", async () => {
      const directCodex = new FakeAdapter("codex");
      harness.deps.directAdapters = { codex: directCodex };
      const task = createDirectReviewingTask("direct-review-capacity-valid-verdict");
      directCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      directCodex.transcriptResponse = [
        "provider capacity exceeded の診断後にレビューは完了しました",
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "pass",
          confidence: "high",
          summary: "問題なし",
          issues: [],
        }),
        "```",
      ].join("\n");

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.listEvents(task.id, "provider_capacity_exceeded")).toHaveLength(0);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
    });

    it("0-token でも success:true の valid structured verdict を受理し user の偽 assistant 文言を無視する", async () => {
      const task = createReviewingTask("sess-user-provider-text-valid-verdict");
      const resultText = [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "pass",
          confidence: "high",
          summary: "assistant 境界内の verdict を確認しました",
          issues: [],
        }),
        "```",
      ].join("\n");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 1,
        lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
      };
      setStructuredBridgeResult(fakeCodex, [
        "[user] 再現条件: usage-limit reached",
        `[assistant] ${JSON.stringify("codex: command not found")}`,
        `[assistant] ${resultText}`,
      ].join("\n"), resultText);

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "provider_capacity_exceeded")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "verdict_missing")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });

    it("structured assistant result の安全な抽出不能は nudgeせず extraction_failed でfail-closed", async () => {
      const task = createReviewingTask("sess-extraction-failed");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 1,
        raw: { messages: "not-an-array" },
      };
      fakeCodex.transcriptResponse = "flattened transcript";

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.listEvents(task.id, "extraction_failed")).toHaveLength(1);
      expect(fakeCodex.injectCalls).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });

    it("direct reviewer run の failed close 後に process group cleanup を行う", async () => {
      const directCodex = new FakeAdapter("codex");
      harness.deps.directAdapters = { codex: directCodex };
      const task = createDirectReviewingTask("direct-review-missing");
      directCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      directCodex.transcriptResponse = "verdict がありません";

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      expect(harness.store.getTask(task.id)?.blockReason).toBe(
        "needs-manual: レビュー verdict 欠落 (session=direct-review-missing)",
      );
      expect(directCodex.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-review-missing"]);
      expect(directCodex.injectCalls).toHaveLength(0);
      const run = createKanbanReadView(harness.home.env.dbPath);
      try {
        expect(run.runs(task.id).find((item) => item.sessionId === "direct-review-missing")?.status).toBe("failed");
      } finally {
        run.close();
      }
    });

    it("transcript 取得が3回連続で失敗すると needs-manual へ強制退避し run が close される（契約 §15.2, §12.16-1）", async () => {
      const task = createReviewingTask("sess-fetch-error");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      fakeCodex.transcriptError = new Error("bridge 接続エラー");

      await reviewStage.tick(harness.deps, true, now());
      await reviewStage.tick(harness.deps, true, now());
      expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(2);
      expect(harness.store.getTask(task.id)?.status).toBe("review");

      const third = await reviewStage.tick(harness.deps, true, now());
      expect(third.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("needs-manual: レビュー transcript 取得不能 (session=sess-fetch-error)");
      expect(updated?.assignee).toBe("human");
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

      // コメントは初回失敗分の1件のみ（§12.10-3 の「1回だけコメント」を踏襲）
      expect(harness.store.listComments(task.id)).toHaveLength(1);
    });

    it("pass+high の endRun 時に adapter.status() の lastResult を reviewer run の meta へマージ保存する（docs/contract.md §14.5）", async () => {
      const task = createReviewingTask("sess-stats");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        resultCount: 1,
        lastResult: { costUsd: 0.2, turns: 2, durationMs: 3000, inputTokens: 500, outputTokens: 300 },
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-stats");
        expect(run).toBeDefined();
        expect(run?.status).toBe("done");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.role).toBe("reviewer");
        expect(meta.lastResult).toEqual({
          costUsd: 0.2,
          turns: 2,
          durationMs: 3000,
          inputTokens: 500,
          outputTokens: 300,
        });
      } finally {
        view.close();
      }
    });

    it("dry-run は判定のみで DB に書き込まない", async () => {
      const task = createReviewingTask("sess-dry-verdict");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "OK", issues: [] }),
        "```",
      ].join("\n"));

      const result = await reviewStage.tick(harness.deps, false, now());
      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeDefined();
    });
  });

  describe("classifyVerifyFailure（verify 失敗の flake 判定, このタスクの追加要件）", () => {
    /** ESC(0x1B) を含む文字列を組み立てる。ソース上に生の制御文字/バックスラッシュ表記を書かない。 */
    function ansiCode(code: string): string {
      return `${String.fromCharCode(27)}[${code}`;
    }

    function buildEvidence(overrides: Partial<VerifyEvidence> = {}): VerifyEvidence {
      return {
        status: "failed",
        exitCode: 1,
        signal: null,
        timedOut: false,
        timeoutMs: 15 * 60 * 1000,
        command: "pnpm test",
        cwd: tmpCwd,
        outputTail: "",
        ...overrides,
      };
    }

    it("ANSI装飾（色コード）込みの出力でも失敗テストファイルとテスト名を特定し、再実行が通れば flake と判定する", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const outputTail = [
        `${ansiCode("1m")}${ansiCode("31m")}FAIL${ansiCode("39m")}${ansiCode("22m")}  src/foo.test.ts > suite > test`,
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "passed",
        failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
        failingTestFiles: ["src/foo.test.ts"],
      });
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls[0]?.options.cwd).toBe(tmpCwd);
    });

    it("pnpm --stream の実測プレフィックス（<package> <script>:）付きANSI出力から失敗テストを特定し、再実行が通れば flake と判定する（実測: FORCE_COLOR=1 pnpm --filter @hachi/cli --filter @hachi/supervisor run test src/argv.test.ts を、cli側にのみ一時的に失敗テストを注入して採取）", async () => {
      // 以下の outputTail は、このリポジトリで実際に上記コマンドを実行して採取した生出力を
      // そのまま書き起こしたもの（一時的に注入したテストは採取後 git checkout -- で復元済み）。
      // 2 package を対象に実行したため cli/supervisor 双方の出力が "<package> <script>: "
      // プレフィックス付きで並ぶが、失敗したのは cli のみ。supervisor は無変更のまま全テスト
      // 通過しており、"Tests ... failed" trailer 自体が現れない（vitest は失敗0件のとき
      // trailer に "failed" を含めない）。この package を突合対象から除外する挙動
      // （sumReportedFailingCountsByPackage が package 単位で trailer 有無を扱う設計）も
      // 本テストで併せて検証している。
      mkdirSync(join(tmpCwd, "packages", "cli", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "cli", "src", "argv.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const cliPrefix = `${ansiCode("36m")}packages/cli${ansiCode("39m")} ${ansiCode("96m")}test${ansiCode("39m")}:`;
      const supervisorPrefix = `${ansiCode("35m")}packages/supervisor${ansiCode("39m")} ${ansiCode("96m")}test${ansiCode("39m")}:`;
      const outputTail = [
        `Scope: 2 of 7 workspace projects`,
        `${ansiCode("36m")}packages/cli${ansiCode("39m")} ${ansiCode("96m")}test${ansiCode("39m")}$ vitest run src/argv.test.ts`,
        `${ansiCode("35m")}packages/supervisor${ansiCode("39m")} ${ansiCode("96m")}test${ansiCode("39m")}$ vitest run src/argv.test.ts`,
        `${supervisorPrefix}  RUN  v4.1.9 /Users/dev/.hachi-kanban/worktrees/hk-verify-classification/packages/supervisor`,
        `${cliPrefix}  RUN  v4.1.9 /Users/dev/.hachi-kanban/worktrees/hk-verify-classification/packages/cli`,
        `${supervisorPrefix}  Test Files  1 passed (1)`,
        `${supervisorPrefix}       Tests  22 passed (22)`,
        `${supervisorPrefix}    Start at  00:55:54`,
        `${supervisorPrefix}    Duration  124ms (transform 24ms, setup 0ms, import 34ms, tests 3ms, environment 0ms)`,
        `${cliPrefix}  ❯ src/argv.test.ts (14 tests | 1 failed) 5ms`,
        `${cliPrefix}      × temp fail for single package fixture capture 2ms`,
        `${cliPrefix} ${ansiCode("90m")}⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")} FAIL  src/argv.test.ts > TEMP_FIXTURE_CAPTURE_SINGLE > temp fail for single package fixture capture${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}AssertionError: expected true to be false // Object.is equality${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}- Expected${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}+ Received${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}- false${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}+ true${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")} ❯ src/argv.test.ts:83:18${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}     81| describe("TEMP_FIXTURE_CAPTURE_SINGLE", () => {${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}     82|   it("temp fail for single package fixture capture", () => {${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}     83|     expect(true).toBe(false);${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}       |                  ^${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}     84|   });${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}     85| });${ansiCode("39m")}`,
        `${cliPrefix} ${ansiCode("90m")}⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯${ansiCode("39m")}`,
        `${cliPrefix}  Test Files  1 failed (1)`,
        `${cliPrefix}       Tests  1 failed | 13 passed (14)`,
        `${cliPrefix}    Start at  00:55:54`,
        `${cliPrefix}    Duration  129ms (transform 24ms, setup 0ms, import 34ms, tests 5ms, environment 0ms)`,
        `${cliPrefix} Failed`,
        `/Users/dev/.hachi-kanban/worktrees/hk-verify-classification/packages/cli:`,
        `${ansiCode("41m")}${ansiCode("30m")} ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL ${ansiCode("39m")}${ansiCode("49m")} ${ansiCode("31m")}@hachi/cli@0.1.0 test: \`vitest run src/argv.test.ts\`${ansiCode("39m")}`,
        `${ansiCode("31m")}Exit status 1${ansiCode("39m")}`,
        `${supervisorPrefix} Done`,
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "passed",
        failingTests: [
          {
            package: "packages/cli",
            file: "src/argv.test.ts",
            test: "TEMP_FIXTURE_CAPTURE_SINGLE > temp fail for single package fixture capture",
          },
        ],
        failingTestFiles: ["src/argv.test.ts"],
      });
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/argv.test.ts'");
      expect(fakeVerify.calls[0]?.options.cwd).toBe(join(tmpCwd, "packages", "cli"));
    });

    it("同一ファイル内で複数テストが失敗しても、失敗テスト名は個別に保持しつつ再実行はファイル単位でまとめる", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const outputTail = [
        " FAIL  src/foo.test.ts > suite > test-a",
        " FAIL  src/foo.test.ts > suite > test-b",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry.failingTests).toEqual([
        { package: null, file: "src/foo.test.ts", test: "suite > test-a" },
        { package: null, file: "src/foo.test.ts", test: "suite > test-b" },
      ]);
      expect(result.verifyRetry.failingTestFiles).toEqual(["src/foo.test.ts"]);
      // 再実行はファイル単位（同じファイルを二重に渡さない）。
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
    });

    it("FAIL行が無い出力は失敗テストを特定できず、再実行せず worker_local のまま倒す", async () => {
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: "Error: something broke\nno fail markers here" }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toEqual({
        attempted: false,
        outcome: "not-attempted",
        reason: "failing_tests_not_identified",
        failingTests: [],
        failingTestFiles: [],
        command: null,
      });
      expect(fakeVerify.calls).toHaveLength(0);
    });

    it("FAIL行はあるがファイルが実在しない場合は再実行せず worker_local のまま倒す", async () => {
      const fakeVerify = new FakeVerifyExecutor();
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: " FAIL  src/does-not-exist.test.ts > suite > test" }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toEqual({
        attempted: false,
        outcome: "not-attempted",
        reason: "failing_test_path_unresolved",
        failingTests: [{ package: null, file: "src/does-not-exist.test.ts", test: "suite > test" }],
        failingTestFiles: ["src/does-not-exist.test.ts"],
        command: null,
      });
      expect(fakeVerify.calls).toHaveLength(0);
    });

    it("prefixからpackageを特定済みなら対象ファイルがhost側に存在しなくてもpackage scopeで再実行する", async () => {
      mkdirSync(join(tmpCwd, "packages", "cli"), { recursive: true });
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 1, signal: null, stdout: "", stderr: "test file not found", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({
          outputTail: "packages/cli test: FAIL  src/does-not-exist.test.ts > suite > test",
        }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "failed",
        reason: "retry_failed",
        failingTests: [
          {
            package: "packages/cli",
            file: "src/does-not-exist.test.ts",
            test: "suite > test",
          },
        ],
        failingTestFiles: ["src/does-not-exist.test.ts"],
        command: "pnpm exec vitest run 'src/does-not-exist.test.ts'",
      });
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/does-not-exist.test.ts'");
      expect(fakeVerify.calls[0]?.options.cwd).toBe(join(tmpCwd, "packages", "cli"));
    });

    it("失敗テストが複数packageへ跨っても、各ファイルが個別に一意解決できればpackageごとに再実行し、全て通れば flake と判定する", async () => {
      // 以前は「全失敗ファイルが単一ディレクトリへ一致しない限り再実行を諦める」実装だったが、
      // 個々の失敗自体は package ごとに一意解決できるため、一律 worker_local へ倒すのは過剰だった
      // （§ Fix C）。ここでは packages/a と packages/b それぞれで一意に解決できるファイル名の
      // ケースを検証する（同名パスが複数packageに存在するケースは次のテストで別途検証する）。
      mkdirSync(join(tmpCwd, "packages", "a", "src"), { recursive: true });
      mkdirSync(join(tmpCwd, "packages", "b", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "a", "src", "foo.test.ts"), "");
      writeFileSync(join(tmpCwd, "packages", "b", "src", "bar.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        { exitCode: 0, signal: null, stdout: "retry ok (a)", stderr: "", timedOut: false },
        { exitCode: 0, signal: null, stdout: "retry ok (b)", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const outputTail = [
        " FAIL  src/foo.test.ts > suite > test-a",
        " FAIL  src/bar.test.ts > suite > test-b",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "passed",
        failingTests: [
          { file: "src/foo.test.ts", test: "suite > test-a" },
          { file: "src/bar.test.ts", test: "suite > test-b" },
        ],
        failingTestFiles: ["src/foo.test.ts", "src/bar.test.ts"],
      });
      // package ごとに1回ずつ、計2回（「特定した失敗ごとに厳密1回」を保つ。まとめての1回や
      // 再試行ループにはしない）。
      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls[0]?.options.cwd).toBe(join(tmpCwd, "packages", "a"));
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/bar.test.ts'");
      expect(fakeVerify.calls[1]?.options.cwd).toBe(join(tmpCwd, "packages", "b"));
    });

    it("複数packageに跨る失敗のうち一方の再実行で再現した場合は、全体を worker_local のまま倒す", async () => {
      mkdirSync(join(tmpCwd, "packages", "a", "src"), { recursive: true });
      mkdirSync(join(tmpCwd, "packages", "b", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "a", "src", "foo.test.ts"), "");
      writeFileSync(join(tmpCwd, "packages", "b", "src", "bar.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        { exitCode: 0, signal: null, stdout: "retry ok (a)", stderr: "", timedOut: false },
        { exitCode: 1, signal: null, stdout: "still failing (b)", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const outputTail = [
        " FAIL  src/foo.test.ts > suite > test-a",
        " FAIL  src/bar.test.ts > suite > test-b",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "failed",
        reason: "retry_failed",
        failingTestFiles: ["src/foo.test.ts", "src/bar.test.ts"],
      });
      // package a は通過したが、package b で再現が確定した時点でそれ以降のグループ実行を
      // 打ち切り、全体を worker_local として確定する（グループ順は失敗ファイルの出現順）。
      expect(fakeVerify.calls).toHaveLength(2);
    });

    /**
     * 両 package の同じ相対テストパスへ一時的に同名の失敗を注入し、`FORCE_COLOR=1` の
     * 実 pnpm stream 実行から採取した raw bytes をそのまま読む。採取後は逆パッチし、
     * 両対象ファイルが採取前の SHA-256 に戻ったことを確認済み。
     */
    function collisionFixtureOutputTail(): string {
      return readFileSync(new URL("./fixtures/pnpm-stream-argv-package-collision.txt", import.meta.url), "utf8");
    }

    it("pnpm --stream の実測プレフィックス＋ANSI装飾で、同一相対パス（src/argv.test.ts）が2 packageで衝突する実測形状でも、prefixから package を特定して package ごとに再実行し、全て通れば flake と判定する", async () => {
      mkdirSync(join(tmpCwd, "packages", "cli", "src"), { recursive: true });
      mkdirSync(join(tmpCwd, "packages", "supervisor", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "cli", "src", "argv.test.ts"), "");
      writeFileSync(join(tmpCwd, "packages", "supervisor", "src", "argv.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        { exitCode: 0, signal: null, stdout: "retry ok (cli)", stderr: "", timedOut: false },
        { exitCode: 0, signal: null, stdout: "retry ok (supervisor)", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: collisionFixtureOutputTail() }),
      );

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "passed",
        failingTests: [
          {
            package: "packages/cli",
            file: "src/argv.test.ts",
            test: "TEMP_RAW_PNPM_COLLISION_FIXTURE > fails in both packages for raw fixture capture",
          },
          {
            package: "packages/supervisor",
            file: "src/argv.test.ts",
            test: "TEMP_RAW_PNPM_COLLISION_FIXTURE > fails in both packages for raw fixture capture",
          },
        ],
      });
      // 同じ相対パスでも package が異なるため別の失敗として扱い、衝突を一意に解決した上で
      // package ごとに1回ずつ再実行する（本タスクの起票理由そのものの検証）。
      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/argv.test.ts'");
      expect(fakeVerify.calls[0]?.options.cwd).toBe(join(tmpCwd, "packages", "cli"));
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/argv.test.ts'");
      expect(fakeVerify.calls[1]?.options.cwd).toBe(join(tmpCwd, "packages", "supervisor"));
    });

    it("同一相対パスが2 packageで衝突する実測形状で、一方の package の再実行のみ再現した場合は worker_local のまま倒す（衝突を解決した上で個別に再現性を判定できている証跡）", async () => {
      mkdirSync(join(tmpCwd, "packages", "cli", "src"), { recursive: true });
      mkdirSync(join(tmpCwd, "packages", "supervisor", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "cli", "src", "argv.test.ts"), "");
      writeFileSync(join(tmpCwd, "packages", "supervisor", "src", "argv.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.responses = [
        { exitCode: 0, signal: null, stdout: "retry ok (cli)", stderr: "", timedOut: false },
        { exitCode: 1, signal: null, stdout: "still failing (supervisor)", stderr: "", timedOut: false },
      ];
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: collisionFixtureOutputTail() }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "failed",
        reason: "retry_failed",
        failingTests: [
          {
            package: "packages/cli",
            file: "src/argv.test.ts",
            test: "TEMP_RAW_PNPM_COLLISION_FIXTURE > fails in both packages for raw fixture capture",
          },
          {
            package: "packages/supervisor",
            file: "src/argv.test.ts",
            test: "TEMP_RAW_PNPM_COLLISION_FIXTURE > fails in both packages for raw fixture capture",
          },
        ],
      });
      // cli 側は再現しなかったが、衝突している supervisor 側で再現が確定した時点で全体を
      // worker_local とする（一方の package が通っただけで、衝突している他方も同じく flake と
      // 誤判定しない）。
      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[0]?.options.cwd).toBe(join(tmpCwd, "packages", "cli"));
      expect(fakeVerify.calls[1]?.options.cwd).toBe(join(tmpCwd, "packages", "supervisor"));
    });

    it("同じ相対パスのテストファイルが複数packageに存在し、失敗が単一ファイルの場合でも一意解決できず worker_local のまま倒す（誤った package の成功を根拠にしない）", async () => {
      // packages/a と packages/b の双方に同じ相対パス "src/index.test.ts" が実在する。
      // 実際に落ちたのは（例えば）packages/b 側だが、出力からはどちらか判別できないため、
      // 先頭候補（packages/a）を安易に採用して再実行し「通った」と誤判定してはならない。
      mkdirSync(join(tmpCwd, "packages", "a", "src"), { recursive: true });
      mkdirSync(join(tmpCwd, "packages", "b", "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "packages", "a", "src", "index.test.ts"), "");
      writeFileSync(join(tmpCwd, "packages", "b", "src", "index.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      // 誤って呼ばれた場合に検知できるよう、呼ばれたら常に「通った」を返す fake にしておく。
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: " FAIL  src/index.test.ts > suite > test" }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry.reason).toBe("failing_test_path_unresolved");
      expect(result.verifyRetry.failingTestFiles).toEqual(["src/index.test.ts"]);
      expect(result.verifyRetry.attempted).toBe(false);
      expect(fakeVerify.calls).toHaveLength(0);
    });

    it("再実行がtimeoutした場合は再現とみなさず worker_local のまま倒す", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: true };
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: " FAIL  src/foo.test.ts > suite > test" }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry.reason).toBe("retry_timed_out");
      expect(result.verifyRetry.attempted).toBe(true);
      expect(result.verifyRetry.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls).toHaveLength(1);
    });

    it("再実行のexecutorがthrowした場合は再現とみなさず worker_local のまま倒す", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.error = new Error("spawn failed: ENOENT");
      setVerifyExecutor(harness, fakeVerify);

      const result = await classifyVerifyFailure(
        harness.deps,
        buildEvidence({ outputTail: " FAIL  src/foo.test.ts > suite > test" }),
      );

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry.reason).toBe("retry_error: spawn failed: ENOENT");
      expect(result.verifyRetry.attempted).toBe(true);
      expect(result.verifyRetry.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls).toHaveLength(1);
    });

    // 実際の flake（kill EPERM / ENOTEMPTY）を模したケース。
    // 契約 §0.6.2 が言う「環境・evidence 制約」の典型例で、本タスクの直接の起票理由
    // （t_da7e9d7aaf3e5942 run 1334 の direct-codex.test.ts kill EPERM）を再現する。
    it("kill EPERM による flake（実測: direct-codex.test.ts の stop テスト）を模した出力から再実行し、通れば flake と判定する", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "direct-codex.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      // 実測（2026-08-21 / t_da7e9d7aaf3e5942 run 1334）の出力を模した内容。
      const outputTail = [
        " ❯ src/direct-codex.test.ts (29 tests | 1 failed)",
        "",
        "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
        "",
        " FAIL  src/direct-codex.test.ts > stop（契約 §34.2）> 既にプロセスが終了している場合は already-exited を返す",
        "Error: kill EPERM",
        "    at process.kill (node:internal/process/per_thread:220:13)",
        "",
        " Test Files  1 failed | 4 passed (5)",
        "      Tests  1 failed | 443 passed (444)",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("environment_evidence");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "passed",
        failingTests: [
          {
            file: "src/direct-codex.test.ts",
            test: "stop（契約 §34.2）> 既にプロセスが終了している場合は already-exited を返す",
          },
        ],
        failingTestFiles: ["src/direct-codex.test.ts"],
      });
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/direct-codex.test.ts'");
    });

    it("ENOTEMPTY による flake（worktree cleanup 競合を想定）を模した出力から再実行し、再現すれば worker_local のまま倒す", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "direct-transport.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      // ここでは再実行でも再現する（実欠陥の場合）を検証する。
      fakeVerify.response = { exitCode: 1, signal: null, stdout: "still failing", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      const outputTail = [
        " FAIL  src/direct-transport.test.ts > worktree cleanup > 一時ディレクトリを削除する",
        "Error: ENOTEMPTY: directory not empty, rmdir '/tmp/hachi-worktree-abc123'",
        "    at rmdirSync (node:fs:...)",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toMatchObject({
        attempted: true,
        outcome: "failed",
        failingTests: [
          { file: "src/direct-transport.test.ts", test: "worktree cleanup > 一時ディレクトリを削除する" },
        ],
        failingTestFiles: ["src/direct-transport.test.ts"],
      });
      expect(fakeVerify.calls).toHaveLength(1);
      expect(fakeVerify.calls[0]?.command).toBe("pnpm exec vitest run 'src/direct-transport.test.ts'");
    });

    it("outputTailが上限（8KB）に達している場合は前方欠落の疑いがあるため再実行せず worker_local のまま倒す", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      // 誤って呼ばれた場合に検知できるよう、呼ばれたら常に「通った」を返す fake にしておく。
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      // takeTail は前方切り詰め（tail-keeping）のため、上限ちょうどの長さは「切り詰められた
      // 可能性がある」ことの検出条件そのもの（buildVerifyEvidence の実装と対応）。
      const failLine = " FAIL  src/foo.test.ts > suite > test";
      const padding = "x".repeat(8 * 1024 - failLine.length);
      const outputTail = `${padding}${failLine}`;
      expect(outputTail.length).toBe(8 * 1024);

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toEqual({
        attempted: false,
        outcome: "not-attempted",
        reason: "output_truncated",
        failingTests: [],
        failingTestFiles: [],
        command: null,
      });
      expect(fakeVerify.calls).toHaveLength(0);
    });

    it("抽出した失敗テスト数とvitest自己申告のTests trailerが一致しない場合は再実行せず worker_local のまま倒す（出力の欠落・混入を疑う）", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const fakeVerify = new FakeVerifyExecutor();
      // 誤って呼ばれた場合に検知できるよう、呼ばれたら常に「通った」を返す fake にしておく。
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "retry ok", stderr: "", timedOut: false };
      setVerifyExecutor(harness, fakeVerify);

      // FAIL行からは1件しか抽出できないが、trailer は "2 failed" を申告している
      // ＝出力のどこかで別の失敗テストの記述が欠落している（不一致）。
      const outputTail = [
        " FAIL  src/foo.test.ts > suite > test",
        "Error: boom",
        " Test Files  1 failed | 4 passed (5)",
        "      Tests  2 failed | 443 passed (445)",
      ].join("\n");

      const result = await classifyVerifyFailure(harness.deps, buildEvidence({ outputTail }));

      expect(result.failureCause).toBe("worker_local");
      expect(result.verifyRetry).toMatchObject({
        attempted: false,
        outcome: "not-attempted",
        reason: "failing_test_count_mismatch",
        failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
        failingTestFiles: ["src/foo.test.ts"],
        command: null,
      });
      expect(fakeVerify.calls).toHaveLength(0);
    });
  });

  describe("reviewer run の max 実行時間強制回収（docs/contract.md §34.3）", () => {
    beforeEach(async () => {
      // maxRunSeconds を小さい値に上書きし、経過時間の判定を決定的にする（実時間経過に頼らない）。
      await harness.cleanup();
      harness = await setupHarness({ resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2, maxRunSeconds: 60 } });
      fakeCodex = new FakeAdapter("codex");
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    });

    it("reviewer max-runtime は即 stop/close せず durable cancel request を作る", async () => {
      const task = createReviewingTask("sess-max-runtime-1");
      fakeCodex.stopResponse = { stopped: true, reason: "terminated" };

      const farFuture = now() + 100_000; // maxRunSeconds(60s) を確実に超えさせる
      const result = await reviewStage.tick(harness.deps, true, farFuture);
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("review");
      expect(fakeCodex.stopCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
      expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toMatchObject({
        sessionId: "sess-max-runtime-1",
        status: "cancel_requested",
        reason: expect.stringContaining("reviewer max-runtime exceeded"),
      });

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-max-runtime-1");
        expect(run?.status).toBe("running");
      } finally {
        view.close();
      }
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeDefined();
    });

    it("adapter が stop 未実装でも pending request と reviewer run を維持する", async () => {
      const fakeNoStop = new FakeAdapter("codex", { supportsStop: false });
      harness.deps.adapters = { ...harness.deps.adapters, codex: fakeNoStop };
      fakeCodex = fakeNoStop;

      const task = createReviewingTask("sess-max-runtime-2");

      const farFuture = now() + 100_000;
      const result = await reviewStage.tick(harness.deps, true, farFuture);
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
      expect(harness.store.getActiveRunCancelRequestByTask(task.id)).toMatchObject({
        sessionId: "sess-max-runtime-2",
        status: "cancel_requested",
      });
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeDefined();
    });

    it("dry-run は actions を計上するが副作用ゼロ", async () => {
      const task = createReviewingTask("sess-max-runtime-dry");

      const farFuture = now() + 100_000;
      const result = await reviewStage.tick(harness.deps, false, farFuture);
      expect(result.actions).toBe(1);

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
      expect(fakeCodex.stopCalls).toHaveLength(0);
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeDefined();
    });

    it("経過時間が閾値以内なら何もしない（既定 maxRunSeconds=60 に対し通常の now() では未超過）", async () => {
      const task = createReviewingTask("sess-max-runtime-ok");
      fakeCodex.statusResponse = { state: "active", lastActivityAt: null };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(0);
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "run_stop")).toHaveLength(0);
    });
  });

  describe("自動 rework（docs/contract.md §21）", () => {
    it("resource lease を終了済み旧 worker run から新 rework run へ fence 付きで rebind する", async () => {
      const task = createReviewTask();
      const resource = bindPreviewLeaseToEndedWorker(task.id);
      harness.store.startRun(task.id, "codex", "sess-resource-reviewer", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "resource rework", issues: ["fix"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-resource-rework",
        serverUrl: "http://rework.example",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      const newRun = harness.store.getLatestOpenRun(task.id);
      expect(newRun?.sessionId).toBe("sess-resource-rework");
      expect(harness.store.getRuntimeResourceLease(resource.leaseId)).toMatchObject({
        ownerRunId: newRun?.id,
        fence: resource.fence + 1,
      });
      expect(fakeCodex.launchCalls[0]?.options.promptText).toContain(resource.leaseId);
    });

    it("resource lease の旧 owner run が active なら外部 launch・新 run・rebind を行わない", async () => {
      const task = createReviewTask();
      const resource = bindPreviewLeaseToEndedWorker(task.id, false);
      harness.store.startRun(task.id, "codex", "sess-active-owner-reviewer", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "active owner", issues: ["fix"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(harness.store.getLatestOpenRun(task.id)?.id).toBe(resource.oldRunId);
      expect(harness.store.getRuntimeResourceLease(resource.leaseId)).toMatchObject({
        ownerRunId: resource.oldRunId,
        fence: resource.fence,
      });
      expect(
        harness.store.listRuntimeResourceEvents(resource.leaseId).filter((event) => event.eventType === "lease_run_rebound"),
      ).toHaveLength(0);
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked" });
      expect(harness.store.getTask(task.id)?.blockReason).toContain("fresh ownership/fence");
    });

    it("resource lease の旧 owner run を取得できない場合も外部 launch・新 run・rebind を行わない", async () => {
      const task = createReviewTask();
      const resource = bindPreviewLeaseToEndedWorker(task.id);
      harness.store.startRun(task.id, "codex", "sess-unknown-owner-reviewer", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      const getRun = harness.store.getRun.bind(harness.store);
      harness.store.getRun = (runId: number) => runId === resource.oldRunId ? null : getRun(runId);
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "unknown owner", issues: ["fix"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getRuntimeResourceLease(resource.leaseId)).toMatchObject({
        ownerRunId: resource.oldRunId,
        fence: resource.fence,
      });
      expect(
        harness.store.listRuntimeResourceEvents(resource.leaseId).filter((event) => event.eventType === "lease_run_rebound"),
      ).toHaveLength(0);
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked" });
    });

    it("fail 1回目は rework を起動する（attempt=1, blocked(in-progress) + role=rework）", async () => {
      const task = createReviewingTask("sess-fail-1");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "バグがあります", issues: ["バグA"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-1",
        serverUrl: "http://rework-server.example",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
      expect(updated?.blockReason).toContain("even-session=sess-rework-1");

      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(1);
      expect(JSON.parse(harness.store.listEvents(task.id, "verdict_failed")[0]!.payload)).toMatchObject({
        failureCause: "worker_local",
        failureCauseSource: "reported",
        modelFailureCounted: true,
        routingAction: "automatic_rework",
      });
      const lessons = harness.store.listRecentLessons("test-tenant", tmpCwd, 3);
      expect(lessons).toHaveLength(1);
      expect(lessons[0]).toMatchObject({
        trigger: "rework",
        tenant: "test-tenant",
        cwd: tmpCwd,
        sourceTaskId: task.id,
      });
      expect(lessons[0]?.body).toContain("review fail: バグがあります");
      expect(lessons[0]?.body).toContain("バグA");
      const reworkEvents = harness.store.listEvents(task.id, "rework_launched");
      expect(reworkEvents).toHaveLength(1);
      expect(JSON.parse(reworkEvents[0]!.payload)).toMatchObject({ sessionId: "sess-rework-1", attempt: 1 });

      // レビュアー run は close され、role-aware metaを持つrework runのみが open
      const runs = harness.store.listOpenRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.sessionId).toBe("sess-rework-1");
      const meta = JSON.parse(runs[0]?.meta ?? "{}") as Record<string, unknown>;
      expect(meta.reworkAttempt).toBe(1);
      expect(meta.role).toBe("rework");

      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(fakeCodex.launchCalls[0]?.options.model).toBe("gpt-5.6-terra");
      expect(fakeCodex.launchCalls[0]?.options.effort).toBe("xhigh");
      expect(fakeCodex.launchCalls[0]?.options.cwd).toBe(tmpCwd);
    });

    it("rework実launch echoがprofile effortのnative deliveryを欠く場合はrun/resourceへbindしない", async () => {
      const task = createReviewingTask("sess-fail-native-missing", "none");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "rework-effort-missing",
        serverUrl: "http://rework-server.example",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "none",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      const missing = harness.store.listEvents(task.id, "execution_native_delivery_missing");
      expect(missing).toHaveLength(1);
      expect(JSON.parse(missing[0]!.payload)).toMatchObject({ role: "rework", sessionId: "rework-effort-missing" });
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("rework-effort-missing");
    });

    it("direct reworkのnative delivery欠落中断でstopがunsignalableを返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
      // setExecutionOverrides は open run 中のtaskへ適用できないため、createReviewingTask相当の
      // 手順をopen run開始前にoverrideを挟む形で組み立てる。
      const task = createReviewTask();
      harness.store.setExecutionOverrides(
        task.id,
        "worker",
        { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
        "tester",
        activeOrchestratorProvenance(task.id, "rework-direct-native-missing"),
      );
      harness.store.startRun(task.id, "codex", "sess-fail-native-missing-direct", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "none",
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      harness.deps.directAdapters = { codex: fakeCodex };
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "rework-direct-native-missing",
        serverUrl: "direct",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "none",
        startedAt: now(),
      };
      fakeCodex.stopResponse = { stopped: false, reason: "unsignalable" };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      const missing = harness.store.listEvents(task.id, "execution_native_delivery_missing");
      expect(missing).toHaveLength(1);
      expect(JSON.parse(missing[0]!.payload)).toMatchObject({
        role: "rework",
        sessionId: "rework-direct-native-missing",
      });
      expect(fakeCodex.stopCalls.map((ref) => ref.sessionId)).toContain("rework-direct-native-missing");
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });

    it("rework bridge の appliedModel が要求と不一致ならrun/resourceへbindしない", async () => {
      const task = createReviewingTask("sess-fail-native-applied-mismatch", "none");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      const launchResponse: BridgeLaunchSessionRef = {
        provider: "codex",
        sessionId: "rework-applied-model-mismatch",
        serverUrl: "http://rework-server.example",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "native",
        appliedModel: "gpt-5.4",
        appliedEffort: "xhigh",
        startedAt: now(),
      };
      fakeCodex.launchResponse = launchResponse;

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked", assignee: "human" });
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      const missing = harness.store.listEvents(task.id, "execution_native_delivery_missing");
      expect(missing).toHaveLength(1);
      expect(JSON.parse(missing[0]!.payload)).toMatchObject({
        role: "rework",
        sessionId: "rework-applied-model-mismatch",
      });
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("rework-applied-model-mismatch");
    });

    it("rework prompt artifact保存後にtask bodyが変わった場合はworkerをlaunchしない", async () => {
      const task = createReviewingTask("sess-fail-rework-prelaunch-body");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      const getTask = harness.store.getTask.bind(harness.store);
      let bodyChanged = false;
      harness.store.getTask = (taskId: string): TaskRow | null => {
        if (taskId === task.id && !bodyChanged) {
          const artifactDir = join(harness.home.env.artifactsDir, task.id);
          const reworkPromptSaved = existsSync(artifactDir) &&
            readdirSync(artifactDir).some((name) => name.startsWith("prompt-rework1-"));
          if (reworkPromptSaved) {
            harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nrework prompt構築後の仕様変更`, "tester");
            bodyChanged = true;
          }
        }
        return getTask(taskId);
      };

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(bodyChanged).toBe(true);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(result.notes?.join(" ")).toContain("rework設定/configがlaunch直前に変更");
    });

    it("rework launch中にtask bodyが変わった場合はrun/resourceへbindせず孤児sessionを中断する", async () => {
      const task = createReviewingTask("sess-fail-rework-launch-body");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "rework-body-orphan",
        serverUrl: "http://rework-server.example",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.launchHook = (): void => {
        harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nrework launch中の仕様変更`, "tester");
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "orphan_session").map((event) => JSON.parse(event.payload)))
        .toContainEqual(expect.objectContaining({ role: "rework", sessionId: "rework-body-orphan" }));
      expect(fakeCodex.injectCalls.map((call) => call.ref.sessionId)).toContain("rework-body-orphan");
    });

    it("direct reworkがlaunch中のtask body変更で孤児化した場合、stopがunsignalableを返しても例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
      // setExecutionOverrides は open run 中のtaskへ適用できないため、createReviewingTask相当の
      // 手順をopen run開始前にoverrideを挟む形で組み立てる。
      const task = createReviewTask();
      harness.store.setExecutionOverrides(
        task.id,
        "worker",
        { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
        "tester",
        activeOrchestratorProvenance(task.id, "rework-direct-orphan"),
      );
      harness.store.startRun(task.id, "codex", "sess-fail-rework-launch-body-direct", {
        role: "reviewer",
        serverUrl: "http://x",
        model: "gpt-5.5",
        modelDelivery: "native",
      });
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      harness.deps.directAdapters = { codex: fakeCodex };
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "rework-body-orphan-direct",
        serverUrl: "direct",
        model: "gpt-5.6-terra",
        modelDelivery: "native",
        effortDelivery: "native",
        startedAt: now(),
      };
      fakeCodex.stopResponse = { stopped: false, reason: "unsignalable" };
      fakeCodex.launchHook = (): void => {
        harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nrework launch中の仕様変更(direct)`, "tester");
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "orphan_session").map((event) => JSON.parse(event.payload)))
        .toContainEqual(expect.objectContaining({ role: "rework", sessionId: "rework-body-orphan-direct" }));
      expect(fakeCodex.stopCalls.map((ref) => ref.sessionId)).toContain("rework-body-orphan-direct");
      const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
      expect(log).toContain("停止を確認できませんでした");
      expect(log).toContain('"reason":"unsignalable"');
    });

    it("rework launch中にbody変更後adapterがthrowしても古いlaunch failureでblockしない", async () => {
      const task = createReviewingTask("sess-fail-rework-stale-launch");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchError = new Error("rework launch failed after mutation");
      fakeCodex.launchHook = (): void => {
        harness.store.updateBody(task.id, `cwd: ${tmpCwd}\nrework launch中の仕様変更`, "tester");
      };

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "rework_launch_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "stale_launch_failure").map((event) => JSON.parse(event.payload)))
        .toContainEqual(expect.objectContaining({ role: "rework", error: expect.stringContaining("launch failed") }));
      expect(result.notes?.join(" ")).toContain("stale launch failure");
    });

    it("rework unsupported preflight中にconfigが変わった場合は古い理由でblockしない", async () => {
      const task = createReviewingTask("sess-fail-rework-unsupported-config");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "要修正", issues: ["バグ"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      setCompatibilityProbe(harness, async (provider, transport) => {
        writeFileSync(
          join(harness.home.home, "config.json"),
          JSON.stringify({
            ...harness.deps.config,
            resourceGuard: {
              ...harness.deps.config.resourceGuard,
              maxLaunchesPerTick: harness.deps.config.resourceGuard.maxLaunchesPerTick + 1,
            },
          }),
          "utf8",
        );
        return { ok: true, snapshot: incompatibleCapabilitySnapshot(provider, transport) };
      });

      const result = await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      expect(harness.store.listEvents(task.id, "incompatible_model_transport")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      expect(result.notes?.join(" ")).toContain("古い互換性判定を破棄");
    });

    it("worker品質 fail の2回目は既定 rework 上限1回で review-required になる", async () => {
      const task = createReviewingTask("sess-fail-a");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "指摘A", issues: [], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchResponse = {
        provider: "codex",
        sessionId: "sess-rework-a",
        serverUrl: "http://x",
        model: "gpt-5.4",
        modelDelivery: "native",
        startedAt: now(),
      };

      await reviewStage.tick(harness.deps, true, now()); // fail#1(指摘A) → rework attempt=1
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);

      advanceToNextReviewer(task.id, "sess-review-b");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "指摘B", issues: [], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      const result = await reviewStage.tick(harness.deps, true, now()); // fail#2 → 上限到達 → review-required
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("worker_local: Sol/xhigh replacement required");
      expect(updated?.blockReason).toContain("指摘B");
      expect(updated?.assignee).toBe("human");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1); // 2回目は起動しない
      const failures = harness.store.listEvents(task.id, "verdict_failed");
      expect(failures).toHaveLength(2);
      expect(JSON.parse(failures[1]!.payload)).toMatchObject({
        failureCause: "worker_local",
        modelFailureCounted: true,
        routingAction: "orchestrator_sol_xhigh_replacement",
      });
      expect(fakeCodex.launchCalls).toHaveLength(1);
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    });

    it("worker_major は1回目でも同じworkerを起動せずSol/xhigh replacement待ちにする", async () => {
      const task = createReviewingTask("sess-fail-major");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      const secret = "sk-reviewmajor123456";
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: `重大境界の破壊 token=${secret}`,
          issues: [`secret ${secret}`],
          failureCause: "worker_major",
        }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("worker_major: Sol/xhigh replacement required");
      expect(updated?.blockReason).toContain("token=[REDACTED]");
      const failurePayload = harness.store.listEvents(task.id, "verdict_failed")[0]!.payload;
      expect(JSON.parse(failurePayload)).toMatchObject({
        failureCause: "worker_major",
        failureCauseSource: "reported",
        modelFailureCounted: true,
        routingAction: "orchestrator_sol_xhigh_replacement",
      });
      expect(failurePayload).not.toContain(secret);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      // 契約 §44.1: worker 起因（worker_major）は自動rework しない場合でも lesson として記録する
      expect(harness.store.listRecentLessons("test-tenant", tmpCwd, 3)).toHaveLength(1);
    });

    it.each([
      ["spec_ambiguity"],
      ["environment_evidence"],
      ["late_requirement_change"],
    ] as const)("%s は自動rework枠を消費せずorchestrator回収へ倒す", async (failureCause) => {
      const task = createReviewingTask(`sess-fail-${failureCause}`);
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: `${failureCause} のため停止`,
          issues: [],
          failureCause,
        }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain(`${failureCause}: orchestrator handling required`);
      const failurePayload = JSON.parse(harness.store.listEvents(task.id, "verdict_failed")[0]!.payload);
      expect(failurePayload).toMatchObject({
        failureCause,
        modelFailureCounted: false,
        routingAction: "orchestrator_review_required",
      });
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      // 契約 §44.1: worker 起因でない fail は lesson として記録しない
      // （§44.2 で worker prompt へ注入されるため、worker の責任でない原因を教訓化しない）
      expect(harness.store.listRecentLessons("test-tenant", tmpCwd, 3)).toHaveLength(0);
    });

    it.each([
      ["missing", undefined, "missing"],
      ["unknown", "future_category", "unrecognized"],
    ] as const)("failureCause %s はunknownとしてfail-closedに停止する", async (_label, reportedCause, source) => {
      const task = createReviewingTask(`sess-fail-${_label}`);
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: "分類不能",
          issues: [],
          ...(reportedCause === undefined ? {} : { failureCause: reportedCause }),
        }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toContain(
        "failure_cause_unknown: classification required",
      );
      const failurePayload = harness.store.listEvents(task.id, "verdict_failed")[0]!.payload;
      expect(JSON.parse(failurePayload)).toMatchObject({
        failureCause: "unknown",
        failureCauseSource: source,
        modelFailureCounted: false,
        routingAction: "orchestrator_review_required",
      });
      expect(failurePayload).not.toContain("分類不能");
      expect(failurePayload).not.toContain("future_category");
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
      // 契約 §44.1: 分類できない fail を worker 起因と推測して教訓化しない
      expect(harness.store.listRecentLessons("test-tenant", tmpCwd, 3)).toHaveLength(0);
    });

    it("同じworker_local summaryの再発は未使用枠があってもno-progressで停止する", async () => {
      const task = createReviewingTask("sess-fail-no-progress");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      const sameSummary = "同じ指摘です";
      const summaryHash = createHash("sha256").update(sameSummary).digest("hex").slice(0, 8);
      harness.store.addEvent(task.id, "verdict_failed", "tester", {
        sessionId: "prior-review",
        summaryHash,
        issueCount: 1,
        source: "verdict",
        failureCause: "worker_local",
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: sameSummary,
          issues: [],
          failureCause: "worker_local",
        }),
        "```",
      ].join("\n"));

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)?.blockReason).toContain("worker_local: no-progress");
      expect(harness.store.listEvents(task.id, "rework_no_progress")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      expect(fakeCodex.launchCalls).toHaveLength(0);
    });

    it("rework 起動失敗は auto-launch-failed で blocked へ遷移する", async () => {
      const task = createReviewingTask("sess-fail-launcherr");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "直すべき点", issues: ["A"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchError = new Error("bridge 接続エラー");

      const result = await reviewStage.tick(harness.deps, true, now());
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason.startsWith("auto-launch-failed:")).toBe(true);
      expect(updated?.assignee).toBe("human");

      expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launch_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
      // レビュアー run はすでに verdict 検証 Tx で done close 済み
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    });

    it("rework launch timeout は launch-indeterminate で block する", async () => {
      const task = createReviewingTask("sess-fail-launch-timeout");
      fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "fail", confidence: "high", summary: "直すべき点", issues: ["A"], failureCause: "worker_local" }),
        "```",
      ].join("\n"));
      fakeCodex.launchError = new BridgeError("bridge /api/prompt がタイムアウトしました", "timeout");
      (harness.deps as StageDepsWithLaunchSessionProbe).launchSessionProbe = async () => {
        throw new Error("probe failed Authorization: Bearer raw-probe-secret");
      };

      await reviewStage.tick(harness.deps, true, now());

      expect(harness.store.getTask(task.id)).toMatchObject({
        status: "blocked",
        blockReason: expect.stringMatching(/^needs-manual: launch-indeterminate: rework 起動 \(/),
      });
      expect(harness.store.getTask(task.id)?.blockReason).not.toContain("probe failed");
      const events = harness.store.listEvents(task.id, "rework_launch_indeterminate");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        probeCwd: realpathSync.native(tmpCwd),
        probeProvider: "codex",
        candidateSessions: [],
        probeError: "probe failed Authorization: Bearer [REDACTED]",
      });
      expect(Date.parse(payload.attemptedAt as string)).not.toBeNaN();
      expect(Date.parse(payload.probedAt as string)).toBeGreaterThanOrEqual(Date.parse(payload.attemptedAt as string));
      expect(JSON.stringify(payload)).not.toContain("raw-probe-secret");
      expect(harness.store.listEvents(task.id, "rework_launch_failed")).toHaveLength(0);
      expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(0);
    });
  });
});

describe("reviewStage e2e（実 MockBridgeServer 経由, docs/contract.md §15）", () => {
  let harness: TestHarness;
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = mkdtempSync(join(tmpdir(), "hk-review-e2e-"));
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("dispatch(worker, outcome=review) → finalize → review起動 → verdict(pass+high) → done まで自律遷移する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "実装タスク", body: `cwd: ${tmpCwd}\n本文` }),
      "tester",
    );

    // 1. dispatch: worker を起動する
    const dispatchResult = await dispatchStage.tick(harness.deps, true, now());
    expect(dispatchResult.actions).toBe(1);

    const workerSessionId = harness.codexBridge.sessions()[0];
    expect(workerSessionId).toBeDefined();

    const handoffText = [
      "作業ログ",
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "review", summary: "実装完了。レビューして" }),
      "```",
    ].join("\n");
    harness.codexBridge.completeSession(workerSessionId!, handoffText);

    // finalize は session_ended イベント（monitor が記録）をトリガーに対象を選ぶ（docs/contract.md §13.4）
    const workerCandidateAt = now();
    const monitorResult = await monitorStage.tick(harness.deps, true, workerCandidateAt);
    expect(monitorResult.actions).toBe(1);
    const confirmedMonitor = await monitorStage.tick(harness.deps, true, workerCandidateAt + 60);
    expect(confirmedMonitor.actions).toBe(1);

    // 2. finalize: handoff(outcome=review) を検証し review へ遷移する
    const finalizeResult = await finalizeStage.tick(harness.deps, true, workerCandidateAt + 61);
    expect(finalizeResult.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("review");

    // 3. review 前半: レビュアーを起動する
    const launchResult = await reviewStage.tick(harness.deps, true, now());
    expect(launchResult.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("review");

    const reviewerSessionId = harness.codexBridge.sessions().find((id) => id !== workerSessionId);
    expect(reviewerSessionId).toBeDefined();

    const runs = harness.store.listOpenRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe(reviewerSessionId);
    const runMeta = JSON.parse(runs[0]?.meta ?? "{}") as Record<string, unknown>;
    expect(runMeta.role).toBe("reviewer");

    const verdictText = [
      "レビューログ",
      "```hachi-verdict-v1",
      JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "問題なし", issues: [] }),
      "```",
    ].join("\n");
    harness.codexBridge.completeSession(reviewerSessionId!, verdictText);

    // 4. review 後半: verdict を検証し done へ遷移する
    const verdictResult = await reviewStage.tick(harness.deps, true, now());
    expect(verdictResult.actions).toBe(1);

    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(1);
  });

  it("fail → rework → worker(outcome=review) → 再審 pass+high → done まで自律遷移する（docs/contract.md §21）", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "実装タスク(rework)", body: `cwd: ${tmpCwd}\n本文` }),
      "tester",
    );

    // 1. dispatch: worker を起動する
    const dispatchResult = await dispatchStage.tick(harness.deps, true, now());
    expect(dispatchResult.actions).toBe(1);

    const workerSessionId = harness.codexBridge.sessions()[0];
    expect(workerSessionId).toBeDefined();

    harness.codexBridge.completeSession(
      workerSessionId!,
      [
        "作業ログ",
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "review", summary: "実装完了。レビューして" }),
        "```",
      ].join("\n"),
    );

    const firstWorkerCandidateAt = now();
    await monitorStage.tick(harness.deps, true, firstWorkerCandidateAt);
    await monitorStage.tick(harness.deps, true, firstWorkerCandidateAt + 60);
    await finalizeStage.tick(harness.deps, true, firstWorkerCandidateAt + 61);
    expect(harness.store.getTask(task.id)?.status).toBe("review");

    // 2. review 前半: 1回目のレビュアーを起動する
    await reviewStage.tick(harness.deps, true, now());
    const reviewerSessionId = harness.codexBridge.sessions().find((id) => id !== workerSessionId);
    expect(reviewerSessionId).toBeDefined();

    // 3. 1回目のレビュアーが fail 判定
    harness.codexBridge.completeSession(
      reviewerSessionId!,
      [
        "レビューログ",
        "```hachi-verdict-v1",
        JSON.stringify({
          taskId: task.id,
          verdict: "fail",
          confidence: "high",
          summary: "修正が必要です",
          issues: ["バグA"],
          failureCause: "worker_local",
        }),
        "```",
      ].join("\n"),
    );

    // 4. review 後半: verdict(fail) を検証し rework を起動する（契約 §21.1/§21.2）
    const reworkLaunch = await reviewStage.tick(harness.deps, true, now());
    expect(reworkLaunch.actions).toBeGreaterThanOrEqual(1);
    expect(harness.store.listEvents(task.id, "verdict_failed")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "rework_launched")).toHaveLength(1);

    const afterRework = harness.store.getTask(task.id);
    expect(afterRework?.status).toBe("blocked");
    expect(afterRework?.blockReason.startsWith("codex-in-progress:")).toBe(true);

    const reworkSessionId = harness.codexBridge
      .sessions()
      .find((id) => id !== workerSessionId && id !== reviewerSessionId);
    expect(reworkSessionId).toBeDefined();

    // 5. rework worker が完了報告（outcome=review, 再レビュー必須）
    harness.codexBridge.completeSession(
      reworkSessionId!,
      [
        "修正ログ",
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "review", summary: "修正完了。再レビューして" }),
        "```",
      ].join("\n"),
    );

    const reworkCandidateAt = now();
    await monitorStage.tick(harness.deps, true, reworkCandidateAt);
    await monitorStage.tick(harness.deps, true, reworkCandidateAt + 60);
    await finalizeStage.tick(harness.deps, true, reworkCandidateAt + 61);
    expect(harness.store.getTask(task.id)?.status).toBe("review");

    // 6. review 前半: 2回目のレビュアーを起動する
    await reviewStage.tick(harness.deps, true, now());
    const reviewer2SessionId = harness.codexBridge
      .sessions()
      .find((id) => id !== workerSessionId && id !== reviewerSessionId && id !== reworkSessionId);
    expect(reviewer2SessionId).toBeDefined();

    // 7. 2回目のレビュアーが pass+high 判定 → done
    harness.codexBridge.completeSession(
      reviewer2SessionId!,
      [
        "レビューログ",
        "```hachi-verdict-v1",
        JSON.stringify({ taskId: task.id, verdict: "pass", confidence: "high", summary: "修正確認しました", issues: [] }),
        "```",
      ].join("\n"),
    );
    const finalVerdict = await reviewStage.tick(harness.deps, true, now());
    expect(finalVerdict.actions).toBeGreaterThanOrEqual(1);

    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    expect(harness.store.listEvents(task.id, "verdict_finalized")).toHaveLength(1);
  });
});
