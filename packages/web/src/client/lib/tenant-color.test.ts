// =============================================================================
// tenantHue のハッシュ安定性テスト。
// =============================================================================

import { describe, expect, it } from "vitest";
import { tenantHue } from "./tenant-color.js";

describe("tenantHue", () => {
  it("空文字は 0 を返す", () => {
    expect(tenantHue("")).toBe(0);
  });

  it("同じ文字列は常に同じ色相を返す（安定性）", () => {
    const hue = tenantHue("my-tenant");
    expect(tenantHue("my-tenant")).toBe(hue);
    expect(tenantHue("my-tenant")).toBe(hue);
  });

  it("異なる文字列は異なる色相を返す（衝突回避）", () => {
    const a = tenantHue("alpha");
    const b = tenantHue("beta");
    expect(a).not.toBe(b);
  });

  it("結果は 0–359 の範囲に収まる", () => {
    const tenants = ["dev", "staging", "production", "test-very-long-tenant-name-123"];
    for (const t of tenants) {
      const hue = tenantHue(t);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
