// 実プロセス / 実 MockBridgeServer / 実ファイルシステムを起こすテストがあり、
// ファイル並列実行では作業ディレクトリ配下の fixture が相互干渉する（t_52d07696b9de200e）。
// 直列化で失敗は 6〜15 件から 0〜1 件へ落ちる。所要は並列 185s に対し
// 直列 181〜296s（6 回の実測・中央値およそ 232s）で、おおむね 1.25 倍かかる。
// 直列化しても 5 秒境界に居るテストが1件あるため timeout も併せて伸ばす。
// 根因（fixture を process.cwd() 配下に作ること）の是正は t_9585c1d226c2fec9。
// それが入ったら fileParallelism を戻せるか再評価する。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
