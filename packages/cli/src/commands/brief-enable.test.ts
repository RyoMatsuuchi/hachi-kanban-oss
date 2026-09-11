import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStewardStateLock,
  type BoardAuditStore,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import {
  parseBriefStateStrict,
  prepareBriefEnable,
  writeBriefEnablePending,
  type BriefEnableState,
} from "../brief-enable.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

const DISABLED: BriefEnableState = {
  lastRunAt: 1_700_100_200,
  lastError: "Bearer super-secret-token",
  consecutiveFailures: 3,
  autoDisabled: true,
  autoDisabledReason: "連続3回失敗: sk-secret12345678",
  autoDisabledAt: 1_700_100_000,
  claimGeneration: 11,
};

function writeBriefStateFixture(home: string, state: BriefEnableState): void {
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "brief.json"), JSON.stringify(state), { mode: 0o600 });
}

function activeFlags(ctx: TestDeps): { flags: string[]; principal: {
  kind: "orchestrator";
  actorId: string;
  actorSessionId: string;
  actorGeneration: number;
} } {
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: "brief operator",
    project: "hachi-kanban",
    repoCommonDir: "",
  });
  const session = ctx.deps.store.startOrchestratorSession({ orchestratorId: orchestrator.id });
  return {
    flags: [
      "--actor-kind", "orchestrator",
      "--orchestrator", orchestrator.id,
      "--session", session.id,
      "--generation", String(session.generation),
    ],
    principal: {
      kind: "orchestrator",
      actorId: orchestrator.id,
      actorSessionId: session.id,
      actorGeneration: session.generation,
    },
  };
}

function auditStore(ctx: TestDeps): BoardAuditStore {
  return ctx.deps.store as unknown as BoardAuditStore;
}

describe("hachi admin brief-enable", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("既定dry-runはactive exact authorityを検証するがstate/eventを変更しない", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "brief.json");
    const before = readFileSync(path, "utf8");

    await buildProgram(ctx.deps).parseAsync(["admin", "brief-enable", ...flags, "--json"], { from: "user" });

    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      apply: false,
      result: { outcome: "changed", changed: true, lastRunAt: DISABLED.lastRunAt },
      auditEvent: null,
      killSwitchChanged: false,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
  });

  it("明示--applyは復帰5 fieldをresetしてgenerationを前進し、exact provenanceのbounded auditを残す", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const killSwitch = join(ctx.deps.env.home, "brief.disabled");
    writeFileSync(killSwitch, "keep");

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    const state = parseBriefStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "brief.json"), "utf8"),
    );
    expect(state).toEqual({
      ...DISABLED,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 12,
    });
    expect(readFileSync(killSwitch, "utf8")).toBe("keep");
    const events = auditStore(ctx).listBoardAuditEvents("brief_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "brief_enabled",
      actor: "orchestrator",
      payload: {
        version: "brief-enable.v1",
        outcome: "changed",
        changed: true,
        lastRunAt: DISABLED.lastRunAt,
      },
      provenance: principal,
    });
    expect(ctx.stdout.text()).not.toContain("super-secret-token");
    expect(ctx.stdout.text()).not.toContain("secret12345678");
  });

  it("autoDisabledAt を持たない既存stateも --apply で従来どおり復帰できる", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    const legacy = { ...DISABLED } as Partial<BriefEnableState>;
    delete legacy.autoDisabledAt;
    delete legacy.claimGeneration;
    const stateDir = join(ctx.deps.env.home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "brief.json"), JSON.stringify(legacy), { mode: 0o600 });

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    expect(parseBriefStateStrict(readFileSync(join(stateDir, "brief.json"), "utf8")))
      .toMatchObject({ autoDisabled: false, autoDisabledAt: 0, claimGeneration: 1 });
  });

  it("state未作成と既にenabledのapplyはidempotent no-op auditを残す", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(auditStore(ctx).listBoardAuditEvents()[0]?.payload["outcome"]).toBe("no-state");

    writeBriefStateFixture(ctx.deps.env.home, { ...DISABLED, autoDisabled: false });
    const path = join(ctx.deps.env.home, "state", "brief.json");
    const before = readFileSync(path, "utf8");
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents().map((event) => event.payload["outcome"]))
      .toEqual(["no-state", "already-enabled"]);
  });

  it("audit記録失敗時はstateをCAS rollbackしgenerationを巻き戻さない", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "brief.json");
    const store = ctx.deps.store as unknown as BoardAuditStore;
    store.addBoardAuditEvent = (): never => {
      throw new Error("injected audit failure");
    };

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(parseBriefStateStrict(readFileSync(path, "utf8"))).toEqual({
      ...DISABLED,
      claimGeneration: 12,
    });
    expect(existsSync(join(ctx.deps.env.home, "state", "brief-enable.pending.json"))).toBe(false);
  });

  it("authority不足と旧generationをfile/event mutation 0で拒否する", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "brief.json");
    const before = readFileSync(path, "utf8");
    const invalid = flags.map((value, index) => index === flags.length - 1
      ? String(principal.actorGeneration + 1)
      : value);

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...invalid],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
  });

  it("壊れたstateと共有lock競合をmutation/event 0で拒否する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    mkdirSync(join(ctx.deps.env.home, "state"), { recursive: true });
    const path = join(ctx.deps.env.home, "state", "brief.json");
    writeFileSync(path, "{");
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(readFileSync(path, "utf8")).toBe("{");

    ctx.stderr.clear();
    ctx.exitCodes.length = 0;
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "supervisor-brief");
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(ctx.exitCodes).toEqual([1]);
    expect(parseBriefStateStrict(readFileSync(path, "utf8"))).toEqual(DISABLED);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
    lock!.release();
  });

  it("v1 journalのstate rename後pendingを従来どおり冪等回収する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-brief-enable");
    const plan = prepareBriefEnable(ctx.deps.env.home);
    writeBriefEnablePending(ctx.deps.env.home, {
      version: "brief-enable-pending.v1",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    plan.apply();
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    const events = auditStore(ctx).listBoardAuditEvents("brief_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      operationId: lock!.operationId,
      outcome: "changed",
      recovered: true,
    });
    expect(existsSync(join(ctx.deps.env.home, "state", "brief-enable.pending.json"))).toBe(false);
  });

  it("補償rollback後/journal削除前のcrashを次回--applyで回収する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-brief-enable");
    const plan = prepareBriefEnable(ctx.deps.env.home);
    writeBriefEnablePending(ctx.deps.env.home, {
      version: "brief-enable-pending.v2",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      compensatedHash: plan.compensatedHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    const applied = plan.apply();
    expect(applied!.rollbackIfUnchanged()).toBe(true);
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );

    const state = parseBriefStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "brief.json"), "utf8"),
    );
    expect(state).toMatchObject({ autoDisabled: false, claimGeneration: 13 });
    const events = auditStore(ctx).listBoardAuditEvents("brief_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload["operationId"]).not.toBe(lock!.operationId);
    expect(events[0]?.payload["recovered"]).toBe(false);
    expect(existsSync(join(ctx.deps.env.home, "state", "brief-enable.pending.json"))).toBe(false);
  });

  it("v2 journalの3つのhashに一致しないstateは第三者更新として拒否する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeBriefStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-brief-enable");
    const plan = prepareBriefEnable(ctx.deps.env.home);
    writeBriefEnablePending(ctx.deps.env.home, {
      version: "brief-enable-pending.v2",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      compensatedHash: plan.compensatedHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    const thirdPartyState = { ...DISABLED, lastError: "third-party update", claimGeneration: 99 };
    writeFileSync(join(ctx.deps.env.home, "state", "brief.json"), JSON.stringify(thirdPartyState));
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "brief-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("stateが別更新されたため自動回収できません");
    expect(parseBriefStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "brief.json"), "utf8"),
    )).toEqual(thirdPartyState);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
    expect(existsSync(join(ctx.deps.env.home, "state", "brief-enable.pending.json"))).toBe(true);
  });

  it("helpはdry-run/applyとorchestrator principal flagsを公開する", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["admin", "brief-enable", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    const help = ctx.stdout.text();
    expect(help).toContain("--apply");
    expect(help).toContain("--actor-kind <kind>");
    expect(help).not.toContain("service");
    expect(help).not.toContain("unknown");
  });
});
