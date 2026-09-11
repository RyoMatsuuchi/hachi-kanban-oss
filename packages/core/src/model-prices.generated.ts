// 自動生成ファイル。手で編集しないこと。
// 生成元: LiteLLM model_prices_and_context_window.json
// 再生成: node scripts/update-model-prices.mjs
import type { ModelPrice } from "./usage-pricing.js";

/** 参照した価格表の版。RunUsage.costUsd（estimated）の priceTableRef に記録する。 */
export const PRICE_TABLE_REF = "litellm@e2c3f51c46aa2a11a930b6c19bc28e4144a38a1e(2026-09-02T04:46:46Z)";

/** LiteLLM から抜き出した 1トークンあたり USD 単価。完全一致でのみ引く（前方一致は禁止）。 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheCreationCostPerToken: 0.00000625,
    cacheCreation1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 5e-7,
  },
  "claude-sonnet-5": {
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.00001,
    cacheCreationCostPerToken: 0.0000025,
    cacheCreation1hCostPerToken: 0.000004,
    cacheReadCostPerToken: 2e-7,
  },
  "claude-fable-5-1": {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00005,
    cacheCreationCostPerToken: 0.0000125,
    cacheCreation1hCostPerToken: 0.00002,
    cacheReadCostPerToken: 2.5e-7,
  },
  "claude-fable-5": {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00005,
    cacheCreationCostPerToken: 0.0000125,
    cacheCreation1hCostPerToken: 0.00002,
    cacheReadCostPerToken: 0.000001,
  },
  "claude-haiku-4-5": {
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheCreationCostPerToken: 0.00000125,
    cacheCreation1hCostPerToken: 0.000002,
    cacheReadCostPerToken: 1e-7,
  },
  "claude-haiku-4-5-20251001": {
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheCreationCostPerToken: 0.00000125,
    cacheCreation1hCostPerToken: 0.000002,
    cacheReadCostPerToken: 1e-7,
  },
  "claude-opus-4-8": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheCreationCostPerToken: 0.00000625,
    cacheCreation1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 5e-7,
  },
  "claude-opus-4-7": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheCreationCostPerToken: 0.00000625,
    cacheCreation1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 5e-7,
  },
  "claude-opus-4-6": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheCreationCostPerToken: 0.00000625,
    cacheCreation1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 5e-7,
  },
  "claude-opus-4-5": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheCreationCostPerToken: 0.00000625,
    cacheCreation1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 5e-7,
  },
  "claude-sonnet-4-6": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheCreation1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 3e-7,
  },
  "claude-sonnet-4-5": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheCreation1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 3e-7,
  },
  "gpt-5.6": {
    inputCostPerToken: 0.000004,
    outputCostPerToken: 0.00002,
    cacheCreationCostPerToken: 0.000005,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 4e-7,
  },
  "gpt-5.6-sol": {
    inputCostPerToken: 0.000004,
    outputCostPerToken: 0.00002,
    cacheCreationCostPerToken: 0.000005,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 4e-7,
  },
  "gpt-5.6-luna": {
    inputCostPerToken: 2e-7,
    outputCostPerToken: 0.0000012,
    cacheCreationCostPerToken: 2.5e-7,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 2e-8,
  },
  "gpt-5.6-terra": {
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000012,
    cacheCreationCostPerToken: 0.0000025,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 2e-7,
  },
  "gpt-5.5": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.00003,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 5e-7,
  },
  "gpt-5.5-pro": {
    inputCostPerToken: 0.00003,
    outputCostPerToken: 0.00018,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 0.000003,
  },
  "gpt-5.4": {
    inputCostPerToken: 0.0000025,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 2.5e-7,
  },
  "gpt-5.4-mini": {
    inputCostPerToken: 7.5e-7,
    outputCostPerToken: 0.0000045,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 7.5e-8,
  },
  "gpt-5.4-nano": {
    inputCostPerToken: 2e-7,
    outputCostPerToken: 0.00000125,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 2e-8,
  },
  "gpt-5.4-pro": {
    inputCostPerToken: 0.00003,
    outputCostPerToken: 0.00018,
    cacheCreationCostPerToken: null,
    cacheCreation1hCostPerToken: null,
    cacheReadCostPerToken: 0.000003,
  },
};
