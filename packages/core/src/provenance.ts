// =============================================================================
// provenance ユーティリティ（docs/contract.md §0 two-party gate 用）
// nonce 生成とハッシュ計算のみを提供する。検証ロジック自体は host 側の責務。
// =============================================================================

import { createHash, randomBytes } from "node:crypto";

/** 16 hex（8 バイト）のランダム nonce を生成する */
export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/** 文字列の SHA-256 ハッシュを16進小文字文字列で返す */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
