import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";

interface ChildOutcome {
  ok: boolean;
  errorCode: string;
  errorMessage: string;
  elapsedMs: number;
}

interface ChildRun {
  child: ChildProcess;
  result: Promise<ChildOutcome>;
}

interface V24Fixture {
  dbPath: string;
  terminalLaunchId: string | null;
}

const BETTER_SQLITE3_MODULE_URL = pathToFileURL(
  createRequire(import.meta.url).resolve("better-sqlite3"),
).href;
const DB_MODULE_URL = new URL("./db.ts", import.meta.url).href;
const CHILD_RUNNER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import Database from ${JSON.stringify(BETTER_SQLITE3_MODULE_URL)};

const [mode, ...args] = process.argv.slice(2);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const waitForFile = (path) => {
  const deadline = Date.now() + 12_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("child barrier timeout: " + path);
    Atomics.wait(waitBuffer, 0, 0, 20);
  }
};
const outcome = (ok, error, startedAt) => ({
  ok,
  errorCode: typeof error?.code === "string" ? error.code : "",
  errorMessage: error instanceof Error ? error.message : error === undefined ? "" : String(error),
  elapsedMs: Date.now() - startedAt,
});
const printOutcome = (value) => process.stdout.write(JSON.stringify(value));

if (mode === "hold-writer") {
  const [dbPath, readyPath, releasePath] = args;
  const startedAt = Date.now();
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE schema_migrations SET applied_at = applied_at + 1 WHERE version = 24").run();
    writeFileSync(readyPath, "ready");
    waitForFile(releasePath);
    db.exec("COMMIT");
    printOutcome(outcome(true, undefined, startedAt));
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    printOutcome(outcome(false, error, startedAt));
  } finally {
    db?.close();
  }
} else if (mode === "old-deferred-v25") {
  const [dbPath, validatedPath, releasePath] = args;
  const startedAt = Date.now();
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN");
    db.prepare("SELECT version FROM schema_migrations WHERE version = 25").get();
    db.prepare("PRAGMA table_info(orchestrator_successor_launches)").all();
    db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_successor_launches'",
    ).get();
    db.prepare("PRAGMA index_info(idx_orchestrator_successor_runtime)").all();
    db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_orchestrator_successor_runtime'",
    ).get();
    writeFileSync(validatedPath, "validated");
    waitForFile(releasePath);
    db.exec("ALTER TABLE orchestrator_successor_launches ADD COLUMN tmux_socket_path TEXT NOT NULL DEFAULT ''");
    db.exec("COMMIT");
    printOutcome(outcome(true, undefined, startedAt));
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    printOutcome(outcome(false, error, startedAt));
  } finally {
    db?.close();
  }
} else if (mode === "open-store-at-v25") {
  const [dbPath, modePath, enteredPath, releasePath, dbModuleUrl] = args;
  const originalTransaction = Database.prototype.transaction;
  Database.prototype.transaction = function (callback) {
    const transaction = originalTransaction.call(this, callback);
    if (!String(callback).includes("migrateOrchestratorSuccessorV25")) return transaction;
    const deferred = (...values) => {
      writeFileSync(modePath, "deferred");
      return transaction(...values);
    };
    deferred.default = deferred;
    deferred.deferred = deferred;
    deferred.immediate = (...values) => {
      writeFileSync(modePath, "immediate");
      writeFileSync(enteredPath, "entered");
      waitForFile(releasePath);
      return transaction.immediate(...values);
    };
    deferred.exclusive = (...values) => transaction.exclusive(...values);
    return deferred;
  };

  const startedAt = Date.now();
  let store;
  try {
    const { SqliteKanbanStore: ChildStore } = await import(dbModuleUrl);
    store = new ChildStore(dbPath);
    printOutcome(outcome(true, undefined, startedAt));
  } catch (error) {
    printOutcome(outcome(false, error, startedAt));
  } finally {
    store?.close();
  }
} else {
  throw new Error("unknown child mode: " + mode);
}
`;

function downgradeToV24(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      DELETE FROM schema_migrations WHERE version = 25;
      DROP INDEX idx_orchestrator_successor_runtime;
      ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_socket_path;
      ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_pid;
      ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_start_time;
      ALTER TABLE orchestrator_successor_launches DROP COLUMN tmux_server_lifetime_hash;
      CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
        ON orchestrator_successor_launches(observed_host_id, tmux_pane)
        WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> ''
          AND status IN ('runtime_bound', 'attested', 'accepting', 'succeeded', 'stop_pending', 'uncertain');
    `);
  } finally {
    db.close();
  }
}

function createV24Fixture(directory: string, terminalOwner = false): V24Fixture {
  const dbPath = join(directory, "kanban.db");
  const store = new SqliteKanbanStore(dbPath);
  let terminalLaunchId: string | null = null;
  if (terminalOwner) {
    const now = Math.floor(Date.now() / 1000);
    const orchestrator = store.registerOrchestrator({
      label: "bootstrap-contention",
      project: "hachi-kanban",
      repoCommonDir: "/repo/bootstrap-contention/.git",
    });
    const source = store.startOrchestratorSession({ orchestratorId: orchestrator.id });
    terminalLaunchId = store.armSuccessorLaunch({
      orchestratorId: orchestrator.id,
      targetProvider: "codex",
      sourceSessionId: source.id,
      sourceGeneration: source.generation,
      canonicalCwd: "/repo/bootstrap-contention",
      hostId: "host-bootstrap-contention",
      launchNonceHash: "1".repeat(64),
      plannedTmuxSession: "tmux-bootstrap-contention",
      hookDefinitionHash: "2".repeat(64),
      hookExecutableHash: "3".repeat(64),
      runtimeDeadlineAt: now + 60,
      attestationDeadlineAt: now + 120,
      kind: "handoff",
      handoffTokenFenceHash: "4".repeat(64),
      handoffExpiresAt: now + 120,
      now,
    }).id;
  }
  store.close();

  if (terminalLaunchId !== null) {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `UPDATE orchestrator_successor_launches
         SET status = 'succeeded', observed_host_id = 'legacy-terminal-host', tmux_session = planned_tmux_session,
             tmux_pane = '%71', pane_pid = 17001, process_group_id = 18001,
             owner_nonce_hash = ?, runtime_ownership_claimed = 1, revision = 7, terminal_at = ?
         WHERE id = ?`,
      ).run("a".repeat(64), Math.floor(Date.now() / 1000), terminalLaunchId);
    } finally {
      db.close();
    }
  }
  downgradeToV24(dbPath);
  return { dbPath, terminalLaunchId };
}

function startChild(
  runnerPath: string,
  mode: string,
  args: readonly string[],
  children: ChildProcess[],
): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, mode, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const result = new Promise<ChildOutcome>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`DB contention child がtimeoutしました: mode=${mode}`));
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || stdout.length === 0) {
        rejectPromise(new Error(
          `DB contention child が異常終了しました: mode=${mode}, code=${code}, signal=${signal}, stderr=${stderr}`,
        ));
        return;
      }
      resolvePromise(JSON.parse(stdout) as ChildOutcome);
    });
  });
  void result.catch(() => undefined);
  return { child, result };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`DB contention marker がtimeoutしました: ${path}`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return readFileSync(path, "utf8");
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    child.kill("SIGKILL");
  });
}

describe("DB bootstrap の v25 writer contention", () => {
  const directories: string[] = [];
  const children: ChildProcess[] = [];

  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), "hachi-db-bootstrap-contention-"));
    directories.push(path);
    return path;
  }

  function runner(directoryPath: string): string {
    const runnerPath = join(directoryPath, "db-contention-runner.mjs");
    writeFileSync(runnerPath, CHILD_RUNNER_SOURCE, { mode: 0o600 });
    return runnerPath;
  }

  afterEach(async () => {
    for (const child of children.splice(0)) {
      await killChild(child);
    }
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("旧deferred経路はv25検証後に別writerがcommitするとSQLITE_BUSY_SNAPSHOTを再現する", async () => {
    const dir = directory();
    const fixture = createV24Fixture(dir);
    const validatedPath = join(dir, "old-validated");
    const releasePath = join(dir, "old-release");
    const oldMigration = startChild(
      runner(dir),
      "old-deferred-v25",
      [fixture.dbPath, validatedPath, releasePath],
      children,
    );
    await waitForFile(validatedPath);

    const writer = new Database(fixture.dbPath);
    try {
      writer.prepare(
        `UPDATE schema_migrations SET applied_at = applied_at + 1 WHERE version = 24`,
      ).run();
    } finally {
      writer.close();
    }
    writeFileSync(releasePath, "release");

    const result = await oldMigration.result;
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SQLITE_BUSY_SNAPSHOT",
    });
    expect(result.errorMessage).toContain("database is locked");
  });

  it("v25はIMMEDIATEで検証前にwriter予約し、短時間writerの解放後にupgradeを完了する", async () => {
    const dir = directory();
    const fixture = createV24Fixture(dir, true);
    const childRunner = runner(dir);
    const modePath = join(dir, "migration-mode");
    const enteredPath = join(dir, "migration-entered");
    const migrationReleasePath = join(dir, "migration-release");
    const writerReadyPath = join(dir, "writer-ready");
    const writerReleasePath = join(dir, "writer-release");
    const migration = startChild(
      childRunner,
      "open-store-at-v25",
      [fixture.dbPath, modePath, enteredPath, migrationReleasePath, DB_MODULE_URL],
      children,
    );
    expect(await waitForFile(modePath)).toBe("immediate");
    await waitForFile(enteredPath);

    const writer = startChild(
      childRunner,
      "hold-writer",
      [fixture.dbPath, writerReadyPath, writerReleasePath],
      children,
    );
    await waitForFile(writerReadyPath);
    writeFileSync(migrationReleasePath, "release");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(migration.child.exitCode).toBeNull();
    writeFileSync(writerReleasePath, "release");

    expect(await writer.result).toMatchObject({ ok: true });
    expect(await migration.result).toMatchObject({ ok: true });
    const check = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(check.prepare(
        `SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25`,
      ).get()).toEqual({ count: 1 });
      expect(check.prepare(
        `SELECT runtime_ownership_claimed FROM orchestrator_successor_launches WHERE id = ?`,
      ).get(fixture.terminalLaunchId)).toEqual({ runtime_ownership_claimed: 0 });
      expect(check.prepare(`PRAGMA index_info(idx_orchestrator_successor_runtime)`).all()).toMatchObject([
        { name: "observed_host_id" },
        { name: "tmux_socket_path" },
        { name: "tmux_server_lifetime_hash" },
        { name: "tmux_pane" },
      ]);
    } finally {
      check.close();
    }
  });

  it("5秒を超えてwriterが占有するとbusy_timeoutの元エラーを維持する", async () => {
    const dir = directory();
    const fixture = createV24Fixture(dir);
    const childRunner = runner(dir);
    const modePath = join(dir, "timeout-mode");
    const enteredPath = join(dir, "timeout-entered");
    const migrationReleasePath = join(dir, "timeout-migration-release");
    const writerReadyPath = join(dir, "timeout-writer-ready");
    const writerReleasePath = join(dir, "timeout-writer-release");
    const migration = startChild(
      childRunner,
      "open-store-at-v25",
      [fixture.dbPath, modePath, enteredPath, migrationReleasePath, DB_MODULE_URL],
      children,
    );
    expect(await waitForFile(modePath)).toBe("immediate");
    await waitForFile(enteredPath);

    const writer = startChild(
      childRunner,
      "hold-writer",
      [fixture.dbPath, writerReadyPath, writerReleasePath],
      children,
    );
    await waitForFile(writerReadyPath);
    writeFileSync(migrationReleasePath, "release");

    const result = await migration.result;
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SQLITE_BUSY",
    });
    expect(result.errorMessage).toContain("database is locked");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(4_500);
    writeFileSync(writerReleasePath, "release");
    expect(await writer.result).toMatchObject({ ok: true });
  }, 15_000);

  it("constructorは部分schemaの元エラーを維持し、失敗したDBをcloseする", () => {
    const dir = directory();
    const fixture = createV24Fixture(dir);
    const raw = new Database(fixture.dbPath);
    try {
      raw.exec(
        `ALTER TABLE orchestrator_successor_launches
         ADD COLUMN tmux_socket_path TEXT NOT NULL DEFAULT ''`,
      );
    } finally {
      raw.close();
    }

    const originalClose = Database.prototype.close;
    const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (
      this: Database.Database,
    ): Database.Database {
      originalClose.call(this);
      throw new Error("close failure sentinel");
    });
    expect(() => new SqliteKanbanStore(fixture.dbPath)).toThrow(
      "successor launch v25 migrationのruntime identity列が部分適用されています",
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("migration記録済みの不正runtime indexを推測修復せずfail-closedにする", () => {
    const dir = directory();
    const dbPath = join(dir, "invalid-index.db");
    new SqliteKanbanStore(dbPath).close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP INDEX idx_orchestrator_successor_runtime;
        CREATE UNIQUE INDEX idx_orchestrator_successor_runtime
          ON orchestrator_successor_launches(observed_host_id, tmux_pane)
          WHERE runtime_ownership_claimed = 1 AND observed_host_id <> '' AND tmux_pane <> '';
      `);
    } finally {
      raw.close();
    }

    expect(() => new SqliteKanbanStore(dbPath)).toThrow(
      "successor launch v25 migrationのruntime authority indexが欠落または不正です",
    );
  });
});
