import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import type { HalfOpenOutboxRow } from "./types.js";

const BASE_NOW = 1_800_000_000;

describe("half-open claim outbox（contract §40.1.1）", () => {
  let root: string;
  let dbPath: string;
  let store: SqliteKanbanStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hachi-half-open-outbox-"));
    dbPath = join(root, "kanban.db");
    store = new SqliteKanbanStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** steward stage の配送予定を 1 件積む */
  function enqueue(dedupeKey: string, claimGeneration = 1, now = BASE_NOW): HalfOpenOutboxRow {
    const result = store.enqueueHalfOpenOutbox({
      stage: "steward",
      claimGeneration,
      dedupeKey,
      kind: "steward_summary",
      payload: JSON.stringify({ title: "half-open", dedupeKey }),
      now,
    });
    expect(result.outcome).toBe("created");
    return result.row;
  }

  it("enqueue した行が listPending に出る", () => {
    const row = enqueue("steward:gen1:summary");

    expect(row.stage).toBe("steward");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.sentTransports).toEqual([]);
    expect(row.createdAt).toBe(BASE_NOW);

    const pending = store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW });
    expect(pending.map((entry) => entry.id)).toEqual([row.id]);
    // 別 stage には出ない
    expect(store.listPendingHalfOpenOutbox({ stage: "brief", now: BASE_NOW })).toEqual([]);
  });

  it("同じ dedupe_key は duplicate で既存行を返す", () => {
    const first = enqueue("steward:gen1:summary");
    const second = store.enqueueHalfOpenOutbox({
      stage: "steward",
      claimGeneration: 2,
      dedupeKey: "steward:gen1:summary",
      kind: "steward_summary",
      payload: JSON.stringify({ title: "second" }),
      now: BASE_NOW + 10,
    });

    expect(second.outcome).toBe("duplicate");
    expect(second.row).toEqual(first);
    expect(store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW + 10 })).toHaveLength(1);
  });

  it("failed は attempts+1 と未来の next_attempt_at になり、now を進めると再び出る", () => {
    const row = enqueue("steward:gen1:summary");

    const failed = store.markHalfOpenOutbox({ id: row.id, result: "failed", now: BASE_NOW + 5 });
    expect(failed).not.toBeNull();
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    // retryAfterSec 既定 60 秒
    expect(failed?.nextAttemptAt).toBe(BASE_NOW + 65);

    expect(store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW + 64 })).toEqual([]);
    const due = store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW + 65 });
    expect(due.map((entry) => entry.id)).toEqual([row.id]);

    // retryAfterSec 指定と attempts の累積
    const failedAgain = store.markHalfOpenOutbox({ id: row.id, result: "failed", retryAfterSec: 300, now: BASE_NOW + 65 });
    expect(failedAgain?.attempts).toBe(2);
    expect(failedAgain?.nextAttemptAt).toBe(BASE_NOW + 365);
  });

  it("sent 後は listPending に出ず、以後 mark しても変わらない", () => {
    const row = enqueue("steward:gen1:summary");

    const sent = store.markHalfOpenOutbox({
      id: row.id,
      result: "sent",
      sentTransports: ["telegram", "telegram", "slack"],
      now: BASE_NOW + 5,
    });
    expect(sent?.status).toBe("sent");
    expect(sent?.nextAttemptAt).toBeNull();
    expect(sent?.attempts).toBe(0);
    expect(sent?.sentTransports).toEqual(["telegram", "slack"]);
    expect(store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW + 1_000_000 })).toEqual([]);

    // 終端行への failed は無視され現在行がそのまま返る
    const unchanged = store.markHalfOpenOutbox({ id: row.id, result: "failed", now: BASE_NOW + 10 });
    expect(unchanged).toEqual(sent);
    // 存在しない id は null
    expect(store.markHalfOpenOutbox({ id: "hoo_missing", result: "sent" })).toBeNull();
  });

  it("discardStale は旧世代の pending|failed だけを discarded にし新世代を残す", () => {
    const oldPending = enqueue("steward:gen1:a", 1, BASE_NOW);
    const oldFailed = enqueue("steward:gen1:b", 1, BASE_NOW + 1);
    store.markHalfOpenOutbox({ id: oldFailed.id, result: "failed", now: BASE_NOW + 2 });
    const oldSent = enqueue("steward:gen1:c", 1, BASE_NOW + 3);
    store.markHalfOpenOutbox({ id: oldSent.id, result: "sent", now: BASE_NOW + 4 });
    const current = enqueue("steward:gen2:a", 2, BASE_NOW + 5);
    // 別 stage の旧世代は対象外
    const briefOld = store.enqueueHalfOpenOutbox({
      stage: "brief",
      claimGeneration: 1,
      dedupeKey: "brief:gen1:a",
      kind: "brief",
      payload: "{}",
      now: BASE_NOW + 6,
    });

    const discarded = store.discardStaleHalfOpenOutbox({ stage: "steward", currentGeneration: 2, now: BASE_NOW + 10 });
    expect(discarded).toBe(2);

    const remaining = store.listPendingHalfOpenOutbox({ stage: "steward", now: BASE_NOW + 1_000_000 });
    expect(remaining.map((entry) => entry.id)).toEqual([current.id]);
    expect(store.listPendingHalfOpenOutbox({ stage: "brief", now: BASE_NOW + 10 }).map((entry) => entry.id)).toEqual([
      briefOld.row.id,
    ]);

    // discarded 行は mark しても状態が変わらない
    const stale = store.markHalfOpenOutbox({ id: oldPending.id, result: "sent", now: BASE_NOW + 20 });
    expect(stale?.status).toBe("discarded");
    expect(stale?.updatedAt).toBe(BASE_NOW + 10);
    // sent 済みの旧世代は discarded にならない
    expect(store.markHalfOpenOutbox({ id: oldSent.id, result: "failed" })?.status).toBe("sent");
  });
});
