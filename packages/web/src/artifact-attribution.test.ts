import { describe, expect, it } from "vitest";
import type { EventRow, RunRow } from "@hachi/core";
import { resolveArtifactAttribution, type ArtifactStat } from "./artifact-attribution.js";

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    taskId: "t_artifact",
    provider: "codex",
    sessionId: "session-one",
    status: "done",
    meta: '{"role":"worker"}',
    startedAt: 100,
    endedAt: 200,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    taskId: "t_artifact",
    eventType: "artifact_attached",
    actor: "worker",
    payload: JSON.stringify({ name: "artifact.txt", runId: 1, sessionId: "session-one" }),
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 150,
    ...overrides,
  };
}

function stats(values: Record<string, ArtifactStat>): ReadonlyMap<string, ArtifactStat> {
  return new Map(Object.entries(values));
}

describe("resolveArtifactAttribution", () => {
  it("event-run を filename-session と interval より優先する", () => {
    const name = "transcript-filename-session-abcdef12.txt";
    const runs = [
      makeRun({ id: 1, sessionId: "event-session", meta: '{"role":"rework"}' }),
      makeRun({ id: 2, sessionId: "filename-session", startedAt: 140, endedAt: 190 }),
    ];
    const event = makeEvent({
      payload: JSON.stringify({ name, runId: 1, sessionId: "event-session" }),
      createdAt: 160,
    });

    expect(resolveArtifactAttribution({
      names: [name],
      stats: stats({ [name]: { sizeBytes: 12, mtimeMs: 155_000 } }),
      events: [event],
      runs,
      now: 300,
    })[0]).toMatchObject({
      attachedAt: 160,
      attachedAtSource: "event",
      runId: 1,
      sessionId: "event-session",
      role: "rework",
      attributionSource: "event-run",
    });
  });

  it("event に run 情報が無い場合は filename-session を interval より優先する", () => {
    const name = "prompt-filename-session-abcdef12.txt";
    const event = makeEvent({
      payload: JSON.stringify({ name, runId: null, sessionId: null }),
      createdAt: 160,
    });
    const runs = [
      makeRun({ id: 1, sessionId: "filename-session", meta: '{"role":"reviewer"}' }),
      makeRun({ id: 2, sessionId: "interval-session", startedAt: 150, endedAt: 170 }),
    ];

    expect(resolveArtifactAttribution({
      names: [name],
      stats: stats({ [name]: { sizeBytes: 8, mtimeMs: 155_000 } }),
      events: [event],
      runs,
      now: 300,
    })[0]).toMatchObject({
      attachedAt: 160,
      attachedAtSource: "event",
      runId: 1,
      role: "reviewer",
      attributionSource: "filename-session",
    });
  });

  it("filename に一致が無ければ attachedAt を含む開始時刻が最も遅い run へ帰属する", () => {
    const name = "screen.PNG";
    const runs = [
      makeRun({ id: 1, sessionId: "older", startedAt: 100, endedAt: 200 }),
      makeRun({ id: 2, sessionId: "newer", startedAt: 140, endedAt: 180 }),
    ];

    expect(resolveArtifactAttribution({
      names: [name],
      stats: stats({ [name]: { sizeBytes: 20, mtimeMs: 150_999 } }),
      events: [],
      runs,
      now: 300,
    })[0]).toMatchObject({
      kind: "image",
      attachedAt: 150,
      attachedAtSource: "mtime",
      runId: 2,
      sessionId: "newer",
      attributionSource: "interval",
    });
  });

  it("prompt-review と prompt-rework<N> の nonce は sessionId として扱わない", () => {
    const names = ["prompt-review-nonce-abcdef12.txt", "prompt-rework2-nonce-abcdef12.txt"];
    const result = resolveArtifactAttribution({
      names,
      stats: stats({
        "prompt-review-nonce-abcdef12.txt": { sizeBytes: 1, mtimeMs: 300_000 },
        "prompt-rework2-nonce-abcdef12.txt": { sizeBytes: 1, mtimeMs: 300_000 },
      }),
      events: [],
      runs: [
        makeRun({ id: 1, sessionId: "review-nonce", startedAt: 100, endedAt: 200 }),
        makeRun({ id: 2, sessionId: "rework2-nonce", startedAt: 100, endedAt: 200 }),
      ],
      now: 400,
    });

    expect(result.map((entry) => entry.attributionSource)).toEqual(["none", "none"]);
  });

  it("複数の同名 event は createdAt と id が最新のものだけを使う", () => {
    const older = makeEvent({ id: 10, createdAt: 150 });
    const newer = makeEvent({
      id: 11,
      createdAt: 160,
      payload: JSON.stringify({ name: "artifact.txt", runId: 2, sessionId: "session-two" }),
    });

    expect(resolveArtifactAttribution({
      names: ["artifact.txt"],
      stats: stats({ "artifact.txt": { sizeBytes: 4, mtimeMs: 140_000 } }),
      events: [newer, older],
      runs: [makeRun(), makeRun({ id: 2, sessionId: "session-two" })],
      now: 300,
    })[0]).toMatchObject({ attachedAt: 160, runId: 2, sessionId: "session-two" });
  });

  it("区間境界を含み、endedAt=null は now を終端として扱う", () => {
    const runs = [makeRun({ id: 5, sessionId: "open", startedAt: 100, endedAt: null })];
    const names = ["at-start.txt", "at-now.txt", "after-now.txt"];
    const result = resolveArtifactAttribution({
      names,
      stats: stats({
        "at-start.txt": { sizeBytes: 1, mtimeMs: 100_000 },
        "at-now.txt": { sizeBytes: 1, mtimeMs: 200_000 },
        "after-now.txt": { sizeBytes: 1, mtimeMs: 201_000 },
      }),
      events: [],
      runs,
      now: 200,
    });

    expect(result.find((entry) => entry.name === "at-start.txt")).toMatchObject({ runId: 5, attributionSource: "interval" });
    expect(result.find((entry) => entry.name === "at-now.txt")).toMatchObject({ runId: 5, attributionSource: "interval" });
    expect(result.at(-1)).toMatchObject({ name: "after-now.txt", runId: null, attributionSource: "none" });
  });

  it("帰属不能と stat 失敗は none とし、orchestrator/human の run 外 role と none の末尾配置を保つ", () => {
    const event = makeEvent({
      payload: JSON.stringify({ name: "manual.txt", runId: null, sessionId: null }),
      provenance: { kind: "human", actorId: "human", actorSessionId: "", actorGeneration: null },
      createdAt: 500,
    });
    const result = resolveArtifactAttribution({
      names: ["manual.txt", "missing-stat.txt", "inside.txt"],
      stats: stats({
        "manual.txt": { sizeBytes: 2, mtimeMs: 500_000 },
        "inside.txt": { sizeBytes: 3, mtimeMs: 150_000 },
      }),
      events: [event],
      runs: [makeRun()],
      now: 600,
    });

    expect(result[0]).toMatchObject({ name: "inside.txt", attributionSource: "interval" });
    expect(result[1]).toMatchObject({
      name: "manual.txt",
      attachedAt: 500,
      attachedAtSource: "event",
      role: "human",
      attributionSource: "none",
    });
    expect(result[2]).toMatchObject({
      name: "missing-stat.txt",
      sizeBytes: null,
      attachedAt: null,
      attachedAtSource: "mtime",
      role: "unknown",
      attributionSource: "none",
    });
  });
});
