# hachi-kanban

ローカル運用の自律型エージェント向け看板（kanban）基盤です。
オーケストレーター（人間または上位エージェント）がタスクを board に積み、
supervisor が worker エージェント（Codex / Claude の CLI）を起動して実装・レビュー・
終端処理まで回す、という運用をひとつの状態機械として実装しています。

状態はすべてローカルの SQLite に持ちます。SaaS も外部 API サーバも前提にしません。

> **位置づけ**: これは作者個人のローカル運用のために作られた実験的なシステムです。
> 汎用プロダクトとして整備されたものではなく、後方互換性・サポート・SLA の約束はありません。
> 公開しているのは、同じ問題に取り組む人が設計や実装を参照できるようにするためです。
> そのまま使うより、読んで持ち帰る前提で見てください。
> 報告の窓口は [`SECURITY.md`](SECURITY.md)、変更の出し方は
> [`CONTRIBUTING.md`](CONTRIBUTING.md) にあります。

## 何をするものか

- **タスクの状態機械**: triage → ready → in-progress → review → done を単一書込パスで遷移させ、
  すべての遷移をイベントとして記録する
- **worker の起動と回収**: ready なタスクに対して worker エージェントを起動し、
  成果（handoff）と品質検証（verify）の結果で終端を決める
- **レビュー工程**: worker の成果を別のエージェント（reviewer）に渡し、verdict を board に戻す
- **エージェント間メッセージ**: `agent.message.v1` でオーケストレーター・worker・reviewer 間の
  指示、質問、エスカレーションを board 経由で durable に運ぶ
- **人間への確認キュー**: 判断が必要になった時点で作業を止め、人間の決定を待つ
- **ローカル Web 看板**: ブラウザから board の状態・イベント・メッセージを読む

## 構成

pnpm workspace のモノレポです。

| パッケージ | 責務 |
|---|---|
| `packages/core` (`@hachi/core`) | 型契約・SQLite 単一書込パス・状態機械・policy・`agent.message.v1` |
| `packages/adapters` (`@hachi/adapters`) | Codex / Claude worker adapter（direct または bridge） |
| `packages/supervisor` (`@hachi/supervisor`) | dispatch / monitor / finalize / messages / reap の常駐実行 |
| `packages/cli` (`@hachi/cli`) | `hachi` CLI |
| `packages/web` (`@hachi/web`) | ローカル Web 看板（Hono + React + Vite） |
| `packages/testing` (`@hachi/testing`) | mock bridge・fixture・統合テスト |

Git で共有されるのはソフトウェアだけです。SQLite DB、config、token、artifact は
各マシンの `$HACHI_KANBAN_HOME` に作られ、リポジトリには入りません。

## 前提

- macOS（LaunchAgent を使わない foreground 実行なら Linux でも動きます）
- Git — supervisor の finalize / review / monitor が `git` を直接実行します
- Node.js 22.13 以上（`bin/hachi` が起動時に検査し、不足なら exit 127）
- pnpm 10.17.1 — 依存 install、root の `pnpm <script>` 起動、LaunchAgent の
  `ProgramArguments` で使います（`bin/hachi` を直接叩く経路だけは pnpm を経由しません）
- direct transport の場合は、利用する `codex` / `claude` CLI と、その認証
- `sqlite` コマンドは不要です。DB アクセスは npm の `better-sqlite3` だけを使います

構成によって追加で必要になるもの。

- `tmux` — `hachi orchestrator handover` / 後継起動を使う場合。稼働中の
  orchestrator session がある状態で `tmux` が無いと `hachi doctor` が失敗します
- `python3` — `~/.local/bin` に入る運用ヘルパー 5 本のうち 4 本
- Docker と `lsof` — config に `runtimeResources` を書いて runtime resource profile
  を使う場合のみ（`hachi resource *` 系）

## セットアップ

```bash
git clone <repository-url>
cd hachi-kanban
pnpm install --frozen-lockfile

# まず変更内容だけ表示する（setup は既定で dry-run）
node scripts/setup-local.mjs

# direct 構成、ローカル state、CLI symlink、運用ヘルパーシムを作成する
node scripts/setup-local.mjs --apply --skip-install --transport direct

# symlink もヘルパーシムも置かない場合（hachi doctor の
# "orchestrator helpers" 検査は NG になる。下記の注記参照）
node scripts/setup-local.mjs --apply --skip-install --transport direct --no-link

# config / ローカル state の確認。runtime readiness はサービス起動後に full doctor で確認する
~/.local/bin/hachi doctor --offline
```

`--apply` を付けても、既存の `$HACHI_KANBAN_HOME/config.json` や
別の `~/.local/bin/hachi` は上書きしません。同じ引数での再実行は冪等です。

`--no-link` を付けない場合、`~/.local/bin` には `hachi` の symlink に加えて
オーケストレーター運用ヘルパーの exec シム（`hachi-handover-now`、`hhn`、
`hachi-orch-enable`、`cc-cache-ttl`、`hachi-watch-stop`）も作られます。
CLI 本体の動作には不要ですが、`hachi doctor` の `orchestrator helpers` 検査は
この 5 本が揃っていることを合格条件にしており、欠けていると doctor 全体が
exit 1 になります（`packages/cli/src/commands/doctor.ts` の
`checkOrchestratorHelpers`）。`--no-link` で入れた場合は、この 1 項目が
NG になるのを承知で使ってください。5 本のうち 4 本（`hachi-handover-now`、`hhn`、
`cc-cache-ttl`、`hachi-watch-stop`）は `python3` を要求します。

詳しい要件、環境変数、bridge 構成、LaunchAgent は
[`docs/portable-install.md`](docs/portable-install.md) を参照してください。

### transport の選択

| transport | 必要なもの | 用途 |
|---|---|---|
| `direct` | provider CLI、ログイン、利用可能な model | 新規導入の推奨。リポジトリ外の bridge に依存しない |
| `bridge` | 外部 bridge サービス、その URL、0600 の token file | 既存の bridge 運用向け。bridge 実装自体はこのリポジトリに含まれない |

bridge token の既定配置は `$HACHI_KANBAN_HOME/credentials/{codex,claude}-bridge-token` です。
別の配置を使う場合は `HACHI_CODEX_BRIDGE_TOKEN_FILE` /
`HACHI_CLAUDE_BRIDGE_TOKEN_FILE` で明示します。

`examples/config.direct.json` の model は例です。アカウントで利用できる model と
runtime version を `hachi doctor` で確認し、必要なら config の profile、allowlist、
`modelTransportPolicies` を合わせてください。互換性を推測した fallback はしません。

なお `hachi doctor` が green でも direct の readiness は証明されません。
`codex` / `claude` CLI が見つからない場合、`model transport (<profile>)` 検査は
fail ではなく `警告:` 付きの合格（decision=unknown）になります
（`packages/cli/src/model-transport-observability.ts`）。実際に worker が起動するかは
1 タスク流して確認してください。

## CLI

依存関係を install 済みなら、リポジトリの `bin/hachi` は clone 位置から root を解決します。
非対話環境で Node.js が見つからない場合は、実行可能ファイルの絶対パスを
`HACHI_NODE_BIN` で指定できます。

```bash
bin/hachi board
bin/hachi doctor --offline   # 設定の構文確認用。runtime readiness の証明ではない
bin/hachi task list --json
```

root の pnpm script も利用できます。

```bash
pnpm hachi board
pnpm supervisor --once
pnpm web
```

worker / reviewer はタスクごとに model、effort、speed を指定できます。
実際に解決される値は、config・runtime policy・provider の可用性で変わるため、
README の値をそのまま運用へ写さず `hachi admin resolve` で確認してください。

```bash
# 最小形。--title / --body / --tenant が必須オプション
hachi task create --title "..." --body "..." --tenant dev

# オーケストレーターとして作る場合（--actor-kind orchestrator は
# --orchestrator / --session / --generation を 3 つとも要求し、
# 有効な orchestrator session が board に登録されている必要がある）
hachi task create --title "..." --body "..." --tenant dev \
  --actor-kind orchestrator --orchestrator <id> --session <session-id> --generation <n>

hachi admin resolve <task-id> --role all --json
```

## 開発

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter @hachi/web build
```

v0.1 は `tsx` によるソース実行で、npm package / release artifact は提供していません。

Git hooks は husky です。pre-commit が typecheck と staged TypeScript の lint、
pre-push がフルテストを実行します。詳細は
[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。

## ドキュメントの読み方

このリポジトリのドキュメントは日本語が正本です。

| ドキュメント | 位置づけ |
|---|---|
| [`docs/contract.md`](docs/contract.md) | **仕様の正本**。状態機械、データモデル、policy、不変条件はすべてここで定義する |
| [`runbooks/orchestrator-playbook.md`](runbooks/orchestrator-playbook.md) | **運用の正本**。判断規律・切りどき・監視・終端対応の分岐 |
| [`runbooks/orchestrator-reference.md`](runbooks/orchestrator-reference.md) | **手順書**。playbook が参照する具体的なコマンド列 |
| [`docs/portable-install.md`](docs/portable-install.md) | 導入手順、環境変数、LaunchAgent |
| `docs/plans/` | 設計中・検討中のプラン |

実装と仕様が食い違っている場合、`docs/contract.md` が正しく、実装がバグです。
playbook / reference は全文を読む前提では書かれていません。
playbook 冒頭の索引から、必要な節だけ引いてください。

## ライセンス

MIT License。[`LICENSE`](LICENSE) を参照してください。
