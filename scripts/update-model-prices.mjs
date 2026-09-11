#!/usr/bin/env node
// LiteLLM の model_prices_and_context_window.json から、hachi が実際に起動しうるモデルの
// 単価だけを抜き出して packages/core/src/model-prices.generated.ts を再生成する。
//
// 使い方: node scripts/update-model-prices.mjs
//
// なぜ subset を vendoring するか（設計 R1 の「単価表と算出式だけ借りる」の実装）:
//   - LiteLLM の原本は 1.7MB / 1000モデル超。実行時 fetch は supervisor をネットワーク依存にし、
//     test も非決定になる。必要なのは数十モデルだけなので生成物を repo に固定する
//   - ccusage 本体は依存に入れない（R1 の決定）。参照するのは同じ LiteLLM の JSON
//
// 更新手順:
//   1. このスクリプトを実行する（GitHub から最新版と commit sha を取得する）
//   2. 生成された diff を確認し、PRICE_TABLE_REF の sha が更新されていることを確かめる
//   3. `pnpm --filter @hachi/core test` を通す
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const COMMITS_API =
  "https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1";

// 収録対象。hachi の起動面（config の model 指定・per-task override）と、
// claude のサブエージェント/advisor が内部で使うモデルを含む。前方一致ではなく完全一致で引く。
const WANTED = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
];

async function main() {
  const [tableRes, commitRes] = await Promise.all([fetch(RAW_URL), fetch(COMMITS_API)]);
  if (!tableRes.ok) throw new Error(`価格表の取得に失敗しました: ${tableRes.status}`);
  if (!commitRes.ok) throw new Error(`commit 情報の取得に失敗しました: ${commitRes.status}`);
  const table = await tableRes.json();
  const commits = await commitRes.json();
  const sha = commits[0]?.sha;
  const date = commits[0]?.commit?.committer?.date;
  if (typeof sha !== "string" || typeof date !== "string") {
    throw new Error("commit sha / date を特定できませんでした");
  }

  const entries = [];
  const missing = [];
  for (const model of WANTED) {
    const row = table[model];
    if (row === undefined) {
      missing.push(model);
      continue;
    }
    entries.push([
      model,
      {
        inputCostPerToken: num(row.input_cost_per_token),
        outputCostPerToken: num(row.output_cost_per_token),
        // cache 単価が未掲載の provider は input 単価へフォールバックせず 0 も入れない。
        // null のまま持ち、算出側で「その内訳は価格不明」として扱う。
        cacheCreationCostPerToken: numOrNull(row.cache_creation_input_token_cost),
        // 1h TTL の cache write は 5m より高い。区別しないと 1h 分を過小評価する
        // （本機の実ログでは cache creation の 45% が 1h だった）。
        cacheCreation1hCostPerToken: numOrNull(row.cache_creation_input_token_cost_above_1hr),
        cacheReadCostPerToken: numOrNull(row.cache_read_input_token_cost),
      },
    ]);
  }
  if (missing.length > 0) {
    console.warn(`警告: 価格表に見つからなかったモデル: ${missing.join(", ")}`);
  }

  const body = entries
    .map(
      ([model, p]) =>
        `  ${JSON.stringify(model)}: {\n` +
        `    inputCostPerToken: ${p.inputCostPerToken},\n` +
        `    outputCostPerToken: ${p.outputCostPerToken},\n` +
        `    cacheCreationCostPerToken: ${p.cacheCreationCostPerToken},\n` +
        `    cacheCreation1hCostPerToken: ${p.cacheCreation1hCostPerToken},\n` +
        `    cacheReadCostPerToken: ${p.cacheReadCostPerToken},\n` +
        `  },`,
    )
    .join("\n");

  const out = `// 自動生成ファイル。手で編集しないこと。
// 生成元: LiteLLM model_prices_and_context_window.json
// 再生成: node scripts/update-model-prices.mjs
import type { ModelPrice } from "./usage-pricing.js";

/** 参照した価格表の版。RunUsage.costUsd（estimated）の priceTableRef に記録する。 */
export const PRICE_TABLE_REF = "litellm@${sha}(${date})";

/** LiteLLM から抜き出した 1トークンあたり USD 単価。完全一致でのみ引く（前方一致は禁止）。 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
${body}
};
`;

  const here = dirname(fileURLToPath(import.meta.url));
  const dest = join(here, "..", "packages", "core", "src", "model-prices.generated.ts");
  writeFileSync(dest, out, "utf8");
  console.log(`${dest} を更新しました（${entries.length} モデル / ${sha}）`);
}

function num(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`単価が数値ではありません: ${String(value)}`);
  }
  return value;
}

function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

await main();
