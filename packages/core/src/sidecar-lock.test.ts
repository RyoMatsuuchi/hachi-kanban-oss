import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SidecarLockBusyError,
  acquireSidecarLock,
  type AcquireSidecarLockOptions,
  type SidecarLock,
} from "./sidecar-lock.js";

const LOCK_MAX_BYTES = 1024 * 1024;

function options(directory: string): AcquireSidecarLockOptions {
  return {
    lockPath: join(directory, "worker.sqlite"),
    ownerMarkerPath: join(directory, "worker.owner"),
    recheckDirectoryPaths: [directory],
    maxBytes: LOCK_MAX_BYTES,
  };
}

function writeChildHolder(directory: string): string {
  const runnerPath = join(directory, "sidecar-holder.mjs");
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "src/sidecar-lock.ts")).href;
  writeFileSync(
    runnerPath,
    `import { acquireSidecarLock } from ${JSON.stringify(moduleUrl)};\n` +
      `const [lockPath, ownerMarkerPath, directory] = process.argv.slice(2);\n` +
      `const lock = acquireSidecarLock({\n` +
      `  lockPath,\n` +
      `  ownerMarkerPath,\n` +
      `  recheckDirectoryPaths: [directory],\n` +
      `  maxBytes: ${LOCK_MAX_BYTES},\n` +
      `});\n` +
      `lock.assertOpenAndLocked();\n` +
      `process.stdout.write("ready\\n");\n` +
      `setInterval(() => lock.assertOpenAndLocked(), 100);\n`,
    { mode: 0o600 },
  );
  return runnerPath;
}

function startChildHolder(
  runner: string,
  lockOptions: AcquireSidecarLockOptions,
  lockDirectory: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      runner,
      lockOptions.lockPath,
      lockOptions.ownerMarkerPath,
      lockDirectory,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("sidecar lock holder のstdioを取得できませんでした");
  }
  let errorOutput = "";
  stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8");
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`sidecar lock holder の起動がtimeoutしました: ${errorOutput}`));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString("utf8").includes("ready")) {
        return;
      }
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectPromise(new Error(
        `sidecar lock holder が取得前に終了しました: code=${code}, signal=${signal}, stderr=${errorOutput}`,
      ));
    };
    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("sidecar lock holder のSIGKILL終了がtimeoutしました"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = (): void => {
      cleanup();
      resolvePromise();
    };
    child.on("error", onError);
    child.on("exit", onExit);
    child.kill("SIGKILL");
  });
}

describe("sidecar lock", () => {
  const directories: string[] = [];
  const locks: SidecarLock[] = [];
  const children: ChildProcess[] = [];

  function directory(): string {
    const path = realpathSync.native(mkdtempSync(join(tmpdir(), "hachi-sidecar-lock-")));
    chmodSync(path, 0o700);
    directories.push(path);
    return path;
  }

  afterEach(async () => {
    for (const child of children.splice(0)) {
      await killChild(child);
    }
    for (const lock of locks.splice(0)) {
      try {
        lock.close();
      } catch {
        // inode差し替え後でも残りのtest cleanupを続ける。
      }
    }
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("保持中のlockに対する2本目の取得をfail-closedで拒否する", async () => {
    const lockOptions = options(directory());
    const lockDirectory = dirname(lockOptions.lockPath);
    const child = startChildHolder(writeChildHolder(lockDirectory), lockOptions, lockDirectory);
    children.push(child);
    await waitForReady(child);

    expect(() => acquireSidecarLock(lockOptions)).toThrow(SidecarLockBusyError);
    expect(child.exitCode).toBeNull();
  });

  it("同じinodeを指す別pathの取得をfd open前に拒否して先行lockを維持する", () => {
    const lockOptions = options(directory());
    writeFileSync(lockOptions.lockPath, "", { mode: 0o600 });
    const lock = acquireSidecarLock(lockOptions);
    locks.push(lock);
    const aliasPath = join(dirname(lockOptions.lockPath), "worker-alias.sqlite");
    linkSync(lockOptions.lockPath, aliasPath);

    expect(() => acquireSidecarLock({ ...lockOptions, lockPath: aliasPath }))
      .toThrow(SidecarLockBusyError);

    unlinkSync(aliasPath);
    expect(() => lock.assertOpenAndLocked()).not.toThrow();
  });

  it("保持中にlock pathnameを別inodeへ差し替えると以後の検証を拒否する", () => {
    const lockOptions = options(directory());
    const lock = acquireSidecarLock(lockOptions);
    locks.push(lock);

    unlinkSync(lockOptions.lockPath);
    writeFileSync(lockOptions.lockPath, "replacement", { mode: 0o600 });
    chmodSync(lockOptions.lockPath, 0o600);

    expect(() => lock.assertOpenAndLocked())
      .toThrow(/sidecar lock の(?:hard link数|inodeまたは所有者が変化)/);
  });

  it("保持processがSIGKILLで消えた後は次の取得に成功する", async () => {
    const lockOptions = options(directory());
    const lockDirectory = dirname(lockOptions.lockPath);
    const runner = writeChildHolder(lockDirectory);
    const child = startChildHolder(runner, lockOptions, lockDirectory);
    children.push(child);
    await waitForReady(child);
    await killChild(child);

    const resumed = acquireSidecarLock(lockOptions);
    locks.push(resumed);
    expect(() => resumed.assertOpenAndLocked()).not.toThrow();
  });
});
