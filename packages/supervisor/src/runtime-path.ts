import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** verify 実行証拠へ保存する固定識別子。PATH 値そのものは永続化しない。 */
export const VERIFY_RUNTIME_PATH_SOURCE = "runtime-path-v1" as const;

const KNOWN_TOOLCHAIN_DIRECTORIES = [".vite-plus/bin", ".local/bin", ".n/bin"] as const;

export interface RuntimePathInput {
  home: string | undefined;
  basePath: string | undefined;
  directoryExists: (path: string) => boolean;
}

export interface RuntimePath {
  path: string;
  source: typeof VERIFY_RUNTIME_PATH_SOURCE;
  /** verify 出力の永続化前に置換する値。実行証拠そのものには含めない。 */
  sensitiveValues: readonly string[];
}

/** 実ファイルシステム向けの directory 判定。参照不能・不在は安全側に skip する。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * supervisor の基底 PATH へ既知 toolchain directory だけを決定論的に前置する。
 * task body、repo .env、対話 shell の状態は入力に取らない。
 */
export function buildRuntimePath(input: RuntimePathInput): RuntimePath {
  const home = input.home;
  const normalizedHome =
    home !== undefined && home.trim() !== "" && isAbsolute(home) ? resolve(home) : null;
  const knownDirectories =
    normalizedHome !== null
      ? KNOWN_TOOLCHAIN_DIRECTORIES.map((directory) => join(normalizedHome, directory)).filter((directory) =>
          input.directoryExists(directory),
        )
      : [];
  const baseDirectories = (input.basePath ?? "").split(":").filter((directory) => directory !== "");
  const directories = [...new Set([...knownDirectories, ...baseDirectories])];
  const path = directories.join(":");

  return {
    path,
    source: VERIFY_RUNTIME_PATH_SOURCE,
    sensitiveValues: [path, ...(normalizedHome === null ? [] : [normalizedHome])].filter(
      (value) => value !== "",
    ),
  };
}
