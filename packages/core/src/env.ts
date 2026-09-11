// =============================================================================
// 環境変数解決（docs/contract.md §3）
// HACHI_KANBAN_HOME 等の環境変数から Environment を組み立てる。
// =============================================================================

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { PROVIDERS, type BridgeConfig, type Environment, type Provider } from "./types.js";

const DEFAULT_HOME = "~/.hachi-kanban";
const DEFAULT_BOARD = "dev";

/** board 名として許可する charset（docs/contract.md §12.8-1）。パス区切りは含めない */
const BOARD_SLUG_REGEX = /^[A-Za-z0-9._-]+$/;

interface BridgeDefault {
  urlEnvVar: string;
  urlDefault: string;
  tokenFileEnvVar: string;
  tokenFileName: string;
}

/** provider ごとの bridge 既定値（docs/contract.md §3） */
const BRIDGE_DEFAULTS: Readonly<Record<Provider, BridgeDefault>> = {
  codex: {
    urlEnvVar: "HACHI_CODEX_BRIDGE_URL",
    urlDefault: "http://127.0.0.1:3456",
    tokenFileEnvVar: "HACHI_CODEX_BRIDGE_TOKEN_FILE",
    tokenFileName: "codex-bridge-token",
  },
  claude: {
    urlEnvVar: "HACHI_CLAUDE_BRIDGE_URL",
    urlDefault: "http://127.0.0.1:3457",
    tokenFileEnvVar: "HACHI_CLAUDE_BRIDGE_TOKEN_FILE",
    tokenFileName: "claude-bridge-token",
  },
};

/** `~` または `~/...` で始まるパスをホームディレクトリへ展開する */
function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path;
}

/**
 * board 名を検証する（docs/contract.md §12.8-1）。
 * 許可 charset（英数字・.・_・-）以外を含む値、および `.` / `..`（カレント/親ディレクトリ参照）は
 * パストラバーサルに使われうるため fail-closed で throw する。
 */
function assertValidBoardSlug(board: string): void {
  if (!BOARD_SLUG_REGEX.test(board)) {
    throw new Error(
      `不正な board 名です（英数字・.・_・- のみ使用可能で、パス区切りは使用できません）: ${board}`,
    );
  }
  if (board === "." || board === "..") {
    throw new Error(`board 名に . または .. は使用できません: ${board}`);
  }
}

/** プロセス環境変数から Environment を解決する（docs/contract.md §3） */
export function resolveEnvironment(processEnv: NodeJS.ProcessEnv): Environment {
  const home = expandHome(processEnv.HACHI_KANBAN_HOME ?? DEFAULT_HOME);
  const board = processEnv.HACHI_KANBAN_BOARD ?? DEFAULT_BOARD;
  assertValidBoardSlug(board);

  const dbPath = `${home}/boards/${board}/kanban.db`;

  // dbPath が $home/boards/ 配下に収まっていることを二重に検証する（containment, docs/contract.md §12.8-1）。
  // 上の charset 検証だけでも `/` を含む値は排除できるが、パストラバーサルによる home 外への
  // DB 作成を確実に防ぐため path.resolve 後の startsWith でも確認する。
  const boardsRoot = resolve(home, "boards");
  const resolvedDbPath = resolve(dbPath);
  if (!resolvedDbPath.startsWith(`${boardsRoot}${sep}`)) {
    throw new Error(`board 名の解決結果が home/boards 配下に収まりません: ${board}`);
  }

  const artifactsDir = `${home}/artifacts`;

  const bridges: Record<Provider, BridgeConfig> = {} as Record<Provider, BridgeConfig>;
  for (const provider of PROVIDERS) {
    const defaults = BRIDGE_DEFAULTS[provider];
    const configuredTokenFile = processEnv[defaults.tokenFileEnvVar];
    bridges[provider] = {
      url: processEnv[defaults.urlEnvVar] ?? defaults.urlDefault,
      tokenFile: configuredTokenFile === undefined
        ? join(home, "credentials", defaults.tokenFileName)
        : expandHome(configuredTokenFile),
    };
  }

  return { home, board, dbPath, artifactsDir, bridges };
}

/** Environment が指す各ディレクトリを mkdir -p 相当で作成する */
export function ensureEnvironmentDirs(env: Environment): void {
  mkdirSync(dirname(env.dbPath), { recursive: true });
  mkdirSync(env.artifactsDir, { recursive: true });
}
