import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStewardStateLock,
  writeFileAtomic0600Durable,
  type BoardAuditStore,
} from "@hachi/core";
import { buildProgram } from "../program.js";
import {
  parseStewardStateStrict,
  prepareStewardEnable,
  writeStewardEnablePending,
  type StewardState,
} from "../steward-enable.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

const DISABLED: StewardState = {
  lastRunAt: 1_700_100_200,
  lastProposalCount: 9,
  lastAppliedCount: 2,
  lastProposedCount: 7,
  lastRequestedCount: 3,
  lastSuppressedCount: 1,
  lastArchivedByEvidence: {
    "not-observable:repo-root": 2,
    "clean-head-reachable": 1,
  },
  lastError: "Bearer super-secret-token",
  consecutiveFailures: 3,
  autoDisabled: true,
  autoDisabledReason: "連続3回失敗: sk-secret12345678",
  autoDisabledAt: 1_700_100_000,
  claimGeneration: 7,
};

function writeStewardStateFixture(home: string, state: StewardState): void {
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "steward.json"), JSON.stringify(state), { mode: 0o600 });
}

function activeFlags(ctx: TestDeps): { flags: string[]; principal: {
  kind: "orchestrator";
  actorId: string;
  actorSessionId: string;
  actorGeneration: number;
} } {
  const orchestrator = ctx.deps.store.registerOrchestrator({
    label: "steward operator",
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

describe("hachi admin steward-enable", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("既定dry-runはactive exact authorityを検証するがstate/eventを変更しない", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "steward.json");
    chmodSync(path, 0o640);
    const before = readFileSync(path, "utf8");

    await buildProgram(ctx.deps).parseAsync(["admin", "steward-enable", ...flags, "--json"], { from: "user" });

    const output = JSON.parse(ctx.stdout.text()) as {
      apply: boolean;
      result: { outcome: string; changed: boolean; lastRunAt: number };
      auditEvent: null;
      killSwitchChanged: boolean;
    };
    expect(output).toMatchObject({
      apply: false,
      result: { outcome: "changed", changed: true, lastRunAt: DISABLED.lastRunAt },
      auditEvent: null,
      killSwitchChanged: false,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("明示--applyは復帰5 fieldをresetしてgenerationを前進し、redacted bounded eventへprovenanceを残す", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const killSwitch = join(ctx.deps.env.home, "steward.disabled");
    writeFileSync(killSwitch, "keep");

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    const state = parseStewardStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "steward.json"), "utf8"),
    );
    expect(state).toEqual({
      ...DISABLED,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 8,
    });
    expect(readFileSync(killSwitch, "utf8")).toBe("keep");
    const events = auditStore(ctx).listBoardAuditEvents("steward_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: {
        version: "steward-enable.v1",
        outcome: "changed",
        changed: true,
        lastRunAt: DISABLED.lastRunAt,
      },
      provenance: principal,
    });
    const output = ctx.stdout.text();
    expect(output).not.toContain("super-secret-token");
    expect(output).not.toContain("secret12345678");
  });

  it("autoDisabledAt を持たない既存stateも --apply で従来どおり復帰できる", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    const legacy = { ...DISABLED } as Partial<StewardState>;
    delete legacy.autoDisabledAt;
    delete legacy.claimGeneration;
    const stateDir = join(ctx.deps.env.home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "steward.json"), JSON.stringify(legacy), { mode: 0o600 });

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    expect(parseStewardStateStrict(readFileSync(join(stateDir, "steward.json"), "utf8")))
      .toMatchObject({ autoDisabled: false, autoDisabledAt: 0, claimGeneration: 1 });
  });

  it("state未作成/既にenabledの--applyもidempotent no-op eventを残す", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(auditStore(ctx).listBoardAuditEvents()[0]?.payload["outcome"]).toBe("no-state");

    ctx.stdout.clear();
    writeStewardStateFixture(ctx.deps.env.home, { ...DISABLED, autoDisabled: false });
    const path = join(ctx.deps.env.home, "state", "steward.json");
    const before = readFileSync(path, "utf8");
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents().map((event) => event.payload["outcome"]))
      .toEqual(["no-state", "already-enabled"]);
  });

  it("human/flag不足/旧generation/closed sessionをfile/event mutation 0で拒否する", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "steward.json");
    const before = readFileSync(path, "utf8");
    const invalidArgs = [
      ["--actor-kind", "human"],
      ["--actor-kind", "orchestrator", "--orchestrator", principal.actorId],
      flags.map((value, index) => index === flags.length - 1 ? String(principal.actorGeneration + 1) : value),
    ];
    for (const invalid of invalidArgs) {
      ctx.stderr.clear();
      await buildProgram(ctx.deps).parseAsync(
        ["admin", "steward-enable", "--apply", ...invalid],
        { from: "user" },
      );
      expect(ctx.exitCodes.at(-1)).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
    }

    ctx.deps.store.closeOrchestratorSession(principal.actorSessionId, principal.actorGeneration);
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
  });

  it("壊れたJSON・symlinkはauthority成功後もmutation/event 0で拒否する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    mkdirSync(join(ctx.deps.env.home, "state"), { recursive: true });
    const path = join(ctx.deps.env.home, "state", "steward.json");
    writeFileSync(path, "{");
    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );
    expect(ctx.exitCodes.at(-1)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{");
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
  });

  it("audit INSERT失敗時はstateをrollbackしgenerationを巻き戻さない", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "steward.json");
    chmodSync(path, 0o640);
    const store = ctx.deps.store as unknown as BoardAuditStore;
    store.addBoardAuditEvent = (): never => {
      throw new Error("injected audit failure");
    };

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("injected audit failure");
    expect(parseStewardStateStrict(readFileSync(path, "utf8"))).toEqual({
      ...DISABLED,
      claimGeneration: 8,
    });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(false);
  });

  it("audit失敗前にstateが別更新された場合はCAS rollbackせずpendingを保持する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "steward.json");
    const concurrent = { ...DISABLED, lastRunAt: DISABLED.lastRunAt + 99, lastError: "new failure" };
    const store = ctx.deps.store as unknown as BoardAuditStore;
    store.addBoardAuditEvent = (): never => {
      // shared lockを無視する外部破損writerを模擬。CAS rollbackがこの内容を上書きしてはならない。
      writeFileSync(path, JSON.stringify(concurrent));
      throw new Error("injected audit failure after concurrent write");
    };

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("rollbackしませんでした");
    expect(parseStewardStateStrict(readFileSync(path, "utf8"))).toEqual(concurrent);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(true);
  });

  it("同じ内容でもpost-write inodeが置換された場合はrollbackしない", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const path = join(ctx.deps.env.home, "state", "steward.json");
    const store = ctx.deps.store as unknown as BoardAuditStore;
    store.addBoardAuditEvent = (): never => {
      const enabledRaw = readFileSync(path, "utf8");
      writeFileAtomic0600Durable(path, enabledRaw);
      throw new Error("injected audit failure after same-content replacement");
    };

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("rollbackしませんでした");
    expect(parseStewardStateStrict(readFileSync(path, "utf8")).autoDisabled).toBe(false);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(true);
  });

  it("v1 journalのstate rename後/audit前crashを従来どおり回収する", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-steward-enable");
    expect(lock).not.toBeNull();
    const plan = prepareStewardEnable(ctx.deps.env.home);
    writeStewardEnablePending(ctx.deps.env.home, {
      version: "steward-enable-pending.v1",
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
      ["admin", "steward-enable", "--apply", ...flags, "--json"],
      { from: "user" },
    );

    const events = auditStore(ctx).listBoardAuditEvents("steward_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      operationId: lock!.operationId,
      outcome: "changed",
      recovered: true,
    });
    expect(events[0]?.provenance).toEqual(principal);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(false);
  });

  it("補償rollback後/journal削除前のcrashを次回--applyで回収する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-steward-enable");
    const plan = prepareStewardEnable(ctx.deps.env.home);
    writeStewardEnablePending(ctx.deps.env.home, {
      version: "steward-enable-pending.v2",
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
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    const state = parseStewardStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "steward.json"), "utf8"),
    );
    expect(state).toMatchObject({ autoDisabled: false, claimGeneration: 9 });
    const events = auditStore(ctx).listBoardAuditEvents("steward_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload["operationId"]).not.toBe(lock!.operationId);
    expect(events[0]?.payload["recovered"]).toBe(false);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(false);
  });

  it("v2 journalの3つのhashに一致しないstateは第三者更新として拒否する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-steward-enable");
    const plan = prepareStewardEnable(ctx.deps.env.home);
    writeStewardEnablePending(ctx.deps.env.home, {
      version: "steward-enable-pending.v2",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      compensatedHash: plan.compensatedHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    const thirdPartyState = { ...DISABLED, lastError: "third-party update", claimGeneration: 99 };
    writeFileSync(join(ctx.deps.env.home, "state", "steward.json"), JSON.stringify(thirdPartyState));
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("stateが別更新されたため自動回収できません");
    expect(parseStewardStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "steward.json"), "utf8"),
    )).toEqual(thirdPartyState);
    expect(auditStore(ctx).listBoardAuditEvents()).toHaveLength(0);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(true);
  });

  it("journal fsync後/state rename前のcrashはpendingを破棄して通常applyを再実行する", async () => {
    ctx = createTestDeps();
    const { flags } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-steward-enable");
    const plan = prepareStewardEnable(ctx.deps.env.home);
    writeStewardEnablePending(ctx.deps.env.home, {
      version: "steward-enable-pending.v1",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    const state = parseStewardStateStrict(
      readFileSync(join(ctx.deps.env.home, "state", "steward.json"), "utf8"),
    );
    expect(state.autoDisabled).toBe(false);
    const events = auditStore(ctx).listBoardAuditEvents("steward_enabled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload["operationId"]).not.toBe(lock!.operationId);
    expect(events[0]?.payload["recovered"]).toBe(false);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(false);
  });

  it("audit後/journal削除前のcrashはoperationIdで重複eventを作らず回収する", async () => {
    ctx = createTestDeps();
    const { flags, principal } = activeFlags(ctx);
    writeStewardStateFixture(ctx.deps.env.home, DISABLED);
    const lock = acquireStewardStateLock(ctx.deps.env.home, "cli-steward-enable");
    const plan = prepareStewardEnable(ctx.deps.env.home);
    writeStewardEnablePending(ctx.deps.env.home, {
      version: "steward-enable-pending.v1",
      operationId: lock!.operationId,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      outcome: "changed",
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    });
    plan.apply();
    auditStore(ctx).addBoardAuditEvent({
      eventType: "steward_enabled",
      actor: "orchestrator",
      payload: {
        version: "steward-enable.v1",
        operationId: lock!.operationId,
        outcome: "changed",
        changed: true,
        lastRunAt: plan.result.lastRunAt,
        recovered: false,
      },
      provenance: principal,
    });
    lock!.release();

    await buildProgram(ctx.deps).parseAsync(
      ["admin", "steward-enable", "--apply", ...flags],
      { from: "user" },
    );

    expect(auditStore(ctx).listBoardAuditEvents("steward_enabled")).toHaveLength(1);
    expect(existsSync(join(ctx.deps.env.home, "state", "steward-enable.pending.json"))).toBe(false);
  });

  it("helpはdry-run/applyとorchestrator flagsだけを公開しservice/unknownを選択肢に出さない", async () => {
    ctx = createTestDeps();
    await expect(
      buildProgram(ctx.deps).parseAsync(["admin", "steward-enable", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    const help = ctx.stdout.text();
    expect(help).toContain("--apply");
    expect(help).toContain("--actor-kind <kind>");
    expect(help).toContain('(choices: "human", "orchestrator")');
    expect(help).not.toContain("service");
    expect(help).not.toContain("unknown");
  });
});
