#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const templateNames = Object.freeze([
  "com.hachi-kanban.supervisor.plist",
  "com.hachi-kanban.web.plist",
  "com.hachi-kanban.backup.plist",
  "com.hachi-kanban.watchdog.plist",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");
const placeholderPattern = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const invalidXmlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;
const boardSlugPattern = /^[A-Za-z0-9._-]+$/;

function usage() {
  return `Usage: node scripts/render-launchd.mjs [options]

Render the repository's launchd templates without installing or loading them.
With no --output-dir, the command validates the rendered plists and performs a
dry-run. Supplying --output-dir writes new files there; existing files require
--force. Direct output to ~/Library/LaunchAgents is deliberately rejected.

Options:
  --output-dir <path>   Write rendered plist files to this directory
  --force               Replace existing files in --output-dir
  --repo-root <path>    Repository root (default: script parent)
  --home <path>         User home (default: HOME / OS home)
  --hachi-home <path>   Runtime root (default: HACHI_KANBAN_HOME or ~/.hachi-kanban)
  --node <path>         Node executable (default: HACHI_NODE_BIN or current Node)
  --pnpm <path>         pnpm executable (default: HACHI_PNPM_BIN or PATH lookup)
  --launchd-path <path> launchd PATH (default: resolved executable/common dirs)
  --help                Show this help

Environment passed through after validation:
  HACHI_KANBAN_BOARD, HACHI_KANBAN_WEB_PORT,
  HACHI_CODEX_BRIDGE_URL, HACHI_CODEX_BRIDGE_TOKEN_FILE,
  HACHI_CLAUDE_BRIDGE_URL, HACHI_CLAUDE_BRIDGE_TOKEN_FILE,
  HACHI_BRIDGE_ALLOW_REMOTE
`;
}

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must not contain NUL or line breaks`);
  }
  return value;
}

function expandUserPath(value, home, label) {
  const checked = assertNonEmpty(value, label);
  if (checked === "~") {
    return home;
  }
  if (checked.startsWith("~/")) {
    return path.join(home, checked.slice(2));
  }
  if (checked.startsWith("~")) {
    throw new Error(`${label} does not support another user's ~ expansion: ${checked}`);
  }
  return checked;
}

function resolveAbsolutePath(value, home, label) {
  return path.resolve(expandUserPath(value, home, label));
}

function assertExecutable(candidate, home, label) {
  const resolved = resolveAbsolutePath(candidate, home, label);
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${resolved}`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`${label} is not a regular file: ${resolved}`);
  }
  // version manager が差し替える安定 symlink/shim path を plist に保持する。
  return resolved;
}

function findExecutable(name, pathValue, home) {
  const checkedPath = assertNonEmpty(pathValue, "PATH");
  for (const entry of checkedPath.split(path.delimiter)) {
    if (entry === "") {
      continue;
    }
    const directory = resolveAbsolutePath(entry, home, "PATH entry");
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        // command -v 相当の path を保持し、upgrade 後も symlink の差し替えに追従する。
        return candidate;
      }
    } catch {
      // PATH の次候補を確認する。
    }
  }
  throw new Error(`${name} was not found as an executable on PATH`);
}

function resolveExecutableSetting(value, pathValue, home, label) {
  const checked = assertNonEmpty(value, label);
  if (checked.includes("/") || checked.startsWith("~")) {
    return assertExecutable(checked, home, label);
  }
  return findExecutable(checked, pathValue, home);
}

function uniquePath(entries) {
  return [...new Set(entries.filter((entry) => entry !== ""))].join(path.delimiter);
}

function normalizePathList(value, home) {
  const checked = assertNonEmpty(value, "launchd PATH");
  const entries = checked
    .split(path.delimiter)
    .filter((entry) => entry !== "")
    .map((entry) => resolveAbsolutePath(entry, home, "launchd PATH entry"));
  const normalized = uniquePath(entries);
  if (normalized === "") {
    throw new Error("launchd PATH must contain at least one directory");
  }
  return normalized;
}

function assertDirectory(directory, label) {
  let resolved;
  try {
    resolved = realpathSync(directory);
  } catch {
    throw new Error(`${label} does not exist: ${directory}`);
  }
  return resolved;
}

function resolveBoard(value) {
  const board = assertNonEmpty(value, "HACHI_KANBAN_BOARD");
  if (!boardSlugPattern.test(board) || board === "." || board === "..") {
    throw new Error(
      `HACHI_KANBAN_BOARD must be a slug containing only letters, digits, dot, underscore, or hyphen: ${board}`,
    );
  }
  return board;
}

function resolveWebPort(value) {
  const port = assertNonEmpty(value, "HACHI_KANBAN_WEB_PORT");
  if (!/^[0-9]+$/.test(port)) {
    throw new Error(`HACHI_KANBAN_WEB_PORT must be an integer from 1 to 65535: ${port}`);
  }
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`HACHI_KANBAN_WEB_PORT must be an integer from 1 to 65535: ${port}`);
  }
  return String(numericPort);
}

function resolveBridgeUrl(value, label) {
  const checked = assertNonEmpty(value, label);
  let parsed;
  try {
    parsed = new URL(checked);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL: ${checked}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.hostname === "") {
    throw new Error(`${label} must be an absolute HTTP(S) URL: ${checked}`);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${label} must not contain credentials, a query, or a fragment`);
  }
  return checked;
}

function resolveRemoteBridgeSetting(value) {
  const checked = assertNonEmpty(value, "HACHI_BRIDGE_ALLOW_REMOTE");
  if (checked !== "0" && checked !== "1") {
    throw new Error("HACHI_BRIDGE_ALLOW_REMOTE must be 0 or 1");
  }
  return checked;
}

function isLoopbackBridgeHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function assertBridgeUrlPolicy(value, label, allowRemote) {
  const parsed = new URL(value);
  if (isLoopbackBridgeHost(parsed.hostname)) {
    return;
  }
  if (allowRemote !== "1") {
    throw new Error(`${label} is remote and requires HACHI_BRIDGE_ALLOW_REMOTE=1`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS when it points to a remote host`);
  }
}

export function resolveRenderConfig(options = {}, environment = process.env) {
  const environmentHome = environment.HOME ?? homedir();
  const home = assertDirectory(
    resolveAbsolutePath(options.home ?? environmentHome, path.resolve(environmentHome), "home"),
    "home",
  );
  const repoRoot = assertDirectory(
    resolveAbsolutePath(
      options.repoRoot ?? environment.HACHI_KANBAN_REPO_ROOT ?? defaultRepoRoot,
      home,
      "repo root",
    ),
    "repo root",
  );
  if (!existsSync(path.join(repoRoot, "package.json"))) {
    throw new Error(`repo root does not contain package.json: ${repoRoot}`);
  }

  const searchPath = environment.PATH ?? "";
  const nodeBin = resolveExecutableSetting(
    options.node ?? environment.HACHI_NODE_BIN ?? process.execPath,
    searchPath,
    home,
    "node executable",
  );
  const pnpmBin = options.pnpm ?? environment.HACHI_PNPM_BIN;
  const resolvedPnpmBin = pnpmBin
    ? resolveExecutableSetting(pnpmBin, searchPath, home, "pnpm executable")
    : findExecutable("pnpm", searchPath, home);
  const hachiHome = resolveAbsolutePath(
    options.hachiHome ?? environment.HACHI_KANBAN_HOME ?? "~/.hachi-kanban",
    home,
    "HACHI_KANBAN_HOME",
  );
  const board = resolveBoard(environment.HACHI_KANBAN_BOARD ?? "dev");
  const webPort = resolveWebPort(environment.HACHI_KANBAN_WEB_PORT ?? "9131");
  const codexBridgeUrl = resolveBridgeUrl(
    environment.HACHI_CODEX_BRIDGE_URL ?? "http://127.0.0.1:3456",
    "HACHI_CODEX_BRIDGE_URL",
  );
  const claudeBridgeUrl = resolveBridgeUrl(
    environment.HACHI_CLAUDE_BRIDGE_URL ?? "http://127.0.0.1:3457",
    "HACHI_CLAUDE_BRIDGE_URL",
  );
  const codexBridgeTokenFile = resolveAbsolutePath(
    environment.HACHI_CODEX_BRIDGE_TOKEN_FILE
      ?? path.join(hachiHome, "credentials", "codex-bridge-token"),
    home,
    "HACHI_CODEX_BRIDGE_TOKEN_FILE",
  );
  const claudeBridgeTokenFile = resolveAbsolutePath(
    environment.HACHI_CLAUDE_BRIDGE_TOKEN_FILE
      ?? path.join(hachiHome, "credentials", "claude-bridge-token"),
    home,
    "HACHI_CLAUDE_BRIDGE_TOKEN_FILE",
  );
  const bridgeAllowRemote = resolveRemoteBridgeSetting(
    environment.HACHI_BRIDGE_ALLOW_REMOTE ?? "0",
  );
  assertBridgeUrlPolicy(codexBridgeUrl, "HACHI_CODEX_BRIDGE_URL", bridgeAllowRemote);
  assertBridgeUrlPolicy(claudeBridgeUrl, "HACHI_CLAUDE_BRIDGE_URL", bridgeAllowRemote);

  const configuredLaunchdPath = options.launchdPath ?? environment.HACHI_LAUNCHD_PATH;
  const launchdPath = configuredLaunchdPath
    ? normalizePathList(configuredLaunchdPath, home)
    : uniquePath([
      path.dirname(nodeBin),
      path.dirname(resolvedPnpmBin),
      path.join(home, ".local", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);

  return Object.freeze({
    repoRoot,
    home,
    hachiHome,
    nodeBin,
    pnpmBin: resolvedPnpmBin,
    launchdPath,
    board,
    webPort,
    codexBridgeUrl,
    codexBridgeTokenFile,
    claudeBridgeUrl,
    claudeBridgeTokenFile,
    bridgeAllowRemote,
  });
}

export function escapeXml(value) {
  const checked = assertNonEmpty(value, "template value");
  if (invalidXmlCharacterPattern.test(checked)) {
    throw new Error("template value contains a character that XML 1.0 cannot represent");
  }
  return checked
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderTemplate(source, values, templateName = "template") {
  const unknown = new Set();
  const rendered = source.replace(placeholderPattern, (_match, name) => {
    if (!Object.hasOwn(values, name)) {
      unknown.add(name);
      return `{{${name}}}`;
    }
    return escapeXml(values[name]);
  });
  if (unknown.size > 0) {
    throw new Error(`${templateName} has unknown placeholders: ${[...unknown].sort().join(", ")}`);
  }
  const unresolved = [...rendered.matchAll(placeholderPattern)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`${templateName} has unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`);
  }
  return rendered;
}

export function renderLaunchdTemplates(config, templatesDir = path.join(config.repoRoot, "runbooks", "templates")) {
  const values = {
    HACHI_REPO_ROOT: config.repoRoot,
    HACHI_KANBAN_HOME: config.hachiHome,
    HACHI_PNPM_BIN: config.pnpmBin,
    HACHI_LAUNCHD_PATH: config.launchdPath,
    HACHI_KANBAN_BOARD: config.board,
    HACHI_KANBAN_WEB_PORT: config.webPort,
    HACHI_CODEX_BRIDGE_URL: config.codexBridgeUrl,
    HACHI_CODEX_BRIDGE_TOKEN_FILE: config.codexBridgeTokenFile,
    HACHI_CLAUDE_BRIDGE_URL: config.claudeBridgeUrl,
    HACHI_CLAUDE_BRIDGE_TOKEN_FILE: config.claudeBridgeTokenFile,
    HACHI_BRIDGE_ALLOW_REMOTE: config.bridgeAllowRemote,
  };

  return templateNames.map((name) => {
    const templatePath = path.join(templatesDir, name);
    let source;
    try {
      source = readFileSync(templatePath, "utf8");
    } catch (error) {
      throw new Error(`failed to read launchd template ${templatePath}: ${error.message}`);
    }
    const content = renderTemplate(source, values, name);
    return Object.freeze({
      name,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  });
}

function canonicalizePath(target) {
  let existing = path.resolve(target);
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`could not resolve an existing parent for output path: ${target}`);
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...suffix);
}

function isPathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function inspectPathEntry(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function writeRenderedTemplates(rendered, outputDirectory, config, force = false) {
  const outputDir = canonicalizePath(resolveAbsolutePath(outputDirectory, config.home, "output directory"));
  const launchAgentsDir = canonicalizePath(path.join(config.home, "Library", "LaunchAgents"));
  if (isPathWithin(outputDir, launchAgentsDir)) {
    throw new Error(
      `refusing to render directly into live LaunchAgents directory: ${outputDir}; render elsewhere and install explicitly`,
    );
  }

  mkdirSync(outputDir, { recursive: true });
  for (const file of rendered) {
    const outputPath = path.join(outputDir, file.name);
    const existing = inspectPathEntry(outputPath);
    if (!force && existing !== null) {
      throw new Error(`output already exists (use --force to replace it): ${outputPath}`);
    }
    if (
      force &&
      existing !== null &&
      !existing.isFile() &&
      !existing.isSymbolicLink()
    ) {
      throw new Error(`output destination is not a replaceable regular file or symlink: ${outputPath}`);
    }
  }
  for (const file of rendered) {
    const outputPath = path.join(outputDir, file.name);
    const temporaryPath = path.join(outputDir, `.${file.name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      if (force) {
        renameSync(temporaryPath, outputPath);
      } else {
        linkSync(temporaryPath, outputPath);
        unlinkSync(temporaryPath);
      }
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
  return outputDir;
}

export function runCli(argv = process.argv.slice(2), environment = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "output-dir": { type: "string" },
      force: { type: "boolean", default: false },
      "repo-root": { type: "string" },
      home: { type: "string" },
      "hachi-home": { type: "string" },
      node: { type: "string" },
      pnpm: { type: "string" },
      "launchd-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (values.force && !values["output-dir"]) {
    throw new Error("--force requires --output-dir");
  }

  const config = resolveRenderConfig({
    repoRoot: values["repo-root"],
    home: values.home,
    hachiHome: values["hachi-home"],
    node: values.node,
    pnpm: values.pnpm,
    launchdPath: values["launchd-path"],
  }, environment);
  const rendered = renderLaunchdTemplates(config);
  const outputDir = values["output-dir"]
    ? writeRenderedTemplates(rendered, values["output-dir"], config, values.force)
    : null;

  process.stdout.write(`${JSON.stringify({
    mode: outputDir ? "write" : "dry-run",
    outputDir,
    resolved: config,
    files: rendered.map(({ name, sha256 }) => ({ name, sha256 })),
  }, null, 2)}\n`);
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`render-launchd: ${error.message}\n`);
    process.exitCode = 1;
  }
}
