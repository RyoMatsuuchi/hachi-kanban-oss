import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { ActorProvenance, OrchestratorRow, OrchestratorSessionRow, TaskRow } from "./types.js";

const UNKNOWN: ActorProvenance = {
  kind: "unknown",
  actorId: "",
  actorSessionId: "",
  actorGeneration: null,
};

describe("actor provenance", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function createTask(store: SqliteKanbanStore, status: "triage" | "todo" | "ready" = "triage"): TaskRow {
    return store.createTask({ title: "監査対象", body: "cwd: /tmp/a", tenant: "dev", status }, "legacy");
  }

  function createAuthority(store: SqliteKanbanStore, label: string): {
    orchestrator: OrchestratorRow;
    session: OrchestratorSessionRow;
    provenance: ActorProvenance;
  } {
    const orchestrator = store.registerOrchestrator({ label, project: "dev", repoCommonDir: "/tmp/repo" });
    const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    return {
      orchestrator,
      session,
      provenance: {
        kind: "orchestrator",
        actorId: orchestrator.id,
        actorSessionId: session.id,
        actorGeneration: session.generation,
      },
    };
  }

  it("migration v16 は既存行を unknown のまま保ち、部分欠落を冪等に自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-actor-provenance-"));
    cleanupPaths.push(dir);
    const dbPath = join(dir, "kanban.db");
    const initial = new SqliteKanbanStore(dbPath);
    const task = createTask(initial);
    initial.addComment(task.id, "legacy-author", "legacy comment");
    initial.close();

    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE task_events DROP COLUMN actor_id");
    raw.exec("ALTER TABLE task_comments DROP COLUMN actor_session_id");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
    raw.close();

    const repaired = new SqliteKanbanStore(dbPath);
    expect(repaired.listEvents(task.id)[0]?.provenance).toEqual(UNKNOWN);
    expect(repaired.listComments(task.id)[0]?.provenance).toEqual(UNKNOWN);
    repaired.close();

    const check = new Database(dbPath);
    for (const tableName of ["task_events", "task_comments"]) {
      const columns = check.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["actor_kind", "actor_id", "actor_session_id", "actor_generation"]),
      );
    }
    expect(check.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16").get()).toEqual({ count: 1 });
    expect(() => check.prepare(
      "INSERT INTO task_events (task_id, event_type, actor_kind, actor_generation, created_at) VALUES (?, 'bad', 'bogus', NULL, 1)",
    ).run(task.id)).toThrow();
    expect(() => check.prepare(
      "INSERT INTO task_comments (task_id, author, body, actor_generation, created_at) VALUES (?, 'x', 'x', 0, 1)",
    ).run(task.id)).toThrow();
    check.close();

    const idempotent = new SqliteKanbanStore(dbPath);
    idempotent.close();
  });

  it("migration v17 は既存knowledgeをunknownのまま保ち、部分欠落を冪等に自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-knowledge-provenance-"));
    cleanupPaths.push(dir);
    const dbPath = join(dir, "kanban.db");
    const initial = new SqliteKanbanStore(dbPath);
    const knowledge = initial.addKnowledge({ title: "legacy", body: "legacy knowledge" }, "legacy");
    initial.close();

    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE knowledge DROP COLUMN actor_id");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 17").run();
    raw.close();

    const repaired = new SqliteKanbanStore(dbPath);
    expect(repaired.getKnowledge(knowledge.id)?.provenance).toEqual(UNKNOWN);
    repaired.close();

    const check = new Database(dbPath);
    const columns = check.prepare("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["actor_kind", "actor_id", "actor_session_id", "actor_generation"]),
    );
    expect(check.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 17").get())
      .toEqual({ count: 1 });
    expect(() => check.prepare(
      "INSERT INTO knowledge (id,title,body,source,tags,content_hash,actor_kind,created_at,updated_at) VALUES ('k_aaaaaaaaaaaa','x','x','x','[]',?, 'bogus',1,1)",
    ).run("a".repeat(64))).toThrow();
    check.close();

    const idempotent = new SqliteKanbanStore(dbPath);
    idempotent.close();
  });

  it("legacy・provenance未指定は unknown、human/service は構造化値を返す", () => {
    const store = new SqliteKanbanStore(":memory:");
    const task = createTask(store);
    expect(store.listEvents(task.id)[0]?.provenance).toEqual(UNKNOWN);
    expect(store.addComment(task.id, "表示名", "legacy").provenance).toEqual(UNKNOWN);

    const human: ActorProvenance = {
      kind: "human",
      actorId: "local-user",
      actorSessionId: "",
      actorGeneration: null,
    };
    expect(store.addComment(task.id, "表示名", "human", human).provenance).toEqual(human);
    const service: ActorProvenance = {
      kind: "service",
      actorId: "unit-test-service",
      actorSessionId: "",
      actorGeneration: null,
    };
    expect(store.addEvent(task.id, "service_test", "service", {}, service).provenance).toEqual(service);
    expect(() => store.addEvent(task.id, "bad", "service", {}, { ...service, actorId: "" })).toThrow();
    expect(() => store.addEvent(task.id, "bad", "service", {}, { ...service, actorId: "unsafe name" })).toThrow();
    store.close();
  });

  it("read mapping はDBへ混入した不正なkind組合せを表示文字列から補完せず拒否する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-actor-mapping-"));
    cleanupPaths.push(dir);
    const dbPath = join(dir, "kanban.db");
    const store = new SqliteKanbanStore(dbPath);
    const task = createTask(store);
    store.close();

    const raw = new Database(dbPath);
    raw.prepare("UPDATE task_events SET actor_kind = 'service', actor_id = '' WHERE task_id = ?").run(task.id);
    raw.close();

    const reopened = new SqliteKanbanStore(dbPath);
    expect(() => reopened.listEvents(task.id)).toThrow(/service provenance/);
    reopened.close();
  });

  it("active session完全一致だけを許可し、旧generation・別identity・closed/stale/supersededを拒否する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const task = createTask(store);
    const active = createAuthority(store, "active");
    expect(store.addComment(task.id, "orch", "ok", active.provenance).provenance).toEqual(active.provenance);

    expect(() => store.addComment(task.id, "orch", "wrong generation", {
      ...active.provenance,
      actorGeneration: active.session.generation + 1,
    })).toThrow(/完全一致/);

    const other = createAuthority(store, "other");
    expect(() => store.addComment(task.id, "orch", "wrong identity", {
      ...active.provenance,
      actorId: other.orchestrator.id,
    })).toThrow(/完全一致/);

    const closed = createAuthority(store, "closed");
    store.closeOrchestratorSession(closed.session.id, closed.session.generation);
    expect(() => store.addComment(task.id, "orch", "closed", closed.provenance)).toThrow(/完全一致/);
    expect(() => store.setWatched(task.id, false, "orch", closed.provenance)).toThrow(/完全一致/);

    const stale = createAuthority(store, "stale");
    store.expireStaleOrchestratorSessions(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(() => store.addComment(task.id, "orch", "stale", stale.provenance)).toThrow(/完全一致/);

    const superseded = createAuthority(store, "superseded");
    store.prepareOrchestratorHandoff(
      superseded.session.id,
      superseded.session.generation,
      "a".repeat(64),
      Number.MAX_SAFE_INTEGER,
    );
    store.acceptOrchestratorHandoff({ oldSessionId: superseded.session.id, tokenHash: "a".repeat(64) });
    expect(() => store.addComment(task.id, "orch", "superseded", superseded.provenance)).toThrow(/完全一致/);
    store.close();
  });

  it("knowledgeはactive principalを保存し、duplicate no-opでもauthority検証して既存provenanceを書換えない", () => {
    const store = new SqliteKanbanStore(":memory:");
    const authority = createAuthority(store, "knowledge");
    const first = store.addKnowledge(
      { title: "first", body: "same knowledge body" },
      "orchestrator",
      authority.provenance,
    );
    expect(first.provenance).toEqual(authority.provenance);

    const duplicate = store.addKnowledge(
      { title: "second", body: "same knowledge body" },
      "human",
      { kind: "human", actorId: "local", actorSessionId: "", actorGeneration: null },
    );
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.title).toBe("first");
    expect(duplicate.actor).toBe("orchestrator");
    expect(duplicate.provenance).toEqual(authority.provenance);

    expect(() => store.addKnowledge(
      { title: "stale", body: "same knowledge body" },
      "orchestrator",
      { ...authority.provenance, actorGeneration: authority.session.generation + 1 },
    )).toThrow(/完全一致/);
    expect(store.listKnowledge({ includeExpired: true })).toHaveLength(1);
    store.close();
  });

  it("主要 task/admin mutation の全 event/comment へ provenance を伝搬する", () => {
    const store = new SqliteKanbanStore(":memory:");
    const authority = createAuthority(store, "mutations");
    const expectLatest = (taskId: string): void => {
      expect(store.listEvents(taskId).at(-1)?.provenance).toEqual(authority.provenance);
    };

    const moved = createTask(store);
    store.transition({ taskId: moved.id, to: "todo", actor: "orch", provenance: authority.provenance });
    expectLatest(moved.id);

    const commented = createTask(store);
    expect(store.addComment(commented.id, "orch", "comment", authority.provenance).provenance)
      .toEqual(authority.provenance);

    const blocked = createTask(store, "ready");
    store.block(blocked.id, "needs-manual: test", "orch", undefined, authority.provenance);
    expectLatest(blocked.id);
    store.unblock(blocked.id, "ready", "orch", authority.provenance);
    expectLatest(blocked.id);

    const userDecision = createTask(store, "ready");
    store.block(userDecision.id, "user-decision: choose", "legacy");
    store.unblock(userDecision.id, "ready", "orch", authority.provenance);
    expect(store.listEvents(userDecision.id).slice(-2).map((event) => event.provenance))
      .toEqual([authority.provenance, authority.provenance]);

    const watched = createTask(store);
    store.setWatched(watched.id, true, "orch", authority.provenance);
    expectLatest(watched.id);

    const edited = createTask(store);
    store.updateBody(edited.id, "cwd: /tmp/b", "orch", authority.provenance);
    expectLatest(edited.id);

    const overridden = createTask(store);
    store.bindTaskToOrchestrator(overridden.id, authority.orchestrator.id, "primary");
    store.setModelOverride(overridden.id, "gpt-5.6-sol", "orch", authority.provenance);
    expectLatest(overridden.id);
    store.setEffortOverride(overridden.id, "high", "orch", authority.provenance);
    expectLatest(overridden.id);
    store.close();
  });

  it("CAS後のauthority失敗はtask更新とprovenance行を同時にrollbackする", () => {
    const store = new SqliteKanbanStore(":memory:");
    const task = createTask(store, "ready");
    const authority = createAuthority(store, "rollback");
    store.closeOrchestratorSession(authority.session.id, authority.session.generation);
    const before = store.listEvents(task.id).length;

    expect(() => store.blockIfReadyUnclaimed(
      task.id,
      "needs-manual: rollback",
      "orch",
      undefined,
      authority.provenance,
    )).toThrow(/完全一致/);
    expect(store.getTask(task.id)?.status).toBe("ready");
    expect(store.listEvents(task.id)).toHaveLength(before);
    store.close();
  });
});
