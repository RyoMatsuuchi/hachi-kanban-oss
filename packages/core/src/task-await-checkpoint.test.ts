import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_AWAIT_CHECKPOINT_MAX_BYTES,
  TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
  TASK_AWAIT_LOCK_MAX_BYTES,
  TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
  TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
  type TaskAwaitCheckpoint,
  type TaskAwaitCheckpointStore,
  matchesAwaitTenantFilter,
  normalizeAwaitOrchestratorFilter,
  normalizeAwaitTenantFilter,
  openTaskAwaitCheckpointStore,
} from "./task-await-checkpoint.js";

const BOARD_INSTANCE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_BOARD_INSTANCE_ID = "fedcba9876543210fedcba9876543210";
const CHILD_LOCK_ACQUIRED_EXIT_CODE = 0;
const CHILD_LOCK_BUSY_EXIT_CODE = 73;
const BETTER_SQLITE3_MODULE_PATH = createRequire(import.meta.url).resolve("better-sqlite3");
const CHILD_LOCK_PROBE_SCRIPT = `
const Database = require(process.argv[1]);
const sidecarPath = process.argv[2];
try {
  const db = new Database(sidecarPath, { fileMustExist: true, timeout: 0 });
  db.pragma("busy_timeout = 0");
  db.exec("BEGIN EXCLUSIVE");
  process.exit(db.inTransaction ? ${CHILD_LOCK_ACQUIRED_EXIT_CODE} : 75);
} catch (error) {
  process.exit(error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED"
    ? ${CHILD_LOCK_BUSY_EXIT_CODE}
    : 75);
}
`;
const CHILD_LOCK_HOLDER_SCRIPT = `
const { randomBytes } = require("node:crypto");
const { chmodSync, renameSync, writeFileSync } = require("node:fs");
const Database = require(process.argv[1]);
const sidecarPath = process.argv[2];
const ownerMarkerPath = process.argv[3];
let db;
try {
  db = new Database(sidecarPath, { fileMustExist: true, timeout: 0 });
  db.pragma("busy_timeout = 0");
  db.exec("BEGIN EXCLUSIVE");
  const tempPath = ownerMarkerPath + ".child-" + process.pid;
  writeFileSync(tempPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, ownerMarkerPath);
  process.stdout.write("ready");
} catch {
  process.exit(75);
}
process.on("SIGTERM", () => {
  try {
    if (db.inTransaction) {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
    process.exit(0);
  }
});
setInterval(() => {}, 1_000);
`;

function childLockProbeExitCode(sidecarPath: string): number {
  const result = spawnSync(
    process.execPath,
    ["--eval", CHILD_LOCK_PROBE_SCRIPT, BETTER_SQLITE3_MODULE_PATH, sidecarPath],
    { stdio: "ignore", timeout: 5_000 },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === null) {
    throw new Error("sidecar lock の子process probeが終了しませんでした");
  }
  return result.status;
}

function sidecarOwnerMarkerPath(sidecarPath: string): string {
  if (!sidecarPath.endsWith(".sqlite")) {
    throw new Error("sidecar lock path のsuffixが不正です");
  }
  return `${sidecarPath.slice(0, -".sqlite".length)}.owner`;
}

function startChildLockHolder(sidecarPath: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--eval",
      CHILD_LOCK_HOLDER_SCRIPT,
      BETTER_SQLITE3_MODULE_PATH,
      sidecarPath,
      sidecarOwnerMarkerPath(sidecarPath),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

async function waitForChildLockHolder(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error("sidecar lock の子process stdoutを取得できませんでした");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("sidecar lock の子process取得待ちがtimeoutしました"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`sidecar lock の子processが取得前に終了しました: code=${code}, signal=${signal}`));
    };
    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function stopChildLockHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("sidecar lock の子process停止待ちがtimeoutしました"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      resolve();
    };
    child.on("error", onError);
    child.on("exit", onExit);
    child.kill("SIGTERM");
  });
}

function checkpoint(
  eventCursor: number,
  targetIds: string[] = ["t_0000000000000001"],
  boardInstanceId = BOARD_INSTANCE_ID,
): TaskAwaitCheckpoint {
  return {
    schemaVersion: TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION,
    boardInstanceId,
    eventCursor,
    targetIds,
  };
}

function tenantCheckpoint(
  eventCursor: number,
  targetIds: string[] = ["t_0000000000000001"],
  tenants: string[] = ["tenant-a"],
  boardInstanceId = BOARD_INSTANCE_ID,
): TaskAwaitCheckpoint {
  return {
    schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
    boardInstanceId,
    eventCursor,
    targetIds,
    tenants,
    filterRevision: 1,
  };
}

function orchestratorCheckpoint(
  eventCursor: number,
  targetIds: string[] = ["t_0000000000000001"],
  tenants: string[] = [],
  orchestratorId = "orchestrator-main",
  boardInstanceId = BOARD_INSTANCE_ID,
): TaskAwaitCheckpoint {
  return {
    schemaVersion: TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
    boardInstanceId,
    eventCursor,
    targetIds,
    tenants,
    orchestratorId,
    filterRevision: 1,
  };
}

describe("task-await checkpoint store", () => {
  const homes: string[] = [];
  const stores: TaskAwaitCheckpointStore[] = [];

  function home(): string {
    const path = mkdtempSync(join(tmpdir(), "hachi-task-await-checkpoint-"));
    homes.push(path);
    return path;
  }

  function open(
    homePath: string,
    relativePath = "watch.json",
    boardInstanceId = BOARD_INSTANCE_ID,
  ): TaskAwaitCheckpointStore {
    const store = openTaskAwaitCheckpointStore({ home: homePath, relativePath, boardInstanceId });
    stores.push(store);
    return store;
  }

  function openTenant(
    homePath: string,
    tenants: readonly string[],
    relativePath = "watch.json",
    boardInstanceId = BOARD_INSTANCE_ID,
  ): TaskAwaitCheckpointStore {
    const store = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath,
      boardInstanceId,
      tenants,
    });
    stores.push(store);
    return store;
  }

  function openOrchestrator(
    homePath: string,
    orchestratorId: string,
    tenants?: readonly string[],
    relativePath = "watch.json",
    boardInstanceId = BOARD_INSTANCE_ID,
  ): TaskAwaitCheckpointStore {
    const store = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath,
      boardInstanceId,
      orchestratorId,
      ...(tenants === undefined ? {} : { tenants }),
    });
    stores.push(store);
    return store;
  }

  function expectUnexpectedOwnerAtCheck(
    checkNumber: number,
    action: () => unknown,
    expected: RegExp,
  ): void {
    if (typeof process.getuid !== "function") {
      throw new Error("owner focused test はgetuid対応環境でのみ実行できます");
    }
    const actualUid = process.getuid();
    let checks = 0;
    const uid = vi.spyOn(process, "getuid").mockImplementation(() => {
      checks += 1;
      return checks === checkNumber ? actualUid + 1 : actualUid;
    });
    try {
      expect(action).toThrow(expected);
      expect(checks).toBe(checkNumber);
    } finally {
      uid.mockRestore();
    }
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // 失敗系testで境界を差し替えたstoreはclose自体が失敗し得る。
      }
    }
    for (const path of homes.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("schemaを0600のcheckpointへ保存し、targetIdsを辞書順で復元する", () => {
    const homePath = home();
    const store = open(homePath);

    expect(store.read()).toBeNull();
    expect(store.write(checkpoint(42, [
      "t_0000000000000002",
      "t_0000000000000001",
    ]))).toEqual(checkpoint(42, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]));
    expect(store.read()).toEqual(checkpoint(42, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]));

    const fileStat = lstatSync(store.checkpointPath);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(fileStat.nlink).toBe(1);
    const expected = checkpoint(42, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]);
    expect(TASK_AWAIT_CHECKPOINT_SCHEMA_VERSION).toBe("task-await-checkpoint.v1");
    expect(readFileSync(store.checkpointPath, "utf8")).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("tenant filterをtrim・重複排除・辞書順へ正規化し、ORと無指定全件を判定する", () => {
    expect(normalizeAwaitTenantFilter([
      " tenant-b ",
      "tenant-a",
      "tenant-b",
    ])).toEqual(["tenant-a", "tenant-b"]);
    expect(() => normalizeAwaitTenantFilter([])).toThrow(/1件以上/);
    expect(() => normalizeAwaitTenantFilter(["   "])).toThrow(/空/);
    expect(() => normalizeAwaitTenantFilter(["tenant\0a"])).toThrow(/NUL/);

    const tenants = ["tenant-a", "tenant-b"];
    expect(matchesAwaitTenantFilter("tenant-a", tenants)).toBe(true);
    expect(matchesAwaitTenantFilter("tenant-b", tenants)).toBe(true);
    expect(matchesAwaitTenantFilter("tenant-c", tenants)).toBe(false);
    expect(matchesAwaitTenantFilter("tenant-c", undefined)).toBe(true);
  });

  it("v2を6fieldのexact key順で保存し、targetIdsを辞書順で復元する", () => {
    const homePath = home();
    const store = openTenant(homePath, [" tenant-b ", "tenant-a", "tenant-b"]);
    const expected = tenantCheckpoint(
      42,
      ["t_0000000000000001", "t_0000000000000002"],
      ["tenant-a", "tenant-b"],
    );

    expect(store.read()).toBeNull();
    expect(store.write(tenantCheckpoint(
      42,
      ["t_0000000000000002", "t_0000000000000001"],
      ["tenant-a", "tenant-b"],
    ))).toEqual(expected);
    expect(store.read()).toEqual(expected);
    expect(TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION).toBe("task-await-checkpoint.v2");
    expect(readFileSync(store.checkpointPath, "utf8")).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("open後にcallerのtenant配列を変更しても購読条件のprivate copyを維持する", () => {
    const homePath = home();
    const callerTenants = [" tenant-b ", "tenant-a"];
    const store = openTenant(homePath, callerTenants);
    callerTenants.splice(0, callerTenants.length, "tenant-c");

    const expected = tenantCheckpoint(1, undefined, ["tenant-a", "tenant-b"]);
    expect(store.write(expected)).toEqual(expected);
    expect(store.read()).toEqual(expected);
  });

  it("write時の版・tenant・revision不一致を拒否して元checkpointを変更しない", () => {
    const homePath = home();
    const store = openTenant(homePath, ["tenant-a"]);
    store.write(tenantCheckpoint(10));
    const before = readFileSync(store.checkpointPath);
    const revisionMismatch = {
      ...tenantCheckpoint(11),
      filterRevision: 2,
    } as unknown as TaskAwaitCheckpoint;

    expect(() => store.write(checkpoint(11))).toThrow(/schemaVersion.*open条件/);
    expect(readFileSync(store.checkpointPath)).toEqual(before);
    expect(() => store.write(tenantCheckpoint(11, undefined, ["tenant-b"])))
      .toThrow(/tenants.*open条件/);
    expect(readFileSync(store.checkpointPath)).toEqual(before);
    expect(() => store.write(revisionMismatch)).toThrow(/filterRevision/);
    expect(readFileSync(store.checkpointPath)).toEqual(before);
  });

  it("read時にv1/v2の流用と異なるtenant条件を拒否して元fileを変更しない", () => {
    const v1Home = home();
    const v1Seed = open(v1Home, "v1-as-v2.json");
    v1Seed.write(checkpoint(1));
    const v1Before = readFileSync(v1Seed.checkpointPath);
    v1Seed.close();
    const v2Reader = openTenant(v1Home, ["tenant-a"], "v1-as-v2.json");
    expect(() => v2Reader.read()).toThrow(/schemaVersion.*open条件/);
    expect(readFileSync(v2Reader.checkpointPath)).toEqual(v1Before);
    expect(() => v2Reader.write(tenantCheckpoint(2))).toThrow(/schemaVersion.*open条件/);
    expect(readFileSync(v2Reader.checkpointPath)).toEqual(v1Before);
    v2Reader.close();

    const v2Home = home();
    const v2Seed = openTenant(v2Home, ["tenant-a"], "v2-as-v1.json");
    v2Seed.write(tenantCheckpoint(1));
    const v2Before = readFileSync(v2Seed.checkpointPath);
    v2Seed.close();
    const v1Reader = open(v2Home, "v2-as-v1.json");
    expect(() => v1Reader.read()).toThrow(/schemaVersion.*open条件/);
    expect(readFileSync(v1Reader.checkpointPath)).toEqual(v2Before);
    expect(() => v1Reader.write(checkpoint(2))).toThrow(/schemaVersion.*open条件/);
    expect(readFileSync(v1Reader.checkpointPath)).toEqual(v2Before);
    v1Reader.close();

    const tenantReader = openTenant(v2Home, ["tenant-b"], "v2-as-v1.json");
    expect(() => tenantReader.read()).toThrow(/tenants.*open条件/);
    expect(readFileSync(tenantReader.checkpointPath)).toEqual(v2Before);
    expect(() => tenantReader.write(tenantCheckpoint(2, undefined, ["tenant-b"])))
      .toThrow(/tenants.*open条件/);
    expect(readFileSync(tenantReader.checkpointPath)).toEqual(v2Before);
  });

  it("v2の欠落・未知key・非正規化tenant・未知revisionをstrictに拒否する", () => {
    const valid = tenantCheckpoint(1, undefined, ["tenant-a", "tenant-b"]);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["missing", {
        schemaVersion: TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId: BOARD_INSTANCE_ID,
        eventCursor: 1,
        targetIds: ["t_0000000000000001"],
        filterRevision: 1,
      }, /schema key/],
      ["unknown", { ...valid, extra: true }, /schema key/],
      ["unnormalized", { ...valid, tenants: ["tenant-b", "tenant-a"] }, /正規化/],
      ["revision", { ...valid, filterRevision: 2 }, /filterRevision/],
    ];

    for (const [name, value, expected] of cases) {
      const homePath = home();
      const seed = openTenant(homePath, ["tenant-a", "tenant-b"], `${name}.json`);
      const target = seed.checkpointPath;
      seed.close();
      const raw = `${JSON.stringify(value)}\n`;
      writeFileSync(target, raw, { mode: 0o600 });
      const reader = openTenant(homePath, ["tenant-a", "tenant-b"], `${name}.json`);
      expect(() => reader.read(), name).toThrow(expected);
      expect(readFileSync(target, "utf8")).toBe(raw);
      expect(() => reader.write(tenantCheckpoint(2, undefined, ["tenant-a", "tenant-b"])), name)
        .toThrow(expected);
      expect(readFileSync(target, "utf8")).toBe(raw);
      reader.close();
    }
  });

  it("orchestrator filterをtrimし、非string・空・NULを拒否する", () => {
    expect(normalizeAwaitOrchestratorFilter(" orchestrator-main ")).toBe("orchestrator-main");
    expect(() => normalizeAwaitOrchestratorFilter("   ")).toThrow(/空/);
    expect(() => normalizeAwaitOrchestratorFilter("orchestrator\0main")).toThrow(/NUL/);
    expect(() => normalizeAwaitOrchestratorFilter(42 as unknown as string)).toThrow(/string/);

    const homePath = home();
    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "empty-tenant-v2.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      tenants: [],
    })).toThrow(/1件以上/);
  });

  it("v3担当単独を7fieldのexact key順でroundtripする", () => {
    const homePath = home();
    const store = openOrchestrator(homePath, " orchestrator-main ");
    const expected = orchestratorCheckpoint(
      42,
      ["t_0000000000000001", "t_0000000000000002"],
    );

    expect(store.read()).toBeNull();
    expect(store.write(orchestratorCheckpoint(
      42,
      ["t_0000000000000002", "t_0000000000000001"],
    ))).toEqual(expected);
    expect(store.read()).toEqual(expected);
    expect(TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION)
      .toBe("task-await-checkpoint.v3");
    expect(Object.keys(expected)).toEqual([
      "schemaVersion",
      "boardInstanceId",
      "eventCursor",
      "targetIds",
      "tenants",
      "orchestratorId",
      "filterRevision",
    ]);
    expect(readFileSync(store.checkpointPath, "utf8")).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("v3 tenant ORを正規化し、open後のcaller配列変更から条件を隔離する", () => {
    const homePath = home();
    const callerTenants = [" tenant-b ", "tenant-a", "tenant-b"];
    const store = openOrchestrator(homePath, " orchestrator-main ", callerTenants);
    callerTenants.splice(0, callerTenants.length, "tenant-c");
    const expected = orchestratorCheckpoint(
      7,
      undefined,
      ["tenant-a", "tenant-b"],
    );

    expect(store.write(expected)).toEqual(expected);
    expect(store.read()).toEqual(expected);
  });

  it("v3 write時の版・tenant・identity・revision不一致で元fileを変更しない", () => {
    const homePath = home();
    const store = openOrchestrator(homePath, "orchestrator-main", ["tenant-a"]);
    store.write(orchestratorCheckpoint(10, undefined, ["tenant-a"]));
    const before = readFileSync(store.checkpointPath);
    const revisionMismatch = {
      ...orchestratorCheckpoint(11, undefined, ["tenant-a"]),
      filterRevision: 2,
    } as unknown as TaskAwaitCheckpoint;

    const cases: Array<[TaskAwaitCheckpoint, RegExp]> = [
      [checkpoint(11), /schemaVersion.*open条件/],
      [tenantCheckpoint(11), /schemaVersion.*open条件/],
      [orchestratorCheckpoint(11, undefined, ["tenant-b"]), /tenants.*open条件/],
      [
        orchestratorCheckpoint(11, undefined, ["tenant-a"], "orchestrator-other"),
        /orchestratorId.*open条件/,
      ],
      [revisionMismatch, /filterRevision/],
    ];

    for (const [value, expected] of cases) {
      expect(() => store.write(value)).toThrow(expected);
      expect(readFileSync(store.checkpointPath)).toEqual(before);
    }
  });

  it("v3 fileの欠落・未知key・未知版・revision・非正規化条件をstrictに拒否する", () => {
    const valid = orchestratorCheckpoint(1, undefined, ["tenant-a", "tenant-b"]);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["missing", {
        schemaVersion: TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION,
        boardInstanceId: BOARD_INSTANCE_ID,
        eventCursor: 1,
        targetIds: ["t_0000000000000001"],
        tenants: ["tenant-a", "tenant-b"],
        filterRevision: 1,
      }, /schema key/],
      ["unknown-key", { ...valid, extra: true }, /schema key/],
      ["unknown-version", { ...valid, schemaVersion: "task-await-checkpoint.v4" }, /schemaVersion/],
      ["revision", { ...valid, filterRevision: 2 }, /filterRevision/],
      ["tenant-order", { ...valid, tenants: ["tenant-b", "tenant-a"] }, /正規化/],
      ["tenant-duplicate", { ...valid, tenants: ["tenant-a", "tenant-a"] }, /正規化/],
      ["identity-space", { ...valid, orchestratorId: " orchestrator-main " }, /正規化/],
      ["identity-empty", { ...valid, orchestratorId: "   " }, /空/],
      ["identity-nul", { ...valid, orchestratorId: "orchestrator\0main" }, /NUL/],
      ["identity-non-string", { ...valid, orchestratorId: 42 }, /string/],
    ];

    for (const [name, value, expected] of cases) {
      const homePath = home();
      const seed = openOrchestrator(
        homePath,
        "orchestrator-main",
        ["tenant-a", "tenant-b"],
        `${name}.json`,
      );
      const target = seed.checkpointPath;
      seed.close();
      const raw = `${JSON.stringify(value)}\n`;
      writeFileSync(target, raw, { mode: 0o600 });
      const reader = openOrchestrator(
        homePath,
        "orchestrator-main",
        ["tenant-a", "tenant-b"],
        `${name}.json`,
      );
      expect(() => reader.read(), name).toThrow(expected);
      expect(readFileSync(target, "utf8")).toBe(raw);
      expect(() => reader.write(orchestratorCheckpoint(
        2,
        undefined,
        ["tenant-a", "tenant-b"],
      )), name).toThrow(expected);
      expect(readFileSync(target, "utf8")).toBe(raw);
      reader.close();
    }
  });

  it("v3の条件違いとv1/v2相互流用を暗黙変換せずfileを維持する", () => {
    const v3Home = home();
    const v3Seed = openOrchestrator(v3Home, "orchestrator-main", [], "v3.json");
    v3Seed.write(orchestratorCheckpoint(1));
    const v3Before = readFileSync(v3Seed.checkpointPath);
    v3Seed.close();

    const identityReader = openOrchestrator(v3Home, "orchestrator-other", [], "v3.json");
    expect(() => identityReader.read()).toThrow(/orchestratorId.*open条件/);
    expect(() => identityReader.write(orchestratorCheckpoint(
      2,
      undefined,
      undefined,
      "orchestrator-other",
    ))).toThrow(/orchestratorId.*open条件/);
    identityReader.close();

    const tenantReader = openOrchestrator(v3Home, "orchestrator-main", ["tenant-a"], "v3.json");
    expect(() => tenantReader.read()).toThrow(/tenants.*open条件/);
    expect(() => tenantReader.write(orchestratorCheckpoint(2, undefined, ["tenant-a"])))
      .toThrow(/tenants.*open条件/);
    tenantReader.close();

    const v1Reader = open(v3Home, "v3.json");
    expect(() => v1Reader.read()).toThrow(/schemaVersion.*open条件/);
    expect(() => v1Reader.write(checkpoint(2))).toThrow(/schemaVersion.*open条件/);
    v1Reader.close();

    const v2Reader = openTenant(v3Home, ["tenant-a"], "v3.json");
    expect(() => v2Reader.read()).toThrow(/schemaVersion.*open条件/);
    expect(() => v2Reader.write(tenantCheckpoint(2))).toThrow(/schemaVersion.*open条件/);
    v2Reader.close();
    expect(readFileSync(join(v3Home, "state", "task-await", "v3.json"))).toEqual(v3Before);

    const legacyCases: Array<[string, (homePath: string) => TaskAwaitCheckpointStore]> = [
      ["v1.json", (homePath) => open(homePath, "v1.json")],
      ["v2.json", (homePath) => openTenant(homePath, ["tenant-a"], "v2.json")],
    ];
    for (const [relativePath, openLegacy] of legacyCases) {
      const homePath = home();
      const legacy = openLegacy(homePath);
      if (relativePath === "v1.json") {
        legacy.write(checkpoint(1));
      } else {
        legacy.write(tenantCheckpoint(1));
      }
      const before = readFileSync(legacy.checkpointPath);
      legacy.close();
      const v3Reader = openOrchestrator(homePath, "orchestrator-main", [], relativePath);
      expect(() => v3Reader.read()).toThrow(/schemaVersion.*open条件/);
      expect(() => v3Reader.write(orchestratorCheckpoint(2))).toThrow(/schemaVersion.*open条件/);
      expect(readFileSync(v3Reader.checkpointPath)).toEqual(before);
      v3Reader.close();
    }
  });

  it("v3でもboard不一致・cursor逆行・同cursor target減少を拒否する", () => {
    const boardHome = home();
    const boardSeed = openOrchestrator(
      boardHome,
      "orchestrator-main",
      undefined,
      "board-v3.json",
      OTHER_BOARD_INSTANCE_ID,
    );
    boardSeed.write(orchestratorCheckpoint(
      1,
      undefined,
      undefined,
      undefined,
      OTHER_BOARD_INSTANCE_ID,
    ));
    const boardBefore = readFileSync(boardSeed.checkpointPath);
    boardSeed.close();
    const boardReader = openOrchestrator(boardHome, "orchestrator-main", undefined, "board-v3.json");
    expect(() => boardReader.read()).toThrow(/現在のboardと一致しません/);
    expect(() => boardReader.write(orchestratorCheckpoint(2)))
      .toThrow(/現在のboardと一致しません/);
    expect(readFileSync(boardReader.checkpointPath)).toEqual(boardBefore);
    boardReader.close();

    const homePath = home();
    const store = openOrchestrator(homePath, "orchestrator-main");
    store.write(orchestratorCheckpoint(10, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]));
    const before = readFileSync(store.checkpointPath);

    expect(() => store.write(orchestratorCheckpoint(
      11,
      undefined,
      undefined,
      undefined,
      OTHER_BOARD_INSTANCE_ID,
    ))).toThrow(/現在のboardと一致しません/);
    expect(() => store.write(orchestratorCheckpoint(9, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]))).toThrow(/逆行/);
    expect(() => store.write(orchestratorCheckpoint(
      10,
      ["t_0000000000000001"],
    ))).toThrow(/targetIdsを減らす/);
    expect(readFileSync(store.checkpointPath)).toEqual(before);
  });

  it("sidecar作成後のfsync失敗ではfdだけを閉じて作成したsidecarを残す", () => {
    const homePath = home();
    let sidecarFd: number | undefined;
    const fsyncError = Object.assign(new Error("simulated sidecar fsync failure"), { code: "EIO" });

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        fsyncCreatedSidecar: (fd) => {
          sidecarFd = fd;
          throw fsyncError;
        },
      },
    })).toThrow(fsyncError);

    expect(sidecarFd).toBeDefined();
    expect(() => fstatSync(sidecarFd ?? -1)).toThrow();
    expect(readdirSync(join(homePath, "state", "task-await", ".locks")))
      .toEqual([expect.stringMatching(/^[0-9a-f]{64}\.sqlite$/)]);
  });

  it("sidecar作成後のfsync失敗後も次のwatcherだけが同じlockを取得する", () => {
    const homePath = home();
    const fsyncError = Object.assign(new Error("simulated sidecar fsync failure"), { code: "EIO" });

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        fsyncCreatedSidecar: () => {
          throw fsyncError;
        },
      },
    })).toThrow(fsyncError);

    const locksPath = join(homePath, "state", "task-await", ".locks");
    const sidecarName = readdirSync(locksPath).find((name) => name.endsWith(".sqlite"));
    if (sidecarName === undefined) {
      throw new Error("fsync失敗後に残るsidecarを取得できませんでした");
    }
    const sidecarPath = join(locksPath, sidecarName);
    const sidecarIdentity = lstatSync(sidecarPath);
    const next = open(homePath);

    expect(lstatSync(next.sidecarPath).ino).toBe(sidecarIdentity.ino);
    expect(childLockProbeExitCode(next.sidecarPath)).toBe(CHILD_LOCK_BUSY_EXIT_CODE);
  });

  it("owner markerのrename前失敗ではtempを残さない", () => {
    const homePath = home();
    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryOwnerMarkerDurable: () => {
          throw new Error("simulated owner marker crash boundary");
        },
      },
    })).toThrow(/simulated owner marker crash boundary/);

    expect(readdirSync(join(homePath, "state", "task-await", ".locks"))
      .filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("temp fsync後・rename前の失敗では部分checkpointとtempを残さない", () => {
    const homePath = home();
    const store = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryCheckpointDurable: () => {
          throw new Error("simulated crash boundary");
        },
      },
    });
    stores.push(store);

    expect(() => store.write(checkpoint(1))).toThrow(/simulated crash boundary/);
    expect(existsSync(store.checkpointPath)).toBe(false);
    expect(readdirSync(join(homePath, "state", "task-await"))).toEqual([".locks"]);
  });

  it("atomic rename前の失敗は既存checkpointを変更しない", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.write(checkpoint(10));
    const checkpointPath = seed.checkpointPath;
    seed.close();
    const before = readFileSync(checkpointPath, "utf8");

    const failing = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryCheckpointDurable: () => {
          throw new Error("simulated crash boundary");
        },
      },
    });
    stores.push(failing);
    expect(() => failing.write(checkpoint(11))).toThrow(/simulated crash boundary/);
    expect(readFileSync(checkpointPath, "utf8")).toBe(before);
    expect(readdirSync(join(homePath, "state", "task-await")).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rename前にtempのinodeが差し替わった場合は拒否する", () => {
    const homePath = home();
    const store = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryCheckpointDurable: () => {
          const taskAwaitPath = join(homePath, "state", "task-await");
          const tempName = readdirSync(taskAwaitPath).find((name) => name.includes(".tmp-"));
          expect(tempName).toBeDefined();
          const tempPath = join(taskAwaitPath, tempName ?? "missing");
          rmSync(tempPath);
          writeFileSync(tempPath, "replacement", { mode: 0o600 });
        },
      },
    });
    stores.push(store);

    expect(() => store.write(checkpoint(1))).toThrow(/temp のinodeがrename前に変化/);
    expect(existsSync(store.checkpointPath)).toBe(false);
  });

  it.each([
    ["絶対path", "/tmp/watch.json", /相対path/],
    ["親参照", "../watch.json", /\.\./],
    ["予約領域", ".locks/watch.json", /予約領域/],
    ["大文字", "WATCH.json", /小文字ASCII/],
    ["不正文字", "watch?.json", /小文字ASCII/],
  ])("path封じ込めで%sを拒否する", (_label, relativePath, expected) => {
    const homePath = home();
    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath,
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(expected);
  });

  it("symlinkでtask-await外を指す親directoryを拒否する", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.close();
    const outside = mkdtempSync(join(tmpdir(), "hachi-task-await-outside-"));
    homes.push(outside);
    symlinkSync(outside, join(homePath, "state", "task-await", "alias"), "dir");

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "alias/watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/symlinkではない通常directory/);
  });

  it("存在しないcheckpoint parentを自動作成せずENOENTで拒否する", () => {
    const homePath = home();
    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "sub/w.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/ENOENT/);
    expect(existsSync(join(homePath, "state", "task-await", "sub"))).toBe(false);
  });

  it("0700で事前作成したcheckpoint parentの下で読み書きできる", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.close();
    const parentPath = join(homePath, "state", "task-await", "sub");
    mkdirSync(parentPath, { mode: 0o700 });
    chmodSync(parentPath, 0o700);

    const store = open(homePath, "sub/w.json");
    const expected = checkpoint(42);
    expect(store.checkpointPath).toBe(join(realpathSync.native(parentPath), "w.json"));
    expect(store.write(expected)).toEqual(expected);
    expect(store.read()).toEqual(expected);
    expect(existsSync(join(parentPath, "w.json"))).toBe(true);
  });

  it("不正modeのcheckpoint parentをfail-closedで拒否する", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.close();
    const parentPath = join(homePath, "state", "task-await", "sub");
    mkdirSync(parentPath, { mode: 0o700 });
    chmodSync(parentPath, 0o755);

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "sub/w.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/modeは700/);
  });

  it("checkpoint targetのsymlink・hard link・非regular・不正modeを拒否する", () => {
    const cases: Array<{
      name: string;
      prepare: (homePath: string, target: string) => void;
      expected: RegExp;
    }> = [
      {
        name: "symlink",
        prepare: (homePath, target) => {
          const outside = join(homePath, "outside.json");
          writeFileSync(outside, JSON.stringify(checkpoint(1)), { mode: 0o600 });
          symlinkSync(outside, target, "file");
        },
        expected: /symlinkではない通常file/,
      },
      {
        name: "hard-link",
        prepare: (homePath, target) => {
          const outside = join(homePath, "outside.json");
          writeFileSync(outside, JSON.stringify(checkpoint(1)), { mode: 0o600 });
          linkSync(outside, target);
        },
        expected: /hard link数は1/,
      },
      {
        name: "directory",
        prepare: (_homePath, target) => mkdirSync(target, { mode: 0o700 }),
        expected: /通常file/,
      },
      {
        name: "mode",
        prepare: (_homePath, target) => {
          writeFileSync(target, JSON.stringify(checkpoint(1)), { mode: 0o600 });
          chmodSync(target, 0o644);
        },
        expected: /modeは600/,
      },
    ];

    for (const testCase of cases) {
      const homePath = home();
      const seed = open(homePath, `${testCase.name}.json`);
      const target = seed.checkpointPath;
      seed.close();
      testCase.prepare(homePath, target);
      const reader = open(homePath, `${testCase.name}.json`);
      expect(() => reader.read(), testCase.name).toThrow(testCase.expected);
      reader.close();
    }
  });

  it("task-await directoryと.locks directoryのsymlink・不正modeを拒否する", () => {
    const taskAwaitSymlinkHome = home();
    const outsideTaskAwait = mkdtempSync(join(tmpdir(), "hachi-task-await-root-link-"));
    homes.push(outsideTaskAwait);
    mkdirSync(join(taskAwaitSymlinkHome, "state"), { mode: 0o700 });
    symlinkSync(outsideTaskAwait, join(taskAwaitSymlinkHome, "state", "task-await"), "dir");
    expect(() => openTaskAwaitCheckpointStore({
      home: taskAwaitSymlinkHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/task-await directory.*symlink/);

    const locksSymlinkHome = home();
    mkdirSync(join(locksSymlinkHome, "state", "task-await"), { recursive: true, mode: 0o700 });
    const outsideLocks = mkdtempSync(join(tmpdir(), "hachi-task-await-locks-link-"));
    homes.push(outsideLocks);
    symlinkSync(outsideLocks, join(locksSymlinkHome, "state", "task-await", ".locks"), "dir");
    expect(() => openTaskAwaitCheckpointStore({
      home: locksSymlinkHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/\.locks directory.*symlink/);

    const modeHome = home();
    mkdirSync(join(modeHome, "state", "task-await"), { recursive: true, mode: 0o700 });
    chmodSync(join(modeHome, "state", "task-await"), 0o755);
    expect(() => openTaskAwaitCheckpointStore({
      home: modeHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/modeは700/);

    const locksModeHome = home();
    mkdirSync(join(locksModeHome, "state", "task-await", ".locks"), {
      recursive: true,
      mode: 0o700,
    });
    chmodSync(join(locksModeHome, "state", "task-await", ".locks"), 0o755);
    expect(() => openTaskAwaitCheckpointStore({
      home: locksModeHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/\.locks directory.*modeは700/);

    const taskAwaitFileHome = home();
    mkdirSync(join(taskAwaitFileHome, "state"), { mode: 0o700 });
    writeFileSync(join(taskAwaitFileHome, "state", "task-await"), "", { mode: 0o600 });
    expect(() => openTaskAwaitCheckpointStore({
      home: taskAwaitFileHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/task-await directory.*通常directory/);

    const locksFileHome = home();
    mkdirSync(join(locksFileHome, "state", "task-await"), { recursive: true, mode: 0o700 });
    writeFileSync(join(locksFileHome, "state", "task-await", ".locks"), "", { mode: 0o600 });
    expect(() => openTaskAwaitCheckpointStore({
      home: locksFileHome,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/\.locks directory.*通常directory/);
  });

  it("task-await directoryの所有者不一致を拒否する", () => {
    const homePath = home();
    expectUnexpectedOwnerAtCheck(
      9,
      () => openTaskAwaitCheckpointStore({
        home: homePath,
        relativePath: "watch.json",
        boardInstanceId: BOARD_INSTANCE_ID,
      }),
      /task-await directory の所有者が現在userではありません/,
    );
  });

  it("task-await .locks directoryの所有者不一致を拒否する", () => {
    const homePath = home();
    expectUnexpectedOwnerAtCheck(
      15,
      () => openTaskAwaitCheckpointStore({
        home: homePath,
        relativePath: "watch.json",
        boardInstanceId: BOARD_INSTANCE_ID,
      }),
      /task-await \.locks directory の所有者が現在userではありません/,
    );
  });

  it("sidecarのsymlink・hard link・不正modeを拒否する", () => {
    const cases: Array<{
      name: string;
      prepare: (homePath: string, sidecarPath: string) => void;
      expected: RegExp;
    }> = [
      {
        name: "symlink",
        prepare: (homePath, sidecarPath) => {
          rmSync(sidecarPath);
          const outside = join(homePath, "outside.sqlite");
          writeFileSync(outside, "", { mode: 0o600 });
          symlinkSync(outside, sidecarPath, "file");
        },
        expected: /symlinkではない通常file/,
      },
      {
        name: "hard-link",
        prepare: (homePath, sidecarPath) => {
          rmSync(sidecarPath);
          const outside = join(homePath, "outside.sqlite");
          writeFileSync(outside, "", { mode: 0o600 });
          linkSync(outside, sidecarPath);
        },
        expected: /hard link数は1/,
      },
      {
        name: "mode",
        prepare: (_homePath, sidecarPath) => chmodSync(sidecarPath, 0o644),
        expected: /modeは600/,
      },
      {
        name: "directory",
        prepare: (_homePath, sidecarPath) => {
          rmSync(sidecarPath);
          mkdirSync(sidecarPath, { mode: 0o700 });
        },
        expected: /通常file/,
      },
    ];

    for (const testCase of cases) {
      const homePath = home();
      const seed = open(homePath, `${testCase.name}.json`);
      const sidecarPath = seed.sidecarPath;
      seed.close();
      testCase.prepare(homePath, sidecarPath);
      expect(() => openTaskAwaitCheckpointStore({
        home: homePath,
        relativePath: `${testCase.name}.json`,
        boardInstanceId: BOARD_INSTANCE_ID,
      }), testCase.name).toThrow(testCase.expected);
    }
  });

  it("sidecarの所有者不一致を拒否する", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.close();

    expectUnexpectedOwnerAtCheck(
      11,
      () => openTaskAwaitCheckpointStore({
        home: homePath,
        relativePath: "watch.json",
        boardInstanceId: BOARD_INSTANCE_ID,
      }),
      /task-await sidecar lock の所有者が現在userではありません/,
    );
  });

  it("EEXIST経路の検査失敗では既存sidecarを削除しない", () => {
    const homePath = home();
    const seed = open(homePath, "existing-sidecar.json");
    const existingSidecarPath = seed.sidecarPath;
    seed.close();
    const existingIdentity = lstatSync(existingSidecarPath);
    chmodSync(existingSidecarPath, 0o644);

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "existing-sidecar.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/modeは600/);

    expect(existsSync(existingSidecarPath)).toBe(true);
    expect(lstatSync(existingSidecarPath).ino).toBe(existingIdentity.ino);
  });

  it("同一processで同じcheckpointを2本openすると2本目を拒否する", () => {
    const homePath = home();
    const first = open(homePath);
    const sidecarStat = lstatSync(first.sidecarPath);
    expect(sidecarStat.isFile()).toBe(true);
    expect(sidecarStat.mode & 0o777).toBe(0o600);
    expect(sidecarStat.nlink).toBe(1);

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/別watcherが使用中/);
  });

  it("同一processの2本目を拒否した後も別processからsidecar lockを取得できない", () => {
    const homePath = home();
    const first = open(homePath);

    expect(() => openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/別watcherが使用中/);
    expect(childLockProbeExitCode(first.sidecarPath)).toBe(CHILD_LOCK_BUSY_EXIT_CODE);
  });

  it("元storeのlock喪失後に競合processが取得すると次の操作を拒否する", async () => {
    const homePath = home();
    const first = open(homePath);

    // SQLite外で同じinodeのfdをcloseしてOS lockを落としても、JS flagだけで継続しない。
    const siblingFd = openSync(first.sidecarPath, "r");
    closeSync(siblingFd);
    const child = startChildLockHolder(first.sidecarPath);
    try {
      await waitForChildLockHolder(child);
      expect(() => first.read()).toThrow(/owner marker が現在processと一致しません/);
    } finally {
      await stopChildLockHolder(child);
    }
  });

  it("close後は同一processと別processの双方からsidecar lockを取得できる", () => {
    const homePath = home();
    const first = open(homePath);
    const sidecarPath = first.sidecarPath;

    first.close();
    const resumed = open(homePath);
    expect(resumed.read()).toBeNull();
    resumed.close();
    expect(childLockProbeExitCode(sidecarPath)).toBe(CHILD_LOCK_ACQUIRED_EXIT_CODE);
  });

  it("保持中にsidecarのinodeが差し替わった場合は拒否する", () => {
    const homePath = home();
    let replaced = false;
    const store = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryCheckpointDurable: () => {
          rmSync(store.sidecarPath);
          writeFileSync(store.sidecarPath, "replacement", { mode: 0o600 });
          replaced = true;
        },
      },
    });
    stores.push(store);

    expect(() => store.write(checkpoint(1))).toThrow(/sidecar lock の(?:hard link数|inodeまたは所有者が変化)/);
    expect(replaced).toBe(true);
    expect(existsSync(store.checkpointPath)).toBe(false);
  });

  it("大文字小文字違いの別名は並行初回作成のrename直前でも拒否する", () => {
    const homePath = home();
    let aliasRejected = false;
    const lower = openTaskAwaitCheckpointStore({
      home: homePath,
      relativePath: "watch.json",
      boardInstanceId: BOARD_INSTANCE_ID,
      testHooks: {
        afterTemporaryCheckpointDurable: () => {
          expect(() => openTaskAwaitCheckpointStore({
            home: homePath,
            relativePath: "WATCH.json",
            boardInstanceId: BOARD_INSTANCE_ID,
          })).toThrow(/小文字ASCII/);
          aliasRejected = true;
        },
      },
    });
    stores.push(lower);

    lower.write(checkpoint(1));
    expect(aliasRejected).toBe(true);
    expect(existsSync(lower.checkpointPath)).toBe(true);
    expect(readdirSync(join(homePath, "state", "task-await", ".locks"))
      .filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
  });

  it("壊れたstateと未知schemaを暗黙resetしない", () => {
    const cases: Array<[string, string | Buffer, RegExp]> = [
      ["broken", "{ broken", /JSONが壊れています/],
      ["unknown-version", JSON.stringify({ ...checkpoint(1), schemaVersion: 1 }), /schemaVersion/],
      ["unknown-key", JSON.stringify({ ...checkpoint(1), extra: true }), /schema key/],
      ["duplicate-target", JSON.stringify(checkpoint(1, [
        "t_0000000000000001",
        "t_0000000000000001",
      ])), /重複/],
      ["invalid-utf8", Buffer.from([0xff]), /UTF-8/],
    ];

    for (const [name, raw, expected] of cases) {
      const homePath = home();
      const seed = open(homePath, `${name}.json`);
      const target = seed.checkpointPath;
      seed.close();
      writeFileSync(target, raw, { mode: 0o600 });
      const reader = open(homePath, `${name}.json`);
      expect(() => reader.read(), name).toThrow(expected);
      expect(readFileSync(target)).toEqual(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
      reader.close();
    }
  });

  it("checkpointの所有者不一致を拒否する", () => {
    const homePath = home();
    const seed = open(homePath);
    seed.write(checkpoint(1));
    seed.close();
    const reader = open(homePath);

    expectUnexpectedOwnerAtCheck(
      18,
      () => reader.read(),
      /task-await checkpoint の所有者が現在userではありません/,
    );
  });

  it("checkpointとsidecarのsize上限超過を拒否する", () => {
    const checkpointHome = home();
    const checkpointSeed = open(checkpointHome, "large.json");
    const checkpointPath = checkpointSeed.checkpointPath;
    checkpointSeed.close();
    writeFileSync(checkpointPath, Buffer.alloc(TASK_AWAIT_CHECKPOINT_MAX_BYTES + 1), { mode: 0o600 });
    const checkpointReader = open(checkpointHome, "large.json");
    expect(() => checkpointReader.read()).toThrow(/size上限/);
    checkpointReader.close();

    const sidecarHome = home();
    const sidecarSeed = open(sidecarHome, "large-sidecar.json");
    const sidecarPath = sidecarSeed.sidecarPath;
    sidecarSeed.close();
    writeFileSync(sidecarPath, Buffer.alloc(TASK_AWAIT_LOCK_MAX_BYTES + 1));
    expect(() => openTaskAwaitCheckpointStore({
      home: sidecarHome,
      relativePath: "large-sidecar.json",
      boardInstanceId: BOARD_INSTANCE_ID,
    })).toThrow(/size上限/);
  });

  it("boardInstanceId不一致を暗黙resetしない", () => {
    const homePath = home();
    const original = open(homePath, "board.json", BOARD_INSTANCE_ID);
    original.write(checkpoint(8));
    const before = readFileSync(original.checkpointPath);
    original.close();

    const mismatched = open(homePath, "board.json", OTHER_BOARD_INSTANCE_ID);
    expect(() => mismatched.read()).toThrow(/現在のboardと一致しません/);
    expect(readFileSync(mismatched.checkpointPath)).toEqual(before);
  });

  it("eventCursor逆行と同一cursorでのtarget縮小を拒否する", () => {
    const homePath = home();
    const store = open(homePath);
    store.write(checkpoint(10, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]));
    const before = readFileSync(store.checkpointPath);

    expect(() => store.write(checkpoint(9, [
      "t_0000000000000001",
      "t_0000000000000002",
    ]))).toThrow(/逆行/);
    expect(() => store.write(checkpoint(10, ["t_0000000000000001"]))).toThrow(/targetIdsを減らす/);
    expect(readFileSync(store.checkpointPath)).toEqual(before);
  });
});
