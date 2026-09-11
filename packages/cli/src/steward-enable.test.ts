import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_EVIDENCE_VALUES } from "@hachi/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_STEWARD_STATE_BYTES,
  decideStewardEnable,
  parseStewardStateStrict,
  prepareStewardEnable,
  readStewardEnablePending,
  removeStewardEnablePending,
  STEWARD_INTEGRATION_EVIDENCE_KEYS,
  STEWARD_STATE_KEYS,
  writeStewardEnablePending,
  type StewardState,
} from "./steward-enable.js";

interface SupervisorStewardSchemaModule {
  SUPERVISOR_STEWARD_STATE_KEYS: readonly string[];
  KNOWN_INTEGRATION_EVIDENCE: ReadonlySet<string>;
}

async function importSupervisorStewardSchema(): Promise<SupervisorStewardSchemaModule> {
  // 静的 import は CLI の rootDir 外を tsc program に含めるため、実行時に同じ相対pathを解決する。
  const modulePath: string = new URL("../../supervisor/src/stages/steward.ts", import.meta.url).href;
  return import(modulePath) as Promise<SupervisorStewardSchemaModule>;
}

const DISABLED_STATE: StewardState = {
  lastRunAt: 1_700_000_123,
  lastProposalCount: 7,
  lastAppliedCount: 3,
  lastProposedCount: 4,
  lastRequestedCount: 5,
  lastSuppressedCount: 6,
  lastArchivedByEvidence: {
    "not-observable:repo-root": 2,
    "clean-head-reachable": 1,
  },
  lastError: "Bearer sensitive-token",
  consecutiveFailures: 3,
  autoDisabled: true,
  autoDisabledReason: "連続3回失敗: secret",
  autoDisabledAt: 1_700_000_000,
  claimGeneration: 7,
};

function writeStewardStateFixture(home: string, state: StewardState): void {
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "steward.json");
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

describe("steward enable file helper", () => {
  const dirs: string[] = [];

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "hachi-steward-enable-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("純粋decisionは保持fieldを維持し、復帰5 fieldのresetとgeneration前進を行う", () => {
    const decision = decideStewardEnable(DISABLED_STATE);
    expect(decision.result).toEqual({
      outcome: "changed",
      changed: true,
      lastRunAt: DISABLED_STATE.lastRunAt,
    });
    expect(decision.nextState).toEqual({
      ...DISABLED_STATE,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 8,
    });
    expect(decideStewardEnable(null)).toEqual({
      result: { outcome: "no-state", changed: false, lastRunAt: null },
      nextState: null,
    });
    expect(decideStewardEnable({ ...DISABLED_STATE, autoDisabled: false }).result.outcome)
      .toBe("already-enabled");
  });

  it("strict parserは完全schemaだけを許可する", () => {
    expect(parseStewardStateStrict(JSON.stringify(DISABLED_STATE))).toEqual(DISABLED_STATE);
    for (const value of [
      "{",
      "[]",
      JSON.stringify({ ...DISABLED_STATE, lastFoo: 1 }),
      JSON.stringify({ ...DISABLED_STATE, lastRunAt: -1 }),
      JSON.stringify({ ...DISABLED_STATE, consecutiveFailures: 1.5 }),
      JSON.stringify({ ...DISABLED_STATE, autoDisabled: "yes" }),
      JSON.stringify({ ...DISABLED_STATE, lastError: null }),
    ]) {
      expect(() => parseStewardStateStrict(value)).toThrow();
    }
    const missing = { ...DISABLED_STATE } as Partial<StewardState>;
    delete missing.lastAppliedCount;
    expect(() => parseStewardStateStrict(JSON.stringify(missing))).toThrow(/不足/);
  });

  it("supervisor が書く state field・evidence key と CLI の allowlist が一致する", async () => {
    const {
      KNOWN_INTEGRATION_EVIDENCE,
      SUPERVISOR_STEWARD_STATE_KEYS,
    } = await importSupervisorStewardSchema();
    expect([...STEWARD_STATE_KEYS].sort()).toEqual([...SUPERVISOR_STEWARD_STATE_KEYS].sort());
    expect(STEWARD_INTEGRATION_EVIDENCE_KEYS).toBe(INTEGRATION_EVIDENCE_VALUES);
    expect([...STEWARD_INTEGRATION_EVIDENCE_KEYS].sort())
      .toEqual([...KNOWN_INTEGRATION_EVIDENCE].sort());
  });

  it("lastArchivedByEvidence は optional record として厳格に検証する", () => {
    expect(parseStewardStateStrict(JSON.stringify(DISABLED_STATE))).toEqual(DISABLED_STATE);

    const legacy = { ...DISABLED_STATE } as Partial<StewardState>;
    delete legacy.lastArchivedByEvidence;
    expect(parseStewardStateStrict(JSON.stringify(legacy))).toEqual({
      ...DISABLED_STATE,
      lastArchivedByEvidence: {},
    });

    const unknownKey = {
      ...DISABLED_STATE,
      lastArchivedByEvidence: { "not-observable:bogus": 1 },
    };
    expect(() => parseStewardStateStrict(JSON.stringify(unknownKey))).toThrow(/未知の evidence key/);

    for (const invalidValue of [
      null,
      [],
      1,
      "invalid",
      { "clean-head-reachable": -1 },
      { "clean-head-reachable": "1" },
    ]) {
      const invalid = { ...DISABLED_STATE, lastArchivedByEvidence: invalidValue };
      expect(() => parseStewardStateStrict(JSON.stringify(invalid))).toThrow(/lastArchivedByEvidence/);
    }
  });

  it("追加前の legacy state は optional fieldを既定値で読める（後方互換）", () => {
    const legacy = { ...DISABLED_STATE } as Partial<StewardState>;
    delete legacy.lastRequestedCount;
    delete legacy.lastSuppressedCount;
    delete legacy.autoDisabledAt;
    delete legacy.claimGeneration;

    expect(parseStewardStateStrict(JSON.stringify(legacy))).toEqual({
      ...DISABLED_STATE,
      lastRequestedCount: 0,
      lastSuppressedCount: 0,
      autoDisabledAt: 0,
      claimGeneration: 0,
    });

    // 欠落は許すが、存在するなら必須fieldと同じ厳格さで検証する
    for (const invalid of [
      JSON.stringify({ ...DISABLED_STATE, lastRequestedCount: -1 }),
      JSON.stringify({ ...DISABLED_STATE, lastRequestedCount: 1.5 }),
      JSON.stringify({ ...DISABLED_STATE, lastRequestedCount: null }),
      JSON.stringify({ ...DISABLED_STATE, lastSuppressedCount: "1" }),
      JSON.stringify({ ...DISABLED_STATE, autoDisabledAt: -1 }),
      JSON.stringify({ ...DISABLED_STATE, autoDisabledAt: 1.5 }),
      JSON.stringify({ ...DISABLED_STATE, autoDisabledAt: null }),
      JSON.stringify({ ...DISABLED_STATE, claimGeneration: -1 }),
      JSON.stringify({ ...DISABLED_STATE, claimGeneration: 1.5 }),
      JSON.stringify({ ...DISABLED_STATE, claimGeneration: null }),
    ]) {
      expect(() => parseStewardStateStrict(invalid)).toThrow();
    }
  });

  it("legacy stateからの復帰はmutationを止めず、optional fieldを補って書き戻す", () => {
    const dir = home();
    const legacy = { ...DISABLED_STATE } as Partial<StewardState>;
    delete legacy.lastRequestedCount;
    delete legacy.lastSuppressedCount;
    delete legacy.lastArchivedByEvidence;
    delete legacy.autoDisabledAt;
    delete legacy.claimGeneration;
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "steward.json"), JSON.stringify(legacy), { mode: 0o600 });

    const plan = prepareStewardEnable(dir);
    expect(plan.result.outcome).toBe("changed");
    expect(plan.apply()).not.toBeNull();

    // 書き戻しは現行field形へ正規化され、再readもstrict parserを通る
    const raw = readFileSync(join(stateDir, "steward.json"), "utf8");
    const written = JSON.parse(raw) as Record<string, unknown>;
    expect(written).toMatchObject({
      lastRequestedCount: 0,
      lastSuppressedCount: 0,
      autoDisabledAt: 0,
      claimGeneration: 1,
    });
    expect(written["lastArchivedByEvidence"]).toEqual({});
    expect(parseStewardStateStrict(raw)).toEqual({
      ...DISABLED_STATE,
      lastRequestedCount: 0,
      lastSuppressedCount: 0,
      lastArchivedByEvidence: {},
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 1,
    });
  });

  it("dry-run計画はfileを変更せず、applyはatomic 0600で保持fieldを維持する", () => {
    const dir = home();
    writeStewardStateFixture(dir, DISABLED_STATE);
    const path = join(dir, "state", "steward.json");
    chmodSync(path, 0o644);
    const before = readFileSync(path, "utf8");

    const plan = prepareStewardEnable(dir);
    expect(plan.result.outcome).toBe("changed");
    expect(readFileSync(path, "utf8")).toBe(before);

    const rollback = plan.apply();
    const enabled = parseStewardStateStrict(readFileSync(path, "utf8"));
    expect(enabled).toEqual({
      ...DISABLED_STATE,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 8,
    });
    expect(enabled.lastArchivedByEvidence).toEqual(DISABLED_STATE.lastArchivedByEvidence);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "state")).filter((name) => name.includes(".tmp-"))).toEqual([]);

    expect(rollback).not.toBeNull();
    expect(rollback!.rollbackIfUnchanged()).toBe(true);
    expect(parseStewardStateStrict(readFileSync(path, "utf8"))).toEqual({
      ...DISABLED_STATE,
      claimGeneration: 8,
    });
  });

  it("state未作成/既にenabledはidempotent no-opでfileを作らない", () => {
    const missingHome = home();
    const missing = prepareStewardEnable(missingHome);
    expect(missing.result.outcome).toBe("no-state");
    expect(missing.apply()).toBeNull();
    expect(existsSync(join(missingHome, "state"))).toBe(false);

    const enabledHome = home();
    const enabledState = { ...DISABLED_STATE, autoDisabled: false, consecutiveFailures: 2 };
    writeStewardStateFixture(enabledHome, enabledState);
    const path = join(enabledHome, "state", "steward.json");
    const before = readFileSync(path, "utf8");
    const enabled = prepareStewardEnable(enabledHome);
    expect(enabled.result.outcome).toBe("already-enabled");
    expect(enabled.apply()).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("state directory/fileのsymlink・directory・上限超過をmutation 0で拒否する", () => {
    const realHome = home();
    const linkedParent = join(tmpdir(), `hachi-steward-home-link-${process.pid}-${Date.now()}`);
    dirs.push(linkedParent);
    symlinkSync(realHome, linkedParent);
    expect(() => prepareStewardEnable(linkedParent)).toThrow(/HACHI_KANBAN_HOME/);

    const target = home();
    mkdirSync(join(target, "real-state"));
    symlinkSync(join(target, "real-state"), join(target, "state"));
    expect(() => prepareStewardEnable(target)).toThrow(/通常directory/);
    expect(readdirSync(join(target, "real-state"))).toEqual([]);

    const fileLinkHome = home();
    mkdirSync(join(fileLinkHome, "state"));
    const outside = join(fileLinkHome, "outside.json");
    writeFileSync(outside, JSON.stringify(DISABLED_STATE));
    symlinkSync(outside, join(fileLinkHome, "state", "steward.json"));
    expect(() => prepareStewardEnable(fileLinkHome)).toThrow(/通常file/);
    expect(readFileSync(outside, "utf8")).toBe(JSON.stringify(DISABLED_STATE));

    const directoryHome = home();
    mkdirSync(join(directoryHome, "state", "steward.json"), { recursive: true });
    expect(() => prepareStewardEnable(directoryHome)).toThrow(/通常file/);

    const largeHome = home();
    mkdirSync(join(largeHome, "state"));
    const largePath = join(largeHome, "state", "steward.json");
    writeFileSync(largePath, "x".repeat(MAX_STEWARD_STATE_BYTES + 1));
    expect(() => prepareStewardEnable(largeHome)).toThrow(/bytes/);
    expect(statSync(largePath).size).toBe(MAX_STEWARD_STATE_BYTES + 1);
  });

  it("dangling symlinkもno-state扱いせず拒否する", () => {
    const dir = home();
    mkdirSync(join(dir, "state"));
    const path = join(dir, "state", "steward.json");
    symlinkSync(join(dir, "missing.json"), path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(() => prepareStewardEnable(dir)).toThrow(/通常file/);
  });

  it("prepare後にfileが変わればapplyを拒否し、kill-switchには触れない", () => {
    const dir = home();
    writeStewardStateFixture(dir, DISABLED_STATE);
    const statePath = join(dir, "state", "steward.json");
    const killSwitch = join(dir, "steward.disabled");
    writeFileSync(killSwitch, "keep");
    const plan = prepareStewardEnable(dir);
    writeFileSync(statePath, JSON.stringify({ ...DISABLED_STATE, lastRunAt: 9 }));
    expect(() => plan.apply()).toThrow(/検証後に変更/);
    expect(parseStewardStateStrict(readFileSync(statePath, "utf8")).lastRunAt).toBe(9);
    expect(readFileSync(killSwitch, "utf8")).toBe("keep");
  });

  it("pending journalはhash/operation metadataだけを0600で保持しstrictに読む", () => {
    const dir = home();
    writeStewardStateFixture(dir, DISABLED_STATE);
    const plan = prepareStewardEnable(dir);
    const journal = {
      version: "steward-enable-pending.v1" as const,
      operationId: "op_0123456789abcdef0123456789abcdef",
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      outcome: "changed" as const,
      lastRunAt: plan.result.lastRunAt!,
      createdAt: 1_700_000_000,
    };
    writeStewardEnablePending(dir, journal);
    const path = join(dir, "state", "steward-enable.pending.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readStewardEnablePending(dir)).toEqual(journal);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(DISABLED_STATE.lastError);
    expect(raw).not.toContain(DISABLED_STATE.autoDisabledReason);

    const applied = plan.apply();
    expect(applied).not.toBeNull();
    expect(parseStewardStateStrict(readFileSync(join(dir, "state", "steward.json"), "utf8")).autoDisabledAt)
      .toBe(0);
    expect(applied!.rollbackIfUnchanged()).toBe(true);
    expect(parseStewardStateStrict(readFileSync(join(dir, "state", "steward.json"), "utf8")).autoDisabledAt)
      .toBe(DISABLED_STATE.autoDisabledAt);
    expect(parseStewardStateStrict(readFileSync(join(dir, "state", "steward.json"), "utf8")).claimGeneration)
      .toBe(8);

    chmodSync(path, 0o644);
    expect(() => readStewardEnablePending(dir)).toThrow(/0600/);
    chmodSync(path, 0o600);
    removeStewardEnablePending(dir);
    expect(existsSync(path)).toBe(false);
  });

  it("claimGeneration が上限到達済みなら復帰を fail-closed で拒否する", () => {
    expect(() => decideStewardEnable({
      ...DISABLED_STATE,
      claimGeneration: Number.MAX_SAFE_INTEGER,
    })).toThrow(/Number\.MAX_SAFE_INTEGER/);
  });
});
