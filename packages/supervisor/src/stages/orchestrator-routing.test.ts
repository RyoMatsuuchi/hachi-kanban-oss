import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OrchestratorLivenessIncidentRow,
  OrchestratorRow,
  OrchestratorSessionRow,
} from "@hachi/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskInput } from "@hachi/testing";
import { setupHarness, type TestHarness } from "../test-support.js";
import {
  createOrchestratorRoutingStage,
  orchestratorRoutingStage,
  type OrchestratorHeartbeatStaleAlert,
} from "./orchestrator-routing.js";

interface LivenessFixture {
  orchestrator: OrchestratorRow;
  session: OrchestratorSessionRow;
  incident: OrchestratorLivenessIncidentRow;
}

function createRecoveredIncident(harness: TestHarness, now: number, label: string): LivenessFixture {
  const orchestrator = harness.store.registerOrchestrator({ label, project: "project-a", repoCommonDir: "" });
  const session = harness.store.startOrchestratorSession({
    orchestratorId: orchestrator.id,
    provider: "codex",
    providerSessionId: "11111111-1111-4111-8111-111111111111",
  });
  harness.store.heartbeatOrchestratorSession(session.id, session.generation, now - 91);
  harness.store.heartbeatOrchestratorSession(session.id, session.generation, now);
  return {
    orchestrator,
    session: harness.store.getOrchestratorSession(session.id)!,
    incident: harness.store.getOrchestratorLivenessIncident(session.id, session.generation)!,
  };
}

describe("orchestratorRoutingStage", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("stale sessionを従来どおり回収してclaimをrequeueし、incident送信成功をdurableにsent化する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "stale claim", body: "cwd: /worktrees/stale\n本文", tenant: "project-a" }),
      "tester",
    );
    harness.store.block(task.id, "worker-question: stale claimです", "supervisor");
    const orchestrator = harness.store.registerOrchestrator({ label: "owner", project: "project-a", repoCommonDir: "" });
    harness.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/stale",
      role: "primary",
    });
    const providerSessionId = "11111111-1111-4111-8111-111111111111";
    const session = harness.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "codex",
      providerSessionId,
    });
    const request = harness.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_stale_claim",
      question: "stale claimです",
      worktree: "/worktrees/stale",
      project: "project-a",
    });
    harness.store.markOrchestratorDeliveriesDelivered(orchestrator.id);
    harness.store.claimOrchestratorRequest({
      requestId: request.id,
      sessionId: session.id,
      generation: session.generation,
      claimToken: "stale-claim-token",
      leaseUntil: now + 600,
    });
    harness.store.heartbeatOrchestratorSession(session.id, session.generation, now - 91);
    const alerts: OrchestratorHeartbeatStaleAlert[] = [];
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: (_deps, alert) => {
        alerts.push(alert);
        return Promise.resolve({ attempted: true, sent: true });
      },
    });

    const first = await stage.tick(harness.deps, true, now);

    expect(first.actions).toBe(2);
    expect(harness.store.getOrchestratorSession(session.id)?.status).toBe("stale");
    expect(harness.store.getOrchestratorRequest(request.id)).toMatchObject({
      status: "queued",
      claimantSessionId: "",
      claimantGeneration: null,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain("gapSeconds=91");
    expect(alerts[0]?.body).toContain(`session=${session.id} generation=${session.generation}`);
    expect(alerts[0]?.body).toContain(`orchestrator=${orchestrator.id} label=owner`);
    expect(alerts[0]?.body).toContain(`provider=codex providerNativeSessionId=${providerSessionId}`);
    expect(alerts[0]?.body).toContain("自動再登録を行いません");
    expect(alerts[0]?.body).toContain(
      `hachi orchestrator session takeover ${orchestrator.id} --stale-sec 90 ` +
      `--provider codex --provider-session-id ${providerSessionId} --json`,
    );
    expect(alerts[0]?.body).toContain("status=active へ復帰済みなら二重起動せず");
    expect(harness.store.getOrchestratorLivenessIncident(session.id, session.generation)).toMatchObject({
      status: "sent",
      attempts: 1,
      sentAt: now,
    });

    const second = await stage.tick(harness.deps, true, now + 1);
    expect(second.actions).toBe(0);
    expect(alerts).toHaveLength(1);
  });

  it("attempted=trueかつsent=falseは30秒後にretryし、成功後は再通知しない", async () => {
    const now = 2_000;
    const fixture = createRecoveredIncident(harness, now, "unsent-retry");
    let calls = 0;
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? { attempted: true, sent: false, failedTransports: ["macos"] }
          : { attempted: true, sent: true });
      },
    });

    await stage.tick(harness.deps, true, now);

    expect(calls).toBe(1);
    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: now + 30,
      lastError: expect.stringContaining("attempted=true sent=false"),
    });

    await stage.tick(harness.deps, true, now + 29);
    expect(calls).toBe(1);

    await stage.tick(harness.deps, true, now + 30);
    expect(calls).toBe(2);
    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toMatchObject({
      status: "sent",
      attempts: 2,
      sentAt: now + 30,
    });

    await stage.tick(harness.deps, true, now + 31);
    expect(calls).toBe(2);
  });

  it("通知throwも同じbounded retryへ入り、lastErrorはCoreへ渡す", async () => {
    const now = 3_000;
    const fixture = createRecoveredIncident(harness, now, "throw-retry");
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: () => Promise.reject(new Error("transport exploded")),
    });

    await stage.tick(harness.deps, true, now);

    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: now + 30,
      lastError: "transport exploded",
    });
  });

  it("5回目の通知失敗をexhausted化してnoteと構造化warningへ出し、6回目は通知しない", async () => {
    const now = 4_000;
    const fixture = createRecoveredIncident(harness, now, "retry-exhausted");
    let calls = 0;
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: () => {
        calls += 1;
        return Promise.resolve({ attempted: true, sent: false, failedTransports: ["telegram"] });
      },
    });

    const attemptsAt = [now, now + 30, now + 90, now + 210, now + 450];
    let result = await stage.tick(harness.deps, true, attemptsAt[0]!);
    for (const attemptAt of attemptsAt.slice(1)) {
      result = await stage.tick(harness.deps, true, attemptAt);
    }

    expect(calls).toBe(5);
    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toMatchObject({
      status: "exhausted",
      attempts: 5,
      sentAt: null,
    });
    expect(result.notes).toContain(
      `liveness incident exhausted: incident=${fixture.incident.id} session=${fixture.session.id} ` +
      `generation=${fixture.session.generation} attempts=5`,
    );
    const logs = readFileSync(join(harness.home.home, "test-supervisor.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "orchestrator-routing: liveness incident notification exhausted",
      incidentId: fixture.incident.id,
      sessionId: fixture.session.id,
      generation: fixture.session.generation,
      attempts: 5,
    }));

    await stage.tick(harness.deps, true, now + 10_000);
    expect(calls).toBe(5);
  });

  it("attempts CAS競合時は同一tickで再通知も再更新もしない", async () => {
    const now = 5_000;
    const fixture = createRecoveredIncident(harness, now, "attempts-cas");
    let calls = 0;
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: (_deps, alert) => {
        calls += 1;
        harness.store.markOrchestratorLivenessIncident(
          alert.incident.id,
          alert.incident.attempts,
          "pending",
          now + 600,
          "concurrent notifier",
          now,
        );
        return Promise.resolve({ attempted: true, sent: true });
      },
    });

    const result = await stage.tick(harness.deps, true, now);

    expect(calls).toBe(1);
    expect(result.notes).toContain(
      `liveness incident ${fixture.incident.id} (${fixture.session.id}:${fixture.session.generation}): ` +
      "attempts CAS競合のため sent 更新をskipしました",
    );
    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: now + 600,
      lastError: "concurrent notifier",
    });

    await stage.tick(harness.deps, true, now);
    expect(calls).toBe(1);
  });

  it("dry-runはstale sessionもdue incidentも更新・通知せず予定だけをnoteへ出す", async () => {
    const now = 6_000;
    const staleOwner = harness.store.registerOrchestrator({ label: "dry-stale", project: "project-a", repoCommonDir: "" });
    const staleSession = harness.store.startOrchestratorSession({ orchestratorId: staleOwner.id });
    harness.store.heartbeatOrchestratorSession(staleSession.id, staleSession.generation, now - 91);
    const fixture = createRecoveredIncident(harness, now, "dry-incident");
    const sessionsBefore = harness.store.listOrchestratorSessions();
    const incidentBefore = harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation);
    let calls = 0;
    const stage = createOrchestratorRoutingStage({
      notifyStaleSession: () => {
        calls += 1;
        return Promise.resolve({ attempted: true, sent: true });
      },
    });

    const result = await stage.tick(harness.deps, false, now);

    expect(result.actions).toBe(2);
    expect(result.notes).toContain("dry-run: stale orchestrator session 1件を回収予定");
    expect(result.notes).toContain(
      `dry-run: liveness incident ${fixture.incident.id} ` +
      `(${fixture.session.id}:${fixture.session.generation}, attempts=0) を通知予定`,
    );
    expect(calls).toBe(0);
    expect(harness.store.listOrchestratorSessions()).toEqual(sessionsBefore);
    expect(harness.store.getOrchestratorLivenessIncident(fixture.session.id, fixture.session.generation)).toEqual(incidentBefore);
  });

  it("既存worker-questionを冪等backfillする", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "backfill", body: "cwd: /worktrees/backfill\n本文", tenant: "project-a" }),
      "tester",
    );
    harness.store.block(task.id, "worker-question: 既存の質問です", "supervisor");
    harness.store.addEvent(task.id, "question_asked", "supervisor", {
      questionId: "q_existing",
      question: "既存の質問です",
      context: "移行対象",
    });
    const orchestrator = harness.store.registerOrchestrator({ label: "backfill", project: "project-a", repoCommonDir: "" });
    harness.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/backfill",
      role: "primary",
    });

    const first = await orchestratorRoutingStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(first.actions).toBe(1);
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toEqual([
      expect.objectContaining({ questionId: "q_existing", question: "既存の質問です", worktree: "/worktrees/backfill" }),
    ]);

    const second = await orchestratorRoutingStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));
    expect(second.actions).toBe(0);
    expect(harness.store.listOrchestratorRequests(orchestrator.id)).toHaveLength(1);
  });

  it("期限内のplanned handoff sessionはstale扱いしない", async () => {
    const now = Math.floor(Date.now() / 1000);
    const orchestrator = harness.store.registerOrchestrator({ label: "handoff", project: "project-a", repoCommonDir: "" });
    const session = harness.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    harness.store.heartbeatOrchestratorSession(session.id, session.generation, now - 91);
    harness.store.prepareOrchestratorHandoff(session.id, session.generation, "a".repeat(64), now + 300);

    const result = await orchestratorRoutingStage.tick(harness.deps, true, now);

    expect(result.actions).toBe(0);
    expect(harness.store.getOrchestratorSession(session.id)?.status).toBe("handoff_pending");
    expect(harness.store.getOrchestratorLivenessIncident(session.id, session.generation)).toBeNull();
  });

  it("作成後に追加されたwatchへqueued requestを次tickで再配送する", async () => {
    const task = harness.store.createTask(
      taskInput({ status: "ready", title: "late watch", body: "cwd: /worktrees/late\n本文", tenant: "project-a" }),
      "tester",
    );
    harness.store.block(task.id, "worker-question: 後から担当します", "supervisor");
    const request = harness.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_late_stage",
      question: "後から担当します",
      worktree: "/worktrees/late",
      project: "project-a",
    });
    const orchestrator = harness.store.registerOrchestrator({ label: "late", project: "project-a", repoCommonDir: "" });
    harness.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "worktree",
      selector: "/worktrees/late",
      role: "primary",
    });

    const result = await orchestratorRoutingStage.tick(harness.deps, true, Math.floor(Date.now() / 1000));

    expect(result.actions).toBe(1);
    expect(result.notes).toContain(`${request.id}: current binding/watchへ1件を再配送しました`);
    expect(harness.store.listOrchestratorRequests(orchestrator.id).map((row) => row.id)).toEqual([request.id]);
  });
});
