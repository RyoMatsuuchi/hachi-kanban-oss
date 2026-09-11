// =============================================================================
// @hachi/web クライアント（React SPA）の Vite 設定（docs/contract.md §20.1）。
// root はパッケージ直下（index.html を配置）、出力は dist/（main.ts が読む固定パス）。
// =============================================================================

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
