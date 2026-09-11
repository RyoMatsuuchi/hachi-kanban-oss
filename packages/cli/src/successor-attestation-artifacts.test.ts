import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, normalize, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT,
  CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH,
  CODEX_SUCCESSOR_HOOK_COMMAND,
  CODEX_SUCCESSOR_HOOK_MATCHER,
  CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS,
  CODEX_SUCCESSOR_MANIFEST_SCHEMA,
  CODEX_SUCCESSOR_SESSION_START_GROUP,
  SuccessorAttestationArtifactError,
  createSuccessorAttestationArtifactResolver,
  expectedCodexSuccessorHookDefinitionHash,
  renderCodexSuccessorHookTemplate,
  type CodexSuccessorAttestationManifest,
  type SuccessorAttestationArtifactFileSystem,
  type SuccessorAttestationArtifactResolver,
} from "./successor-attestation-artifacts.js";

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ArtifactFixture {
  root: string;
  hachiHome: string;
  codexHome: string;
  hooksPath: string;
  helperPath: string;
  manifestPath: string;
  helperBytes: Buffer;
  manifest: CodexSuccessorAttestationManifest;
  resolver: SuccessorAttestationArtifactResolver;
}

const roots: string[] = [];

function installedHooks(groups: unknown[] = [CODEX_SUCCESSOR_SESSION_START_GROUP]): string {
  return `${JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [{ type: "command", command: "other-tool session setup", timeout: 3 }],
        },
        ...groups,
      ],
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "other-tool guard" }],
      }],
    },
  }, null, 2)}\n`;
}

function writeManifest(fixture: ArtifactFixture, overrides: Partial<CodexSuccessorAttestationManifest> = {}): void {
  fixture.manifest = { ...fixture.manifest, ...overrides };
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(fixture.manifestPath, 0o600);
}

function createFixture(): ArtifactFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hachi-gate4-artifacts-")));
  roots.push(root);
  const hachiHome = join(root, "hachi-home");
  const codexHome = join(root, "codex-home");
  const hooksPath = join(codexHome, "hooks.json");
  const helperPath = join(root, "bin", "hachi");
  const manifestPath = join(hachiHome, CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(dirname(helperPath), { recursive: true });
  writeFileSync(hooksPath, installedHooks(), { mode: 0o644 });
  chmodSync(hooksPath, 0o644);
  const helperBytes = Buffer.from("#!/bin/sh\nexec node /reviewed/hachi-cli.mjs \"$@\"\n");
  writeFileSync(helperPath, helperBytes, { mode: 0o755 });
  chmodSync(helperPath, 0o755);
  const manifest: CodexSuccessorAttestationManifest = {
    schemaVersion: CODEX_SUCCESSOR_MANIFEST_SCHEMA,
    codexHome,
    installedHooksPath: hooksPath,
    helperExecutablePath: helperPath,
    expectedHookDefinitionHash: expectedCodexSuccessorHookDefinitionHash(),
    expectedHelperExecutableHash: hash(helperBytes),
  };
  const fixture: ArtifactFixture = {
    root,
    hachiHome,
    codexHome,
    hooksPath,
    helperPath,
    manifestPath,
    helperBytes,
    manifest,
    resolver: undefined as unknown as SuccessorAttestationArtifactResolver,
  };
  writeManifest(fixture);
  fixture.resolver = createSuccessorAttestationArtifactResolver({
    hachiStateHome: hachiHome,
    processEnv: { CODEX_HOME: codexHome, PATH: dirname(helperPath) },
    osHome: root,
  });
  return fixture;
}

function expectResolverCode(
  resolver: SuccessorAttestationArtifactResolver,
  code: SuccessorAttestationArtifactError["code"],
): void {
  try {
    resolver.resolveInstalledArtifacts();
    throw new Error("resolver は失敗する想定です");
  } catch (err) {
    expect(err).toBeInstanceOf(SuccessorAttestationArtifactError);
    expect((err as SuccessorAttestationArtifactError).code).toBe(code);
    expect((err as Error).message).not.toMatch(/[0-9a-f]{64}/);
  }
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("Codex successor attestation static artifacts", () => {
  it("checked-in templateはrendererとbyte一致し、公式SessionStart同期command shapeを固定する", () => {
    const templatePath = new URL("../artifacts/codex-successor-session-start-hook.json", import.meta.url);
    const bytes = readFileSync(templatePath, "utf8");
    expect(bytes).toBe(renderCodexSuccessorHookTemplate());
    const parsed = JSON.parse(bytes) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    const group = parsed.hooks.SessionStart[0]!;
    const command = group.hooks[0]!;
    expect(group.matcher).toBe(CODEX_SUCCESSOR_HOOK_MATCHER);
    expect(command["type"]).toBe("command");
    expect(command["command"]).toBe(CODEX_SUCCESSOR_HOOK_COMMAND);
    expect(command["async"]).toBeUndefined();
    expect(command["timeout"]).toBe(CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS);
    expect(command["timeout"]).toBeLessThan(15);
    expect(command["additionalContextLimit"]).toBe(CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT);
    expect(Number(command["additionalContextLimit"])).toBeGreaterThan(0);
  });

  it("manifest exampleはexact schemaとreview済みhook hashを保持する", () => {
    const fixturePath = new URL("../artifacts/codex-successor-attestation-manifest.example.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as CodexSuccessorAttestationManifest;
    expect(parsed.schemaVersion).toBe(CODEX_SUCCESSOR_MANIFEST_SCHEMA);
    expect(parsed.expectedHookDefinitionHash).toBe(expectedCodexSuccessorHookDefinitionHash());
    expect(parsed.expectedHelperExecutableHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Codex successor attestation publication resolver", () => {
  it("他hookを維持したinstalled hooksからexact Hachi groupだけをcanonical hash化する", () => {
    const fixture = createFixture();
    expect(fixture.resolver.resolveInstalledArtifacts()).toEqual({
      codexHome: fixture.codexHome,
      installedHooksPath: fixture.hooksPath,
      helperExecutablePath: fixture.helperPath,
      hookDefinitionHash: expectedCodexSuccessorHookDefinitionHash(),
      hookExecutableHash: hash(fixture.helperBytes),
    });
    expect(fixture.resolver.readInstalledHashes()).toEqual({
      hookDefinitionHash: expectedCodexSuccessorHookDefinitionHash(),
      hookExecutableHash: hash(fixture.helperBytes),
    });
  });

  it("manifest無しはCODEX_HOMEやhelper sourceを推測せず分類済みfail-closed", () => {
    const fixture = createFixture();
    unlinkSync(fixture.manifestPath);
    expectResolverCode(fixture.resolver, "manifest_missing");
  });

  it("manifestのunknown field/schema/size driftを拒否する", () => {
    const schemaFixture = createFixture();
    writeFileSync(schemaFixture.manifestPath, `${JSON.stringify({
      ...schemaFixture.manifest,
      unexpected: true,
    })}\n`, { mode: 0o600 });
    chmodSync(schemaFixture.manifestPath, 0o600);
    expectResolverCode(schemaFixture.resolver, "manifest_schema");

    const sizeFixture = createFixture();
    writeFileSync(sizeFixture.manifestPath, "x".repeat(16_385), { mode: 0o600 });
    chmodSync(sizeFixture.manifestPath, 0o600);
    expectResolverCode(sizeFixture.resolver, "manifest_unsafe");
  });

  it("manifestとinstalled hooksの全nestingでescape decode後の重複keyを拒否する", () => {
    const manifestFixture = createFixture();
    const duplicateManifest = JSON.stringify(manifestFixture.manifest).replace(
      /}$/,
      `,"schema\\u0056ersion":"${CODEX_SUCCESSOR_MANIFEST_SCHEMA}"}`,
    );
    writeFileSync(manifestFixture.manifestPath, duplicateManifest, { mode: 0o600 });
    chmodSync(manifestFixture.manifestPath, 0o600);
    expectResolverCode(manifestFixture.resolver, "manifest_schema");

    const hooksFixture = createFixture();
    const duplicateHooks = installedHooks().replace(
      `"command": "${CODEX_SUCCESSOR_HOOK_COMMAND}"`,
      `"command": "${CODEX_SUCCESSOR_HOOK_COMMAND}",\n` +
        `            "comm\\u0061nd": "${CODEX_SUCCESSOR_HOOK_COMMAND}"`,
    );
    writeFileSync(hooksFixture.hooksPath, duplicateHooks);
    expectResolverCode(hooksFixture.resolver, "hook_definition_drift");
  });

  it("symlink + .. を含むraw CODEX_HOMEとhachiStateHomeをlexical resolve前に拒否する", () => {
    const codexFixture = createFixture();
    const codexRedirect = join(codexFixture.root, "codex-redirect");
    mkdirSync(join(codexRedirect, "nested"), { recursive: true });
    mkdirSync(join(codexRedirect, "codex-home"));
    symlinkSync(join(codexRedirect, "nested"), join(codexFixture.root, "codex-link"));
    const rawCodexHome = `${codexFixture.root}/codex-link/../codex-home`;
    expect(realpathSync.native(rawCodexHome)).not.toBe(codexFixture.codexHome);
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: codexFixture.hachiHome,
      processEnv: { CODEX_HOME: rawCodexHome, PATH: dirname(codexFixture.helperPath) },
      osHome: codexFixture.root,
    }), "codex_home_mismatch");
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: codexFixture.hachiHome,
      processEnv: {
        CODEX_HOME: `${codexFixture.root}/./codex-home`,
        PATH: dirname(codexFixture.helperPath),
      },
      osHome: codexFixture.root,
    }), "codex_home_mismatch");

    const stateFixture = createFixture();
    const stateRedirect = join(stateFixture.root, "state-redirect");
    mkdirSync(join(stateRedirect, "nested"), { recursive: true });
    mkdirSync(join(stateRedirect, "hachi-home"));
    symlinkSync(join(stateRedirect, "nested"), join(stateFixture.root, "state-link"));
    const rawHachiHome = `${stateFixture.root}/state-link/../hachi-home`;
    expect(realpathSync.native(rawHachiHome)).not.toBe(stateFixture.hachiHome);
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: rawHachiHome,
      processEnv: { CODEX_HOME: stateFixture.codexHome, PATH: dirname(stateFixture.helperPath) },
      osHome: stateFixture.root,
    }), "manifest_unsafe");
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: `${stateFixture.root}/./hachi-home`,
      processEnv: { CODEX_HOME: stateFixture.codexHome, PATH: dirname(stateFixture.helperPath) },
      osHome: stateFixture.root,
    }), "manifest_unsafe");
  });

  it("同じmatcherのother-tool groupを許容しexact Hachi groupだけを識別する", () => {
    const fixture = createFixture();
    writeFileSync(fixture.hooksPath, installedHooks([{
      matcher: CODEX_SUCCESSOR_HOOK_MATCHER,
      hooks: [{ type: "command", command: "other-tool session setup", timeout: 10 }],
    }, CODEX_SUCCESSOR_SESSION_START_GROUP]));
    expect(fixture.resolver.resolveInstalledArtifacts().hookDefinitionHash)
      .toBe(expectedCodexSuccessorHookDefinitionHash());
  });

  it.each([
    ["duplicate group", (fixture: ArtifactFixture) => {
      writeFileSync(fixture.hooksPath, installedHooks([
        CODEX_SUCCESSOR_SESSION_START_GROUP,
        CODEX_SUCCESSOR_SESSION_START_GROUP,
      ]));
    }, "hook_definition_duplicate"],
    ["field drift", (fixture: ArtifactFixture) => {
      writeFileSync(fixture.hooksPath, installedHooks([{
        ...CODEX_SUCCESSOR_SESSION_START_GROUP,
        unexpected: true,
      }]));
    }, "hook_definition_drift"],
    ["Hachi command drift", (fixture: ArtifactFixture) => {
      writeFileSync(fixture.hooksPath, installedHooks([{
        matcher: CODEX_SUCCESSOR_HOOK_MATCHER,
        hooks: [{
          type: "command",
          command: `${CODEX_SUCCESSOR_HOOK_COMMAND} --drift`,
          timeout: CODEX_SUCCESSOR_HOOK_TIMEOUT_SECONDS,
          additionalContextLimit: CODEX_SUCCESSOR_ADDITIONAL_CONTEXT_LIMIT,
        }],
      }]));
    }, "hook_definition_drift"],
    ["hook hash drift", (fixture: ArtifactFixture) => {
      writeManifest(fixture, { expectedHookDefinitionHash: "f".repeat(64) });
    }, "hook_hash_mismatch"],
    ["helper hash drift", (fixture: ArtifactFixture) => {
      writeFileSync(fixture.helperPath, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
      chmodSync(fixture.helperPath, 0o755);
    }, "helper_hash_mismatch"],
  ] as const)("%sを拒否する", (_label, mutate, code) => {
    const fixture = createFixture();
    mutate(fixture);
    expectResolverCode(fixture.resolver, code);
  });

  it("active CODEX_HOME driftとPATH先頭helper driftをそれぞれ拒否する", () => {
    const fixture = createFixture();
    const otherCodexHome = join(fixture.root, "other-codex-home");
    mkdirSync(otherCodexHome);
    const codexDrift = createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: { CODEX_HOME: otherCodexHome, PATH: dirname(fixture.helperPath) },
      osHome: fixture.root,
    });
    expectResolverCode(codexDrift, "codex_home_mismatch");

    const firstBin = join(fixture.root, "first-bin");
    mkdirSync(firstBin);
    const firstHelper = join(firstBin, "hachi");
    writeFileSync(firstHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(firstHelper, 0o755);
    const helperDrift = createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        PATH: `${firstBin}:${dirname(fixture.helperPath)}`,
      },
      osHome: fixture.root,
    });
    expectResolverCode(helperDrift, "helper_path_mismatch");
  });

  it("symlink + .. を含むraw PATH entryでlexical helperと実exec先が分離しても受理しない", () => {
    const fixture = createFixture();
    const physicalRoot = join(fixture.root, "physical");
    const physicalBin = join(physicalRoot, "bin");
    const physicalNested = join(physicalRoot, "nested");
    const physicalHelper = join(physicalBin, "hachi");
    const pathLink = join(fixture.root, "path-link");
    mkdirSync(physicalBin, { recursive: true });
    mkdirSync(physicalNested);
    writeFileSync(physicalHelper, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    chmodSync(physicalHelper, 0o755);
    symlinkSync(physicalNested, pathLink);

    const rawPathEntry = `${pathLink}${sep}..${sep}bin`;
    const rawHelperPath = `${rawPathEntry}${sep}hachi`;
    expect(normalize(rawHelperPath)).toBe(fixture.helperPath);
    expect(realpathSync.native(rawHelperPath)).toBe(physicalHelper);
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: { CODEX_HOME: fixture.codexHome, PATH: rawPathEntry },
      osHome: fixture.root,
    }), "helper_path_mismatch");
  });

  it.each([
    ["dot segment", (fixture: ArtifactFixture) => `${dirname(fixture.helperPath)}${sep}.`],
    ["symlink component", (fixture: ArtifactFixture) => {
      const linkedBin = join(fixture.root, "linked-bin");
      symlinkSync(dirname(fixture.helperPath), linkedBin);
      return linkedBin;
    }],
    ["empty entry", (fixture: ArtifactFixture) => `${delimiter}${dirname(fixture.helperPath)}`],
    ["relative entry", (fixture: ArtifactFixture) => `relative-bin${delimiter}${dirname(fixture.helperPath)}`],
  ] as const)("raw PATHの%sをfail-closedで拒否する", (_label, buildPath) => {
    const fixture = createFixture();
    expectResolverCode(createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: { CODEX_HOME: fixture.codexHome, PATH: buildPath(fixture) },
      osHome: fixture.root,
    }), "helper_path_mismatch");
  });

  it("canonicalな複数PATH entryでは最初の実行可能hachiを選ぶ", () => {
    const fixture = createFixture();
    const nonExecutableBin = join(fixture.root, "non-executable-bin");
    mkdirSync(nonExecutableBin);
    writeFileSync(join(nonExecutableBin, "hachi"), "#!/bin/sh\nexit 9\n", { mode: 0o644 });

    const resolver = createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        PATH: `${nonExecutableBin}${delimiter}${dirname(fixture.helperPath)}`,
      },
      osHome: fixture.root,
    });
    expect(resolver.resolveInstalledArtifacts().helperExecutablePath).toBe(fixture.helperPath);
  });

  it("installed hooks symlinkとPATH helper symlinkをauthorityへ昇格させない", () => {
    const fixture = createFixture();
    const realHooks = join(fixture.codexHome, "hooks.real.json");
    renameSync(fixture.hooksPath, realHooks);
    symlinkSync(realHooks, fixture.hooksPath);
    expectResolverCode(fixture.resolver, "artifact_unsafe");

    unlinkSync(fixture.hooksPath);
    renameSync(realHooks, fixture.hooksPath);
    const realHelper = join(fixture.root, "real-hachi");
    renameSync(fixture.helperPath, realHelper);
    symlinkSync(realHelper, fixture.helperPath);
    expectResolverCode(fixture.resolver, "artifact_unsafe");
  });

  it("open済みhooks pathのsymlink swapをfinal identity recheckで拒否する", () => {
    const fixture = createFixture();
    let readCount = 0;
    const swappingFs: SuccessorAttestationArtifactFileSystem = {
      lstat: (path) => lstatSync(path, { bigint: true }),
      realpath: (path) => realpathSync.native(path),
      openNoFollow: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      readFile(fd): Buffer {
        const bytes = readFileSync(fd);
        readCount += 1;
        if (readCount === 2) {
          const original = join(fixture.codexHome, "hooks.opened.json");
          const replacement = join(fixture.codexHome, "hooks.replacement.json");
          renameSync(fixture.hooksPath, original);
          writeFileSync(replacement, installedHooks(), { mode: 0o644 });
          symlinkSync(replacement, fixture.hooksPath);
        }
        return bytes;
      },
      fstat: (fd) => fstatSync(fd, { bigint: true }),
      close: (fd) => closeSync(fd),
      canExecute(path): boolean {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    };
    const resolver = createSuccessorAttestationArtifactResolver({
      hachiStateHome: fixture.hachiHome,
      processEnv: { CODEX_HOME: fixture.codexHome, PATH: dirname(fixture.helperPath) },
      osHome: fixture.root,
      fileSystem: swappingFs,
    });
    expectResolverCode(resolver, "artifact_unstable");
  });

  it("manifest/hooks/helperのunsafe mode bitsを拒否する", () => {
    const fixture = createFixture();
    chmodSync(fixture.manifestPath, 0o644);
    expectResolverCode(fixture.resolver, "manifest_unsafe");
    chmodSync(fixture.manifestPath, 0o600);
    chmodSync(fixture.hooksPath, 0o666);
    expectResolverCode(fixture.resolver, "artifact_unsafe");
    chmodSync(fixture.hooksPath, 0o644);
    chmodSync(fixture.helperPath, 0o644);
    expectResolverCode(fixture.resolver, "helper_path_mismatch");
    chmodSync(fixture.helperPath, 0o775);
    expectResolverCode(fixture.resolver, "artifact_unsafe");
  });
});
