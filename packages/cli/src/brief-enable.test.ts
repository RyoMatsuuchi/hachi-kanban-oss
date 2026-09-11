import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideBriefEnable,
  parseBriefStateStrict,
  prepareBriefEnable,
  readBriefEnablePending,
  removeBriefEnablePending,
  writeBriefEnablePending,
  type BriefEnableState,
} from "./brief-enable.js";

const DISABLED: BriefEnableState = {
  lastRunAt: 1_700_100_200,
  lastError: "timeout detail",
  consecutiveFailures: 3,
  autoDisabled: true,
  autoDisabledReason: "連続3回失敗: timeout detail",
  autoDisabledAt: 1_700_100_000,
  claimGeneration: 11,
};

describe("brief enable file helper", () => {
  const homes: string[] = [];

  function home(): string {
    const path = mkdtempSync(join(tmpdir(), "hachi-brief-enable-"));
    homes.push(path);
    return path;
  }

  function writeState(root: string, state: BriefEnableState, mode = 0o640): string {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, "brief.json");
    writeFileSync(path, JSON.stringify(state), { mode });
    chmodSync(path, mode);
    return path;
  }

  afterEach(() => {
    for (const path of homes.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("disabledだけ復帰5 fieldをresetしgenerationを前進してlastRunAtを保持する", () => {
    expect(decideBriefEnable(DISABLED)).toEqual({
      result: { outcome: "changed", changed: true, lastRunAt: DISABLED.lastRunAt },
      nextState: {
        ...DISABLED,
        lastError: "",
        consecutiveFailures: 0,
        autoDisabled: false,
        autoDisabledReason: "",
        autoDisabledAt: 0,
        claimGeneration: 12,
      },
    });
    expect(decideBriefEnable({ ...DISABLED, autoDisabled: false }).result.outcome)
      .toBe("already-enabled");
    expect(decideBriefEnable(null).result.outcome).toBe("no-state");
  });

  it("prepareはapplyまで変更せず、apply後は0600にしてCAS rollbackできる", () => {
    const root = home();
    const path = writeState(root, DISABLED);
    const before = readFileSync(path, "utf8");
    const plan = prepareBriefEnable(root);

    expect(plan.result.outcome).toBe("changed");
    expect(readFileSync(path, "utf8")).toBe(before);
    const applied = plan.apply();
    expect(applied).not.toBeNull();
    expect(parseBriefStateStrict(readFileSync(path, "utf8"))).toEqual({
      ...DISABLED,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      autoDisabledAt: 0,
      claimGeneration: 12,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(applied!.rollbackIfUnchanged()).toBe(true);
    expect(parseBriefStateStrict(readFileSync(path, "utf8"))).toEqual({
      ...DISABLED,
      claimGeneration: 12,
    });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("schema外field・壊れたJSON・symlinkを拒否する", () => {
    expect(() => parseBriefStateStrict("{" )).toThrow(/JSON/);
    expect(() => parseBriefStateStrict(JSON.stringify({ ...DISABLED, extra: true }))).toThrow(/未知/);

    const root = home();
    const target = writeState(root, DISABLED);
    const linkRoot = home();
    mkdirSync(join(linkRoot, "state"), { recursive: true });
    symlinkSync(target, join(linkRoot, "state", "brief.json"));
    expect(() => prepareBriefEnable(linkRoot)).toThrow(/通常file/);
  });

  it("autoDisabledAt を持たない legacy state は0として復帰し、不正値は拒否する", () => {
    const legacy = { ...DISABLED } as Partial<BriefEnableState>;
    delete legacy.autoDisabledAt;
    delete legacy.claimGeneration;
    expect(parseBriefStateStrict(JSON.stringify(legacy))).toEqual({
      ...DISABLED,
      autoDisabledAt: 0,
      claimGeneration: 0,
    });

    for (const autoDisabledAt of [-1, 1.5, null, "1"]) {
      expect(() => parseBriefStateStrict(JSON.stringify({ ...DISABLED, autoDisabledAt }))).toThrow(
        /autoDisabledAt/,
      );
    }
    for (const claimGeneration of [-1, 1.5, null, "1"]) {
      expect(() => parseBriefStateStrict(JSON.stringify({ ...DISABLED, claimGeneration }))).toThrow(
        /claimGeneration/,
      );
    }

    const root = home();
    const path = join(root, "state", "brief.json");
    mkdirSync(join(root, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(legacy), { mode: 0o600 });
    const plan = prepareBriefEnable(root);
    expect(plan.apply()).not.toBeNull();
    expect(parseBriefStateStrict(readFileSync(path, "utf8"))).toMatchObject({
      autoDisabled: false,
      autoDisabledAt: 0,
      claimGeneration: 1,
    });
  });

  it("pending journalは0600 strict schemaでround-tripする", () => {
    const root = home();
    const statePath = writeState(root, DISABLED, 0o600);
    const plan = prepareBriefEnable(root);
    const journal = {
      version: "brief-enable-pending.v1" as const,
      operationId: `op_${"a".repeat(32)}`,
      beforeHash: plan.beforeHash!,
      afterHash: plan.afterHash!,
      outcome: "changed" as const,
      lastRunAt: 123,
      createdAt: 456,
    };
    writeBriefEnablePending(root, journal);
    expect(readBriefEnablePending(root)).toEqual(journal);
    expect(statSync(join(root, "state", "brief-enable.pending.json")).mode & 0o777).toBe(0o600);
    const applied = plan.apply();
    expect(applied).not.toBeNull();
    expect(parseBriefStateStrict(readFileSync(statePath, "utf8")).autoDisabledAt).toBe(0);
    expect(applied!.rollbackIfUnchanged()).toBe(true);
    expect(parseBriefStateStrict(readFileSync(statePath, "utf8")).autoDisabledAt)
      .toBe(DISABLED.autoDisabledAt);
    expect(parseBriefStateStrict(readFileSync(statePath, "utf8")).claimGeneration).toBe(12);
    removeBriefEnablePending(root);
    expect(existsSync(join(root, "state", "brief-enable.pending.json"))).toBe(false);
  });

  it("claimGeneration が上限到達済みなら復帰を fail-closed で拒否する", () => {
    expect(() => decideBriefEnable({
      ...DISABLED,
      claimGeneration: Number.MAX_SAFE_INTEGER,
    })).toThrow(/Number\.MAX_SAFE_INTEGER/);
  });
});
