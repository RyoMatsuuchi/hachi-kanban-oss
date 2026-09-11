import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { ActorProvenance } from "./types.js";

function registerPrincipal(store: SqliteKanbanStore, label = "audit"): ActorProvenance {
  const orchestrator = store.registerOrchestrator({ label, project: "hachi-kanban", repoCommonDir: "" });
  const session = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  return {
    kind: "orchestrator",
    actorId: orchestrator.id,
    actorSessionId: session.id,
    actorGeneration: session.generation,
  };
}

describe("board audit store (migration v18)", () => {
  const stores: SqliteKanbanStore[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("active exact orchestratorだけがredact済み監査eventを追加できる", () => {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    const principal = registerPrincipal(store);

    store.assertActiveOrchestratorPrincipal(principal);
    const event = store.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: {
        version: "steward-enable.v1",
        outcome: "changed",
        secret: "Bearer abcdef123456",
      },
      provenance: principal,
    });

    expect(event.eventType).toBe("steward_enabled");
    expect(event.payload).toEqual({
      version: "steward-enable.v1",
      outcome: "changed",
      secret: "[REDACTED]",
    });
    expect(event.provenance).toEqual(principal);
    expect(store.listBoardAuditEvents()).toEqual([event]);
  });

  it("旧generation・別identity・closed session・非orchestratorをmutation 0で拒否する", () => {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    const principal = registerPrincipal(store, "primary");
    const other = registerPrincipal(store, "other");
    const candidates: ActorProvenance[] = [
      { ...principal, actorGeneration: principal.actorGeneration! + 1 },
      { ...principal, actorId: other.actorId },
      { kind: "human", actorId: "human", actorSessionId: "", actorGeneration: null },
      { kind: "service", actorId: "supervisor", actorSessionId: "", actorGeneration: null },
      { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    ];
    for (const candidate of candidates) {
      expect(() => store.assertActiveOrchestratorPrincipal(candidate)).toThrow();
      expect(() => store.addBoardAuditEvent({
        eventType: "steward_enabled",
        actor: "orchestrator",
        payload: { outcome: "changed" },
        provenance: candidate,
      })).toThrow();
    }
    store.closeOrchestratorSession(principal.actorSessionId, principal.actorGeneration!);
    expect(() => store.assertActiveOrchestratorPrincipal(principal)).toThrow();
    expect(store.listBoardAuditEvents()).toHaveLength(0);
  });

  it("status=activeでもheartbeatがstaleなら拒否する", () => {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    const principal = registerPrincipal(store);
    store.heartbeatOrchestratorSession(principal.actorSessionId, principal.actorGeneration!, 1);

    expect(() => store.assertActiveOrchestratorPrincipal(principal)).toThrow(/fresh active/);
    expect(() => store.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: { outcome: "changed" },
      provenance: principal,
    })).toThrow(/fresh active/);
    expect(store.listBoardAuditEvents()).toHaveLength(0);
  });

  it("event/actor/payload/limitをboundedに検証し、時系列順で列挙する", () => {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    const principal = registerPrincipal(store);
    expect(() => store.addBoardAuditEvent({
      eventType: "Bad Event",
      actor: "orchestrator",
      payload: {},
      provenance: principal,
    })).toThrow(/eventType/);
    expect(() => store.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "bad actor",
      payload: {},
      provenance: principal,
    })).toThrow(/actor/);
    expect(() => store.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: { text: "x".repeat(5_000) },
      provenance: principal,
    })).toThrow(/4096/);

    const first = store.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: { seq: 1 },
      provenance: principal,
    });
    const second = store.addBoardAuditEvent({
      eventType: "other_event",
      actor: "orchestrator",
      payload: { seq: 2 },
      provenance: principal,
    });
    expect(store.listBoardAuditEvents(undefined, 1)).toEqual([second]);
    expect(store.listBoardAuditEvents("steward_enabled")).toEqual([first]);
    expect(() => store.listBoardAuditEvents(undefined, 0)).toThrow(/1〜1000/);
  });

  it("同じeventType/operationIdの監査eventをDB制約で重複拒否する", () => {
    const store = new SqliteKanbanStore(":memory:");
    stores.push(store);
    const principal = registerPrincipal(store);
    const input = {
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: { operationId: "op_0123456789abcdef0123456789abcdef", outcome: "changed" },
      provenance: principal,
    };
    store.addBoardAuditEvent(input);
    expect(() => store.addBoardAuditEvent(input)).toThrow(/UNIQUE/);
    expect(store.listBoardAuditEvents()).toHaveLength(1);
  });

  it("v18記録済みでもtable実体欠落を起動時に自己修復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-board-audit-"));
    dirs.push(dir);
    const dbPath = join(dir, "kanban.db");
    const first = new SqliteKanbanStore(dbPath);
    first.close();

    const db = new Database(dbPath);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 18").get()).toBeDefined();
    db.exec("DROP TABLE board_audit_events");
    db.close();

    const reopened = new SqliteKanbanStore(dbPath);
    stores.push(reopened);
    const principal = registerPrincipal(reopened);
    expect(() => reopened.addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: { outcome: "no-state" },
      provenance: principal,
    })).not.toThrow();
  });
});
