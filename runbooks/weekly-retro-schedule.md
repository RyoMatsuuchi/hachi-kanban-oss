# 週次レトロスペクティブスケジュール

## 概要

毎週金曜 18:00（JST）に自動でレトロスペクティブレポートタスクを作成するスケジュール雛形。
worker が `http://127.0.0.1:9131/api/metrics?days=7` から直近 7 日間のデータを取得し、スループット・成功率・
rework 率・human_queue 滞留時間・profile 別コストをサマリしてタスクコメントに書き出す。

- 契約: `docs/contract.md` §43.2（メトリクス API）
- CLI: `hachi schedule create`（`docs/contract.md` §29.3）
- API エンドポイント: `GET /api/metrics?days=7`

## 登録コマンド

```bash
pnpm hachi schedule create \
  --name "weekly-retro" \
  --cadence weekly \
  --at "18:00" \
  --weekday 5 \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --prompt "週次レトロスペクティブレポートを作成してください。

## 手順

1. GET http://127.0.0.1:9131/api/metrics?days=7 を呼び出して直近7日間のメトリクスを取得する
2. 以下の観点でレポートを作成する:

### スループット
- throughput 配列から日別の done 数を表にまとめる
- 7日間の合計と日平均を算出する

### run 成功率
- runSuccess.rate をパーセント表示する
- failed が 0 でなければ失敗 run の傾向を分析する

### rework 率
- rework.rate をパーセント表示する
- rework が多い場合は原因仮説を添える

### human_queue 滞留時間
- humanQueueDwell のバケット分布を表にする
- 滞留が長い（>12h, >24h）件数が多い場合は改善提案を添える

### コスト（profile x provider）
- profileProviderStats を profile・provider ごとの表にまとめる
- totalCostUsd の合計と、前週比が取れる場合は比較する

3. レポートをタスクコメントとして書き出す（Markdown 形式）
4. 特筆すべき異常値やトレンドがあれば最後に「所見」セクションを追加する"
```

### オプション: テナント指定

マルチテナント環境で特定テナントのみのレトロを取りたい場合は `--tenant` を追加する。

```bash
pnpm hachi schedule create \
  --name "weekly-retro-tenant-a" \
  --cadence weekly \
  --at "18:00" \
  --weekday 5 \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --tenant "tenant-a" \
  --prompt "（上記と同じプロンプト）"
```

### オプション: profile 指定

レトロタスクを特定の profile（モデル）で実行したい場合は `--profile` を追加する。
`hachi.config.ts` の `profiles` に定義済みの名前を指定すること。

```bash
pnpm hachi schedule create \
  --name "weekly-retro" \
  --cadence weekly \
  --at "18:00" \
  --weekday 5 \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --profile "sonnet" \
  --prompt "（上記と同じプロンプト）"
```

## 登録後の確認

```bash
# 一覧で確認
pnpm hachi schedule list

# 詳細確認（ID は list で取得）
pnpm hachi schedule show <schedule-id>
```

出力例:

```
sch_xxxx [enabled] weekly weekday=5 at=18:00 tenant=- profile=- weekly-retro
```

## 運用

### 無効化 / 有効化

```bash
# 一時的に止める（祝日週など）
pnpm hachi schedule disable <schedule-id>

# 再開
pnpm hachi schedule enable <schedule-id>
```

### 削除

```bash
pnpm hachi schedule delete <schedule-id>
```

### 実行タイミングの変更

スケジュールの更新 CLI は現状提供されていないため、削除 → 再作成で対応する。

```bash
pnpm hachi schedule delete <schedule-id>
# 例: 月曜 09:00 に変更
pnpm hachi schedule create \
  --name "weekly-retro" \
  --cadence weekly \
  --at "09:00" \
  --weekday 1 \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --prompt "（同じプロンプト）"
```

## カスタマイズガイド

### プロンプトの調整

`--prompt` の内容は自由に変更可能。以下のような観点を追加・削除できる。

| 追加候補 | 説明 |
|----------|------|
| tickMetrics の分析 | supervisor の各ステージの処理時間・アクション数のトレンド |
| 週次比較 | 前週のレポートとの差分を自動で比較させる |
| アクションアイテム | レポート末尾に改善アクションの提案を含める |
| 通知連携 | レポート作成後に Slack 通知を送る指示を含める |

### cadence の変更

週次以外のスケジュールも同じ CLI で登録できる。

```bash
# 日次（毎日 09:00）
pnpm hachi schedule create \
  --name "daily-metrics-summary" \
  --cadence daily \
  --at "09:00" \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --prompt "日次メトリクスサマリを作成してください。..."

# 月次（毎月1日 10:00）
pnpm hachi schedule create \
  --name "monthly-retro" \
  --cadence monthly \
  --at "10:00" \
  --day 1 \
  --cwd ~/.hachi-kanban/worktrees/hk-metrics \
  --prompt "月次レトロスペクティブレポートを作成してください。..."
```

## メトリクス API レスポンス形状

worker がプロンプトを実行する際に参照する `/api/metrics` のレスポンス構造
（`packages/web/src/shared/api-types.ts` MetricsResponse）:

```typescript
interface MetricsResponse {
  period: { from: number; to: number };
  throughput: { date: string; count: number }[];
  runSuccess: { total: number; succeeded: number; failed: number; rate: number };
  rework: { totalDone: number; reworked: number; rate: number };
  humanQueueDwell: { bucket: string; count: number }[];
  profileProviderStats: { profile: string; provider: string; runCount: number; totalCostUsd: number }[];
  tickMetrics: { ts: number; stage: string; actions: number; durationMs: number }[];
}
```

## 関連

- `docs/contract.md` §29.3 — `hachi schedule create` CLI 仕様
- `docs/contract.md` §43.2 — メトリクス API 仕様
- `packages/cli/src/commands/schedule.ts` — schedule サブコマンド実装
- `packages/core/src/metrics.ts` — メトリクス集計クエリ
- `packages/web/src/shared/api-types.ts` — MetricsResponse 型定義
- `runbooks/supervisor-launchd-setup.md` — supervisor セットアップ（スケジュール実行基盤）
