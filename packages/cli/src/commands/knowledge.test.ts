import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface TestKnowledgeStore {
  listKnowledge(options: { includeExpired: boolean; limit: number }): KnowledgeRow[];
}

describe("hachi knowledge", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("add → list → show を --json で操作できる", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(
      [
        "knowledge",
        "add",
        "--title",
        "handover",
        "--body",
        "session body",
        "--source",
        "session-handover",
        "--tags",
        "session,handover",
        "--importance",
        "75",
        "--json",
      ],
      { from: "user" },
    );

    const createPayload = JSON.parse(ctx.stdout.text()) as { id: string; knowledge: KnowledgeRow };
    const created = createPayload.knowledge;
    expect(createPayload.id).toBe(created.id);
    expect(createPayload).not.toHaveProperty("status");
    expect(created.id).toMatch(/^k_[0-9a-f]{12}$/);
    expect(created.source).toBe("session-handover");
    expect(created.tags).toEqual(["session", "handover"]);
    expect(created.importance).toBe(75);
    expect(created.provenance).toEqual({ kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["knowledge", "list", "--tag", "handover", "--json"], {
      from: "user",
    });
    const listPayload = JSON.parse(ctx.stdout.text()) as { knowledge: KnowledgeRow[] };
    expect(listPayload).not.toHaveProperty("id");
    expect(listPayload).not.toHaveProperty("status");
    const listed = listPayload.knowledge;
    expect(listed.map((row) => row.id)).toEqual([created.id]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["knowledge", "show", created.id, "--json"], { from: "user" });
    const showPayload = JSON.parse(ctx.stdout.text()) as { id: string; knowledge: KnowledgeRow };
    const shown = showPayload.knowledge;
    expect(showPayload.id).toBe(shown.id);
    expect(showPayload).not.toHaveProperty("status");
    expect(shown.body).toBe("session body");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["knowledge", "show", created.id], { from: "user" });
    expect(ctx.stdout.text()).toContain("provenance: kind=unknown actor_id=- session=- generation=-");
  });

  it("add はactive orchestrator provenanceを保存し、旧generationはrow 0で拒否する", async () => {
    ctx = createTestDeps();
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "knowledge", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    const args = [
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation),
    ];
    await buildProgram(ctx.deps).parseAsync([
      "knowledge", "add", "--title", "structured", "--body", "structured body", ...args, "--json",
    ], { from: "user" });
    const created = (JSON.parse(ctx.stdout.text()) as { knowledge: KnowledgeRow }).knowledge;
    expect(created.provenance).toEqual({
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    });

    ctx.exitCodes.length = 0;
    ctx.stderr.clear();
    await buildProgram(ctx.deps).parseAsync([
      "knowledge", "add", "--title", "stale", "--body", "stale body",
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation + 1),
    ], { from: "user" });
    expect(ctx.exitCodes).toEqual([1]);
    expect((ctx.deps.store as unknown as TestKnowledgeStore)
      .listKnowledge({ includeExpired: true, limit: 10 })).toHaveLength(1);
  });

  it("add/ingest helpはhuman/orchestratorだけを公開しserviceを拒否する", async () => {
    ctx = createTestDeps();
    for (const command of ["add", "ingest-sessions"]) {
      ctx.stdout.clear();
      await expect(buildProgram(ctx.deps).parseAsync(["knowledge", command, "--help"], { from: "user" }))
        .rejects.toMatchObject({ code: "commander.helpDisplayed" });
      expect(ctx.stdout.text()).toContain("--actor-kind <kind>");
      expect(ctx.stdout.text()).toContain('(choices: "human", "orchestrator")');
      expect(ctx.stdout.text()).not.toContain("service");
    }
  });

  it("ingest-sessions は markdown fixture を冪等に取り込む", async () => {
    ctx = createTestDeps();
    const dir = join(ctx.deps.env.home, "fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "with-frontmatter.md"),
      [
        "---",
        "type: session-handover",
        "created: 2026-07-07T09:00:00+09:00",
        "topic: セッション引き継ぎ",
        "importance: 90",
        "expires_at: 2099-01-01T00:00:00Z",
        "tags:",
        "  - session",
        "  - handover",
        "---",
        "本文です。",
      ].join("\n"),
    );
    writeFileSync(join(dir, "no-frontmatter.md"), ["# 見出しタイトル", "", "frontmatter なし本文"].join("\n"));

    await buildProgram(ctx.deps).parseAsync(["knowledge", "ingest-sessions", "--dir", dir, "--json"], {
      from: "user",
    });
    const first = JSON.parse(ctx.stdout.text()) as {
      summary: { added: number; skipped: number; failed: number };
    };
    expect(first.summary).toMatchObject({ added: 2, skipped: 0, failed: 0 });

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["knowledge", "ingest-sessions", "--dir", dir, "--json"], {
      from: "user",
    });
    const second = JSON.parse(ctx.stdout.text()) as {
      summary: { added: number; skipped: number; failed: number };
    };
    expect(second.summary).toMatchObject({ added: 0, skipped: 2, failed: 0 });

    const rows = (ctx.deps.store as unknown as TestKnowledgeStore)
      .listKnowledge({ includeExpired: true, limit: 10 })
      .sort((a, b) => a.title.localeCompare(b.title));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source)).toEqual(["session-handover", "session-handover"]);
    expect(rows.map((row) => row.originPath).every((path) => path.startsWith(dir))).toBe(true);
  });

  it("ingest-sessions は明示principalを全新規rowへ一貫適用する", async () => {
    ctx = createTestDeps();
    const dir = join(ctx.deps.env.home, "structured-fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "one.md"), "# one\n\nbody one");
    writeFileSync(join(dir, "two.md"), "# two\n\nbody two");
    const orchestrator = ctx.deps.store.registerOrchestrator({ label: "ingest", project: "dev", repoCommonDir: "" });
    const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    await buildProgram(ctx.deps).parseAsync([
      "knowledge", "ingest-sessions", "--dir", dir,
      "--actor-kind", "orchestrator", "--orchestrator", orchestrator.id,
      "--session", session.id, "--generation", String(session.generation), "--json",
    ], { from: "user" });

    const rows = (ctx.deps.store as unknown as TestKnowledgeStore)
      .listKnowledge({ includeExpired: true, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => (
      row.provenance.kind === "orchestrator" &&
      row.provenance.actorId === orchestrator.id &&
      row.provenance.actorSessionId === session.id &&
      row.provenance.actorGeneration === session.generation
    ))).toBe(true);
  });
});
