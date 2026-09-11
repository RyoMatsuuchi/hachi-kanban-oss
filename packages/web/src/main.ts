#!/usr/bin/env node
// =============================================================================
// @hachi/web の実環境エントリポイント（docs/contract.md §20.1）。
// dist/ が無ければ vite build を実行し、env 解決 → KanbanReadView 生成 → buildApp →
// Node サーバ起動、を行う薄い層。実装への依存（sqlite readonly 接続・vite build 等）は
// このファイルだけが持つ。app.ts は型のみに依存する。
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
// createKanbanReadView は core 側の readonly 接続 factory（packages/core/src/readview.ts）。
// 実 DB（sqlite readonly）への依存はこのファイルだけが持ち、app.ts / テストは
// KanbanReadView を型としてのみ利用する（docs/contract.md §14.4）。
import {
  resolveEnvironment,
  createKanbanReadView,
  createRuntimeResourceReadView,
  loadConfig,
  SqliteKanbanStore,
} from "@hachi/core";
import { buildApp } from "./app.js";
import { ensureWebToken, type WebTokenWarnFields } from "./write-auth.js";

/** HACHI_KANBAN_WEB_PORT 既定値（docs/contract.md §14.2。旧 dashboard 9129 と衝突回避） */
const DEFAULT_PORT = 9131;

/** supervisor launchd のジョブラベル既定値（runbooks/supervisor-launchd-setup.md。docs/contract.md §23.1） */
const DEFAULT_SUPERVISOR_LAUNCHD_LABEL = "com.hachi-kanban.supervisor";

const __dirname = dirname(fileURLToPath(import.meta.url));
// main.ts は packages/web/src/main.ts に配置されるため、2階層上がパッケージルート
const packageRoot = resolve(__dirname, "..");
const distDir = resolve(packageRoot, "dist");

/** HACHI_KANBAN_WEB_PORT を解決する。不正な値は fail-closed で throw する */
function resolvePort(processEnv: NodeJS.ProcessEnv): number {
  const raw = processEnv.HACHI_KANBAN_WEB_PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`不正な HACHI_KANBAN_WEB_PORT です: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`不正な HACHI_KANBAN_WEB_PORT です: ${raw}`);
  }
  return parsed;
}

function writeWarnJsonl(message: string, fields: WebTokenWarnFields): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", message, ...fields })}\n`);
}

/**
 * dist/index.html が無ければ vite build を実行してから起動する（docs/contract.md §20.1
 * 「dist 不在なら vite build → serve」）。プログラマティック API を使い、`pnpm` 等の
 * 外部コマンドが PATH 上にあるかに依存しないようにする。
 */
async function ensureBuilt(): Promise<void> {
  if (existsSync(resolve(distDir, "index.html"))) {
    return;
  }
  process.stdout.write("hachi-web: dist が見つからないため vite build を実行します...\n");
  const { build } = await import("vite");
  await build({ root: packageRoot });
}

async function main(): Promise<void> {
  await ensureBuilt();

  const env = resolveEnvironment(process.env);
  const config = loadConfig(env);
  const port = resolvePort(process.env);
  const writeToken = ensureWebToken(env.home, writeWarnJsonl);

  // 読み取り専用接続（readonly: true, fileMustExist: true）は core 側の factory 実装に委ねる。
  const view = createKanbanReadView(env.dbPath);
  const runtimeResourceView = createRuntimeResourceReadView(env.dbPath);
  const store = new SqliteKanbanStore(env.dbPath);
  const app = buildApp({
    view,
    store,
    artifactsDir: env.artifactsDir,
    bridges: env.bridges,
    config,
    writeToken,
    // kill-switch ファイルの配置ディレクトリは env.home 直下固定（docs/contract.md §23.2）
    home: env.home,
    launchdLabel: DEFAULT_SUPERVISOR_LAUNCHD_LABEL,
    metricsDbPath: env.dbPath,
    runtimeResourceView,
    humanDecisionView: view,
    humanDecisionAnswerStore: store,
    staticDir: distDir,
  });

  // bind は 127.0.0.1 固定（docs/contract.md §14.2）
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    process.stdout.write(`hachi-web: listening on http://127.0.0.1:${info.port} (board=${env.board})\n`);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`hachi-web: 起動に失敗しました: ${message}\n`);
  process.exitCode = 1;
});
