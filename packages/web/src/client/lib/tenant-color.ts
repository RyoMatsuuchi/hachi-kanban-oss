// =============================================================================
// テナント名からハッシュ安定色相を算出する。同じテナント名は常に同じ色になる。
// =============================================================================

/** 文字列を整数ハッシュに変換する（djb2 変種） */
function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** テナント名から安定した色相（0–359）を返す。空文字は 0 を返す */
export function tenantHue(tenant: string): number {
  if (tenant === "") return 0;
  return ((hashCode(tenant) % 360) + 360) % 360;
}
