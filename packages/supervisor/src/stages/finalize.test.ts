import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import {
  EXTERNAL_RUNTIME_GENERATION_SCHEMA,
  EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
  EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  createKanbanReadView,
  parseExternalRuntimeGenerationStatus,
  sha256Hex,
} from "@hachi/core";
import type {
  DurableSteerStore,
  HachiConfig,
  RunRow,
  StageDeps,
  SteerDeliveryRow,
  TaskRow,
  ExternalRuntimeGenerationAttestationV1,
} from "@hachi/core";
import type { ProfileEntryConfig } from "@hachi/core/config-schema";
import type { ExternalRuntimeGenerationReader } from "../external-runtime-generation-reader.js";
import {
  CONFIG_FILE_SNAPSHOT_META_KEY,
  CONFIG_MODIFIED_EVENT_TYPE,
  readConfigFileSnapshot,
} from "../config-protection.js";
import {
  HANDOFF_GIT_EVIDENCE_EVENT_TYPE,
  HANDOFF_GIT_LAUNCH_META_KEY,
  NodeHandoffGitEvidenceProbe,
  type HandoffGitEvidenceProbe,
  type HandoffGitLaunchSnapshot,
} from "../handoff-git-evidence.js";
import { FakeAdapter, setupHarness, type TestHarness } from "../test-support.js";
import { dispatchStage } from "./dispatch.js";
import { finalizeStage, type HandoffArtifactPathClaim } from "./finalize.js";
import type {
  RuntimePathBuilder,
  VerifyExecutor,
  VerifyCommandOptions,
  VerifyCommandResult,
} from "./review.js";

interface StageDepsWithHandoffGitEvidenceProbe extends StageDeps {
  handoffGitEvidenceProbe: HandoffGitEvidenceProbe;
}

interface StageDepsWithExternalRuntimeGenerationReader extends StageDeps {
  externalRuntimeGenerationReader?: ExternalRuntimeGenerationReader;
}

/** task_runs.meta.handoffEvidence（証拠検証の判定材料）を test から読むための view */
interface HandoffEvidenceMetaView {
  status: string;
  claims: {
    commitHashes: string[];
    artifactPaths: string[];
    artifactPathClaims: Array<{
      path: string;
      source: "structured" | "summary";
      missingIsFailure: boolean;
    }>;
    commitClaimedWithoutHash: boolean;
  };
  warnings: Array<{ kind: string; message: string; claim?: string }>;
  artifactClaims: { confirmed: string[] };
  commitClaims: { confirmed: string[]; runCommits: string[]; upstream: string[]; unresolved: string[] } | null;
  git: { state: string; commitCount: number | null; localCommitCount: number | null } | null;
}

/**
 * artifacts.ts のファイル名規約（docs/contract.md §12.19-1）と一致させたテスト用ヘルパー。
 * `<prefix>-<sanitized>-<sha256(元ID)先頭8hex>.txt` を組み立てる。
 */
function artifactFilename(prefix: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${prefix}-${safe}-${sha256Hex(id).slice(0, 8)}.txt`;
}

/** bridge 正常系は flattened transcript ではなく structured assistant result を明示する。 */
function setStructuredBridgeResult(
  adapter: FakeAdapter,
  text: string,
  structuredText = text,
  preserveStatusRaw = false,
): void {
  adapter.transcriptResponse = text;
  adapter.statusResponse = {
    ...adapter.statusResponse,
    state: "idle",
    resultCount: adapter.statusResponse.resultCount ?? 1,
    lastResultId: adapter.statusResponse.lastResultId ?? 1,
    lastEntryId: adapter.statusResponse.lastEntryId ?? adapter.statusResponse.lastResultId ?? 1,
  };
  if (!preserveStatusRaw) {
    adapter.statusResponse = {
      ...adapter.statusResponse,
      raw: { messages: [{ type: "result", success: true, text: structuredText }] },
    };
  }
}

function bridgeEndedPayload(sessionId: string, resultWatermark = 1, lastEntryId = resultWatermark): Record<string, unknown> {
  return {
    sessionId,
    provider: "codex",
    resultCount: 1,
    lastResultId: resultWatermark,
    resultWatermark,
    lastEntryId,
    observedAt: 1_000,
  };
}

function terminalExternalGenerationFixture(model: string, observedAt: number): {
  attestation: ExternalRuntimeGenerationAttestationV1;
  running: ReturnType<typeof parseExternalRuntimeGenerationStatus>;
  stopped: ReturnType<typeof parseExternalRuntimeGenerationStatus>;
} {
  const identity = {
    kind: "external-shared-runtime" as const,
    generationId: "7".repeat(32),
    runtimeModelId: model,
    modelReadbackSource: "codex-applied-model" as const,
    writerPid: 401,
    writerProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    runtimePid: 402,
    runtimeProcessStart: "darwin-ps-lstart:Mon Aug 25 10:11:12 2026",
    bootNonce: "8".repeat(32),
    endpointIdentityHash: `sha256:${"9".repeat(64)}`,
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
    observedAt: observedAt - 1_000,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt - 1_000 + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
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
    observedAt: observedAt - 1_000,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    expiresAt: observedAt - 1_000 + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    source: "endpoint-observer" as const,
  };
  const baseStatus = {
    schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
    schemaVersion: 1 as const,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex" as const,
    lane: "even-shared" as const,
    runtimeKey: "external-shared-runtime/codex/even-shared",
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  const running = parseExternalRuntimeGenerationStatus(JSON.stringify({
    ...baseStatus,
    revision: 1,
    state: "running",
    attestations: [attestation],
    transitions: [runningTransition],
    observedAt: observedAt - 1_000,
    expiresAt: observedAt - 1_000 + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  }), "codex");
  const stopped = parseExternalRuntimeGenerationStatus(JSON.stringify({
    ...baseStatus,
    revision: 2,
    state: "stopped",
    attestations: [],
    transitions: [runningTransition, {
      version: 1,
      revision: 2,
      kind: "stopped",
      oldIdentity: identity,
      newIdentity: null,
      lastSeenAt: observedAt,
      stoppedAt: observedAt,
      replacementFirstSeenAt: null,
      observedAt,
      ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      source: "owner-wait",
    }],
    observedAt,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  }), "codex");
  return { attestation, running, stopped };
}

describe("finalizeStage", () => {
  let harness: TestHarness;
  let fakeCodex: FakeAdapter;
  let tmpCwd: string;
  let tmpPaths: string[];

  beforeEach(async () => {
    harness = await setupHarness();
    for (const profile of Object.values(harness.deps.config.profiles)) {
      (profile as ProfileEntryConfig).reviewPolicy = "worker-outcome";
    }
    fakeCodex = new FakeAdapter("codex");
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };
    tmpPaths = [];
    tmpCwd = makeTmpPath("hk-finalize-test-");
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const path of tmpPaths) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function makeTmpPath(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    tmpPaths.push(path);
    return path;
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  }

  function createGitRepoWithOriginMain(): { repo: string; headHash: string } {
    const repo = makeTmpPath("hk-finalize-git-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    const baseHash = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["update-ref", "refs/remotes/origin/main", baseHash]);
    writeFileSync(join(repo, "README.md"), "base\nchange\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "change"]);
    return { repo, headHash: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  function writeRepoFile(repo: string, relativeFile: string, content: string): void {
    const parent = relativeFile.split("/").slice(0, -1).join("/");
    if (parent !== "") {
      mkdirSync(join(repo, parent), { recursive: true });
    }
    writeFileSync(join(repo, relativeFile), content);
  }

  function createDirtyGitRepo(relativeFiles: string[] = ["README.md"]): string {
    const repo = makeTmpPath("hk-finalize-dirty-git-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    for (const relativeFile of relativeFiles) {
      writeRepoFile(repo, relativeFile, `base ${relativeFile}\n`);
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    for (const relativeFile of relativeFiles) {
      writeRepoFile(repo, relativeFile, `dirty ${relativeFile}\n`);
    }
    return repo;
  }

  function createCleanGitRepo(): string {
    const repo = makeTmpPath("hk-finalize-clean-git-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    writeRepoFile(repo, "README.md", "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    return repo;
  }

  async function gitLaunchSnapshot(repo: string): Promise<HandoffGitLaunchSnapshot> {
    return new NodeHandoffGitEvidenceProbe().captureLaunchSnapshot(repo);
  }

  /**
   * 上流 commit が main に先行している worktree を作り、task branch を checkout した状態で返す。
   * run 中に `git merge main` させることで「取り込んだ上流 commit」の状況を再現する。
   */
  function createRepoWithUpstreamAhead(publishToOrigin: boolean): { repo: string; upstreamShort: string } {
    const repo = makeTmpPath("hk-finalize-upstream-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "hachi-test@example.com"]);
    git(repo, ["config", "user.name", "Hachi Test"]);
    writeRepoFile(repo, "README.md", "base\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["branch", "fix/steward-proposal"]);
    writeRepoFile(repo, "packages/core/src/types.ts", "export interface KanbanStore {}\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "steward 提案 API を KanbanStore interface へ宣言する"]);
    const upstreamShort = git(repo, ["rev-parse", "--short", "HEAD"]).trim();
    if (publishToOrigin) {
      git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    }
    git(repo, ["checkout", "-q", "fix/steward-proposal"]);
    return { repo, upstreamShort };
  }

  function readHandoffEvidenceMeta(taskId: string, sessionId: string): HandoffEvidenceMetaView | null {
    const view = createKanbanReadView(harness.home.env.dbPath);
    try {
      const run = view.runs(taskId).find((candidate) => candidate.sessionId === sessionId);
      const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
      return (meta.handoffEvidence as HandoffEvidenceMetaView | undefined) ?? null;
    } finally {
      view.close();
    }
  }

  /** session_ended まで進んだ状態のタスクを構築する */
  function createEndedTask(sessionId: string): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "検証対象" }), "tester");
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, {});
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(sessionId));
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 1 };
    return blocked;
  }

  /** session_ended まで進んだ状態のタスクを任意 body で構築する */
  function createEndedTaskWithBody(
    sessionId: string,
    body: string,
    extraRunMeta: Record<string, unknown> = {},
  ): TaskRow {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "検証対象", body }), "tester");
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, { ...extraRunMeta });
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(sessionId));
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 1 };
    return blocked;
  }

  function queueSteer(
    steerStore: DurableSteerStore,
    taskId: string,
    run: RunRow,
    messageKey: string,
    supersedesId?: string,
  ): SteerDeliveryRow {
    return steerStore.createOrGetSteerDelivery({
      taskId,
      runId: run.id,
      sessionId: run.sessionId,
      messageKey,
      expectedCancelFence: 0,
      ...(supersedesId !== undefined ? { supersedesId } : {}),
      actor: "tester",
    });
  }

  function acceptSteer(
    steerStore: DurableSteerStore,
    run: RunRow,
    delivery: SteerDeliveryRow,
  ): void {
    steerStore.claimSteerDispatch(delivery.id, run.id, run.sessionId, 0, "tester");
    steerStore.markSteerTransportAccepted(delivery.id, run.id, run.sessionId, 0, "tester");
  }

  function listNonSteerTerminalSummaryComments(taskId: string): ReturnType<typeof harness.store.listComments> {
    return harness.store
      .listComments(taskId)
      .filter((comment) => !comment.body.includes("Durable steer 終端サマリ v1"));
  }

  function createDirectEndedTask(
    sessionId: string,
    body = `cwd: ${tmpCwd}`,
    extraRunMeta: Record<string, unknown> = {},
  ): { task: TaskRow; adapter: FakeAdapter } {
    const adapter = new FakeAdapter("codex");
    harness.deps.directAdapters = { codex: adapter };
    const task = harness.store.createTask(taskInput({ status: "ready", title: "direct finalize", body }), "tester");
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=direct started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, {
      serverUrl: "direct",
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "direct",
      ...extraRunMeta,
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", { sessionId, provider: "codex" });
    return { task: blocked, adapter };
  }

  /** injectSession が成功できる MockBridgeServer 上の実 sessionId を持つ bridge run を構築する */
  async function createInjectableBridgeEndedTask(
    body = `cwd: ${tmpCwd}`,
    extraRunMeta: Record<string, unknown> = {},
  ): Promise<TaskRow> {
    const promptRes = await fetch(`${harness.codexBridge.url}/api/prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock-codex-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "作業してください", provider: "codex" }),
    });
    const promptBody = (await promptRes.json()) as { sessionId?: unknown };
    if (typeof promptBody.sessionId !== "string") {
      throw new Error("MockBridgeServer が sessionId を返しませんでした");
    }
    const sessionId = promptBody.sessionId;
    const task = harness.store.createTask(taskInput({ status: "ready", title: "bridge finalize", body }), "tester");
    const blocked = harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=${harness.codexBridge.url} started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, {
      serverUrl: harness.codexBridge.url,
      model: "gpt-5.4",
      modelDelivery: "native",
      transport: "bridge",
      ...extraRunMeta,
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(sessionId));
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 1 };
    return blocked;
  }

  it("正しい handoff（outcome=done）で done へ遷移し artifacts を保存する", async () => {
    const task = createEndedTask("sess-done");
    setStructuredBridgeResult(fakeCodex, [
      "作業ログ",
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.blockReason).toBe("");

    const comments = harness.store.listComments(task.id);
    expect(comments.some((c) => c.body.includes("実装完了"))).toBe(true);

    const transcriptPath = join(harness.deps.env.artifactsDir, task.id, artifactFilename("transcript", "sess-done"));
    expect(readFileSync(transcriptPath, "utf8")).toContain("実装完了");

    expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
  });

  describe("review-policy", () => {
    it("profile 省略時の既定 required では worker の done 申告を review へ遷移させ監査 meta を残す", async () => {
      const defaultProfile = harness.deps.config.profiles[harness.deps.config.defaultProfile];
      expect(defaultProfile).toBeDefined();
      delete (defaultProfile as ProfileEntryConfig).reviewPolicy;
      // cwd と verify 設定を与え、done 直行 verify（§39）が走らないことを実測で確かめる
      const task = createEndedTaskWithBody("sess-review-policy-required", `cwd: ${tmpCwd}`);
      const openRun = harness.store.getLatestOpenRun(task.id)!;
      const verifyCalls: string[] = [];
      (harness.deps.config as HachiConfig & { verify?: { tenants: Record<string, string> } }).verify = {
        tenants: { [task.tenant]: "pnpm -r test" },
      };
      (harness.deps as StageDeps & { verifyExecutor?: VerifyExecutor }).verifyExecutor = {
        run: async (command: string): Promise<VerifyCommandResult> => {
          verifyCalls.push(command);
          return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false };
        },
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装と指定検証を完了しました" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      const runMeta = JSON.parse(harness.store.getRun(openRun.id)!.meta) as Record<string, unknown>;
      expect(runMeta).toMatchObject({
        reviewPolicyApplied: "required",
        workerOutcome: "done",
      });
      // review へ倒す場合は done 直行 verify を走らせない（review 経路の verify に一本化。§76.1）
      expect(verifyCalls).toHaveLength(0);
      expect(runMeta.verify).toBeUndefined();
      // finalized event の outcome は実効値（review）で記録し、申告値は workerOutcome に残す
      // （done-origin の非done finalized 判定と整合させ、後続 reviewer pass を汚染しない）
      const finalizedEvents = harness.store.listEvents(task.id, "finalized");
      expect(finalizedEvents.length).toBeGreaterThan(0);
      expect(JSON.parse(finalizedEvents[finalizedEvents.length - 1]!.payload)).toMatchObject({
        from: "blocked",
        to: "review",
        outcome: "review",
        workerOutcome: "done",
        sessionId: "sess-review-policy-required",
      });
    });

    it("body の worker-outcome 宣言は profile の required より優先して done へ遷移させる", async () => {
      const defaultProfile = harness.deps.config.profiles[harness.deps.config.defaultProfile];
      expect(defaultProfile).toBeDefined();
      (defaultProfile as ProfileEntryConfig).reviewPolicy = "required";
      const task = createEndedTaskWithBody(
        "sess-review-policy-worker-outcome",
        "review-policy: worker-outcome",
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "従来の完了経路を確認しました" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
    });

    it("不正な body 宣言は run を failed にし review-required block へ付け替える", async () => {
      const task = createEndedTaskWithBody("sess-review-policy-invalid", "review-policy: yes");
      const openRun = harness.store.getLatestOpenRun(task.id)!;
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "不正宣言の失敗経路を確認します" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getRun(openRun.id)?.status).toBe("failed");
      expect(harness.store.getTask(task.id)).toMatchObject({
        status: "blocked",
        blockReason: `review-required: handoff 証拠検証失敗 (session=sess-review-policy-invalid)`,
      });
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("review-policy 宣言が不正");
    });
  });

  describe("durable steer 終端サマリ（docs/contract.md §65.4）", () => {
    it("current exact runだけの状態件数と未確認keyを一度記録しhandoff判定を変えない", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "steer summary" }),
        "tester",
      );
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 even-session=steer-old server=http://x",
        "tester",
      );
      const steerStore = harness.store as typeof harness.store & DurableSteerStore;
      const oldRun = harness.store.startRun(task.id, "codex", "steer-old", {});
      const oldAccepted = queueSteer(steerStore, task.id, oldRun, "old-run-key");
      acceptSteer(steerStore, oldRun, oldAccepted);
      harness.store.endRun(oldRun.id, "released");

      const currentRun = harness.store.startRun(task.id, "codex", "steer-current", {});
      const superseded = queueSteer(steerStore, task.id, currentRun, "current-superseded");
      queueSteer(steerStore, task.id, currentRun, "current-expired", superseded.id);

      const pending = queueSteer(steerStore, task.id, currentRun, "current-pending");
      steerStore.claimSteerDispatch(pending.id, currentRun.id, currentRun.sessionId, 0, "tester");

      const delivered = queueSteer(steerStore, task.id, currentRun, "current-delivered");
      acceptSteer(steerStore, currentRun, delivered);
      steerStore.observeSteerDelivery({
        deliveryId: delivered.id,
        expectedRunId: currentRun.id,
        expectedSessionId: currentRun.sessionId,
        expectedCancelFence: 0,
        observedMessageId: "observed-delivered",
        acknowledged: false,
        actor: "tester",
      });

      const acknowledged = queueSteer(steerStore, task.id, currentRun, "current-acknowledged");
      acceptSteer(steerStore, currentRun, acknowledged);
      steerStore.observeSteerDelivery({
        deliveryId: acknowledged.id,
        expectedRunId: currentRun.id,
        expectedSessionId: currentRun.sessionId,
        expectedCancelFence: 0,
        observedMessageId: "observed-acknowledged",
        acknowledged: true,
        actor: "tester",
      });

      const accepted = queueSteer(steerStore, task.id, currentRun, "current-accepted");
      acceptSteer(steerStore, currentRun, accepted);
      const uncertain = queueSteer(steerStore, task.id, currentRun, "current-uncertain");
      steerStore.claimSteerDispatch(uncertain.id, currentRun.id, currentRun.sessionId, 0, "tester");
      steerStore.markSteerDispatchUncertain(uncertain.id, "receipt unknown", "tester");
      const failed = queueSteer(steerStore, task.id, currentRun, "current-failed");
      steerStore.failSteerDelivery(failed.id, "delivery failed", "tester");

      harness.store.addEvent(
        task.id,
        "session_ended",
        "supervisor",
        bridgeEndedPayload(currentRun.sessionId),
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "steer summaryを記録しながら通常の完了判定を維持しました",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.getTask(task.id)?.blockReason).toBe("");
      const summaryEvents = harness.store.listEvents(task.id, "steer_terminal_summary");
      expect(summaryEvents).toHaveLength(1);
      const payload = JSON.parse(summaryEvents[0]!.payload) as {
        version: number;
        runId: number;
        sessionId: string;
        counts: Record<string, number>;
        unacknowledged: { count: number; keys: string[]; truncated: boolean };
        unknown: { count: number; keys: string[]; truncated: boolean };
      };
      expect(payload).toMatchObject({
        version: 1,
        runId: currentRun.id,
        sessionId: currentRun.sessionId,
        counts: {
          pending: 1,
          delivered: 1,
          acknowledged: 1,
          superseded: 1,
          expired: 2,
          unknown: 2,
        },
        unacknowledged: {
          count: 7,
          keys: [
            "current-superseded",
            "current-expired",
            "current-pending",
            "current-delivered",
            "current-accepted",
            "current-uncertain",
            "current-failed",
          ],
          truncated: false,
        },
        unknown: {
          count: 2,
          keys: ["current-accepted", "current-uncertain"],
          truncated: false,
        },
      });
      expect(summaryEvents[0]!.payload).not.toContain("old-run-key");
      expect(summaryEvents[0]!.payload).not.toContain("applied");

      const summaryComments = harness.store
        .listComments(task.id)
        .filter((comment) => comment.body.includes("Durable steer 終端サマリ v1"));
      expect(summaryComments).toHaveLength(1);
      expect(summaryComments[0]!.body).toContain(
        "pending=1, delivered=1, acknowledged=1, superseded=1, expired=2, unknown=2",
      );
      expect(summaryComments[0]!.body).toContain("未acknowledged key (7件)");
      expect(summaryComments[0]!.body).not.toContain("old-run-key");
      expect(summaryComments[0]!.body).not.toContain("applied");

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(harness.store.listEvents(task.id, "steer_terminal_summary")).toHaveLength(1);
      expect(
        harness.store
          .listComments(task.id)
          .filter((comment) => comment.body.includes("Durable steer 終端サマリ v1")),
      ).toHaveLength(1);
    });

    it("steer 0件でも全状態0・空key listを一度記録する", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "empty steer summary" }),
        "tester",
      );
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 even-session=steer-empty server=http://x",
        "tester",
      );
      const run = harness.store.startRun(task.id, "codex", "steer-empty", {});
      harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(run.sessionId));
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "review",
          summary: "steer 0件の終端サマリを確認します",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      const summaryEvents = harness.store.listEvents(task.id, "steer_terminal_summary");
      expect(summaryEvents).toHaveLength(1);
      expect(JSON.parse(summaryEvents[0]!.payload)).toMatchObject({
        version: 1,
        runId: run.id,
        sessionId: run.sessionId,
        counts: {
          pending: 0,
          delivered: 0,
          acknowledged: 0,
          superseded: 0,
          expired: 0,
          unknown: 0,
        },
        unacknowledged: {
          count: 0,
          keys: [],
          truncated: false,
        },
        unknown: {
          count: 0,
          keys: [],
          truncated: false,
        },
      });

      const summaryComments = harness.store
        .listComments(task.id)
        .filter((comment) => comment.body.includes("Durable steer 終端サマリ v1"));
      expect(summaryComments).toHaveLength(1);
      expect(summaryComments[0]!.body).toContain(
        "pending=0, delivered=0, acknowledged=0, superseded=0, expired=0, unknown=0",
      );
      expect(summaryComments[0]!.body).toContain("未acknowledged key (0件): なし");
      expect(summaryComments[0]!.body).toContain("unknown key (0件): なし");

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(harness.store.listEvents(task.id, "steer_terminal_summary")).toHaveLength(1);
      expect(
        harness.store
          .listComments(task.id)
          .filter((comment) => comment.body.includes("Durable steer 終端サマリ v1")),
      ).toHaveLength(1);
    });

    it("未acknowledged/unknown keyを20件に制限しkey本文をredact・truncateする", async () => {
      const task = harness.store.createTask(
        taskInput({ status: "ready", title: "bounded steer summary" }),
        "tester",
      );
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 even-session=steer-bounded server=http://x",
        "tester",
      );
      const run = harness.store.startRun(task.id, "codex", "steer-bounded", {});
      const steerStore = harness.store as typeof harness.store & DurableSteerStore;
      const secret = `sensitive-${"x".repeat(160)}`;
      for (let index = 0; index < 22; index += 1) {
        const key = index === 0 ? `token=${secret}` : `bounded-key-${String(index).padStart(2, "0")}`;
        const delivery = queueSteer(steerStore, task.id, run, key);
        acceptSteer(steerStore, run, delivery);
      }
      harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(run.sessionId));
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "review",
          summary: "bounded steer summaryの確認をレビューへ引き継ぎます",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("review");
      const event = harness.store.listEvents(task.id, "steer_terminal_summary")[0];
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.payload) as {
        unacknowledged: { count: number; keys: string[]; truncated: boolean };
        unknown: { count: number; keys: string[]; truncated: boolean };
      };
      expect(payload.unacknowledged).toMatchObject({ count: 22, truncated: true });
      expect(payload.unacknowledged.keys).toHaveLength(20);
      expect(payload.unknown).toMatchObject({ count: 22, truncated: true });
      expect(payload.unknown.keys).toHaveLength(20);
      expect(event!.payload).not.toContain(secret);
      expect(event!.payload).not.toContain("bounded-key-20");
      expect(event!.payload).not.toContain("bounded-key-21");

      const comment = harness.store
        .listComments(task.id)
        .find((candidate) => candidate.body.includes("Durable steer 終端サマリ v1"));
      expect(comment?.body).toContain("未acknowledged key (22件)");
      expect(comment?.body).toContain("unknown key (22件)");
      expect(comment?.body).not.toContain(secret);
      expect(comment?.body).not.toContain("bounded-key-20");
      expect(comment?.body).not.toContain("bounded-key-21");
    });
  });

  it("direct run の正常 close 後に process group cleanup として stop を呼ぶ（docs/contract.md §51.1）", async () => {
    const { task, adapter } = createDirectEndedTask("direct-finalize-1");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "direct run の完了を確認しました" }),
      "```",
    ].join("\n");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0]?.sessionId).toBe("direct-finalize-1");
    // 契約 §34.2.1: 成功2値（terminated/killed）も reason を証拠として記録する（デフォルトの
    // stopResponse は stopped:true, reason:"terminated"）。stopped:false のときだけ記録すると
    // 成功経路の reason が欠落するため、成功経路でも記録されることをここで確認する。
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("process group cleanup が完了しました");
    expect(log).toContain('"reason":"terminated"');
  });

  it("direct run の正常 close 後の process group cleanup が unsignalable を返した場合は例外扱いにせず停止未確認をwarnする（契約 §34.2.1）", async () => {
    const { task, adapter } = createDirectEndedTask("direct-finalize-1-unsignalable");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "direct run の完了を確認しました" }),
      "```",
    ].join("\n");
    adapter.stopResponse = { stopped: false, reason: "unsignalable" };

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0]?.sessionId).toBe("direct-finalize-1-unsignalable");
    const log = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8");
    expect(log).toContain("停止を確認できませんでした");
    expect(log).toContain('"reason":"unsignalable"');
  });

  it("direct run の handoff missing close 後に process group cleanup として stop を呼ぶ（docs/contract.md §51.1）", async () => {
    const { task, adapter } = createDirectEndedTask("direct-missing-1");
    adapter.transcriptResponse = "handoff fence なし";

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("handoff 欠落");
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-missing-1"]);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
  });

  it("direct run の出力ファイル欠落は worker_output_missing として handoff 欠落へ流さない", async () => {
    const { task, adapter } = createDirectEndedTask("direct-output-missing-1");
    const openRun = harness.store.getLatestOpenRun(task.id)!;
    adapter.transcriptResponse = "(出力ファイルなし)";

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toContain("worker_output_missing");
    const outputEvents = harness.store.listEvents(task.id, "worker_output_missing");
    expect(outputEvents).toHaveLength(1);
    expect(JSON.parse(outputEvents[0]!.payload)).toMatchObject({
      infraCorrelation: { version: 1, state: "unconfirmed" },
    });
    expect(JSON.parse(harness.store.getRun(openRun.id)!.meta)).toMatchObject({
      infraCorrelation: { version: 1, state: "unconfirmed" },
    });
    expect(harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-output-missing-1"]);
  });

  it("exact bindingとunexpired stopped transitionが30秒窓で交差する時だけruntime_generation_interruptedを一度記録する", async () => {
    const sessionId = "external-generation-interrupted";
    const model = "gpt-5.6-sol";
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "external interruption", body: `cwd: ${tmpCwd}` }),
      "tester",
    );
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x`,
      "tester",
    );
    const run = harness.store.startRun(task.id, "codex", sessionId, {
      role: "worker",
      transport: "bridge",
      serverUrl: "http://x",
      model,
      appliedModel: model,
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload(sessionId));
    const terminalEvent = harness.store.listEvents(task.id, "session_ended")[0]!;
    const observedAt = terminalEvent.createdAt * 1_000;
    const fixture = terminalExternalGenerationFixture(model, observedAt);
    harness.store.transaction(() => {
      expect(harness.store.acceptExternalRuntimeGenerationStatus(fixture.running, observedAt - 1_000)).toBe("accepted");
      expect(harness.store.bindExternalRuntimeGenerationLaunch({
        taskId: task.id,
        runId: run.id,
        sessionId,
        role: "worker",
        provider: "codex",
        transport: "bridge",
        attestation: fixture.attestation,
        statusRevision: fixture.running.status.revision,
        statusDigest: fixture.running.canonicalDigest,
        boundAt: observedAt - 500,
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

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1_000));

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "runtime_generation_interrupted")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
    const view = createKanbanReadView(harness.home.env.dbPath);
    const closed = view.runs(task.id)[0]!;
    view.close();
    const meta = JSON.parse(closed.meta) as Record<string, unknown>;
    expect(meta.infraCorrelation).toMatchObject({
      state: "confirmed",
      reason: "runtime_generation_interrupted",
      transitionKind: "stopped",
    });
    const second = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1_000));
    expect(second.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "runtime_generation_interrupted")).toHaveLength(1);
  });

  // 実 git repository を作って probe を通すため、workspace 全体の並列実行では既定 5s に収まらない。
  // 判定内容ではなく subprocess の待ち時間で落ちないよう明示 timeout を置く。
  describe("handoff欠落時のbounded Git evidence（docs/contract.md §65.3）", { timeout: 120_000 }, () => {
    it("worker_output_missingでdirty file count/pathをversioned eventと既存コメントへ一度だけ記録する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "README.md", "dirty body must not be persisted\n");
      writeRepoFile(repo, "src/new.ts", "const secret = 'must-not-be-persisted';\n");
      const { task, adapter } = createDirectEndedTask(
        "direct-output-dirty",
        `cwd: ${repo}`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      adapter.transcriptResponse = "(出力ファイルなし)";

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const events = harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        version: 1,
        trigger: "worker_output_missing",
        sessionId: "direct-output-dirty",
        state: "dirty",
        dirtyFileCount: 2,
        paths: ["README.md", "src/new.ts"],
        commitCount: 0,
        commitSummaries: [],
      });
      const comments = listNonSteerTerminalSummaryComments(task.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Git evidence: dirty");
      expect(comments[0]?.body).not.toContain("dirty body must not be persisted");
      expect(comments[0]?.body).not.toContain("must-not-be-persisted");
      expect(harness.store.getTask(task.id)?.blockReason).toContain("[git=dirty files=2 commits=0]");

      const second = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(second.actions).toBe(0);
      expect(harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)).toHaveLength(1);
      expect(listNonSteerTerminalSummaryComments(task.id)).toHaveLength(1);
    });

    it("handoff救済対象のclean worktreeをclean evidenceとして記録する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      const { task, adapter } = createDirectEndedTask(
        "direct-handoff-clean",
        `cwd: ${repo}`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      adapter.transcriptResponse = "handoff fence なし";

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const events = harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        trigger: "handoff_missing",
        state: "clean",
        dirtyFileCount: 0,
        paths: [],
        commitCount: 0,
      });
      expect(harness.store.listComments(task.id)[0]?.body).toContain("Git evidence: clean");
      expect(harness.store.getTask(task.id)?.blockReason).toContain("[git=clean files=0 commits=0]");
    });

    it("working treeがcleanなcommit-only成果をdirty/commit count/短いsummaryとして記録する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "README.md", "committed\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "成果をcommit"]);
      const { task, adapter } = createDirectEndedTask(
        "direct-handoff-commit-only",
        `cwd: ${repo}`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      adapter.transcriptResponse = "handoff fence なし";

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const event = harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)[0];
      expect(event).toBeDefined();
      expect(JSON.parse(event!.payload)).toMatchObject({
        state: "dirty",
        dirtyFileCount: 0,
        paths: [],
        commitCount: 1,
        commitSummaries: [expect.stringContaining("成果をcommit")],
      });
      expect(harness.store.getTask(task.id)?.blockReason).toContain("[git=dirty files=0 commits=1]");
    });

    it("probe timeoutでもunavailable evidenceを記録してrun closeとneeds-manual化を完了する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      let probeCalls = 0;
      (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
        captureLaunchSnapshot: async (): Promise<HandoffGitLaunchSnapshot> => snapshot,
        captureEndEvidence: async () => {
          probeCalls += 1;
          return {
            schemaVersion: "handoff-git-evidence.v1",
            state: "unavailable",
            dirtyFileCount: null,
            dirtyFileCountTruncated: false,
            paths: [],
            pathsTruncated: false,
            commitCount: null,
            commitSummaries: [],
            localCommitCount: null,
            localCommitOids: [],
            localCommitAttribution: null,
            unavailableReason: "timeout",
          };
        },
      };
      const { task, adapter } = createDirectEndedTask(
        "direct-output-timeout",
        `cwd: ${repo}`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      adapter.transcriptResponse = "(出力ファイルなし)";

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(probeCalls).toBe(1);
      expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
      expect(harness.store.getTask(task.id)?.blockReason).toContain(
        "needs-manual: 実行失敗 worker_output_missing",
      );
      const event = harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)[0];
      expect(JSON.parse(event!.payload)).toMatchObject({
        state: "unavailable",
        unavailableReason: "timeout",
      });
    });
  });

  it("prompt の placeholder handoff だけを含む 0-token provider 拒否は nudge/reject を発生させない", async () => {
    const task = createEndedTask("sess-provider-rejected-prompt-fence");
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
      "[user] 完了時は次の形式で出力してください:",
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "<作業内容の要約>" }),
      "```",
    ].join("\n"), undefined, true);

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.listEvents(task.id, "provider_capacity_exceeded")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_rejected")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
  });

  it("capacity 診断を含む direct run でも taskId 一致の妥当な handoff があれば failure 分類しない", async () => {
    const { task, adapter } = createDirectEndedTask("direct-capacity-valid-handoff");
    adapter.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1 };
    adapter.transcriptResponse = [
      "provider capacity exceeded の診断後に作業は完了しました",
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "成果を正常に回収しました" }),
      "```",
    ].join("\n");

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.listEvents(task.id, "provider_capacity_exceeded")).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
  });

  it("0-token でも success:true の valid structured handoff を受理し user の偽 assistant 文言を無視する", async () => {
    const task = createEndedTask("sess-user-cli-text-valid-handoff");
    const resultText = [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "role 境界を維持して修正と検証を完了しました" }),
      "```",
    ].join("\n");
    fakeCodex.statusResponse = {
      state: "idle",
      lastActivityAt: null,
      resultCount: 1,
      lastResult: { turns: 0, inputTokens: 0, outputTokens: 0 },
    };
    setStructuredBridgeResult(fakeCodex, [
      "[user] 再現条件: codex: command not found",
      `[assistant] ${JSON.stringify("usage-limit reached")}`,
      `[assistant] ${resultText}`,
    ].join("\n"), resultText);

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listEvents(task.id, "cli_startup_failed")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_rejected")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
  });

  it("direct run の handoff rejected close 後に process group cleanup として stop を呼ぶ（docs/contract.md §51.1）", async () => {
    const { task, adapter } = createDirectEndedTask("direct-rejected-1");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "短い" }),
      "```",
    ].join("\n");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "handoff_rejected")).toHaveLength(1);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-rejected-1"]);
  });

  it("direct run の handoff evidence failed close 後に process group cleanup として stop を呼ぶ（docs/contract.md §51.1）", async () => {
    interface StageDepsWithEvidenceVerifier extends StageDeps {
      handoffEvidenceVerifier?: {
        verify(): Promise<{
          ok: boolean;
          claims: {
            commitHashes: string[];
            artifactPaths: HandoffArtifactPathClaim[];
            commitClaimedWithoutHash: boolean;
          };
          failures: Array<{ kind: "verifier"; message: string }>;
        }>;
      };
    }

    const { task, adapter } = createDirectEndedTask("direct-evidence-1");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "証拠検証失敗を模擬する十分な説明です" }),
      "```",
    ].join("\n");
    (harness.deps as StageDepsWithEvidenceVerifier).handoffEvidenceVerifier = {
      verify: async () => ({
        ok: false,
        claims: { commitHashes: [], artifactPaths: [], commitClaimedWithoutHash: false },
        failures: [{ kind: "verifier", message: "fake evidence failure" }],
      }),
    };

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(1);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-evidence-1"]);
  });

  it("run 開始後に config.json が変わっていた場合は警告イベントを記録し finalize は継続する", async () => {
    const configPath = join(harness.home.home, "config.json");
    writeFileSync(configPath, JSON.stringify(harness.deps.config), "utf8");
    const startSnapshot = readConfigFileSnapshot(harness.deps.env);

    const task = harness.store.createTask(taskInput({ status: "ready", title: "config検知対象" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-config-change server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    harness.store.startRun(task.id, "codex", "sess-config-change", {
      [CONFIG_FILE_SNAPSHOT_META_KEY]: startSnapshot,
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      ...bridgeEndedPayload("sess-config-change"),
    });
    writeFileSync(configPath, JSON.stringify({ ...harness.deps.config, defaultProfile: "review" }), "utf8");

    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");

    const events = harness.store.listEvents(task.id, CONFIG_MODIFIED_EVENT_TYPE);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as {
      sessionId: string;
      start: { hash: string | null };
      current: { hash: string | null };
    };
    expect(payload.sessionId).toBe("sess-config-change");
    expect(payload.start.hash).toBe(startSnapshot.hash);
    expect(payload.current.hash).not.toBe(startSnapshot.hash);
  });

  it("outcome=review の handoff は review へ遷移する", async () => {
    const task = createEndedTask("sess-review");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "review", summary: "レビューをお願いします。確認対象あり" }),
      "```",
    ].join("\n"));

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)?.status).toBe("review");
  });

  it("bridge outcome=question の handoff は run を閉じず question_awaiting と worker-question を記録する", async () => {
    const configWithNotify: HachiConfig & { notify: { transports: string[] } } = {
      ...harness.deps.config,
      notify: { transports: [] },
    };
    harness.deps.config = configWithNotify;
    const task = createEndedTask("sess-question");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({
        taskId: task.id,
        outcome: "question",
        summary: "A案とB案のどちらで進めるべきですか。判断材料が不足しています。",
        context: "現在の実装では両方とも可能ですが、互換性の扱いが変わります。",
      }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("worker-question: A案とB案のどちらで進めるべきですか。判断材料が不足しています。");
    expect(updated?.assignee).toBe("");
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    const questionEvents = harness.store.listEvents(task.id, "question_asked");
    expect(questionEvents).toHaveLength(1);
    expect(JSON.parse(questionEvents[0]!.payload)).toMatchObject({
      sessionId: "sess-question",
      questionId: expect.any(String),
    });
    const awaitingEvents = harness.store.listEvents(task.id, "question_awaiting");
    expect(awaitingEvents).toHaveLength(1);
    expect(JSON.parse(awaitingEvents[0]!.payload)).toMatchObject({
      sessionId: "sess-question",
      baselineResultCount: 1,
      questionId: expect.any(String),
    });
    const comments = harness.store.listComments(task.id);
    expect(comments.some((comment) => comment.body.includes("## 質問"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("## 背景"))).toBe(true);
  });

  it("bridge question_awaiting は resultCount が baseline 以下の間 finalize をスキップする", async () => {
    const task = createEndedTask("sess-question-skip");
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-question-skip",
      baselineResultCount: 1,
      deadline: Math.floor(Date.now() / 1000) + 60,
      questionId: "q_skip",
    });
    fakeCodex.transcriptError = new Error("fetchTranscript should not be called");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(fakeCodex.transcriptCalls).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
  });

  it("bridge question_awaiting は lastResultId baseline と同値の間 finalize をスキップする", async () => {
    const task = createEndedTask("sess-question-id-skip");
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      sessionId: "sess-question-id-skip",
      provider: "codex",
      resultCount: 480,
      lastResultId: 4420,
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-question-id-skip",
      baselineResultCount: 480,
      baselineResultWatermark: 4420,
      baselineLastResultId: 4420,
      deadline: Math.floor(Date.now() / 1000) + 60,
      questionId: "q_id_skip",
    });
    fakeCodex.transcriptError = new Error("fetchTranscript should not be called");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(0);
    expect(fakeCodex.transcriptCalls).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("bridge question_awaiting は lastResultId が baseline より大きければ finalize を再開する", async () => {
    const task = createEndedTask("sess-question-id-resume");
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      sessionId: "sess-question-id-resume",
      provider: "codex",
      resultCount: 480,
      lastResultId: 4420,
    });
    harness.store.addEvent(task.id, "question_awaiting", "supervisor", {
      sessionId: "sess-question-id-resume",
      baselineResultCount: 480,
      baselineResultWatermark: 4420,
      baselineLastResultId: 4420,
      deadline: Math.floor(Date.now() / 1000) + 60,
      questionId: "q_id_resume",
    });
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      ...bridgeEndedPayload("sess-question-id-resume", 4421),
      resultCount: 470,
    });
    fakeCodex.statusResponse = {
      state: "idle",
      lastActivityAt: null,
      resultCount: 470,
      lastResultId: 4421,
      lastEntryId: 4421,
    };
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "回答後に完了しました。" }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(fakeCodex.transcriptCalls).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
  });

  it("direct outcome=question は従来どおり run を閉じ worker-question へ付替する", async () => {
    const configWithNotify: HachiConfig & { notify: { transports: string[] } } = {
      ...harness.deps.config,
      notify: { transports: [] },
    };
    harness.deps.config = configWithNotify;
    const { task, adapter } = createDirectEndedTask("direct-question");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({
        taskId: task.id,
        outcome: "question",
        summary: "direct 実行で確認したい仕様があります。",
      }),
      "```",
    ].join("\n");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.blockReason).toBe(
      "worker-question: direct 実行で確認したい仕様があります。",
    );
    expect(harness.store.getLatestOpenRun(task.id)).toBeNull();
    expect(harness.store.listEvents(task.id, "question_awaiting")).toHaveLength(0);
    expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-question"]);
  });

  it("direct outcome=question は即時通知せず notification outbox へ積む", async () => {
    const configWithNotify: HachiConfig & { notify: { transports: string[] } } = {
      ...harness.deps.config,
      notify: { transports: ["unknown-direct-question"] },
    };
    harness.deps.config = configWithNotify;
    const { task, adapter } = createDirectEndedTask("direct-question-notify");
    adapter.transcriptResponse = [
      "```hachi-handoff-v1",
      JSON.stringify({
        taskId: task.id,
        outcome: "question",
        summary: "direct 実行で通知すべき質問です。",
      }),
      "```",
    ].join("\n");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    const outbox = harness.store.listPendingNotificationOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      taskId: task.id,
      kind: "orchestrator_unavailable",
      transport: "configured",
      status: "pending",
    });
  });

  it("outcome=question は既存 assignee=human を保持せずオーケストレーター回収待ちに付け替える", async () => {
    const configWithNotify: HachiConfig & { notify: { transports: string[] } } = {
      ...harness.deps.config,
      notify: { transports: [] },
    };
    harness.deps.config = configWithNotify;
    const task = createEndedTask("sess-question-assignee");
    harness.store.updateBlockReason(task.id, task.blockReason, "tester", "human");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({
        taskId: task.id,
        outcome: "question",
        summary: "オーケストレーター判断が必要な確認事項があります。",
      }),
      "```",
    ].join("\n"));

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("worker-question: オーケストレーター判断が必要な確認事項があります。");
    expect(updated?.assignee).toBe("");
  });

  // 実 git repository を作って probe を通すため、workspace 全体の並列実行では既定 5s に収まらない。
  // 判定内容ではなく subprocess の待ち時間で落ちないよう明示 timeout を置く。
  describe("handoff 証拠検証", { timeout: 120_000 }, () => {
    it("handoff-policy: no-commit 宣言がある場合は dirty working tree を許容し dirty 一覧を完了コメントに残す", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody("sess-no-commit-dirty", `cwd: ${repo}\nhandoff-policy: no-commit`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "モック UI 更新完了" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);

      const comments = harness.store.listComments(task.id);
      const report = comments.find((comment) => comment.body.includes("handoff-policy: no-commit"));
      expect(report?.body).toContain("dirty files:");
      expect(report?.body).toContain("README.md");
    });

    it("evidence-dir 宣言配下の絶対成果物パスを許可する", async () => {
      const evidenceDir = makeTmpPath("hk-finalize-evidence-");
      const artifactPath = join(evidenceDir, "auto-rules-list.png");
      writeFileSync(artifactPath, "fake image");
      const task = createEndedTaskWithBody(
        "sess-evidence-dir-absolute",
        `cwd: ${tmpCwd}\nevidence-dir: ${evidenceDir}`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `スクリーンショット: ${artifactPath}\n実装完了`,
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    it("bare filename の成果物申告は evidence-dir から解決する", async () => {
      const evidenceDir = makeTmpPath("hk-finalize-evidence-bare-");
      writeFileSync(join(evidenceDir, "ocr-rule-drawer-footer.png"), "fake image");
      const task = createEndedTaskWithBody(
        "sess-evidence-dir-bare",
        `cwd: ${tmpCwd}\nevidence-dir: ${evidenceDir}`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "スクリーンショット: ocr-rule-drawer-footer.png\n実装完了",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    /**
     * 既定反転の中核。repo の base commit は run 開始前から存在するため違反に数えず、
     * 未宣言の dirty tree を no-commit として受理する。
     */
    it("handoff-policy 宣言なし + dirty tree は既定 no-commit として done へ通す", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody("sess-default-no-commit-dirty", `cwd: ${repo}`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: await gitLaunchSnapshot(repo),
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const comments = harness.store.listComments(task.id);
      const report = comments.find((comment) => comment.body.includes("handoff-policy: no-commit"));
      expect(report?.body).toContain("dirty files:");
      expect(report?.body).toContain("README.md");
    });

    /** commit は worker commit を許可する明示例外なので、この宣言時だけ従来の clean 要求を維持する。 */
    it("handoff-policy: commit + dirty tree は review-required へ落とす", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody("sess-explicit-commit-dirty", `cwd: ${repo}\nhandoff-policy: commit`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("working tree が clean ではありません");
    });

    it("handoff-policy: 行の次行に no-commit があっても値にせず invalid として失敗する", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody(
        "sess-policy-empty-line",
        `cwd: ${repo}\nhandoff-policy:\nno-commit`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy 宣言が不正");
      expect(events[0]?.payload).not.toContain("working tree が clean ではありません");
    });

    it("未知の handoff-policy 値は commit へ寄せず invalid として失敗する", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody(
        "sess-policy-unknown",
        `cwd: ${repo}\nhandoff-policy: no-comit`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy 宣言が不正");
      expect(events[0]?.payload).not.toContain("working tree が clean ではありません");
    });

    it("handoff-policy 宣言が2行ある場合は最初の物理行だけを有効にする", async () => {
      const repo = createDirtyGitRepo(["README.md"]);
      const task = createEndedTaskWithBody(
        "sess-policy-first-line",
        `cwd: ${repo}\nhandoff-policy: commit\nhandoff-policy: no-commit`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("working tree が clean ではありません");
      expect(events[0]?.payload).not.toContain("handoff-policy 宣言が不正");
    });

    it("既定 no-commit で commit 数を取得できない場合は判定不能を完了コメントに残す", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-default-no-commit-unavailable", `cwd: ${repo}`);
      (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
        captureLaunchSnapshot: async () => ({
          schemaVersion: "handoff-git-launch.v1",
          state: "unavailable",
          reason: "snapshot-unavailable",
        }),
        captureEndEvidence: async () => ({
          schemaVersion: "handoff-git-evidence.v1",
          state: "unavailable",
          dirtyFileCount: null,
          dirtyFileCountTruncated: false,
          paths: [],
          pathsTruncated: false,
          commitCount: null,
          commitSummaries: [],
          localCommitCount: null,
          localCommitOids: [],
          localCommitAttribution: null,
          unavailableReason: "timeout",
        }),
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const comments = harness.store.listComments(task.id);
      expect(comments.some((comment) => comment.body.includes("no-commit 違反を判定できませんでした。reason=timeout"))).toBe(
        true,
      );
    });

    it("既定 no-commit で commit 帰属が ambiguous の場合は判定不能を完了コメントに残す", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-default-no-commit-ambiguous", `cwd: ${repo}`);
      (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
        captureLaunchSnapshot: async () => ({
          schemaVersion: "handoff-git-launch.v1",
          state: "unavailable",
          reason: "snapshot-unavailable",
        }),
        captureEndEvidence: async () => ({
          schemaVersion: "handoff-git-evidence.v1",
          state: "clean",
          dirtyFileCount: 0,
          dirtyFileCountTruncated: false,
          paths: [],
          pathsTruncated: false,
          commitCount: 2,
          commitSummaries: [],
          localCommitCount: 1,
          localCommitOids: ["0123456789abcdef0123456789abcdef01234567"],
          localCommitAttribution: "ambiguous",
        }),
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const comments = harness.store.listComments(task.id);
      expect(comments.some((comment) => comment.body.includes("commit の帰属が ambiguous"))).toBe(true);
    });

    it("t_86a953ad2b1df034 の #404 回帰: no-commit + evidence-dir で dirty tree と bare filename 成果物を通す", async () => {
      const dirtyFiles = [
        "apps/web/src/features/settings/components/ai-extraction-rules-panel.tsx",
        "apps/web/src/features/settings/components/auto-rule-parts.tsx",
        "apps/web/src/features/settings/components/auto-rules-panel.tsx",
        "apps/web/src/features/settings/components/intake-flow-panel.tsx",
        "apps/web/src/features/settings/components/ocr-schema-detail.tsx",
      ];
      const repo = createDirtyGitRepo(dirtyFiles);
      const evidenceDir = makeTmpPath("mock-v7-evidence-");
      writeFileSync(join(evidenceDir, "auto-rules-list.png"), "fake image");
      writeFileSync(join(evidenceDir, "ocr-rule-drawer-footer.png"), "fake image");
      writeFileSync(join(evidenceDir, "ocr-rule-drawer-updated-tooltip.png"), "fake image");
      const task = createEndedTaskWithBody(
        "sess-t86-404",
        [
          `cwd: ${repo}`,
          "handoff-policy: no-commit",
          `evidence-dir: ${evidenceDir}`,
          "",
          "## 受け入れ基準",
          `証跡: ${evidenceDir}`,
          "## 禁止",
          "git commit / push。",
        ].join("\n"),
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: [
            `スクリーンショット: ${join(evidenceDir, "auto-rules-list.png")}`,
            "スクリーンショット: ocr-rule-drawer-footer.png",
            "スクリーンショット: ocr-rule-drawer-updated-tooltip.png",
            "grep と UI 確認が完了しました",
          ].join("\n"),
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);

      const comments = harness.store.listComments(task.id);
      const report = comments.find((comment) => comment.body.includes("handoff-policy: no-commit"));
      expect(report?.body).toContain("ai-extraction-rules-panel.tsx");
      expect(report?.body).toContain("dirty files:");
    });

    /**
     * D4 による意図的な反転。16進文字列は外部リポジトリの sha / content hash / UUID とも一致するため、
     * 「repository に無い」ことだけを理由に block しない（誤検出として無視する）。
     * 未達の主張は文面ではなく、実測した run 内 commit の側から判定する（下の監査テスト）。
     */
    it("実在しない16進文字列だけを理由に失敗しない（外部識別子との衝突を block にしない）", async () => {
      const { repo } = createGitRepoWithOriginMain();
      const task = createEndedTaskWithBody("sess-bad-commit", `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: await gitLaunchSnapshot(repo),
      });
      const missingHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `参照した commit id: ${missingHash}\n実装完了`,
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      // 対照: 候補としては拾われている（＝抽出そのものが空振りしていない）が、実在しないので無視される
      const evidence = readHandoffEvidenceMeta(task.id, "sess-bad-commit");
      expect(evidence?.claims.commitHashes).toEqual([missingHash]);
      expect(evidence?.commitClaims?.unresolved).toEqual([missingHash]);
      expect(evidence?.commitClaims?.confirmed).toEqual([]);
    });

    it("origin/main..HEAD にある commit hash と既存 artifact を主張する正常 handoff は done へ遷移する", async () => {
      const { repo, headHash } = createGitRepoWithOriginMain();
      // このテストの主眼は commit claim と clean tree の従来契約なので、commit 例外を明示する。
      const task = createEndedTaskWithBody("sess-good-evidence", `cwd: ${repo}\nhandoff-policy: commit`);
      const artifactDir = join(harness.deps.env.artifactsDir, task.id);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "ui-result.png"), "fake image");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `commit: ${headHash}\nスクリーンショット: ui-result.png\n実装完了`,
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    it("主張された成果物パスが存在しない場合は review-required へ落とす", async () => {
      const task = createEndedTaskWithBody("sess-missing-artifact", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "スクリーンショット: ui-missing.png\n実装完了",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: handoff 証拠検証失敗 (session=sess-missing-artifact)");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(1);
      expect(harness.store.listComments(task.id)[0]?.body).toContain(
        "主張された成果物パスが存在しません: ui-missing.png。成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される",
      );
    });

    it("summary 散文の説明的なパス表記が存在しなくても証拠検証を通す", async () => {
      const task = createEndedTaskWithBody(
        "sess-summary-artifact-prose",
        `cwd: ${tmpCwd}\nhandoff-policy: commit`,
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "成果物: prompt.ts の worker/rework テンプレと AGENTS.md を更新",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const evidence = readHandoffEvidenceMeta(task.id, "sess-summary-artifact-prose");
      expect(evidence?.status).toBe("passed");
      expect(evidence?.claims.artifactPathClaims).toEqual([
        { path: "AGENTS.md", source: "summary", missingIsFailure: false },
      ]);
      expect(evidence?.warnings).toMatchObject([{ kind: "artifact", claim: "AGENTS.md" }]);
      expect(evidence?.artifactClaims.confirmed).toEqual([]);
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      expect(harness.store.listComments(task.id)[0]?.body).toContain("handoff 証拠 warning: artifact AGENTS.md");
    });

    it("summary 散文のディレクトリ付き ui-* パスが存在しない場合は review-required へ落とす", async () => {
      const task = createEndedTaskWithBody("sess-summary-ui-dir-missing", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "スクリーンショット: screens/ui-missing.png\n実装完了",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: handoff 証拠検証失敗 (session=sess-summary-ui-dir-missing)");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(1);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-summary-ui-dir-missing");
      expect(evidence?.status).toBe("failed");
      expect(evidence?.claims.artifactPathClaims).toEqual([
        { path: "screens/ui-missing.png", source: "summary", missingIsFailure: true },
      ]);
    });

    it("構造化 claim の artifactPaths が許可された場所にない場合は review-required へ落とす", async () => {
      const task = createEndedTaskWithBody("sess-structured-artifact-outside", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "調査メモを書き出しました。実装完了",
          artifactPaths: ["/tmp/outside.md"],
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: handoff 証拠検証失敗 (session=sess-structured-artifact-outside)");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(1);
      expect(harness.store.listComments(task.id)[0]?.body).toContain(
        "成果物パスが許可された場所（cwd または task artifacts）にありません: /tmp/outside.md。成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される",
      );
      const evidence = readHandoffEvidenceMeta(task.id, "sess-structured-artifact-outside");
      expect(evidence?.status).toBe("failed");
      expect(evidence?.claims.artifactPathClaims).toEqual([
        { path: "/tmp/outside.md", source: "structured", missingIsFailure: true },
      ]);
    });

    it("summary 由来のディレクトリ付き ui-* パスが実在すれば confirmed に入り warning を出さない", async () => {
      const task = createEndedTaskWithBody("sess-summary-ui-dir-exists", `cwd: ${tmpCwd}`);
      mkdirSync(join(tmpCwd, "screens"), { recursive: true });
      writeFileSync(join(tmpCwd, "screens", "ui-exists.png"), "fake image");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "スクリーンショット: screens/ui-exists.png\n実装完了",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-summary-ui-dir-exists");
      expect(evidence?.status).toBe("passed");
      expect(evidence?.claims.artifactPathClaims).toEqual([
        { path: "screens/ui-exists.png", source: "summary", missingIsFailure: true },
      ]);
      expect(evidence?.artifactClaims.confirmed).toEqual(["screens/ui-exists.png"]);
      expect(evidence?.warnings).toEqual([]);
      expect(harness.store.listComments(task.id)[0]?.body).not.toContain("handoff 証拠 warning:");
    });

    /**
     * 以下の実文面テストは policy ではなく commit 主張の抽出を固定する。
     * 旧既定で検証していた意図を no-commit 違反検査へ変えないため commit 例外を明示する。
     */
    it("t_6c00dc4a2c2098e5 回帰: uncommitted WIP と述べた summary を commit 主張と誤判定しない", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-uncommitted-wip", `cwd: ${repo}\nhandoff-policy: commit`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary:
            "S1 は uncommitted WIP として存在する。宣言スコープ内の差分のみで、HEAD は base のまま動かしていない",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    it("precommitted のような前置修飾でも commit 主張と誤判定しない", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-precommitted", `cwd: ${repo}\nhandoff-policy: commit`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "precommitted な hook 設定には触れていない。調査結果のみを本文へ整理した",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    /**
     * summary は JSON 1 field で物理行数が常に 1 になるため、行分割では肯定と否定が同居する。
     * 文セグメント単位の近傍判定で否定が肯定を打ち消すことを固定する。
     * 打ち消さない対照ケース（control-no-negation）を同じ表に含め、テストが空虚でないことを保証する。
     * ケースごとに it を分けるのは、1 test あたり実 git repo 生成 + finalize tick が走るため
     * まとめると負荷時に vitest の 5s テストタイムアウトへ触れるため。
     */
    const commitNegationCases: Array<{ label: string; phrase: string; cancels: boolean }> = [
      { label: "mixed-sareteinai", phrase: "commitされていない", cancels: true },
      { label: "mixed-sareteorazu", phrase: "commitされておらず", cancels: true },
      { label: "mixed-shiteinai", phrase: "commitしていない", cancels: true },
      { label: "mixed-mi-commit", phrase: "未commit", cancels: true },
      { label: "mixed-spaced", phrase: "commit されておらず", cancels: true },
      { label: "control-no-negation", phrase: "レビュー待ち", cancels: false },
    ];

    for (const testCase of commitNegationCases) {
      const title = testCase.cancels
        ? `否定表現 ${testCase.phrase} は同一セグメントの肯定 commit 主張を打ち消す`
        : `対照: ${testCase.phrase} は否定ではないので肯定 commit 主張を打ち消さない`;
      it(title, async () => {
        const repo = createCleanGitRepo();
        const task = createEndedTaskWithBody(
          `sess-negation-${testCase.label}`,
          `cwd: ${repo}\nhandoff-policy: commit`,
        );
        setStructuredBridgeResult(fakeCodex, [
          "```hachi-handoff-v1",
          JSON.stringify({
            taskId: task.id,
            outcome: "done",
            summary: `当初はコミット作成まで行う想定だったが、実際は ${testCase.phrase} の状態で作業ツリーに差分を残した`,
          }),
          "```",
        ].join("\n"));

        await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

        const failures = harness.store.listEvents(task.id, "handoff_evidence_failed");
        if (testCase.cancels) {
          expect(harness.store.getTask(task.id)?.status).toBe("done");
          expect(failures).toHaveLength(0);
        } else {
          expect(harness.store.getTask(task.id)?.status).toBe("blocked");
          expect(failures).toHaveLength(1);
        }
      });
    }

    /**
     * summary は 1 物理行なので、行単位判定では別の文の否定まで肯定を打ち消してしまう。
     * 文セグメント単位なら近傍外の否定は打ち消さないことを固定する。
     */
    it("別の文にある否定は近傍外なので肯定 commit 主張を打ち消さない", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "src/s2.ts", "export const s2 = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "S2 を反映"]);
      const task = createEndedTaskWithBody("sess-cross-sentence-negation", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "S1 の下書きは uncommitted WIP のまま残した。S2 は実装をコミット完了として反映した",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("run 開始後の commit 1 件");
    });

    it("肯定文面でも run 開始後に commit が増えていなければ block しない（実 git 状態を正とする）", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      const task = createEndedTaskWithBody("sess-claim-without-actual-commit", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "作業内容をコミット完了として整理した。HEAD は起動時から動いていない",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      // 証拠検証の probe は §65.3 の bounded Git evidence event を二重発行しない
      expect(harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)).toHaveLength(0);
    });

    it("実際に commit が増えていて hash 記載が無い場合は従来どおり review-required へ落とす", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "src/impl.ts", "export const value = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "実装を反映"]);
      // hash 欠落検査を固定するテストであり、no-commit 違反検査へ意味を変えない。
      const task = createEndedTaskWithBody("sess-claim-with-actual-commit", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "実装をコミット完了。詳細は本文の手順どおりに反映した",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("commit hash がありません");
      expect(events[0]?.payload).toContain("run 開始後の commit 1 件");
    });

    it("起動時スナップショットが無く実 git 状態を確認できない場合は肯定文面で従来どおり fail-closed", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-claim-git-unavailable", `cwd: ${repo}\nhandoff-policy: commit`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "実装をコミット完了として引き継ぐ。詳細は本文のとおり",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("実 git 状態を検証できません");
    });

    it("handoff-policy 宣言なしで実際に commit された場合は既定 no-commit 違反として失敗する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "docs/default-note.txt", "調査メモ\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "既定ポリシーの調査メモを追加"]);
      const task = createEndedTaskWithBody("sess-default-no-commit-violation", `cwd: ${repo}`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "調査結果を整理して引き継ぐ。差分の扱いは本文のとおり",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy: no-commit 違反");
      expect(events[0]?.payload).toContain("commit が 1 件作成されています");
    });

    it("handoff-policy: no-commit で実際に commit された場合は no-commit 違反として区別された文言で失敗する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "docs/note.txt", "調査メモ\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "調査メモを追加"]);
      const task = createEndedTaskWithBody(
        "sess-no-commit-violation",
        `cwd: ${repo}\nhandoff-policy: no-commit`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "調査結果を整理して引き継ぐ。差分の扱いは本文のとおり",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy: no-commit 違反");
      expect(events[0]?.payload).toContain("commit が 1 件作成されています");
      // hash 欠落の文言へ潰さず、違反として区別する
      expect(events[0]?.payload).not.toContain("commit hash がありません");
    });

    /**
     * git probe は外部 I/O なので Tx の外で走る。probe 待ちの間に同一 sessionId の
     * replacement run が始まっても、旧 run 由来の証拠で新 run を終端させないことを固定する。
     */
    it("git probe 中に同一 sessionId の run が入れ替わった場合は旧 run の証拠で終端しない", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      const sessionId = "sess-git-probe-race";
      const task = createEndedTaskWithBody(sessionId, `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      const originalRun = harness.store.getLatestOpenRun(task.id);
      expect(originalRun).not.toBeNull();
      (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
        captureLaunchSnapshot: async (): Promise<HandoffGitLaunchSnapshot> => snapshot,
        captureEndEvidence: async () => {
          // probe 待ちの間に旧 run が閉じ、同じ sessionId の run が張り直された状況を作る
          harness.store.endRun(originalRun!.id, "failed", {});
          harness.store.startRun(task.id, "codex", sessionId, {});
          return {
            schemaVersion: "handoff-git-evidence.v1" as const,
            state: "clean" as const,
            dirtyFileCount: 0,
            dirtyFileCountTruncated: false,
            paths: [],
            pathsTruncated: false,
            commitCount: 0,
            commitSummaries: [],
            localCommitCount: 0,
            localCommitOids: [],
            localCommitAttribution: "exact",
          };
        },
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "調査結果を整理して引き継ぐ。詳細は本文のとおり" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).not.toBe("done");
      expect(harness.store.listEvents(task.id, "stale_finalize_skipped")).toHaveLength(1);
      // 差し替わった run は旧 run の証拠で close されない
      expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeDefined();
    });

    it("実 git 状態を根拠に done へ通した場合は判定材料を run meta へ残す", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      const task = createEndedTaskWithBody("sess-git-truth-audit", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "作業内容をコミット完了として整理した。HEAD は起動時から動いていない",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-git-truth-audit");
        expect(run?.status).toBe("done");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        const handoffEvidence = meta.handoffEvidence as { status: string; git: Record<string, unknown> } | undefined;
        expect(handoffEvidence?.status).toBe("passed");
        expect(handoffEvidence?.git).toMatchObject({ state: "clean", commitCount: 0 });
      } finally {
        view.close();
      }
    });

    /**
     * no-commit 違反判定に outcome ゲートを置いていないため、outcome=review でも違反として止まる。
     * 従来は review へ遷移していた経路なので、意図した振る舞いとして固定する。
     */
    it("outcome=review でも no-commit 違反は検出し review 遷移させない", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "docs/note.txt", "調査メモ\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "調査メモを追加"]);
      const task = createEndedTaskWithBody(
        "sess-no-commit-violation-review",
        `cwd: ${repo}\nhandoff-policy: no-commit`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "review",
          summary: "調査結果を整理して引き継ぐ。人手確認をお願いしたい",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe(
        "review-required: handoff 証拠検証失敗 (session=sess-no-commit-violation-review)",
      );
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy: no-commit 違反");
    });

    it("no-commit 違反は肯定文面が同居していても hash 欠落ではなく違反として報告する", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "docs/note.txt", "調査メモ\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "調査メモを追加"]);
      const task = createEndedTaskWithBody(
        "sess-no-commit-violation-with-claim",
        `cwd: ${repo}\nhandoff-policy: no-commit`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "調査結果をコミット完了として引き継ぐ。詳細は本文のとおり",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy: no-commit 違反");
      expect(events[0]?.payload).not.toContain("commit hash がありません");
    });

    /**
     * D4 の実文面回帰（t_aa373c9193f49f07）。外部依存の版数表記を指示どおり記録しただけの handoff が
     * ローカル commit の主張と誤読されないことを固定する。行に `commit` を含めたままにするのは、
     * 抽出が行単位で commit 文脈を要求するため。この語を落とすとテストが空虚になる。
     */
    it("t_aa373c9193f49f07 回帰: 外部パッケージの版数表記を commit 主張として扱わない", async () => {
      const repo = createCleanGitRepo();
      const task = createEndedTaskWithBody("sess-external-package-ref", `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: await gitLaunchSnapshot(repo),
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary:
            "【単価表の選択理由と更新手順】更新は `node scripts/update-model-prices.mjs`" +
            "（GitHub から最新版と commit sha を取得して再生成）。参照版は" +
            " PRICE_TABLE_REF = litellm@a6163e01466303bc522b408ac5b1d9efd0e3248c(2026-08-20T00:56:34Z)" +
            " として全 estimated 値の priceTableRef に残る。",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      // 候補にすら上がらない（＝所有リポジトリの手掛かりが無い形を除外できている）
      expect(readHandoffEvidenceMeta(task.id, "sess-external-package-ref")?.claims.commitHashes).toEqual([]);
    });

    /**
     * D4 の実文面回帰その2（t_aa373c9193f49f07 の別 run）。session id の先頭 8 桁 hex が
     * 日本語に直付けで現れる形。`\b` は仮名・漢字との境界でも成立するため候補には上がるが、
     * repository に実在しないので誤検出として無視する。
     * 上の外部パッケージ版数（候補にも上げない形）とは落ち方が異なるため別に固定する。
     */
    it("t_aa373c9193f49f07 回帰: 日本語に直付けの session id を commit 主張として block しない", async () => {
      const repo = createCleanGitRepo();
      const sessionIdPrefix = "199a85b5";
      const task = createEndedTaskWithBody("sess-log-session-id", `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: await gitLaunchSnapshot(repo),
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary:
            "指摘3件を修正し実ログで検証。(1)claude重複排除をfirst-winsからグループ内最大outputの行を丸ごと採る方式へ変更" +
            `（項目別maxだと5m/1h内訳が別行から混ざり整合が崩れるため）。実ログ${sessionIdPrefix}でoutput 70,140→110,614` +
            "（独立プローブのsumMaxと一致、turns173も一致）。commit は行っていない。",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-log-session-id");
      // 候補には上がる（＝抽出が空振りしていない）が、実在しないので無視される
      expect(evidence?.claims.commitHashes).toContain(sessionIdPrefix);
      expect(evidence?.commitClaims?.unresolved).toContain(sessionIdPrefix);
      expect(evidence?.commitClaims?.confirmed).toEqual([]);
    });

    /**
     * 別種の識別子の形。`captured: false` は候補にも上げない形、`captured: true` は候補には上がるが
     * 実在確認で落ちる形。後者を同じ表に含めることで、抽出そのものを止めた空虚な実装では通らないようにする。
     */
    const foreignIdentifierCases: Array<{ label: string; phrase: string; captured: boolean }> = [
      { label: "sha256-digest", phrase: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae", captured: false },
      { label: "repo-scoped-ref", phrase: "openai/tiktoken@5d970c1100aeee5f1dd785e26e6bcb8ca57d1a3b", captured: false },
      { label: "url-commit-link", phrase: "https://github.com/openai/tiktoken/commit/5d970c1100aeee5f1dd785e26e6bcb8ca57d1a3b", captured: false },
      { label: "uuid-hyphenated", phrase: "123e4567-e89b-12d3-a456-426614174000", captured: false },
      { label: "artifact-file-name", phrase: "transcript-direct-2f72f7f30b6c67be-1e444498.txt", captured: false },
      // ハイフン無し UUID / MD5 は形だけでは commit hash と区別できないため、実在確認で落として無視する
      { label: "uuid-hyphenless", phrase: "123e4567e89b12d3a456426614174000", captured: true },
      { label: "control-bare-hex", phrase: "cafebabecafebabecafebabecafebabecafebabe", captured: true },
    ];

    for (const testCase of foreignIdentifierCases) {
      const title = testCase.captured
        ? `対照: ${testCase.label} は候補には上がるが実在しないので失敗にしない`
        : `${testCase.label} は commit hash 候補にも上げない`;
      it(title, async () => {
        const repo = createCleanGitRepo();
        const sessionId = `sess-foreign-${testCase.label}`;
        const task = createEndedTaskWithBody(sessionId, `cwd: ${repo}\nhandoff-policy: no-commit`, {
          [HANDOFF_GIT_LAUNCH_META_KEY]: await gitLaunchSnapshot(repo),
        });
        setStructuredBridgeResult(fakeCodex, [
          "```hachi-handoff-v1",
          JSON.stringify({
            taskId: task.id,
            outcome: "done",
            summary: `参照した commit 以外の識別子として ${testCase.phrase} を本文へ記録した`,
          }),
          "```",
        ].join("\n"));

        await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

        // いずれの形でも失敗にはしない。差が出るのは「主張として拾ったか」だけ。
        expect(harness.store.getTask(task.id)?.status).toBe("done");
        expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
        const evidence = readHandoffEvidenceMeta(task.id, sessionId);
        if (testCase.captured) {
          expect(evidence?.claims.commitHashes.length).toBeGreaterThan(0);
          expect(evidence?.commitClaims?.unresolved.length).toBeGreaterThan(0);
          expect(evidence?.commitClaims?.confirmed).toEqual([]);
        } else {
          expect(evidence?.claims.commitHashes).toEqual([]);
        }
      });
    }

    /**
     * D4 と「hash 無しの肯定主張」の交差。除外された16進は hash 記載の代わりにならないため、
     * 実際に run 内 commit があれば従来どおり hash 欠落として失敗する。
     * 失敗文言まで固定するのは、除外が退行すると別枝（run 内 commit 未記載）の文言で
     * 落ちてしまい、status だけの検査では差が出ないため。
     */
    it("除外対象の16進しか無い肯定主張は hash 記載の代わりにならない", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "src/impl.ts", "export const value = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "実装を反映"]);
      const task = createEndedTaskWithBody(
        "sess-foreign-hash-not-a-substitute",
        `cwd: ${repo}\nhandoff-policy: commit`,
        {
          [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
        },
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary:
            "実装をコミット完了として反映した。参照版は" +
            " PRICE_TABLE_REF = litellm@a6163e01466303bc522b408ac5b1d9efd0e3248c のまま",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("commit hash がありません");
      expect(events[0]?.payload).toContain("run 開始後の commit 1 件");
    });

    it("commit 範囲表記 <base>..<tip> でも tip 側を run 内 commit の記載として認める", async () => {
      const { repo } = createRepoWithUpstreamAhead(true);
      const snapshot = await gitLaunchSnapshot(repo);
      const baseShort = git(repo, ["rev-parse", "--short", "HEAD"]).trim();
      writeRepoFile(repo, "packages/supervisor/src/stages/steward.ts", "export const steward = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "steward 提案 request ルーティングを実装"]);
      const tipShort = git(repo, ["rev-parse", "--short", "HEAD"]).trim();
      const task = createEndedTaskWithBody("sess-commit-range", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `この run の commit は ${baseShort}..${tipShort} の1件`,
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      expect(readHandoffEvidenceMeta(task.id, "sess-commit-range")?.commitClaims?.runCommits).toEqual([tipShort]);
    });

    /**
     * D5 の実文面回帰（t_6c00dc4a2c2098e5）。run 中に `git merge main` で取り込んだ上流 commit へ
     * 言及しただけの handoff を、未達の主張として扱わないことを固定する。
     * 上流 commit は origin/main..HEAD の範囲外になるため、旧実装では正当な報告が失敗していた。
     */
    it("t_6c00dc4a2c2098e5 回帰: 取り込み済みの上流 commit への言及で失敗しない", async () => {
      const { repo, upstreamShort } = createRepoWithUpstreamAhead(true);
      const snapshot = await gitLaunchSnapshot(repo);
      git(repo, ["merge", "--ff-only", "main"]);
      const task = createEndedTaskWithBody(
        "sess-upstream-mention",
        `cwd: ${repo}\nhandoff-policy: no-commit`,
        { [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot },
      );
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary:
            "契約§69 の steward 提案 request ルーティングを supervisor 側で実装。worktree に未コミットの差分5ファイル。" +
            `\`git log --oneline -1\` = ${upstreamShort}（\`git merge main\` の fast-forward 後の tip）から動いていない。`,
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-upstream-mention");
      // 実在は確認したうえで「この run の成果ではない commit」として記録するに留める
      expect(evidence?.commitClaims?.upstream).toEqual([upstreamShort]);
      expect(evidence?.commitClaims?.runCommits).toEqual([]);
      // 取り込んだ上流 commit は worker が作った commit として数えない（no-commit 違反にしない）
      expect(evidence?.git?.commitCount).toBe(1);
      expect(evidence?.git?.localCommitCount).toBe(0);
    });

    /**
     * 上流 commit を成果から外す仕組みが、worker 自身の push まで免罪しないことを固定する。
     * push すると `origin/<branch>` が前進するため、これを無条件に「run 前から在った証拠」と
     * 扱うと no-commit 違反を見逃す（policy 迂回が無検出になる）。
     */
    it("no-commit 下で commit して push した場合も違反として検出する", async () => {
      const { repo } = createRepoWithUpstreamAhead(true);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "docs/note.txt", "調査メモ\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "調査メモを追加"]);
      // push 相当: 現在 branch と同名の remote-tracking ref を前進させる
      git(repo, ["update-ref", "refs/remotes/origin/fix/steward-proposal", git(repo, ["rev-parse", "HEAD"]).trim()]);
      const task = createEndedTaskWithBody("sess-no-commit-pushed", `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "調査結果を整理して引き継ぐ。差分の扱いは本文のとおり",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("handoff-policy: no-commit 違反");
    });

    it("run 中に main を取り込んだだけなら no-commit 違反にしない（上流 commit を成果と数えない）", async () => {
      const { repo } = createRepoWithUpstreamAhead(true);
      const snapshot = await gitLaunchSnapshot(repo);
      git(repo, ["merge", "--ff-only", "main"]);
      const task = createEndedTaskWithBody("sess-merge-only", `cwd: ${repo}\nhandoff-policy: no-commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "main を取り込んだうえで実装し、差分は作業ツリーに残した。詳細は本文のとおり",
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
    });

    /**
     * 監査の中核。失敗にするのは「worker がこの run で作った commit があるのに、その hash が
     * 主張に含まれていない」場合だけ。上流 commit への言及は代替にならない。
     */
    it("run 内 commit があるのに上流 commit の hash しか記載が無い場合は review-required へ落とす", async () => {
      const { repo, upstreamShort } = createRepoWithUpstreamAhead(true);
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "packages/supervisor/src/stages/steward.ts", "export const steward = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "steward 提案 request ルーティングを実装"]);
      const task = createEndedTaskWithBody("sess-run-commit-unrecorded", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `取り込んだ上流 commit は ${upstreamShort} で、そのうえで実装を進めた`,
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("blocked");
      const events = harness.store.listEvents(task.id, "handoff_evidence_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toContain("run 開始後に作成された commit 1 件の hash が handoff に記載されていません");
    });

    /**
     * D4 の除外規則が行き過ぎないことの固定。URL 内の16進は「他リポジトリの sha」として候補から
     * 外すが、それが自リポジトリの run 内 commit を指しているなら記載として認めなければ、
     * commit URL を貼った正当な報告が「hash がありません」で block されてしまう。
     * 除外した16進は失敗理由には決してならず、通す方向にだけ働く。
     *
     * **前提（意図的な限界）**: この救済は git probe が起きている run でしか働かない。probe の起動条件は
     * `no-commit 宣言 / hash 無しの肯定主張 / 候補 hash あり` の3つで、除外済み16進は条件に入れていない。
     * ここでは肯定表現「コミット完了」が trigger になっている。条件へ加えると、外部版数表記しか
     * 書いていない handoff にまで run 内 commit の hash 突合（＝新たな block 経路）が及ぶため広げない。
     */
    it("自リポジトリの commit URL 形式でも run 内 commit を指していれば hash 記載として認める", async () => {
      const repo = createCleanGitRepo();
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "src/impl.ts", "export const value = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "実装を反映"]);
      const runCommit = git(repo, ["rev-parse", "HEAD"]).trim();
      const task = createEndedTaskWithBody("sess-commit-url", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `実装をコミット完了。https://github.com/RyoMatsuuchi/hachi-kanban-oss/commit/${runCommit} を参照`,
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-commit-url");
      // 候補（commitHashes）には入らないが、run 内 commit との突合では記載として認める
      expect(evidence?.claims.commitHashes).toEqual([]);
      expect(evidence?.commitClaims?.runCommits).toEqual([runCommit]);
    });

    it("run 内 commit の hash が記載されていれば上流 commit への言及が同居していても通す", async () => {
      const { repo, upstreamShort } = createRepoWithUpstreamAhead(true);
      const snapshot = await gitLaunchSnapshot(repo);
      writeRepoFile(repo, "packages/supervisor/src/stages/steward.ts", "export const steward = 1;\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "steward 提案 request ルーティングを実装"]);
      const runCommitShort = git(repo, ["rev-parse", "--short", "HEAD"]).trim();
      const task = createEndedTaskWithBody("sess-run-commit-recorded", `cwd: ${repo}\nhandoff-policy: commit`, {
        [HANDOFF_GIT_LAUNCH_META_KEY]: snapshot,
      });
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: `実装を commit ${runCommitShort} として反映した。取り込んだ上流 commit は ${upstreamShort}`,
        }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(harness.store.getTask(task.id)?.status).toBe("done");
      expect(harness.store.listEvents(task.id, "handoff_evidence_failed")).toHaveLength(0);
      const evidence = readHandoffEvidenceMeta(task.id, "sess-run-commit-recorded");
      expect(evidence?.commitClaims?.runCommits).toEqual([runCommitShort]);
      expect(evidence?.commitClaims?.upstream).toEqual([upstreamShort]);
    });
  });

  it("direct run で handoff ブロックが無い場合は run を failed で close し block_reason を needs-manual へ付け替えて in-progress 集計から外す", async () => {
    const { task, adapter } = createDirectEndedTask("direct-missing-cleanup");
    adapter.transcriptResponse = "特に何も出力していません";

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe(
      "needs-manual: handoff 欠落 (session=direct-missing-cleanup) [git=unavailable files=? commits=?]",
    );
    expect(updated?.assignee).toBe("human");

    const missingEvents = harness.store.listEvents(task.id, "handoff_missing");
    expect(missingEvents).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);

    const comments = listNonSteerTerminalSummaryComments(task.id);
    expect(comments).toHaveLength(1);

    // 欠落時も transcript は artifacts へ保存し、コメントに artifact パスを含める（docs/contract.md §12.7-2）
    const transcriptPath = join(
      harness.deps.env.artifactsDir,
      task.id,
      artifactFilename("transcript", "direct-missing-cleanup"),
    );
    expect(readFileSync(transcriptPath, "utf8")).toBe("特に何も出力していません");
    expect(comments[0]?.body).toContain(transcriptPath);

    // open run は failed で close される（resource guard の枠が解放される）
    expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

    // needs-manual へ付け替わった時点で listInProgress から外れる
    expect(harness.store.listInProgress().map((t) => t.id)).not.toContain(task.id);

    // 2回目の tick では listInProgress から外れているため対象にすらならず、再度コメント/イベントが増えない（冪等）
    const second = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(1);
    expect(listNonSteerTerminalSummaryComments(task.id)).toHaveLength(1);
  });

  it("bridge run の handoff 欠落初回は救済リプロンプトを注入し、open run と in-progress block を維持する（docs/contract.md §53）", async () => {
    const task = await createInjectableBridgeEndedTask();
    setStructuredBridgeResult(fakeCodex, "特に何も出力していません");
    const now = 1_000;

    const result = await finalizeStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeDefined();
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.listComments(task.id)).toHaveLength(0);

    const nudgeEvents = harness.store.listEvents(task.id, "handoff_nudge_sent");
    expect(nudgeEvents).toHaveLength(1);
    const openRun = harness.store.getLatestOpenRun(task.id);
    expect(openRun).not.toBeNull();
    expect(JSON.parse(nudgeEvents[0]!.payload)).toMatchObject({ sessionId: openRun?.sessionId, ts: now });

    const promptRequests = harness.codexBridge.requests.filter(
      (request) => request.path === "/api/prompt" && request.method === "POST",
    );
    expect(promptRequests).toHaveLength(2);
    const injectBody = promptRequests[1]?.body as { sessionId?: unknown; text?: unknown };
    expect(injectBody.sessionId).toBe(openRun?.sessionId);
    expect(injectBody.text).toContain("新たな作業はせず");
  });

  it("bridge run の handoff 欠落は同一 run で再 inject せず、grace 内は何も付け替えない", async () => {
    const task = await createInjectableBridgeEndedTask();
    setStructuredBridgeResult(fakeCodex, "handoff はまだありません");

    await finalizeStage.tick(harness.deps, true, 1_000);
    const second = await finalizeStage.tick(harness.deps, true, 1_100);

    expect(second.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeDefined();
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
    const promptRequests = harness.codexBridge.requests.filter(
      (request) => request.path === "/api/prompt" && request.method === "POST",
    );
    expect(promptRequests).toHaveLength(2);
  });

  it("bridge run の救済リプロンプト後も grace 超過まで handoff が無い場合は needs-manual へ付け替える", async () => {
    const task = await createInjectableBridgeEndedTask();
    setStructuredBridgeResult(fakeCodex, "handoff はありません");

    await finalizeStage.tick(harness.deps, true, 1_000);
    const second = await finalizeStage.tick(harness.deps, true, 1_601);

    expect(second.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("needs-manual: handoff 欠落");
    expect(updated?.assignee).toBe("human");
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(1);
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
    expect(harness.store.listComments(task.id)[0]?.body).toContain("救済リプロンプト後も");
  });

  it("bridge run の救済リプロンプト後に handoff が出た場合は通常の done 遷移で処理する", async () => {
    const task = await createInjectableBridgeEndedTask();
    setStructuredBridgeResult(fakeCodex, "handoff はありません");

    await finalizeStage.tick(harness.deps, true, 1_000);
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "救済後に完了報告を回収しました" }),
      "```",
    ].join("\n"));

    const second = await finalizeStage.tick(harness.deps, true, 1_100);

    expect(second.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
  });

  it("bridge run の救済リプロンプト注入が失敗した場合は fail-open で従来どおり needs-manual へ付け替える", async () => {
    const task = createEndedTask("sess-nudge-fail");
    setStructuredBridgeResult(fakeCodex, "handoff はありません");

    const result = await finalizeStage.tick(harness.deps, true, 1_000);

    expect(result.actions).toBe(1);
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe(
      "needs-manual: handoff 欠落 (session=sess-nudge-fail) [git=unavailable files=? commits=?]",
    );
    expect(updated?.assignee).toBe("human");
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(1);
    const gitEvents = harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE);
    expect(gitEvents).toHaveLength(1);
    expect(JSON.parse(gitEvents[0]!.payload)).toMatchObject({
      trigger: "handoff_missing",
      state: "unavailable",
    });
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();
  });

  it("transcript 取得自体が失敗した場合は artifact パス無しでコメントのみ残す（docs/contract.md §12.7-2）", async () => {
    const task = createEndedTask("sess-fetch-error");
    fakeCodex.transcriptError = new Error("bridge 接続エラー Bearer secret-token-xyz");

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    // transcript_fetch_failed イベント/コメントの書き込みも actions に計上する（docs/contract.md §12.18-2）
    expect(result.actions).toBe(1);

    const comments = harness.store.listComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("transcript の取得に失敗");
    // エラーメッセージ中の機密情報らしき文字列は redactText でマスクされる（docs/contract.md §12.7-3）
    expect(comments[0]?.body).not.toContain("secret-token-xyz");
    expect(comments[0]?.body).toContain("[REDACTED]");

    // 対象タスクは blocked のまま（in-progress）で、次 tick で再試行される
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
  });

  it("transcript 取得が失敗した場合、dry-run では actions は計上するが notes に記録するのみで DB には書き込まない（docs/contract.md §12.18-2）", async () => {
    const task = createEndedTask("sess-fetch-error-dry");
    fakeCodex.transcriptError = new Error("bridge 接続エラー");

    const result = await finalizeStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes?.some((note) => note.includes("dry-run") && note.includes("transcript_fetch_failed"))).toBe(
      true,
    );

    // dry-run のため DB には何も書き込まれない
    expect(harness.store.listComments(task.id)).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
  });

  it("transcript 取得が2回連続で失敗してもコメントは1件のみ増える一方、イベントは毎 tick 記録されリトライ回数を数える（docs/contract.md §12.16-1）", async () => {
    const task = createEndedTask("sess-fetch-error-repeat");
    fakeCodex.transcriptError = new Error("bridge 接続エラー");

    const first = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(first.actions).toBe(1);
    expect(harness.store.listComments(task.id)).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(1);

    // 2回目の失敗 tick では、コメントは既に記録済みのため増えず warn ログのみに留まるが、
    // リトライ回数を数えるため transcript_fetch_failed イベントは毎 tick 記録され増える。
    // 閾値（3回）未満のためタスクは変化しない。イベント書き込み自体は毎 tick 発生するため actions は計上される。
    const second = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(1);
    expect(harness.store.listComments(task.id)).toHaveLength(1);
    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(2);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("transcript 取得が3回連続で失敗すると needs-manual へ強制退避し run が close される（恒久リーク防止, docs/contract.md §12.16-1）", async () => {
    const task = createEndedTask("sess-fetch-error-exhausted");
    fakeCodex.transcriptError = new Error("bridge 接続エラー");

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(2);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);

    const third = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(third.actions).toBe(1);

    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(3);

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe("needs-manual: transcript 取得不能 (session=sess-fetch-error-exhausted)");
    expect(updated?.assignee).toBe("human");

    // open run は failed で close される（resource guard の枠が解放される）
    expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
    // needs-manual へ付け替わった時点で in-progress 集計から外れる
    expect(harness.store.listInProgress().map((t) => t.id)).not.toContain(task.id);

    // コメントは初回失敗分の1件のみ（§12.10-3 の「1回だけコメント」は維持）
    expect(listNonSteerTerminalSummaryComments(task.id)).toHaveLength(1);

    // 閾値到達後の tick では対象タスクが listInProgress から外れているため、これ以上イベントは増えない
    const fourth = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(fourth.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "transcript_fetch_failed")).toHaveLength(3);
  });

  it("handoff summary 内の機密情報らしき文字列はコメントで redact される（docs/contract.md §12.7-3）", async () => {
    const task = createEndedTask("sess-secret");
    setStructuredBridgeResult(fakeCodex, [
      "作業ログ",
      "```hachi-handoff-v1",
      JSON.stringify({
        taskId: task.id,
        outcome: "done",
        summary: "設定完了。認証は Authorization: Bearer abc123defghi を使用",
      }),
      "```",
    ].join("\n"));

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const comments = harness.store.listComments(task.id);
    expect(comments.some((c) => c.body.includes("ワーカー完了報告"))).toBe(true);
    const reportComment = comments.find((c) => c.body.includes("ワーカー完了報告"));
    expect(reportComment?.body).not.toContain("abc123defghi");
    expect(reportComment?.body).toContain("[REDACTED]");
  });

  it("taskId 不一致の handoff は不正扱いになり needs-manual へ付け替わる", async () => {
    const task = createEndedTask("sess-mismatch");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: "t_deadbeef", outcome: "done", summary: "別タスク" }),
      "```",
    ].join("\n"));

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toBe(
      "needs-manual: handoff 欠落 (session=sess-mismatch) [git=unavailable files=? commits=?]",
    );
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(1);
  });

  it("session_ended が未記録のタスクは対象外", async () => {
    const task = harness.store.createTask(taskInput({ status: "ready", title: "未終了" }), "tester");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-x server=http://x started=2026-07-02T10:00:00+09:00",
      "tester",
    );
    // open run はあるが session_ended イベントが無い状態を再現する
    harness.store.startRun(task.id, "codex", "sess-x", {});

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(0);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
  });

  it("open runとは別sessionのlate session_ended eventではmutation 0", async () => {
    const currentSessionId = "sess-current";
    const task = harness.store.createTask(taskInput({ status: "ready", title: "別session late event" }), "tester");
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${currentSessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", currentSessionId, { serverUrl: "http://x", transport: "bridge" });
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload("sess-late"));
    const taskBefore = harness.store.getTask(task.id);
    const runBefore = harness.store.getLatestOpenRun(task.id);

    const result = await finalizeStage.tick(harness.deps, true, 2_000);

    expect(result.actions).toBe(0);
    expect(harness.store.getTask(task.id)).toEqual(taskBefore);
    expect(harness.store.getLatestOpenRun(task.id)).toEqual(runBefore);
    expect(fakeCodex.statusCalls).toHaveLength(0);
    expect(fakeCodex.transcriptCalls).toHaveLength(0);
    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
  });

  it.each([
    {
      name: "busy",
      configure: (adapter: FakeAdapter): void => {
        adapter.statusResponse = { state: "active", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 2 };
      },
    },
    {
      name: "snapshot変化",
      configure: (adapter: FakeAdapter): void => {
        adapter.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 1, lastResultId: 1, lastEntryId: 2 };
      },
    },
    {
      name: "status取得失敗",
      configure: (adapter: FakeAdapter): void => {
        adapter.statusError = new Error("status unavailable");
      },
    },
  ])("finalize直前のbridge statusが$nameなら副作用なしでopen runを維持する", async ({ name, configure }) => {
    const task = createEndedTask(`sess-recheck-${name}`);
    fakeCodex.transcriptResponse = "(出力なし)";
    configure(fakeCodex);

    const result = await finalizeStage.tick(harness.deps, true, 2_000);

    expect(result.actions).toBe(0);
    expect(fakeCodex.transcriptCalls).toHaveLength(0);
    expect(fakeCodex.injectCalls).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_nudge_sent")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("途中result候補後にbusyへ戻ったセッションは worker_output_missing / needs-manual / run close を起こさない", async () => {
    const sessionId = "sess-editing-after-result";
    const task = harness.store.createTask(taskInput({ status: "ready", title: "編集中" }), "tester");
    harness.store.block(
      task.id,
      `codex-in-progress: 実装中 tmux=none even-session=${sessionId} server=http://x started=2026-07-02T10:00:00+09:00`,
      "tester",
    );
    harness.store.startRun(task.id, "codex", sessionId, { serverUrl: "http://x" });
    harness.store.addEvent(task.id, "session_end_candidate", "supervisor", bridgeEndedPayload(sessionId, 10, 10));
    fakeCodex.statusResponse = { state: "active", lastActivityAt: null, resultCount: 1, lastResultId: 10, lastEntryId: 11 };

    const result = await finalizeStage.tick(harness.deps, true, 2_000);

    expect(result.actions).toBe(0);
    expect(harness.store.listEvents(task.id, "worker_output_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.getLatestOpenRun(task.id)).not.toBeNull();
    expect(harness.store.getTask(task.id)?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("同一 sessionId の session_ended が複数ある場合も最新 watermark を対象に従来どおり finalize する", async () => {
    const task = createEndedTask("sess-ended-watermark");
    harness.store.addEvent(task.id, "session_ended", "supervisor", {
      ...bridgeEndedPayload("sess-ended-watermark", 2),
      resultCount: 2,
    });
    fakeCodex.statusResponse = { state: "idle", lastActivityAt: null, resultCount: 2, lastResultId: 2, lastEntryId: 2 };
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "複数ターン後に完了しました。確認済みです" }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");
    expect(harness.store.listEvents(task.id, "finalized")).toHaveLength(1);
  });

  it("dry-run は判定のみで DB に書き込まない", async () => {
    const task = createEndedTask("sess-dry");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
      "```",
    ].join("\n"));

    const result = await finalizeStage.tick(harness.deps, false, Math.floor(Date.now() / 1000));
    expect(result.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("blocked");
  });

  it("再起動シナリオ: 旧セッションの needs-manual 化は新セッション（新 run）の finalize を妨げない（docs/contract.md §12.5-3 / §12.6-1）", async () => {
    const now = (): number => Math.floor(Date.now() / 1000);

    // --- 1回目のセッション: handoff 無しで終了し needs-manual へ付け替わる（永久リーク防止） ---
    const task = createEndedTask("sess-old");
    setStructuredBridgeResult(fakeCodex, "handoff ブロックの無い出力");

    const first = await finalizeStage.tick(harness.deps, true, now());
    expect(first.actions).toBe(1);
    const afterFirst = harness.store.getTask(task.id);
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.blockReason).toBe(
      "needs-manual: handoff 欠落 (session=sess-old) [git=unavailable files=? commits=?]",
    );

    // handoff_missing は旧セッション（sess-old）の payload.sessionId で記録される
    const missingEvents = harness.store.listEvents(task.id, "handoff_missing");
    expect(missingEvents).toHaveLength(1);
    expect(JSON.parse(missingEvents[0]!.payload)).toMatchObject({ sessionId: "sess-old" });

    // 旧 run は finalize 自身が failed で close 済み（open run は残らない = resource guard の枠が解放されている）
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();

    // --- 人間が再起動を判断: needs-manual(blocked) を ready へ戻し、dispatch による再起動を再現する ---
    harness.store.unblock(task.id, "ready", "human");
    harness.store.block(
      task.id,
      "codex-in-progress: 実装中 tmux=none even-session=sess-new server=http://x started=2026-07-02T10:00:00+09:00",
      "supervisor",
    );
    harness.store.startRun(task.id, "codex", "sess-new", { serverUrl: "http://x" });

    // --- 新セッションが終了し、今度は正しい handoff を出力する ---
    harness.store.addEvent(task.id, "session_ended", "supervisor", bridgeEndedPayload("sess-new"));
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "再実行で完了しました。確認済みです" }),
      "```",
    ].join("\n"));

    const second = await finalizeStage.tick(harness.deps, true, now());

    // 旧セッションの handoff_missing に妨げられず、新セッション分として正常に finalize される
    expect(second.actions).toBe(1);
    expect(harness.store.getTask(task.id)?.status).toBe("done");

    // finalized イベントは新セッションの sessionId で記録される
    const finalizedEvents = harness.store.listEvents(task.id, "finalized");
    expect(finalizedEvents).toHaveLength(1);
    expect(JSON.parse(finalizedEvents[0]!.payload)).toMatchObject({ sessionId: "sess-new", outcome: "done" });

    // 新 run は endRun され open run は残らない
    expect(harness.store.listOpenRuns().find((run) => run.taskId === task.id)).toBeUndefined();

    // 旧セッションの handoff_missing は増えていない（新セッションで重複記録されない）
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(1);
  });

  it("handoff 欠落による needs-manual 化で dispatch の resource guard 枠が回復する（永久リーク防止, docs/contract.md §12.6-1）", async () => {
    await harness.cleanup();
    harness = await setupHarness({ resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 5 } });
    fakeCodex = new FakeAdapter("codex");
    fakeCodex.launchResponse = {
      provider: "codex",
      sessionId: "sess-pending",
      serverUrl: "http://x",
      model: "gpt-5.4",
      modelDelivery: "native",
      startedAt: Math.floor(Date.now() / 1000),
    };
    harness.deps.adapters = { ...harness.deps.adapters, codex: fakeCodex };

    const leaking = createEndedTask("sess-leak");
    setStructuredBridgeResult(fakeCodex, "handoff ブロックの無い出力");

    // cwd 実在チェック導入後は実在するディレクトリを使用する必要がある
    const dispatchCwdDir = join(harness.home.home, "work");
    mkdirSync(dispatchCwdDir, { recursive: true });
    const pending = harness.store.createTask(
      taskInput({ status: "ready", title: "後続タスク", body: `cwd: ${dispatchCwdDir}` }),
      "tester",
    );

    // maxInFlight=1 のため、進行中タスクがある間は後続タスクを起動できない
    const beforeDispatch = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(beforeDispatch.actions).toBe(0);
    expect(harness.store.getTask(pending.id)?.status).toBe("ready");

    // finalize が handoff 欠落を検知し needs-manual へ付け替える（resource guard の枠を解放）
    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(harness.store.listInProgress()).toHaveLength(0);
    expect(harness.store.getTask(leaking.id)?.blockReason.startsWith("needs-manual:")).toBe(true);

    // 枠が回復したため後続タスクが起動できる
    const afterDispatch = await dispatchStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(afterDispatch.actions).toBe(1);
    const updatedPending = harness.store.getTask(pending.id);
    expect(updatedPending?.status).toBe("blocked");
    expect(updatedPending?.blockReason.startsWith("codex-in-progress:")).toBe(true);
  });

  it("fetchTranscript 待機中にタスクが再起動された場合、旧セッションの handoff は適用されず stale_finalize_skipped が記録される（docs/contract.md §12.12-1）", async () => {
    const task = createEndedTask("sess-race-old");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "旧セッションの完了報告です" }),
      "```",
    ].join("\n"));

    // fetchTranscript の待機中（Tx 開始前）に別 writer がタスクを再起動したことを模擬する:
    // 旧 run を failed で close し、新セッションとして再度 in-progress へ block し直す。
    fakeCodex.transcriptHook = (): void => {
      const openRun = harness.store.listOpenRuns().find((r) => r.taskId === task.id);
      if (openRun !== undefined) {
        harness.store.endRun(openRun.id, "failed");
      }
      harness.store.unblock(task.id, "ready", "other-writer");
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 tmux=none even-session=sess-race-new server=http://x started=2026-07-02T10:00:00+09:00",
        "other-writer",
      );
      harness.store.startRun(task.id, "codex", "sess-race-new", {});
    };

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    // 旧セッション（sess-race-old）由来の完了報告・transition は適用されない
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("sess-race-new");

    const comments = harness.store.listComments(task.id);
    expect(comments.some((c) => c.body.includes("旧セッション完了"))).toBe(false);

    // stale_finalize_skipped イベントが旧セッションの sessionId で記録される
    const staleEvents = harness.store.listEvents(task.id, "stale_finalize_skipped");
    expect(staleEvents).toHaveLength(1);
    expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({ sessionId: "sess-race-old" });

    // 新セッションの open run は誤って閉じられずに残っている
    const latestRun = harness.store.getLatestOpenRun(task.id);
    expect(latestRun?.sessionId).toBe("sess-race-new");

    // finalized イベントは記録されない（旧セッションの handoff が誤適用されていない証跡）
    expect(harness.store.listEvents(task.id, "finalized")).toHaveLength(0);
  });

  it("fetchTranscript中にcancelが作られた場合は最終Txでlate resultを拒否しtask/runを変更しない", async () => {
    const task = createEndedTask("sess-cancel-race");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "cancel後は採用しない" }),
      "```",
    ].join("\n"));
    fakeCodex.transcriptHook = (): void => {
      const run = harness.store.getOpenRunByTaskSession(task.id, "sess-cancel-race");
      if (run !== null && harness.store.listRunCancelRequests(task.id).length === 0) {
        harness.store.createOrGetRunCancelRequest({
          taskId: task.id,
          runId: run.id,
          sessionId: run.sessionId,
          provider: run.provider,
          requestNonce: "finalize-cancel-race",
          actor: "supervisor",
          reason: "finalize race",
          deadlineAt: Math.floor(Date.now() / 1000) + 60,
        });
      }
    };

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(harness.store.getTask(task.id)).toMatchObject({ status: "blocked" });
    expect(harness.store.getOpenRunByTaskSession(task.id, "sess-cancel-race")).not.toBeNull();
    expect(harness.store.listEvents(task.id, "finalized")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, "late_result_rejected")).toHaveLength(1);
  });

  it("fetchTranscript 待機中にタスクが再起動された場合（handoff 欠落パス）も stale_finalize_skipped が記録され新セッションを壊さない（docs/contract.md §12.12-1）", async () => {
    const task = createEndedTask("sess-race-missing-old");
    setStructuredBridgeResult(fakeCodex, "handoff ブロックの無い出力");
    let probeCalls = 0;
    (harness.deps as StageDepsWithHandoffGitEvidenceProbe).handoffGitEvidenceProbe = {
      captureLaunchSnapshot: async () => ({
        schemaVersion: "handoff-git-launch.v1",
        state: "unavailable",
        reason: "snapshot-unavailable",
      }),
      captureEndEvidence: async () => {
        probeCalls += 1;
        throw new Error("stale session は Git probe を開始してはいけません");
      },
    };

    fakeCodex.transcriptHook = (): void => {
      const openRun = harness.store.listOpenRuns().find((r) => r.taskId === task.id);
      if (openRun !== undefined) {
        harness.store.endRun(openRun.id, "failed");
      }
      harness.store.unblock(task.id, "ready", "other-writer");
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 tmux=none even-session=sess-race-missing-new server=http://x started=2026-07-02T10:00:00+09:00",
        "other-writer",
      );
      harness.store.startRun(task.id, "codex", "sess-race-missing-new", {});
    };

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    // 旧セッション分の needs-manual 付替は適用されず、新セッションの in-progress のまま残る
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("sess-race-missing-new");
    expect(updated?.blockReason.startsWith("needs-manual:")).toBe(false);

    // handoff_missing は記録されず、stale_finalize_skipped のみ記録される
    expect(harness.store.listEvents(task.id, "handoff_missing")).toHaveLength(0);
    expect(harness.store.listEvents(task.id, HANDOFF_GIT_EVIDENCE_EVENT_TYPE)).toHaveLength(0);
    expect(probeCalls).toBe(0);
    const staleEvents = harness.store.listEvents(task.id, "stale_finalize_skipped");
    expect(staleEvents).toHaveLength(1);
    expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({ sessionId: "sess-race-missing-old" });

    // 新セッションの open run は誤って failed close されずに残っている
    const latestRun = harness.store.getLatestOpenRun(task.id);
    expect(latestRun?.sessionId).toBe("sess-race-missing-new");
  });

  it("transcript 取得失敗の記録（閾値未満の retry 分岐）でも fetchTranscript 待機中の再起動を検知し、旧セッション向けのイベントを記録しない（docs/contract.md §12.17-3）", async () => {
    const task = createEndedTask("sess-retry-race-old");
    fakeCodex.transcriptError = new Error("bridge 接続エラー");

    // fetchTranscript の待機中（Tx 開始前）に別 writer がタスクを再起動したことを模擬する:
    // 旧 run を failed で close し、新セッションとして再度 in-progress へ block し直す。
    fakeCodex.transcriptHook = (): void => {
      const openRun = harness.store.listOpenRuns().find((r) => r.taskId === task.id);
      if (openRun !== undefined) {
        harness.store.endRun(openRun.id, "failed");
      }
      harness.store.unblock(task.id, "ready", "other-writer");
      harness.store.block(
        task.id,
        "codex-in-progress: 実装中 tmux=none even-session=sess-retry-race-new server=http://x started=2026-07-02T10:00:00+09:00",
        "other-writer",
      );
      harness.store.startRun(task.id, "codex", "sess-retry-race-new", {});
    };

    await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    // 旧セッション（sess-retry-race-old）向けの transcript_fetch_failed イベント・コメントは記録されない
    const oldSessionEvents = harness.store
      .listEvents(task.id, "transcript_fetch_failed")
      .filter((event) => (JSON.parse(event.payload) as { sessionId?: string }).sessionId === "sess-retry-race-old");
    expect(oldSessionEvents).toHaveLength(0);
    expect(harness.store.listComments(task.id)).toHaveLength(0);

    // stale_finalize_skipped イベントが旧セッションの sessionId で記録される
    const staleEvents = harness.store.listEvents(task.id, "stale_finalize_skipped");
    expect(staleEvents).toHaveLength(1);
    expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({ sessionId: "sess-retry-race-old" });

    // 新セッションの状態は壊されず、open run も残っている
    const updated = harness.store.getTask(task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockReason).toContain("sess-retry-race-new");
    const latestRun = harness.store.getLatestOpenRun(task.id);
    expect(latestRun?.sessionId).toBe("sess-retry-race-new");
  });

  it("transcript の artifact 保存に失敗しても handoff 欠落のクリーンアップ（run close + needs-manual 付替）は必ず実行される（docs/contract.md §12.12-2）", async () => {
    const task = createEndedTask("sess-artifact-fail");
    setStructuredBridgeResult(fakeCodex, "handoff ブロックの無い出力");

    // artifacts ディレクトリを書込不能にして saveTranscriptArtifact を失敗させる
    chmodSync(harness.deps.env.artifactsDir, 0o444);
    try {
      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(result.actions).toBe(1);

      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe(
        "needs-manual: handoff 欠落 (session=sess-artifact-fail) [git=unavailable files=? commits=?]",
      );
      expect(updated?.assignee).toBe("human");

      // open run は failed で close される（resource guard の枠が解放される。リーク防止）
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();
      // needs-manual へ付け替わった時点で in-progress 集計から外れる（リーク防止）
      expect(harness.store.listInProgress().map((t) => t.id)).not.toContain(task.id);

      const missingEvents = harness.store.listEvents(task.id, "handoff_missing");
      expect(missingEvents).toHaveLength(1);

      // artifact 保存失敗の旨がコメントに明記される（redact 済み）
      const comments = listNonSteerTerminalSummaryComments(task.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("transcript の保存に失敗しました");
    } finally {
      // harness.cleanup() の再帰削除が書込権限を必要とするため復元する
      chmodSync(harness.deps.env.artifactsDir, 0o755);
    }
  });

  it("transcript の artifact 保存に失敗しても有効な handoff（outcome=done）の遷移と open run の close は必ず実行される（docs/contract.md §12.13-1）", async () => {
    const task = createEndedTask("sess-success-artifact-fail");
    setStructuredBridgeResult(fakeCodex, [
      "```hachi-handoff-v1",
      JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
      "```",
    ].join("\n"));

    // artifacts ディレクトリを書込不能にして saveTranscriptArtifact を失敗させる
    chmodSync(harness.deps.env.artifactsDir, 0o444);
    try {
      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(result.actions).toBe(1);

      // artifact 保存が失敗しても done への遷移は必ず実行される
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");
      expect(updated?.blockReason).toBe("");

      // open run も必ず close される（resource guard の枠が解放される。リーク防止）
      expect(harness.store.listOpenRuns().find((r) => r.taskId === task.id)).toBeUndefined();

      const finalizedEvents = harness.store.listEvents(task.id, "finalized");
      expect(finalizedEvents).toHaveLength(1);

      // 完了報告と artifact 保存失敗の旨が同じコメントに明記される（redact 済み）
      const comments = listNonSteerTerminalSummaryComments(task.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("実装完了");
      expect(comments[0]?.body).toContain("transcript の保存に失敗しました");
    } finally {
      // harness.cleanup() の再帰削除が書込権限を必要とするため復元する
      chmodSync(harness.deps.env.artifactsDir, 0o755);
    }
  });

  describe("handoff summary プレースホルダ拒否", () => {
    it("summary が空文字のとき handoff_rejected で needs-manual 化する", async () => {
      const task = createEndedTask("sess-ph-empty");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("needs-manual");
      expect(updated?.blockReason).toContain("プレースホルダ");

      const events = harness.store.listEvents(task.id, "handoff_rejected");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload.reason).toBe("placeholder_summary");

      const runs = harness.store.listOpenRuns().filter((r) => r.taskId === task.id);
      expect(runs).toHaveLength(0);
    });

    it("summary が <作業内容の要約> のようなプレースホルダのとき拒否する", async () => {
      const task = createEndedTask("sess-ph-template");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "review", summary: "<作業内容の要約>" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("needs-manual");

      const events = harness.store.listEvents(task.id, "handoff_rejected");
      expect(events).toHaveLength(1);
    });

    it("summary が短すぎる（10文字未満）のとき拒否する", async () => {
      const task = createEndedTask("sess-ph-short");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "abc" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("needs-manual");

      const events = harness.store.listEvents(task.id, "handoff_rejected");
      expect(events).toHaveLength(1);
    });

    it("有効な summary は正常に遷移する（false positive がないことの確認）", async () => {
      const task = createEndedTask("sess-ph-valid");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "認証ロジックを修正しました" }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");

      const events = harness.store.listEvents(task.id, "handoff_rejected");
      expect(events).toHaveLength(0);
    });

    it("既知テンプレ字句ではない山括弧トークンを含む実体 summary は正常に遷移する", async () => {
      const task = createEndedTask("sess-ph-angle-valid");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({
          taskId: task.id,
          outcome: "done",
          summary: "direct adapter は state/direct-sessions/<sessionId>.out を監視対象にしました",
        }),
        "```",
      ].join("\n"));

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");

      const events = harness.store.listEvents(task.id, "handoff_rejected");
      expect(events).toHaveLength(0);
    });
  });

  describe("outcome=done 直行 verify ゲート（§39）", () => {
    // verify テスト用ヘルパー
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

    interface ConfigWithVerify extends HachiConfig {
      verify?: { tenants: Record<string, string> };
    }

    interface StageDepsWithVerifyExecutor extends StageDeps {
      verifyExecutor?: VerifyExecutor;
      runtimePathBuilder?: RuntimePathBuilder;
    }

    function setVerifyTenants(h: TestHarness, tenants: Record<string, string>): void {
      (h.deps.config as ConfigWithVerify).verify = { tenants };
    }

    function setVerifyExecutor(h: TestHarness, executor: VerifyExecutor): void {
      (h.deps as StageDepsWithVerifyExecutor).verifyExecutor = executor;
    }

    function setRuntimePath(h: TestHarness, path: string, sensitiveValues: readonly string[] = [path]): void {
      (h.deps as StageDepsWithVerifyExecutor).runtimePathBuilder = {
        build: () => ({ path, source: "runtime-path-v1", sensitiveValues }),
      };
    }

    it("verify 成功時は outcome=done が正常に遷移する", async () => {
      const task = createEndedTaskWithBody("sess-vfy-pass", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "全テスト通過しました" }),
        "```",
      ].join("\n"));

      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 0, signal: null, stdout: "all passed", stderr: "", timedOut: false };
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");

      expect(fakeVerify.calls).toHaveLength(1);
      const events = harness.store.listEvents(task.id, "handoff_verify_failed");
      expect(events).toHaveLength(0);
    });

    it("verify 失敗時は needs-manual に付替し、task_runs.meta.verify に証跡を保存する（fail-closed, §39 整合）", async () => {
      const task = createEndedTaskWithBody("sess-vfy-fail", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      const secretHome = "/Users/private-person";
      const secretPath = `${secretHome}/.vite-plus/bin:/usr/bin:/bin`;
      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = {
        exitCode: 1,
        signal: null,
        stdout: [
          "FAIL src/foo.test.ts",
          `PATH=${secretPath}`,
          `artifact=${secretHome}/.ssh/private-token`,
        ].join("\n"),
        stderr: "",
        timedOut: false,
      };
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);
      setRuntimePath(harness, secretPath, [secretPath, secretHome]);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("needs-manual");
      expect(updated?.blockReason).toContain("done 直行 verify 失敗");

      const events = harness.store.listEvents(task.id, "handoff_verify_failed");
      expect(events).toHaveLength(1);

      expect(fakeVerify.calls).toHaveLength(1);

      // verify 証跡が task_runs.meta.verify に保存される（review 経路との整合。§39 の監査記録）
      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-vfy-fail");
        expect(run).toBeDefined();
        expect(run?.status).toBe("failed");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.verify).toBeDefined();
        const verify = meta.verify as Record<string, unknown>;
        expect(verify.status).toBe("failed");
        expect(verify.exitCode).toBe(1);
        expect(verify.outputTail).toContain("[REDACTED]");
        expect(JSON.stringify(meta)).not.toContain(secretHome);
        expect(JSON.stringify(meta)).not.toContain(secretPath);
      } finally {
        view.close();
      }

      const persistedText = [
        ...harness.store.listComments(task.id).map((comment) => comment.body),
        ...harness.store.listEvents(task.id).map((event) => event.payload),
      ].join("\n");
      expect(persistedText).not.toContain(secretHome);
      expect(persistedText).not.toContain(secretPath);
    });

    it("outcome=done 直行 verify が失敗しても、失敗テストだけの再実行が通れば flake として review-required へ倒す（worker帰責にしない）", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const task = createEndedTaskWithBody("sess-vfy-flake", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

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
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: verify_flake_detected (session=sess-vfy-flake)");

      const events = harness.store.listEvents(task.id, "handoff_verify_failed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        failureCause: "environment_evidence",
        modelFailureCounted: false,
        verifyRetry: {
          attempted: true,
          outcome: "passed",
          failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
          failingTestFiles: ["src/foo.test.ts"],
        },
      });

      const comments = harness.store.listComments(task.id);
      expect(comments.some((c) => c.body.includes("再実行で flake と判定"))).toBe(true);

      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
      expect(fakeVerify.calls[1]?.options.cwd).toBe(tmpCwd);
    });

    it("outcome=done 直行 verify が失敗し、失敗テストの再実行も再現した場合は needs-manual へ付替する（§39 整合）", async () => {
      mkdirSync(join(tmpCwd, "src"), { recursive: true });
      writeFileSync(join(tmpCwd, "src", "foo.test.ts"), "");
      const task = createEndedTaskWithBody("sess-vfy-fail-confirmed", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

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
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("needs-manual: done 直行 verify 失敗");

      const events = harness.store.listEvents(task.id, "handoff_verify_failed");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        failureCause: "worker_local",
        modelFailureCounted: true,
        verifyRetry: {
          attempted: true,
          outcome: "failed",
          failingTests: [{ file: "src/foo.test.ts", test: "suite > test" }],
          failingTestFiles: ["src/foo.test.ts"],
        },
      });

      expect(fakeVerify.calls).toHaveLength(2);
      expect(fakeVerify.calls[1]?.command).toBe("pnpm exec vitest run 'src/foo.test.ts'");
    });

    it("verify exit 127 は実行環境失敗としてreview-requiredへ分離し、PATH値を永続化しない", async () => {
      const task = createEndedTaskWithBody("sess-vfy-environment-fail", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装とローカル検証を完了しました" }),
        "```",
      ].join("\n"));

      const secretHome = "/Users/private-person";
      const secretPath = `${secretHome}/.vite-plus/bin:/usr/bin:/bin`;
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
      setVerifyTenants(harness, { "test-tenant": "pnpm run test" });
      setVerifyExecutor(harness, fakeVerify);
      setRuntimePath(harness, secretPath, [secretPath, secretHome]);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toBe("review-required: verify_environment_failed (exit 127)");
      expect(harness.store.listEvents(task.id, "verify_environment_failed")).toHaveLength(1);
      expect(harness.store.listEvents(task.id, "handoff_verify_failed")).toHaveLength(0);

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((candidate) => candidate.sessionId === "sess-vfy-environment-fail");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.verify).toMatchObject({
          status: "verify_environment_failed",
          exitCode: 127,
          runtimePathSource: "runtime-path-v1",
        });
        expect(JSON.stringify(meta)).not.toContain(secretHome);
        expect(JSON.stringify(meta)).not.toContain(secretPath);
      } finally {
        view.close();
      }

      const persistedText = [
        updated?.blockReason ?? "",
        ...harness.store.listComments(task.id).map((comment) => comment.body),
        ...harness.store.listEvents(task.id).map((event) => event.payload),
      ].join("\n");
      expect(persistedText).not.toContain(secretHome);
      expect(persistedText).not.toContain(secretPath);
    });

    it("direct run の verify failed close 後に process group cleanup として stop を呼ぶ（docs/contract.md §51.1）", async () => {
      const { task, adapter } = createDirectEndedTask("direct-vfy-fail", `cwd: ${tmpCwd}`);
      adapter.transcriptResponse = [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。verify 失敗を模擬します" }),
        "```",
      ].join("\n");

      const fakeVerify = new FakeVerifyExecutor();
      fakeVerify.response = { exitCode: 1, signal: null, stdout: "FAIL src/foo.test.ts", stderr: "", timedOut: false };
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      expect(harness.store.listEvents(task.id, "handoff_verify_failed")).toHaveLength(1);
      expect(adapter.stopCalls.map((ref) => ref.sessionId)).toEqual(["direct-vfy-fail"]);
    });

    it("verify 未定義の tenant では verify をスキップし outcome=done が通る（skip 監査記録を meta に残す）", async () => {
      const task = createEndedTask("sess-vfy-skip");
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "テスト用の完了報告を記録しました" }),
        "```",
      ].join("\n"));
      // setVerifyTenants を呼ばない（verify 未定義）

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("done");

      // skip 監査記録が task_runs.meta.verify に残ることを検証（review 経路との整合）
      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-vfy-skip");
        expect(run).toBeDefined();
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.verify).toEqual({ skipped: "no-command" });
      } finally {
        view.close();
      }
    });

    it("verify 実行前に stale セッション検証を行い、再起動済みなら verify を実行せず stale_finalize_skipped を記録する", async () => {
      const task = createEndedTaskWithBody("sess-vfy-stale", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。検証済みです" }),
        "```",
      ].join("\n"));

      const fakeVerify = new FakeVerifyExecutor();
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      // fetchTranscript 成功後（verify 実行前）にタスクが再起動されたことを模擬する
      fakeCodex.transcriptHook = (): void => {
        const openRun = harness.store.listOpenRuns().find((r) => r.taskId === task.id);
        if (openRun !== undefined) {
          harness.store.endRun(openRun.id, "failed");
        }
        harness.store.unblock(task.id, "ready", "other-writer");
        harness.store.block(
          task.id,
          "codex-in-progress: 実装中 tmux=none even-session=sess-vfy-stale-new server=http://x started=2026-07-02T10:00:00+09:00",
          "other-writer",
        );
        harness.store.startRun(task.id, "codex", "sess-vfy-stale-new", {});
      };

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      // verify コマンドは実行されない（stale セッションの verify を走らせない）
      expect(fakeVerify.calls).toHaveLength(0);

      // 旧セッションの done 遷移は適用されない
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toContain("sess-vfy-stale-new");

      // stale_finalize_skipped が記録される
      const staleEvents = harness.store.listEvents(task.id, "stale_finalize_skipped");
      expect(staleEvents).toHaveLength(1);
      expect(JSON.parse(staleEvents[0]!.payload)).toMatchObject({
        sessionId: "sess-vfy-stale",
        phase: "done_verify_preflight",
      });

      // 新セッションの open run は残っている
      const latestRun = harness.store.getLatestOpenRun(task.id);
      expect(latestRun?.sessionId).toBe("sess-vfy-stale-new");
    });

    it("outcome=review の場合は verify を実行しない", async () => {
      const task = createEndedTaskWithBody("sess-vfy-review", `cwd: ${tmpCwd}`);
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "review", summary: "レビューをお願いします" }),
        "```",
      ].join("\n"));

      const fakeVerify = new FakeVerifyExecutor();
      setVerifyTenants(harness, { "test-tenant": "pnpm -r test" });
      setVerifyExecutor(harness, fakeVerify);

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      expect(result.actions).toBe(1);
      const updated = harness.store.getTask(task.id);
      expect(updated?.status).toBe("review");

      // verify は呼ばれない
      expect(fakeVerify.calls).toHaveLength(0);
    });
  });

  describe("コスト/トークン統計の永続化（docs/contract.md §14.5）", () => {
    it("成功パス（handoff done）で adapter.status() の lastResult を task_runs.meta へマージ保存する", async () => {
      const task = createEndedTask("sess-stats-done");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        lastResult: { costUsd: 0.12, turns: 3, durationMs: 4500, inputTokens: 100, outputTokens: 200 },
      };
      setStructuredBridgeResult(fakeCodex, [
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
        "```",
      ].join("\n"));

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-stats-done");
        expect(run).toBeDefined();
        expect(run?.status).toBe("done");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.lastResult).toEqual({
          costUsd: 0.12,
          turns: 3,
          durationMs: 4500,
          inputTokens: 100,
          outputTokens: 200,
        });
      } finally {
        view.close();
      }
    });

    it("handoff 欠落パスでも adapter.status() の lastResult を task_runs.meta へマージ保存する", async () => {
      const task = createEndedTask("sess-stats-missing");
      fakeCodex.statusResponse = {
        state: "idle",
        lastActivityAt: null,
        lastResult: { costUsd: 0.05, turns: 1, durationMs: 800 },
      };
      setStructuredBridgeResult(fakeCodex, "handoff ブロックの無い出力");

      await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-stats-missing");
        expect(run).toBeDefined();
        expect(run?.status).toBe("failed");
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.lastResult).toEqual({ costUsd: 0.05, turns: 1, durationMs: 800 });
      } finally {
        view.close();
      }
    });

    it("adapter.status() が失敗した場合は lastResult 無しで endRun する（ベストエフォート・ブロックしない）", async () => {
      const { task, adapter } = createDirectEndedTask("sess-stats-error");
      adapter.transcriptResponse = [
        "[assistant] 作業ログ",
        "```hachi-handoff-v1",
        JSON.stringify({ taskId: task.id, outcome: "done", summary: "実装完了しました。動作確認済みです" }),
        "```",
      ].join("\n");
      adapter.statusError = new Error("status取得エラー");

      const result = await finalizeStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
      expect(result.actions).toBe(1);
      expect(harness.store.getTask(task.id)?.status).toBe("done");

      const view = createKanbanReadView(harness.home.env.dbPath);
      try {
        const run = view.runs(task.id).find((r) => r.sessionId === "sess-stats-error");
        expect(run).toBeDefined();
        const meta = JSON.parse(run?.meta ?? "{}") as Record<string, unknown>;
        expect(meta.lastResult).toBeUndefined();
      } finally {
        view.close();
      }
    });
  });
});
