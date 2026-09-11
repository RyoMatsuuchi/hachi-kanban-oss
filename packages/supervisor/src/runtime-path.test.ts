import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimePath, isDirectory, VERIFY_RUNTIME_PATH_SOURCE } from "./runtime-path.js";

describe("buildRuntimePath（docs/contract.md §39.1）", () => {
  const createdDirectories: string[] = [];

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), "hk-runtime-path-"));
    createdDirectories.push(home);
    return home;
  }

  it("存在する既知3 directoryを規定順で基底PATHへ前置する", () => {
    const home = createHome();
    const candidates = [join(home, ".vite-plus/bin"), join(home, ".local/bin"), join(home, ".n/bin")];
    for (const candidate of candidates) {
      mkdirSync(candidate, { recursive: true });
    }

    const result = buildRuntimePath({ home, basePath: "/usr/bin:/bin", directoryExists: isDirectory });

    expect(result).toEqual({
      path: [...candidates, "/usr/bin", "/bin"].join(":"),
      source: VERIFY_RUNTIME_PATH_SOURCE,
      sensitiveValues: [[...candidates, "/usr/bin", "/bin"].join(":"), home],
    });
  });

  it("不在directoryをskipし、既知directoryと基底PATHの重複を除去する", () => {
    const home = createHome();
    const vitePlusBin = join(home, ".vite-plus/bin");
    const nBin = join(home, ".n/bin");
    mkdirSync(vitePlusBin, { recursive: true });
    mkdirSync(nBin, { recursive: true });

    const result = buildRuntimePath({
      home,
      basePath: `/usr/bin:${vitePlusBin}:/usr/bin:${nBin}`,
      directoryExists: isDirectory,
    });

    expect(result.path).toBe(`${vitePlusBin}:${nBin}:/usr/bin`);
  });

  it("基底PATHが空でも存在する既知directoryだけで構築する", () => {
    const home = createHome();
    const localBin = join(home, ".local/bin");
    mkdirSync(localBin, { recursive: true });

    expect(buildRuntimePath({ home, basePath: "", directoryExists: isDirectory }).path).toBe(localBin);
  });

  it("HOME不明または相対HOMEでは既知directoryを探索せず基底PATHだけを正規化する", () => {
    const inspected: string[] = [];
    const directoryExists = (path: string): boolean => {
      inspected.push(path);
      return true;
    };

    expect(buildRuntimePath({ home: undefined, basePath: "/usr/bin:/usr/bin:/bin", directoryExists }).path).toBe(
      "/usr/bin:/bin",
    );
    expect(buildRuntimePath({ home: "relative/home", basePath: "/bin", directoryExists }).path).toBe("/bin");
    expect(inspected).toEqual([]);
  });

  it("launchd相当の基底PATHでは見えないfake vpをruntime-path-v1適用後に解決できる", () => {
    const home = createHome();
    const vitePlusBin = join(home, ".vite-plus/bin");
    const baseBin = join(home, "launchd-bin");
    const vpPath = join(vitePlusBin, "vp");
    mkdirSync(vitePlusBin, { recursive: true });
    mkdirSync(baseBin, { recursive: true });
    writeFileSync(vpPath, "#!/bin/sh\nprintf 'fake-vp-ok\\n'\n", { mode: 0o700 });
    chmodSync(vpPath, 0o700);

    const before = spawnSync("vp", [], { env: { PATH: baseBin }, encoding: "utf8" });
    const runtimePath = buildRuntimePath({ home, basePath: baseBin, directoryExists: isDirectory });
    const after = spawnSync("vp", [], { env: { PATH: runtimePath.path }, encoding: "utf8" });

    expect(before.error).toMatchObject({ code: "ENOENT" });
    expect(runtimePath.source).toBe("runtime-path-v1");
    expect(runtimePath.sensitiveValues).toEqual([runtimePath.path, home]);
    expect(after.status).toBe(0);
    expect(after.stdout).toBe("fake-vp-ok\n");
  });
});
