// =============================================================================
// web write API 用 token ファイル管理（docs/contract.md §31.1）。
// token 生値は戻り値としてのみ扱い、ログ・エラー・レスポンス用の文字列には含めない。
// =============================================================================

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const WEB_TOKEN_FILE_NAME = "web-token";
export const REQUIRED_WEB_TOKEN_MODE = 0o600;

export interface WebTokenWarnFields {
  path: string;
  mode: string;
  expectedMode: string;
}

export type WebTokenWarn = (message: string, fields: WebTokenWarnFields) => void;

export function webTokenPath(home: string): string {
  return join(home, WEB_TOKEN_FILE_NAME);
}

export function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function createWebTokenFileRaceSafe(filePath: string): void {
  const token = randomBytes(32).toString("hex");
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "wx", REQUIRED_WEB_TOKEN_MODE);
    writeSync(fd, token, 0, "utf8");
  } catch (error) {
    if (isFileExistsError(error)) {
      return;
    }
    throw error;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
  // umask の影響を排除し、生成ファイルは必ず 0600 に揃える。
  chmodSync(filePath, REQUIRED_WEB_TOKEN_MODE);
}

export function ensureWebToken(home: string, warn?: WebTokenWarn): string {
  const filePath = webTokenPath(home);
  mkdirSync(dirname(filePath), { recursive: true });
  createWebTokenFileRaceSafe(filePath);

  const stat = statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode !== REQUIRED_WEB_TOKEN_MODE) {
    warn?.("web-token mode is not 0600", {
      path: filePath,
      mode: formatFileMode(mode),
      expectedMode: formatFileMode(REQUIRED_WEB_TOKEN_MODE),
    });
  }

  const token = readFileSync(filePath, "utf8").trim();
  if (token === "") {
    throw new Error(`web-token が空です: ${filePath}`);
  }
  return token;
}
