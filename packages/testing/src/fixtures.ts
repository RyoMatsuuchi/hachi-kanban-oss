// テスト用の一時 HACHI_KANBAN_HOME を構築するフィクスチャ群。
// docs/contract.md §3 のディレクトリレイアウト（boards/<board>, artifacts）を
// os.tmpdir() 配下の一意ディレクトリに再現し、Environment を組み立てて返す。

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment, TaskCreateInput } from "@hachi/core";

/** makeTempHome() の戻り値 */
export interface TempHome {
  /** HACHI_KANBAN_HOME 相当の一時ディレクトリ */
  home: string;
  /** home を元に組み立てた Environment */
  env: Environment;
  /** 一時ディレクトリを再帰削除する */
  cleanup: () => void;
}

const DEFAULT_BOARD = "dev";

/**
 * os.tmpdir() 配下に一意な一時ディレクトリを作り、docs/contract.md §3 のレイアウト
 * （boards/<board>、artifacts）を構築して Environment を返す。
 * bridges にはダミー URL（未 listen のポート 0）と実ファイルの token を割り当てる。
 * 誤って実接続を試みても即座に失敗するため、実ネットワークへは出ない。
 */
export function makeTempHome(): TempHome {
  const home = mkdtempSync(join(tmpdir(), "hachi-testing-"));
  const board = DEFAULT_BOARD;
  const boardsDir = join(home, "boards", board);
  const artifactsDir = join(home, "artifacts");
  mkdirSync(boardsDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const codexTokenFile = writeTokenFile(join(home, "bridges", "codex"), "mock-codex-token");
  const claudeTokenFile = writeTokenFile(join(home, "bridges", "claude"), "mock-claude-token");

  const env: Environment = {
    home,
    board,
    dbPath: join(boardsDir, "kanban.db"),
    artifactsDir,
    bridges: {
      codex: { url: "http://127.0.0.1:0", tokenFile: codexTokenFile },
      claude: { url: "http://127.0.0.1:0", tokenFile: claudeTokenFile },
    },
  };

  return {
    home,
    env,
    cleanup: (): void => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** token ファイルを作成する（chmod 600）。dir が無ければ作成し、file path を返す */
export function writeTokenFile(dir: string, token: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "bridge-token");
  writeFileSync(filePath, token, { mode: 0o600 });
  // umask の影響を受けないよう明示的に chmod する
  chmodSync(filePath, 0o600);
  return filePath;
}

/** テスト用 TaskCreateInput 生成ヘルパー（既定値入り、overrides で上書き可能） */
export function taskInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    title: "テストタスク",
    body: "",
    tenant: "test-tenant",
    status: "triage",
    priority: 0,
    profile: "",
    provider: "",
    assignee: "",
    ...overrides,
  };
}
