import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import {
  HumanDecisionError,
  canonicalizeHumanDecisionAnswer,
  canonicalizeHumanDecisionAsk,
  type CreateHumanDecisionRequestInput,
  type HumanDecisionRequestRow,
} from "./human-decision.js";
import type {
  ActorProvenance,
  AttestOrchestratorSuccessorLaunchResult,
  ClaimOrchestratorSuccessorAcceptResult,
  OrchestratorSessionRow,
  OrchestratorSuccessorLaunchKind,
} from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface OwnerFixture {
  orchestratorId: string;
  session: OrchestratorSessionRow;
  provenance: ActorProvenance;
}

interface SuccessorFixture {
  source: OrchestratorSessionRow;
  slotId: string;
  handoffTokenHash: string;
  now: number;
  canonicalCwd: string;
  hostId: string;
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
  ownerNonceHash: string;
  hookDefinitionHash: string;
  hookExecutableHash: string;
}

const human: ActorProvenance = {
  kind: "human",
  actorId: "local-reviewer",
  actorSessionId: "",
  actorGeneration: null,
};

describe("human decision core §80", () => {
  const stores: SqliteKanbanStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function createStore(): SqliteKanbanStore {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    return store;
  }

  function createOwner(store: SqliteKanbanStore, suffix: string): OwnerFixture {
    const orchestrator = store.registerOrchestrator({
      label: `human-decision-${suffix}`,
      project: "hachi-kanban",
      repoCommonDir: `/repo/${suffix}/.git`,
    });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    return {
      orchestratorId: orchestrator.id,
      session,
      provenance: {
        kind: "orchestrator",
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      },
    };
  }

  function decisionInput(
    taskId: string,
    provenance: ActorProvenance,
    key: string,
    overrides: Partial<CreateHumanDecisionRequestInput> = {},
  ): CreateHumanDecisionRequestInput {
    return {
      taskId,
      kind: "decision",
      title: "実装方針の選択",
      question: "どちらの方針で進めますか",
      idempotencyKey: key,
      choices: [
        { id: "keep", label: "現状維持" },
        { id: "change", label: "変更" },
      ],
      provenance,
      now: 1_700_000_000,
      ...overrides,
    } as CreateHumanDecisionRequestInput;
  }

  function answerAndClaim(
    store: SqliteKanbanStore,
    request: HumanDecisionRequestRow,
    owner: OwnerFixture,
    token: string,
    now: number,
  ): HumanDecisionRequestRow {
    store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: `answer-${request.id}`,
      answer: { kind: "decision", choiceId: "keep" },
      provenance: human,
      now,
    });
    return store.claimHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: token,
      leaseUntil: now + 100,
      provenance: owner.provenance,
      now: now + 1,
    });
  }

  function retryAnswer(store: SqliteKanbanStore, requestId: string, now: number): HumanDecisionRequestRow {
    return store.answerHumanDecisionRequest({
      requestId,
      expectedRevision: 0,
      answerIdempotencyKey: `answer-${requestId}`,
      answer: { kind: "decision", choiceId: "keep" },
      provenance: human,
      now,
    });
  }

  function armBoundSuccessor(
    store: SqliteKanbanStore,
    source: OrchestratorSessionRow,
    kind: OrchestratorSuccessorLaunchKind,
    suffix: string,
    now: number,
  ): SuccessorFixture {
    if (kind === "takeover") store.heartbeatOrchestratorSession(source.id, source.generation, now - 100);
    const fixture = {
      source,
      now,
      canonicalCwd: `/repo/${suffix}`,
      hostId: `host-${suffix}`,
      tmuxSession: `tmux-${suffix}`,
      tmuxPane: `%${suffix.length + 10}`,
      panePid: 20_000 + suffix.length,
      processGroupId: 30_000 + suffix.length,
      tmuxSocketPath: `/tmp/hachi-${suffix}.sock`,
      tmuxServerPid: 40_000 + suffix.length,
      tmuxServerStartTime: now - 1_000,
      tmuxServerLifetimeHash: hash(`server-${suffix}`),
      ownerNonceHash: hash(`owner-${suffix}`),
      hookDefinitionHash: hash(`hook-definition-${suffix}`),
      hookExecutableHash: hash(`hook-executable-${suffix}`),
      handoffTokenHash: hash(`handoff-${suffix}`),
    };
    const common = {
      orchestratorId: source.orchestratorId,
      targetProvider: "codex" as const,
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd: fixture.canonicalCwd,
      hostId: fixture.hostId,
      launchNonceHash: hash(`launch-${suffix}`),
      plannedTmuxSession: fixture.tmuxSession,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      runtimeDeadlineAt: now + 60,
      attestationDeadlineAt: now + 120,
      now,
    };
    const armed = kind === "handoff"
      ? store.armSuccessorLaunch({
          ...common,
          kind,
          handoffTokenFenceHash: fixture.handoffTokenHash,
          handoffExpiresAt: now + 120,
        })
      : store.armSuccessorLaunch({ ...common, kind, staleBefore: now - 50 });
    store.bindSuccessorLaunchRuntime({
      slotId: armed.id,
      expectedRevision: armed.revision,
      observedCanonicalCwd: fixture.canonicalCwd,
      observedHostId: fixture.hostId,
      tmuxSession: fixture.tmuxSession,
      tmuxPane: fixture.tmuxPane,
      panePid: fixture.panePid,
      processGroupId: fixture.processGroupId,
      tmuxSocketPath: fixture.tmuxSocketPath,
      tmuxServerPid: fixture.tmuxServerPid,
      tmuxServerStartTime: fixture.tmuxServerStartTime,
      tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      ownerNonceHash: fixture.ownerNonceHash,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      now: now + 1,
    });
    return { ...fixture, slotId: armed.id };
  }

  function attestAndClaim(
    store: SqliteKanbanStore,
    fixture: SuccessorFixture,
    operation: OrchestratorSuccessorLaunchKind,
  ): { attestation: AttestOrchestratorSuccessorLaunchResult; claim: ClaimOrchestratorSuccessorAcceptResult } {
    const attestation = store.attestSuccessorLaunch({
      providerSessionId: `codex-${fixture.slotId}`,
      providerSessionSource: "codex-session-start",
      source: "startup",
      canonicalCwd: fixture.canonicalCwd,
      hostId: fixture.hostId,
      tmuxSession: fixture.tmuxSession,
      tmuxPane: fixture.tmuxPane,
      panePid: fixture.panePid,
      processGroupId: fixture.processGroupId,
      tmuxSocketPath: fixture.tmuxSocketPath,
      tmuxServerPid: fixture.tmuxServerPid,
      tmuxServerStartTime: fixture.tmuxServerStartTime,
      tmuxServerLifetimeHash: fixture.tmuxServerLifetimeHash,
      ownerNonceHash: fixture.ownerNonceHash,
      hookDefinitionHash: fixture.hookDefinitionHash,
      hookExecutableHash: fixture.hookExecutableHash,
      now: fixture.now + 2,
    });
    if (attestation === null) throw new Error("attestation fixtureの作成に失敗しました");
    const claim = store.claimSuccessorLaunchAccept({
      slotId: fixture.slotId,
      expectedRevision: attestation.launch.revision,
      attestationHandleHash: hash(attestation.attestationHandle),
      operation,
      now: fixture.now + 3,
    });
    return { attestation, claim };
  }

  it("kind固有field・固定revision・links・choice/free textを厳密にcanonicalizeする", () => {
    const provenance = { kind: "orchestrator", actorId: "o", actorSessionId: "os", actorGeneration: 1 } as const;
    expect(canonicalizeHumanDecisionAsk({
      taskId: "t_x",
      kind: "approval",
      title: " 承認 ",
      question: " 実行しますか ",
      action: " publish ",
      targetRevision: { kind: "git_commit", value: "a".repeat(40) },
      idempotencyKey: " ask ",
      provenance,
    })).toMatchObject({
      title: "承認",
      action: "publish",
      defaultOutcome: "deny",
      choices: [],
      links: [],
    });
    expect(canonicalizeHumanDecisionAsk({
      taskId: "t_x",
      kind: "review",
      title: "レビュー",
      question: "受理しますか",
      targetRevision: { kind: "sha256", value: "b".repeat(64) },
      idempotencyKey: "review",
      provenance,
    }).defaultOutcome).toBe("not_accepted");
    expect(canonicalizeHumanDecisionAsk(decisionInput("t_x", provenance, "decision", { choices: [] })).defaultOutcome)
      .toBe("retain_current_state");

    const invalidInputs: unknown[] = [
      { ...decisionInput("t_x", provenance, "extra"), extra: true },
      { ...decisionInput("t_x", provenance, "action"), action: "not allowed" },
      { ...decisionInput("t_x", provenance, "revision"), targetRevision: { kind: "git_commit", value: "main" } },
      { ...decisionInput("t_x", provenance, "duplicate"), choices: [{ id: "x", label: "X" }, { id: "x", label: "Y" }] },
      { ...decisionInput("t_x", provenance, "bad-url"), links: [{ type: "url", label: "x", url: "https://u:p@example.com" }] },
      { ...decisionInput("t_x", provenance, "bad-artifact"), links: [{ type: "artifact", label: "x", artifactName: "../x" }] },
    ];
    for (const input of invalidInputs) {
      expect(() => canonicalizeHumanDecisionAsk(input as CreateHumanDecisionRequestInput)).toThrow(HumanDecisionError);
    }
    expect(() => canonicalizeHumanDecisionAnswer("decision", [{ id: "x", label: "X" }], {
      kind: "decision",
      text: "free",
    })).toThrow(/INVALID_INPUT/);
    expect(() => canonicalizeHumanDecisionAnswer("decision", [], { kind: "decision", choiceId: "x" }))
      .toThrow(/INVALID_INPUT/);
  });

  it("triage/todo/doneのtask row全fieldとevent/commentを変えず複数requestを解決する", () => {
    const store = createStore();
    const owner = createOwner(store, "task-invariance");
    const triage = store.createTask({ title: "triage", body: "body", tenant: "dev", status: "triage" }, "tester");
    const todo = store.createTask({ title: "todo", body: "body", tenant: "dev", status: "todo" }, "tester");
    const doneSeed = store.createTask({ title: "done", body: "body", tenant: "dev", status: "todo" }, "tester");
    const done = store.transition({ taskId: doneSeed.id, to: "done", actor: "tester" });
    for (const task of [triage, todo, done]) {
      store.addComment(task.id, "tester", "既存comment");
      const beforeTask = store.getTask(task.id);
      const beforeEvents = store.listEvents(task.id);
      const beforeComments = store.listComments(task.id);
      for (let index = 0; index < 2; index += 1) {
        const request = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, `${task.id}-${index}`));
        store.answerHumanDecisionRequest({
          requestId: request.id,
          expectedRevision: 0,
          answerIdempotencyKey: `a-${task.id}-${index}`,
          answer: { kind: "decision", choiceId: "keep" },
          provenance: human,
          now: 1_700_000_010 + index,
        });
        store.claimHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: `token-${task.id}-${index}`,
          leaseUntil: 1_700_000_100,
          provenance: owner.provenance,
          now: 1_700_000_020,
        });
        expect(store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: `token-${task.id}-${index}`,
          resolution: { outcome: "handled" },
          provenance: owner.provenance,
          now: 1_700_000_030,
        }).status).toBe("resolved");
      }
      expect(store.getTask(task.id)).toEqual(beforeTask);
      expect(store.listEvents(task.id)).toEqual(beforeEvents);
      expect(store.listComments(task.id)).toEqual(beforeComments);
    }
  });

  it("ask/answer idempotency、owner、reference、answer/cancel競合を閉じる", () => {
    const store = createStore();
    const owner = createOwner(store, "idempotency-owner");
    const other = createOwner(store, "idempotency-other");
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    const linked = store.createTask({ title: "linked", body: "", tenant: "dev" }, "tester");
    store.addEvent(task.id, "artifact_attached", "tester", { name: "proof.png", sizeBytes: 1 });
    const input = decisionInput(task.id, owner.provenance, "same", {
      links: [
        { type: "artifact", label: "証拠", artifactName: "proof.png" },
        { type: "task", label: "関連", taskId: linked.id },
      ],
    });
    const request = store.createHumanDecisionRequest(input);
    store.bindTaskToOrchestrator(task.id, other.orchestratorId, "primary");
    expect(request.ownerOrchestratorId).toBe(owner.orchestratorId);
    expect(store.createHumanDecisionRequest(input).id).toBe(request.id);
    expect(() => store.createHumanDecisionRequest({ ...input, question: "different" }))
      .toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(store.createHumanDecisionRequest(decisionInput(task.id, other.provenance, "same")).id).not.toBe(request.id);
    expect(() => store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "missing-artifact", {
      links: [{ type: "artifact", label: "missing", artifactName: "missing.png" }],
    }))).toThrow(/REFERENCE_NOT_FOUND/);

    const answered = store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: "answer-key",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "了解",
      provenance: human,
      now: 1_700_000_010,
    });
    expect(answered.answerRevision).toBe(1);
    const claimed = store.claimHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "secret-token",
      leaseUntil: 1_700_000_100,
      provenance: owner.provenance,
      now: 1_700_000_020,
    });
    expect(claimed).not.toHaveProperty("claimToken");
    expect(claimed).not.toHaveProperty("claimTokenHash");
    expect(store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: "answer-key",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "了解",
      provenance: human,
      now: 1_700_000_021,
    }).status).toBe("claimed");
    expect(() => store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: "other-key",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "了解",
      provenance: human,
    })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: "answer-key",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "了解",
      provenance: { ...human, actorId: "another-local-reviewer" },
    })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "secret-token",
      provenance: other.provenance,
    })).toThrow(/OWNER_MISMATCH/);
    store.resolveHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "secret-token",
      resolution: { outcome: "obsolete", reason: "新しい依頼で訂正" },
      provenance: owner.provenance,
      now: 1_700_000_030,
    });
    expect(store.answerHumanDecisionRequest({
      requestId: request.id,
      expectedRevision: 0,
      answerIdempotencyKey: "answer-key",
      answer: { kind: "decision", choiceId: "keep" },
      comment: "了解",
      provenance: human,
    }).status).toBe("resolved");

    const cancelWins = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "cancel-wins"));
    store.cancelHumanDecisionRequest({
      requestId: cancelWins.id,
      expectedRevision: 0,
      reason: "不要",
      provenance: owner.provenance,
    });
    expect(() => store.answerHumanDecisionRequest({
      requestId: cancelWins.id,
      expectedRevision: 0,
      answerIdempotencyKey: "late-answer",
      answer: { kind: "decision", choiceId: "keep" },
      provenance: human,
    })).toThrow(/STATE_CONFLICT/);
    const answerWins = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "answer-wins"));
    store.answerHumanDecisionRequest({
      requestId: answerWins.id,
      expectedRevision: 0,
      answerIdempotencyKey: "first-answer",
      answer: { kind: "decision", choiceId: "keep" },
      provenance: human,
    });
    expect(() => store.cancelHumanDecisionRequest({
      requestId: answerWins.id,
      expectedRevision: 0,
      reason: "late cancel",
      provenance: owner.provenance,
    })).toThrow(/REVISION_CONFLICT/);

    const relatedOther = store.createHumanDecisionRequest(decisionInput(task.id, other.provenance, "other-related"));
    expect(() => store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "bad-related", {
      relatedRequestId: relatedOther.id,
    }))).toThrow(/OWNER_MISMATCH/);
    const relatedDifferentTask = store.createHumanDecisionRequest(decisionInput(linked.id, owner.provenance, "other-task"));
    expect(() => store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "bad-related-task", {
      relatedRequestId: relatedDifferentTask.id,
    }))).toThrow(/OWNER_MISMATCH/);
    expect(() => store.claimHumanDecisionResponse({
      requestId: answerWins.id,
      expectedRevision: 0 as 1,
      claimToken: "bad-revision",
      leaseUntil: 2_000_000_000,
      provenance: owner.provenance,
    })).toThrow(/REVISION_CONFLICT/);
  });

  it("lease境界・stale claim奪取・release期限後・deadline無副作用を検証する", () => {
    const store = createStore();
    const owner = createOwner(store, "lease");
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    const request = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "lease", {
      deadlineAt: 1,
    }));
    expect(request.status).toBe("waiting_human");
    const claimed = answerAndClaim(store, request, owner, "old-token", 100);
    expect(claimed.answeredAt).toBe(100);
    expect(() => store.resolveHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "old-token",
      resolution: { outcome: "handled" },
      provenance: owner.provenance,
      now: 200,
    })).toThrow(/CLAIM_CONFLICT/);
    const stolen = store.claimHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "new-token",
      leaseUntil: 301,
      provenance: owner.provenance,
      now: 200,
    });
    expect(stolen.answeredAt).toBe(100);
    expect(() => store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "old-token",
      provenance: owner.provenance,
      now: 201,
    })).toThrow(/CLAIM_CONFLICT/);
    expect(store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "new-token",
      provenance: owner.provenance,
      now: 400,
    })).toMatchObject({ status: "answered", answeredAt: 100 });
  });

  it("従来handoffはtoken/lease/answeredAtを保持してclaimantだけ移管する", () => {
    const store = createStore();
    const owner = createOwner(store, "legacy-handoff");
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    const request = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, "legacy-handoff"));
    answerAndClaim(store, request, owner, "handoff-token", 1_700_000_000);
    const handoffHash = hash("session-handoff");
    store.prepareOrchestratorHandoff(owner.session.id, owner.session.generation, handoffHash, 2_000_000_000);
    const successor = store.acceptOrchestratorHandoff({ oldSessionId: owner.session.id, tokenHash: handoffHash });
    const current = retryAnswer(store, request.id, 1_700_000_010);
    expect(current).toMatchObject({
      status: "claimed",
      claimantSessionId: successor.id,
      claimantGeneration: successor.generation,
      claimLeaseUntil: 1_700_000_100,
      answeredAt: 1_700_000_000,
    });
    expect(() => store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "handoff-token",
      provenance: owner.provenance,
    })).toThrow(/SESSION_SUPERSEDED/);
    expect(store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: "handoff-token",
      provenance: {
        kind: "orchestrator",
        actorId: owner.orchestratorId,
        actorSessionId: successor.id,
        actorGeneration: successor.generation,
      },
    }).status).toBe("answered");
  });

  it.each(["close", "takeover", "expire"] as const)("%sは回答/answeredAtを保持してrequeueする", (path) => {
    const store = createStore();
    const owner = createOwner(store, `requeue-${path}`);
    const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
    const request = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, `requeue-${path}`));
    answerAndClaim(store, request, owner, `${path}-token`, 1_700_000_000);
    let successor: OrchestratorSessionRow | null = null;
    if (path === "close") {
      store.closeOrchestratorSession(owner.session.id, owner.session.generation);
    } else if (path === "takeover") {
      store.heartbeatOrchestratorSession(owner.session.id, owner.session.generation, 100);
      successor = store.takeoverStaleOrchestratorSession({ orchestratorId: owner.orchestratorId, staleBefore: 101 });
    } else {
      store.heartbeatOrchestratorSession(owner.session.id, owner.session.generation, 100);
      expect(store.expireStaleOrchestratorSessions(101, 200)).toBe(1);
    }
    expect(retryAnswer(store, request.id, 1_700_000_010)).toMatchObject({
      status: "answered",
      answerRevision: 1,
      answeredAt: 1_700_000_000,
      claimantSessionId: null,
      claimLeaseUntil: null,
    });
    expect(() => store.releaseHumanDecisionResponse({
      requestId: request.id,
      expectedRevision: 1,
      claimToken: `${path}-token`,
      provenance: owner.provenance,
    })).toThrow(/SESSION_SUPERSEDED/);
    if (successor !== null) {
      expect(store.claimHumanDecisionResponse({
        requestId: request.id,
        expectedRevision: 1,
        claimToken: "fresh-token",
        leaseUntil: 2_000_000_000,
        provenance: {
          kind: "orchestrator",
          actorId: owner.orchestratorId,
          actorSessionId: successor.id,
          actorGeneration: successor.generation,
        },
        now: 1_700_000_020,
      }).status).toBe("claimed");
    }
  });

  it("successor launch付きhandoff/takeoverも同じtransactionでtransfer/requeueする", () => {
    for (const kind of ["handoff", "takeover"] as const) {
      const store = createStore();
      const owner = createOwner(store, `successor-${kind}`);
      const task = store.createTask({ title: "t", body: "", tenant: "dev" }, "tester");
      const request = store.createHumanDecisionRequest(decisionInput(task.id, owner.provenance, `successor-${kind}`));
      const now = 1_700_100_000;
      answerAndClaim(store, request, owner, `${kind}-claim-token`, now);
      const fixture = armBoundSuccessor(store, owner.session, kind, `human-${kind}`, now);
      const accepted = attestAndClaim(store, fixture, kind);
      const successor = kind === "handoff"
        ? store.acceptOrchestratorHandoffWithSuccessorLaunch({
            slotId: fixture.slotId,
            expectedRevision: accepted.claim.launch.revision,
            acceptFenceHash: hash(accepted.claim.acceptFence),
            attestationHandleHash: hash(accepted.attestation.attestationHandle),
            handoffTokenHash: fixture.handoffTokenHash,
            now: fixture.now + 4,
          })
        : store.takeoverStaleOrchestratorSessionWithSuccessorLaunch({
            slotId: fixture.slotId,
            expectedRevision: accepted.claim.launch.revision,
            acceptFenceHash: hash(accepted.claim.acceptFence),
            attestationHandleHash: hash(accepted.attestation.attestationHandle),
            now: fixture.now + 4,
          });
      const current = retryAnswer(store, request.id, fixture.now + 5);
      const successorProvenance: ActorProvenance = {
        kind: "orchestrator",
        actorId: owner.orchestratorId,
        actorSessionId: successor.id,
        actorGeneration: successor.generation,
      };
      if (kind === "handoff") {
        expect(current).toMatchObject({
          status: "claimed",
          answerRevision: 1,
          answer: { kind: "decision", choiceId: "keep" },
          claimantSessionId: successor.id,
          claimantGeneration: successor.generation,
          claimLeaseUntil: fixture.now + 100,
          answeredAt: fixture.now,
        });
        expect(() => store.releaseHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "handoff-claim-token",
          provenance: owner.provenance,
          now: fixture.now + 6,
        })).toThrow(/SESSION_SUPERSEDED/);
        expect(() => store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "handoff-claim-token",
          resolution: { outcome: "handled" },
          provenance: owner.provenance,
          now: fixture.now + 6,
        })).toThrow(/SESSION_SUPERSEDED/);
        const wrongGenerationProvenance: ActorProvenance = {
          ...successorProvenance,
          actorGeneration: successor.generation + 1,
        };
        expect(() => store.releaseHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "handoff-claim-token",
          provenance: wrongGenerationProvenance,
          now: fixture.now + 7,
        })).toThrow(/SESSION_SUPERSEDED/);
        expect(() => store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "handoff-claim-token",
          resolution: { outcome: "handled" },
          provenance: wrongGenerationProvenance,
          now: fixture.now + 7,
        })).toThrow(/SESSION_SUPERSEDED/);
        expect(retryAnswer(store, request.id, fixture.now + 8)).toEqual(current);
        expect(store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "handoff-claim-token",
          resolution: { outcome: "handled" },
          provenance: successorProvenance,
          now: fixture.now + 9,
        })).toMatchObject({
          status: "resolved",
          answerRevision: 1,
          answer: { kind: "decision", choiceId: "keep" },
          answeredAt: fixture.now,
          resolution: { outcome: "handled" },
        });
      } else {
        expect(current).toMatchObject({
          status: "answered",
          answerRevision: 1,
          answer: { kind: "decision", choiceId: "keep" },
          claimantSessionId: null,
          claimLeaseUntil: null,
          answeredAt: fixture.now,
        });
        expect(() => store.releaseHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-claim-token",
          provenance: owner.provenance,
          now: fixture.now + 6,
        })).toThrow(/SESSION_SUPERSEDED/);
        expect(() => store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-claim-token",
          resolution: { outcome: "handled" },
          provenance: owner.provenance,
          now: fixture.now + 6,
        })).toThrow(/SESSION_SUPERSEDED/);
        expect(retryAnswer(store, request.id, fixture.now + 7)).toEqual(current);
        const claimed = store.claimHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-fresh-token",
          leaseUntil: fixture.now + 100,
          provenance: successorProvenance,
          now: fixture.now + 8,
        });
        expect(claimed).toMatchObject({
          status: "claimed",
          answerRevision: 1,
          answer: { kind: "decision", choiceId: "keep" },
          answeredAt: fixture.now,
          claimantSessionId: successor.id,
          claimantGeneration: successor.generation,
        });
        expect(() => store.releaseHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-claim-token",
          provenance: successorProvenance,
          now: fixture.now + 9,
        })).toThrow(/CLAIM_CONFLICT/);
        expect(() => store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-claim-token",
          resolution: { outcome: "handled" },
          provenance: successorProvenance,
          now: fixture.now + 9,
        })).toThrow(/CLAIM_CONFLICT/);
        expect(retryAnswer(store, request.id, fixture.now + 10)).toEqual(claimed);
        expect(store.resolveHumanDecisionResponse({
          requestId: request.id,
          expectedRevision: 1,
          claimToken: "takeover-fresh-token",
          resolution: { outcome: "handled" },
          provenance: successorProvenance,
          now: fixture.now + 11,
        })).toMatchObject({
          status: "resolved",
          answerRevision: 1,
          answer: { kind: "decision", choiceId: "keep" },
          answeredAt: fixture.now,
          resolution: { outcome: "handled" },
        });
      }
    }
  });
});
