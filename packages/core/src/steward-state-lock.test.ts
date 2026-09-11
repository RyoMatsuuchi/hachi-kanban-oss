import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { afterEach, describe, expect, it } from "vitest";
import {
  STEWARD_STATE_LOCK_NAME,
  STEWARD_STATE_LOCK_GUARD_NAME,
  acquireStewardStateLock,
  inspectStewardStateLocks,
  writeFileAtomic0600Durable,
} from "./steward-state-lock.js";

describe("steward state lock / durable writer", () => {
  const dirs: string[] = [];

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "hachi-steward-lock-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("O_EXCL lockはCLI/supervisorを相互排他し、所有者だけが解放できる", () => {
    const dir = home();
    const cli = acquireStewardStateLock(dir, "cli-steward-enable");
    expect(cli).not.toBeNull();
    const lockPath = join(dir, STEWARD_STATE_LOCK_NAME);
    expect(lstatSync(lockPath).isFile()).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(acquireStewardStateLock(dir, "supervisor-steward")).toBeNull();

    cli!.release();
    expect(cli!.release).not.toThrow();
    const supervisor = acquireStewardStateLock(dir, "supervisor-steward");
    expect(supervisor).not.toBeNull();
    supervisor!.release();
  });

  it("briefとstewardのwriterはhistorical shared lockで相互排他する", () => {
    const dir = home();
    const brief = acquireStewardStateLock(dir, "cli-brief-enable");
    expect(brief).not.toBeNull();
    expect(acquireStewardStateLock(dir, "supervisor-brief")).toBeNull();
    expect(acquireStewardStateLock(dir, "supervisor-steward")).toBeNull();

    brief!.release();
    const supervisor = acquireStewardStateLock(dir, "supervisor-brief");
    expect(supervisor).not.toBeNull();
    supervisor!.release();
  });

  it("CLIだけがdead pidのcrash lockをstrictに回収できる", () => {
    const dir = home();
    const crashed = acquireStewardStateLock(dir, "cli-steward-enable", { now: () => 1_000 });
    expect(crashed).not.toBeNull();

    const recovered = acquireStewardStateLock(dir, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
      now: () => 1_121,
    });
    expect(recovered).not.toBeNull();
    expect(() => crashed!.release()).toThrow(/所有権/);
    recovered!.release();
  });

  it("二回収者barrierはguardで直列化され、新ownerのmain lockを旧ownerが削除しない", () => {
    const dir = home();
    const crashed = acquireStewardStateLock(dir, "cli-steward-enable", { now: () => 1_000 });
    let competing: ReturnType<typeof acquireStewardStateLock> | undefined;
    const recovered = acquireStewardStateLock(dir, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
      now: () => 1_121,
      beforeStaleRemoval: () => {
        competing = acquireStewardStateLock(dir, "cli-steward-enable", {
          recoverStale: true,
          processAlive: () => false,
          now: () => 1_121,
        });
      },
    });

    expect(competing).toBeNull();
    expect(recovered).not.toBeNull();
    expect(() => crashed!.release()).toThrow(/所有権/);
    expect(existsSync(join(dir, STEWARD_STATE_LOCK_NAME))).toBe(true);
    recovered!.release();
  });

  it("PIDがdeadでも120秒未満または未来時刻のlockは奪わない", () => {
    const dir = home();
    const lock = acquireStewardStateLock(dir, "cli-steward-enable", { now: () => 1_000 });
    expect(() => acquireStewardStateLock(dir, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
      now: () => 1_119,
    })).toThrow(/若い/);
    expect(() => acquireStewardStateLock(dir, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
      now: () => 999,
    })).toThrow(/若い/);
    lock!.release();
  });

  it("live lock・symlink/malformed lockは自動回収しない", () => {
    const liveHome = home();
    const live = acquireStewardStateLock(liveHome, "supervisor-steward");
    expect(() => acquireStewardStateLock(liveHome, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => true,
    })).toThrow(/操作中/);
    live!.release();

    const malformedHome = home();
    const malformedPath = join(malformedHome, STEWARD_STATE_LOCK_NAME);
    writeFileSync(malformedPath, "{");
    chmodSync(malformedPath, 0o600);
    expect(() => acquireStewardStateLock(malformedHome, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
    })).toThrow(/壊れ/);

    const symlinkHome = home();
    const outside = join(symlinkHome, "outside");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(symlinkHome, STEWARD_STATE_LOCK_NAME));
    expect(() => acquireStewardStateLock(symlinkHome, "cli-steward-enable", {
      recoverStale: true,
      processAlive: () => false,
    })).toThrow(/通常/);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("main lockはunknown/missing schema keyをstrictに拒否する", () => {
    for (const mutate of [
      (record: Record<string, unknown>): void => { record["unknown"] = true; },
      (record: Record<string, unknown>): void => { delete record["owner"]; },
    ]) {
      const dir = home();
      acquireStewardStateLock(dir, "cli-steward-enable", { now: () => 1_000 });
      const path = join(dir, STEWARD_STATE_LOCK_NAME);
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      mutate(record);
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      chmodSync(path, 0o600);

      expect(() => acquireStewardStateLock(dir, "cli-steward-enable", {
        recoverStale: true,
        processAlive: () => false,
        now: () => 1_121,
      })).toThrow(/schema key/);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(dir, STEWARD_STATE_LOCK_GUARD_NAME))).toBe(false);
    }
  });

  it("guard競合中はacquire/releaseともmain lockを変更しない", () => {
    const dir = home();
    const handle = acquireStewardStateLock(dir, "cli-steward-enable");
    const mainPath = join(dir, STEWARD_STATE_LOCK_NAME);
    const before = readFileSync(mainPath, "utf8");
    const guardPath = join(dir, STEWARD_STATE_LOCK_GUARD_NAME);
    writeFileSync(guardPath, "manual guard", { mode: 0o600 });

    expect(acquireStewardStateLock(dir, "supervisor-steward")).toBeNull();
    expect(() => handle!.release()).toThrow(/guard が使用中/);
    expect(readFileSync(mainPath, "utf8")).toBe(before);

    rmSync(guardPath);
    handle!.release();
    expect(existsSync(mainPath)).toBe(false);
  });

  it("guard/mainのO_EXCL作成後にI/O失敗してもpartial fileをdurable cleanupし再取得できる", () => {
    for (const [hook, expectedMessage] of [
      ["afterGuardOpened", "guard persist failed"],
      ["afterMainOpened", "main persist failed"],
    ] as const) {
      const dir = home();
      expect(() => acquireStewardStateLock(dir, "cli-steward-enable", {
        [hook]: (): void => {
          throw new Error(expectedMessage);
        },
      })).toThrow(expectedMessage);
      expect(existsSync(join(dir, STEWARD_STATE_LOCK_GUARD_NAME))).toBe(false);
      expect(existsSync(join(dir, STEWARD_STATE_LOCK_NAME))).toBe(false);

      const retried = acquireStewardStateLock(dir, "cli-steward-enable");
      expect(retried).not.toBeNull();
      retried!.release();
    }
  });

  it("read-only inspectionはstale mainとmalformed guardをNGにしnonceを表示しない", () => {
    const staleHome = home();
    const stale = acquireStewardStateLock(staleHome, "cli-steward-enable", { now: () => 1_000 });
    const staleInspection = inspectStewardStateLocks(staleHome, {
      now: () => 1_121,
      processAlive: () => false,
    });
    expect(staleInspection).toMatchObject({ ok: false });
    expect(staleInspection.detail).toContain("stale");
    expect(staleInspection.detail).not.toContain(stale!.operationId);

    const malformedHome = home();
    writeFileSync(join(malformedHome, STEWARD_STATE_LOCK_GUARD_NAME), "{}", { mode: 0o600 });
    const malformedInspection = inspectStewardStateLocks(malformedHome);
    expect(malformedInspection).toMatchObject({ ok: false });
    expect(malformedInspection.detail).toContain("guard lock不正");
  });

  it("lockが無い、またはlive mainだけならread-only inspectionはOK", () => {
    const emptyHome = home();
    expect(inspectStewardStateLocks(emptyHome)).toEqual({ ok: true, detail: "main/guard lockなし" });

    const liveHome = home();
    const live = acquireStewardStateLock(liveHome, "supervisor-steward", { now: () => 1_000 });
    expect(inspectStewardStateLocks(liveHome, {
      now: () => 1_001,
      processAlive: () => true,
    })).toMatchObject({ ok: true });
    live!.release();
  });

  it("durable atomic writerは既存modeに依存せず0600で置換しtempを残さない", () => {
    const dir = home();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);

    writeFileAtomic0600Durable(path, "new");

    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
