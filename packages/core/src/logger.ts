// =============================================================================
// 構造化 JSONL ロガー（docs/contract.md §2）
// console.log 直書き禁止の代替。filePath 指定時は追記、無指定時は stream（既定 stderr）へ出力する。
// =============================================================================

import { appendFileSync } from "node:fs";
import { rotateLogFileIfNeeded, type LogRotationConfig } from "./log-rotation.js";
import type { Logger } from "./types.js";

type LogLevel = "info" | "warn" | "error";

export interface CreateLoggerOptions {
  /** 指定時はこのファイルへ追記する（stream より優先） */
  filePath?: string;
  /** filePath 未指定時の出力先。既定は process.stderr */
  stream?: NodeJS.WritableStream;
  /**
   * filePath 指定時の size-based rotation 設定。未指定なら rotation しない
   * （既存の呼び出し元は無指定のままで挙動を変えない）。
   */
  rotation?: LogRotationConfig;
}

/** 構造化 JSONL ロガーを生成する */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return buildLogger(options, {});
}

/** 固定フィールドを畳み込みながらロガーを構築する内部ヘルパー */
function buildLogger(options: CreateLoggerOptions, fixedFields: Record<string, unknown>): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...fixedFields,
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (options.filePath !== undefined) {
      // 書き込み直前に同期で rotate する。appendFileSync は都度 path を open するため、
      // rotate 後にこの行を書けば新しい現行ファイルへ自然に入り、fd の差し替えは不要
      // （Node はシングルスレッドなので rotate〜append の間に他の書き込みが割り込まない。
      // ただし同一ファイルへ書く supervisor プロセスが単一である前提。多重起動時の
      // rename 競合までは面倒を見ない）。
      // rotate 自体の失敗（一時的な EPERM/EBUSY 等）でログ出力の呼び出し元を巻き込んで
      // クラッシュさせないよう fail-open にする（ログの目的は診断であり、ログ基盤の不調で
      // 常駐プロセス本体を落としてはならない）。
      if (options.rotation !== undefined) {
        try {
          rotateLogFileIfNeeded(options.filePath, options.rotation);
        } catch (err) {
          process.stderr.write(
            `log rotation に失敗しました。rotate をスキップして書き込みを継続します: ${(err as Error).message}\n`,
          );
        }
      }
      appendFileSync(options.filePath, line, "utf8");
    } else {
      (options.stream ?? process.stderr).write(line);
    }
  };

  return {
    info(msg: string, fields?: Record<string, unknown>): void {
      write("info", msg, fields);
    },
    warn(msg: string, fields?: Record<string, unknown>): void {
      write("warn", msg, fields);
    },
    error(msg: string, fields?: Record<string, unknown>): void {
      write("error", msg, fields);
    },
    child(fields: Record<string, unknown>): Logger {
      return buildLogger(options, { ...fixedFields, ...fields });
    },
  };
}
