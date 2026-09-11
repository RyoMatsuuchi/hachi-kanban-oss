import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExternalRuntimeGenerationRoot,
  type ExternalRuntimeGenerationRootFs,
} from "./external-runtime-generation-root.js";

describe("external runtime generation root authority", () => {
  const paths: string[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;

  afterEach(() => {
    for (const path of paths.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
  });

  function tempRoot(label: string): string {
    const path = mkdtempSync(join(process.cwd(), `.external-root-${label}-`));
    paths.push(path);
    chmodSync(path, 0o700);
    return path;
  }

  it("HERMES_HOME keyが存在すればcustom rootをdefaultより優先しbyte-exactで固定する", () => {
    const custom = tempRoot("custom");
    const accountHome = tempRoot("home");
    mkdirSync(join(accountHome, ".hermes-hachi-dev"), { mode: 0o700 });
    const result = resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: custom },
      accountHome,
      uid,
    });
    expect(result).toMatchObject({ ok: true, root: custom, source: "environment", uid });
    expect(result.ok && { dev: result.dev, ino: result.ino }).toEqual({
      dev: lstatSync(custom).dev,
      ino: lstatSync(custom).ino,
    });
    expect(result.ok && result.ancestry.at(-1)).toEqual({
      path: custom,
      dev: lstatSync(custom).dev,
      ino: lstatSync(custom).ino,
      uid: lstatSync(custom).uid,
      mode: lstatSync(custom).mode,
    });
  });

  it("key欠測時だけaccount home配下のdefaultを採用する", () => {
    const accountHome = tempRoot("default-home");
    const expected = join(accountHome, ".hermes-hachi-dev");
    mkdirSync(expected, { mode: 0o700 });
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HOME: tempRoot("ignored-env-home") },
      accountHome,
      uid,
    })).toMatchObject({
      ok: true,
      root: expected,
      source: "default",
      uid,
    });
  });

  it.each([
    ["", "empty"],
    ["relative/root", "relative"],
    ["/tmp//duplicate", "noncanonical"],
    ["/tmp/trailing/", "noncanonical"],
    ["/tmp/../escape", "noncanonical"],
  ] as const)("invalid lexical root %s をdefaultへfallbackしない", (configured, code) => {
    const result = resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: configured },
      accountHome: "/unused",
      uid,
    });
    expect(result).toMatchObject({ ok: false, code, source: "environment" });
  });

  it("missing/symlink/owner/mode/permissionをすべてfail-closedにする", () => {
    const missing = join(tempRoot("missing-parent"), "missing");
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: missing }, accountHome: "/unused", uid,
    })).toMatchObject({ ok: false, code: "missing" });

    const target = tempRoot("symlink-target");
    const link = `${target}-link`;
    paths.push(link);
    symlinkSync(target, link);
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: link }, accountHome: "/unused", uid,
    })).toMatchObject({ ok: false });

    const owner = tempRoot("owner");
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: owner }, accountHome: "/unused", uid: uid + 1,
    })).toMatchObject({ ok: false, code: "owner_mismatch" });

    const mode = tempRoot("mode");
    chmodSync(mode, 0o720);
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: mode }, accountHome: "/unused", uid,
    })).toMatchObject({ ok: false, code: "mode_mismatch" });

    const deniedFs: ExternalRuntimeGenerationRootFs = {
      realpath: (): never => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      lstat: (): never => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    expect(resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: owner }, accountHome: "/unused", uid, fs: deniedFs,
    })).toMatchObject({ ok: false, code: "permission_denied" });
  });
});
