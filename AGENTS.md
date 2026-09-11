# AGENTS.md — Codex セッション向けガイド

このリポジトリで作業する Codex（および他のコーディングエージェント）が守るべき最小限のルール。
**このファイルは worker/実装エージェント視点が主**。もしあなたが**オーケストレーター**（worker を
とりまとめる側）として起動された場合は、下記の運用正本を必ず読むこと。

## オーケストレーターとして動く場合（共通 core は provider 非依存、後継起動は provider 別）

- **0. 読み始める前に heartbeat を回す**（playbook §0.7.4 / knowledge `k_b248e07d575b`）。
  規則の読み込みは session の stale TTL（90秒）を超えうるため、**先に読むと自分の
  session が失効し takeover が要る**。自分のlive sessionが登録済みの場合に行う。
  未登録時は既存担当のheartbeatを操作せず、core §0.8の登録手順を確認する:

  ```bash
  SID=; GEN=; eval "$(hachi orchestrator session resolve --provider-session-id <provider-session-id>)"
  while true; do hachi orchestrator session heartbeat "$SID" --generation "$GEN" >/dev/null; sleep 30; done &
  ```

- **運用の正本（core）**: `runbooks/orchestrator-playbook.md`（判断規律・切りどき・立ち上げ・監視・
  終端対応の分岐・done 照合）。全providerが冒頭「段階的な読み方」の必読節と作業別索引に従う。
  Claude向け起動・過去事故の説明まで毎回全文を読み込まない。
- **作業時参照（reference）**: `runbooks/orchestrator-reference.md`（起票・worktree・統合チェックリスト・
  後継起動・インシデント・並行共存・ポート台帳・他リポジトリからの利用）。
  **全文を読まない。** core 冒頭の trigger index で、これから入る作業の節だけを引く
- **仕様の正本**: `docs/contract.md`
- **最近の仕様・運用変更**: `python3 scripts/read-operations.py knowledge --limit 20`（更新順・本文なし。設計前は`--query`で対象を検索し、関連IDだけ`hachi knowledge show`）
- CLI はどの cwd からでも `hachi <cmd>`（`~/.local/bin/hachi` シム）。無ければ repo の
  `bin/hachi <cmd>`（PATH 補完済みで非対話サンドボックスでも動く）。
  従来の `pnpm --dir ~/develop/private/hachi-kanban --silent hachi <cmd>` は pnpm が PATH にある環境向け。
- スキル（`~/.claude/skills/hachi-kanban*`）は Claude Code 専用だが**中身は上記正本への薄い入口**なので、
  Codex は正本を直接読めば同じ board 運用ができる。ただし後継起動は provider 別で、Claude は tmux/
  `handover --apply`、Codex Desktop は `create_thread` を使う（reference §0.7.5）。

## 正本は docs/contract.md

- 本リポジトリの設計契約は `docs/contract.md` が**正本**。実装が契約と食い違う場合、
  **契約側が正でありコードを直す**。
- 契約を変更したい場合はコードで勝手に迂回せず、オーケストレーターに報告して契約を先に更新する。
- 特に重要な節: §2 コーディング規約 / §3 環境変数と配置 / §5 DB スキーマ / §6 状態機械 /
  §7 profile matrix / §8 agent.message.v1 / §10 supervisor ステージ規約 / §12 実装中確定事項 / §14 web。

## コーディング規約（contract.md §2 の要約）

- コメントは日本語。変数・関数名は英語（camelCase / PascalCase）
- インデント 2 スペース、行末セミコロンあり
- `any` 禁止。型は明示。戻り値型必須。型定義は `interface` 優先
- ESM（`"type": "module"`）。相対 import は**拡張子付き**の `./foo.js` 形式
  （ソースは `.ts` だが import 指定子は `.js`）
- テストは Vitest。対象ファイルと同ディレクトリに `*.test.ts` を同居。describe/it でグループ化
- 外部依存は契約書に列挙されたもの以外追加しない
- ログは構造化 JSONL（`Logger` interface 経由）。`console.log` 直書き禁止（CLI の表示出力を除く）
- fail-closed を徹底: 不明な入力・検証失敗は安全側（起動しない/遷移しない/throw）に倒す

## 検証コマンド（root で実行）

```bash
pnpm typecheck   # 全パッケージ tsc --noEmit
pnpm test        # 全パッケージ vitest run
pnpm lint        # eslint packages/*/src
```

- テストはネットワークアクセス禁止（bridge は `@hachi/testing` の MockBridgeServer を使う）。
  DB テストは `:memory:` または tmp ディレクトリ。
- 統合前に上記3つがすべて通ることを確認する。taskで検証の分担が明示されている場合、
  局所実装workerは指定されたfocused checksを実行し、全体gateは依存する検証taskまたは
  host-finalize担当が実行する。分担が未指定なら提出前に3つとも実行する。
  未実行を成功扱いにせず、handoffへ実行したcheckと残る全体gateの担当を記載する。
  同じ候補・環境で通過済みの検証は、新しい変更・失敗・未解決の懸念がなければ反復しない。

## Runtime resource の安全境界（contract.md §56）

- worker は起動promptの `Runtime resource policy` に列挙された task/worktree 専用 lease だけを利用する。
  task body、repo の `.env`、既存shell env、固定portを割当の根拠にしない。
- 専用DBの起動・接続失敗時に `localhost:5432` 等のshared main DBへ自動fallbackしてはならない。
  明示的な `shared_main_db_exception` leaseが無ければ、環境を変更せず `outcome:"question"` で報告する。
- workerはleaseのrenew/release、cleanup approve/apply、Docker prune/down/deleteを行わない。runtime resourceの
  cleanupはorchestratorへ依頼し、host supervisorのfenced cleanup経路に委ねる。

## 変更禁止領域

- **`packages/core/src/types.ts` は凍結された共有契約**。変更はオーケストレーターのみ可。
  必要になったら変更せずに報告する。
- **`~/.hermes-hachi-dev` 配下（旧システムの状態ディレクトリ）への書き込み禁止**。
  even-terminal bridge（3456/3457）へのアクセスは既存 G2 契約の範囲内の API 呼び出しのみ。
- **G2 契約面（contract.md §4）の変更禁止**: bridge API の呼び出し形・token の扱い・
  in-progress block reason の書式は外部アプライアンス互換のため厳守。
- 各実装エージェントは自パッケージ（`packages/<name>/`）配下のみ書き込む（所有権ルール）。
- 実 DB（`~/.hachi-kanban/boards/<board>/kanban.db`）への生 SQL 発行禁止。
  書き込みは core の `KanbanStore`、読み取り専用面は `KanbanReadView` 経由。

## CLI クイックリファレンス

実行は root から `pnpm hachi <cmd>`（root script が `--` を付与する。v0.1 は tsx ソース実行）。
非対話環境で pnpm が PATH に無い場合は repo の `bin/hachi <cmd>` を使う。
グローバルオプション: `--board <name>` / `--debug`。多くのコマンドに `--json` あり。

```bash
pnpm hachi board                                     # 状態別件数 + 進行中一覧
pnpm hachi task create --title "..." --body "..." --tenant <t> \
  [--profile plan|review|implement|docs] [--priority <int>] \
  [--status triage|todo|ready] [--provider codex|claude]
#   body には cwd 行（`cwd: /absolute/path`）が必須。無いと dispatch が user-decision block する
pnpm hachi task show <id> [--comments <n>] [--events <n>]
pnpm hachi task list [--status <status>] [--limit <n>] [--all]   # 既定 100 件
pnpm hachi task block <id> --reason "<prefix> <理由>" [--assignee <name>]
#   reason は既知 prefix 必須（user-decision:/user-feedback:/review-required:/needs-manual:/auto-launch-failed:）
#   codex-in-progress:/claude-in-progress: は supervisor 専有のため CLI からは拒否される
pnpm hachi task unblock <id> --to <status>          # blocked 状態のタスク専用
pnpm hachi task move <id> --to <status> [--author <name>]  # triage/todo→ready 等の汎用遷移。--to blocked は不可（task block を使う）
pnpm hachi task comment <id> --body "..." [--author <name>]
pnpm hachi msg send --task <id> --intent enqueue|steer|escalate|answer \
  --payload '<json>' [--from-role orchestrator|human] [--key <冪等キー>]
pnpm hachi admin set-model <id> <model>              # model_override（--clear でクリア。§49 で実配信）
pnpm hachi admin set-effort <id> <low|medium|high|xhigh>  # effort_override（§49.3。--clear でクリア）
pnpm hachi admin resolve <id>                        # provider/model/effort/transport の解決結果表示
pnpm hachi task create ... --model <m> --effort <e>  # 起票時に override 同時指定（§49）
#   override は bridge が capability 広告時 bridge 昇格（G2 可視）、無ければ direct 強制（§49.4）
pnpm hachi doctor [--offline]                        # 環境診断（worker process hygiene 含む）

# --- オーケストレーター運用（§50/§52。手組み watcher は使わない） ---
pnpm hachi task await [<id>...] [--all] [--follow-new] [--json]  # 終端まで待つ（監視の標準は --all --follow-new を1本 background）
pnpm hachi task logs <id> [--follow] [--head <n>] [--tail <n>]  # worker ログ（direct/bridge/transcript 統一）
pnpm hachi task steer <id> "<指示>" [--wait <sec>] [--restart]  # 走行中 worker へ追加指示（§52.1）
pnpm hachi task answer <id> "<回答>"                  # active requestが無いlegacy/recovery専用（標準は下記§55）
pnpm hachi orchestrator register --label <責務> --project <project> --cwd <worktree> --json
pnpm hachi orchestrator list --json                       # stable identity / live generation の発見
pnpm hachi orchestrator await --session <id> --generation <n> --json  # 標準inbox（§55）。requests に worker_question / run_stalled / run_stall_suspected、cleanupRequests に runtime_cleanup。列挙は非網羅
pnpm hachi orchestrator answer <requestId> "<回答>" --session <id> --generation <n> --claim <token>
pnpm hachi orchestrator escalate <requestId> "<人間への質問>" --session <id> --generation <n> --claim <token>
pnpm hachi orchestrator resolve <requestId> <handled|false_positive> "<理由>" --session <id> --generation <n> --claim <token>
#   ↑ kind=run_stalled / run_stall_suspected 専用（§50.2）。answer/escalate は kind=worker_question 専用で両者には使えない
#     run_stall_suspected は警告専用（cancel request 無し）。resolve しても run は止まらない
pnpm hachi orchestrator session handoff-prepare <oldSessionId> --generation <n> --json
pnpm hachi orchestrator session handoff-accept <oldSessionId> --token <token> \
  --provider <claude|codex> --provider-session-id <provider-native-session-id> --json
  # provider-native-session-id は板側の <oldSessionId>（os_*）とは別物。claude は --session-id の uuid（検証済み）。
  # codex はどの id を渡すべきか未確定なので、reference §0.7.5 の警告を読んでから使う（t_0898fd0005b3eb56）。
  # 省くと計測が exit 0 の fail-open になる（CLI は未強制）。詳細は playbook §0.8
pnpm hachi knowledge list [--tag <t>] | show <id> | add ...   # 知見面（§47。spec-change タグで運用変更周知）

pnpm supervisor --once --apply                       # 手動 1 tick（--apply 無しは dry-run）
pnpm web                                             # 看板ビュー http://127.0.0.1:9131（読み取り専用）
```

## タスク完了時の handoff（worker として動く場合）

タスクの worker として起動された場合、状態遷移を自分で行ってはならない（two-party gate）。
完了時は出力の最後に次のフェンスドブロックを出力する。supervisor の finalize が検証して遷移する:

````
```hachi-handoff-v1
{"taskId": "t_xxxxxxxxxxxxxxxx", "outcome": "done" | "review", "summary": <成果の要約（日本語）>}
```
````

- 上の例はテンプレートであり、そのままでは JSON として妥当ではない。`|` は選択肢の区切りで、どちらか一方だけを書く
- `summary` の `<...>` は実際の要約を JSON 文字列（引用符付き）で置き換え、JSON として妥当な 1 行で出力する
- 成果物（スクリーンショット等）は cwd 配下か `$HACHI_KANBAN_HOME/artifacts/<taskId>/` に置き、handoff の artifactPaths にそのパスを書く。/tmp 等は検証で拒否される
- `outcome` は `"done"`（完了）/ `"review"`（レビュー要）/ `"question"`（前提不足で判断できない・§52.2）
- **前提や仕様が不足して判断できない場合は推測で進めず** `outcome:"question"` + summary に質問文
  （必要なら `context` に背景）を出して終了する。回答は再起動時の body 冒頭に届く（§52）
- 走行中にオーケストレーターから `task steer` の追加指示が来ることがある（bridge worker は
  agent.message.v1 として届く）。指示に従って作業を調整する
- `taskId` は対象タスクと一致しなければ無効（fail-closed）
- コメント・summary 等ボードに書く文章は日本語（prefix 等の固定識別子のみ英語）
