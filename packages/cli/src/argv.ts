// =============================================================================
// グローバルフラグ（--board / --debug）の argv 事前スキャン。
// hachi task create / hachi admin set-model のように複数階層のサブコマンドが存在するため、
// commander の階層別オプション解決（親コマンドの前に置かないと拾われない等）に頼らず、
// main.ts で argv を一度だけ舐めて取り除いてから commander に渡す。
// =============================================================================

/**
 * argv 先頭に連続する "--" セパレータを全て取り除く（docs/contract.md §12.9-4）。
 * `pnpm hachi -- board` のように pnpm スクリプト側の "--" とユーザー指定の "--" が重なると
 * 二重・三重になり得るため、1つだけでなく先頭に連続する分を全て除去する。
 */
export function stripLeadingSeparators(argv: readonly string[]): string[] {
  let start = 0;
  while (argv[start] === "--") {
    start += 1;
  }
  return argv.slice(start);
}

/** extractGlobalFlags の戻り値 */
export interface ExtractedGlobalFlags {
  /** --board <name> / --board=<name> で指定された値（HACHI_KANBAN_BOARD より優先） */
  boardOverride: string | undefined;
  /** --debug 指定の有無 */
  debug: boolean;
  /** --board / --debug を取り除いた残りの argv（commander に渡す） */
  rest: string[];
}

/** argv から --board / --debug を抽出し、取り除いた残りを rest として返す */
export function extractGlobalFlags(argv: readonly string[]): ExtractedGlobalFlags {
  const rest: string[] = [];
  let boardOverride: string | undefined;
  let debug = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--board") {
      // 次トークンが欠落 or "-" 始まり（別フラグの取り違え）の場合は、黙って次トークンを消費せず
      // エラーにする（docs/contract.md §12.10-4, fail-closed）。
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--board オプションには値を指定してください");
      }
      boardOverride = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--board=")) {
      const value = arg.slice("--board=".length);
      if (value === "") {
        throw new Error("--board オプションには値を指定してください");
      }
      boardOverride = value;
      continue;
    }
    if (arg === "--debug") {
      debug = true;
      continue;
    }

    rest.push(arg);
  }

  return { boardOverride, debug, rest };
}
