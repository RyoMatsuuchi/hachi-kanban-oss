import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  escapeXml,
  renderLaunchdTemplates,
  renderTemplate,
  resolveRenderConfig,
  templateNames,
  writeRenderedTemplates,
} from "./render-launchd.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeExecutable(filePath) {
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(filePath, 0o755);
}

function withTempDirectory(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "hachi-launchd-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("resolveRenderConfig resolves another user's paths and executables", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "another-home");
    const fakeRepo = path.join(directory, "clone");
    const binDirectory = path.join(directory, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(fakeRepo, { recursive: true });
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(path.join(fakeRepo, "package.json"), "{}\n", "utf8");
    const nodeBin = path.join(binDirectory, "node");
    const pnpmBin = path.join(binDirectory, "pnpm");
    const pnpmTarget = path.join(binDirectory, "pnpm-versioned");
    makeExecutable(nodeBin);
    makeExecutable(pnpmTarget);
    symlinkSync(pnpmTarget, pnpmBin);

    const config = resolveRenderConfig({ repoRoot: fakeRepo }, {
      HOME: home,
      PATH: binDirectory,
      HACHI_NODE_BIN: "node",
      HACHI_PNPM_BIN: "pnpm",
      HACHI_LAUNCHD_PATH: "~/.custom/bin:/usr/bin",
      HACHI_KANBAN_HOME: "~/state/hachi",
      HACHI_KANBAN_BOARD: "team-dev_1.2",
      HACHI_KANBAN_WEB_PORT: "19131",
      HACHI_CODEX_BRIDGE_URL: "https://codex-bridge.example.test/base",
      HACHI_CODEX_BRIDGE_TOKEN_FILE: "~/tokens/codex",
      HACHI_CLAUDE_BRIDGE_URL: "https://claude-bridge.example.test/base",
      HACHI_CLAUDE_BRIDGE_TOKEN_FILE: "~/tokens/claude",
      HACHI_BRIDGE_ALLOW_REMOTE: "1",
    });

    const canonicalHome = realpathSync(home);
    assert.equal(config.home, canonicalHome);
    assert.equal(config.repoRoot, realpathSync(fakeRepo));
    assert.equal(config.hachiHome, path.join(canonicalHome, "state", "hachi"));
    assert.equal(config.nodeBin, nodeBin);
    assert.equal(config.pnpmBin, pnpmBin);
    assert.notEqual(config.pnpmBin, realpathSync(pnpmBin));
    assert.equal(config.launchdPath, `${path.join(canonicalHome, ".custom", "bin")}:/usr/bin`);
    assert.equal(config.board, "team-dev_1.2");
    assert.equal(config.webPort, "19131");
    assert.equal(config.codexBridgeUrl, "https://codex-bridge.example.test/base");
    assert.equal(config.codexBridgeTokenFile, path.join(canonicalHome, "tokens", "codex"));
    assert.equal(config.claudeBridgeUrl, "https://claude-bridge.example.test/base");
    assert.equal(config.claudeBridgeTokenFile, path.join(canonicalHome, "tokens", "claude"));
    assert.equal(config.bridgeAllowRemote, "1");
  });
});

test("resolveRenderConfig uses portable bridge defaults and rejects unsafe runtime values", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "home");
    mkdirSync(home, { recursive: true });
    const options = {
      repoRoot,
      home,
      node: process.execPath,
      pnpm: process.execPath,
    };
    const environment = { HOME: home, PATH: "" };
    const config = resolveRenderConfig(options, environment);
    const canonicalHome = realpathSync(home);

    assert.equal(config.board, "dev");
    assert.equal(config.webPort, "9131");
    assert.equal(config.codexBridgeUrl, "http://127.0.0.1:3456");
    assert.equal(
      config.codexBridgeTokenFile,
      path.join(canonicalHome, ".hachi-kanban", "credentials", "codex-bridge-token"),
    );
    assert.equal(
      config.claudeBridgeTokenFile,
      path.join(canonicalHome, ".hachi-kanban", "credentials", "claude-bridge-token"),
    );
    assert.equal(config.bridgeAllowRemote, "0");

    const executableDirectory = path.join(directory, "looks-executable");
    mkdirSync(executableDirectory);
    assert.throws(
      () => resolveRenderConfig({ ...options, pnpm: executableDirectory }, environment),
      /pnpm executable is not a regular file/,
    );

    assert.throws(
      () => resolveRenderConfig(options, { ...environment, HACHI_KANBAN_BOARD: "../other" }),
      /HACHI_KANBAN_BOARD must be a slug/,
    );
    assert.throws(
      () => resolveRenderConfig(options, { ...environment, HACHI_KANBAN_WEB_PORT: "65536" }),
      /integer from 1 to 65535/,
    );
    assert.throws(
      () => resolveRenderConfig(options, {
        ...environment,
        HACHI_CODEX_BRIDGE_URL: "https://token@example.test/?secret=value",
      }),
      /must not contain credentials, a query, or a fragment/,
    );
    assert.throws(
      () => resolveRenderConfig(options, { ...environment, HACHI_BRIDGE_ALLOW_REMOTE: "yes" }),
      /must be 0 or 1/,
    );
    assert.throws(
      () => resolveRenderConfig(options, {
        ...environment,
        HACHI_CODEX_BRIDGE_URL: "https://codex.example.test",
      }),
      /requires HACHI_BRIDGE_ALLOW_REMOTE=1/,
    );
    assert.throws(
      () => resolveRenderConfig(options, {
        ...environment,
        HACHI_CODEX_BRIDGE_URL: "http://codex.example.test",
        HACHI_BRIDGE_ALLOW_REMOTE: "1",
      }),
      /must use HTTPS/,
    );
  });
});

test("renderTemplate XML-escapes every replacement and rejects unknown placeholders", () => {
  assert.equal(
    renderTemplate("<string>{{VALUE}}</string>", { VALUE: `a&b<c>d\"e'f` }),
    "<string>a&amp;b&lt;c&gt;d&quot;e&apos;f</string>",
  );
  assert.equal(escapeXml("plain"), "plain");
  assert.throws(
    () => renderTemplate("{{KNOWN}} {{MISSING}}", { KNOWN: "ok" }, "fixture.plist"),
    /fixture\.plist has unknown placeholders: MISSING/,
  );
  assert.throws(() => escapeXml("bad\u0001value"), /XML 1\.0/);
});

test("all launchd templates render without personal paths or unresolved placeholders", () => {
  const config = Object.freeze({
    repoRoot: "/Volumes/Team & Product/hachi <kanban>",
    home: "/Users/collaborator",
    hachiHome: "/Users/collaborator/Library/Application Support/Hachi & Team",
    nodeBin: "/opt/tools/node",
    pnpmBin: "/opt/tools/pnpm & stable",
    launchdPath: "/opt/tools:/usr/bin:/bin&more",
    board: "portable-dev",
    webPort: "19131",
    codexBridgeUrl: "https://codex.example.test/path&team",
    codexBridgeTokenFile: "/Users/collaborator/tokens/codex&team",
    claudeBridgeUrl: "https://claude.example.test/path&team",
    claudeBridgeTokenFile: "/Users/collaborator/tokens/claude&team",
    bridgeAllowRemote: "1",
  });

  const rendered = renderLaunchdTemplates(config, path.join(repoRoot, "runbooks", "templates"));

  assert.deepEqual(rendered.map(({ name }) => name), templateNames);
  for (const file of rendered) {
    assert.doesNotMatch(file.content, /\{\{[A-Z][A-Z0-9_]*\}\}/);
    // 描画結果に実行ホストの home パスが混入しないこと（値は config 由来だけ）
    assert.doesNotMatch(file.content, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(file.content, /\/Volumes\/Team &amp; Product\/hachi &lt;kanban&gt;/);
    assert.match(file.content, /<key>HACHI_KANBAN_HOME<\/key>/);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  const supervisor = rendered.find(({ name }) => name.endsWith("supervisor.plist"));
  const web = rendered.find(({ name }) => name.endsWith("web.plist"));
  const backup = rendered.find(({ name }) => name.endsWith("backup.plist"));
  const watchdog = rendered.find(({ name }) => name.endsWith("watchdog.plist"));
  assert.match(supervisor.content, /<key>HACHI_KANBAN_BOARD<\/key>\s*<string>portable-dev<\/string>/);
  assert.match(supervisor.content, /https:\/\/codex\.example\.test\/path&amp;team/);
  assert.match(supervisor.content, /<key>HACHI_BRIDGE_ALLOW_REMOTE<\/key>\s*<string>1<\/string>/);
  assert.match(web.content, /<key>HACHI_KANBAN_WEB_PORT<\/key>\s*<string>19131<\/string>/);
  assert.match(backup.content, /<key>HACHI_KANBAN_BOARD<\/key>\s*<string>portable-dev<\/string>/);
  assert.doesNotMatch(watchdog.content, /HACHI_KANBAN_BOARD|BRIDGE_URL|WEB_PORT/);
});

test("writeRenderedTemplates writes only to an explicit non-live directory", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "home");
    mkdirSync(home, { recursive: true });
    const config = Object.freeze({
      repoRoot,
      home,
      hachiHome: path.join(home, ".hachi-kanban"),
      nodeBin: process.execPath,
      pnpmBin: process.execPath,
      launchdPath: path.dirname(process.execPath),
      board: "dev",
      webPort: "9131",
      codexBridgeUrl: "http://127.0.0.1:3456",
      codexBridgeTokenFile: path.join(home, "credentials", "codex-bridge-token"),
      claudeBridgeUrl: "http://127.0.0.1:3457",
      claudeBridgeTokenFile: path.join(home, "credentials", "claude-bridge-token"),
      bridgeAllowRemote: "0",
    });
    const rendered = renderLaunchdTemplates(config);
    const outputDirectory = path.join(directory, "rendered");

    const writtenDirectory = writeRenderedTemplates(rendered, outputDirectory, config);
    assert.equal(writtenDirectory, realpathSync(outputDirectory));
    for (const file of rendered) {
      assert.equal(readFileSync(path.join(outputDirectory, file.name), "utf8"), file.content);
    }
    assert.throws(
      () => writeRenderedTemplates(rendered, outputDirectory, config),
      /output already exists/,
    );
    assert.doesNotThrow(() => writeRenderedTemplates(rendered, outputDirectory, config, true));

    const protectedFile = path.join(directory, "must-not-change");
    writeFileSync(protectedFile, "protected\n", "utf8");
    const firstOutput = path.join(outputDirectory, rendered[0].name);
    rmSync(firstOutput);
    symlinkSync(protectedFile, firstOutput);
    assert.doesNotThrow(() => writeRenderedTemplates(rendered, outputDirectory, config, true));
    assert.equal(readFileSync(protectedFile, "utf8"), "protected\n");
    assert.equal(readFileSync(firstOutput, "utf8"), rendered[0].content);
  });
});

test("writeRenderedTemplates rejects the live LaunchAgents directory, including descendants", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "home");
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    const config = Object.freeze({
      repoRoot,
      home,
      hachiHome: path.join(home, ".hachi-kanban"),
      nodeBin: process.execPath,
      pnpmBin: process.execPath,
      launchdPath: path.dirname(process.execPath),
      board: "dev",
      webPort: "9131",
      codexBridgeUrl: "http://127.0.0.1:3456",
      codexBridgeTokenFile: path.join(home, "credentials", "codex-bridge-token"),
      claudeBridgeUrl: "http://127.0.0.1:3457",
      claudeBridgeTokenFile: path.join(home, "credentials", "claude-bridge-token"),
      bridgeAllowRemote: "0",
    });
    const rendered = renderLaunchdTemplates(config);

    assert.throws(
      () => writeRenderedTemplates(
        rendered,
        path.join(home, "Library", "LaunchAgents", "generated"),
        config,
      ),
      /refusing to render directly into live LaunchAgents directory/,
    );
  });
});

test("writeRenderedTemplates preflights dangling destinations before publishing any file", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "home");
    const outputDirectory = path.join(directory, "rendered");
    mkdirSync(home, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    const rendered = [
      { name: "first.plist", content: "first", sha256: "unused" },
      { name: "second.plist", content: "second", sha256: "unused" },
      { name: "third.plist", content: "third", sha256: "unused" },
    ];
    const dangling = path.join(outputDirectory, rendered[2].name);
    symlinkSync(path.join(directory, "missing-target"), dangling);

    assert.throws(
      () => writeRenderedTemplates(rendered, outputDirectory, { home }),
      /output already exists/,
    );
    assert.equal(existsSync(path.join(outputDirectory, rendered[0].name)), false);
    assert.equal(existsSync(path.join(outputDirectory, rendered[1].name)), false);
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  });
});

test("writeRenderedTemplates preflights every forced destination before replacing files", () => {
  withTempDirectory((directory) => {
    const home = path.join(directory, "home");
    const outputDirectory = path.join(directory, "rendered");
    mkdirSync(home, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    const rendered = [
      { name: "first.plist", content: "new-first", sha256: "unused" },
      { name: "second.plist", content: "new-second", sha256: "unused" },
      { name: "third.plist", content: "new-third", sha256: "unused" },
    ];
    const first = path.join(outputDirectory, rendered[0].name);
    const second = path.join(outputDirectory, rendered[1].name);
    const third = path.join(outputDirectory, rendered[2].name);
    writeFileSync(first, "old-first", "utf8");
    writeFileSync(second, "old-second", "utf8");
    mkdirSync(third);

    assert.throws(
      () => writeRenderedTemplates(rendered, outputDirectory, { home }, true),
      /not a replaceable regular file or symlink/,
    );
    assert.equal(readFileSync(first, "utf8"), "old-first");
    assert.equal(readFileSync(second, "utf8"), "old-second");
    assert.equal(lstatSync(third).isDirectory(), true);
  });
});
