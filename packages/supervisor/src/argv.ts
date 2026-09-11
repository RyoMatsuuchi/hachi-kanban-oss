// =============================================================================
// @hachi/supervisor CLI の argv 解析（docs/contract.md §12.9-4, §12.9-6）。
// main.ts から parseArgs をテスト容易な形へ切り出したもの。
// =============================================================================

const DEFAULT_INTERVAL_SEC = 30;

export interface SupervisorCliOptions {
  apply: boolean;
  once: boolean;
  intervalSec: number;
  board: string | undefined;
}

/**
 * argv 先頭に連続する "--" セパレータを全て取り除く（docs/contract.md §12.9-4）。
 * `pnpm supervisor -- --once` のように pnpm スクリプト側の "--" とユーザー指定の "--" が重なると
 * 二重・三重になり得るため、1つだけでなく先頭に連続する分を全て除去する。
 */
export function stripLeadingSeparators(argv: readonly string[]): string[] {
  let start = 0;
  while (argv[start] === "--") {
    start += 1;
  }
  return argv.slice(start);
}

/**
 * --interval の値を厳格パースする（docs/contract.md §12.9-6）。
 * 正の整数の文字列表現のみ受理する。'1abc' のような部分数値・'0'・負値・小数はすべて拒否する（fail-closed）。
 */
export function parseIntervalSec(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--interval の値が不正です（正の整数を指定してください）: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new Error(`--interval の値が不正です（正の整数を指定してください）: ${value}`);
  }
  return parsed;
}

/** process.argv.slice(2) 相当を解析する。先頭の "--" セパレータ除去も含む */
export function parseArgs(argv: readonly string[]): SupervisorCliOptions {
  const stripped = stripLeadingSeparators(argv);

  let apply = false;
  let once = false;
  let intervalSec = DEFAULT_INTERVAL_SEC;
  let board: string | undefined;

  for (let i = 0; i < stripped.length; i += 1) {
    const arg = stripped[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--interval") {
      i += 1;
      const value = stripped[i];
      if (value === undefined) {
        throw new Error("--interval には値が必要です");
      }
      intervalSec = parseIntervalSec(value);
    } else if (arg === "--board") {
      i += 1;
      const value = stripped[i];
      // 次トークンが欠落 or "-" 始まり（別フラグの取り違え）の場合は、黙って次トークンを消費せず
      // エラーにする（docs/contract.md §12.10-4, fail-closed）。
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--board には値が必要です");
      }
      board = value;
    } else {
      // 契約 §12.11-5: 未知フラグは throw する（typo による意図しない dry-run 起動を防ぐ、fail-closed）
      throw new Error(`未知のフラグです: ${arg}`);
    }
  }

  return { apply, once, intervalSec, board };
}
