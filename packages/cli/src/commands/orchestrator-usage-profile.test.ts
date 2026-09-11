import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_USAGE_PROFILE_REF } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

const CLAUDE_SESSION_ID = "199a85b5-5975-4998-8dc0-9f4d4d29508c";

describe("hachi orchestrator usage-profile refresh", () => {
  let ctx: TestDeps;
  const tempDirs: string[] = [];

  afterEach(() => {
    ctx.cleanup();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transcript fixture から profile と boot sample を upsert する", async () => {
    ctx = createTestDeps();
    ctx.deps.config.orchestrator = { sessionBudget: { costModel: { minTurns: 15, profileSessions: 50 } } };
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "self",
      project: "hachi",
      repoCommonDir: "/tmp/repo",
    });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: CLAUDE_SESSION_ID,
    });
    const root = mkdtempSync(join(tmpdir(), "hachi-usage-profile-cli-"));
    tempDirs.push(root);
    const projectsRoot = join(root, "projects");
    const transcriptPath = join(projectsRoot, "-Users-someone-worktrees-example", `${CLAUDE_SESSION_ID}.jsonl`);
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    const rows = Array.from({ length: 15 }, (_, index) => {
      const cacheCreation = index === 1 ? 40_000 : 0;
      return {
        parentUuid: null,
        isSidechain: false,
        type: "assistant",
        uuid: `uuid-${index}`,
        requestId: `req_${index}`,
        timestamp: new Date(Date.UTC(2026, 8, 1, 0, index, 0)).toISOString(),
        effort: "high",
        message: {
          id: `msg_${index}`,
          model: "claude-opus-5",
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: cacheCreation,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: cacheCreation,
            },
          },
        },
      };
    });
    writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    ctx.deps.nativeUsageRoots = { claudeProjectsRoot: projectsRoot };

    await buildProgram(ctx.deps).parseAsync(["orchestrator", "usage-profile", "refresh", "--json"], { from: "user" });

    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      selectedSessions: 1,
      collectedSessions: 1,
      skippedSessions: [],
      minTurns: 15,
      profilesUpserted: 1,
      bootSamplesUpserted: 1,
    });
    expect(ctx.deps.store.listSessionUsageProfiles()).toEqual([expect.objectContaining({
      provider: "claude",
      model: "claude-opus-5",
      effort: "high",
      turns: 15,
      measured: true,
      cacheWrite5mPerTurn: 0,
      cacheWrite1hPerTurn: 40_000 / 15,
      reasoningPerTurn: null,
      sourceSessionIds: [CLAUDE_SESSION_ID],
      computedFromRef: SESSION_USAGE_PROFILE_REF,
    })]);
    expect(ctx.deps.store.listSessionBootSamples({ orchestratorId: orchestrator.id })).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        providerSessionId: CLAUDE_SESSION_ID,
        model: "claude-opus-5",
        contextAtTurn15: 1,
        bootOverheadUsd: 0.38,
        provenance: `${SESSION_USAGE_PROFILE_REF};priceSource=table;writePrice=cacheCreation1h`,
      }),
    ]);
  });
});
