// 実 TCP listener（MockBridgeServer）と実 /usr/sbin/lsof を起こすテストがあり、
// pnpm -r test が package 群を同時に走らせると 5 秒の既定 timeout を超える（t_17d3d4a6a19988af）。
// 単独実行では 3.56s / ファイル並列 ON のままでも 795 全通過するため、
// 直列化はせず timeout だけを伸ばす。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
