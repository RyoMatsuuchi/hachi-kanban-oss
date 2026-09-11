# hachi-kanban v0.1 構築計画

## Wave 0: スキャフォールド + 契約（オーケストレーター）
- [x] リポジトリ初期化（pnpm workspace / tsconfig / eslint）
- [x] docs/contract.md（設計契約書）
- [x] packages/core/src/types.ts（凍結共有契約）
- [x] 依存インストール

## Wave 1: 基盤実装（Sonnet 5 並列）
- [x] @hachi/core: env / logger / db(KanbanStore) / statemachine / policy / redaction / messages / provenance + tests（86テスト通過）
- [x] @hachi/adapters: CodexAdapter / ClaudeAdapter / reason 書式 + tests（44テスト通過）
- [x] @hachi/testing: MockBridgeServer / fixtures + tests（10テスト通過）
- 申し送り: /api/status・/api/messages のレスポンス形状は契約未記載→トレラント実装。実 bridge との live probe が Wave 3 検証項目

## Wave 2: 上位実装（Sonnet 5 並列）
- [x] @hachi/supervisor: tick ループ + dispatch/monitor/finalize/messages/reap ステージ + tests（41テスト通過）
- [x] @hachi/cli: hachi board/task/msg/admin/doctor + tests（27テスト通過 + 実CLIスモーク）

## Wave 3: 統合・検証
- [x] 統合テスト（supervisor tests が MockBridge 経由の dispatch→finalize→messages を担保）
- [x] pnpm typecheck / test / lint 全通過（最終: 421テスト）
- [x] 実CLI e2e スモーク（一時HOME: create→board→doctor OK）
- [x] codex-review ×16巡 + 修正（P0=0 維持。11巡目以降は過剰修正気味 → 停止規則を lessons.md に記録）
- [x] 初回コミット（61146f4）

## v0.2（2026-07-02 実施済み）
- [x] bridge live probe（/api/status は busy/idle のみ・messages は type 判別イベントログと確定 → contract §13）
- [x] bridge 実仕様適合（終了検知 = idle + resultCount>=1、transcript は type ベース構築、MockBridge 実仕様化）
- [x] launchd 常駐化（com.hachi-kanban.supervisor。※StartInterval 自然発火せず → KeepAlive 化が残作業）
- [x] **実機 e2e 完走**（実 Codex worker: ready→launched→session_ended→finalized→done、handoff 実出力、約4分）
- [x] core: KanbanReadView（readonly 読み取りクエリ面、visibility_bucket 分類）
- [x] **@hachi/web 看板ビュー**（Hono SSR・127.0.0.1:9131・人間確認キュー/自律進行レーン・詳細・transcript/artifact 表示・実データスモーク済み）
- [x] セッション統計の永続化（result イベントの costUsd/tokens → task_runs.meta.lastResult、web 表示）
- [x] codex レビュー1巡（停止規則適用）→ P0(artifact パス逸脱)/P1(コスト表示キー) 修正

## v0.3（2026-07-02 実施済み — 運用課題バックログ #1〜#6 完了）
- [x] #1 review ステージ（reviewer 自律起動 + verdict 検証。実機 e2e: worker→reviewer 2セッション連鎖で done 完走）
- [x] #2 Claude ワーカー実機 e2e（3457 経由、62秒で自律完走、コスト記録 $0.20/4turns）
- [x] #3 旧ボード import（admin import-legacy。実 DB から 28件移行、旧 prefix は needs-manual (imported) 変換）
- [x] #4 direct transport（codex exec -c model=。実機で model: gpt-5.4 配信確認。profile 単位 opt-in・G2 非表示トレードオフ）
- [x] #5 notify ステージ（human_queue 入りを macOS 通知。reasonHash 冪等）
- [x] #6 バックアップ（admin backup、世代14、daily plist テンプレ）+ 旧パイプラインデーモン9本 kill-switch 停止（bridge 3456/3457 は維持）
- [x] launchd KeepAlive+内部ループ化（on-demand-only mode 対策、30秒 tick 自然駆動実証）
- 運用整備: 新 hachi-kanban スキル / 旧スキル3本アーカイブ / AGENTS.md / task move（promote 経路）

## Follow-up（v0.4 候補）
- [ ] web での verdict 表示（review ステージのイベント/コメントは表示済み、専用 UI は未）
- [ ] KanbanReadView.retryPendingCount() / links の N+1 解消（board 性能）
- [ ] task_runs.ended_at が検知時刻になる件（result イベント時刻の採用）
- [ ] core: EnqueuePayload/SteerPayload の Record 代入互換 / DEFAULT_CONFIG export
- [x] Claude direct transport（モデル実配信の Claude 版）→ **§22 で v0.4 実装済み**（2026-07-05 実態同期）
- [x] 自動 rework（review fail 後の bounded 再作業）→ **§21 で v0.4 実装済み**（2026-07-05 実態同期）
- [x] 旧システムの完全退役判断（bridge の自前化 or 継続利用、旧 LaunchAgent の bootout、旧リポジトリの扱い）
      → 看板 t_a99dd71275d187db で実施済み。記録: `tasks/old-system-retirement-20260707.md`

## v0.7（2026-07-05 夜間セッション、進行中）

バリュー最大化レポート（ローカルのノート。リポジトリ外）に基づく信頼性・統制の補強。
看板に13タスク起票済み（今夜直轄5件 = t_f395454e/t_9c280592/t_1e646569/t_1d5d5348/t_1db15e8f、
引き継ぎ8件 = Telegram out/in・steward 契約起草（採番は起草時の契約末尾に従う）・verify ゲート・メトリクス・lessons・CI・旧系統退役）。

- [x] 契約 §33-§36 起草 + types.ts（EffortLevel/StopResult/stop?/maxRunSeconds）+ policy effort 解決
- [x] §33 supervisor watchdog（heartbeat + 独立監視 + doctor 拡張）
- [x] §34 adapter 信頼性（GET リトライ・worker stop・max 実行時間・tick 観測）
- [x] §35 effort 伝搬（codex: -c model_reasoning_effort / claude: --effort、bridge は effortDelivery=none 記録）
- [x] §36 hachi board human_queue + --tenant
- [x] codex レビュー1巡（gpt-5.5 high、停止規則適用）→ P0×1（direct stop の pid 検証/exitFile 事前確認）
      P1×2（monitor max-runtime の Tx 再検証 / watchdog 環境変数検証）修正済み。
      follow-up 記録: review.ts の stop 前 CAS 再検証 / board --tenant の counts 最適化（看板コメント参照）
- 検証: typecheck 全通過 / テスト 811件全緑 / eslint クリーン
- [x] ドキュメント同期（§5 DDL id 桁 / §9 将来表現 / §10 確定ステージ順 / §12.3 置換注記 /
      planner スキルの依存ゲート陳腐化修正 / 本ファイル）

## Review
- v0.1 を 61146f4 として初回コミット（2026-07-02）。
- 実装は全て Sonnet 5 サブエージェント（Wave 1: core/adapters/testing 並列、Wave 2: supervisor/cli 並列、
  修正 Wave ×9）。オーケストレーターは契約（docs/contract.md / types.ts）とレビューゲートを担当。
- codex レビュー（gpt-5.5, effort high）×16巡。P0 は全巡ゼロ。§12.4〜§12.19 として契約に反映。
- 最終状態: 5パッケージ / テスト421件 / typecheck・eslint クリーン / 実CLIスモーク通過。
- 反省: レビュー反復は11巡目以降過剰だった（lessons.md 参照）。次回から停止規則を先に宣言する。
