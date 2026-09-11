import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

function publicAsset(name: string): string {
  return fileURLToPath(new URL(`../public/${name}`, import.meta.url));
}

function readPngHeader(name: string): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
} {
  const bytes = readFileSync(publicAsset(name));
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24]!,
    colorType: bytes[25]!,
  };
}

describe("web icon assets", () => {
  it("keeps the canonical SVG square, margin-safe, and accent-only", () => {
    const canonical = readFileSync(publicAsset("icons/shiba.svg"), "utf8");
    const favicon = readFileSync(publicAsset("favicon.svg"), "utf8");

    expect(canonical).toContain('viewBox="0 0 100 100"');
    expect(canonical).toContain('transform="translate(-31.733929825 -31.443260425) scale(2.55)"');
    expect(canonical).toContain('fill="#2f9e77"');
    expect(canonical).not.toContain("#4a4636");
    expect(canonical).toContain('aria-label="Shiba logo"');
    expect(canonical.match(/#[0-9a-f]{6}/gi)).toEqual(["#2f9e77"]);

    const canonicalPath = canonical.match(/<path\b[^>]*>/s)?.[0];
    const faviconPath = favicon.match(/<path\b[^>]*>/s)?.[0];
    expect(canonicalPath).toBeDefined();
    expect(faviconPath).toBe(canonicalPath);
    const pathData = canonicalPath?.match(/\bd="([^"]*)"/s)?.[1];
    expect(pathData).toBeTruthy();
    expect(createHash("sha256").update(pathData ?? "").digest("hex")).toBe(
      "792b410d7c204223ed05369644c7c0e5301050a736b79a9be8668cf88cdc3b18",
    );
  });

  it("ships dimensioned RGBA PNGs for browser and PWA consumers", () => {
    const expected = [
      ["favicon-16x16.png", 16],
      ["favicon-32x32.png", 32],
      ["apple-touch-icon.png", 180],
      ["icon-192.png", 192],
      ["icon-512.png", 512],
    ] as const;

    for (const [name, size] of expected) {
      expect(readPngHeader(name)).toMatchObject({
        width: size,
        height: size,
        colorType: 6,
      });
    }
  });

  it("matches the linked PWA manifest and keeps all assets under public/", () => {
    const manifest = JSON.parse(readFileSync(publicAsset("manifest.webmanifest"), "utf8")) as {
      theme_color?: string;
      icons?: Array<{ src?: string; sizes?: string; type?: string }>;
    };
    expect(publicDirectory.endsWith("/public/")).toBe(true);
    expect(manifest.theme_color).toBe("#2f9e77");
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });
});
