import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import {
  EXTERNAL_RUNTIME_GENERATION_SCHEMA,
  EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
  EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  canonicalJson,
  classifyRuntimeGenerationInterruption,
  externalRuntimeGenerationEndpointIdentityHash,
  parseExternalRuntimeGenerationStatus,
  type ExternalRuntimeGenerationAttestationV1,
  type ExternalRuntimeGenerationIdentityV1,
  type ExternalRuntimeGenerationState,
  type ExternalRuntimeGenerationStatusV1,
  type ExternalRuntimeGenerationTransitionV1,
} from "./external-runtime-generation.js";
import { createKanbanReadView } from "./readview.js";

const BASE_NOW = 2_000_000_000_000;
const PROCESS_START = "darwin-ps-lstart:Mon Aug 25 10:11:12 2026";
const ENDPOINT_HASH = externalRuntimeGenerationEndpointIdentityHash("codex", "http://127.0.0.1:3456");

function identity(model: string, generationId = "1".repeat(32)): ExternalRuntimeGenerationIdentityV1 {
  return {
    kind: "external-shared-runtime",
    generationId,
    runtimeModelId: model,
    modelReadbackSource: "codex-applied-model",
    writerPid: 101,
    writerProcessStart: PROCESS_START,
    runtimePid: 202,
    runtimeProcessStart: PROCESS_START,
    bootNonce: "2".repeat(32),
    endpointIdentityHash: ENDPOINT_HASH,
    startedAt: BASE_NOW - 10_000,
  };
}

function attestation(
  value: ExternalRuntimeGenerationIdentityV1,
  statusRevision: number,
): ExternalRuntimeGenerationAttestationV1 {
  const observedAt = BASE_NOW - (3 - statusRevision) * 1_000;
  return {
    version: 1,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    statusRevision,
    state: "running",
    identity: value,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
}

function transition(
  revision: number,
  kind: ExternalRuntimeGenerationState,
  oldIdentity: ExternalRuntimeGenerationIdentityV1 | null,
  newIdentity: ExternalRuntimeGenerationIdentityV1 | null,
): ExternalRuntimeGenerationTransitionV1 {
  const observedAt = revision <= 2
    ? BASE_NOW - (3 - revision) * 1_000
    : BASE_NOW + revision * 1_000;
  return {
    version: 1,
    revision,
    kind,
    oldIdentity,
    newIdentity,
    lastSeenAt: kind === "stopped" || kind === "replaced" ? observedAt - 200 : null,
    stoppedAt: kind === "stopped" ? observedAt - 100 : null,
    replacementFirstSeenAt: kind === "replaced" ? observedAt - 100 : null,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
    source: kind === "running" ? "endpoint-observer" : "owner-wait",
  };
}

function sortAttestations(values: ExternalRuntimeGenerationAttestationV1[]): ExternalRuntimeGenerationAttestationV1[] {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(canonicalJson(left.identity)), Buffer.from(canonicalJson(right.identity))));
}

function sortTransitions(values: ExternalRuntimeGenerationTransitionV1[]): ExternalRuntimeGenerationTransitionV1[] {
  return [...values].sort((left, right) => {
    if (left.revision !== right.revision) return left.revision - right.revision;
    const leftKey = canonicalJson([left.kind, left.oldIdentity, left.newIdentity]);
    const rightKey = canonicalJson([right.kind, right.oldIdentity, right.newIdentity]);
    return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
  });
}

function runningFixture(): ExternalRuntimeGenerationStatusV1 {
  const attestations = sortAttestations([
    attestation(identity("gpt-5.6/model-b"), 2),
    attestation(identity("gpt-5.6/model-a"), 1),
  ]);
  const transitions = sortTransitions(attestations.map((entry) =>
    transition(entry.statusRevision, "running", null, entry.identity)));
  return {
    schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
    schemaVersion: 1,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    revision: 2,
    state: "running",
    attestations,
    transitions,
    observedAt: BASE_NOW,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: BASE_NOW + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
}

function terminalFixture(kind: "stopped" | "replaced" | "unknown"): ExternalRuntimeGenerationStatusV1 {
  const running = runningFixture();
  const replacement = kind === "replaced"
    ? { ...identity("gpt-5.6/model-new", "3".repeat(32)), startedAt: BASE_NOW + 2_850 }
    : null;
  const terminalBatch = running.attestations.map((entry) => transition(3, kind, entry.identity, replacement));
  return {
    ...running,
    revision: 3,
    state: kind,
    attestations: [],
    transitions: sortTransitions([...running.transitions, ...terminalBatch]),
    observedAt: BASE_NOW + 3_000,
    expiresAt: BASE_NOW + 3_000 + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
}

function raw(value: ExternalRuntimeGenerationStatusV1): string {
  return JSON.stringify(value);
}

interface CrossRepoFixtureGeneration {
  name: string;
  generationId: string;
  runtimePid: number;
  runtimeProcessStart: string;
  startedAt: number;
}

interface CrossRepoFixtureTimelineEvent {
  revision: number;
  operation: ExternalRuntimeGenerationState;
  generation: string;
  modelIndex?: number;
  replacementGeneration?: string;
  replacementModelIndex?: number;
  observedAt: number;
}

interface CrossRepoFixture {
  schema: string;
  schemaHash: string;
  provider: "codex";
  lane: "even-shared";
  runtimeKey: string;
  endpoint: string;
  writerPid: number;
  writerProcessStart: string;
  bootNonce: string;
  models: string[];
  generations: CrossRepoFixtureGeneration[];
  timeline: CrossRepoFixtureTimelineEvent[];
  expected: {
    terminalBatchRevisions: Record<"stopped" | "replaced" | "unknown", number>;
    terminalBatchSize: number;
    finalRevision: number;
    finalState: ExternalRuntimeGenerationState;
    canonicalSha256: string;
  };
}

function crossRepoFixtureStatuses(): {
  fixture: CrossRepoFixture;
  snapshots: Map<number, ExternalRuntimeGenerationStatusV1>;
} {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/external-runtime-generation-status-v1.json", import.meta.url),
    "utf8",
  )) as CrossRepoFixture;
  const generations = new Map(fixture.generations.map((entry) => [entry.name, entry]));
  const endpointHash = externalRuntimeGenerationEndpointIdentityHash(fixture.provider, fixture.endpoint);
  const fixtureIdentity = (generationName: string, modelIndex: number): ExternalRuntimeGenerationIdentityV1 => {
    const generation = generations.get(generationName);
    const model = fixture.models[modelIndex];
    if (generation === undefined || model === undefined) throw new Error("cross-repo fixture identity が不正です");
    return {
      kind: "external-shared-runtime",
      generationId: generation.generationId,
      runtimeModelId: model,
      modelReadbackSource: "codex-applied-model",
      writerPid: fixture.writerPid,
      writerProcessStart: fixture.writerProcessStart,
      runtimePid: generation.runtimePid,
      runtimeProcessStart: generation.runtimeProcessStart,
      bootNonce: fixture.bootNonce,
      endpointIdentityHash: endpointHash,
      startedAt: generation.startedAt,
    };
  };

  let attestations: ExternalRuntimeGenerationAttestationV1[] = [];
  let transitions: ExternalRuntimeGenerationTransitionV1[] = [];
  let previousObservedAt = 0;
  const snapshots = new Map<number, ExternalRuntimeGenerationStatusV1>();
  for (const event of fixture.timeline) {
    if (event.operation === "running") {
      if (event.modelIndex === undefined) throw new Error("cross-repo running fixture が不正です");
      const value = fixtureIdentity(event.generation, event.modelIndex);
      attestations = sortAttestations([...attestations, {
        version: 1,
        schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
        provider: fixture.provider,
        lane: fixture.lane,
        runtimeKey: fixture.runtimeKey,
        statusRevision: event.revision,
        state: "running",
        identity: value,
        observedAt: event.observedAt,
        ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
        expiresAt: event.observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
      }]);
      transitions = sortTransitions([...transitions, {
        version: 1,
        revision: event.revision,
        kind: "running",
        oldIdentity: null,
        newIdentity: value,
        lastSeenAt: null,
        stoppedAt: null,
        replacementFirstSeenAt: null,
        observedAt: event.observedAt,
        ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        expiresAt: event.observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        source: "endpoint-observer",
      }]);
    } else {
      const replacement = event.operation === "replaced"
        ? fixtureIdentity(event.replacementGeneration ?? "", event.replacementModelIndex ?? -1)
        : null;
      const batch = attestations.map((entry): ExternalRuntimeGenerationTransitionV1 => {
        const lastSeenAt = event.operation === "stopped" || event.operation === "replaced"
          ? Math.max(entry.identity.startedAt, previousObservedAt)
          : null;
        const stoppedAt = event.operation === "stopped"
          ? Math.max(lastSeenAt ?? 0, event.observedAt)
          : null;
        const replacementFirstSeenAt = event.operation === "replaced"
          ? Math.max(lastSeenAt ?? 0, replacement?.startedAt ?? 0)
          : null;
        return {
          version: 1,
          revision: event.revision,
          kind: event.operation,
          oldIdentity: entry.identity,
          newIdentity: replacement,
          lastSeenAt,
          stoppedAt,
          replacementFirstSeenAt,
          observedAt: event.observedAt,
          ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
          expiresAt: event.observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
          source: event.operation === "stopped" ? "owner-wait" : "endpoint-observer",
        };
      });
      transitions = sortTransitions([...transitions, ...batch]);
      attestations = [];
    }
    snapshots.set(event.revision, {
      schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
      schemaVersion: 1,
      schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
      provider: fixture.provider,
      lane: fixture.lane,
      runtimeKey: fixture.runtimeKey,
      revision: event.revision,
      state: event.operation,
      attestations,
      transitions,
      observedAt: event.observedAt,
      ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
      expiresAt: event.observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    });
    previousObservedAt = event.observedAt;
  }
  return { fixture, snapshots };
}

describe("external runtime generation wire contract", () => {
  it("A1-Eと共有するoffline fixtureの4 state・batch・canonical SHAをbyte-exactに固定する", () => {
    const { fixture, snapshots } = crossRepoFixtureStatuses();
    expect(fixture.schema).toBe("external-runtime-generation-cross-repo-fixture/v1");
    expect(fixture.schemaHash).toBe(EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH);
    for (const kind of ["stopped", "replaced", "unknown"] as const) {
      const revision = fixture.expected.terminalBatchRevisions[kind];
      const status = snapshots.get(revision);
      expect(status?.state).toBe(kind);
      expect(status?.attestations).toEqual([]);
      expect(status?.transitions.filter((entry) => entry.revision === revision)).toHaveLength(
        fixture.expected.terminalBatchSize,
      );
    }
    const final = snapshots.get(fixture.expected.finalRevision);
    if (final === undefined) throw new Error("cross-repo final fixture がありません");
    const parsed = parseExternalRuntimeGenerationStatus(raw(final), fixture.provider);
    expect(parsed.status.state).toBe(fixture.expected.finalState);
    expect(parsed.canonicalDigest).toBe(fixture.expected.canonicalSha256);
  });

  it.each(["stopped", "replaced", "unknown"] as const)(
    "%s batch は同一revision・derived key順・2 model全件除去を検証する",
    (kind) => {
      const parsed = parseExternalRuntimeGenerationStatus(raw(terminalFixture(kind)), "codex");
      const batch = parsed.status.transitions.filter((entry) => entry.revision === 3);
      expect(batch).toHaveLength(2);
      expect(new Set(batch.map((entry) => entry.revision))).toEqual(new Set([3]));
      expect(parsed.status.attestations).toEqual([]);
      expect(batch.map((entry) => entry.oldIdentity?.runtimeModelId).sort()).toEqual([
        "gpt-5.6/model-a",
        "gpt-5.6/model-b",
      ]);
    },
  );

  it("endpoint-observer由来のstoppedをexact terminal evidenceとして受理しない", () => {
    const fixture = terminalFixture("stopped");
    const invalid = {
      ...fixture,
      transitions: fixture.transitions.map((entry) => entry.kind === "stopped"
        ? { ...entry, source: "endpoint-observer" as const }
        : entry),
    };
    expect(() => parseExternalRuntimeGenerationStatus(raw(invalid), "codex")).toThrowError(
      expect.objectContaining({ code: "value_invalid" }),
    );
  });

  it("identity.startedAtとterminal時刻の全順序逆転をfile全体invalidにする", () => {
    const stopped = terminalFixture("stopped");
    const replaced = terminalFixture("replaced");
    const unknown = terminalFixture("unknown");
    const unknownNewIdentity = {
      ...identity("gpt-5.6/model-new", "3".repeat(32)),
      startedAt: BASE_NOW + 2_850,
    };
    const invalidChronologies: Array<{ label: string; status: ExternalRuntimeGenerationStatusV1 }> = [
      {
        label: "old startedAt > lastSeenAt",
        status: {
          ...stopped,
          transitions: stopped.transitions.map((entry) =>
            entry.kind === "stopped" && entry.oldIdentity !== null && entry.lastSeenAt !== null
              ? { ...entry, oldIdentity: { ...entry.oldIdentity, startedAt: entry.lastSeenAt + 1 } }
              : entry),
        },
      },
      {
        label: "lastSeenAt > stoppedAt",
        status: {
          ...stopped,
          transitions: stopped.transitions.map((entry) =>
            entry.kind === "stopped" && entry.stoppedAt !== null
              ? { ...entry, lastSeenAt: entry.stoppedAt + 1 }
              : entry),
        },
      },
      {
        label: "lastSeenAt > new startedAt",
        status: {
          ...replaced,
          transitions: replaced.transitions.map((entry) =>
            entry.kind === "replaced" && entry.newIdentity !== null && entry.lastSeenAt !== null
              ? { ...entry, newIdentity: { ...entry.newIdentity, startedAt: entry.lastSeenAt - 1 } }
              : entry),
        },
      },
      {
        label: "new startedAt > replacementFirstSeenAt",
        status: {
          ...replaced,
          transitions: replaced.transitions.map((entry) =>
            entry.kind === "replaced" && entry.newIdentity !== null && entry.replacementFirstSeenAt !== null
              ? { ...entry, newIdentity: { ...entry.newIdentity, startedAt: entry.replacementFirstSeenAt + 1 } }
              : entry),
        },
      },
      {
        label: "nullable fieldを挟むold startedAt > new startedAt",
        status: {
          ...unknown,
          transitions: unknown.transitions.map((entry) => entry.kind === "unknown" && entry.oldIdentity !== null
            ? {
                ...entry,
                newIdentity: { ...unknownNewIdentity, startedAt: entry.oldIdentity.startedAt - 1 },
              }
            : entry),
        },
      },
      {
        label: "unknown lastSeenAt > new startedAt",
        status: {
          ...unknown,
          transitions: unknown.transitions.map((entry) => entry.kind === "unknown"
            ? {
                ...entry,
                newIdentity: unknownNewIdentity,
                lastSeenAt: unknownNewIdentity.startedAt + 1,
                replacementFirstSeenAt: unknownNewIdentity.startedAt + 2,
              }
            : entry),
        },
      },
      {
        label: "nullable fieldを挟むold startedAt > replacementFirstSeenAt",
        status: {
          ...unknown,
          transitions: unknown.transitions.map((entry) => entry.kind === "unknown" && entry.oldIdentity !== null
            ? { ...entry, replacementFirstSeenAt: entry.oldIdentity.startedAt - 1 }
            : entry),
        },
      },
    ];
    for (const fixture of invalidChronologies) {
      expect(
        () => parseExternalRuntimeGenerationStatus(raw(fixture.status), "codex"),
        fixture.label,
      ).toThrowError(expect.objectContaining({ code: "value_invalid" }));
    }
  });

  it("transition revision間のclock rollbackを拒否する", () => {
    const running = runningFixture();
    const firstObservedAt = running.transitions[0]!.observedAt;
    expect(() => parseExternalRuntimeGenerationStatus(raw({
      ...running,
      transitions: running.transitions.map((entry) => entry.revision === 2
        ? {
            ...entry,
            observedAt: firstObservedAt - 1,
            expiresAt: firstObservedAt - 1 + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
          }
        : entry),
    }), "codex")).toThrowError(expect.objectContaining({ code: "value_invalid" }));
  });

  it("同一generationの複数model terminalをmodel別revisionへ分割したpayloadを拒否する", () => {
    const fixture = terminalFixture("stopped");
    const split = {
      ...fixture,
      revision: 4,
      transitions: sortTransitions(fixture.transitions.map((entry) =>
        entry.kind === "stopped" && entry.oldIdentity?.runtimeModelId === "gpt-5.6/model-b"
          ? { ...entry, revision: 4 }
          : entry)),
    };
    expect(() => parseExternalRuntimeGenerationStatus(raw(split), "codex")).toThrowError(
      expect.objectContaining({ code: "value_invalid" }),
    );
  });

  it("raw key order/whitespace/number/escape差を同じcanonical bytes/SHAへ畳み込む", () => {
    const fixture = terminalFixture("stopped");
    const canonical = parseExternalRuntimeGenerationStatus(raw(fixture), "codex");
    const { schema, schemaVersion, ...remaining } = fixture;
    const reordered = { ...remaining, schemaVersion, schema };
    const variant = JSON.stringify(reordered, null, 2)
      .replace('"revision": 3,', '"revision": 3e0,')
      .replaceAll("gpt-5.6/model-a", "gpt-5.6\\u002fmodel-a");
    const parsedVariant = parseExternalRuntimeGenerationStatus(variant, "codex");
    expect(parsedVariant.canonicalJson).toBe(canonical.canonicalJson);
    expect(parsedVariant.canonicalDigest).toBe(canonical.canonicalDigest);
    expect(canonical.canonicalDigest).toBe(
      "sha256:0e5dbd81576f5f91585d764e8fc7d685908f12b07aabd09d3d106aad63153653",
    );
  });

  it("Codex/Claudeのlaneとruntime model readback sourceをproviderごとに固定する", () => {
    const running = runningFixture();
    const toClaudeIdentity = (value: ExternalRuntimeGenerationIdentityV1 | null):
    ExternalRuntimeGenerationIdentityV1 | null => value === null ? null : {
      ...value,
      modelReadbackSource: "claude-runtime-model",
      endpointIdentityHash: externalRuntimeGenerationEndpointIdentityHash("claude", "http://127.0.0.1:3457"),
    };
    const claude: ExternalRuntimeGenerationStatusV1 = {
      ...running,
      provider: "claude",
      lane: "even-claude",
      runtimeKey: "external-shared-runtime/claude/even-claude",
      attestations: running.attestations.map((entry) => ({
        ...entry,
        provider: "claude",
        lane: "even-claude",
        runtimeKey: "external-shared-runtime/claude/even-claude",
        identity: toClaudeIdentity(entry.identity)!,
      })),
      transitions: running.transitions.map((entry) => ({
        ...entry,
        oldIdentity: toClaudeIdentity(entry.oldIdentity),
        newIdentity: toClaudeIdentity(entry.newIdentity),
      })),
    };
    expect(parseExternalRuntimeGenerationStatus(raw(claude), "claude").status).toMatchObject({
      provider: "claude",
      lane: "even-claude",
      runtimeKey: "external-shared-runtime/claude/even-claude",
    });
    expect(() => parseExternalRuntimeGenerationStatus(raw({
      ...claude,
      attestations: claude.attestations.map((entry) => ({
        ...entry,
        identity: { ...entry.identity, modelReadbackSource: "codex-applied-model" },
      })),
    }), "claude")).toThrowError("value_invalid");
  });

  it("duplicate/unknown keyとattestation/transition array順違いをdigest比較前に拒否する", () => {
    const fixture = terminalFixture("stopped");
    const canonical = canonicalJson(fixture);
    const duplicate = canonical.replace(
      '"schema":',
      `"schema":"${EXTERNAL_RUNTIME_GENERATION_SCHEMA}","schema":`,
    );
    expect(() => parseExternalRuntimeGenerationStatus(duplicate, "codex")).toThrowError("duplicate_key");
    expect(() => parseExternalRuntimeGenerationStatus(
      canonical.replace("{", '{"diagnostic":"forbidden",'),
      "codex",
    )).toThrowError("unknown_key");
    expect(() => parseExternalRuntimeGenerationStatus(raw({
      ...fixture,
      transitions: [...fixture.transitions].reverse(),
    }), "codex")).toThrowError("array_order_invalid");
    const running = runningFixture();
    expect(() => parseExternalRuntimeGenerationStatus(raw({
      ...running,
      attestations: [...running.attestations].reverse(),
    }), "codex")).toThrowError("array_order_invalid");
  });
});

describe("external runtime generation durable Store", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function storeFixture(): { store: SqliteKanbanStore; dbPath: string } {
    const root = mkdtempSync(join(tmpdir(), "hachi-external-generation-"));
    tempPaths.push(root);
    const dbPath = join(root, "kanban.db");
    return { store: new SqliteKanbanStore(dbPath), dbPath };
  }

  it("migration v24とread viewを作り、replay/equivocation/history欠落をfail-closedにする", () => {
    const { store, dbPath } = storeFixture();
    const running = parseExternalRuntimeGenerationStatus(raw(runningFixture()), "codex");
    expect(store.acceptExternalRuntimeGenerationStatus(running, BASE_NOW)).toBe("accepted");
    expect(store.acceptExternalRuntimeGenerationStatus(running, BASE_NOW + 1)).toBe("idempotent");

    const semanticDifference = parseExternalRuntimeGenerationStatus(raw({
      ...runningFixture(),
      observedAt: BASE_NOW + 1,
      expiresAt: BASE_NOW + 1 + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    }), "codex");
    expect(store.acceptExternalRuntimeGenerationStatus(semanticDifference, BASE_NOW + 1)).toBe("equivocation");

    const replay = parseExternalRuntimeGenerationStatus(raw({
      ...runningFixture(),
      revision: 1,
      attestations: [runningFixture().attestations[0]!],
      transitions: [runningFixture().transitions[0]!],
    }), "codex");
    expect(store.acceptExternalRuntimeGenerationStatus(replay, BASE_NOW + 2)).toBe("replay");

    const stopped = terminalFixture("stopped");
    const incomplete = parseExternalRuntimeGenerationStatus(raw({
      ...stopped,
      transitions: stopped.transitions.filter((entry) =>
        entry.revision !== 3 || entry.oldIdentity?.runtimeModelId === "gpt-5.6/model-a"),
    }), "codex");
    expect(store.acceptExternalRuntimeGenerationStatus(incomplete, BASE_NOW + 3_000)).toBe("history_missing");

    const check = new Database(dbPath, { readonly: true });
    expect(check.prepare(`SELECT version FROM schema_migrations WHERE version = 24`).get()).toEqual({ version: 24 });
    check.close();
    const view = createKanbanReadView(dbPath);
    expect(view.externalRuntimeGenerationStatus("codex")?.canonicalDigest).toBe(running.canonicalDigest);
    view.close();
    store.close();
  });

  it("launch successと同じTxでresponse/status exact attestationだけをbindしterminal分類を一度だけ導ける", () => {
    const { store, dbPath } = storeFixture();
    const task = store.createTask({
      title: "external generation",
      body: "cwd: /tmp",
      tenant: "test",
    }, "test");
    const run = store.startRun(task.id, "codex", "session-1", {
      role: "worker",
      transport: "bridge",
      serverUrl: "http://127.0.0.1:3456",
      appliedModel: runningFixture().attestations[0]!.identity.runtimeModelId,
    });
    const running = parseExternalRuntimeGenerationStatus(raw(runningFixture()), "codex");
    store.transaction(() => {
      expect(store.acceptExternalRuntimeGenerationStatus(running, BASE_NOW)).toBe("accepted");
      expect(store.bindExternalRuntimeGenerationLaunch({
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        role: "worker",
        provider: "codex",
        transport: "bridge",
        attestation: running.status.attestations[0],
        statusRevision: running.status.revision,
        statusDigest: running.canonicalDigest,
        boundAt: BASE_NOW,
      })).toBe(true);
    });
    expect(store.bindExternalRuntimeGenerationLaunch({
      taskId: task.id,
      runId: run.id,
      sessionId: run.sessionId,
      role: "worker",
      provider: "codex",
      transport: "bridge",
      attestation: { ...running.status.attestations[0], runtimeKey: "mismatch" },
      statusRevision: running.status.revision,
      statusDigest: running.canonicalDigest,
      boundAt: BASE_NOW,
    })).toBe(false);

    const stopped = parseExternalRuntimeGenerationStatus(raw(terminalFixture("stopped")), "codex");
    expect(store.acceptExternalRuntimeGenerationStatus(stopped, BASE_NOW + 3_000)).toBe("accepted");
    const binding = store.getExternalRuntimeGenerationBinding(run.id)!;
    const status = store.getExternalRuntimeGenerationStatus("codex")!;
    const correlation = classifyRuntimeGenerationInterruption({
      binding,
      status,
      runStartedAt: BASE_NOW - 20_000,
      terminalObservedAt: BASE_NOW + 3_100,
      nowMs: BASE_NOW + 3_100,
      diagnosticCode: "worker_output_missing",
    });
    expect(correlation).toMatchObject({
      reason: "runtime_generation_interrupted",
      runId: run.id,
      transitionKind: "stopped",
      deltaMs: 200,
    });
    expect(classifyRuntimeGenerationInterruption({
      binding,
      status: {
        ...status,
        status: {
          ...status.status,
          transitions: status.status.transitions.map((entry) => entry.kind === "stopped"
            ? { ...entry, source: "endpoint-observer" as const }
            : entry),
        },
      },
      runStartedAt: BASE_NOW - 20_000,
      terminalObservedAt: BASE_NOW + 3_100,
      nowMs: BASE_NOW + 3_100,
      diagnosticCode: "worker_output_missing",
    })).toBeNull();

    const view = createKanbanReadView(dbPath);
    expect(view.externalRuntimeGenerationBinding(run.id)).toEqual(binding);
    view.close();
    store.close();
  });

  it("running/unknown/stale/mismatch/legacyはconfirmed terminalへ昇格しない", () => {
    const { store } = storeFixture();
    const task = store.createTask({
      title: "legacy boundaries",
      body: "cwd: /tmp",
      tenant: "test",
    }, "test");
    const run = store.startRun(task.id, "codex", "session-legacy", { role: "worker", transport: "bridge" });
    const running = parseExternalRuntimeGenerationStatus(raw(runningFixture()), "codex");
    store.acceptExternalRuntimeGenerationStatus(running, BASE_NOW);
    expect(store.getExternalRuntimeGenerationBinding(run.id)).toBeNull();
    expect(classifyRuntimeGenerationInterruption({
      binding: {
        version: 1,
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        role: "worker",
        provider: "codex",
        transport: "bridge",
        runtimeKey: running.status.runtimeKey,
        identity: running.status.attestations[0]!.identity,
        boundAt: BASE_NOW,
      },
      status: { ...running, acceptedAt: BASE_NOW },
      runStartedAt: BASE_NOW - 1_000,
      terminalObservedAt: BASE_NOW + 1_000,
      nowMs: BASE_NOW + 1_000,
      diagnosticCode: "worker_output_missing",
    })).toBeNull();
    store.close();
  });
});
