# hachi-kanban 設計契約書（canonical contract）

このファイルは全パッケージが従う正本の契約。実装がこの契約と食い違う場合、**契約側が正でありコードを直す**。
契約を変更したい場合はコードで勝手に迂回せず、オーケストレーターに報告して契約を先に更新する。

## 0. プロジェクト概要

hachi-kanban は、ローカル運用の自律型課題解決エージェント向け看板基盤。
先行システム legacy-hermes（bash 140本 / launchd 15デーモン）のゼロベース再設計であり、
以下の設計原則を**そのまま継承**する:

1. **3面分離**: ①統制面（SQLite Kanban DB = 唯一の真実）②配管（決定論、本リポジトリ）③判断（LLM/人間）。
   配管は判断しない。LLM は権威状態を直接書き換えない。
2. **board-first**: 全エージェント間ハンドオフはボード（tasks/task_comments/task_events）を経由する。
   サイドチャネル禁止。
3. **two-party gate**: LLM 出力（verdict/handoff）は「提案」であり、host（supervisor）が provenance
   （nonce/hash/claim）を検証して初めて状態遷移する。
4. **fail-closed 既定**: 不明な入力・未知 tenant・検証失敗は安全側（起動しない/遷移しない/hold）に倒す。
5. **kill-switch 遍在**: 各ステージは `$HACHI_KANBAN_HOME/<stage>.disabled` ファイルの存在で即時無効化できる。
6. **dry-run 既定**: 副作用のある操作は `--apply` 明示時のみ実行。既定は判定結果の表示のみ。
7. **「失敗」と「人間判断待ち」の区別**: 人間の判断が必要な状況はエラーではなく
   `user-decision:` prefix の blocked として表現し、assignee を人間に付け替える。

## 1. パッケージ構成と所有権

| パッケージ | 責務 | 依存 |
|---|---|---|
| `@hachi/core` | 型定義（types.ts）・DB層・状態機械・provenance・redaction・policy・message packet | better-sqlite3, zod, fs-ext@2.1.1（型: @types/fs-ext@2.0.3） |
| `@hachi/adapters` | WorkerAdapter interface の実装（CodexAdapter / ClaudeAdapter）、G2専用Codex queue transport | @hachi/core（**types のみ**。core の実装関数へ依存しない）、ws@8.21.3（G2専用WS-over-UDSのみ、型: @types/ws@8.18.1） |
| `@hachi/supervisor` | 単一常駐デーモン。tick ループ + ステージモジュール | @hachi/core, @hachi/adapters |
| `@hachi/cli` | `hachi` コマンド（board/task/msg/admin/doctor） | @hachi/core, @hachi/adapters |
| `@hachi/testing` | fixture・モック bridge server・統合テストハーネス | @hachi/core |
| `@hachi/g2-channel-plugin` | §78.10.4.5のClaude opt-in channel。hostが公開するbindingとD1認可に従う | @modelcontextprotocol/sdk@1.30.0, zod（採択済みplugin lockに固定）。Bun bundleを使い、core実装をruntime importしない |

**所有権ルール**: 各実装エージェントは自パッケージ配下のみ書き込む。
`packages/core/src/types.ts` は凍結された共有契約（オーケストレーターのみ変更可）。

## 2. コーディング規約

- コメントは日本語。変数・関数名は英語（camelCase / PascalCase）
- インデント 2スペース、行末セミコロンあり
- `any` 禁止。型は明示。戻り値型必須。型定義は `interface` 優先
- ESM（`"type": "module"`）、import は拡張子付き相対パス（`./foo.js`）
- テストは Vitest、対象ファイルと同ディレクトリに `*.test.ts`。describe/it でグループ化
- 外部依存は契約書に列挙されたもの以外追加しない
- ログは構造化 JSONL（`Logger` interface 経由）。console.log 直書き禁止（CLI の表示出力を除く）

## 3. 環境変数と配置

| 変数 | 既定値 | 意味 |
|---|---|---|
| `HACHI_KANBAN_HOME` | `~/.hachi-kanban` | 状態ディレクトリ（DB/kill-switch/ログ/artifacts） |
| `HACHI_KANBAN_BOARD` | `dev` | 既定ボード名 |
| `HACHI_CODEX_BRIDGE_URL` | `http://127.0.0.1:3456` | Codex 用 even-terminal bridge |
| `HACHI_CODEX_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/codex-bridge-token` | Codex bridge token ファイル |
| `HACHI_CLAUDE_BRIDGE_URL` | `http://127.0.0.1:3457` | Claude 用 even-terminal bridge |
| `HACHI_CLAUDE_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/claude-bridge-token` | Claude bridge token ファイル |

- DB パス: `$HACHI_KANBAN_HOME/boards/<board>/kanban.db`
- artifacts: `$HACHI_KANBAN_HOME/artifacts/<task_id>/`（生ログはここへ。コメントには要約+パスのみ）
- kill-switch: `$HACHI_KANBAN_HOME/<name>.disabled`（name 例: `supervisor`, `dispatch`, `finalize`）
- bridge token の既定 path は同じ state root の `credentials/` 配下へ解決する。既存配置を継続する場合だけ
  `HACHI_CODEX_BRIDGE_TOKEN_FILE` / `HACHI_CLAUDE_BRIDGE_TOKEN_FILE` で明示する
- **既存の legacy-hermes の DB（`~/.hermes-hachi-dev/kanban/`）には一切書き込まない**。
  bridge（3456/3457）へのアクセスは既存 G2 契約の範囲内の API 呼び出しのみ。

## 4. G2（メガネデバイス）契約 — 変更禁止の外部インターフェース

even-terminal bridge server は本リポジトリの外部にある既存アプライアンス。以下の契約で通信する:

- `POST {bridge}/api/prompt` body: `{"text": string, "provider": "codex"|"claude", "sessionId"?: string, "cwd"?: string}`
  → 成功 2xx + `{"ok": true, "sessionId": string}`。**常に新規スレッド生成**（sessionId 指定時は既存へ注入）
- `GET {bridge}/api/status?sessionId=<sid>&provider=<p>` / `GET {bridge}/api/messages?...`
- 認証: `Authorization: Bearer <token>`。token はファイルから読む（env/argv に生値を置かない）
- token 無しの `GET /api/info` が 401 を返すことが生存確認
- 進行中タスクの block reason 書式（既存 G2 monitor 互換のため厳守）:
  - Codex: `codex-in-progress: <summary> tmux=none even-session=<sessionId> server=<url> started=<ISO8601 JST>`
  - Claude: `claude-in-progress: <summary> tmux=none even-session=<sessionId> server=<url> model=<model> started=<ISO8601 JST>`

## 5. DB スキーマ（v0.1 DDL）

legacy-hermes の実 DB と互換のサブセット + `provider`/`profile` 列。core が migration として実装する。

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                -- 't_' + 16 hex（64bit。§12.7-5 で 8 hex から拡張）
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'triage',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',      -- '' | 'codex' | 'claude'
  profile TEXT NOT NULL DEFAULT '',       -- '' | 'plan' | 'review' | 'implement' | 'docs' | 任意
  model_override TEXT NOT NULL DEFAULT '',
  block_reason TEXT NOT NULL DEFAULT '',
  claim_lock TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_error TEXT NOT NULL DEFAULT '',
  last_heartbeat_at INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,            -- epoch 秒
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',     -- JSON 文字列
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running', -- running | done | failed | released
  meta TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL REFERENCES tasks(id),
  child_id TEXT NOT NULL REFERENCES tasks(id),
  link_type TEXT NOT NULL DEFAULT 'subtask',
  created_at INTEGER NOT NULL,
  UNIQUE(parent_id, child_id, link_type)
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

- 接続規約: WAL モード、`busy_timeout=5000`、書き込みは supervisor / cli の単一書込パス
  （core の `KanbanDb` クラス）経由のみ。生 SQL を他パッケージから発行しない。
- 全ての状態遷移は同一トランザクション内で `task_events` に記録する（監査証跡）。

## 6. 状態機械

statuses: `triage → todo → ready → blocked(in-progress) → review → needs-integration → done → archived`

- `running` は使わない（先行システムとの互換設計。進行中は `blocked` + in-progress prefix）
- 遷移は core の `StateMachine.transition()` のみが行い、不正遷移は throw（fail-closed）
- 例外遷移（2026-07-07 追加）: `todo → done` を許可する。オーケストレーター/人間が盤外で実施済みの
  タスクを、dispatch 対象となる ready を経由せずクローズするための経路（ready 経由クローズで
  dispatch に claim される競合の再発防止）。不要化の終端は従来どおり `triage/todo → archived` を使う。
  `triage → done` は許可しない（完了化は todo へ降ろしてから）。
- reason prefix（block_reason の先頭）:
  - `codex-in-progress:` / `claude-in-progress:` — worker 実行中（§4 の書式）
  - `user-decision:` — 人間の判断待ち（assignee を人間へ）
  - `user-feedback:` — 人間のフィードバック待ち
  - `review-required:` — レビュー fail 後の人間確認待ち
  - `needs-manual:` — 統合等の手動対応待ち
  - `auto-launch-failed:` — 起動失敗（リトライ対象）

## 7. profile matrix（モデル/プロバイダ・ルーティング）

設定ファイル: `$HACHI_KANBAN_HOME/config.json`（無ければ既定値）。zod で検証。

```jsonc
{
  "profiles": {
    "plan":      { "provider": "claude", "model": "claude-opus-4-6" },
    "review":    { "provider": "codex",  "model": "gpt-5.6-sol",   "effort": "high" },
    "implement": { "provider": "codex",  "model": "gpt-5.6-luna",  "transport": "direct",
                   "effort": "max", "speed": "standard" },
    "docs":      { "provider": "codex",  "model": "gpt-5.6-luna",  "effort": "high" }
  },
  "allowlist": {
    "codex":  ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    "claude": ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"]
  },
  "resourceGuard": { "maxInFlight": 10, "maxLaunchesPerTick": 2 },
  "defaultProfile": "implement"
}
```

- 解決順: task.model_override（allowlist 検証、不合格は fail-closed で `user-decision:` block）
  > task.profile > defaultProfile
- Codex 5.6 系の選択肢は Codex CLI のモデル ID と一致する `gpt-5.6-sol` / `gpt-5.6-terra` /
  `gpt-5.6-luna` の3つ。`gpt-5.6` alias は重複候補として allowlist へ追加しない
- 既定`implement` profileはHachiが起動する実装worker用の`gpt-5.6-luna / max / standard / direct`。
  登録済みorchestrator sessionや予約`review` profileには適用しない
- モデル選定、複雑度シグナル、fast opt-in、review/escalationの運用判断は
  `runbooks/orchestrator-playbook.md`（core）と `runbooks/orchestrator-reference.md`（reference）を
  唯一の正本とし、本契約は解決・配送・fail-closed条件だけを定める
- Claude Opus 5 のmodel IDは`claude-opus-5`。allowlist登録だけでは起動許可にならず、§59/§67の
  model/runtime/effort/speed capability判定を通す
- 異モデル二審のreviewerとして指定できるClaude modelは`claude-opus-5`だけとする。Fable系・
  `claude-opus-4-8`・`gpt-5.5`をreviewerの代替として自動選択しない。指定した`claude-opus-5`が
  §59/§67の判定で`supported`にならない場合、Supervisorは別modelへ暗黙にfallbackせず当該reviewer
  起動だけをfail-closedで`needs-manual` blockし人間確認へ倒す（§15.1）。通常の実装レビューを
  低品質modelへ落とす必要はなく、どの場合に異モデル二審を要求するかはreference §0.6.2が正本
- CLI の `task create --model` / `admin set-model` は、現 config の provider 別 allowlist を重複除去して
  候補表示・入力検証に使う。選択後も最終的な `{provider, model}` ペアを `resolveModel` で検証する
- モデル名の charset は `[A-Za-z0-9._-]+` を allowlist 照合より先に検査（charset-first）
- supervisor は起動時に初期 config を読み込む。起動時の `config.json` 不正は fail-closed で起動失敗。
- dispatch ステージは tick ごとに `config.json` を再読み込みし、成功した値で `deps.config` を更新して
  ready タスクの profile / resourceGuard 解決に使う。再読み込み失敗（JSON parse / zod / 意味検証 /
  ファイル I/O）は前回の有効値で継続し、warn ログと stage notes に残す。
- `$HACHI_KANBAN_HOME/config.json` の変更権限は人間または orchestrator のみ。worker は live config を
  変更してはならない。worker/rework prompt にはこの禁止文を明記する。
- worker/rework run 開始時、supervisor は `config.json` の `mtimeMs` / `size` / SHA-256 hash を
  `task_runs.meta.configFileSnapshot` に保存する。finalize は run close 時に現行 snapshot と比較し、
  変化があれば task event `config_modified_during_run` を警告として記録する。自動復元は行わない。

## 8. agent.message.v1（エージェント間通信パケット）

task_comments の body に JSON フェンスドブロックで格納する。core の `messages` モジュールが
シリアライズ/パース/検証（zod）を担う。

```jsonc
{
  "schema": "agent.message.v1",
  "from": { "role": "worker|reviewer|orchestrator|human", "provider": "codex|claude|", "sessionId": "" },
  "to": { "role": "...", "taskId": "" },
  "intent": "enqueue" | "steer" | "escalate" | "answer",
  "payload": {},
  "idempotencyKey": "string（送信側が決定。同一 key の重複処理は禁止）",
  "createdAt": 1234567890
}
```

- `enqueue`: payload = `{title, body, tenant, profile?, priority?}` → 子タスクを `ready` で生成し
  task_links(parent→child) を張る
- `steer`: payload = `{message}` → 対象タスクの進行中セッションへ adapter.inject()
- `escalate` / `answer`: 人間エスカレーションとその回答
- 処理済み idempotencyKey は task_events(`message_processed`) で照合し重複実行を防ぐ

## 9. WorkerAdapter（types.ts が正本）

`packages/core/src/types.ts` の `WorkerAdapter` interface を実装する。
- `launch()` は bridge `/api/prompt` へ POST し `SessionRef` を返す。失敗は throw（呼び出し側が
  `auto-launch-failed:` 処理を行う）
- モデル指定: 運べなかった場合は `modelDelivery: "none"` を SessionRef に記録して**無視を隠さない**。
  **bridge は 2026-08-21 時点で model を運べる**（§49.4 の capability 付き passthrough。codex/claude 両 adapter が
  `/api/prompt` へ載せ、runtime が native echo を返す）。運べなかった場合は起動を通さない（§35.3）。
  direct 実行による確実注入は **§17（codex）/ §22（claude）で実装済み**
- token は launch 時にファイルから読み、メモリ外へ出さない（ログ・エラーメッセージに含めない）

## 10. supervisor ステージ規約

- tick 間隔既定 30 秒。各 tick で全ステージを順に実行（ステージは冪等であること）
- ステージ: `dispatch`（ready→launch）→ `monitor`（in-progress の heartbeat/staleness）→
  `finalize`（worker 完了ハンドオフの検証遷移）→ `messages`（agent.message.v1 の処理）→ `reap`（孤児 run 清掃）
- **確定ステージ順（v0.7 時点の集約。§15.3 / §18 / §29 / §30 による追加を反映した正）**:
  `scheduler → dispatch → monitor → finalize → review → messages → reap → notify → webwatch`
- 各ステージは実行前に kill-switch（`<stage>.disabled` / `supervisor.disabled`）を確認
- `--apply` なしは dry-run（判定のみログ）。resourceGuard の上限を必ず尊重
- 例外はステージ単位で捕捉し、他ステージの実行を妨げない。連続失敗はログ + イベント記録

## 11. テスト規約

- ユニット: 各パッケージ内、`*.test.ts` 同居。DB テストは `:memory:` または tmp ディレクトリ
- 統合: `@hachi/testing` のモック bridge server（/api/prompt, /api/status, 401 検証）を使用
- ネットワークアクセスするテストを書かない（モックのみ）。実 bridge への接続はテストで行わない

### 11.x CI / hook（2026-07-06 ユーザー決定: 両方 + コミットフック強化）
- **pre-commit hook**: `pnpm -r typecheck` + staged ファイルへの eslint --fix（husky + lint-staged）。
  supervisor が main のソースを tsx で直読みするため、壊れたコミットを main に載せない防波堤が本線
- **pre-push hook**: `pnpm -r test`（フル）
- **GitHub Actions**: push/PR で typecheck + test + lint + build のフル検証（セーフティネット）
- hook は `HUSKY=0` で明示的に skip 可能（緊急時の逃げ道。常用しない）
- カバレッジ: @vitest/coverage-v8 を導入し計測のみ（数値ゲートはまだ設けない）

## 12. v0.1 追補（実装中に確定した契約）

### 12.1 cwd 解決
ワーカーの作業ディレクトリはタスク body 内の行 `cwd: <絶対パス>`（正規表現 `/^cwd:\s*(\S+)\s*$/m`）で指定する。
無い場合、dispatch は fail-closed で `user-decision: cwd 未指定のため起動できません` として block する。

### 12.2 worker handoff ブロック（two-party gate の worker 側出力）
ワーカーは完了時、出力の最後に以下のフェンスドブロックを出力する。supervisor の finalize ステージが
transcript から抽出・検証し、検証を通過した場合のみ状態遷移を行う（LLM は自ら遷移しない）。

```
```hachi-handoff-v1
{"taskId": "t_xxxxxxxx", "outcome": "done" | "review", "summary": "成果の要約"}
```
```

- taskId は対象タスクと一致しなければ無効（fail-closed）
- handoff が見つからない場合は `handoff_missing` イベントを冪等に記録し、タスクは変更しない（人間介入待ち）

### 12.3 bridge status/messages API の暫定扱い【§13 で置換済み・歴史的記録】
**本節は 2026-07-02 の live probe を反映した §13 で置換済み**（推測パースは廃止され、
busy/idle の厳密マッピングと type 判別イベントログに確定）。以下は当時の暫定契約の記録として残す。

`GET /api/status` / `GET /api/messages` のレスポンス形状は本契約で未確定。adapters はトレラントな
推測パース（state/status キーワードマッチ、messages/items/data 配列探索）で実装しており、
実 bridge との突き合わせ（live probe）後に本節を確定形へ更新する。

### 12.4 初回 codex レビュー反映（v0.1 確定事項）

1. **実行形態**: v0.1 はビルドせずソース実行（`tsx`）。package.json の `bin` は公開しない
   （`pnpm --filter @hachi/cli run hachi -- <args>` / supervisor は `run start`）。dist ビルドは v0.2 で検討。
2. **CLI の config fail-closed**: `config.json` が不正な場合、CLI は既定値へフォールバックせず
   エラー終了する（doctor コマンドのみ、原因報告のために起動を許可し検査結果で fail を報告）。
3. **resolveModel の全ソース検証**: override だけでなく profile / default 由来の model も、最終的な
   `{provider, model}` ペアで charset + allowlist を検証する（fail-closed）。task.provider が
   profile.provider を上書きした結果 model が当該 provider の allowlist 外になる場合も ok:false。
4. **agent.message.v1 の冪等性戦略**: DB-only intent（enqueue/escalate/answer）はハンドラ処理と
   markMessageProcessed を KanbanStore.transaction() で同一 Tx にする（exactly-once）。
   外部副作用を持つ steer は mark-first → inject（at-most-once。クラッシュ時は送信側が新 key で再送）。
5. **cwd は絶対パス必須**: `path.isAbsolute()` で検証し、相対パスは `user-decision:` block（fail-closed）。
6. **bridgeHealthCheck の厳格化**: token 無し `GET /api/info` が **HTTP 401 を返した場合のみ**健全と
   みなす（404/500/他サービスの応答は不健全）。

### 12.5 2巡目 codex レビュー反映（v0.1 確定事項）

1. **セッションメタデータの正本は task_runs**: supervisor（monitor/finalize/steer）が SessionRef を
   再構築する際は、block_reason の文字列パースではなく **当該タスクの最新 open run（task_runs）** を
   正本として使う。dispatch は startRun 時に meta へ `serverUrl` / `model` / `modelDelivery` を記録する。
   block_reason は人間/G2 表示用であり、運用メタデータの機械的な情報源にしない。
2. **summary のサニタイズ**: buildInProgressReason は summary（task title 由来の自由文）内の
   `key=value` 形式トークン（特に even-session= / server= / model= / started= / tmux=）を無害化してから
   合成する（外部 G2 monitor のパースを title 注入で汚染させない。defense in depth）。
   parseSessionIdFromReason は互換・デバッグ用として残すが非権威（authoritative ではない）と明記する。
3. **イベントのセッションスコープ**: session_ended / handoff_missing イベントは payload.sessionId を必須とし、
   finalize は「現在の open run の sessionId と一致するイベント」のみを参照する（再起動タスクで過去
   セッションのイベントを誤参照しない）。
4. **インデックス**: migration version 2 として以下を追加する:
   `tasks(status, priority)` / `task_comments(task_id, id)` / `task_events(task_id, event_type, id)` /
   `task_events(event_type, json_extract(payload,'$.idempotencyKey'))`（式インデックス）/
   `task_runs(task_id, status)`
5. **engines**: root / 全パッケージの engines.node は `>=22.12`（commander@15 の要求に合わせる）。

### 12.6 3巡目 codex レビュー反映（v0.1 確定事項）

1. **handoff 欠落/不正の終端処理（§12.2 の修正）**: セッション ended かつ有効な handoff が無い場合、
   finalize は (a) handoff_missing イベント記録（従来通り・sessionId スコープ）に加え、
   (b) open run を `failed` で close、(c) block_reason を `needs-manual: handoff 欠落 (session=<sid>)` に
   更新（updateBlockReason）し assignee を人間へ。これにより in-progress 集計から外れ、
   resource guard の枠が解放される（永久リーク防止）。
2. **updateBlockReason API**: blocked タスクの reason 付替は状態遷移ではなく専用 API で行う
   （KanbanStore.updateBlockReason。blocked 以外は throw、prefix 検証、event 記録）。
   escalate の reason 付替にも使用可（ただし in-progress reason の escalate 上書きは行わない方針を維持）。
3. **dispatch の原子性**: prompt artifact は launch **前**に保存する。try/catch は adapter.launch のみを
   包む。launch 成功後の startRun + transition は store.transaction() で原子化し、それ以降の
   非本質的失敗（artifact 追記等）は warn ログに留めタスク状態を壊さない。
4. **CLI create の初期 status 制限**: `hachi task create --status` は triage / todo / ready のみ許可
   （blocked/done 等の不変条件を満たさない初期状態を作らせない。fail-closed）。
5. **messages 走査のカーソル化**: KanbanStore.listMessageFenceComments(afterId) による増分走査に変更。
   supervisor は処理済みカーソル（最終 comment id）を `$HACHI_KANBAN_HOME/state/messages-cursor.json` に
   永続化する。クラッシュ等でカーソルが巻き戻っても冪等キー照合が重複実行を防ぐ（at-least-once + idempotent）。
6. **engines**: 全パッケージで engines.node `>=22.13` を明示（eslint@10 の要求に合わせる）。
7. **.gitignore**: `.env` / `.env.*` / `*.db` / `*.db-wal` / `*.db-shm` を追加（ローカル秘匿情報と
   repo 内 SQLite 実験ファイルの誤コミット防止）。

### 12.7 4巡目 codex レビュー反映（v0.1 確定事項）

1. **dispatch の起動前 durable claim**: dispatch は launch より前に `claimTask`（CAS:
   status='ready' かつ claim_lock='' の場合のみ claim_lock=token を設定）で claim する。
   claim 失敗（並行変更）はそのタスクをスキップ。artifact 保存失敗・launch 失敗など起動不成立時は
   `releaseClaim` で巻き戻す。ready→blocked の transition 成功時に claim_lock は '' にクリアされる。
2. **handoff 欠落時の transcript 保存**: finalize は handoff が欠落/不正の場合も transcript を
   `$artifactsDir/<taskId>/transcript.txt` に保存し、needs-manual コメントに artifact パスを含める
   （監査・手動リカバリの材料を捨てない）。
3. **コメント書き込み境界の redaction**: worker 由来の自由文（handoff summary、escalate/answer payload、
   エラーメッセージ）をコメントへ書く際は `redactText()` を必ず通す。生データは artifacts のみに置く。
4. **status マッピングの負例優先**: adapters のセッション状態推定は、負例・終端語
   （not_running / not running / stopped / terminated / exited / closed 等）を先に判定してから
   正例（active/running 等）を判定する。部分文字列の誤マッチ（not_running→active）を禁止。
5. **タスク ID の拡張**: 't_' + 16 hex（64bit ランダム）に変更し、PK 衝突時は最大5回まで再生成リトライ。
   （§5 DDL の注記 "t_ + 8 hex" は本節で上書き）
6. **getLatestOpenRun**: KanbanStore に追加し、session-ref の再構築はこれを使う（全 open run 走査の排除）。

### 12.8 5巡目 codex レビュー反映（v0.1 確定事項）

1. **board 名の slug 検証**: `resolveEnvironment` は board 名を `^[A-Za-z0-9._-]+$` で検証し、
   パス区切り・`.`・`..` を拒否（fail-closed throw）。dbPath は必ず `$home/boards/` 配下に収まること
   （containment）。パストラバーサルによる home 外への DB 作成を禁止する。
2. **dispatch の起動予算と stale claim**: `launchesThisTick` は **claim 成功後**にのみ加算する。
   claim_lock が既に設定されている ready 行は候補から除外する（他 supervisor 処理中 or stale）。
   reap ステージは `clearStaleClaims(600, now)` で「ready のまま 10 分以上更新の無い claim」を解放する。
3. **起動後 Tx の claim 再検証（orphan 可視化）**: launch 成功後の startRun+transition Tx 内で
   status='ready' かつ claim_lock=token を再検証する。不整合時は throw で握り潰さず、
   `orphan_session` イベント + コメント（sessionId・serverUrl 記録、redaction 適用）で人間に可視化する
   （外部セッションだけが走り DB に記録が無い状態を作らない）。
4. **finalize 成功パスの原子化**: comment + transition(finalized) + endRun(done) を単一
   store.transaction() で行う（クラッシュで「done なのに open run」を残さない）。
5. **core createTask の初期 status 制限**: CLI だけでなく core の createTask 自体が
   triage / todo / ready 以外の初期 status を拒否する（fail-closed。KanbanStore が共有書込 API のため）。
6. **CLI 数値オプションの負値拒否**: --limit / --comments / --events は正の整数のみ受理。

### 12.9 6巡目 codex レビュー反映（v0.1 確定事項）

1. **メッセージ冪等キーの DB レベル保証**: migration v3 として部分 UNIQUE 式インデックス
   `CREATE UNIQUE INDEX idx_events_idem_unique ON task_events(json_extract(payload,'$.idempotencyKey'))
   WHERE event_type='message_processed'` を追加（既存 idx_events_idem は非 unique のまま残してよい）。
   markMessageProcessed は UNIQUE 衝突時に throw せず「既処理」として false を返し、呼び出し側は
   side effect を打たない。check-then-mark はアプリ層の Tx + DB レベル UNIQUE の二重防御とする。
2. **tick の重なり禁止**: supervisor のループは setInterval ではなく「runTick 完了後に次を
   setTimeout する async ループ」（または running ガード）で、同一デーモン内の tick 重なりを排除する。
3. **launch 失敗時の claim 巻き戻し**: launch 失敗パスでは releaseClaim を挟まず、直接
   block()（ready→blocked 遷移が同一 Tx で claim_lock をクリア）する。releaseClaim は
   「タスクを ready のまま残す」巻き戻し（artifact 保存失敗等）専用とする。
4. **CLI 実行導線の整合**: supervisor/cli の main は先頭の連続する `--` セパレータを全て除去する。
   README の実行例は実際に動くコマンド（`pnpm hachi board` / `pnpm hachi doctor --offline` 等）に統一。
   非対話サンドボックスなど pnpm が PATH に無い可能性がある環境では repo の `bin/hachi <cmd>` を使う。
   `bin/hachi` は存在確認できた既知 toolchain path だけを補完してから CLI を起動する。
5. **task show の直近表示**: limit 指定時は DESC で取得し表示時に時系列へ反転（「直近 N 件」を正しく返す）。
   KanbanStore の listComments/listEvents の limit セマンティクスは「新しい方から N 件」と定義する。
6. **--interval の厳格パース**: 正の整数のみ受理（部分数値文字列 '1abc' を拒否）。

### 12.10 7巡目 codex レビュー反映（v0.1 確定事項）

1. **mark-first の徹底**: KanbanStore.markMessageProcessed は boolean を返す（新規 true / 既処理 false）。
   messages ステージは全 intent で mark を side effect より先に行い、false なら side effect を打たない。
   - DB-only intent: 同一 Tx 内で「mark → false なら早期 return → handler」。handler が throw した場合は
     Tx ごと rollback されるため、catch 節で改めて mark（新規 Tx）+ エラーコメント（poison 防止を維持）。
   - steer: mark（true の場合のみ）→ inject。
2. **orphan 記録後の fail-closed**: 起動後 Tx の claim 再検証で不整合を検出し orphan_session を記録した際、
   タスクがまだ ready のままなら `needs-manual: 起動セッション孤児化のため手動確認要` で block し、
   次 tick の自動再起動（孤児セッションの増殖）を防ぐ。ready でない（他 writer が遷移済み）ならそのまま。
3. **transcript 取得失敗のコメント抑制**: fetchTranscript 失敗時のコメントは同一 sessionId につき1回のみ
   （session スコープの `transcript_fetch_failed` イベントで冪等化）。以降の失敗は warn ログのみ。
4. **--board の値検証**: 次トークンが欠落 or `-` 始まりの場合はエラー（黙って次トークンを消費しない）。
5. **--priority の厳格パース**: 整数のみ受理（`^-?[0-9]+$`）。'1abc' は拒否。

### 12.11 8巡目 codex レビュー反映（v0.1 確定事項）

1. **claim 後の再読込**: dispatch は claimTask 成功後にタスクを再読込し、resolveModel / cwd 抽出 /
   プロンプト生成は claim 済みの最新行に対して行う（pre-claim スナップショットで launch しない）。
2. **in-progress prefix は supervisor 専有**: CLI の `task block` は `codex-in-progress:` /
   `claude-in-progress:` prefix を拒否する（in-progress は dispatch だけが作れる）。加えて monitor は
   「in-progress reason なのに open run が無い」タスクを検出し `needs-manual: in-progress 不整合
   (open run なし)` へ reason 付替する（自己修復。resource guard の恒久リーク防止）。
3. **migration v3 の preflight**: UNIQUE インデックス作成前に既存の重複 message_processed
   （同一 idempotencyKey）を検出し、最小 id を残して安全に重複行を削除してからインデックスを張る
   （既存 DB / import 由来 DB の起動不能を防ぐ）。
4. **malformed メッセージの監査記録**: parse 失敗した agent.message.v1 ブロックは、当該コメントの
   タスクへ `message_parse_failed` イベント（comment id スコープで冪等）を記録してからカーソルを進める
   （黙って読み飛ばさない）。
5. **supervisor の未知フラグ拒否**: 未知の CLI フラグは throw（typo による意図しない dry-run 起動を防ぐ）。

### 12.12 9巡目 codex レビュー反映（v0.1 確定事項）

1. **finalize Tx 内の最終再検証**: finalize の成功パス/欠落パスとも、Tx 内でタスクと latest open run を
   再読込し、「status=blocked かつ in-progress reason かつ getLatestOpenRun(task.id).sessionId ===
   ref.sessionId」を満たさない場合は中断する（stale handoff の適用禁止。`stale_finalize_skipped`
   イベントを記録）。fetchTranscript（外部 I/O）中にタスクが再起動されても新セッションを壊さない。
2. **handoff 欠落クリーンアップの artifact 非依存**: transcript 保存は best-effort とし、失敗しても
   endRun(failed) + needs-manual 付替は必ず実行する（保存失敗の旨は redact 済みコメントに明記）。
   リソース枠の恒久リークを artifact ストレージ障害に連動させない。
3. **msg send の payload redaction**: CLI msg send は payload の自由文フィールドを redactText に通してから
   serialize してコメントに書く（board へ書かれる時点で秘匿情報が残らない）。
4. **listRecent**: KanbanStore に listRecent(limit)（updated_at 降順）を追加し、CLI の `task list`
   （--status 無し）は全 status 走査ではなくこれを使う。

### 12.13 10巡目 codex レビュー反映（v0.1 確定事項）

1. **成功パスも transcript 保存は best-effort**: 有効な handoff の finalize（done/review 遷移 + endRun）は
   transcript artifact の保存失敗によって妨げられてはならない。保存失敗時は redact 済みコメントに
   その旨を明記した上で遷移を実行する（§12.12-2 と対称）。
2. **payload redaction の再帰化**: msg send（および payload を board へ書く全ての境界）は JSON の
   全文字列リーフ（配列・深いネスト含む）を再帰的に redactText へ通す。
3. **bridge URL の loopback 検証**: bridge URL は既定で 127.0.0.1 / localhost / [::1] のみ許可し、
   それ以外のホストへは token を送らない（fail-closed throw）。リモート bridge が必要な場合は
   env `HACHI_BRIDGE_ALLOW_REMOTE=1` の明示 opt-inとHTTPSを両方要求する（token 流出の防止）。
4. **bridge token file の検証**: token はsymlinkを辿らずopenしたregular fileから読む。現在user所有、
   group/other permissionなし（0400または0600相当）、8 KiB以下を要求し、不一致はtokenを送る前にfail-closedとする。

### 12.14 11巡目 codex レビュー反映（v0.1 確定事項）

1. **リダイレクト非追従**: token を送る bridge リクエストは `redirect: "manual"` とし、3xx 応答は
   fail-closed でエラー扱いする（loopback 検証をリダイレクトで迂回させない）。
2. **orphan 処理の claim 尊重**: 起動後の claim 再検証で不整合を検出した際の needs-manual block は、
   現在の claim_lock が ''（未 claim）の場合のみ行う。他 token が claim 済みの場合は orphan_session の
   記録のみ行い、他者の claim / 起動経路には触れない。
3. **actions 計上の正確化**: dispatch の actions は claim 成功後にのみ加算する（claim 失敗による
   スキップは notes 記録のみ。メトリクスの誤誘導防止）。

### 12.15 12巡目 codex レビュー反映（v0.1 確定事項）

1. **supervisor 側 payload redaction**: messages ステージは intent 処理の前に msg.payload の全文字列リーフを
   redactJsonStrings で redact する（worker 発メッセージは CLI を経由しないため。CLI 側 redaction は
   defense in depth として維持）。
2. **ref 系呼び出しは ref.serverUrl を使う**: adapter の status / inject / fetchTranscript は
   構成時の bridge URL ではなく SessionRef.serverUrl（task_runs 正本由来）へ接続する
   （loopback 検証は同様に適用）。bridge URL 変更後も既存セッションへ正しく到達する。
3. **launch 失敗パスの claim 再検証**: auto-launch-failed block は Tx 内で status='ready' かつ
   claim_lock=token を再検証してから適用する。不一致時は状態を変更せず `stale_launch_failure`
   イベントのみ記録。
4. **clearStaleClaims の監査精度**: 実際にクリアした行のみ stale_claim_cleared を記録する
   （UPDATE と同一述語での再確認 or RETURNING 相当）。

### 12.16 13巡目 codex レビュー反映（v0.1 確定事項）

1. **transcript 取得失敗の有界化**: session_ended 済みタスクの fetchTranscript 失敗は、同一 sessionId の
   `transcript_fetch_failed` イベント数が閾値（3回）に達したら、open run を failed で close し
   `needs-manual: transcript 取得不能 (session=<sid>)` へ付替する（恒久リーク防止。§12.10-3 の
   「1回だけコメント」は初回のみのままとし、イベントは毎失敗 tick 記録に変更してリトライ回数を数える）。
2. **json_extract の json_valid ガード**: task_events.payload への json_extract を使う全てのインデックス・
   クエリ（idx_events_idem / idx_events_idem_unique / v3 dedupe / hasProcessedMessage）は
   `CASE WHEN json_valid(payload) THEN json_extract(...) END` 形式でガードする。migration preflight は
   malformed な message_processed 行を検出した場合、event_type を `message_processed_malformed` に
   付替して隔離する（削除しない。監査を残す）。
3. **MockBridgeServer の provider 整合**: セッションを provider 付きで保持し、inject/status/messages の
   provider 不一致は 404 を返す（テストの偽陽性防止）。
4. **MODEL_CHARSET の共有化**: charset 正規表現は core から1箇所で export し、db.ts / policy.ts で共用する。

### 12.17 14巡目 codex レビュー反映（v0.1 確定事項）

1. **orphan block の CAS 化**: orphan_session 記録後の needs-manual block は KanbanStore の
   `blockIfReadyUnclaimed`（単一 Tx 内で status='ready' AND claim_lock='' を検証してから遷移。
   不一致は no-op で false）で行う（check-then-block の窓を排除）。
2. **transcript artifact のセッションスコープ化**: transcript は
   `$artifactsDir/<taskId>/transcript-<sessionId>.txt` に保存し、コメント・イベントには
   セッション別パスを記載する（stale セッションの transcript が現行セッションの監査証跡を
   上書きしない）。prompt artifact も同様に `prompt-<sessionId>.txt` とする（起動ごとに区別）。
3. **retry 分岐にも stale 再検証**: transcript_fetch_failed の記録（非閾値分岐）も
   assertStillTargetSession 相当のガード下で行い、stale なら stale_finalize_skipped を記録して中断。
4. **getOpenRunByTaskSession**: finalize の open run 解決は listOpenRuns 全走査ではなく
   専用メソッド（task_id + session_id + status='running'）で行う。

### 12.18 15巡目 codex レビュー反映（v0.1 確定事項）

1. **メッセージのゲートは対象タスクで行う**: messages ステージの処理可否は「コメントが載っている
   タスク」ではなく **msg.to.taskId（対象タスク）** の状態で判定する:
   - 対象が存在しない → `message_target_missing` イベント（コメントのタスクへ記録）+ mark processed（poison 防止）
   - 対象が done/archived → `message_target_terminal` イベント + mark processed（終端タスクの不変条件保護）。
     `intent=answer` の場合だけ、同一 Tx で `task_id` + exact `answer_key` が一致する `answering` request を
     `resolved` へ進める。task の status/body/completedAt は変更せず ready へ戻さない。別 intent・key 不一致は
     request に作用しない
   - 対象が非終端 → intent 処理（コメントが done タスク上にあっても処理する。done タスクからの
     followup enqueue を正当なパターンとして許容）
   - `message_processed` の記録先は**対象タスク**とする（対象不存在時のみコメントのタスク）。
2. **retry 分岐の actions/dry-run 整合**: transcript_fetch_failed のイベント/コメント書き込みも
   actions に計上し、dry-run では同内容を notes に出す（apply と dry-run の見え方を一致させる）。

### 12.19 16巡目 codex レビュー反映（v0.1 確定事項）

1. **artifact パスの衝突耐性と containment**: artifact ファイル名は `<prefix>-<safe>-<sha256先頭8hex>.txt`
   形式とする（safe は可読用のサニタイズ済み ID、hash 部が衝突を防ぐ）。書き込み前に path.resolve で
   最終パスが env.artifactsDir 配下に収まることを assert する（fail-closed）。
2. **blockClaimedTask（claim 保持中の fail-closed block の CAS 化）**: KanbanStore に
   `blockClaimedTask(taskId, claimToken, reason, actor, assignee?)` を追加（単一 Tx で
   status='ready' AND claim_lock=claimToken を検証して blocked へ遷移、不一致は false で no-op）。
   dispatch の model 解決失敗・cwd 検証失敗・launch 失敗の block は全てこれを使う。
3. **メッセージ対象の Tx 内再検証**: 対象タスクの終端判定は answer の通常 fallback を含む handler Tx 内
   （markMessageProcessed 直後）で再読込して行う（間隙での終端化に対する不変条件保護）。外側の事前判定だけを
   根拠に task 本文・状態へ作用してはならない。
4. **task list の既定上限**: --limit 省略時は 100 件（--all で全件）。

## 13. bridge API 確定仕様（2026-07-02 live probe 反映。§12.3 を置換）

実 even-terminal bridge（3456/3457）への live probe で確定した仕様。MockBridgeServer もこれに準拠する。

### 13.1 POST /api/prompt
- **202 Accepted**: `{"ok": true, "sessionId": string, "provider": string}`（非同期受理）
- **client timeout の意味は「不定（indeterminate）」であって「起動していない」ではない**
  （2026-08-31 追記。§34.1 と対で読むこと）。202 は受理だけを返す非同期契約なので、client 側の
  `AbortSignal.timeout()` による中断は**サーバ側の session 生成を止めない**。したがって timeout で
  throw した launch は (a) session が生成されていない (b) 生成されたが応答を受け取れなかった、の
  **いずれかであり、POST の戻り値からこの2つを区別する手段は存在しない**
- 区別が要る場合は §13.6 `GET /api/sessions` を**同一 `cwd` かつ同一 `provider`** で照会する。
  これは**判断材料であって判定ではない** — 照会結果で re-ready / unblock / cancel / cleanup を
  自動化してはならない（§34.1 の不定経路の規定と同根）

### 13.2 GET /api/status?sessionId=<id>&provider=<p>
- 200: `{"state": "busy" | "idle", "sessionId": string, "provider": string}`
  - **state は busy/idle の2値のみ。"ended" 相当は存在しない**（セッションは idle のまま残存し再利用可能）
  - lastActivityAt 等のタイムスタンプフィールドは存在しない
- 404: `{"error": "Session not found"}`

### 13.3 GET /api/messages?sessionId=<id>&provider=<p>
- **常に 200**（未知セッションでも 404 にならない。messages 空配列 + state:"idle"）
- `{"messages": Entry[], "state": "busy"|"idle", "sessionId": string, "provider": string}`
- Entry は type 判別ユニオン（**role/author/from フィールドは存在しない**）:
  - `{"id", "type": "status", "state": "busy"|"idle"|"text_start"|"text_end", ...}`（テレメトリ）
  - `{"id", "type": "user_prompt", "text"}`（ユーザー/inject の入力）
  - `{"id", "type": "running_stats", "durationMs", "inputTokens", "outputTokens"}`（テレメトリ）
  - `{"id", "type": "text_delta", "text"}`（ストリーミング断片。中間状態）
  - `{"id", "type": "result", "success", "text", "costUsd", "turns", "durationMs", ...}`（**確定応答**）

### 13.4 セッション終了（turn 完了）の検知規約
- `/api/status` の state だけでは終了を検知できず、bridge の `idle + type:"result"` は途中の assistant
  result と turn 真正終端を区別できない。したがって bridge ではこれを**終端候補**として扱い、即座に
  `session_ended` を記録しない。direct adapter の process exit 判定は従来どおり真正終端として扱う。
- adapter の bridge `status()` は `/api/messages` を1回取得し、top-level state、resultCount、
  lastResultId に加えて、窓内全entryの最大単調ID `lastEntryId` を返す。500件リングバッファでも
  countではなくIDを正本にし、ID欠如・不正は0としてfail-closedに扱う。
- monitor は `idle && result watermark >= 1` を初観測した時に `session_end_candidate` を記録する。
  payloadは sessionId / resultCount / lastResultId / resultWatermark / lastEntryId / observedAt を持つ。
  同一session・同一resultWatermark・同一lastEntryIdのまま **60秒**（定数）以上idleが継続した時だけ
  `session_ended` を記録する。busyへの復帰、watermarkまたはlastEntryIdの増加は既存候補を無効とし、
  次のidle snapshotを新候補にする。同一snapshotの候補・確定イベントは冪等にする。
- finalize は `session_ended` を見ても、bridgeでは外部副作用・run close・task遷移の前にadapter.status()を
  再取得し、state=idleかつ resultWatermark / lastEntryId が確定payloadと一致することを必須とする。
  busy、snapshot変化、status取得失敗、session/run不一致では何もclose/遷移せず次tickへ待機する。
  `worker_output_missing`、handoff nudge、needs-manualはいずれもこの再確認後だけ実行できる。

### 13.5 transcript の構築規約
- `user_prompt` → `[user] <text>` / `result` → `[assistant] <text>` のみを transcript に採用。
- `status` / `running_stats` は除外（テレメトリ）。`text_delta` は除外（result に確定テキストが入るため。
  採用すると同一内容が重複する）。

### 13.6 GET /api/sessions（参考）
- 200: `{"sessions": [{"id", "title", "timestamp"(ISO8601), "cwd", "status": "idle"|"busy", "provider"}]}`
- 状態フィールド名は `status`（/api/status の `state` とは別名。混同注意）

### 13.7 worker API hard error の安全な観測（`worker-api-error-observation.v1`）

bridge worker が生存したまま API hard error を踏んだ場合も、raw transcript の走査に頼らず
supervisor が観測できなければならない。even-terminal は `GET /api/messages` response の top-level
property `apiErrorObservation`（コード表現: `/api/messages.apiErrorObservation`）として次の additive
field を返す。既存 consumer との互換のため、省略可能 field とする。

```ts
interface WorkerApiErrorObservationV1 {
  schemaVersion: "worker-api-error-observation.v1";
  streamId: string;
  watermark: number;
  recent: Array<{
    sequence: number;
    category: "context-window-exceeded" | "provider-hard-error";
  }>;
}
```

producer と consumer は次を満たす。

1. **producer の唯一の入力**: live Claude session が受け取った assistant message の
   `isApiErrorMessage === true` だけを観測する。通常の本文文字列、result、status、終了状態から
   API error を推測してはならない。
2. **安全な分類**: `message.content` が配列なら `type === "text"` かつ `text` が文字列の block を
   順番に改行で連結し、先頭末尾の空白だけを除いた値を分類中だけ使う。この値が
   `Prompt is too long` と完全一致する場合だけ `context-window-exceeded`、その他の marked API error は
   `provider-hard-error` とする。それ以外のcase folding・部分一致・Unicode正規化は行わない。
   raw error text、prompt、content、tool output、およびそれらの hash を ring、projection、task event、
   log、notification のいずれにも保存・公開してはならない。
3. **stream と watermark**: `streamId` は live Claude session instance ごとに生成する UUID であり、
   process や session instance の再生成をまたいで再利用しない。`sequence` は stream 内で1から始まる
   正の単調増加整数、`watermark` は最新 sequence（未観測なら0）とする。`recent` は末尾32件以下を
   sequence昇順で保持し、重複を持たない。`watermark > 0` なら `recent` は空でなく、末尾sequenceと
   watermarkが一致する。`watermark === 0` なら `recent` は空とする。
4. **additive parse**: field absence は旧または未対応runtimeとして正常に受理し、error発生を推測しない。
   present field は schemaVersion、UUID、整数境界、配列長、sequence順序、watermark整合、category allowlistを
   全て検証する。hachi adapter は frozen `packages/core/src/types.ts` を変更せず、adapter-localな拡張型として
   valid / absent / malformed を返す。malformedなraw valueを上位へ転送してはならない。
5. **durable event**: monitor は同一task/runの unseen `{sessionId, streamId, sequence}` ごとに
   `worker_api_error` を一度だけ記録する。payload は sessionId、streamId、sequence、category、provider、
   transport、host側 `observedAt` だけを持つ。保持窓の先頭sequenceから未観測範囲が判明した場合は、
   `worker_api_error_gap` に safe な range/countだけを記録する。presentだがmalformedなfieldには
   `worker_api_error_observation_invalid` を同一snapshotについて一度だけ記録し、raw valueを含めない。
   invalid payload は sessionId、provider、transport、既存statusの resultWatermark / lastEntryId、
   allowlist済み reason（`schema-version` / `stream-id` / `watermark` / `recent-shape` /
   `sequence` / `category` / `consistency`）、host側 `observedAt` だけを持つ。dedupe key は
   `{sessionId, resultWatermark, lastEntryId, reason}` とし、malformed value自体やそのhashを使わない。
6. **warn と通知の冪等性**: 新規event bundleのdurable insertを獲得したtickだけが、同じsafe metadataを
   structured warningへ出し、既存のbest-effort operational notificationを最大1回試行できる。
   再tick・supervisor再起動時のdedupeはdurable task eventの存在を正本とする。event insert後・通知前の
   crash、またはnotification失敗では通知が欠け得るが、eventを巻き戻したりtask処理を停止したりしない。
7. **R0（観測のみ）**: この観測を根拠に自動cancel、retry、compaction、needs-manual化、task状態遷移を
   行ってはならない。pre-send window保証、context budget、recovery、direct/Codex transport parity、
   installed runtimeへのapply・restart・live canaryは本節の対象外とする。

## 14. Web 看板ビュー（@hachi/web、v0.2）

### 14.1 方針
- 「薄い自作 + 既製部品」: Hono + hono/jsx SSR + better-sqlite3 **readonly 接続**。JS 無し
  （ボード画面は `<meta http-equiv="refresh" content="30">` の全画面更新。htmx/DnD は将来拡張）
- 原則読み取り専用。例外として §23（supervisor kill-switch トグル）、§29.4（スケジュール CRUD）、
  §80（独立した人間判断依頼への回答）の限定 write を提供し、いずれも §31 の共通 write 認可を通す。タスク操作の write は提供しない
  （CLI / supervisor の責務）
- DB への SQL は core の `KanbanReadView`（読み取り専用クエリ面）に集約する。web パッケージから生 SQL 禁止
  （§5 の単一書込パス原則の読み取り版）

### 14.2 サーバ
- bind は **127.0.0.1 固定**。port は env `HACHI_KANBAN_WEB_PORT`（既定 **9131**。9129/9130 は本番 Hermes dashboard が使用中のため回避）
- 起動: LaunchAgent `com.hachi-kanban.web`（KeepAlive 常駐、2026-07-04〜。テンプレートは
  runbooks/templates/com.hachi-kanban.web.plist。on-demand-only mode で自動再起動が保留される
  既知制約があり、復旧は kickstart または §30 webwatch）。手動オンデマンド起動は廃止
- DB 接続: `readonly: true, fileMustExist: true` + busy_timeout。integrity_check や長い読みトランザクションを張らない

### 14.3 ルート
- `GET /` ボード画面。query: `tenant`（絞り込み）
  - 最上段に**あなたの判断待ち**レーン（user-decision/user-feedback。ユーザーが行動する対象。
    従来の赤系アクセント）
  - その下（横並び UI では直後）に**オーケストレーター回収待ち**レーン
    （review-required/needs-manual/auto-launch-failed/未知 prefix。通常はユーザー対応不要）
  - **自律進行中**レーン（codex-in-progress/claude-in-progress。provider バッジ + 経過時間）
  - 状態レーン: triage / todo / ready / review / needs-integration / done(直近N=20)
  - ヘッダ: tenant セレクタ・status別件数・retry_pending（auto-launch-failed）件数
- `GET /task/:id` 詳細画面: task 全項目（block_reason/assignee/provider/profile/model_override）、
  コメント時系列（agent.message.v1 フェンスドブロックは intent/from/to を整形表示）、イベント監査履歴、
  実行履歴（task_runs: provider/session/状態/開始終了/meta の model・modelDelivery・cost）、
  親子リンク（タイトル付き）、artifacts 一覧（prompt-*/transcript-*）とインライン表示リンク（帰属付きの詳細は §32.5）
- `GET /task/:id/artifact/:name` artifact テキスト表示。**name は当該タスクの artifacts ディレクトリの
  readdir 結果と完全一致する場合のみ**許可（パス結合前検証 + resolve 後 containment。fail-closed 404）。
  表示前に `redactText` を通す（defense in depth）
- `GET /healthz` `{ok, taskCount}`

### 14.4 KanbanReadView（core に実装、interface は types.ts）
tenants / counts(tenant?) / humanQueue(tenant?) / inProgress(tenant?) / byStatus(status, tenant?, limit?) /
bucketOf(task) / task(id) / comments / events / runs / links(親子) / close。
visibility_bucket 分類: human_queue（4 prefix）/ autonomous_in_progress（2 prefix）/
retry_pending（auto-launch-failed:）/ blocked_other / それ以外は status そのまま。
human_queue 表示は対応主体で2分類する。user-decision/user-feedback は「判断待ち」、
review-required/needs-manual は「回収待ち」。auto-launch-failed と未知 prefix も Web 表示上は
「回収待ち」に倒す（fail-closed）。既存 humanQueue() は後方互換の合算読み取り面として維持する。

### 14.5 コスト/トークンの永続化（前提小改修）
- adapter の `SessionStatus` に `lastResult?: {costUsd?, turns?, durationMs?, inputTokens?, outputTokens?}`
  を追加し、`/api/messages` の最後の type:"result" イベントから充填する
- supervisor finalize は成功/欠落いずれの endRun 時にも、取得できた lastResult を run の meta へ
  マージ保存する（web が task_runs.meta から表示。bridge ライブ呼び出しに依存しない）

#### 14.5.1 `task_runs.meta.usage`（v0.19・§69 とは独立）

`lastResult` は bridge の result イベント由来で、direct 経路では欠落し、codex では全項目0の
偽ゼロになる実績がある（2026-08-20 実測: codex 816 行が全項目0、direct 313 行が lastResult 自体なし、
claude はキャッシュ分を落として `input_tokens` だけ記録）。**`lastResult` は互換のため残すが、
費用対効果の判断には使わない。**

判断の正本は `task_runs.meta.usage`（`RunUsage`）とする。

- **metric ごとにタグ付き値**を持つ。`measured` / `estimated` / `not-provided` /
  `unavailable-by-design` / `unknown` / `legacy-unverified` を構造的に別 state とし、
  網羅性検査で既定集計が推定値や未検証値を暗黙に取り込むことを防ぐ
- **`measured` と `estimated` を合算しない。** 表示は必ず別列にする
- トークンは provider のネイティブセッションログから取得する
  （claude: `~/.claude/projects/**`、サブエージェント配下を親へ合算する。
  codex: `~/.codex/sessions/**/rollout-*.jsonl`）。
  **provider ごとに内数構造が違う**（codex の `cached_input_tokens` は input の内数、
  `reasoning_output_tokens` は output の内数）ため、互いに素な系統へ正規化してから合算する
- **cost はどちらの provider でも `measured` にならない。** claude のネイティブログに cost は存在せず、
  `--output-format json` の封筒は `.out` を JSON 化して handoff fence 抽出を壊すため使えない。
  よって両者とも価格表からの `estimated` とし、参照した価格表の版を値に添える
- 価格引きは**完全一致のみ**。前方一致や正規化で近い単価を静かに使わない。
  価格表に無いモデルは `unavailable-by-design` とし、**0 を入れない**
- run と provider セッションの相関は**起動時に session id を渡して確定させる**。
  時刻ウィンドウ推測に依存しない
- `.out` の書式を変えない（handoff fence 抽出が生テキスト前提のため）。usage 取得は事後読取で行う

設計の詳細と実測の根拠は `docs/plans/direct-run-usage-cost-audit.md`（改訂節 R1〜R8）を参照する。

## 15. review ステージ（v0.3）

worker の handoff outcome="review" で `review` 状態になったタスクを、レビュアーセッション（two-party gate の
第2審）で自動レビューする。旧システムの reviewer パイプラインの新実装。

### 15.1 レビュアーの起動（review ステージ前半）
- 対象: status='review' かつ open な reviewer run（task_runs.meta.role='reviewer'）が無く、
  当該タスクに `verdict_finalized` イベントが無いタスク
- モデル/プロバイダ: §67のreviewer role解決（task reviewer override > 選択review profile >
  config.profiles["review"]）。未解決またはcapability不足なら起動しない（fail-closed）
- cwd: worker と同じ（task.body の `cwd:` 行）。無ければ `needs-manual: レビュー起動不能 (cwd 無し)` へ
- 起動数: 1 tick あたり最大1（ハードコード）。resource guard の maxInFlight 計算には
  reviewer run も含める（listOpenRuns ベースで加算）
- プロンプト（§15.4 で改善・2026-07-08）: タスク title/body + worker の handoff summary +
  **変更俯瞰（host が worktree cwd で生成: `git diff --stat <BASE>` + `git status --porcelain=v1 -uall` +
  untracked 一覧。BASE=merge-base(HEAD, origin/main||main)。cap/truncated 明記・失敗は fail-open）** +
  **reviewer 必須手順**（「上の俯瞰は索引。判定は cwd の worktree で `git --no-pager diff <BASE>` と untracked
  新規ファイルの中身を自分で取得して行うこと。git diff が取得できない場合は pass/high を出さない」）+
  「読み取り専用でレビューし、最後に以下のフェンスドブロックを出力せよ」:
  （旧: 直近 worker transcript 末尾抜粋 8000字 → 実 git diff で代替。transcript 末尾窓は削除）

```
```hachi-verdict-v1
{"taskId": "t_...", "verdict": "pass" | "fail", "confidence": "high" | "medium" | "low",
 "summary": "判定理由の要約", "issues": ["指摘があれば列挙"],
 "failureCause": "worker_local" | "worker_major" | "spec_ambiguity" | "environment_evidence" | "late_requirement_change"}
```
```

`failureCause` は fail verdict で必須。pass verdict では省略する。legacy fail の欠落・未知値は
§21.1どおり `unknown` へ正規化し、自動reworkしない。

- 起動成功: startRun（meta: role='reviewer', serverUrl, model, modelDelivery）+ イベント
  `reviewer_launched`（payload: sessionId）。**status は review のまま**（block しない。
  reviewer セッションの追跡は task_runs が正本）
- prompt artifact: `prompt-review-<claimToken 相当（nonce）>.txt` として保存

### 15.2 verdict の検証遷移（review ステージ後半）
- 対象: status='review' かつ open reviewer run あり
- adapter.status が idle + resultCount>=1 になったら transcript 取得 → hachi-verdict-v1 を抽出・検証
  （taskId 一致・verdict/confidence が列挙値。fail-closed）。transcript は
  `transcript-review-<sessionId>-<hash>.txt` として保存（best-effort）
- 遷移（Tx 内で status='review' と reviewer run の sessionId 一致を再検証。§12.12-1 と同型）:
  - **pass + high** → done（comment: redact 済み verdict summary + イベント `verdict_finalized`）
  - **pass + medium/low** → blocked `user-decision: レビュー pass (confidence=<c>) 人間確認要`、assignee=human
  - **fail** → `failureCause` を §21.1 の機械規則で分類し、同じroutingの自動reworkまたは
    `review-required:` へ遷移する。replacement自体はorchestrator専有でSupervisorは起動しない
  - いずれも reviewer run を endRun('done', meta+lastResult)
- verdict 欠落/不正: bridge reviewer は §15.2.1 の one-shot verdict nudge を先に試す。direct、
  安全な assistant result 抽出不能、nudge 注入失敗、grace 超過、nudge 後の再欠落/不正だけ、
  `verdict_missing` イベント（sessionId スコープ・冪等）+ run を failed で close +
  `needs-manual: レビュー verdict 欠落 (session=<sid>)` へ倒す（恒久リーク防止）
- transcript 取得失敗: §12.16-1 と同じ有界リトライ（3回で needs-manual）

### 15.2.1 reviewer verdict 欠落の one-shot 救済

目的は**レビュー本体の再実行ではなく、既に行った判断の protocol fence 化だけ**である。reviewer の
構造化 assistant 最終 result は存在するが、有効な `hachi-verdict-v1` が無い場合、bridge transport に限り
同一 reviewer session へ1回だけ救済 prompt を注入する。新規 reviewer session / verify / diff 読み直しを
起動してはならない。

- 適用条件（すべて必要）:
  - task status=`review`、対象 sessionId の reviewer run が open、現在の task/run/session fence が一致
  - provider/CLI/0-token failureではなく、安全に抽出できた構造化 assistant result が1件以上ある
  - transport=`bridge`。direct は resume 不能なので現行どおり fail-closed
  - 当該 sessionId に `verdict_nudge_sent` が未記録（1 run 1回、冪等）
- 注入文は「新たなレビュー・tool実行・verifyを行わず、直前に確定した verdict / confidence / summary /
  issues / failureCause を同じ taskId の `hachi-verdict-v1` fence で直ちに再出力する。fail の
  failureCause は必須」と限定する。
- 外部副作用 intent の順序は、現在の task/run/session を再検証 → inject → 成功時に
  `verdict_nudge_sent` を記録、の順とする。event payload は `sessionId`、`ts`、
  `baselineResultWatermark`、`baselineLastResultId`、`baselineResultCount` を持つ。比較 watermark は
  `lastResultId>0` を優先し、無い legacy bridge だけ `resultCount` に fallback する。
- nudge 成功時は task を `review`、reviewer run を open のまま維持する。同じ watermark の間は再解析・
  再注入しない。観測 watermark が baseline を超えた**新しい assistant result だけ**を通常の §15.2 parserへ戻す。
- 新resultが有効 verdictなら通常遷移する。新resultも欠落/不正なら再nudgeせず、原因を
  `model_output_missing` / `parse_invalid` に分類して `verdict_missing` + needs-manualへ倒す。
- assistant role境界や構造化 result 自体を安全に取得できない `extraction_failed` はnudge非対象とし、
  transcript全文・prompt例示へ探索を広げずneeds-manualへ倒す。
- graceは10分の定数。新watermark未観測のまま超過したら `verdict_nudge_expired` を記録し、runをfailedで
  closeしてneeds-manualへ倒す。inject失敗は `verdict_nudge_failed` を記録して同じくfail-closedとする。
- stale session、review遷移後、別generation/run、既にclose済みrunからのlate result/nudge mutationは拒否する。
  `message_processed` やtransport受理だけを reviewer が verdict を出した証拠にしてはならない。

### 15.3 ステージ順序と kill-switch
- ステージ順: dispatch → monitor → finalize → **review** → messages → reap
- kill-switch: `$HACHI_KANBAN_HOME/review.disabled`

## 16. 旧ボード import（v0.3、一回きりの移行ツール）

旧 legacy-hermes ボード（~/.hermes-hachi-dev/kanban/boards/dev/kanban.db）の生きタスクを
新ボードへ移行する。旧 DB へは**読み取り専用アクセスのみ**（PRAGMA query_only 相当。書き込み厳禁）。

### 16.1 CLI
`hachi admin import-legacy --db <旧DBパス> [--status triage,todo,blocked] [--task <id>...] [--apply]`
- 既定 dry-run（移行予定の一覧と変換内容を表示）。--apply で実行
- 対象は指定 status（既定: triage,todo,blocked）の旧タスク。done/archived は対象外

### 16.2 変換規則
- title / body / tenant / priority / assignee をそのまま移行。id は新規採番（旧 id は引き継がない）
- status 対応: triage→triage / todo→todo / blocked→blocked
- blocked の block_reason: 新 REASON_PREFIXES に一致する prefix はそのまま。
  一致しない（codex-paused: 等の旧固有 prefix）は `needs-manual: (imported) <元 reason 先頭200字>` に
  変換し assignee=human（fail-closed。旧文脈の判断は人間に委ねる）
- ready への直接投入は行わない（cwd 未整備のタスクの誤自動起動防止）
- 各タスクに provenance コメントを追加:
  `imported from hermes kanban <旧id> (created <旧created_at ISO>, status <旧status>)`
- 旧コメント・イベントは移行しない（履歴は旧 DB を read-only で参照。コメント83%が生ログのため）

### 16.3 冪等性
- import 済み判定は task_events の `legacy_imported` イベント（payload.legacyId）を全タスク横断で照合し、
  同一 legacyId の二重取り込みを防ぐ（再実行安全）

## 17. direct transport（v0.3、model 実配信）

当時 bridge は model を運べなかった（modelDelivery=none）ため、トークン経済を実効化する
`codex exec` 直接実行トランスポートを追加した。**トレードオフ: G2 非表示**（旧システムの
direct reroute と同じ割り切り。既定は bridge のまま、profile 単位で opt-in）。
なお 2026-08-21 以降は bridge も model を運べる（§49.4）ため、この理由だけで direct を選ぶ必要は無い。

### 17.1 profile 拡張
- ProfileEntry に `transport?: "bridge" | "direct"`（既定 "bridge"）。direct は provider=codex のみ対応
  （claude direct は将来）。config 検証で「direct + claude」は fail-closed で reject

### 17.2 DirectCodexAdapter（adapters）
- launch: `sh -c 'codex exec -c model=<model> --cd <cwd> - < <promptファイル> > <outファイル> 2>&1; echo $? > <exitファイル>'`
  を detached で spawn。prompt はファイル経由（シェルエスケープ回避）。
  SessionRef: sessionId=`direct-<nonce16hex>` / serverUrl=`direct` / modelDelivery=**"native"**
- セッション状態: `$HACHI_KANBAN_HOME/state/direct-sessions/<sessionId>.json`
  に {pid, taskId, outFile, exitFile, model, startedAt} を記録
- status(): exit ファイルあり → `idle` + resultCount=1 / 無し + pid 生存 → `active` /
  無し + pid 消失 → `idle` + resultCount=1（クラッシュも「終了」扱い。handoff 欠落経路が
  needs-manual に倒すため恒久リークしない）
- fetchTranscript(): out ファイル全文（handoff フェンス抽出は全文正規表現のため互換）
- inject(): 非対応（明確なエラーを throw。steer は bridge 経路のみ）
- healthCheck(): codex CLI の存在（which codex）

### 17.3 supervisor 配線
- ModelResolution（ok:true）に transport を含める。resolveModel は profile の transport を伝播
- StageDeps に `directAdapters?: Partial<Record<Provider, WorkerAdapter>>` を追加。
  dispatch は transport=direct のとき directAdapters[provider] を使用（不在は auto-launch-failed で
  fail-closed。bridge への silent fallback 禁止）
- startRun meta に `transport` を記録。monitor/finalize/review の SessionRef 再構築は
  meta.transport==='direct' なら direct adapter へルーティング（serverUrl='direct' が印）
- block reason は既存書式を踏襲しつつ `server=direct`（G2 monitor は server URL を参照しないため無害。
  G2 に出ない旨はタスクコメントに1行明記）
- resource guard は従来どおり listInProgress ベース（direct も自動算入）

## 18. 人間確認キューの通知（v0.3）

- supervisor に `notify` ステージを追加（ステージ順の最後、reap の後。kill-switch: notify.disabled）
- 対象: human_queue bucket に入った blocked タスク（user-decision:/user-feedback:/review-required:/
  needs-manual:）のうち、`human_notified` イベント（payload.reasonHash = block_reason の sha256 先頭8hex）が
  未記録のもの（同一 reason での再通知はしない。reason が変われば再通知）
- 通知手段: macOS 通知（osascript display notification。title は user-decision/user-feedback なら
  `要判断`、review-required/needs-manual なら `回収待ち` を含める。本文=redact 済み reason 先頭100字）。
  osascript 失敗は warn のみ（通知はベストエフォート、状態を壊さない）
- 通知後 `human_notified` イベントを記録（apply 時のみ。dry-run は件数計上）

## 19. バックアップ（v0.3）

- `hachi admin backup [--keep <n>]`（既定 keep=14）: better-sqlite3 の backup API で
  `$HACHI_KANBAN_HOME/backups/kanban-<board>-<YYYYMMDD-HHmmss>.db` を作成し、古い世代を keep 件まで削除
- launchd テンプレート `com.hachi-kanban.backup.plist`（1日1回、StartCalendarInterval 04:00。
  on-demand-only mode で発火しない可能性があるため、runbook に手動実行の代替を明記）

## 20. Web 看板ビュー v2（v0.4、React + Radix UI 化）

§14 の zero-JS SSR 方針を改め、web パッケージに限り React SPA 構成を採用する（ユーザー指示）。

### 20.1 構成
- フロント: Vite + React + Tailwind CSS + Radix UI（@radix-ui/react-select 等の primitives）
- サーバ: Hono は JSON API + 静的配信に転換。**セキュリティ不変条件は §14 から完全継承**:
  127.0.0.1 固定 bind / readonly 接続（KanbanReadView のみ・生 SQL 禁止）/
  artifact ルートの taskId 形状検証・readdir 完全一致・containment・redactText / 依存追加は web パッケージ内に限定
- `pnpm web` は「dist 不在なら vite build → serve」。開発は `pnpm --filter @hachi/web dev`

### 20.2 API ルート
- `GET /api/board?tenant=&q=` → {tenants, counts,
  lanes: {humanQueue(後方互換合算), humanDecisionQueue, orchestratorRecoveryQueue, inProgress, byStatus...},
  retryPending}
- `GET /api/task/:id` → {task, comments, events, runs, links, artifacts, messages(パース済み packet)}
- `GET /task/:id/artifact/:name`（従来どおり text。検証・redact 維持）/ `GET /healthz`
- SPA ルーティング: `/` ボード、`/task/:id` 詳細（API を fetch。30秒ポーリング更新）

### 20.3 トンマナ（MaterialM 参照）
- ライトグレー背景 + 白カード（rounded-xl〜2xl・ソフトシャドウ・薄いボーダー）、
  Plus Jakarta Sans 系のクリーンなサンセリフ、プライマリは青紫系
- レーンヘッダ: レーン名 + 件数チップ。カード: タイトル・tenant/provider/priority の淡色バッジ
  （human_queue=赤系 / in-progress=青系 / done=緑系 / retry=琥珀系の soft badge: bg-*/10 + text-*）
- 絞り込みツールバー: Radix Select（tenant / 状態・bucket）+ シンプルな検索 Input（title/ID 部分一致）。
  余計な装飾は排し、フィルタ変更は即時反映

## 21. 自動 rework（v0.4）

review の verdict=fail 時、即座に人間へ倒すのではなく、有界の自動再作業を試みる
（旧システムの bounded rework 相当）。

### 21.1 発火条件と上限
- fail verdict の `failureCause` は
  `worker_local | worker_major | spec_ambiguity | environment_evidence | late_requirement_change`。
  field 欠落（legacy）・未知値・型不正は `unknown` へ正規化し、worker 起因と推測しない
- 同じroutingを自動reworkできるのは `worker_local` かつ次の全条件を満たす場合だけ:
  - `rework_launched` が0件（自動reworkは固定で最大1回。legacy config互換の
    `review.maxReworkLaunches` は省略または1だけを受理）
  - 直前の `worker_local` fail と summary hash が異なる。同一なら `rework_no_progress`
- `worker_major` と、自動rework後の2回目の `worker_local` は同じworkerを起動せず、
  `review-required:` + machine-readable `orchestrator_sol_xhigh_replacement` として止める。
  Supervisorはreplacementを起動せず、orchestratorがreference §0.6.2とdurable cancel gateに従う
- `spec_ambiguity | environment_evidence | late_requirement_change | unknown` はモデル失敗回数・
  自動rework枠へ加算せず、原因付き `review-required:` でorchestrator回収へ倒す
- `verdict_failed` payload は sessionId / summaryHash / issueCount / source に加え、固定enumの
  `failureCause` / `failureCauseSource` / `modelFailureCounted` / `routingAction` を持つ。
  summary・issues・未知の生causeは保存しない。block reason のredact済みsummaryは先頭120字まで

### 21.2 rework の起動
- `worker_local` の1回目だけworkerと同じモデル解決（resolveModel(task, config)。transportも尊重）
- プロンプト: 元タスク title/body + 「前回作業のレビュー指摘」（redact 済み verdict summary/issues）+
  「指摘を修正し、完了時は outcome="review" で handoff せよ」（再レビュー必須）
- 遷移: Tx 内で status='review' と reviewer run の close を再検証 → review → blocked
  （in-progress reason、通常の worker と同書式）→ startRun（meta.rework_attempt=n）+
  `rework_launched` イベント（payload: attempt, 前回 summaryHash）
- 以降は通常サイクル（monitor → finalize → outcome=review → review ステージ → reviewer 再審）
- 起動失敗は dispatch と同じ auto-launch-failed 処理

## 22. Claude direct transport（v0.4、§17 の Claude 版）

### 22.1 方式
- §17.1 の「direct は codex のみ」制約を撤廃し、provider=claude の direct transport を追加
  （config 検証の direct+claude 拒否を削除）
- DirectClaudeAdapter: `claude -p --model <model> --dangerously-skip-permissions < <promptファイル>`
  を task cwd で detached 実行（プロセス機構は §17.2 と共通化してよい: prompt/out/exit ファイル・
  state JSON・3分岐 status・inject 非対応・transcript=out 全文）
- modelDelivery="native"（--model で実配信）
- **subscription-only**: 子プロセス env から ANTHROPIC_API_KEY / CLAUDE_API_KEY 等の API 課金系
  変数を除去して spawn する（旧システムの subscription guard 相当）
- healthCheck: claude CLI の存在（which claude）

### 22.2 既定値
- 既定 profile は bridge のまま（G2 可視性優先）。安価モデルの実配信が必要な profile のみ
  config.json で transport="direct" を opt-in する

## 23. supervisor 状態パネル + kill-switch トグル（v0.4）

Web から supervisor / launchd / 各ステージ kill-switch の状態を確認し、ステージの ON/OFF を行える
最小パネル。**readonly 設計の唯一の例外**として、kill-switch ファイルの touch/rm のみを許す限定書込。

### 23.1 状態 API（読み取り）
- `GET /api/supervisor` → {
    launchd: {label, loaded, pid|null, lastExitCode|null},  // launchctl print/list をパース
    stages: [{name, disabled: bool}],  // dispatch/monitor/finalize/review/messages/reap/notify + supervisor(全体)
    lastTick: {at, stages: [{name, actions, skipped}]} | null,  // supervisor.jsonl 末尾から
    killSwitchDir: string
  }
- launchctl 実行は spawnSync（label 固定 com.hachi-kanban.supervisor）。失敗時は launchd:null で degrade
- supervisor.jsonl は末尾のみ tail 読み（全読み禁止）。存在しなければ lastTick:null

### 23.2 kill-switch トグル API（限定書込）
- `POST /api/supervisor/killswitch` body `{stage: string, disabled: bool}`
  - stage は許可リスト（supervisor/dispatch/monitor/finalize/review/messages/reap/notify）と完全一致必須（fail-closed）
  - disabled=true → `$HACHI_KANBAN_HOME/<stage>.disabled` を touch(0600) / false → rm -f
  - **kill-switch ファイルのパスは env.home 直下に固定**（path.join 後に env.home 配下 containment 検証。stage 名の許可リスト一致で二重防御）
  - 200 で更新後の該当ステージ状態を返す。DB には一切触れない
- **CSRF/誤操作対策**: このエンドポイントは 127.0.0.1 bind でのみ動作（既存）。加えて `Sec-Fetch-Site`
  ヘッダが cross-site の場合は拒否（同一オリジンの fetch のみ許可。過剰でない範囲の最小対策）

### 23.3 UI
- ボード画面ヘッダに「supervisor」ステータスバッジ（緑=loaded+PID / 灰=停止 / 赤=全体 kill-switch）。
  クリックでパネル展開: launchd 状態・最終 tick・各ステージのトグルスイッチ（Radix Switch or checkbox）。
  トグルは即時 POST → 楽観更新 + 再フェッチ。破壊的でないので確認ダイアログは出さない
- ステージ無効化中はバッジに「N stages off」を表示

## 24. 依存ゲート（depends-on による実行制御、v0.4）

task_links の `link_type='depends-on'` を実行順序制御に効かせる。既存の `subtask` リンクは
構造表現のみで実行制御しない（従来どおり）。

### 24.1 セマンティクス
- `hachi task link <prerequisite> <dependent> --type depends-on`
  → task_links(parent_id=prerequisite, child_id=dependent, link_type='depends-on')。
  意味は「dependent は prerequisite に依存する（prerequisite が先に done になる必要がある）」
- タスク T の**前提タスク**= child_id=T かつ link_type='depends-on' のリンクの parent_id 群
- **未充足の前提** = 前提のうち status が done/archived でないもの

### 24.2 依存ゲート（dispatch）
- dispatch は ready タスクを起動する前に未充足前提を確認する。1件以上あれば **claim せず skip**
  （launch 予算を消費しない・状態は ready のまま・次 tick で再評価）。
  1タスクにつき最初の待機時のみ `dependency_wait` イベントを記録（payload: 未充足前提IDリスト。
  同一充足集合での重複記録は避ける = payload のハッシュで冪等）。前提が全て done になれば通常起動
- todo↔ready の自動昇格は行わない（ready + dispatch skip 方式に一本化。運用がシンプル）

### 24.3 サイクル安全
- `task link --type depends-on` は、リンク追加で depends-on グラフに**循環が生じる場合は拒否**
  （fail-closed。デッドロック防止）。自己依存も拒否
- KanbanStore に `dependencies(taskId): TaskRow[]`（前提の TaskRow 群）を追加

### 24.4 CLI / 可視化
- `hachi task deps <id>` — 前提タスク一覧を status 付きで表示（未充足を明示）。--json 対応
- Web 詳細画面 LinksCard: depends-on リンクは subtask と区別し、前提側は status ドット
  （done=緑/未充足=灰）付きで表示（nice-to-have）

## 25. ワーカープロンプト先頭の G2 可読性（v0.4）

EVN-G2 のセッション一覧はプロンプト先頭の文字を表示するため、先頭が識別に有効であるべき。
現状は全プロンプトが `# タスク: ` 定型で始まり、一覧で先頭がその定型に食われてタスク識別性が低い。

### 25.1 方針
- buildWorkerPrompt / buildReviewPrompt / buildReworkPrompt の**先頭行**を、
  マークダウン定型 prefix（`# タスク: ` 等）でなく **task.title を先頭に置く**形へ変更する。
  種別（worker/review/rework）は先頭の短い記号マーカーで区別:
  - worker: `▶ <title>`
  - review: `🔍 review: <title>`
  - rework: `🔁 rework(N): <title>`（N は attempt。取得できなければ番号省略）
- 先頭行末尾に短縮タスク ID を併記（`  〔<task.id>〕`）。title が長い場合は G2 側で切れてよい（ID は副次）
- プロンプト**本体**（cwd 行・## 目的・handoff 指示等）は現状維持。**先頭行のみ**変更する
- 先頭行の title は改行・制御文字を除去し1行に畳む（一覧表示の崩れ防止）

### 25.2 制約
- handoff/verdict の抽出ロジックには影響させない（本体の指示ブロックは不変）
- title は redact 不要（既にボード上の可視情報）だが、改行のみ畳む

## 26. 実行中セッション一覧 + ターミナル風ライブビュー（v0.4）

Web からセッションを一覧し、選んだセッションの会話をブラウザ内ターミナル風 UI でポーリング表示する。

### 26.1 サーバ（bridge プロキシ。token をブラウザに晒さない）
- `GET /api/sessions` → 実行中セッション一覧。KanbanReadView から task_runs(status='running') を集約:
  `[{taskId, taskTitle, provider, model, transport, sessionId, serverUrl, startedAt}]`
  （meta から model/transport/serverUrl を読む。KanbanReadView に runningSessions() を追加）
- `GET /api/session/:sessionId/messages?provider=&server=` → **サーバが bridge へプロキシ**して
  `/api/messages` の結果（type 判別イベントログ）をそのまま返す。token はサーバがファイルから読み
  Authorization に付与（**ブラウザに token を渡さない**）。provider から token ファイル/bridge URL を解決。
  server パラメータは env の既知 bridge URL（codex 3456 / claude 3457 / direct）と**完全一致する場合のみ**
  許可（SSRF 防止・fail-closed）。direct transport（serverUrl='direct'）は bridge を持たないため
  「ライブ閲覧は非対応（transcript artifact を参照）」を返す
- token は §14 のセキュリティ不変条件を継承（生値をレスポンス・ログに出さない）

### 26.2 フロント（ターミナル風ビュー）
- ボード画面ヘッダ or 別ルート `/sessions` に**実行中セッション一覧**（タスク名・provider バッジ・
  model・経過時間・sessionId 短縮）。行クリックでライブビューを開く
- **ターミナル風ライブビュー**（モーダル or 別ペイン）: 選択セッションの `/api/session/:id/messages` を
  **2〜3秒間隔でポーリング**し、新規イベント（id 増分）のみ追記する（全再描画しない）。
  等幅フォント・ダークな端末調配色。user_prompt=プロンプト行、text_delta/result=出力、status/
  running_stats=淡色のメタ行として整形。末尾へオートスクロール（ユーザーが上にスクロール中は追従停止）
- ポーリングは開いている間だけ。閉じたら停止。session が idle+result 済みになったら「完了」表示して
  ポーリング終了
- **コピー機能も併設**: §26 の curl コマンド（token は `$(cat <tokenfile>)` 形式で生値を含まない）を
  クリップボードにコピーするボタン（ターミナルで直接見たい人向け）

### 26.3 制約
- 読み取り専用（session への入力送信はしない。steer は CLI/msg 経由）
- direct transport セッションは artifact 参照へ誘導（bridge ライブ非対応）

## 27. セッション単独ウィンドウ + 実行履歴からの遷移（v0.4）

§26 のライブビューを、詳細画面の実行履歴からも開けるようにし、単独ウィンドウで複数並べられるようにする。

### 27.1 専用ルート `/session/:sessionId`
- ライブビュー（§26.2 の SessionLiveView）を専用ページとして独立表示する SPA ルートを追加
- `document.title` を **kanban タスクタイトル**に設定（`▶ <title>` 等の識別子付き。複数ウィンドウを
  タスクバー/タブで見分けられるように）
- ページ読込時に `GET /api/session/:sessionId` でセッションのメタ（taskId/taskTitle/provider/model/
  serverUrl 等 = RunningSession 相当）を取得してから messages ポーリングを開始する。
  実行中でない（done 済み等で running run が無い）sessionId の場合は transcript artifact 参照へ誘導 or
  「セッション終了済み」表示（最後まで取得できた分は表示）
- SPA fallback に `/session/:sessionId` を追加（app.ts。index.html を返す。/api・artifact は除外）

### 27.2 サーバ `GET /api/session/:sessionId`
- KanbanReadView に `runningSession(sessionId): RunningSession | null` を追加（task_runs から1件）。
  running が無ければ、task_runs 全体（status 問わず）から該当 sessionId の run + task を引いて
  `{...RunningSession, ended: true}` 相当を返せるようにする（終了済みでもメタは見せる）
- 実装は §26 の SSRF/token 不変条件を継承

### 27.3 導線
- **実行履歴（RunsCard）**: 各 run 行に、session_id があり transport≠direct なら「ライブビュー ⧉」リンク。
  クリックで `window.open('/session/<sessionId>', '_blank', 'width=720,height=900')` で単独ウィンドウ起動
- **セッション一覧（SessionsPanel）**: 既存のモーダル表示に加え、各行に「別ウィンドウで開く ⧉」も併設
- 単独ウィンドウは複数同時に開ける（それぞれ独立してポーリング。タイトルで識別）

## 28. セッション画面の再設計（一覧モーダル廃止 → 専用画面 + タブ、v0.4）

一覧のモーダル方式を廃し専用画面 + タブに一本化する。**単独ウィンドウ（/session/:sessionId）は維持**。

### 28.1 ルート
- `/sessions` — セッション一覧の専用画面。ボードヘッダの「実行中セッション」はモーダルでなくここへ SPA 遷移。
  **タブで「実行中」/「以前のもの」を切替**（実行中=runningSessions、以前=recentSessions 直近50）。state バッジ
- `/session/:sessionId` — 単一セッションのライブ/ログ画面（**単独ウィンドウ用に維持**）。一覧の行クリックで
  SPA 遷移、「別ウィンドウ ⧉」で window.open。document.title = kanban タスクタイトル
- SPA fallback に /sessions と /session/:sessionId を追加

### 28.2 core / サーバ
- RunningSession に `state: 'running'|'ended'` を追加（types 更新）
- KanbanReadView: runningSessions()（running）/ recentSessions(limit)（ended 直近）/ runningSession(sessionId)（単体、state 反映）
- `GET /api/sessions?scope=running|recent`（既定 running）/ `/api/session/:id`（メタ）/ `/messages`（§26）/
  `/transcript?taskId=`（終了済みフォールバック）

### 28.3 UI
- 一覧モーダル/オーバーレイは全廃 → 一覧画面に。ダイアログ「閉じる」概念は無くす（画面なので戻るリンク）
- ライブ/ログビュー: text_delta 連結・「最新に戻る ↓」ボタン・端末調・ダークモード・「タスクを開く」別タブ を踏襲
- **ノイズ抑制（v0.6）**: 既定表示は実際のやり取り（user_prompt / text / result）のみ。
  running_stats・status マーカー（think_start/think_end/text_start/text_end）・tool_start/tool_end 等の
  進行イベントは既定で**非表示**。「詳細イベント」トグル（既定 OFF）で全イベントを表示できる。
  最新の running_stats はストリームに流さず、ヘッダの**ステータスピル1個**（経過時間・token）に集約して
  ライブ更新する。tool イベントは詳細 ON 時に「🔧 <tool名>」の1行 dimmed 表示（unknown type と表示しない）

### 28.5 セッションの工程表示（v0.6）
- RunningSession に `role: "worker" | "reviewer"` と `taskStatus: TaskStatus`、`tenant: string`
  （いずれも tasks との join）、`effort: string | null` / `effortDelivery: string | null`（run meta 由来、
  §35.3。無ければ null）を追加する。
  role は task_runs.meta の `role`（review stage が "reviewer" を刻む）から導出し、無ければ worker。
  taskStatus は tasks との join による**現在**の状態
- 表示: セッション一覧（/sessions 両タブ）とタスク詳細の実行履歴（RunsCard）の各行に
  **工程バッジ**（worker=「実装」/ reviewer=「レビュー」で色分け）を付ける。
  セッション一覧側は taskStatus のチップと **tenant 名**も併記する（タイトルは表示済み）。
  ライブビュー/セッション詳細のヘッダにも tenant を表示する
- ライブビュー（/session/:id）のヘッダにも工程バッジを表示する

### 28.6 ネイティブ transcript の生 JSONL 参照（v0.7）

`GET /api/session/:sessionId/transcript-raw?taskId=&after=&before=&limit=`。
既存の SessionLiveView（§26 の `/messages`）を置き換えず併置する読み取り専用ビューで、
ディスク上のネイティブ JSONL を正本として行単位で辿る。以下は凍結された不変条件であり、
worker が実装判断で緩めてはならない。

1. **パス解決は既存ヘルパのみ**。`resolveClaudeProjectsRoot` / `resolveCodexSessionsRoot` /
   `findClaudeSessionDir` / `findCodexRollout` / `readDirectSessionState` / `readDirectOutHead`
   だけを使い、cwd からディレクトリ名への符号化規則を再実装しない。
   direct transport の sessionId indirection（claude は state JSON の `nativeSessionId`、
   codex は `.out` 冒頭の `session id: <uuid>` ヘッダ）を board の sessionId と混同しない。

2. **パス境界（形式検証と containment の両方を課す）**。native session id は
   `^[A-Za-z0-9_-]{1,128}$` に適合するものだけを受理し、適合しないものは「見つからない」ではなく
   **明示的に拒否**する（理由コードを分ける）。あわせて解決後の絶対パスが対応する root
   （claudeProjectsRoot / codexSessionsRoot）配下にあることを `resolve` 後に強制する。
   一方を他方の代替にしない。`findClaudeSessionDir` は `join(dir, id + ".jsonl")` を組み立てるため、
   形式検証だけでは将来の別呼び出し元から境界外へ抜けられる。
   本エンドポイントは tailscale 経由で外部から到達しうるため、任意 `.jsonl` 読み出しは実害である。

3. **redaction は直列化後の最終文字列に対して行う**。`redactJsonStrings` は値のみを走査し
   object key を素通しするため、key に入った秘匿値は `JSON.stringify` で応答へ出る。
   したがって entry の text は truncate 前に**最終文字列全体**へ `redactText` を適用する。
   パース失敗行・非オブジェクト行の raw 経路にも同じ適用順序を保つ。

4. **ページングは行範囲指定**。`after` / `before` / `limit` を取り、既定は tail 200。
   `limit` は 1..1000 を強制し範囲外は 400。`after` と `before` の同時指定は拒否。
   全文一括返却は行わない。`taskId` と session の所属を照合する。

5. **snapshot 一貫性**。行番号の算出と本文の抽出は同一 snapshot（同一 fd / inode / 固定 size）に対して行う。
   走行中セッションでは未改行の末尾行が後から確定するため、size を跨いだ2回の独立読取は
   `after` が確定済み行を恒久的に飛ばす原因になる。末尾未確定行（`endsWithNewline` が偽の最終行）は
   取得済みに数えない。

6. **サイズ上限は UTF-8 バイト数で定義する**。UTF-16 code unit 数で数えない
   （日本語・絵文字で実バイト量が上限の3〜4倍になる）。

7. **常に 200 を返す**。ログ未検出・未生成・設計上ログを持たない起動（`--ephemeral` 等）は
   `found: false` と理由コードで区別して表す。理由コードは推測せず、判定不能なら unknown を明示する。

8. **クライアント側の直列化**。session 切替・close で進行中の poll と過去方向読み取りを必ず打ち切り、
   entries / cursor / in-flight ガードを同時にリセットする（別セッションのログ混入を禁ずる）。
   初回 tail 取得が完了するまで incremental poll を開始しない。ポーリングは走行中セッションのみ、
   タブ可視時のみ行う。

9. **1レスポンスは JSON envelope 全体で 8MiB 以下**。上限は
   `Buffer.byteLength(JSON.stringify(body), "utf8") <= 8 * 1024 * 1024` と同値に判定し、
   `entries[].text` の合計だけで近似しない。field名・引用符・escape・配列区切りを含む最終レスポンス
   全体を数える。上限到達時も HTTP 200 を維持し、entryまたはUTF-8文字の途中では切らない。
   `after` は指定行の直後から最古側の**連続prefix**、`before` と初回tailは指定境界に最も近い
   最新側の**連続suffix**だけを返す。返さなかった行を跨いでcursorを進めず、`startLine` / `endLine` は
   実際に処理済みとした連続物理行範囲、`hasMoreBefore` / `hasMoreAfter` は未返却範囲を表す。
   空行は従来どおりentryへ載せないが、budget到達前に走査した空行は物理行cursorへ反映してよい。

10. **raw physical line は改行を除く UTF-8 byte列で 1MiB 以下**。`\n`、またはCRLFの `\r\n` を
    line terminatorとして上限計算から除き、`1 * 1024 * 1024` bytesを超えた時点で、行全体のdecode、
    `JSON.parse`、`redactJsonStrings`、`JSON.stringify`、`redactText`へ渡さない。改行まではbounded memoryで
    読み捨て、その物理行番号を持つ `unparsed: true` のentryを、source由来のprefix / suffix / hash /
    byte列を一切含まない固定placeholder textで返す。placeholderは通常entryと同様にレスポンスbudgetへ
    数え、返した場合はline cursorを前進させる。redaction前のsource断片を「参考表示」してはならない。

11. **1リクエストの累積snapshot readは 64MiB 以下かつ1-pass**。open時に固定したsnapshot sizeが
    `64 * 1024 * 1024` bytesを超える場合は本文を走査せず、従来どおりHTTP 200の
    `found: false / reason: "log-too-large"` を返す。受理したsnapshotの `[0, size)` は同一fdから各byteを
    最大1回だけ読み、行数算出・末尾改行判定・範囲選択・entry候補収集を同じpassで完了する。
    末尾1byte確認のための別readや、`countPhysicalLines` と `collectEntries` の再走査を行わない。
    `stat` 等のmetadata取得はread bytesへ含めないが、別path/fdの内容をsnapshotへ混ぜない。

12. **上限到達は `limitedBy` で機械可読にする**。found responseは
    `limitedBy: SessionTranscriptRawLimitReason[]` を返し、理由語彙は `"response-bytes"` と
    `"raw-line-bytes"` だけとする。重複を許さず、この順序でcanonical化する。どちらにも達していなければ
    空配列。rolling compatibilityのためclientはfield欠落も空配列として扱うが、新実装serverは常にfieldを
    返す。scan上限超過はfound responseを作らず11項の `log-too-large` を使う。clientは各理由を警告として
    表示し、`raw-line-bytes`があっても返却済みの他entryを隠さない。

## 29. スケジュール実行（定期タスク、v0.5）

定期（daily/weekly/monthly）または一回限り（once）でタスクを自動起票する。発火 = 既存の
`createTask(status=ready)` であり、以降は通常の dispatch → worker 自律処理（§10）に乗る。
時刻・日付はすべて **JST** で解釈する。

### 29.1 データモデル（schedules テーブル、migration v5）
- id は `s_` + 16 hex（CHECK 制約）。列: name / enabled / cadence_kind / at_hour / at_minute /
  weekday（weekly のみ・0=日曜）/ day_of_month（monthly のみ・1〜31）/ run_date（once のみ・YYYY-MM-DD）/
  tenant / profile / cwd / prompt / priority / last_run_at / last_task_id（tasks FK）/
  consecutive_failures / auto_disabled_reason / created_at / updated_at
- **cadence と付随列の整合を CHECK 制約で強制**（例: daily は weekday/day_of_month/run_date すべて NULL）
- `computeNextFire(schedule, nowMs)`: JST で次回発火時刻を計算。monthly の短い月は月末に丸める。
  無効化済み・過去日付の once は null（発火予定なし）を返す

### 29.2 scheduler ステージ（tick 先頭・§10）
- 期限到来（`last_run_at` 以降で next fire ≤ now）の enabled スケジュールから、body 先頭 `cwd:` 行 +
  prompt を持つタスクを **status=ready** で生成し、last_run_at / last_task_id を更新。
  claim 競合は「既に claim 済み」として安全にスキップ（多重発火防止）
- **結果の計上**: 発火タスクの終端を監視し、`schedule_task_result_counted` イベントで冪等に1回だけ計上。
  done → consecutive_failures リセット。失敗（blocked 終端等）→ +1、**3回連続で自動 disable**
  （auto_disabled_reason 記録）。復帰は `schedule enable`。24時間を超えて未終端のタスクは stale として
  失敗扱い
- dry-run（apply=false）では起票せず notes に予定を記録。kill-switch: `scheduler.disabled`

### 29.3 CLI
- `hachi schedule create|list|show|enable|disable|delete`。create の必須: --name/--at/--cwd/--prompt +
  cadence 別（weekly=--weekday, monthly=--day, once=--date）。--profile は config.profiles に対して
  作成時検証（§29.5）。list は次回発火（JST）・enabled・連続失敗・auto_disabled を表示

### 29.4 Web
- `GET /api/schedules`（一覧 + computeNextFire による次回発火）/ `POST /api/schedules` /
  `PATCH|DELETE /api/schedules/:id`。write はすべて §31 の共通認可を通す
- `/schedules` 画面: 一覧（name/cadence/次回発火 JST/enabled/last_run/連続失敗/auto_disabled）+
  作成フォーム（cadence 種別で入力欄切替）+ enable/disable トグル + 削除。SPA fallback 登録済み

### 29.5 フォーム入力候補と profile 検証（v0.5.1）
- `KanbanReadView.scheduleFormOptions()` — 過去に使われた cwd（schedules.cwd ∪ task body 先頭 `cwd:` 行、
  新しく使われた順）と tenant（tasks ∪ schedules、昇順）の distinct を返す
- `GET /api/schedule-options` — 上記に config 由来の profiles（name/provider/model/isDefault）を合成して返す。
  web は起動時に loadConfig する（config 不在時は組み込み既定にフォールバック = policy.ts と同一挙動）
- **profile の作成時検証（fail-closed）**: CLI `schedule create` と Web POST/PATCH は profile を
  config.profiles に対して検証し、未知名は即エラー（dispatch まで遅延させない）。空 profile は従来どおり
  defaultProfile に解決されるため許容
- Web フォーム: profile は Radix Select（provider/model を添え書き）、cwd/tenant は自由入力 + datalist 候補

## 30. webwatch — supervisor による web 自己修復（v0.6）

launchd の on-demand-only mode（KeepAlive 自動再起動が保留される既知制約、2026-07-04 実測）への補完として、
長寿命な supervisor が web (§14) を看視し自己修復する。

### 30.1 stage 仕様
- stage `webwatch` を stage 順の**末尾**（notify の後、9番目）に追加
- 毎 tick `GET http://127.0.0.1:9131/healthz`（timeout 3秒）。**2 tick 連続失敗**で
  `launchctl kickstart -k "gui/<uid>/com.hachi-kanban.web"` を実行する
- **apply ゲート**: kickstart の実行は `apply === true` の時のみ。dry-run（--once 等）では
  notes に実行予定を記録するだけで副作用を起こさない
- **クールダウン**: kickstart 実行後 5 分間は再実行しない（クラッシュループ抑止）。抑制中も notes に記録
- kickstart 対象 label は**定数固定**（設定・入力から組み立てない。任意コマンド実行の余地を作らない）
- `-k` を使う理由: health dead 判定後の復旧が目的であり、生きているプロセスの温存より確実な再起動を優先する
  （in-flight を持つ supervisor 本体とは事情が異なる）
- fail-open: healthz 失敗・kickstart 失敗は warn ログのみ（看視が supervisor 本体を壊さない）
- 失敗分類: network error / timeout / non-2xx / invalid body を notes で区別する
- actions の定義: **kickstart を実行した時のみ 1**（失敗検知そのものは notes）
- kill-switch: `$HACHI_KANBAN_HOME/webwatch.disabled`（既存 isDisabled 機構）。
  supervisor-status.ts の stage 一覧（Web パネルトグル）にも追加する
- 実装は factory 形式（fetch/exec/now を DI）とし、テストで実 launchctl / 実 fetch を呼ばない

## 31. web write API の共通認可（v0.6）

tailscale serve 等のリバースプロキシ経由では 127.0.0.1 bind 防御が実質無効化される
（プロキシがローカルから接続するため）。write API を「token の知識」で保護する。read は無認証のまま
（tailnet 境界に委ねる）。

### 31.1 token
- token ファイル: `$HACHI_KANBAN_HOME/web-token`。web 起動時に無ければ 32byte hex を生成
  （`wx` フラグで race-safe。**既存ファイルは絶対に上書きしない**）、mode 0600。
  既存ファイルの mode が 0600 以外なら warn
- token の生値をレスポンス・ログ・エラーメッセージに一切出さない（テストで担保）
- `hachi doctor` は web-token の**パス・存在有無・mode のみ**表示する（値は表示しない）

### 31.2 共通ガード requireWriteAuth()
- 対象: `POST/PATCH/DELETE /api/schedules*` と `POST /api/supervisor/*`（kill-switch トグル）。
  **今後追加される write API もすべてこのガードを通す**
- 検査: ① `Authorization: Bearer <token>` の一致（欠落/不一致は 401）
  ② Sec-Fetch-Site が送られている場合は `same-origin` のみ許可（未送信は許可 — 旧ブラウザ/curl 互換）。
  従来の schedule API と kill-switch API で検査条件が不整合だった点をこの統一仕様に揃える
- SPA は write の 401 を受けたら token 入力 UI（多重表示ガード付き）→ localStorage 保存 →
  **元のリクエストを1回だけ自動リトライ**。以降は常にヘッダを付与する

## 32. 画像アーティファクト（添付とブラウザ確認、v0.6）

外出中でも UI 確認を kanban 上で完結させるため、タスクに画像を添付しブラウザで閲覧できるようにする。
正本は従来どおり **ファイルシステム**（`$HACHI_KANBAN_HOME/artifacts/<taskId>/`、DB 変更なし・列挙は既存の
ディレクトリスキャン）。

### 32.1 添付（CLI）
- `hachi task attach <taskId> --file <path> [--name <保存名>] [--comment <本文>]`
- 検証（fail-closed）: task 存在 / ファイル存在 / 拡張子 allowlist（png, jpg, jpeg, webp, gif, txt, md, log）/
  サイズ上限 10MB / 保存名は `[A-Za-z0-9._-]+` のみ（既定は basename を sanitize。衝突時は `-2` 等の連番付与）
- `--comment` 指定時はタスクへコメントを1件追加し、本文末尾に添付ファイル名を記す（閲覧導線）

### 32.2 配信（web）
- 既存 `GET /task/:id/artifact/:name` を拡張: 拡張子が画像（png/jpg/jpeg/webp/gif）なら
  **バイナリ + 正しい Content-Type + `X-Content-Type-Options: nosniff`** で返す。
  それ以外は従来どおり text（redactText 適用）
- 既存の fail-closed 検証（taskId 形状 → task 存在 → readdir 完全一致 → resolve 後 containment）を
  そのまま通す（緩めない）。read 系のため認可は §31 の対象外（tailnet 境界）

### 32.3 表示（UI）
- ArtifactsCard: 画像 artifact は**インラインサムネイル**（max-h 制限・object-contain）で表示し、
  クリックで新規タブ原寸表示。テキスト artifact は従来どおりインラインテキスト
- モバイル幅（402px）・ダークモード両対応
- 配置・グルーピング・絞り込みは §32.5 が上書きする（2026-09-03）

### 32.4 運用
- オーケストレーターは統合時のスクショ判定画像を attach してタスクに残す（ユーザーは外出先から
  詳細画面で確認できる）。ワーカーにも body で保存先を指示できる（sandbox 制約がある場合は
  オーケストレーターが代行添付する）
- **worker prompt の恒常案内**: buildWorkerPrompt は本文の後に「成果物の画像添付」節を恒常的に含める。
  内容: ①画像/ファイルをユーザー確認用に残す場合は
  `cd <repo>/packages/cli && pnpm run --silent hachi task attach <taskId> --file <path> --name <名前>` が使える
  ②attach が sandbox 等で失敗したら作業ディレクトリ直下に `ui-*.png` 等で保存し handoff summary に明記する
  （オーケストレーターが代行添付）③撮れない/不要なら省略してよい。
  rework プロンプト（buildReworkPrompt 等）にも同節を含める。レビュアー prompt には含めない（read-only のため）

### 32.5 帰属付き一覧・run 単位のグルーピング・配置（2026-09-03）

動機: 複数 worker をまたぐタスクでは画像が 10 枚以上になり、右カラム（固定幅 420px）では縦長になる。
ユーザーの関心は「最後の worker が添付した数枚」であり、誰がいつ添付したかを run 単位で見たい。

- **API（additive）**: `GET /api/task/:id` は既存の `artifacts: string[]` を残したまま `artifactDetails: ArtifactEntry[]` を
  追加する。`ArtifactEntry = { name, kind: image|text, sizeBytes, attachedAt, attachedAtSource: event|mtime,
  runId: number|null, sessionId: string|null, role: worker|reviewer|rework|orchestrator|human|unknown,
  attributionSource: event-run|filename-session|interval|none }`。**DB 変更なし**（§32 冒頭）: 列挙はディレクトリスキャン、
  `stat` の mtime と既存の `events` / `runs` の結合はこの規則の範囲内。
- **帰属の解決順（サーバ側の純関数。順に試し、最初に決まったものを採る）**:
  1. `artifact_attached` event（payload.name が一致。複数あれば最新）が `runId` / `sessionId` を持てば **event-run**。
     `attachedAt` は event の created_at。role は run の meta.role（reviewer）/ rework run / worker、event の actor が
     orchestrator / human なら run の外として `orchestrator` / `human`
  2. ファイル名 `<prefix>-<sessionId>-<hash8>.txt`（§9 の命名。prefix = prompt / transcript / transcript-full /
     transcript-review）から sessionId を取り `task_runs.session_id` に一致すれば **filename-session**。
     `prompt-review` / `prompt-rework<N>` は id が nonce なので該当しない
  3. `attachedAt`（event があれば created_at、無ければ mtime）が `task_runs` の `[started_at, ended_at ?? now]` に入る run が
     あれば **interval**（複数なら開始が最も遅い run）
  4. いずれも無ければ **none**（帰属不明）。常に末尾に置き、既定で折りたたむ
- **表示（ArtifactsCard）**: TaskDetailView の**左カラム最下段**（CommentsCard の下）へ移す。右カラムは
  fields / model / routing / events / links のまま。グループは run 単位（run 1 つ = session 1 つなので「ワーカーごと」と
  「セッションごと」は同じ軸）で、**新しい run が先頭**、グループ内も `attachedAt` の新しい順。グループ見出しは
  role バッジ・run id と session id の短縮・provider/model（run meta にあれば）・時刻範囲・件数。**最新グループだけ
  既定で展開**し、他は折りたたむ（Collapsible）。各項目は `attachedAt` の絶対時刻（§37 の `formatTimestamp`）と
  相対時刻、size を出す。画像はグリッドを `sm:2 列 / xl:3 列` にし、サムネイルの max-h と新規タブ原寸は §32.3 のまま。
- **絞り込み（セグメンテッドコントロール）**: `すべて` / `最新の run` / `画像のみ`。§37.6 に従い shadcn の
  `Collapsible` と `ToggleGroup`（Radix）を `components/ui/` へコピーインして使う（素の div/button で自作しない）。
- **CommentsCard も同じ規則**: コメントを `created_at` の interval で run に帰属させ（`agent.message.v1` は
  `from.sessionId` を優先）、run の外（orchestrator / human）は `run 外` グループ。新しい run が先頭、最新だけ展開、
  同じセグメント（`すべて` / `最新の run` / `メッセージのみ` = agent.message ブロックを含むコメント）。EventsCard は対象外。
- **証跡**: リポジトリに Playwright / Storybook は無い。worker は jsdom（RTL）の focused test までを納め、
  402px / 1440px × light / dark のスクリーンショットと console 0 の確認は**オーケストレーターが host-finalize で撮って
  attach する**（§32.4 / reference §1.5 step 7）。worker に実ブラウザ evidence を求めない。
- 実装順: W0 attach event に run/session を記録（cli+core）∥ W1 API `artifactDetails` と帰属モジュール → W2 ArtifactsCard
  （配置・グルーピング・絞り込み・ui プリミティブ）→ W3 CommentsCard。

## 33. supervisor watchdog — heartbeat + 独立監視 + doctor 拡張（v0.7）

背景: launchd の GUI ドメインが on-demand-only mode に入ると KeepAlive/RunAtLoad の自動再起動が
保留される既知制約（§30 と同根、runbooks/supervisor-launchd-setup.md）。webwatch は web を監視するが、
supervisor 自身を監視する者がいない。デーモン停止＝全自動化の静かな停止を防ぐ。

### 33.1 heartbeat
- supervisor は起動直後および毎 tick 完了時に `$HACHI_KANBAN_HOME/state/supervisor-heartbeat.json` を
  原子的に書く（tmp へ書いて rename）。内容: `{ ts: epoch秒, pid, tickCount, intervalSec }`
- 書き込み失敗は warn ログのみで tick は継続する（heartbeat は可観測性であり統制ではない。
  DB には触れない）

### 33.2 watchdog（独立 LaunchAgent）
- 実体: `scripts/hachi-watchdog.sh` + `runbooks/templates/com.hachi-kanban.watchdog.plist`
  （KeepAlive + プロセス内部ループ。§30 と同じ流儀で StartInterval に依存しない）
- 60秒毎に heartbeat の鮮度を検査し、閾値（既定 180秒、env `HACHI_WATCHDOG_STALE_SEC`）超過で
  `launchctl kickstart -k gui/<uid>/com.hachi-kanban.supervisor` を実行し、osascript で macOS 通知を出す
- kickstart 後は 600秒のクールダウン（連続 kickstart ループ防止）
- kill-switch: `$HACHI_KANBAN_HOME/watchdog.disabled` の存在中は検査を skip（ループは継続）
- watchdog は supervisor の内部状態・DB に依存しない純 shell（配管を見張る配管）。
  heartbeat ファイルが存在しない場合は「未稼働」として同様に kickstart 対象とする

### 33.3 doctor 拡張
- `hachi doctor` に2検査を追加する:
  1. **supervisor heartbeat**: state ファイルの存在と鮮度（既定 300秒以内）。欠如/陳腐化は NG
     （メッセージに最終 ts と経過秒を表示）
  2. **web healthz**: `GET http://127.0.0.1:<port>/healthz`（timeout 3秒）が `{ok:true}` を返すこと。
     port は env `HACHI_KANBAN_WEB_PORT`（既定 9131）
- いずれも `--offline` では skip する（--offline の意味を「bridge 検査に加えローカル外形監視も skip」に拡張。
  一時 HOME でのテスト/e2e スモークを壊さないため）

## 34. adapter 信頼性 — GET リトライ・worker stop・max 実行時間・tick 観測（v0.7）

前提の確認: bridgeFetch には既に 10 秒の AbortSignal timeout があり（§12 系）、bridge 呼び出しは有界。
本節は「有界だが脆い」箇所（瞬断の即 block 化・止められない worker・観測不能な tick）を補強する。

### 34.1 GET リトライ（bridge）
- 副作用の無い bridge 呼び出し（GET /api/status・GET /api/messages・healthCheck）は、
  network/timeout/5xx 失敗時に最大2回まで指数バックオフ（500ms → 1500ms、±20% jitter）で再試行する
- POST /api/prompt（launch/inject）は副作用があるため自動再試行しない（at-most-once 維持、§12.10-1 と同根）
- 認可失敗（401/403）・policy 違反（リダイレクト・非 loopback）・4xx は再試行しない（fail-closed 即時）
- **POST の client timeout は「失敗」ではなく「不定」として扱う**（2026-08-31 実害。§13.1 と対）。
  「自動再試行しない」は「起動していないと見なしてよい」を意味しない。timeout で throw した launch を
  `auto-launch-failed:` のような **dispatch の自動 retry 対象**の block reason へ落とすと、
  生きている session があるまま2本目が同じ worktree へ起動する（2 tenant・3 タスクで観測）
- **不定は `needs-manual: launch-indeterminate:`（自動 retry 対象外）で block する。**
  判定は `BridgeError.kind === "timeout"` だけで行い、**message 文字列の照合はしない**。
  worker（dispatch）・reviewer・rework の**3つの catch site すべて**に適用する
- **不定経路では runtime resource の cleanup request を作らない。** 生きている session が
  その resource を握っている可能性があり、cleanup は不定を確定に変えてしまうため
- **不定で block した task には run が存在しない。** run は `launch()` が成功して初めて作られる
  ため、timeout 経路では worker・reviewer・rework のいずれも run 行を残さない。
  したがって **`task await` はこの task についてそれ以上発火せず、外部 session が idle へ落ちても
  board 側には何のイベントも起きない**。回収は観測しに行く側の責務である
- **候補 session の不在は「起動していない」ことの証明ではない。** timeout した POST が
  まだサーバ側で処理中でありうるため、`GET /api/sessions` の1回のスナップショットを
  解放ゲートに使ってはならない（§13.1 の「判断材料であって判定ではない」と同根）。
  **確実な判定には server 側の launch idempotency key が要るが、現時点で存在しない**
- **timeout event は観測値を durable に残すようになった**（C-1-b。2026-08-31 実装・統合済み /
  main=`16555e5`。`packages/supervisor/src/stages/launch-outcome.ts` の
  `probeIndeterminateLaunch`）。**event 名は catch site ごとに異なる**ので、
  役割で引き分けること（1つの名前で grep すると3経路のうち2つを取り逃がす）:

  | catch site | event 名 | probe 以外の payload |
  |---|---|---|
  | worker（dispatch） | `launch_indeterminate` | `error` / `source: "launch"` |
  | reviewer | `reviewer_launch_indeterminate` | `error` |
  | rework | `rework_launch_indeterminate` | `error` / `attempt` |

  **3経路に共通するのは次の probe 6項目**である。

  | key | 内容 |
  |---|---|
  | `attemptedAt` | launch を試みた時刻（ISO8601） |
  | `probeCwd` | `realpathSync.native` で canonical 化した cwd。取得失敗時 `null` |
  | `probeProvider` | 解決済み provider |
  | `candidateSessions[]` | `id` / `status`（`idle` \| `busy`）/ `timestamp` / `startedAfterAttempt` |
  | `probedAt` | 照会を行った時刻 |
  | `probeError` | 照会自体が失敗した場合の redact 済みメッセージ。成功時 `null` |

  `startedAfterAttempt` は session の `timestamp` が `attemptedAt` 以降かの三値
  （`true` / `false` / **不明は `null`**）である。**timestamp 欠落・parse 不能を `false` へ丸めない。**
  probe は **read-only の照会であり、判断を一切加えない**（`GET /api/sessions` を
  canonical cwd + provider で引くだけ）。
  - **未記録の項目が1つ残る: bridge endpoint。** payload に serverUrl 相当は載っていないため、
    **複数 bridge を運用している場合、どの endpoint への launch だったかは event から決まらない**
- **観測できるようになったが、判定できるようにはなっていない。**
  `candidateSessions` は**候補**であって当該 launch の session ではない。
  上の「候補 session の不在は証明ではない」はそのまま生きており、
  加えて **`startedAfterAttempt: true` の session が当該 launch のものである保証も無い**
  （同一 cwd + provider へ別経路から起動された session を拾いうる）。
  **確定判定には server 側の launch idempotency key が要り、これは未実装である**
- **不定経路は orchestrator request を作らない。** 3つの catch site はいずれも
  block と event を作るだけである。したがって **`hachi orchestrator escalate` は使えない**
  （`<request-id>` と claim token を要求するため）。`task await` も発火しない（run が無い）ので、
  **この block に対する durable な自動伝達路は存在しない**。回収は human queue の
  「オーケストレーター回収待ち」レーンを一巡して見つけるほかない
- **したがって不定からの回収は、依然として escalation のみが正しい**。
  payload は**エスカレーションに添える観測材料**として使う。
  launch idempotency key が入るまで、**`candidateSessions` を根拠に re-ready する手順を
  運用側に置かない**（誤認した session の `idle` を根拠に再起動すると、
  C-1-a が消したはずの重複起動が別経路で戻る）
- 回収（不定から抜ける手順）は運用側の規律であり、playbook §1.4 の
  `needs-manual: launch-indeterminate` の行を正本とする

### 34.2 worker stop
- `WorkerAdapter.stop?(ref): Promise<StopResult>`（types.ts）。optional だが **direct 系は必須実装**
- DirectCodexAdapter / DirectClaudeAdapter: state ファイルの pid へ SIGTERM → 最大5秒待機 → 残存時 SIGKILL。
  送信前から消えていれば already-exited（**§34.2.2 完了までは多義。§34.2.1 参照**）。
  停止後も exit ファイルが無い場合がある。
  **run close の主体と順序は §57.4 が正本であり、本節の「monitor が run close を担う」は
  §57.4 により置換済み（非規範）。** 本節から直接 close してはならない
- bridge 系 adapter: bridge API に停止経路が無いため `{ stopped: false, reason: "unsupported" }` を返す
  （throw しない。「経路が無い」ことの正直な報告）
- `StopResult` は `stopped` と `reason` の組合せを discriminated union で固定する（§34.2.1）。
  **成功2値（`terminated` / `killed`）だけが `stopped: true`。残る4値は `stopped: false`**

#### 34.2.1 停止の観測（signal 送信を停止の証拠にしない）

**「シグナルを送れた」ことは「停止した」ことの証拠ではない。** また **EPERM は
「停止した」でも「生きている」でもなく「観測も送信もできない」である。**
本節はこの2つを別々の事実として `StopResult` に表す。

**`stopped` は「この呼び出しが実際に停止させたか」である**（既存実装の意味を変えない）。
成功2値・失敗4値であり、**`already-exited` は `stopped: false`** に留める。

| reason | stopped | 何を観測したか |
|---|---|---|
| `terminated` | true | SIGTERM 後に group の**消滅を観測した** |
| `killed` | true | SIGKILL 後に group の**消滅を観測した** |
| `already-exited` | false | この呼び出しでは停止させていない。**停止済みか不明かを区別できない多義値**（§34.2.2 完了まで。下記） |
| `unsupported` | false | 停止経路そのものが無い（bridge 系） |
| **`unsignalable`** | false | **EPERM 等で観測も送信もできなかった。停止したかは不明** |
| **`kill-unconfirmed`** | false | **SIGKILL は送れたが、group が依然として観測可能で生存している** |

**`stopped: false` は「停止していない」を意味しない。** それが表すのは
「**この呼び出しは停止させていない**」だけである。`already-exited` は
**停止済みか不明かを区別できない多義値**（§34.2.2 完了まで。下記）、
`unsignalable` は停止したかが不明、`kill-unconfirmed` は生存を観測している。
**停止したかの判断に `stopped` 単独を使わず、必ず `reason` を見る。**
この曖昧さ自体の解消は §34.2.2 で扱う。

##### 実装規則

- `isProcessGroupAlive` と `killProcessGroup` は **EPERM の解釈を一致させる**こと。
  片方が「生存」と判定し、もう片方が throw する状態にしてはならない
  （2026-08-21〜25 の direct テスト flake `Error: kill EPERM` の正体。
  本番の stop 経路にも同じ穴があり、`stop()` が StopResult を返さず例外で落ちる）
- signal エラーは3分類する: **`gone`（ESRCH）/ `unsignalable`（EPERM）/ `fatal`（その他）**。
  分類は両関数が共有する1つの classifier で行う
- `killProcessGroup` は **`unsignalable` で throw してはならない**（`fatal` のみ throw）。
  かつ**呼び出し元が `sent` / `gone` / `unsignalable` を識別できる戻り値**を返すこと。
  throw しないだけでは、送れたのか送れなかったのかが区別できない
- **生存観測の tri-state（`alive` / `gone` / `unobservable`）は本節で導入する。**
  ただし**導入範囲は `direct-process.ts` 内部と、その DI 注入面までに限る**。
  公開 API の改名・他パッケージ（`monitor.ts` / cli の同名 `TmuxLauncher.isProcessGroupAlive` 等）の
  移行は §34.2.2 で行う。既存の boolean 呼び出し元は
  **`gone` のみ false、`alive` と `unobservable` を true に写す**アダプタで互換を保つ。
  **`unobservable` を false に写してはならない。** `monitor.ts` は false を
  「process tree 不在」と解釈して durable cancel を作るため、EPERM を false に落とすと
  **leader 消滅かつ group が EPERM のときに誤った stall/cancel が発生する**
  （現行は EPERM を生存扱いにしているため起きていない。向きを間違えると
  「実装後だけ悪化する」）。`monitor` 自体の tri-state 化は §34.2.2 で行う
  （**`"gone"` は truthy なので単純な文字列置換をしないこと**）
- **SIGTERM / SIGKILL の送信時に `gone`（ESRCH）が返った場合は `already-exited`
  （`stopped: false`）を返す。** ESRCH はシグナルが**届いていない**ことを意味するので、
  「この呼び出しが停止させた」とは言えない。`terminated` / `killed` は
  **送信が成功し、その後に消滅を観測した**場合だけである
##### 観測状態の遷移表（各 phase で何を返すか）

`obs()` は §34.2.1 の tri-state 観測、`send(sig)` は `killProcessGroup` の結果
（`sent` / `gone` / `unsignalable` / `fatal`）。上から順に評価する。

| phase | 条件 | 次にすること / 返す |
|---|---|---|
| 開始前 | `obs()` = `gone` | **返す**: `already-exited`（stopped:false） |
| 開始前 | `obs()` = `unobservable` | **返す**: `unsignalable`（送る先が観測できない） |
| 開始前 | `obs()` = `alive` | **継続**: SIGTERM phase へ |
| SIGTERM | `send` = `gone` | **返す**: `already-exited` |
| SIGTERM | `send` = `unsignalable` | **返す**: `unsignalable` |
| SIGTERM | `send` = `fatal` | **throw** |
| SIGTERM | `send` = `sent` | **継続**: TERM 後 poll phase へ |
| TERM 後 poll | `obs()` = `gone` | **返す**: `terminated`（stopped:true） |
| TERM 後 poll | `obs()` = `alive` または `unobservable` | **継続**: 期限まで poll |
| TERM 後 poll | 期限到達・poll 中に一度でも `alive` を観測した | **継続**: SIGKILL phase へ |
| TERM 後 poll | 期限到達・`alive` を一度も観測せず `unobservable` のみ | **返す**: `unsignalable` |
| SIGKILL | `send` = `gone` | **返す**: `already-exited` |
| SIGKILL | `send` = `unsignalable` | **返す**: `unsignalable` |
| SIGKILL | `send` = `fatal` | **throw** |
| SIGKILL | `send` = `sent` | **継続**: KILL 後 poll phase へ |
| KILL 後 poll | `obs()` = `gone` | **返す**: `killed`（stopped:true） |
| KILL 後 poll | `obs()` = `alive` または `unobservable` | **継続**: 期限まで poll |
| KILL 後 poll | 期限到達・poll 中に一度でも `alive` を観測した | **返す**: `kill-unconfirmed` |
| KILL 後 poll | 期限到達・`alive` を一度も観測せず `unobservable` のみ | **返す**: `unsignalable` |

**期限到達時の優先順位**: poll 中に `alive` を一度でも観測していれば
「生存していた」を優先する（TERM 後なら SIGKILL へ、KILL 後なら `kill-unconfirmed`）。
`alive` を一度も観測できず `unobservable` だけだった場合のみ `unsignalable` を返す。

- **poll 中の `unobservable` は終端ではない。** poll を継続し、`gone` を観測できたら
  そちらを採る（消滅の観測を優先する）。
  **一方、開始前と送信時の `unobservable` は即座に `unsignalable` を返す**
  （poll する対象がまだ確定していない／送信自体が失敗しているため。上表のとおり）
- poll の間隔と上限は既存の `pollIntervalMs` / `maxWaitMs`（既定5秒）を使う

- **SIGKILL 送信後は必ず再観測する。** 再観測は既存の `pollIntervalMs` 間隔で
  **最大 `maxWaitMs`（既定5秒）まで**行う。消滅を観測できたときだけ `killed`。
  観測できて生存していれば `kill-unconfirmed`、観測できなければ `unsignalable`
  （§57.2 の `cooperative_sent` と同じ規律。送信は停止の証拠ではない）
- **`WorkerAdapter.stop` の全呼び出し元を本節で同時に移行する。** 戻り値を検査し、
  reason を証拠へ残すこと。現在 EPERM は throw されて catch/log されているため、
  **非 throw 化だけを行うと警告ごと消えて「前より悪い」状態になる。**
  **戻り値未検査は合計11箇所**（2026-08-25 実測）。実装前に grep で網羅を再確認すること:
  - `reap.ts` `cleanupReleasedDirectRun`
  - `finalize.ts` の cleanup 呼び出し
  - **`review.ts` の5箇所**（`:1010` / `:1916` / `:1946` / `:2414` / `:2434`）。
    「cleanup 呼び出し」とだけ書くと `:1010` しか指さず、残り4箇所で
    非 throw 化後に警告が消える
  - **`dispatch.ts` の3箇所**（`:2059` / `:2072` / `:2121`。`:2121` は `unsignalable` でも
    `injected: true` を記録している。`:2059` / `:2072` は未移行だと EPERM の具体的警告が消える）
  - **`steward.ts` の呼び出し**
- **`reap.ts` の `run_released.directCleanup` は次のとおり写す。**
  現在は EPERM が throw されるため `false` になっており、**非 throw 化だけを行うと
  無条件 `true` になって監査値が悪化する**。
  - `terminated` / `killed` → `directCleanup: true`
  - `already-exited` / `unsupported` / `unsignalable` / `kill-unconfirmed` → `directCleanup: false`
  - **`already-exited` を true に写さないこと。** 現行実装は state ファイルが読めないだけでも
    この値を返すため、残存 group の有無が不明である（§34.2.2 で分離するまで false 側に倒す）
  - いずれの場合も **`reason` を同イベントへ格納**し、`directCleanup` と矛盾させない

##### `already-exited` は当面多義である

本節の実装後も、`already-exited` は次の3つを区別せずに表す:

1. 開始前の観測で `gone`（＝実際に group の消滅を観測した）
2. SIGTERM / SIGKILL の送信で ESRCH が返った（＝送信時点で消滅していた）
3. **state ファイルが読めなかった**（現行実装。group の有無は不明）

3 は消滅の証拠ではない。**この分離は §34.2.2 で行う。**
それまでは `already-exited` を「停止済みの証拠」として扱う消費側を新設しないこと
（`directCleanup` を false 側に倒しているのはこのため）。

##### 本節が定めないこと（§34.2.2 で扱う）

本節は **`StopResult` の意味と生成規則だけ**を定める。次は**本節では変更しない**:

- **停止証拠の記録先と run close の順序**（§57.4 が正本。§34.3 の記述もそちらに従う）
- **`already-exited` の意味**。現行実装は state ファイルが読めないだけでも
  `already-exited` を返しており、これは group 消滅の観測証拠ではない。
  この分離は §34.2.2 で行う
- **`unsignalable` のときに run を close してよいか**（§51.1 の best-effort cleanup と
  active run の durable cancel で答えが違う）
- **永続 EPERM のときの再試行・上限・エスカレーション経路**
- **生存観測 tri-state の「公開 API 改名と他パッケージ（`monitor.ts` / cli 等）の移行」**。
  `direct-process.ts` 内部と DI 注入面への導入は §34.2.1 で行う（繰り延べるのは移行範囲だけ）

#### 34.2.2 停止証拠と close 順序の再調停（未着手・設計タスク）

§34.2.1 の実装後に、次を1つの設計として調停する。**着手前に本節を確定させること。**

1. `already-exited` を「実際に `gone`（ESRCH）を観測した」場合だけに限定し、
   state 不明は別値（例 `state-unknown`）とする。現行は `cancel.ts` が
   `already-exited` を `already-stopped` かつ process tree 不存在の証拠として扱っており、
   **state が読めないだけで残存プロセスがいても gate が解除される**
2. `stopped: false` のときの run close 可否を、**active run の durable cancel（§57.4）**と
   **自然終端後の残留掃除（§51.1 best-effort）**で分けて定める
3. 永続 EPERM の再試行権限・上限・backoff・回復手段。現行は失敗ごとに
   新しい fence/request を作れ、`cancel-failure:<id>` が無制限に増える
4. 生存観測を `ProcessGroupObservation = "alive" | "gone" | "unobservable"` へ移行する
   対象パッケージと各値の分岐（`"gone"` は truthy なので単純置換は論理を反転させる）。
   同名の別 API である `TmuxLauncher.isProcessGroupAlive`（cli）が対象かも明示する
5. §34.2 本文（書き換え済み）と §34.3（1〜2を打ち消し済み）の記述を、
   §57.4 の現行仕様として正式に書き直す。あわせて **§51.1 の
   「§34 max-runtime の stop が direct で発火」という参照**と、
   §34.3 の「恒久リーク防止・inFlight 枠解放」を §57.4 に合わせる
   （停止未確認時に意図的に gate を維持する §57.4 と現在は食い違っている）
6. **`task.ts` の direct restart 経路**（`reason === "already-exited"` だけで run を close して
   再投入している。`stopped` を見ていない）。`already-exited` の意味が変われば同時に直す
7. **`cancel.ts` の direct `idle` を自然停止の強い証拠として扱う経路**。
   `idle` は leader / state 中心の観測であり、**child process group 消滅の証拠ではない**。
   孫プロセスが残っていても natural-close してしまう
8. **child process tree の消滅を何をもって証拠とするか**の定義。
   上記6・7・`cancel.ts` の `already-exited` 解釈は同じ問題の別の顔であり、
   個別に直すと再び食い違うため1つの設計として調停する

### 34.3 max 実行時間（monitor 強制回収）
- config `resourceGuard.maxRunSeconds`（optional、既定 7200）。zod で正の整数のみ許可（fail-closed）
- **1〜2は §57.4 により置換済み（非規範）。3 も下記の現行形へ置換する。いずれも歴史的記述として残す。**
  現行の monitor は上限超過を検知しても直接 close せず、**durable cancel request を作るだけ**である
  （`monitor.ts` / `review.ts` は §57.4 側へ移行済み。stop 証拠の記録と run close は cancel stage が行い、
  `run_stop` イベントは生成しない）。max-runtime の現行仕様は §57.4 を読むこと。
  1. ~~adapter.stop があれば呼ぶ（結果を `run_stop` イベントに記録）~~
  2. ~~open run を failed で close し、タスクを `needs-manual: max-runtime exceeded (<経過秒>s)` に付替~~
  3. ~~bridge 実行はセッション自体を止められないため、その旨を needs-manual 理由に含める~~
     → **現行形**: bridge も `session-stop-v1` を広告し得るため「bridge は常に停止不能」ではない。
     停止不能・停止未確認の場合は **`needs-manual` へ遷移させず gate を維持し、
     §57.3 の durable escalation を行う**。その際
     **session が継続している可能性を escalation の証拠へ含める**。
     **taxonomy は §57.3 の `ExactSessionStopResult`（`unsupported` / `rejected` / `unknown`）が正本**であり、
     §34.2.1 の `StopResult` はその内訳を表す:
     - `unsupported` → `unsupported`
     - **`unsignalable` / `kill-unconfirmed` → `unknown`**（direct 側の内訳）
     - `rejected` / その他の `unknown` は bridge 側で発生する。
       §34.2.1 は direct の内訳だけを細分化しており、bridge の分類を置き換えない
- 目的は §12.6-1 と同型の恒久リーク防止（inFlight 枠の解放）。reviewer run も同一ルールとする

### 34.4 tick 観測
- runTick はステージごとの所要 ms と tick 全体の所要 ms を計測し、info ログ（fields）に記録する
- 閾値超過の warn・メトリクス永続化は将来課題（別タスク）とし、本節はログ記録までを契約とする

## 35. effort 伝搬 — profile → direct 実配信（v0.7）

### 35.1 語彙
- `EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"`（types.ts、閉じた union）
- 実機根拠（2026-07-05 確認）: codex は `codex exec -c model_reasoning_effort=<v>`、
  claude CLI は `--effort <low|medium|high|xhigh|max>` を受理する。
  語彙に含まれることは全modelの対応証拠ではない。`max`は§59/§67のmodel/runtime別policyで
  明示対応された場合だけ配送する（"minimal"は契約語彙に含めない）

### 35.2 profile / 解決
- `ProfileEntry.effort?: EffortLevel`（optional。未指定は「各 CLI の既定に任せる」= 何も渡さない）
- zod は閉じた enum で検証（不正値は config 読込時に throw、§7 の fail-closed と同じ）
- `resolveModel` は解決に使った profile の effort を `ModelResolution.effort` として返す。
  **model_override は model のみを上書きし effort には影響しない**（effort は profile 専属、v1）

### 35.3 配信
- dispatch は worker/rework の解決値を `LaunchOptions.effort` に渡す。review ステージは§67の
  reviewer role解決を使い、reviewer overrideをreworkへ伝播させない
- DirectCodexAdapter: `-c model_reasoning_effort=<effort>` を起動スクリプトに付与
  （値は閉じた enum のため quoting 安全。既存の model 注入と同じ流儀）
- DirectClaudeAdapter: `--effort <effort>` を付与
- bridge 系 adapter: runtime が `effort-passthrough-v1` を広告し、かつ passthrough を要求された場合に
  限り `/api/prompt` の body へ載せる（§49.4）。運べなかった場合は
  `SessionRef.effortDelivery = "none"` を記録する（modelDelivery と同型の「無視を隠さない」原則）。
  direct 系は常に "native"
- **passthrough の合成**: adapter 固有の要求と呼び出し側の `bridgePassthrough` は**併合**する。
  片方で他方を上書きしてはならない。上書きすると dispatch / review が resolution から組み立てた
  effort / speed のフラグが落ち、実配送されないまま `bridge_native_missing` で run が止まる
- dispatch と review ステージは run.meta に effort / effortDelivery を記録する（web 表示は任意）
- **model の native 配送は常に要求する**（2026-08-21〜）。effort/speed は「省略時は runtime default へ
  委譲する」が、model に省略は無く profile 由来でも必ず解決されるため、実配送が native でなければ
  起動を通さない（`bridge_native_missing` で block + セッション中断）。task override があるときだけ
  検査する形では、runtime が指定を黙って無視して既定モデルへ落としても検知できなかった

## 36. hachi board の human_queue 表示 + tenant 絞り込み（v0.7）

- `hachi board [--tenant <t>] [--json]`:
  1. 状態別件数（現行どおり）
  2. 自律進行中一覧（現行どおり）
  3. **要対応（human_queue）一覧を追加**: blocked のうち block_reason が §6 の human 系 4 prefix
     （user-decision: / user-feedback: / review-required: / needs-manual:）で始まるもの。
     id / priority / reason 先頭 / title を表示する
- `HUMAN_QUEUE_PREFIXES` は core（readview.ts）の export 定数を唯一の定義とし、
  supervisor(notify) / cli(board) はこれを import する（三重定義の禁止）
- Web は human_queue を対応主体で2レーンに分離する。user-decision/user-feedback は「あなたの判断待ち」、
  review-required/needs-manual/auto-launch-failed/未知 prefix は「オーケストレーター回収待ち」。
  `humanQueue` API フィールドは後方互換の合算として残し、`humanDecisionQueue` /
  `orchestratorRecoveryQueue` を追加する
- `--tenant` 指定時は件数・一覧とも該当 tenant のみに絞る
- `--json` は既存 board --json の形状に `humanQueue` 配列を追加する（後方互換）

## 37. UI 刷新 — Linear 風ミニマルデザイン（v0.8）

MaterialM トーンから、Linear 風のミニマルで密度の高い UI へ刷新する。既存機能・ルート・API は不変更
（見た目とレイアウトシェルのみ）。ライト/ダーク両対応を維持する。

### 37.1 デザイントークン（基盤）— パレット F「Cool Gray × Forest」（2026-07-06 ユーザー選定・v0.8.1）
- **セマンティックトークン方式**: styles.css に CSS custom properties（`:root`=light / `.dark`=dark）を
  定義し、Tailwind v4 `@theme inline` で `--color-<名>: var(--<名>)` にマップして `bg-canvas` 等の
  ユーティリティで使う。コンポーネントに生の色クラス（zinc-*/indigo-* 等）を直書きしない
- **light**: canvas #FBFCFB / surface #FFFFFF / line #E2E8E6 / ink #374140 / ink-muted #6B7876 /
  accent #2F9E77（hover/text 濃 #25795C・soft 背景 #E9F5F0）
- **dark**: canvas #090A0A / surface #101312 / line #222826 / ink #C9CECC / ink-muted #899490 /
  accent #2F9E77（text 淡 #6CC9A8・soft 背景 rgba(47,158,119,.15)）
- **ステータス**: 成功はアクセントと同族の緑に統一（light soft #E9F5F0/文字 #25795C、dark soft
  rgba(76,183,138,.13)/文字 #7BD4AE）= 色数最少化。警告 light #FDF3E2/#B57816・dark
  rgba(242,201,76,.13)/#F2C94C。危険 light #FDEEEE/#C53030・dark rgba(235,87,87,.13)/#F19999。
  レビュー工程バッジは紫系維持（light #F0EBFA/#8B5CF6・dark rgba(139,92,246,.15)/#C4B5FD）
- カードは **フラット化**: shadow 廃止 → 1px 境界 + rounded-md。カード内 padding は p-3
- タイポ: 本文 text-sm 基調、見出し text-sm font-semibold、等幅は既存踏襲
- フォーカス可視化: focus-visible ring をアクセント（#2F9E77）で統一
- supervisor 稼働ドットの緑もアクセント族に揃える。ライブビューの端末調（黒背景）は不変更

### 37.2 アプリシェル（単一行ヘッダー + パンくず）
- 全画面共通の AppShell ヘッダー **1行・高さ 48px**: 左=**柴犬ロゴ + ワードマーク**（board へ）+ **パンくず**
  （例: `hachi / board`、詳細: `hachi / board / t_xxx…`、`hachi / sessions / <session>`）、
  右=検索（デスクトップはインライン入力、モバイルはアイコン→ポップオーバー。既存 Toolbar の検索を統合）+
  ナビ（sessions / トップのみ人間への確認 / その他 / supervisor ドット）。「その他」は全幅で
  metrics・usage・knowledge・schedules・settingsとテーマ選択を一つのPopoverへ集約する。
  項目選択で閉じ、テーマはライト/ダーク/システムのradio選択とし選択後も開く。
  既存md境界を維持し、狭幅は確認/その他をaccessible name付きアイコンにする。
  メニューは内部スクロールと画面端回避、Escape時のトリガーへのfocus復帰を備える。
- **counts バーはヘッダーから撤去**（ファーストビュー優先度の回復）。件数はボード各レーンのヘッダー数字に
  委譲し、全体 counts は supervisor パネル内へ移す
- 詳細/一覧系画面の**コンテンツ内「← board」等の戻るリンクは全廃**（パンくずが唯一の上位導線）
- supervisor バッジは状態ドット（緑/灰/赤）のアイコンボタンに縮小。クリックで既存パネル
- **ロゴ（2026-08-20 追加）**: ワードマーク左に favicon と同一の canonical SVG（`packages/web/public/icons/
  shiba.svg`）を `<img src="/icons/shiba.svg">` で置く。ワードマーク「hachi」は**残す**（ロゴは識別性の
  補強であって置換ではない）。単色アクセント `#2f9e77` はライト/ダーク共通のためテーマ分岐は不要。
  SVG 本体は `icon-assets.test.ts` が path データの sha256 と使用色を固定検証しているため編集禁止。
  配信は app.ts の固定 allowlist（`PUBLIC_STATIC_ASSETS`）にリテラルパスとして追加する

### 37.3 余白と密度
- ページ外側余白: モバイル px-2・sm 以上 px-4（現 px-6 から縮小）。ボードのレーン列はビューポート幅を
  最大限使う。カード左右余白と外側余白の**二重取りを解消**
- レーン: 幅 288px（モバイル min(85vw,320px) 維持）、レーン間 gap-3、カード間 gap-2
- タスクカード: タイトル 2行 clamp・メタ（id/tenant/優先度/経過）は1行の小さな行に集約。
  ボードのカード本文プレビューは 2行 clamp（常時全文を出さない）

### 37.4 ボードのファーストビュー優先度
- 上から: ヘッダー(48px) → レーン列（即コンテンツ）。tenant/バケットのフィルタは検索ポップオーバー内に統合
  （デスクトップも同様のフィルタボタン化。常時表示しない）
- 要対応レーンは先頭固定 + 赤アクセント維持（薄く）。空レーンは折りたたみ表示（タイトル+0のみ）

### 37.5 適用範囲
- board / task 詳細 / sessions（一覧・ライブ）/ schedules の全画面に §37.1-37.4 を適用。
  ライブビューの端末調（黒背景）は維持しつつ、周囲のシェル/カードを新トーンに合わせる

### 37.6 コンポーネント実装規約（恒久ルール、2026-07-06〜）
UI コンポーネントは **shadcn/ui + Radix UI ベースを原則**とする。優先順位:
1. **既存の共通コンポーネント**（client/components 配下）を再利用・拡張する
2. 無ければ **shadcn/ui のパターン**を導入する（コピーイン方式: 依存パッケージとしてではなく、
   shadcn の実装を client/components/ui/ 配下へ写して §37.1 のセマンティックトークンに合わせる。
   ベースは Radix プリミティブ + Tailwind）
3. shadcn に無い場合は **素の Radix プリミティブ**（@radix-ui/react-*）で組む
4. 独自実装は上記で成立しない場合のみ（理由をコメントに残す）
- ダイアログ/ドロップダウン/トグル/ツールチップ等の対話部品を**素の div/button で自作しない**
  （a11y・フォーカス管理・Esc/外側クリックの挙動を Radix に委ねる）
- 既存の自作対話部品は新規改修のついでに段階的に置換してよい（一括置換タスクは立てない）

### 37.7 document.title の単一所有 + 実行中ワーカー数プレフィックス（2026-08-20〜）
タブを開いていなくても実行中ワーカー数が分かるように、`document.title` の**先頭**に件数を出す。

- **単一所有**: `document.title` へ書き込むのは `client/lib/document-title.ts` **のみ**。コンポーネントが
  直接代入してはならない（AppShell は `/sessions`・`/session/:id` を含む全ルートをラップするため、
  複数箇所からの代入は最後の書き手勝ち + cleanup によるプレフィックス消失を招く）
- **整形規則**: `activeCount > 0` なら `(<件数>) <ベース>`、0 件ならプレフィックス無し（ヘッダー
  バッジの `badge > 0` 表示条件と一致させる）。ベース未登録時の既定は `hachi-kanban`
- **ベース登録**: 画面ごとに `useDocumentTitleBase(base)` で登録する。cleanup は**自分が最後の登録者
  である場合のみ**クリアする（StrictMode の二重実行・画面遷移時の cleanup/effect 交差で壊れないため）。
  §27.1 の単独ウィンドウ識別子 `▶ <タスクタイトル>` はベースとして維持し、`(3) ▶ <タスク>` となる
- **件数の供給元**: ヘッダーの sessions バッジと同じ `GET /api/sessions?scope=running` の件数
- **非表示タブでの更新**: §20 の「タブ非表示時は skip」は帯域節約のため維持しつつ、`useVisiblePolling`
  に任意の `hiddenIntervalMs` を追加し、**非表示中のみ**低頻度（既定 30s）でカウントを更新する。
  ブラウザのバックグラウンドタイマー抑制により実間隔は保証されない（Chrome は数分後に約1分間隔）

## 38. notify transport 抽象化 + Telegram 通知（out、v0.9）

human_queue 入り・escalate を外出先へ届ける。旧系統（legacy-hermes の escalation packet）で
実在した機能の再獲得。**out（通知）のみ**を扱い、in（双方向）は別契約とする。

### 38.1 transport 抽象
- notify ステージに transport 層を導入: `macos`（既存 osascript）/ `telegram` / 将来 `g2`
- 既存の reasonHash 冪等（同一 reason 1回・変化で再通知）は transport 共通の上位層でそのまま流用
- config.json `notify.transports: string[]`（既定 `["macos"]` = 未設定でも既存動作不変・fail-closed）
- 送信失敗は warn ログのみ（通知が supervisor 本体を壊さない）。transport ごとに独立試行し、
  1つの失敗が他 transport を止めない

### 38.2 telegram transport
- Bot API sendMessage。token は `$HACHI_KANBAN_HOME/telegram-token`（0600・値をログ/エラーに出さない・
  bridge-token と同流儀）。chat_id は config.json `notify.telegram.chatId`
- token ファイル欠如または chatId 未設定時は telegram transport を **skip（warn 1回/tick）** —
  実装を先行させ、credential は後from設定可能にする
- 本文: タスク title / id / block_reason（redact 済み）/ 詳細 URL（`http://127.0.0.1:9131/task/<id>` は
  外出先で開けないため、config `notify.telegram.baseUrl`（例 https://<your-host>.<your-tailnet>.ts.net:9443）があればそちらで生成）
- 粒度: config `notify.telegram.minPriority`（既定 0 = 全 human_queue 通知）
- macOS transport の通知タイトルは §18 の2分類（要判断 / 回収待ち）を使う。Telegram 本文と対象範囲は
  従来の human_queue 通知を維持する
- doctor: telegram-token の存在有無・mode のみ表示（値は出さない）

## 39. verify ゲート — 自動 done の機械証拠条件化（v0.9）

現状 pass+high verdict は人間確認なしで自動 done する（§15）。done の根拠を機械証拠に紐付ける。
**適用は tenant 別**（2026-07-06 ユーザー決定）: verify コマンドが定義された tenant は証拠必須、
未定義 tenant は現状動作 + 監査ログのみ。

### 39.1 verify コマンド定義
- config.json `verify.tenants: Record<string, string>`（例: `{"hachi-kanban": "pnpm -r typecheck && pnpm -r test"}`）
- タスク単位の上書き: body の独立行 `verify: <コマンド>`（cwd 行と同流儀）。`verify: none` で明示的に免除
- コマンドは task の cwd で実行する。timeout は 15 分（超過は失敗扱い）
- verify は launchd から再現可能な**非対話実行環境**で動かす。`.zshrc`、shell snapshot、alias、shell function は
  読み込まず、`zsh -lc` への切替を解決策にしない。実行 PATH は supervisor の基底 PATH に、存在確認済みの
  `$HOME/.vite-plus/bin`、`$HOME/.local/bin`、`$HOME/.n/bin` を既知 toolchain path として前置する
  （値は task body や shell 出力から採用しない）
- `verify:` に記載するコマンドは上記 PATH から解決できる実行ファイルまたは workspace script を入口にする。
  対話 shell にしか存在しない function/alias を契約上の実行可能コマンドとして扱わない
- **予約語の fail-fast（2026-08-29 実装。main=d15e090）。** `verify:` の値は `none` 以外が
  シェルコマンドとして実行されるため、モード名のつもりで書いた語が `command not found`（exit 127）
  になり、**worker が走り切った後の finalize で落ちる**という最も高い位置での失敗を招いていた
  （2026-08-29 に `verify: focused` と `verify: test` の2件が独立に発生）。次のとおり書込境界で拒否する。
  - **判定は既知予約語の完全一致**（trim・case-insensitive）:
    `focused` / `full` / `test` / `skip` / `all` / `default` / `auto`
  - **PATH 解決による判定は行わない。** `test` は shell builtin なので解決に成功して漏れ、
    起票側と worker で PATH/cwd が違えば誤検知するため（実装は `packages/core/src/verify-directive.ts`）
  - **多語コマンドは拒否しない。** `test -e file` / `pnpm test` / `make` / `just` は従来どおり通る
  - 予約語と同名の実コマンドは `./focused` や `command focused` のような明示形で使う
  - 適用は Core の書込境界3点: `createTask`（INSERT 前）/ `updateBody`（UPDATE 前）/
    `runTransition` の `to === "ready"` 前。CLI だけでなく scheduler・enqueue・fanout-apply・
    legacy import も同じ境界を通るため一箇所で塞げる
  - 既存 body の発見は `hachi doctor` の `verify directives` 検査が担う
    （非終端タスクを走査し、**body 全文は出さず task ID と該当予約語だけ**を出す）
  - **finalize 直前に専用の終端理由を導入することは意図的に見送った**（`t_55ea6b3254752e77` #4054）。
    上記3点と doctor で残るのは「既に ready の既存行」だけであり、それは doctor が拾う

### 39.2 finalize/review の挙動
- pass+high の自動 done 判定前に、対象 tenant/task に verify 定義があれば実行:
  - 成功（exit 0）→ 自動 done。exit code・末尾出力（redact 済み・上限 8KB）を task_runs.meta.verify に
    evidence 記録
  - 失敗 → `failureCause=worker_local` として自動 done せず**既存の自動 rework 経路**へ
    （review fail と同型。summary に verify 失敗を明記）
- verify 未定義 tenant → 従来どおり自動 done し、meta.verify に `{skipped: "no-command"}` を監査記録
- pass+medium/low の人間確認フローは不変更
- dry-run（apply=false）では実行せず notes に予定を記録。kill-switch: verify.disabled（既存 isDisabled 機構）
- exit 127 / `command not found` はコード品質の review fail と混同せず `verify_environment_failed` として記録し、
  同じ worker を自動 rework しない。task_runs.meta.verify には exit code、redact済み末尾、実行PATHの由来
  （値そのものではなく `runtime-path-v1` 等の固定識別子）を残し、タスクは `review-required:` へ倒す

## 40. steward ステージ — 判断面の自動化（v0.9）

判断面（triage 仕分け・spec 不足指摘・閉じ忘れ検出・escalate）を、常駐 supervisor が定期起動する
**短命判断セッション**で自動化する。適用権限は「低リスクのみ自動・他は人間承認」
（2026-07-06 ユーザー決定）。

### 40.1 実行モデル
- stage `steward` を STAGES 末尾に追加。**tick より疎**: `state/steward.json` の lastRunAt を見て
  `config.steward.intervalMinutes`（既定 30）経過時のみ実行。apply=false では起動しない
- 判断セッションは `profiles["steward"]` で起動（推奨: claude / claude-sonnet-5 / transport=direct /
  effort=medium — §35 の effort 伝搬を利用）。profile 未定義なら skip + warn（fail-closed）
- direct 判断セッションは実行ごとに OS tmp 配下へ fresh 0700 directory を作り、空 Git repository として
  初期化して通常の trusted-repository 検査を満たす。永続 workspace や `--skip-git-repo-check` は使わず、
  成功・起動失敗・timeout の全経路で workspace を破棄する。Codex の reserved virtual Steward
  （id=steward / tenant=system / profile=steward / status=blocked）だけは read-only sandbox、ephemeral、
  user config/rules 無効、shell environment 非継承で起動し、通常の direct worker へこの隔離設定を波及させない。
  Steward用direct adapterはstop capability必須とし、起動後のstatus/fetch/timeout例外では未完了sessionを
  best-effort停止してからworkspaceを破棄する。Codex/Claude direct adapterはspawn後のsession state永続化に
  失敗した場合も、取得済みPIDのprocess groupをbest-effort停止してから失敗を返す
- kill-switch: `steward.disabled`。連続3回失敗（起動失敗・出力パース不能）で auto-disable
- **auto-disable は half-open で自動復帰する（2026-08-29 実装。main=ee14a62。§48.1 の brief も同じ）。**
  実装は `packages/supervisor/src/stages/auto-disable-circuit-breaker.ts` に共通化し、steward と brief が共有する。
  - 背景: 2026-08-27 に claude direct lane が約2時間全滅し、**障害は自然回復したのに steward だけが
    連続3回失敗で停止し、27時間止まったまま誰も気づかなかった**。原因は (a) 復帰条件が無い
    (b) auto-disable が notify 経路を通らない (c) 同じ障害でも run 粒度で耐性が数倍違う（brief は
    1 scheduled run 内の retry なので +1 しか増えない）の3つである
  - state に `autoDisabledAt`（epoch 秒）を持つ。**`AUTO_DISABLE_RETRY_AFTER_SEC = 3600` 経過後は
    `autoDisabled=true` でもその回だけ実行を通す**（half-open）。時間で開くため (c) も同時に解消する
  - half-open が成功したら `autoDisabled=false` / `consecutiveFailures=0` / `autoDisabledAt=0` へ完全復帰する
  - half-open が失敗しても `consecutiveFailures` は増やさない（増やすと数字が無意味に発散する）。
    **再試行の起点は §40.1.1 の claim 時刻とする** — すなわち claim 取得時に書いた
    `autoDisabledAt` をそのまま残し、失敗時に現在時刻へ書き直さない。
    **旧記述（失敗時に現在時刻へ更新する）は §40.1.1 の採択で置き換えられた。**
    claim を挟まずに half-open した場合（§40.1.1 実装前の現行動作）は従来どおり失敗時刻へ更新する
  - **auto-disable への遷移時と half-open 復帰成功時の両方で通知を出す**
    （実装は steward/brief 既存の `sendAdHocNotification` 経路。§38 の operational notify とは別経路である）
  - `autoDisabledAt` は **optional field** として扱う。**欠落と `0` は「即座に half-open 可」**と解釈し、
    追加前に書かれた既存 state を壊さない。`hachi admin steward-enable` / `brief-enable` の strict parser は
    未知 key を拒否するため、両 CLI の `OPTIONAL_STATE_KEYS` にも同じ field を加えてある
    （手動復帰を残すために必要な追随であり、CLI 挙動の変更ではない）
  - **half-open（自動）と手動復帰は別経路であり両立する。** §40.6 / §48.3 が「唯一の経路」と述べるのは
    **手動で復帰させる場合**の話であり、時間経過による half-open を否定しない。
    **手動復帰は fenced な `hachi admin steward-enable` / `brief-enable` だけを使う**
  - **半開の獲得は fence されていない（2026-08-29 に方式採択。実装は未了）。** 現行実装は
    「実行可否の判定」を run の前に読み、state の書き込み時にだけ state lock を取る
    （`writeStewardState` → `acquireStewardStateLock`）。したがって tick が重なると
    **half-open の試行が二重に走りうる**（brief の通知重複、steward の提案二重適用）。
    **どこまで重なるかは調査で確定した**（`t_880a9b4badd8c906`）:
    - **単一の常駐 supervisor 内では tick は重ならない。** stage は順に `await` され、次 tick は
      前回完了後に予約されるため、300 秒の steward/brief run が 30 秒 cadence をまたいでも
      同一プロセス内の再入は起きない
    - **プロセスを跨ぐと重なる。** `--once --apply` は `runTick()` を直接呼べるが、常駐モードとの
      プロセス横断排他も singleton 確認も無い。`runTick()` 自体に `running` guard は無く、
      guard は常駐ループ側にしかない。**具体的な条件は「常駐中の手動 `--once --apply`」と
      「同じ home を使う supervisor の二重起動」**である
    - **二重副作用の窓は実在する。** steward も brief も**外部セッションの実行と適用・通知を
      行ってから state を書く**ので、最後の lock と stale-write 検査は**後着 writer を拒否できても、
      既に行われた提案適用や通知は戻せない**
    - **採択した対策は下の §40.1.1。**
  （state に理由記録・doctor で可視化。**復帰は §40.6 / §48.3 の
  `hachi admin steward-enable` / `brief-enable` だけを使う。state ファイルの手編集・直接リセットは禁止**
  — provenance・state lock・audit event・stale write 保護をすべて迂回するため）

#### 40.1.1 half-open claim の契約（2026-08-29 採択・実装未了）

> 方式比較 `t_880a9b4badd8c906` は3案を比較した:
> A（`autoDisabledAt` を先行更新して席を獲る）/ B（nonce + expiry）/ C（tick 全体をプロセス横断 lock）。
> **C は通常 cadence 実行まで直列化し、長時間 tick 用の PID/nonce/stale 回収が要るうえ、crash 時に
> supervisor 全体を止めうる**ので、今回の局所対策には過大である。ここは採らない。
>
> **worker の推奨は A だった。根拠は「最小変更」で、B の欠点は
> 「state schema・strict CLI parser・doctor・手動 enable まで波及する」ことだった。
> しかし採択後のレビューで、その根拠が成立しないことが分かった（2026-08-29）。**
> A が想定していた「`autoDisabledAt` の一致」だけの fence は **ABA 安全ではない**
> （手動復帰が `0` へ戻した後、次の auto-disable が同じ epoch 秒を書けば、所有権を失った
> claimant の等値 fence が通る）。**これを塞ぐには所有者識別が要り、その時点で
> B の欠点として挙げた波及範囲（state schema / strict parser / doctor / 手動 enable）を
> そのまま支払うことになる。**
>
> **したがって本節が採択するのは「A の骨格 + B の所有者識別（`claimGeneration`）」であり、
> worker が推奨した素の A ではない。** B の expiry / renewal は導入せず、expiry は従来どおり
> `autoDisabledAt` からの 3600 秒で測る。**「最小変更だから A」という理由は既に失効しているので、
> 実装者は本節を『A だから軽い』と読んではならない。**
> さらに **outbox（lock 外でネットワーク配送するための durable な配送予定）は A にも B にも
> 無かった追加スコープ**である。
>
> **それでもこの形を採るのは、代替が「不健全と分かっている fence を出荷すること」だからである。**
> なお B の renewal を入れれば、本節が「現状どこにも上限が無い」と認めている
> 「全区間 < 3600 秒」の不変条件を実装で強制せずに済む。**将来この不変条件を保証できないと
> 判明した場合は、renewal 込みの B へ進む**（下記の安全不変条件の項を参照）。

- **`autoDisabledAt` の意味を拡張する**: 「auto-disable へ遷移した時刻」**または「最新の half-open
  claim を開始した時刻」**。どちらであるかを区別する field は増やさない
- **「3600 秒経過後はその回だけ通す」を「共有 state lock 下の再判定と先行書き込みに成功した
  1 claimant だけ通す」に置き換える。** 順序は次の4段で固定する:
  1. 副作用の無い cadence / due-slot / profile 検査を行う
  2. **純粋な検査が終わった直後、かつ失敗しうる準備処理より前に**、既存の共有 state lock
     （`$HACHI_KANBAN_HOME/steward-state.lock`。§40.6）を取る。
     **「外部セッションを起動する直前」では遅い** — 現行実装には claim より前に副作用を出す経路が
     実在する（brief は model 解決に失敗した時点で、セッションを1つも起動しないまま circuit state を
     書く。steward は runner 構築に失敗した時点で決定論的な escalation を適用する）。
     **claim せずに失敗すると `autoDisabledAt` が更新されないので毎 tick が即 eligible のままになり、
     複数プロセスが同じ副作用を繰り返せる。** したがって
     **「セッションを起動せずに retry window だけを消費する」遷移も claim の内側に入れる**
  3. 対象 state を**再読込**し、その時点の時刻で half-open 可否を**再判定**する。eligible な
     claimant だけが `autoDisabledAt = now` を durable write し、書き込み後の state を
     完了時 CAS の baseline にする
  4. **lock を解放してから実行する**（外部セッションを lock 保持中に走らせない）。
     他プロセスは更新済みの時刻を読んで skip する
- **half-open が失敗した場合**は、既に記録済みの claim 時刻を再試行の起点とし、
  `consecutiveFailures` は増やさない（現行規定を維持する）
- **`autoDisabledAt` 欠落 / `0` の legacy state も、最初の実行者が時刻を永続化してから run する。**
  「欠落と `0` は即座に half-open 可」の解釈は維持するが、**判定と実行の間に必ず claim の
  書き込みを挟む**
- **claim を持ったままプロセスが落ちた場合は 3600 秒後に自動回復する**（追加の expiry は要らない）。
  **これは lock 残骸の回復とは別物である** — lock を保持したまま crash して残った
  `steward-state.lock` は supervisor が自動回収せず、**§40.6 の CLI stale-lock 回収経路が要る**
- **安全不変条件は「セッション timeout」ではなく「claim 取得から最終 CAS までの全処理時間」で測る。**
  `claim 取得 → 外部セッション実行 → 提案適用・通知 → 完了時 CAS` の**全区間 < claim expiry（3600 秒）**
  でなければならない。セッション timeout（300 秒）はこの区間の一部にすぎず、
  **セッション終了後の提案適用・通知・停止処理・CAS 書き込みには現状どこにも上限が無い**。
  区間が expiry を超えると、**最初の claimant が生存したまま次の claimant が走り、
  先行者が expiry 超過で所有権を失う**（`claimGeneration` fence があるので後着と先行者が
  同時に副作用を出すことは防げるが、**先行者が途中まで出した副作用は戻らない**）。
  したがって実装時は次のどちらかを満たす:
  - **全区間へ上限を設け、その合計が 3600 秒を十分下回ることを保証する**（上限の根拠を実装タスクに残す）
  - 保証できないなら **案 B（nonce + expiry + renewal + 所有者 fence）へ移行する**。
    案 A の適用範囲は「全区間が有界であること」が前提であり、これは採択時の暗黙前提だった
- **不可逆な副作用の直前に claim fence を置く（案 A の必須要素）。** timeout は
  「処理が止まったこと」を保証しない。したがって **提案適用・outbox 記録・完了時 CAS の
  それぞれの直前に、共有 state lock 下で state を再読込し、`claimGeneration` が自分の獲得値と
  一致することを確認する。一致しなければ副作用を行わず中止する**（既に適用済みの分は戻せないので、
  fence は「これ以上増やさない」ためのものである）。
  **fence のキーは `claimGeneration` ただ一つである。`autoDisabledAt` の一致で判定してはならない**
  （理由は下記の ABA の項）。`autoDisabledAt` は **expiry の計算にだけ**使う
- **fence は「振る舞いの約束」ではなく「API の保証」として実装する（2026-08-29 追記）。**
  この節の要求を**呼び出し元の書き方に委ねてはならない** — 呼び出し側は別タスク・別 worker が書くので、
  約束だけでは破られる。**実際に rework を2回要した**（`t_ddcca63008708ee8`）。具体的には:
  - **bool を返す fence API を作らない。** 「判定して返す」形は、返った時点で lock が解放されているため、
    呼び出し元がどう書いてもこの節を満たせない。**lock を保持したまま呼び出し元の処理を実行する
    callback 形**（fence 通過時だけ `fn` を呼ぶ）にする
  - **callback が thenable を返したら実行時に拒否する。** async callback は同期部分が返った時点で
    lock が解放され、**継続は解放後に走る**。型だけでは `any` 経由で抜けられるので実行時にも見る
  - **state を書く capability は fence スコープを抜けた時点で revoke する。** callback へ渡した writer を
    退避されると、スコープ外（＝lock 解放後）に呼べてしまう
  - lock の解放は全経路で `finally` に置き、**revoke を解放より前**に行う
  - **未了（follow-up）: 現行実装は callback へ raw な writer を渡しており、上の保証は完全ではない。**
    callback が (a) `claimGeneration` を**下げた** state を書く、(b) 呼び出し元が持つ store の
    `writeStateUnderLock` を直接掴んで lock 解放後に書く、のどちらもできてしまう
    （revoke は fence が渡した wrapper にしか掛からない）。**塞ぐには、fence 側が
    scoped write のたびに claim generation を検証または注入し、callback へ生の mutator を
    渡さない**（宣言的な遷移を受け取り、fence 実装が検証して適用する形にする）。
    negative test（generation を下げる／生 writer を持ち出す）も要る。**この節は要求であり、
    実装は未了である**
- **fence と、それが守る状態遷移は、同じ lock 保持の中で行う。**
  確認してから lock を手放して状態を書き換えてはならない。手放すと、その隙に
  `hachi admin steward-enable` / `brief-enable`（§40.6 / §48.3）が lock を取って claim を無効化でき、
  **所有権を失った claimant がそのまま副作用を出す**。
- **ただしネットワーク配送を lock 保持中に行ってはならない。** 通知経路は有界ではない
  （Telegram だけでも1通あたり10秒×2回の試行がありうる）ので、保持したまま配送すると
  **steward / brief の両ステージと手動復帰を不定時間ブロックする**。したがって:
  1. **lock 内**: fence（`claimGeneration` 一致）→ 提案適用などの状態遷移 →
     **配送予定を outbox として durable に記録**（`claimGeneration` を添える）→ lock 解放
  2. **lock 外**: outbox を読んでネットワーク配送する。配送は outbox エントリ単位で行い、
     **配送済みの記録は `claimGeneration` 付きで残す**。
     **ただし「重複しない」を保証してはならない** — 現行の Telegram 経路は
     `sendMessage` に idempotency key が無く、**応答を取りこぼすと「相手は受理したが手元は未確認」を
     区別できない**（notify 実装自身がこの重複可能性を明記している）。
     したがって**通知は at-least-once とし、曖昧な失敗の後の重複を許容する**。
     重複を許さない要件が出た場合は、**remote 側に冪等性を持つ transport を要求する**
  2'. **無効化された世代の outbox は配送しない。** 手動復帰などで `claimGeneration` が進んだら、
     **未配送の旧世代 outbox は破棄する**。**既に発信済みのネットワーク呼び出しは取り消せない**ので、
     無効化が保証するのは「これ以上出さないこと」だけである
  3. **lock 内**: 完了時 CAS。ここでも fence を通す
  **lock を保持したまま走らせないのは外部セッションとネットワーク配送の2つ**である
- **提案の件数と処理時間には上限を設ける**（1回の claim で適用する提案数の上限、
  claim 取得から最終 CAS までの経過時間の上限）。上限に達したら打ち切って次の claim へ送る。
  上限値と根拠は実装タスクで決めて契約へ追記する
- **generation の単調性は、手動復帰の pending journal 回収を壊しうる（2026-08-29 追記）。**
  §40.6 / §48.3 の apply は pending journal に `beforeHash` / `afterHash` を持ち、回収時に現在の state を
  それと突き合わせる。**`claimGeneration` を巻き戻さない**という要求のため、audit 失敗時の rollback は
  **before 状態でも after 状態でもない「第三の state」**（before 状態 + 前進した generation）を作る。
  そのまま実装すると、**journal を削除する前に停止した場合に次回 apply が第三者更新として拒否し、
  正規復帰経路が回収不能になる**（`t_afc56e8e8058d9b7` で実際に検出）。したがって:
  - **補償 state は事前に決定できる**（before 状態 + 適用後の generation）ので、
    **journal 作成時に `compensatedHash` も併せて記録する**。
    **rollback 中に journal を書き足さない**（書き足すと新しいクラッシュ窓ができる）
  - 回収は **`beforeHash` / `afterHash` / `compensatedHash` の3つを受理**する。
    いずれにも一致しない state は従来どおり第三者更新として拒否する
  - journal の version を上げ、**旧 version（`compensatedHash` を持たない）は従来の2ハッシュ判定で
    引き続き回収する**
- **手動復帰は in-flight な claim を無効化する。** §40.6 / §48.3 は `autoDisabledAt=0` へ戻すと同時に
  **`claimGeneration` を +1 する**。これにより **claimant は次の fence で不一致を検出して中止する**。
  これは手動復帰を優先する意図的な設計である（**無効化の実体は `claimGeneration` の前進であって、
  `autoDisabledAt` の reset ではない**）
- **fence の判定に「claim 時刻の一致」だけを使ってはならない（採択案の修正・2026-08-29）。**
  当初 A は「後着が書く `autoDisabledAt` は必ず自分の claim 時刻より 3600 秒以上大きいので
  ABA は生じない」という前提で採択した。**これは誤りである** — 手動復帰（§40.6 / §48.3）が
  `autoDisabledAt=0` へ reset した後、次の auto-disable が**たまたま元と同じ epoch 秒**を書けば、
  所有権を失った claimant の等値 fence が通ってしまう。
  wall-clock の調整でも同じことが起きる。
- **したがって state に `claimGeneration`（単調増加する整数）を持ち、fence はこれで行う。**
  - claim を獲るたびに `claimGeneration` を +1 し、`autoDisabledAt` と**同一の書き込み**で永続化する
  - **すべての副作用 fence は `claimGeneration == 自分が獲得した値` で判定する**
    （`autoDisabledAt` は expiry の計算にだけ使う）
  - **単調増加なので reset や wall-clock 調整で再利用されない**
  - **`claimGeneration` を巻き戻す経路を作らない。** `hachi admin steward-enable` / `brief-enable` は
    audit 失敗時に**直前の state 全体を書き戻す rollback 経路を持つ**が、これをそのまま通すと
    `g+1` が `g` へ戻り、**無効化したはずの claimant（`g` を保持）が fence を通ってしまう**。
    rollback しても **`claimGeneration` だけは前進後の値を保つか、さらに +1 して補償する**。
    **この pending journal / rollback 経路も本節の波及範囲に含める**
  - **claim を無効化する遷移は `claimGeneration` を +1 する。** 手動復帰（§40.6 / §48.3）は
    `autoDisabledAt=0` へ戻すと同時に **`claimGeneration` を +1 する**。
    **保持するだけでは無効化にならない** — fence は `claimGeneration` だけで判定するので、
    値が変わらなければ所有権を失ったはずの claimant がそのまま通ってしまう。
    **減らすことは決してしない**（再利用が起きる）。steward と brief に同じ規則を適用する
  - **数値域を決める**: 欠落は `0` と解釈する。+1 する前に
    **非負かつ `Number.MAX_SAFE_INTEGER` 未満の安全整数**であることを検査し、
    それ以外（負・非整数・上限到達）は **fail-closed で失敗させる**（黙って巻き戻さない）
  - これは案 B の「所有者識別」だけを借りたものであり、**B の expiry / renewal 機構は導入しない**
    （expiry は従来どおり `autoDisabledAt` からの 3600 秒で測る）。
    波及は state schema と、`hachi admin steward-enable` / `brief-enable` の strict parser の
    `OPTIONAL_STATE_KEYS`、doctor の可視化に限る
  - **時刻だけの版へ「簡約」してはならない。** 上記の理由でそれは不健全である
- **§48.1 の brief も同じ claim 契約を継承する**（auto-disable 機構は
  `packages/supervisor/src/stages/auto-disable-circuit-breaker.ts` で共有されているため）
- 実装タスクは別途起票する。**本節は契約であり、実装済みを意味しない**

### 40.2 入力
- board スナップショット: triage/todo/ready の一覧（id/title/tenant/priority/経過時間/body 先頭）、
  human_queue、done だが archive されていない一覧、直近 task_events 要約
- プロンプトは §12 の redact を通し、token 類を含めない

### 40.3 出力契約（hachi-steward-v1 フェンス）
- セッション最終出力に ```hachi-steward-v1 フェンスで proposals 配列を出す:
  `{ proposals: [{ kind: "promote"|"archive"|"spec-lint"|"escalate", taskId, reason }] }`
- steward は**この提案以外の書込手段を持たない**（タスク直接遷移・enqueue・steer は不可。
  ステージ側パーサが kind 外・不明 taskId を破棄し監査 warn）

### 40.4 適用規則（two-party gate: steward=提案 / supervisor=検証と適用）
- **自動適用（低リスクのみ）**: kind=archive **かつ対象 status=done** → archived へ遷移
  （機械検証可能な board 衛生のみ。イベント steward_auto_archive を記録）。
  **適用前に §74 の統合観測ゲートを通す。** veto された提案は適用しない。
  イベントには §74.3 の `integrationEvidence` を必ず載せ、判断 session の自由文で
  「統合済み」に相当する主張をしない
- kind=archive（done 以外）/ kind=promote → 自動適用**しない**。対象タスクへ提案コメント
  （steward 名義・reason 付き）+ steward_proposal イベント + notify 経路（§38）で人間へ通知。
  **tenant=hachi-kanban の promote は将来承認機構が入っても常に人間ゲート**（§課題: 自己改変ハザード）
- kind=spec-lint → 対象タスクへ指摘コメントのみ
- kind=escalate → human_queue 通知（§38 notify 経由）
- 同一 (kind, taskId) の提案は 24h 冪等（重複コメント抑止）

### 40.5 観測
- 実行結果（起動時刻・提案数・適用数・失敗）を state/steward.json とログに記録。doctor に
  steward の lastRun 鮮度・auto-disable 状態の検査を追加

### 40.6 auto-disable の正規復帰

- 手動復帰入口は`hachi admin steward-enable [--apply] --actor-kind orchestrator --orchestrator <id>
  --session <id> --generation <n>`。既定はdry-runで、`--apply`だけがstateを変更する。human/unknown/service、旧generation、
  別identity、stale/closed sessionを拒否し、active exact principalをCore Storeで再照合する。
- 対象は`$HACHI_KANBAN_HOME/state/steward.json`の通常fileだけ。symlink、directory、非regular、上限超過、壊れたJSON、
  schema外値はmutation 0で拒否する。既にenabledまたはstate未作成はidempotent no-op。
- applyは既存`lastRunAt`・proposal/applied/comment countを保持し、`consecutiveFailures=0`、`autoDisabled=false`、
  **`autoDisabledAt=0`**（§40.1.1 の claim 時刻を残さない。残すと手動復帰の直後に claim 済みと誤読される。
  **`claimGeneration` は +1 する** — in-flight claim の無効化はこの前進で行う。減らすことはしない）、
  `autoDisabledReason=''`、`lastError=''`だけをatomic renameでresetする。新規file/temporary fileは0600、state全文や
  model出力をCLI・eventへ含めない。
- CLI applyとsupervisorの通常state writerは`$HACHI_KANBAN_HOME/steward-state.lock`を共有し、0600のO_EXCL通常fileで相互排他する。
  lockはowner・PID・128bit operation nonce・createdAtのstrict schemaを持つ。supervisorは既存lockを常に尊重する。
  CLIだけが`kill(pid, 0)=ESRCH`かつ作成から120秒以上の両方を確認した場合に限り、読取ったnonceとの一致を
  再照合してstale lockを回収できる。PID alive/EPERM、未来時刻、120秒未満、malformed、symlink/non-regularは
  奪わない。main lockのcreate・stale回収・releaseは、全writerが共有する短時間O_EXCL recovery guardで直列化し、
  stale候補のread→remove間に新owner lockを削除できないようにする。guard自体は自動stale回収せず、残骸・malformed時は
  fail-closedでdoctorへ出し、live writerを推測で奪わない。releaseもguard下で所有nonce一致を再確認する。
  state writerはtemp作成からrename後まで0600を保ち、fileと親directoryをfsyncしてからlockをreleaseする。
- changed applyはstate更新前に0600の`state/steward-enable.pending.json`をdurableに作り、operationIdとbefore/afterの
  SHA-256、保持対象の非secret要約だけを記録する。次回applyは共有lock下でjournalを先に回収する。current hashがbeforeなら
  未適用としてjournalを破棄して再試行し、afterならoperationIdの監査eventを冪等確認・不足時だけ追記してcommitし、どちらにも
  一致しない場合は第三者更新としてmutation 0で停止する。監査失敗rollbackはcurrent hashが自身のafter hashと一致する時だけ
  before snapshotへ戻し、並行supervisor更新を上書きしない。audit後/journal削除前のcrashもoperationIdの一意性で再実行しない。
- **journal は v2 で3ハッシュになった（2026-08-29。§40.1.1 の `claimGeneration` 単調性が上の2ハッシュ判定を
  壊すため）。** rollback は `claimGeneration` を巻き戻さないので、before でも after でもない**補償 state**
  （before 状態 + 適用後の generation）が生まれる。補償 state は事前に決定できるので、
  **journal 作成時に `compensatedHash` も併せて記録する**（rollback 中に journal を書き足さない＝
  新しいクラッシュ窓を作らない）。回収の分岐は次のとおり:
  - current hash が **before または compensated** → **未適用**として journal を破棄し再試行する。
    **監査 event は記録しない**（適用されていないため）
  - current hash が **after** → 従来どおり operationId の監査 event を冪等確認・不足時だけ追記して commit する
  - **いずれにも一致しない** → 従来どおり第三者更新として mutation 0 で停止する
  - **v1 journal（`compensatedHash` を持たない）は従来の2ハッシュ判定で引き続き回収する**
- migration version 18でtask非依存の`board_audit_events`をadditiveに追加する。event type、表示actor、bounded JSON payload、
  §60と同じ4 provenance列、createdAtを持ち、Storeがactive orchestrator generationを同一transactionで再照合する。
  成功/no-opは`steward_enabled`を構造化orchestrator provenance付きで記録する。payloadはchanged/no-opと保持した
  lastRunAt等の非secret要約とoperationIdだけとし、state全文・失敗出力・reason全文を含めない。operationIdは同event type内で
  一意にしてcrash recovery時の監査追記を冪等化する。dry-run、authority失敗、file検証失敗はevent 0。
  apply後はdoctorがauto-disable NGを解消し、次のcadence tickで再失敗しないことを実環境確認する。
- kill-switch`steward.disabled`は別authorityでありenableでは削除・迂回しない。auto-disable復帰後もkill-switchがあれば
  stageは従来どおりskipする。

## 42. Telegram 双方向ゲートウェイ（in: approve / answer、v0.9）

スマホから承認・回答を返せる bounded write 経路。**許可範囲は approve + answer**
（2026-07-06 ユーザー決定）。自由コマンド・任意遷移は受けない（fail-closed）。

### 42.1 telegram-in ステージ
- supervisor 新ステージ `telegram-in`（STAGES 末尾）。Bot API getUpdates ロングポーリングではなく
  tick 内での増分取得（offset= state/telegram-in.json の update_id カーソル、冪等）。
  token/chatId は §38.2 と同一のもの（token 未設定なら skip）。kill-switch: telegram-in.disabled
- **chat_id allowlist**: config `notify.telegram.chatId` と一致する chat 以外の更新は無視し、
  盗聴的試行として warn + 監査イベント記録

### 42.2 bounded intents（inline keyboard）
- §38 の通知に inline keyboard を付ける: user-decision blocked → [✓ 承認して done] [詳細]、
  steward promote 提案（§40.4）→ [✓ ready 化を承認] [✕ 却下]
- callback_data は `<action>:<taskId>:<nonce>`（nonce は state 管理・1回限り・期限24h）
- **approve**: user-decision の解消（blocked→done）と steward promote 提案の適用（→ready）。
  いずれも Telegram 操作 = 人間承認として two-party gate を満たす。適用は supervisor が
  状態を再検証してから遷移（すでに動いた/消えたタスクは「適用不能」を返信）
- **answer**: active orchestrator request が無い従来タスクだけ agent.message.v1 answer として記録する。
  `waiting_human` request への返信は worker へ直送せず request の `human_answer` へ保存し、§55 の
  オーケストレーター inbox へ戻す。active request が `waiting_human` 以外なら fail-closed で拒否する
- すべての操作を task_events（telegram_approve / telegram_answer / telegram_rejected）で監査

### 42.3 応答
- 操作結果（適用済み/適用不能/権限なし）を同 chat に返信。token・秘密値は返信に含めない

## 43. handoff 証拠検証（commit / working tree / artifact、v0.9）

worker の `hachi-handoff-v1` は引き続き提案であり、finalize は summary 等で主張された機械証拠を検証してから
状態遷移する。LLM が「コミット済み」「スクリーンショット保存済み」と述べただけでは done にしない。

- commit claim: summary の commit/コミット文脈、または任意の追加 JSON field
  `commit` / `commits` / `commitHash` / `commitHashes` に含まれる 7〜64 桁 hex を commit claim とみなす。
  主張された hash は task body の `cwd:` の git repository で `origin/main..HEAD` に含まれる commit でなければならない。
  「コミット済み」等の主張があるのに hash が無い場合も fail-closed。
- working tree: outcome=`done` かつ `cwd:` が git repository で、かつ有効 handoff policy が `commit` の場合、
  `git status --porcelain=v1` が空でなければならない。`cwd:` が git repository でなく、commit claim も無い場合は
  従来互換のため working tree 検証は skip する。有効 policy が `no-commit`（既定）の場合の扱いは下の宣言規則に従う。
- artifact claim: summary の成果物/スクリーンショット/artifact 文脈、または任意の追加 JSON field
  `artifact` / `artifacts` / `artifactPath` / `artifactPaths` に含まれる成果物パスを検証する。相対パスは `cwd:`
  または `$HACHI_KANBAN_HOME/artifacts/<taskId>/` のどちらかに実在すればよい。絶対パスは同2領域配下のみ許可する。
  - **不在時の扱いは主張の出所で分ける（2026-09-02）。** 構造化 field 由来の主張、および basename が
    `ui-*.{png,jpg,jpeg,webp,gif}` の UI 証跡（summary 由来を含む）は、実在しなければ従来どおり fail-closed。
    **summary 散文から抽出した候補は、実在すれば `handoffEvidence.artifactClaims.confirmed` に記録し、実在しなければ
    failure ではなく `handoffEvidence.warnings` に記録して状態遷移を妨げない。** 散文の path 抽出は
    「prompt.ts の worker/rework テンプレと AGENTS.md」のような説明的表記を path 主張と誤認する偽陽性が避けられず
    （2026-09-02 実害 `t_e8c2ddb7825eb1ac`）、語彙調整で当てにいくと際限が無いため、fail-closed の対象を
    機械可読な主張（構造化 field・UI 証跡命名規約）に限定する。各候補の出所と判定は
    `handoffEvidence.claims.artifactPathClaims[]`（`path` / `source: structured|summary` / `missingIsFailure`）に残す。
- task body の機械可読宣言 `handoff-policy: <値>` で working tree ポリシーを選ぶ。**宣言が無い場合の既定は
  `no-commit` である**（2026-08-23 反転。それ以前は「未宣言 = 厳格」だった）。反転の理由は、§0 の役割境界が
  worker に commit を禁じているのに、旧既定が「worker は commit する」を前提にしていたためである。
  - **宣言の走査は行単位で行う。** body を行へ分割し、`^handoff-policy:` に前方一致する**最初の行**を唯一の
    宣言とみなす（以降の同種行は無視する）。その行が `/^handoff-policy:[ \t]*(\S+)[ \t]*$/` に一致した時だけ
    値が確定する。**旧記載の `/^handoff-policy:\s*(\S+)\s*$/m` は使わない** — JavaScript の `\s` は改行を
    含むため `handoff-policy:` の**次の行**の語を値として拾ってしまい、「最初の物理行」と「最初に一致した宣言」が
    食い違う。
  - 値は `no-commit` / `commit` の2つだけを認める。**それ以外の値、および `handoff-policy:` 行が存在するのに
    上記正規表現へ一致しない場合（値が空・値に空白が混じる等）は `invalid` とし、`commit` へ寄せずに
    それ自体を検証失敗として扱う**（`handoff-policy 宣言が不正` と分かる文言で失敗させる）。
    `commit` は単なる厳格モードではなく「worker の commit を許可する例外」なので、typo を `commit` へ
    寄せると禁止された commit を受理する権限拡張になる。
  - `handoff-policy: no-commit`（既定）の場合、outcome=`done` の working tree clean 検証を skip する。
    finalize は代わりに `git status --porcelain=v1`
    の dirty file 一覧（取得不能ならその旨）を完了コメントに記録し、オーケストレーターの裏取り材料にする。
    `handoffEvidence.warnings` が 1 件以上ある場合も同じ経路で、warning を 1 行ずつ完了コメントへ転記する
    （新しい event / request は作らない。2026-09-02 追記、t_63d2df1d3df8af74）。
  - 有効 policy が `no-commit`（既定による場合を含む）なのに **run 開始時点以降に作成された commit が
    存在した場合は違反として fail-closed** にする。判定の基準点は run 開始時の HEAD であり、run 開始前から
    存在した commit（orchestrator の先行コミット等）を違反にしてはならない。dirty tree による失敗とは
    **区別された文言**で失敗させ、どちらの規約に違反したのかがコメント・イベントから一意に読めるようにする。
    既定への反転で no-commit 違反の検出力を落としてはならない。
    - 既知の fail-open: commit 数を取得できない場合、および commit の帰属が判定不能（ambiguous）な場合は
      違反判定を行わない。この2ケースは違反なしとして通すのではなく、**判定できなかった旨を完了コメントへ
      残す**（オーケストレーターが裏取りできるようにするため）
  - commit claim の抽出と hash 照合（上記 commit claim の項）は **policy に依存せず常に行う**。policy が
    切り替えるのは (a) clean working tree を要求するか（`commit` のときだけ要求する）、
    (b) no-commit 違反検査を行うか（`no-commit` のときだけ行う）の2点だけである。
  - `evidence-dir: <絶対パス>`（正規表現 `/^evidence-dir:\s*(\S+)\s*$/m`、複数行可）がある場合、
    そのディレクトリを artifact claim の許可 root に追加する。相対パスは `cwd:` / task artifacts / `evidence-dir`
    配下で検証し、絶対パスも同 root 群の配下のみ許可する。
  - artifact claim が bare filename（パス区切り無し）の場合は、`evidence-dir` → `cwd:` → task artifacts の順で
    実在解決を試みる。これにより worker が `ocr-rule-drawer-footer.png` のようなファイル名だけを申告した場合も、
    宣言済み evidence dir 配下の実ファイルに解決できる。
- 既定が `no-commit` であることは §0 の役割境界（worker は worktree 内の実装のみ・commit しない）と一致する。
  worker へ `git add` / `git commit` を要求してこの責務境界を迂回してはならない。commit まで worker に委ねる
  例外的なタスクだけが `handoff-policy: commit` を明示し、その場合に限り dirty tree は fail-closed になる。
  成果物を cwd 外へ保存する場合は `evidence-dir` も宣言する（既定反転は evidence-dir の要否に影響しない）。
- 実装は 2026-08-23 に main へ統合済み（`228c4c4`）。既存 task body に残っている
  `handoff-policy: no-commit` 行は冗長なだけで無害なので、削除して回らない。
- 不一致時: finalize は `handoff_evidence_failed` イベントを記録し、open run を `failed` で close し、
  task を `review-required: handoff 証拠検証失敗 (session=<sid>)`（assignee=human）へ付け替える。
  transcript artifact 保存は従来と同じく best-effort。
## 43. メトリクス永続化 + /metrics（v0.9）

StageResult.actions・tick 所要時間等を捨てずに永続化し、PDCA を数値化する。

### 43.1 データ（migration v6 を予約）
- `tick_metrics` テーブル: ts / stage / actions / duration_ms（tick ごとに全ステージ分を記録。
  保持期間 90 日、超過分は tick 内で間引き削除）
- run 系メトリクス（成功率・rework 率・コスト）は task_runs / task_events からの**集計ビュー**
  （KanbanReadView にメソッド追加が必要な場合は types.ts 凍結のため orchestrator 経由）

### 43.2 表示
- `GET /api/metrics`（期間 query）と Web `/metrics` 画面: スループット（日別 done 数）/ run 成功率 /
  rework 率 / human_queue 滞留時間分布 / profile×provider 別の件数・コスト。§37 トーン準拠
- 週次レトロ: §29 schedule として登録できる週報タスク雛形（起票は統合時に CLI で行う）

## 44. lessons 複利化（v0.9）

### 44.1 データ（migration v7 を予約）
- `lessons` テーブル: id / created_at / trigger（rework|user-decision|needs-manual）/ tenant / cwd /
  profile / body / source_task_id
- 記録契機: review の verdict=fail 確定時のうち `failureCause` が `worker_local | worker_major` の
  ものと、user-decision 解消時に、原因要約を lesson として記録（trigger は前者が `rework`）。
  `spec_ambiguity | environment_evidence | late_requirement_change | unknown` は worker 起因でないため
  記録しない — §44.2 で worker prompt に注入すると、worker の責任でない原因を教訓として刷り込むため。
  これらの原因は `verdict_failed` payload（§21.1）と block reason に残り、orchestrator が回収する
  （v1 は supervisor が機械的に要約フィールドを埋める。LLM 蒸留は steward 連携の follow-up）

### 44.2 注入
- dispatch の buildWorkerPrompt: 対象タスクと同 tenant（+ 同 cwd prefix があれば優先）の直近 k=3 件を
  「過去の教訓」節として worker prompt に注入（貯めるだけでなく必ず使う）。prompt artifact で確認可能
- 週次蒸留（重複統合・恒久修正タスク起票）は §40 steward の入力拡張として別タスク

## 45. Web 設定画面 — config.json の UI 編集（v0.10）

目的: `$HACHI_KANBAN_HOME/config.json`（profiles / verify / notify / steward / review / dispatch 等）を
Web UI から安全に編集する（ユーザー要望 2026-07-06「ゆくゆく UI から設定できるように」）。
適用は既存の config hot-reload（tick ごとの再読込）に乗り、supervisor の再起動を要しない。

### 45.1 API
- `GET /api/config` — 現 config.json の内容 + `etag`（ファイル mtimeMs の文字列）を返す。
  設定は管理面のため read も §31 の共通 write 認可を要求する（tailnet 境界に加えて token を要求。
  read 系を認可対象にする初のエンドポイントであることを明示する）。
  config.json が存在しない場合は `{exists: false, config: null, etag: null}` を返す（DEFAULT_CONFIG は
  埋めない — 保存時に「完全形で新規作成」させる）。
- `PUT /api/config` — §31 write 認可必須。body = `{config: <完全形JSON>, baseEtag: string|null}`。
  1. zod（core の hachiConfigSchema、完全形）で検証。失敗は 400 + zod issues の要約
  2. 現ファイルの mtimeMs と baseEtag を照合。不一致は 409（並行編集検知。クライアントは再読込を促す）。
     ファイル未存在時は baseEtag=null のみ許可
  3. 書き込み前に現ファイルを `$HACHI_KANBAN_HOME/backups/config-<UTCts>.json` へ退避（存在時のみ）
  4. atomic write（同 dir の tmp ファイルに書いて rename）
  5. 応答: 新 etag。適用タイミング（次 tick）を meta で返す
- token 等の秘匿値は従来どおり config.json に置かない（telegram token は別ファイルパス参照のまま）。

### 45.2 UI（/settings）
- ルート `{name:"settings"}` を追加し、ヘッダの歯車アイコンから遷移
- セクションフォーム: profiles（profile 名 × provider/model/transport/effort、行の追加/削除）、
  notify（transports チェック、telegram chatId/baseUrl）、steward、verify.tenants、review、
  dispatch.providerLaunchLimits。フォームは zod スキーマ準拠で、未知キー・未対応セクションは
  「Raw JSON」タブ（テキストエリア）で保全編集できる（フォームと Raw は同一 state の双方向ビュー）
- profile の model 入力は自由入力を保ちつつ、選択中 provider の allowlist を datalist 候補として表示する。
  新規 config テンプレートの Codex allowlist は §7 の既定値と一致させる
- 保存は完全形 JSON を合成して PUT（partial 不可の原則を UI でも維持）。クライアント側でも
  同じ zod スキーマで事前検証し、エラーはフィールド近傍に表示
- write token の入力・保持は既存 WriteTokenModal の方式を踏襲
- 保存成功時は「次 tick から適用」を明示。409 受信時は再読込ボタンを提示
- §37.6 準拠（Radix/実績ライブラリ優先・自作 UI 基盤禁止）、§37.1 トークンでスタイル

### 45.3 ガードレール
- worker の live config 編集禁止（§32.4 の prompt 注意書き）は不変。UI 経由の PUT は人間の操作とみなす
- 保存時バックアップ（45.1-3）で誤保存からの手動復旧を可能にする
- 監査: PUT 成功時に supervisor 向けログ相当として web サーバーが変更セクション名の要約を stdout ログへ
  出力する（値そのものはログに出さない）

注: §43 は「handoff 証拠検証」と「メトリクス」で重複採番されている（並行起草の衝突痕）。参照 20 箇所の
同時更新を要するため改番は保留し、本書以降の新節は §45 から続番する。
## 46. ウォッチフラグ（スター）— 要確認マークとボード強調（v0.10）

目的: 進捗を追いたいタスクに人間/エージェント双方がスターを立て、ボードで動きを追いやすくする
（ユーザー要望 2026-07-06）。

### 46.1 データ
- `tasks.watched INTEGER NOT NULL DEFAULT 0`（0/1）。migration version 8（冪等 DDL、§12.9 の流儀）
- `TaskRow.watched: boolean`（凍結 types.ts はオーケストレーターが先行コミット）
- 変更は task_events に `watch_set` / `watch_cleared`（actor 付き）で監査記録する
- read view（board/task API）に watched を含める

### 46.2 CLI
- `hachi task watch <id>` / `hachi task unwatch <id>`（--json 対応）。冪等（既に同値なら no-op で成功）

### 46.3 Web
- write: `POST /api/tasks/:id/watch` / `DELETE /api/tasks/:id/watch`（§31 write 認可）
- タスクカードと詳細ヘッダにスタートグル（設定済み=塗り、未設定=輪郭。§37.6 準拠）
- ボード強調: watched カードは §37.1 トークンで控えめに — アクセント色の左ボーダー + スターバッジ
  + わずかな背景 tint。ノイズにしない
- ツールバーのフィルタに「ウォッチ中のみ」を追加（既存の bucket/フィルタ機構に合流）

### 46.4 非対象
- 通知連動（watched タスクの状態変化を §38 で push）は follow-up。本節はマークと表示のみ

### 46.5 ウォッチ通知連動（v0.10 で follow-up を実装）
- notify ステージの拡張: `watched=1` のタスクの `status_changed` イベントを、前回処理位置
  （`state/watch-notify.json` の lastEventId カーソル）以降から走査し、タスク単位に1通へまとめて
  §38 transport（telegram/macos）で通知する（title・from→to・詳細 URL。body の生文は送らず §38 の
  redaction 流儀に従う）
- カーソルは送信成功後にのみ前進（at-least-once。重複よりも取りこぼしを嫌う）。transport 失敗は
  warn ログのみで tick を止めない
- 人間確認キュー通知（既存）と重複する遷移は human-queue 側を優先し、watched 通知はスキップする

## 47. knowledge 面 — セッション知見の一次格納（v0.10）

目的: hermes-agent 退役決定（2026-07-07, t_a99dd712）に基づき、session-handover 等のセッション知見の
一次格納先を看板 DB にする（従来は Obsidian に書き出すのみで読み手が休眠）。Obsidian は view、看板が正本。

### 47.1 データ（migration version 9）
- `knowledge` テーブル: `id TEXT PK`（`k_` + 12hex）/ `title` / `body` / `source`
  （例: session-handover / orchestrator / steward）/ `tags`（JSON 配列文字列）/
  `importance INTEGER`（0-100、既定 50）/ `expires_at INTEGER NULL` / `origin_path TEXT`（取込元）/
  `content_hash TEXT UNIQUE`（本文 sha256。**冪等 ingest の鍵**）/ `actor` / `created_at` / `updated_at`
- `KnowledgeRow` を types.ts に追加（凍結ファイルはオーケストレーターが先行コミット）
- 書き込みは KanbanDb 経由のみ（§5 単一書込パス）。重複 content_hash の add は既存行を返す no-op

### 47.2 CLI
- `hachi knowledge add --title <t> (--body <text> | --file <path>) [--source s] [--tags a,b] [--importance n] [--json]`
- `hachi knowledge list [--tag t] [--source s] [--limit n] [--json]`（既定 20 件・expires 切れは除外、
  `--include-expired` で含める）
- `hachi knowledge show <id> [--json]`
- `hachi knowledge ingest-sessions --dir <path> [--json]` — session-handover ノート（YAML frontmatter:
  topic/tags/importance/expires_at/created + 本文）の一括取込。frontmatter 欠落は best-effort
  （title=先頭 H1 or ファイル名、source=session-handover）。content_hash で冪等（再実行安全）

### 47.3 利用面
- 起票時・設計時にオーケストレーター/planner が `knowledge list` で参照する（貯めるだけにしない）
- session-handover スキル側の書き込み追加（Obsidian 併記 → 看板一次）はスキル側の変更で対応（オーケストレーター作業）

### 47.4 follow-up（本節の対象外）
- 朝夕ブリーフ → §48 として実装
- steward プロンプトへの knowledge 注入（引き続き follow-up）

### 47.5 knowledge Web ビュー（v0.10 で follow-up を実装）
- `GET /api/knowledge?tag=&source=&q=&limit=` — read-only。tailnet 境界のため §31 認可対象外
  （board/task read と同格。knowledge に秘匿値を置かない運用が前提）。q は title/body の LIKE 検索
- Web `/knowledge` ルート: 一覧（title・tags チップ・importance・source・作成日時）+ 行クリックで
  本文表示（v1 は pre-wrap テキスト。markdown レンダリングは将来）+ tag/source フィルタ + 検索
- ヘッダーに knowledge への遷移アイコンを追加（§37.6 準拠）

## 48. 朝夕ブリーフ — knowledge + board の定時要約通知（v0.10）

目的: hermes-agent の morning brief / Evening Review の置き換え（退役決定 t_a99dd712・§47.4）。
ボードと knowledge の動きを定時に要約し、§38 transport（Telegram）へ届ける。

### 48.1 設定と起動
- config `brief`（任意。無ければステージは no-op）: `{ "times": ["07:30", "19:30"] }`。
  時刻はローカルタイム HH:MM。profile は `profiles.brief`（無ければ steward と同じ
  claude / claude-sonnet-5 / direct / medium に解決）
- supervisor に brief ステージを追加（steward と同じ短命 direct セッション方式・DI 注入）。
  各 tick で「未処理の配信時刻を跨いだか」を `state/brief.json`（lastRunAt・lastError・
  consecutiveFailures・autoDisabled）で判定。kill-switch は `~/.hachi-kanban/brief.disabled`、
  連続3失敗で auto-disable（steward §40 と同じ流儀）。**half-open による自動復帰も §40.1 と同一機構**
  （`auto-disable-circuit-breaker.ts` を共有。`autoDisabledAt` は optional field で欠落は即 half-open 可）
- doctorはbrief configが有効な場合に`state/brief.json`のschema、auto-disable、直近予定slotの完了を検査する。
  auto-disable復帰はstate手編集では行わず、§48.3のexact orchestrator provenanceとstate lock/auditを持つ
  `hachi admin brief-enable`だけを使う

### 48.2 生成と配信
- supervisor が store から材料を機械的に収集して prompt に埋める（LLM に DB を触らせない）:
  前回ブリーフ以降の done（title 列挙）/ 現在の人間確認キュー2レーン/ 自律進行中/
  期限内 knowledge の新着（title・tags）
- LLM の出力は**プレーンテキストの要約のみ**（400字目安・見出し1行 + 箇条書き）。提案・状態遷移は
  行わない（two-party gate: 送信は supervisor が実施）
- 配信は §38 の operational notify（telegram + macos）。失敗は warn + consecutiveFailures 加算

### 48.3 timeout 証跡と auto-disable の正規復帰

- brief の direct session は毎回0700の一時Git workspaceで起動し、live homeをcwdにしない。adapterは
  exact session stop capability必須とし、timeoutだけでなくstatus/fetch例外を含む全未完了経路でstopを試みる。
  workspaceは成功・失敗・timeoutの全経路で破棄する。
- Supervisorの構造化ログへ、秘匿prompt/outputを含めず、session開始、正常終端、timeout、stop結果
  (`stopped`/`reason`) とstop後のsession stateを残す。direct session state/out/exit fileと合わせて、開始、停止、
  残留有無、連続失敗回数を追跡可能にする。未完了sessionのstop失敗を成功や残留なしへ丸めない。
- 手動復帰入口は`hachi admin brief-enable [--apply] --actor-kind orchestrator --orchestrator <id>
  --session <id> --generation <n>`。既定はdry-runで、`--apply`だけがstateを変更する。human/unknown/service、
  旧generation、別identity、stale/closed sessionを拒否し、active exact principalをCore Storeで再照合する。
- 対象は`$HACHI_KANBAN_HOME/state/brief.json`の通常fileだけ。symlink、directory、非regular、上限超過、
  壊れたJSON、schema外値はmutation 0で拒否する。既にenabledまたはstate未作成はidempotent no-op。
- applyは既存`lastRunAt`を保持し、`consecutiveFailures=0`、`autoDisabled=false`、**`autoDisabledAt=0`**（§40.1.1 と同じ理由。**`claimGeneration` は +1 する**）、
  `autoDisabledReason=''`、`lastError=''`だけをatomic renameでresetする。state全文、失敗出力、reason全文を
  CLI・audit eventへ含めない。kill-switch`brief.disabled`は別authorityであり削除・迂回しない。
- CLIとSupervisorのstate writerは、後方互換のためhistorical nameを維持する
  `$HACHI_KANBAN_HOME/steward-state.lock`とguardをautomation共通lockとして使う。owner schemaへ
  `cli-brief-enable`/`supervisor-brief`を追加し、stale回収、0600、fsync、nonce再照合は§40.6と同じ契約に従う。
- changed applyはstate更新前に0600の`state/brief-enable.pending.json`をdurableに作り、operationIdと
  before/after SHA-256、保持する`lastRunAt`だけを記録する。crash回収、第三者更新の拒否、audit失敗時の
  hash/inode CAS rollbackは§40.6と同じ。**v2 の `compensatedHash` と3ハッシュ回収の分岐、
  v1 journal の2ハッシュ互換も §40.6 と同じ契約に従う**（2026-08-29）。成功/no-opは`brief_enabled` board audit eventへexact orchestrator
  provenanceとbounded payloadを残し、operationIdで冪等化する。dry-run、authority/file検証失敗はevent 0。
- enableは配信成功を偽装せず`lastRunAt`を進めない。次tickが未処理slotを再試行し、実sessionの正常終端と
  operational notify成功後だけ`lastRunAt`を更新する。live復帰完了はdoctorのauto-disable解消に加え、
  次の再試行が1回成功し、未完了direct session残留がないことまで確認する。

## 49. model_override の実効化 — override は direct transport を強制（v0.10）

背景（2026-07 時点）: bridge（even-terminal /api/prompt）はモデル指定を運べず（modelDelivery: "none"）、
`admin set-model` の per-task override が**実行に反映されない**ことが tenant-a 運用で顕在化した
（t_4ac6e9be。2026-07-07 の hachi-kanban 側 override run も全て delivery=none を確認）。

### 49.1 解決規則
- resolveModel の解決結果が `source=override` の場合、**transport を direct に強制**する
  （profile の transport 指定より優先）。direct adapter（§22 direct-codex / direct-claude）は
  モデルを実配信でき、modelDelivery: "native" が記録される
- **§49.4（v0.10、§67拡張）**: bridge が model/effort/speed パススルー capability を広告する場合に限り、
  dispatch は direct 強制を bridge へ**昇格**できる（resolveModel 自体は pure のまま = 出力不変。
  昇格判定は dispatch 側 resolveTransport が行う）
- allowlist・fail-closed（未知モデルは起動拒否）は従来どおり適用
- トレードオフの明示: direct セッションは bridge を経由しないため **G2/ライブビューに映らない**。
  override は「モデル厳密性 > 可視性」の例外運用と位置付ける（既定は profile どおり bridge）
- 記録: SessionRef / task_runs.meta に transport と modelDelivery を残し、`admin resolve` の
  出力にも transport（override による強制を含む）を表示する

### 49.2 タスク間 fan-out plan（v0.15）

1タスク=1ワーカーとworktree分離は維持する。タスク内で複数workerを暗黙spawnする代わりに、
planner/orchestratorが確定した親scope、3〜6件の子spec、排他的file ownership、依存DAG、統合gateを
`fanout-plan-input.v1`として明示し、Coreのpure関数が検証・canonical化した`fanout-plan.v1`を返す。
F1のplan段階はread-onlyであり、子task/link/binding/worktreeを作成せず、worker起動も行わない。

#### 49.2.1 入力・親snapshot

- 入力はJSON objectで、schema version、parent task ID、parent snapshot、repo common-dir、
  `scopeRoots`、`children`、`integrationGate`を必須とする。未知field、異形JSON、1MiB超の通常file、
  symlink入力fileをfail-closedで拒否する
- parent snapshotは少なくとも`taskId`、`updatedAt`、正規化済みbodyのSHA-256 `bodyHash`を持つ。
  hash生成後の親更新をF2 applyが検出できるよう、snapshotをcanonical出力とplan hashの双方へ含める
- bodyはCRLFをLFへ正規化し、末尾改行を1つにする。title、tenant、profile等の意味文字列を
  勝手にtrim・case変換しない。secretらしい値を診断やJSON出力へ反射しない
- repo common-dirは絶対・canonical pathであり、全child worktreeは絶対・正規化済み・相互に一意、
  `~/.hachi-kanban/worktrees/`配下でなければならない。plan時点では未作成を許すが、F2 apply前にhostが
  realpath、Git common-dir、既存worktree ownershipを再検証する

#### 49.2.2 ownership・scope検証

- `scopeRoots`と各childの`ownership`はrepo相対のfileまたはdirectory prefixだけを許可する。
  絶対path、空、`.`、`..`、escape、glob/wildcard、NUL、symlink spellingを拒否する
- path separatorとdot segmentを正規化し、prefix比較はdirectory境界で行う。単なる文字列prefix
  （例: `src/a`と`src/ab`）を祖先関係と扱わない
- 各childは1件以上を所有する。別child間の同一pathと祖先/子孫prefix重複を拒否する
- 各scope rootはexactly one childに被覆されなければならない。scope外ownership、未所有scope、
  複数childによる重複被覆はwarningへ落とさずplan全体を拒否する
- integration gateは全child keyを`requiredChildren`としてexactly once参照し、機能file ownershipを
  持たない。workerによるmerge command、自動conflict解消、main操作をspecへ含めてはならない

#### 49.2.3 child・依存DAG

- child keyは安全文字集合で一意、child数は3〜6件。各childはtitle/body/tenant/profile/worktree/
  ownership/dependsOnを明示する。`dependsOn`は同plan内の既存keyだけを参照し、自己依存、重複、循環を拒否する
- canonical出力ではchildrenをkey順、dependsOn・ownership・scopeRoots・requiredChildrenを重複除去後の
  辞書順に並べる。入力object key順や配列順へhashを依存させない
- 依存DAGとintegration gateはF2のtask/link生成、F3の統合判断の正本であり、apply時に暗黙追加・削除しない

#### 49.2.4 canonical JSON・plan hash

- Core pure関数は検証済み入力からversioned `fanout-plan.v1`とcanonical JSONを生成し、canonical JSONの
  SHA-256を`planHash`として返す。生成時刻、乱数、host固有の一時値をhash対象へ含めない
- hash対象にはschema version、parent ID/updatedAt/bodyHash、repo common-dir、全scope、child spec、
  ownership、worktree、依存、integration gateを含める。同一意味入力は同一hash、意味差は別hashになる
- canonicalizationまたはhash検証に失敗した場合はpartial planを返さず、board/worktree mutationを0に保つ

#### 49.2.5 CLI・副作用境界

- CLIは`hachi fanout plan --parent <taskId> --file <json> [--json]`。通常fileだけを読み、parentは
  `KanbanReadView`でread-only取得する。stdin、directory、device、symlink、1MiB超を拒否する
- 成功・失敗の双方でtasks、comments、events、links、bindings、worktree、Gitへのmutationは0。
  planは承認やapplyを意味せず、F2は明示承認された同一plan hashだけを別のgeneration-fenced経路で扱う
- Coreはschema/path/DAG/coverage/canonical hashのpure実装、CLIはfile境界・parent lookup・表示だけを担当する。
  LLM分解、自然言語scope推測、worktree作成、child ready化、自動mergeはF1の範囲外とする

#### 49.2.6 承認済み plan apply（F2）

- mutation入口は `hachi fanout apply` とし、`--parent <taskId>`、`--file <json>`、
  `--approved-plan-hash <sha256>`、`--orchestrator <id>`、`--session <id>`、`--generation <n>`を必須、
  `--json`を任意とする。入力を再canonical化して
  `approvedPlanHash`、canonical JSONのSHA-256、plan内hash、plan payloadの4者を照合し、1つでも不一致なら
  tasks/comments/events/links/bindingsのmutationを0に保って拒否する
- 初回applyは親の`updatedAt`/body hash snapshot、repo common-dir、親の単一primary binding、stable
  orchestrator identityとactive session/generationを同一Store transaction内で再検証する。既存applyのretryも
  activeな同一stable identityからだけ許可し、session交代後は新しいactive generationで再開できる
- repo common-dirは単なるcanonical directoryでは足りず、`GIT_*`を継承しないread-only Git probeで
  実Git common-dirと一致しなければならない。既存child worktreeも同じcommon-dirへの所属を再検証し、
  未作成worktreeは既存祖先にsymlink/non-directoryがないことを確認する。applyはworktreeを作成しない
- 初回applyは全childを`todo`で作成し、cwd、`subtask`、`depends-on`、primary orchestrator bindingを
  planどおりに付与する。childを`ready`へ移さず、worker起動・Git mutation・mergeを行わない。途中例外は
  transaction全体をrollbackし、同一planの再実行で重複task/link/bindingを生成しない
- durable authorityは通常task commentではなく、同一transactionでCore内部だけが生成するstrictな
  `fanout_plan_applied` eventとする。payloadはversion、parent ID、plan hash、orchestrator/session/generation、
  child key/task ID対応を保持する。表示用commentはauthorityに使わず、通常commentの事前偽造で既存taskを
  childへ取り込めない。authority eventの複数存在、破損、child key/task ID重複、異plan/identityは
  fail-closedで拒否する
- 同一plan retryはauthority eventに対応するchild集合、title/body（cwdを含む）、tenant/profile、許容status、
  親subtask集合、全depends-on集合、primary ownershipを照合する。status以外のspecやplan管理linkにdriftが
  あれば自動修復・上書きせず拒否する。bodyのrework prepend等、plan spec変更が必要な場合は新plan/hashを
  明示承認する
- DB-level UNIQUE migrationはF2では追加せず、SQLite transactionとauthority eventの複数検出で
  fail-closedにする。別connectionからの同一planは1組へ収束し、異planは既存authorityとのhash不一致で拒否する

### 49.3 effort_override — タスク単位の effort 指定（v0.10 拡張）
- `tasks.effort_override TEXT NOT NULL DEFAULT ''`（migration version 10。空 = 指定なし）。
  値は §35 の EffortLevel（low/medium/high/xhigh/max）のみ許可し、maxは§59/§67のmodel policyで検証する
- `TaskRow.effortOverride: EffortLevel | ""`（凍結 types.ts はオーケストレーターが先行コミット）
- resolveModel: effort_override が非空なら profile の effort より優先し、**transport を direct に強制**
  （bridge は effort 不搬送のため。§49.1 の model_override と同じ規則・同じトレードオフ = G2 非表示）。
  model_override と併用可（どちらか一方でも direct 強制）
- CLI: `hachi admin set-effort <id> <effort>` / `--clear`。`admin resolve` に effort と強制理由を表示
- 起票時指定: `hachi task create` の `--model <m>` / `--effort <e>` / `--speed <s>` と§67のreviewer
  flagsは作成と同じtransactionで保存・解決する。execution指定時はexact orchestrator provenanceを必須とする
- 監査: set-model / set-effort の変更は task_events（`override_changed`、actor 付き）に記録する

### 49.4 bridge パススルー連携（v0.10。even-terminal escrow パッチ前提）
- **capability probe**: token 付き `GET /api/info?provider=<provider>` の `capabilities.<provider>` に
  `model-passthrough-v1` / `effort-passthrough-v1` / `speed-passthrough-v1` が広告されている場合のみ
  対応する値をパススルー可能と判定する。**claude も同型で扱う**（2026-08-20〜。それ以前は
  claude bridge が広告を持たず、profile 由来の model が runtime 既定へ黙って落ちていた）。
  probe は identity probe と別関数・tick 単位キャッシュ。**取得失敗・non-2xx は「capability 不明」として
  direct を選択 + warn ログ**（「広告なし」と同一視して黙殺しない）
- **ターン上限（claude bridge。2026-08-20〜）**: even-terminal の既定は 50 ターンで、自律ワーカーは
  handoff を書く前に打ち切られる。ClaudeAdapter は `maxTurns` を body へ載せて引き上げる
  （runtime 側の受理は 1〜2000 の整数。capability は `max-turns-passthrough-v1`、応答は
  `maxTurnsDelivery` / `appliedMaxTurns`）。**未対応 runtime は body を黙って無視し 202 を返す**ため
  起動時には検知できない。打ち切り自体は `run_truncated_max_turns` として分類する（§53.0）
- **resolveTransport（dispatch 側・pure）**: resolution が override 由来の direct でも、タスクの
  **全 override**（model / effort / speed）を native 配信できる capability が揃う場合に限り
  bridge へ昇格する。片方でも欠ければ direct のまま。run meta には**実際に選ばれた transport** を記録する
- **任意のbridge昇格候補の事前互換性（2026-09-09）**: 上記capabilityの充足は昇格候補であり、
  外部POST前にfull bridge snapshotの必要passthrough tokenとtrusted model×transport requirementを
  同じsnapshotで検査し、互換性がsupportedの場合だけ昇格を確定する。解決済みのprofile由来effort/speedも
  既存requirementで検査する。speed省略をstandardへ補完しない。候補がunsupported/unknown、probe失敗、
  full snapshotでtoken欠落なら元のdirectを維持し、direct自身の互換性がsupportedの場合だけ起動する。
  pre-claimとclaim後再検証は同じ選択規則を使い、既存fingerprint/CASによる再利用条件を保つ。
  最終compatibility eventとrun metaは実際の選択transportを示す。未採択bridge候補のunknownでtaskをblockしない。
  この規則はpassthrough-promoted候補に限り、元からconfigured bridgeのcompatibility拒否や既存Claude
  maxTurns capabilityによるPOST前選択、下表の409/202/non-2xx処理を変更しない。POST後fallbackの追加ではない。
- **起動時のフォールバック表（at-most-once 両立・codex plan review 3巡で確定）**:

| 状況 | 挙動 |
|---|---|
| capability なし（POST 前判明） | POST せず direct（従来） |
| POST → `409 {code:"model-passthrough-rejected", sessionCreated:false}` | 副作用なし確定 → 同一 claim 内で direct フォールバック |
| POST → その他 non-2xx | フォールバックしない（従来の launch 失敗 = auto-launch-failed） |
| POST → 202 だが native 確認欠落 | **direct へ落とさない**（二重実行禁止）。run 記録の上 `needs-manual: bridge native 確認欠落` + 孤児中断注入（§51/§52 経路） |
| POST → 202 + `modelDelivery:"native"`（+必要なら effort/speed delivery） | bridge のまま（G2 可視・worker commit 可） |

- **「native 確認」の定義（2026-08-23 オーケストレーター決定）**: 上表の
  `202 + modelDelivery:"native"` 行は、**フラグ単独では成立しない**。盤は要求した項目ごとに
  次の3つが揃った時だけ native 確認済みと判定する。対象は **model / effort / speed / maxTurns の
  4項目すべて**（`maxTurns` は claude が常時送るため除外しない）。
  1. 対応する delivery フラグが `"native"`
  2. 対応する applied 値（`appliedModel` / `appliedEffort` / `appliedSpeed` / `appliedMaxTurns`）が
     応答に存在し、`null` でない
  3. applied 値が要求値と**一致する**（前後空白を除いた文字列一致。数値は数値として比較。
     エイリアス解決は行わない）

  1つでも欠ければ「202 だが native 確認欠落」の行へ倒す（**direct へは落とさない**）。
  エイリアスで偽陽性が出た場合も needs-manual として可視化されるので、黙って別モデルで走るより良い
  （その時は bridge が要求値をそのまま echo する側を直す）。

  **applied 値の意味は「runtime が provider へ実際に渡した値」であり、provider が最終的に選んだ
  モデルの観測値ではない。** 過大に読まないこと。それでも delivery フラグより厳密に強い —
  bridge runtime の claude 経路は allowlist 外のモデルを黙って捨てたまま `appliedModel` を
  `null` で返す一方、**model が要求されただけで `modelDelivery:"native"` を立てる**ことがある。
  = **拒否されたモデルは「applied=null なのに delivery=native」として現れる**ので、上記 2. が
  これを捕まえる。provider 内部での事後的な差し替えはこの検査の射程外であり、それを検知するには
  runtime がセッション初期化後の観測値を返す必要がある。

  **provider ごとに成熟度が違う（実測 2026-08-23）:**

  | 経路 | 現状 | 上記のどれが捕まえるか |
  |---|---|---|
  | codex の model / effort | **既に正しい。** runtime がセッション開始時の実値と要求を比較し、不一致なら applied 値を丸ごと `null` にする＝delivery フラグ自体が立たない。これは真の事後観測値 | 現状で既に安全 |
  | claude の model / effort | **要注意。** allowlist 外を黙って捨て、`appliedModel` は `null`。なのに delivery は `"native"` が立つことがある | 2.（applied が null） |
  | codex の `maxTurns` | **要注意だが現状は到達不能。** 応答に applied 値が**欠落**しうる（一方 `maxTurnsDelivery:"native"` は立つ）。ただし `CodexAdapter` は `maxTurns` を送らない（送るのは `ClaudeAdapter` だけ）ので、この分岐は今日は踏まれない | 2.（applied が不在） |
  | claude の `maxTurns` | **概ね正しい。** 受理できた値は `appliedMaxTurns` として返る。範囲外（1〜2000 の整数以外）を要求した場合だけ黙って捨て、上流既定の 50 が返る | 3.（要求値と不一致） |

  盤側の突き合わせは追加通信ゼロで行える。bridge 側の是正（409 で弾く）と**両方**行う —
  盤は自分が制御しない vendored 部品の自己申告に `requireNativeModelDelivery` の担保を委ねない。
  **`maxTurns` を codex へ送り始める変更は、この規則の下では codex の全 run を
  native 確認欠落にする**（上表の理由）。送り始める前に bridge runtime 側が `appliedMaxTurns` を
  返すようにすること。fail-closed 自体は意図どおりだが、無自覚に踏むと全レーンが止まる。

  実装は `SessionRef` / `PromptResponse` への `maxTurnsDelivery` / `appliedMaxTurns` の追加
  （現状 `packages/adapters/src/session.ts` は未パース）と、`hasRequiredNativeDelivery`
  （`packages/supervisor/src/execution-preflight.ts`）を delivery フラグ単独判定から
  applied 一致判定へ拡張することを含む。
- §13 拡張: `/api/prompt` body に optional `model` / `effort` / `speed`。パッチ済み bridge は適用時のみ
  応答へ各deliveryと`appliedModel` / `appliedEffort` / `appliedSpeed`を付与し、適用不能・不正・
  `sessionId` 併用は上記 409 で**セッション未作成のまま**拒否する。未パッチ bridge はフィールドを無視して
  従来応答を返す（後方互換。native 確認が無いので hachi は流さない → 実害なし）
- MockBridgeServer（testing）は capability あり/なしの両モードを持ち、native echo・409・後方互換の
  全分岐をテスト可能にする


### 49.5 passthrough patch status の盤側検査（v0.15）

even-terminal の passthrough パッチは hermes の wrapper が bridge 起動のたびに適用し、結果を
`$HERMES_HOME/even-shared/passthrough-patch-status.json` へ書く（`HERMES_HOME` 未設定時は
`$HOME/.hermes-hachi-dev`）。**この JSON は repo をまたぐ契約なので、形と判定を本節で固定する。**
（2026-08-23 追加。それ以前は doctor 実装とテスト fixture が事実上の仕様になっていた）

**本節は仕様先行であり、統合されるまで実装は本節どおりに動かない。** writer（hermes 側 wrapper）と
doctor 側の実装、`DoctorCheck.reason` の値追加、パス解決の依存注入は同時に着地させる。

#### 49.5.1 ファイル形式

| key | 型 | 必須 | 備考 |
|---|---|---|---|
| `schema` | string | 必須 | `"passthrough-patch-status/v1"` 固定 |
| `state` | string | 必須 | **`ok` / `error` / `applying` の3値のみ**。増やす場合は本節を先に更新する |
| `evenTerminalVersion` | string | 必須 | 空文字を許さない |
| `updatedAt` | string | 必須 | **RFC 3339（タイムゾーンオフセット必須）**。オフセット無しを受理しない |
| `detail` | string | 必須 | 空文字可 |
| `patchVersion` | string \| null | 必須 | 未確定時は `null`。**空文字は使わない** |
| `bridgePid` | number \| null | 必須 | 下記 49.5.2 |

- 未知キーは無視する（additive を許す）。ただし上表のキーが1つでも欠ける・型が違う場合は不正とする
- 文字列値の上限は各 1,000 文字とし、超過は不正として扱う

#### 49.5.2 鮮度は時刻ではなく bridge プロセス同一性で判定する

**絶対時間の閾値を使わない。** 長時間安定稼働している健全な bridge を誤って NG にする一方、
wrapper を status 非対応版へロールバックした直後を検知できないため、閾値は両方向に間違う。

`updatedAt` と bridge プロセス起動時刻の比較も使わない。**wrapper は spawn より前に apply.sh を
実行するため、健全な起動でも `updatedAt` は必ず bridge プロセス起動時刻より古くなる**
（前身システム側 `legacy-hermes:scripts/kanban-shared-app-server.sh` の apply→spawn 順。本リポジトリには含まれない）。時刻比較は健全な起動を全て NG にする。

代わりにプロセス同一性で判定する:

- wrapper は apply 結果を書いた後、bridge を spawn し、**spawn した PID を `bridgePid` として
  status へ書き戻す**（同一ファイルの atomic rewrite。`state` 等は書き換えない）
- spawn に至らなかった場合（apply 失敗で起動を拒否した場合を含む）は `bridgePid: null` のままにする
- doctor は bridge port を LISTEN しているプロセスの PID を取り、`bridgePid` と**一致すること**を要求する

#### 49.5.3 doctor の判定（fail-closed）

| 状況 | 判定 |
|---|---|
| 使用中 profile に bridge が1件も無い | `{ok:true, skipped:true, reason:"unused-transport"}`（§59.5 の既存規約） |
| bridge を使うが status ファイルが無い | `{ok:true, skipped:true, reason:"writer-not-deployed"}`。**readiness の証明ではないことを detail に書く** |
| bridge が LISTEN していない | `{ok:true, skipped:true, reason:"bridge-not-running"}`。停止中の同一性判定は意味を持たない |
| 読み取り失敗 / JSON 解析失敗 / root が object でない / `schema` 不正・未知 / 49.5.1 のキー不正 | **`ok:false`**。ファイルが在る = writer 稼働中であり、信号だけが壊れている状態を素通しさせない |
| `state` が `ok` 以外（未知値を含む） | **`ok:false`**。`applying` は過渡状態なので detail に「数秒後に再実行」を添える |
| `state=ok` だが `bridgePid` が現に LISTEN している PID と一致しない（`null` を含む） | **`ok:false`**。前世代の status を現行 bridge の健全性の証拠にしない |
| bridge は LISTEN しているが、その PID を決定できない | **`ok:false`**（`unknown` を ok へ倒さない） |

#### 49.5.4 出力と依存の規律

- **`DoctorCheck` に第3状態（`warning` 等）を追加しない。** §59.5 は JSON を additive に保ち
  `name/ok/detail` と fail-closed 判定を維持すると定めている。「該当なし」は既存の
  `skipped` + `reason` で表す。`checks[].ok` だけを見る自動化から区別できない中間状態を作らない。
  本節が使う `reason` の値（`writer-not-deployed` / `bridge-not-running`）は
  `DoctorCheck.reason` の許容値へ追加する（凍結契約の変更なのでオーケストレーターが先行コミットする）
- **status 由来の文字列は detail 以外もすべてサニタイズしてから出力へ埋める**
  （`schema` / `evenTerminalVersion` / `updatedAt` / `patchVersion`）。doctor の出力は行志向なので、
  外部プロセスが書いた改行入りの値をそのまま埋めると、存在しない `[OK] ...` 行を注入できる
- **パスは注入可能な依存として渡す**（`process.env` の直読みをしない。既定パス分岐がテスト不能になる）。
  現行の `Environment` は `HERMES_HOME` も OS home も持たないため、解決済みパスまたは `hermesHome` を
  依存として追加する。これも凍結契約の変更なのでオーケストレーターが先行コミットする

## 50. 終端待機の一元化 — task await + supervisor 内蔵 stall 検知（v0.10）

背景: オーケストレーターがレーンごとに手組みのポーリング watcher を background 起動する運用は重く、
自作ループの無言故障（lessons 2026-07-03 ほか）と検知遅延（2026-07-08 ユーザー指摘）の温床だった。
監視の機械部分を CLI / supervisor へ移し、オーケストレーターは「1コマンドを待つだけ」にする。

### 50.1 `hachi task await`
- `hachi task await [<id>...] [--all] [--follow-new] [--interval <sec>=5] [--max-wait <sec>] [--json]`
- 指定タスク（`--all` なら現在稼働中 = ready / review / blocked+in-progress の全タスク）のうち
  **1つ以上が終端に達するまでブロック**し、達したタスクの `{id, status, blockReason}` を出力して exit 0。
  終端判定は §14.4 と同じ（not running）。`--max-wait` 超過は exit 2（何も出力しない）
- 実装は read-only の DB ポーリング（既定 5 秒。書き込み・イベント記録なし）。`--all` は待機開始時点の
  稼働集合を対象に固定する（途中参加のタスクは対象外 — 意図しない待ち伸びを防ぐ）。
  固定は `resolveAwaitInitialTargets`（1回だけ集合を取る）と `runAwait`（`targetIds` へ固定）で起きる。
  初期集合が空なら即時 exit 0（何も出力しない）
- **`--all --follow-new`（2026-08-29 実装。main=cd1582c）**: 上の固定により、arm 後に ready 化された
  タスクの終端はその await に映らない。これを塞ぐ opt-in フラグ。**`--all` 単独の意味は変えない。**
  - `--follow-new` は `--all` とだけ併用できる（id 指定との併用は拒否）
  - arm 時に、稼働集合と `task_events` の高水位を**同一 read-only transaction** で取得する
  - 以後は**イベント ID カーソル**で状態遷移を追う（`id > cursor ORDER BY id ASC LIMIT 200`）。
    **単純な「毎ポーリングで稼働集合を取り直す」実装にしてはならない** —
    ポーリング間隔内に ready から終端まで進んだ短命タスクを取りこぼすため
  - カーソルは**消費したイベントまでしか前進させない**。1ページ上限に達した場合は追加取得して
    backlog を消化するので、**1回の呼び出しの中では**イベント欠落が起きない
  - **既知の限界: `--cursor-file` を指定しない場合、カーソルは呼び出しをまたいで永続化されない。**
    `task await` は最初の終端を出力して exit するため、**exit から次の arm までの間に別タスクが
    終端すると、その終端は次の arm の高水位に飲まれ、かつ終端済みなので初期対象からも外れる**。
    結果その1件は永久に報告されない。ループで回す運用では**再アームの窓が盲点になる**。
    運用上の要点は knowledge `k_67651836ec59`。
    **恒久対策は下の §50.1.1（`--cursor-file`）で契約化した**（方式比較 `t_3ccb19467e572661`、
    2026-08-29 採択。**契約のみで実装は未了**）
  - `--follow-new` では初期稼働集合が空でも待機を継続する。`--max-wait` 超過のみ exit 2
  - 採択判断は `t_db91a6919fe389cd` コメント #4025、実装は `t_deaedfa752892fd3`
- 用途: オーケストレーターはセッションごとに `hachi task await --all --follow-new` を background に1本置く。
  発火 → 終端処理 → 再度 await、のシンプルな運用に統一（per-lane watcher の手組みを廃止）。
  **後発タスクを個別に待つ場合の `hachi task await <id>` は one-shot にする**
  （終端済みタスクに対しては即座に返るため、再アームするループにすると同じ終端を数秒ごとに
  再発火し続ける。2026-08-29 実害）
- `needs-manual` / `review-required` / `auto-launch-failed` を再ready化する直前は、対象identity/bindingを確認し、
  open runが0件であることを正規CLI/read viewから再確認する。bridge runのopen sessionが残る、またはstatusを
  確認できない場合は、同一worktreeへのreplacement runを起動せず回収待ちを維持する。

#### 50.1.1 `--cursor-file` — 再アーム窓を塞ぐ checkpoint（2026-08-29 採択 / 2026-08-30 実装・同日 P1 1件 + P2 2件を修正して運用可）

> 方式比較 `t_3ccb19467e572661` の推奨案 **A1** を採択した。比較した4案は
> A1（state file + 明示 `--cursor-file`）/ A2（board DB へ checkpoint テーブル）/
> B（継続 stream 化）/ C（再アーム時 reconciliation）。
> **A2 は board DB を read-only とする本節の契約を破り**、migration・provenance・行 cleanup・
> writer 競合を持ち込むため採らない。**B は正常稼働中の再アーム窓は消せるが、プロセス再起動時の
> 欠落が残る**ので単独では恒久対策にならない（`t_db91a6919fe389cd` #4025 で stream を見送った
> 理由はこの比較で弱まったが、結論は変わらない）。**C は完全版が A1 の resume 処理そのものになる**
> ため独立案として成立しない。将来 A1 の checkpoint を再利用して stream を足す余地は残す。

- 構文: `hachi task await --all --follow-new --json --cursor-file <path> [...]`。
  **`--cursor-file` は `--follow-new` とだけ併用できる**（`--all` 単独・id 指定との併用は拒否）。
  **`--cursor-file` は `--json` を必須とする** — at-least-once は重複配信を許すので、
  受け手が重複を落とすための `dedupeKey` が要る。**text 出力にはそれを載せる場所が無い**ため、
  `--json` なしの `--cursor-file` は拒否する
- **保存するのは cursor 単体ではない。** `eventCursor` だけを保存しても、再開時点で既に終端した
  タスクは arm が取り直す稼働集合に入らず、`targetIds` に無いものは終端として報告されないため、
  **結局その1件は落ちる**。したがって checkpoint は
  **`schemaVersion` / board 識別子 / `eventCursor` / `targetIds` を一体**で持つ
- **board DB は read-only のままとする。** checkpoint の書き込み先は
  `$HACHI_KANBAN_HOME/state/task-await/` 配下の指定ファイルに限り、本節の
  「実装は read-only の DB ポーリング（書き込み・イベント記録なし）」はこの例外を除いて維持する
- **`--cursor-file` は利用者入力なので封じ込めを契約にする。** 受け付けるのは
  `$HACHI_KANBAN_HOME/state/task-await/` からの**相対パス**とし、`..` を含むもの、絶対パス、
  **解決後（symlink 解決を含む）にこの directory の外を指すもの**は拒否する。
  **既存の target が symlink / 非 regular file / hard link されているものは奪わず失敗する。**
  **ファイル名は正規文法に制限する: 小文字 ASCII 英数と `-` `_` `.` のみ**（大文字を拒否する）。
  macOS の APFS など **case-insensitive なファイルシステムでは `watch.json` と `WATCH.json` が
  同一ファイルを指す**が、**checkpoint がまだ存在しない初回作成時は実体を canonical 化できない**ため、
  そのままだと 2 つの watcher が別々の sidecar lock を取り、同じ checkpoint を上書きし合う。
  **並行初回作成（大文字小文字違いの別名）のテストを必須とする**
  checkpoint 本体・temp file・sidecar lock はいずれも **0600 で作成**し、
  想定外の所有者・mode・サイズ上限超過も fail-closed で拒否する
- **初回**（ファイル不在）: 現行どおり稼働集合と `task_events` の高水位を同一 read-only transaction で
  取得する。**過去の終端を遡って再生しない**。
  **取得した初回 checkpoint は、待機に入る前に atomic かつ durable に保存する。**
  保存前に待機へ入ると、arm 後・最初の出力前にクラッシュした場合にファイルが残らず、
  再起動時に新しい高水位が終端を飲み込んで**本節が塞ぐはずの欠落がそのまま再現する**
- **初期化途中でのクラッシュ**: 保存が完了していない checkpoint は「不在」と同じに扱い、
  初回として arm し直す（部分書き込みが残らないよう temp file + atomic rename を使う）
- **再開**（ファイル存在）: 保存された `eventCursor` からイベントを再生する。
  **新しい `MAX(id)` へ飛ばさない。** `targetIds` は保存値を復元したうえで arm 時点の稼働集合と合併する
- **ファイル名は中間 directory を作らない。`sub/watcher.json` は ENOENT で失敗する（2026-08-31 明文化）。**
  実装（`packages/core/src/task-await-checkpoint.ts` の `checkpointParent`）は各階層を
  `inspectDirectory` で**検査するだけ**で作成しない。入れ子名を使うなら
  **呼び出し側が 0700 で事前に作成する**こと。
  **自動作成しないことを契約とする** — 自動作成すると打ち間違えた名前が新しい checkpoint として
  黙って成立し、**その watcher は初回扱いで arm し直すので本節が塞いだ再アーム窓が再び開く**。
  存在しない親で**大きな音を立てて失敗するほうが安全**である。
- **checkpoint 名は世代・セッションを含めない安定した論理名にする（2026-08-31 明文化）。**
  **`<board>-<責務>.json`（例 `dev-orchestrator-main.json`）で名付ける。**
  `gen29-terminal.json` のような世代入りの名前は、**世代交代のたびに新しい checkpoint になり
  初回扱いで arm し直す**ため、引き継ぎの瞬間に本節が塞いだ再アーム窓が毎回開く。
  ファイルを分ける単位は**論理 watcher**であって、セッションでも世代でもない。
  **board 名を必ず含める** — `state/task-await/` は board 間で共有される単一 directory なので、
  board 非依存の名前は衝突する。同時なら sidecar lock で、逐次なら checkpoint の
  board 識別子不一致で fail-closed になり、**どちらの場合も一方の board が無監視になる**。
- **所有権**: checkpoint ファイルは呼び出し元が所有する**論理 watcher 単位**で1つ。
  **同一ファイルの同時利用は fail-closed で拒否する**。複数 watcher は別ファイルにする
- **排他は caller process 自身が保持する private FD の `flock(LOCK_EX|LOCK_NB)` とする（2026-09-05 是正）。**
  共有実装は `packages/core/src/sidecar-lock.ts` の同期 `acquireSidecarLock` / `assertOpenAndLocked` / `close`。
  Node 標準 API に syscall はないため `fs-ext@2.1.1` と `@types/fs-ext@2.0.3` を列挙依存とし、
  `pnpm.onlyBuiltDependencies` に `fs-ext` を許可する。非対応・build/load失敗は開始拒否し、
  SQLite / O_EXCL / marker / PID 推測へ fallback しない。
  - 唯一の lock 名は `$HACHI_KANBAN_HOME/state/task-await/.locks/<canonical-checkpoint-path-hash>.flock`。
    hash導出と予約namespaceは従来どおり。markerは同stemの `.owner`、lockは空file（`maxBytes=0`）とする。
  - lock取得とownership依存操作は同じprocessが行う。private FDは外部へ返さず、childへ継承せず、
    `close` 以外でunlock/closeしない。別FDのcloseで解除されるPOSIX record lockを使わない。
    `inTransaction`・marker・inode・競合probeのbusyは単独の所有証明にしない。
  - `lstat` / no-follow open / `fstat` によりcanonical path、current uid、regular file、0600、
    `nlink=1`、size上限、取得時のdev/ino/uidとの一致を検査する。directoryのnlink=1は要求しない。
    task-await / .locks / checkpoint親の各directoryの封じ込め・0700・identity検査を維持する。
    lockは非破壊openし、既存fileをtruncate/unlinkしない。
  - OS lock取得後に、取得単位のrandom tokenをmarkerへ0600/atomic publishする。markerは
    regular/current uid/0600/nlink=1/64 bytes以下を検査し、構造が正常なstale markerだけを上書きする。
    markerは診断・世代照合であり取得対象ではない。各操作前にtoken不一致を拒否する。
  - 各ownership依存操作前にclosed flag、private FD / pathname / 取得時identityの三者一致、
    file属性、指定directory群の取得時identity、markerを同期検査する。assertでflockの再取得をしない。
    初回検証失敗は一次errorを保存して不可逆にpoison化し、操作を拒否する。poison後のassertは
    同じ一次errorを再throwし、復元・再検査・再取得でopenへ戻さない。assert失敗自体はunlock/FD closeや
    既存process registry entryの削除を行わず、失われたentryを復活させない。identity未証明のpathを削除しない。
    callerはcloseの責任を持つ。task-awaitはassert catchでstoreを先にclosed化して即closeし、cleanup errorで
    一次検証errorを隠さない。D1は§78.1どおり新規操作を拒否し、既開始recorderのsettle後にcloseする。
    poison中の競合busy保証は取得lock inodeとregistry identityが維持された場合に限る。
  - closeはopen/poisonedのどちらからも先にclosed化し、unlock失敗時も最終FD closeとregistry解放を必ず行う。二重closeはno-op。
    同processの二重取得はregistryで拒否し、他process競合はbusyとして拒否する。
  - 前後identity検査はnamespace差替えの検出であり、pathname操作・非同期処理との原子性を保証しない。
    同uidの非協調processによるprivate FD操作・namespaceの同時改変は脅威境界外とし、
    観測したidentity不一致はfail-closedにする。アプリケーション側のfencing/idempotencyは別途維持する。
  - v1 SQLiteとv2 flockは相互排他でない。**rolling coexistenceは禁止**。
    hostが全旧task-await watcher/旧D1の停止証拠を確認してからv2だけを起動する。
    旧.sqliteを自動削除しない。異常終了・SIGKILLはkernel解放、SIGSTOP中はbusy維持を検証する。
  - **Linux CIでnative build・競合時排他・SIGKILL後の解放が成功することを必須gateとする。**
    macOSの成功で代用せず、不通過なら実装を採択・展開しない。publicationと旧/new切替は、
    Linux gateおよび旧processのexact停止証拠をhostが確認した後にのみ行う。
  本条項は従来のSQLite採用とowner-marker単独証明を置換する。下記2026-08-30の修正履歴は
  当時の実装記録であり、v2の所有証明や現在のbackendを表さない。
- **lock は checkpoint 本体とは別 inode の sidecar（上記 `.locks/` 配下のファイル）に取る。
  checkpoint 本体を lock 対象にしてはならない。** 本節は checkpoint を temp file + atomic rename で
  更新するため、**本体を lock すると rename で inode が入れ替わり、2本目の watcher が新しい inode を
  lock できてしまう**（同一の論理 checkpoint を二重に更新でき、cursor の巻き戻し・重複・
  終端の取りこぼしが起きる）。sidecar は**保持中に rename も削除もしない**
- **lock の取得は checkpoint を読む前・作る前に行い、watcher の生存期間中ずっと保持する**
- **配信保証**: 出力後に atomic な checkpoint 更新を行う。クラッシュ境界では**欠落より重複を選ぶ
  at-least-once** とし、受け手が重複を落とせるよう出力 JSON に安定した dedupe key を加える
- **「出力後」の commit point を明示する。** `stdout.write()` の呼び出しは配信の完了ではない
  （バッファリングと backpressure がある）。**checkpoint を前進させてよいのは、その1件の
  レコード全体が stdout へ書き終わったこと（write の完了コールバック／drain）を確認した後**とする。
  write エラーは checkpoint を前進させずに失敗させる。
  **保証の範囲は「stdout への引き渡しの成功」までであり、受け手が読んだことまでは保証しない**
  （それ以上は本節の責務ではない。受け手側は dedupe key で重複を落とす）
- **1回の取得で複数の終端が出る場合の commit 単位を決める。** 現行のスキャンは
  **1ページ分を取り切ってから最後のイベント ID までカーソルを進める**ため、素朴に
  「最初の1件を出したら checkpoint」とすると、**2件目を出す前に落ちた時に2件目が飛ぶ**
  （at-least-once に反する）。したがって **checkpoint は「実際に出力し終えたイベント」までしか
  進めない**。実装は次のどちらかとする:
  - バッチ全件を出力し終えてから、そのバッチの最終イベント ID で1回 checkpoint する
  - **1イベントずつ「消費 → `targetIds` 更新 → 出力 → checkpoint」を回す**
  **どちらの場合も不変条件は同じ: 保存する `targetIds` は、`eventCursor` までのイベント接頭辞を
  ちょうど反映した状態でなければならない。** 現行コードは1ページを消費し切ってから結果を出すため、
  素朴に実装すると**イベント 101・102 がタスク A・B を終端させた時、A だけ出力して
  cursor=101 と「既に A も B も取り除かれた `targetIds`」を保存**しうる。
  この組み合わせでクラッシュすると **B は二度と報告されない**（at-least-once に反する）
  **クラッシュテストの必須ケース: (1) 1ページに終端が複数含まれる場合、(2) 出力の途中で
  stdout が失敗した場合、(3) 同一タスクが1ページ内で `終端 → 再走行 → 終端` する場合。**
  (3) は現行実装が**同一ページ内の2度目以降の終端イベントを抑制する**ため特に危険である
  （`blocked(非 running) → ready → blocked/done` の形）。**2度目の終端が出力から落ちたまま
  そのタスクが `targetIds` に残り、ページ最終 cursor を保存すると
  「その接頭辞を反映していない target 集合」が永続化される**。
  **出力レコードを畳む場合でも、`targetIds` はすべての終端遷移を反映させること**
- **checkpoint と dedupe key の外部 schema は実装前に確定させる**（受け手との互換契約になるため、
  「board 識別子」「安定した dedupe key」のままでは実装者ごとに分かれる）。
  **下の3項は 2026-08-30 に確定済みであり、実装はここに書かれた値をそのまま使う**
  （実装側で決め直さない。決め直しは §0.5「設計判断を worker へ先送りしない」違反である）:
  - **board 識別子は名前ではなく instance 識別子にする。** 同名 DB を作り直した場合を
    別 board として検出できる必要がある（board 名だけでは検出できない）。
    **これは migration v26 で実装済みである（2026-08-30 時点）**: 128bit 乱数の `boardInstanceId` を
    **schema migration が1回だけ生成して `board_metadata` へ永続化する**（DB を作り直せば
    新しい値になる＝再作成を検出できる）。既存 board は migration 適用時に生成される。
    読み出しは read-only accessor（`readBoardInstanceId`）を使い、
    **`await` のロジック自体はこれを読むだけで書かない**。
    **この前提は満たされているので、A1 の実装可能性はここではブロックされない**
  - **ただし「read-only」の意味を正確に書く。** 現行はどの CLI 起動でも store 構築時に
    schema migration が走るため、**deploy 後の最初の `task await` が `boardInstanceId` を
    生成・書き込みうる**。本節の read-only 契約は
    **「await のポーリングと判定が board へ書き込み・イベント記録を行わない」**という意味であって、
    **store 構築時の schema migration はその対象外**である（これは `--cursor-file` 以前からの
    既存挙動であり、本節が新設する例外ではない）。
    migration を `task await` から確実に排除したい場合は
    **read-only な起動経路を別に用意する必要があり、それは本節の範囲外の別課題とする**
  - **checkpoint JSON の exact schema（確定・2026-08-30）**:

    ```jsonc
    {
      "schemaVersion": "task-await-checkpoint.v1",
      "boardInstanceId": "0123456789abcdef0123456789abcdef",
      "eventCursor": 0,
      "targetIds": ["t_0123456789abcdef", "t_fedcba9876543210"]
    }
    ```

    - top-level は object のみ（配列・`null`・スカラは拒否）。**key 集合は上の4つちょうど**とし、
      未知 key の混入・field の欠落はいずれも拒否する（strict）
    - `schemaVersion`: 文字列リテラル `"task-await-checkpoint.v1"`。**数値版を使わない** —
      本 repo の外部 artifact は `cancel.v1` / `handoff-git-evidence.v1` /
      `codex-successor-attestation-publication.v1` のように**名前空間付き文字列**で版を持つ
      （`external-runtime-generation` の `schemaVersion: 1` は `schema` field に名前を分けて
      持っている形であり、単独の数値版ではない）。不一致は暗黙 reset せず失敗する
    - `boardInstanceId`: `^[0-9a-f]{32}$`。上の migration が生成する 128bit 値の小文字 hex 表記
    - `eventCursor`: 非負の safe integer（`Number.isSafeInteger`）。`0` は「まだ何も消費していない」
    - `targetIds`: task ID の配列。**重複を禁止し、昇順ソートを規定する**
      （順序を規定しないと同一集合が別バイト列になり、差分・比較・テストが不安定になる）。
      読み込み時は昇順へ正規化して受理してよいが、**書き出しは常に昇順**とする
    - シリアライズは **key を上の宣言順**（`schemaVersion` → `boardInstanceId` → `eventCursor` →
      `targetIds`）で並べた JSON に末尾改行1つを付けた形とする。整形（インデント）はしない
  - **`dedupeKey` の field 名・型・生成規則（確定・2026-08-30）**:
    - field 名は `dedupeKey`、型は string、出力レコードの top-level に置く
    - **`--cursor-file` を指定した時だけ出力する。** `--all` 単独と `--cursor-file` なしの
      `--follow-new` の出力へ field を足さない（本節末尾の「挙動を変更しない」に従う。
      厳格パーサを持つ受け手を壊さないため）
    - **経路非依存にする。** 同じ論理的終端には、どの経路で検出しても同じ key を与える:
      `"<boardInstanceId>:<taskId>:e<terminalEventId>"`。
      イベント経路はその id をそのまま使い、**スナップショット経路**（arm 時点で既に終端していた／
      イベントを解釈できなかった場合）は **read-only で同じ id を引いて同じ形にする**。
      経路ごとに別 key を作ってはならない（重複排除が経路によって効かなくなる）
    - **`<terminalEventId>` の定義（実装者に選ばせない）**: await の稼働判定述語は
      **`(status, blockReason)` の組**である（`ready` / `review` / `blocked` かつ in-progress な
      block_reason が「稼働」）。`<terminalEventId>` は、**その述語を稼働から非稼働へ移した
      最後の `task_events` 行の id** とする。
      **`status_changed` だけを見てはならない。`block_reason_updated` も対象に含める** —
      `blocked` + `*-in-progress:` から `blocked` + `review-required:` / `needs-manual:` への遷移は
      **status が変わらず block_reason だけが変わる**ため、`status_changed` だけを探すと
      **より古い遷移を選ぶか、1件も見つからない**。これは例外ではなく
      **review-required / needs-manual の主経路**である
    - **現行実装の制約に依存しないこと**: `parseAwaitTaskEvent` は payload の `from` / `to` を
      要求するため、`{previous, reason, assignee}` を payload に持つ `block_reason_updated` を
      解釈できず、この遷移は**イベント経路では検出されずスナップショット経路で拾われている**。
      `<terminalEventId>` の解決は**イベント経路が何を解釈できるかとは独立に**、
      上の述語遷移だけで決める
    - **畳み込み時の不変条件**: 同一 task の終端が1ページ内で複数回起きた場合
      （`終端 → 再走行 → 終端`）、**報告するのは最後の終端遷移**であり、`dedupeKey` も
      その event id を使う。`targetIds` 側は上の commit 単位の規定どおり
      **すべての終端遷移を反映させる**
    - **弱い fallback を置かない。`<terminalEventId>` を解決できない場合は
      key を発行せず fail-closed で失敗する。** 次の2つはいずれも採らない:
      - **内容由来の key**（status + 秒粒度の時刻など）— **同一秒内の別終端が同じ key になり、
        受け手が本物の終端を落とす**。取りこぼしより重複を選ぶ本節の方針では、
        **false-equal は false-distinct より厳しく禁じる**
      - **発行単位で一意な key**（プロセス nonce + 出力連番など）— false-equal は避けられるが、
        **出力後・checkpoint 永続化前のクラッシュを再生すると同じ論理的終端に別の key が付き**、
        受け手が重複を落とせない。**本節が塞ごうとしているクラッシュ境界そのもので効かない**ため、
        「安定した dedupe key」の要件を満たさない
    - **fail-closed が実際に到達しうるかの現状**: `task_events` に終端遷移の行が残らない経路は
      現時点で存在しない（`task_events` への `DELETE` は migration v3 preflight の
      `message_processed` 重複除去のみで、retention による剪定は無い）。
      したがって fail-closed は実運用では発火しない想定である。
      **将来そういう経路ができた場合も、弱い key を発明せず本節を改訂すること**
- **fail-closed の範囲**: 壊れた state / board 識別子の不一致 / cursor の逆行は
  **暗黙に reset せず失敗する**（黙って高水位へ飛ぶと、塞いだはずの窓が復活するため）
- **既定の監視コマンド**（本節「用途」の1本）は `--cursor-file` を指定する形へ更新する。
  ただし **`--all` 単独と、`--cursor-file` なしの `--follow-new` の挙動は変更しない**
- **実装済み（2026-08-30 / main=93ccd7f）**: store は `packages/core/src/task-await-checkpoint.ts`、
  CLI 配線は `packages/cli/src/commands/task.ts`。本節の値は実装の正本であり続ける
- **3 件の欠陥はいずれも修正済み・統合済み（2026-08-30。運用禁止は解除した）。**
  2026-08-30 のセルフレビューで見つかった P1 1 件と P2 2 件は、**再発防止テストつきで
  host-finalize され、main に入っている**。解除の根拠は task status ではなく統合実績である。
  - **P1**（`t_45be262b11a8e7d8` / main=`53af796`）— 再開時に `targetIds` へ arm 時点の稼働集合を
    merge したうえで**古い `eventCursor` のまま永続化**していたため接頭辞不変条件を破り、
    transition 分岐が `event.from` の稼働性を検査しなかったため
    **非稼働→非稼働の遷移が終端として報告されていた**。checkpoint へ書く接頭辞集合と
    実行時の待機集合を分け、transition 分岐で `event.from` の稼働性を検査するようにした。
    **再現手順の A/B を未修正 main / 修正 branch / 統合後 main の 3 系統で実測して解消を確認**
  - **P2-a**（`t_22df8d2caf3eebe7` / main=`da66f56`）— 2 本目の open が失敗したとき
    **1 本目と同じ inode を指す生 fd を close していた**ため、POSIX fcntl の規約により
    1 本目の lock が落ち、**別プロセスが取得できる状態**になっていた。
    プロセス内レジストリで **fd を開く前に** 2 本目を拒否し、あわせて上の owner marker 条項を実装した。
    独立プローブで「2 本目の失敗後も別プロセスの取得が拒否される」ことを実測（未修正 main では取得できた）
  - **P2-b**（`t_6ac7c0c684dc73ea` / main=`30e0771`）— イベント再生経路が `{kind:"invalid"}` を
    黙って読み飛ばし（fail-open）、スナップショット経路は `throw`（fail-closed）していた。
    再生経路を `throw` に揃えて経路非依存にした。`event === null`（無関係な種別）は従来どおり読み飛ばす

#### 50.1.2 tenant購読とcheckpoint v2（2026-09-09 ユーザー実装承認）

本節は t_282fc30032fb476f の採択仕様。tenant購読は通知対象の選択であり、担当binding/watch、claim権限を変更しない。
Codexのgoal休止・wake host・inbox peekは本節の範囲外。無指定の既存CLI/JSON/checkpoint v1は維持する。

- `task await --all --tenant <name>` を反復指定可能にする。複数値はOR。`--all`なし・明示ID併用は拒否。
  各値をtrimし空値/NULを拒否、重複を除きJS既定string sort順へ正規化。存在taskが0件でも有効。
- follow-new/checkpointの稼働target集合とevent cursorは従来どおりboard全体を追跡し、配送候補だけtenantで絞る。
  候補判定時にtaskを取得しtenantを照合。task不在/読取失敗でtenantを証明できなければエラーとし、当該候補を
  消費済みにしない。過去のevent時点tenantを復元する保証はしない。tenant変更は次の候補判定から適用する。
  除外候補は出力せずそのeventのtarget集合変更/cursor前進を反映する。除外だけではexit 0せず待機を続ける。
  対象候補はstdout成功後だけcheckpointを進める既存規律を維持する。下流永続受信の保証を追加したと称さない。
- `--all`単独のsnapshot方式でも配送前に同じpredicateを使う。対象tenantの稼働taskが初期0件なら既存の空集合終了と同様exit 0。
  `--follow-new`の場合は初期0件でも待機し後発taskを拾う。対象taskが稼働途中にtenant外へ移った場合は配送せずtargetから除外し、
  follow-newは継続、snapshot方式は残対象が無くなれば空集合終了。page内複数終端/再走行のtarget整合性を維持する。
- tenant指定のJSONだけ、既存fieldに`tenant:string`を加える。無指定の出力shapeは不変。dedupeKeyは既存規則を維持。
  全tenantのmetadata版出力、担当OR条件、live個別routerの削除は後続の独立gateで扱う。

checkpoint v2のexact key順は`schemaVersion,boardInstanceId,eventCursor,targetIds,tenants,filterRevision`。
`schemaVersion="task-await-checkpoint.v2"`、`tenants`は上記正規化済み非空string配列、`filterRevision=1`。
残り4fieldの不変条件、size上限、board同一性、cursor単調性、同cursorでtargetを減らさない条件、fsync/rename/lock/poison/closeは§50.1.1を継承。
未知key/欠落/未知版/未知revision/非正規化tenantsは拒否。targetIdsの既存読取正規化は維持する。
v1をtenant購読へ流用せず、v2を無指定購読へ流用しない。異なるtenant集合/revisionで同pathを開いた場合も拒否。
暗黙reset/upgrade/downgradeは行わない。別条件は別pathの新購読としてarmし、過去終端の自動replayはしない。

coreの公開APIは既存module内で以下に固定する（types.ts変更なし、既存barrel star exportを使う）:
- `normalizeAwaitTenantFilter(values: readonly string[]): string[]` は上記正規化を行う純関数。空配列も拒否。
- `matchesAwaitTenantFilter(tenant: string, tenants: readonly string[] | undefined): boolean` はundefinedなら全件、指定時はexact一致。
- 既存`TaskAwaitCheckpoint`をv1/v2 discriminated unionにし、v1既存constantは値を変えず、
  `TASK_AWAIT_TENANT_CHECKPOINT_SCHEMA_VERSION`をv2 literalとして追加。v2 interfaceだけtenants/filterRevisionを持つ。
- `OpenTaskAwaitCheckpointStoreOptions.tenants?: readonly string[]`を追加。open時に正規化してprivate copyし、
  read/writeで版・tenant集合・revisionがopen条件と一致することを検証する。caller配列変更でscopeが変わらない。
  `read/write`の外部型は上記union。無指定callerと既存v1 testをそのまま通す。

必須focused: v1後方互換、v2 roundtrip、正規化、複数/空/未知tenant、caller mutation、filter/版/revision不一致時の
checkpoint不変、board不一致、cursor逆行、同cursor target減少、共有lock/poison/close/crash非回帰。
CLIはtenant A/B/A、除外だけでreturnしないこと、後発task、snapshot/follow-new/checkpointの各経路、
同page複数終端/再走行、stdout失敗とcrash再arm、tenant変更、不明task、無指定JSON不変を実fixtureで証明する。

#### 50.1.3 明示した担当scopeとのOR購読（2026-09-09 採択、実装段階）

- 未指定/v1、tenantのみ/v2の挙動は維持する。追加CLIは`--include-orchestrator <stable-id>`とし、
  `--all`必須・明示task ID併用不可。tenant指定時はtenant一致 OR 指定identityの正本scope一致。
  担当単独なら正本scopeだけ。既存task listの`--orchestrator`と暗黙に同義扱いしない。
- 正本scopeは既存`isOrchestratorScopedToTask`と同一。active bindingが1件でもあればwatchを抑制し、
  非observer bindingだけを配送先にする（observerだけでもwatch抑制）。active binding0件の時だけ
  §69.3の既存watch解決を使う。steward専用tenant fallback、claim権限、session/generation境界を変更しない。
- `KanbanReadViewCapabilities.isOrchestratorScopedToTask(orchestratorId:string,taskId:string):boolean`を
  additiveに公開する。Store/ReadViewは同じinternal resolverを使い、readonly面でStore/migrationを起動しない。
  未知identity/taskと読取失敗はthrow。`types.ts`の凍結interfaceは変更しない。
- CLIのidentity存在検査は開始時に必須。配送は候補判定時の現scope。判定不能を除外に変換しない。
  board全体のtarget/cursor、stdout成功後のcheckpoint、dedupeKey、除外のみで継続の規律を継承する。
  OR指定JSONはtenantを含める。旧Pythonの無条件LIMIT 1を互換性の正本にしない。
- 担当指定checkpoint v3はexact keysを`schemaVersion,boardInstanceId,eventCursor,targetIds,tenants,orchestratorId,filterRevision`、
  schemaVersionを`task-await-checkpoint.v3`、filterRevisionを1に固定。orchestratorIdはtrim済み非空/NULなしstring。
  tenantsはv2同様の正規化済み配列で、担当単独の時だけ空配列を許す。v1/v2の空tenant拒否は変えない。
- coreは`TASK_AWAIT_ORCHESTRATOR_CHECKPOINT_SCHEMA_VERSION`とv3 unionを既存moduleへ追加。
  `OpenTaskAwaitCheckpointStoreOptions.orchestratorId?:string`を追加し、指定時はv3だけ許可。
  tenants未指定/空なら担当単独、非空なら既存正規化を使う。open時にprivate copyしてread/writeを照合する。
  `normalizeAwaitOrchestratorFilter(value:string):string`はtrim、非string/空/NULを拒否する純関数として公開する。
  未指定のv1/v2選択と既存APIは維持。版/tenant/identity/revision不一致は拒否し暗黙変換/resetしない。
- readonly scope抽出とv3 checkpointは所有を分けて並列実装可能。CLIは両APIの受入後に接続する。
  v3のlock/poison/close/fsync/rename/上限/board/cursor/target整合性は§50.1.1を継承する。
- tenant-a live切替は旧routerのobserver/released/複数binding/watchとの差をshadow比較し、採択済み差と未処理0件を
  hostが確認してから行う。新CLI追加だけで既存routerを撤去しない。エラー通知とrollback経路を維持する。

### 50.2 monitor ステージの direct stall 検知

> **2026-08-29 訂正（1回目）。** 本節の旧記述は「`.out` のサイズ増加を監視し、15 分無増加で `run_stalled`」
> だったが、実装（`packages/supervisor/src/stages/monitor.ts` の `monitorDirectStalls`）は
> **二軸判定**であり、無増加だけでは発火しない。旧記述を根拠に「15分で停滞に気付ける」と
> 見積もると外れる（knowledge `k_c9093cb48658`。ただし同エントリの**数値**は `k_6e15c0df4d69` が訂正した）。
>
> **2026-08-29 改訂（2回目・main=cd8fdf1）。** 上の二軸判定は「生きたまま止まった run には
> 実効 120 分まで手が入らない」という限界を持っていた。方式比較 `t_a37e99b4f9eb716c` の採択
> （#4055）を受け、**警告と破壊的 cancel を分ける二段階方式**を実装した。判定は**三経路**になり、
> **生存中の停滞は `run_stall_suspected` として警告のみを出す**（cancel request を作らない）。
> したがって旧記述の「軸1 は生存中の run に到達しない」「最初に手が入るのは 120 分」は
> **警告経路については不正確**になった。**以下を現行契約とする**
> （関数名・行の参照は実装が現契約に一致していることの証跡であって、実装が正本という意味ではない）。

#### 50.2.1 三経路の判定（confirmed crash / suspected live stall / max runtime）

direct transport の open run について、`monitorDirectStalls` は次の**三経路**で判定する。
**進捗シグナルは provider で異なる。`.out` が連続的に育つのは codex だけであり、
`claude -p` は完了まで何も書かない。したがって `.out` の成長を provider 非依存の進捗シグナルとして
扱ってはならない。**

| 経路 | 成立条件 | 生成物 | cancel request |
|---|---|---|---|
| **confirmed crash** | state が読める + `.out` が `outputStallSeconds` 無成長 + **プロセスツリー不在** | `run_stalled`(reason=`output-stall`) | **作る** |
| **suspected live stall** | state が読める + **生存確認の時点でプロセスツリー生存** + provider 別 progress が `outputStallSeconds` 無成長 | `run_stall_suspected`(reason=`live-progress-stall`) | **作らない（警告専用）** |
| **max runtime** | state が読める + `startedAt` から `maxRuntimeSeconds` 超過 | `run_stalled`(reason=`max-runtime`) | **作る** |

- **評価順は max runtime → confirmed crash → suspected live stall** である。
  max runtime は**出力の有無・成長に依存せず、`.out` の fail-open スキップより前に評価される**
  （出力が全く生まれない run こそ上限で打ち切る必要があるため）
- 生存判定は §34.2 / direct-stop-v1 と同じく `state/direct-sessions/<sessionId>.json` の pid を使い、
  新しい停止機構は作らない。判定は **`isProcessAlive(pid) || isProcessGroupAlive(pid)` の OR** である
  （`isDirectSessionProcessAlive`）。**pid が process group leader でない場合に `-pid` が ESRCH となって
  生きているプロセスを死亡と誤判定する余地を塞ぐため**であり、
  **生存の証拠が1つでもあれば confirmed crash を宣言しない fail-safe 方向へ倒す**
  （crash 宣言は run を停止させる副作用を持つため）
- **`confirmed crash` は実装が使っている呼称であって、crash と確定したという意味ではない。**
  この経路が実際に観測しているのは **「open run なのにプロセスが不在で、かつ出力も伸びていない」**
  だけである。**`.exit` や adapter の終了ステータスを確認していない**（`monitorDirectStalls` は
  `readDirectSessionState` しか読まない）ので、
  **正常終了したが finalize されず open のまま残っている run もこの経路に落ちる**。
  したがって「crash と確定した」と読んではならない。正確には **process absent / unclassified termination** である。
  それでも cancel してよいのは、いずれにせよ**そのプロセスはもう走っていない**からで、
  停止対象として害が無いことによる（**生きている run を止める経路ではない**）。
  **無成長だけを根拠にしない**理由は逆側で、
  `claude -p` は完了まで stdout へ何も書かないため、無成長のみで判定すると正常稼働中の run を
  誤って停止する
- fail-open は**出力経路限定**: `.out` 未出現・stat 失敗のとき confirmed crash は何もしない。
  max runtime は上記のとおり `.out` を見る前に評価される

##### suspected live stall の進捗シグナル（provider 別）

`lastProgressAt = max(有効な進捗ソースの最終成長時刻)` を取り、
`now - lastProgressAt >= outputStallSeconds` で成立する。

| provider | 進捗ソース | 備考 |
|---|---|---|
| codex | **`max(.out の成長, native rollout log の成長)`** | `.out` は走行中に継続的に育つので有意 |
| claude | **native transcript log の成長のみ**（`.out` は使わない） | `claude -p` の `.out` は完了まで育たないため進捗源にならない |

- native log は `session.nativeSessionId` から解決する（claude = `~/.claude/projects/<proj>/<id>.jsonl`、
  codex = codex sessions root の rollout ファイル。codex は `nativeSessionId` 未設定なら
  `.out` 冒頭から復元を試みる）。`session.nativeLogsDisabled === true` の run は解決しない
- **進捗ソースが1つも取れない run では警告しない。** 誤検知を出さないための fail-open である
- **event の `processTreeAlive: true` は生存確認を行った時点の観測値であって、記録時点の保証ではない。**
  生存確認のあとに native log の解決と（最大で秒オーダーの）git probe が入るため、その間に
  プロセスが終了しうる。**警告を受けた側は「今も生きている」と読まず、claim 時点で改めて確認すること**
  （確認手段の不足は下記「既知の限界」を参照）
- 同一 run につき1回だけ警告する（`stallSuspected` フラグ + `run_stall_suspected` event の存在チェック）。
  進捗が回復しても再送しない
- **警告は破壊的な操作を一切行わない。** `recordDirectRunStallSuspected` の transaction は
  `addEvent` と `createOrGetOrchestratorRequest` の2つだけで、`ensureSupervisorCancelRequest` は
  confirmed crash / max runtime の経路にのみ存在する。**破壊的 cancel は共有 guard（実効 120 分）、
  または人間/オーケストレーターの exact-session 判断に残す**
- 警告 event には **worktree の補助証拠**を添える（`git status` の porcelain hash・変更 path・
  task の cwd と worktree の ownership 一致）。**これは補助証拠であって単独の cancel 根拠にしない。
  差分の内容は読まない。** probe が失敗した場合は `unavailableReason` を入れて続行する。
  値は **`timeout` / `output-limit` / `probe-failed` / `invalid-output` の4種**である
  （`timeout` = kill または ETIMEDOUT、`output-limit` = maxBuffer 超過、
  `invalid-output` = **git probe 出力の構造・正規化に失敗** — identity probe（`rev-parse` の行数不正・
  canonical path 解決失敗）と porcelain 解析失敗の**両方**がこの値になり、区別できない、
  `probe-failed` = それ以外）。
  **consumer は未知値に耐えること**（将来増えうる）

##### session state が読めない場合（`direct-session-state-unreadable`）

> **これは 2026-08-29 の改訂で挙動が変わった箇所である。** 旧契約は「生存確認を省いて出力無成長のみで
> 判定し、軸2 は見送る」という互換フォールバックだったが、**健全な claude run でも state が読めなければ
> 45 分で cancel されうる**という誤検知リスクを持っていた。この経路は**廃止した**。

- `readDirectSessionState` が `null` を返した run では、**provider 別の判定を三経路とも skip する**。
  cancel は作らない
- 代わりに `direct-session-state-unreadable` イベントと §38 operational notify を
  **同一 run 1回だけ**出す（`providerSpecificChecksSkipped: true`）
- **共有 `resourceGuard.maxRunSeconds` はこの関数の外なので維持される。ただし無条件ではない。**
  共有 guard の対象は `store.listInProgress()` が返す task のうち session ref を再構成できるものだけで、
  `monitorDirectStalls` が見る「全 open run」より狭い。
  したがって **state が読めず、かつ in-progress 集合から外れている open run は、
  三経路も共有 guard も適用されず、自動では何も起きない**（無期限に open のまま残りうる）。
  これは既知の穴であり、**「state が読めなくても 120 分で必ず手が入る」と読んではならない**

#### 50.2.2 識別子（3系統。混同しないこと）

- **event 名**: `run_stalled`（破壊的経路）/ `run_stall_suspected`（警告専用経路）/
  `direct-session-state-unreadable`（判定 skip）
- **`payload.reason`**: `output-stall`（confirmed crash）/ `max-runtime` / `live-progress-stall`（警告）
- cancel request の **`reasonKey`**（nonce の材料であり永続化される reason ではない）:
  confirmed crash = `direct-output-stall` / max runtime = `direct-max-runtime` / 共有 guard = `max-runtime`
- **永続化される cancel `reason` 文字列**: `direct output stall (<n>s)` /
  `direct max runtime exceeded (<n>s > <limit>s)` / `max-runtime exceeded (<n>s > <limit>s)`

`run_stalled` は event と通知で終わりではなく、**event → cancel request → 停止 or 停止失敗**まで続く。
停止に成功して task が終端すれば `hachi task await` が発火し、停止に失敗すれば §57.5 により
担当オーケストレーターの inbox へ上がる。**`run_stall_suspected` はここに繋がらない** —
警告と inbox request で終わり、run はそのまま走り続ける。

- **event・cancel request・§55.2 の orchestrator request は同一 Store transaction に入れる**
  （2026-08-29 実装。main=755cebe。`run_stall_suspected` は cd8fdf1 で同じ規律に従う）。したがって
  「event だけ記録されて **cancel request と orchestrator request** が永久に欠落する」窓は無い。
  **保証されるのは durable な request までである。**
  §38 operational notify はこの transaction の**後**に best-effort で行うので、
  **送信失敗や送信前の crash は救済されない**（次 tick は既存 event を見て skip するため再送しない）。
  **通知が来ないことを「起きていない」と読まないこと。正本は inbox の request である**
- 閾値は **provider 別**（`DEFAULT_DIRECT_STALL_LIMITS`）で、`config.direct.stall.<provider>` で上書きできる。

  | provider | outputStallSeconds | maxRuntimeSeconds |
  |---|---:|---:|
  | codex | 15 分 | 120 分 |
  | claude | 45 分 | 180 分 |

- **上表は §50.2 内の閾値であって、run が実際に止められるまでの時間ではない。**
  同じ monitor tick は `store.listInProgress()` が返す task のうち **session ref を再構成できるもの**
  （direct を含む。transport で絞っていない）に対して、共有の `resourceGuard.maxRunSeconds`
  （未設定時 7200 秒 = 120 分）も適用し、超過分へ cancel request を作る。
  こちらは `run_stalled` イベントを**記録しない**。
  **in-progress 集合から外れた open run はこの guard の対象にならない**ため、
  その場合 claude direct は max runtime 経路の 180 分まで到達しうる。
  したがって **最初に cancel request が作られる時刻は min(provider の maxRuntimeSeconds,
  resourceGuard.maxRunSeconds)** である。**これは「そこで止まる」保証ではない** — 共有 guard も
  §50.2 も作るのは cancel request であって、停止そのものは §57.4/§57.5 の cancel 経路が行う。
  cancel が無効・保留・失敗なら run は開いたまま残る。

  | provider | max runtime 経路 | 共有 guard | **最早の cancel request** | max runtime の `run_stalled` |
  |---|---:|---:|---:|---|
  | codex | 120 分 | 120 分 | **120 分** | **出る**。`monitorDirectStalls` は共有 guard より先に走り（tick 冒頭）、max runtime は `>=`、共有 guard は `>` なので**max runtime が先に成立する**（決定的） |
  | claude | 180 分 | 120 分 | **120 分**（reason=`max-runtime`） | **共有 cancel が 180 分より前に run を閉じた場合だけ出ない。**閉じられなければ 180 分で出る |

  **上表は「生存中かつ session state が読める run の、時間上限の経路だけ」を対象とする。**
  confirmed crash が先に成立するのは **`.out` が観測できており、かつ無成長のまま閾値を超え、
  かつプロセスが不在**の3条件が揃った時だけで、その場合は codex 15 分 / claude 45 分で
  cancel request が作られる。
  **`.out` が未出現・stat 失敗なら confirmed crash は評価されず、時間上限の経路へ落ちる。**
  session state が読めない run は三経路とも skip されるため、上表は適用できない
  （共有 guard の 120 分だけが残る）。

  claude direct で 180 分を意図した閾値として機能させたいなら、(a) direct run を共有 guard の
  対象から外す、または (b) `resourceGuard.maxRunSeconds` を 180 分以上へ上げる（ただし
  bridge を含む全 run に効く）。いずれも未実施。
- **`outputStallSeconds` は「破壊的 cancel の時計」と「警告の時計」を兼ねる（2026-08-29〜）。**
  同じ値が confirmed crash（プロセス不在）と suspected live stall（プロセス生存）の両方で使われる。
  したがって **codex 15 分 / claude 45 分は、生存中の run に対しては
  「警告が出るまでの時間」として機能する**（cancel までの時間ではない）。
  改訂前の「`outputStallSeconds` の provider 別値は生存中の run に対しては事実上機能していない」
  という記述は、警告経路が入ったことで**過去のものになった**。
  - **停滞を人間/オーケストレーターが知るまで**: codex 15 分 / claude 45 分（inbox request）。
    **これは判定閾値であって、通知が届く時刻の上限ではない。** 実際の通知は
    **閾値到達後の最初の monitor tick** で行われるので、tick 間隔と各 stage の処理時間だけ遅れる。
    **supervisor が止まっている間は無期限に遅れる。**
    さらに次の3つが同時に成り立たない run では、警告が出ないか大きく遅れる:
    (a) session state が読める、(b) 進捗ソースを**少なくとも1つ**継続観測できている、
    (c) monitor state（`$HACHI_KANBAN_HOME/state/monitor-direct.json`）が維持されている。
    **(c) の意味を取り違えないこと**: この state は永続ファイルであり、
    **通常の supervisor 再起動では再読込されるので時計はリセットされない**。
    リセットされるのは**ファイル全体が欠落・破損した場合に加え、
    その run の entry だけが欠落しているか必須フィールド
    （`size` / `lastGrowthAt` / `stalled`）の型が不正な場合**である
    （`readDirectMonitorState` は不正な entry を個別に落とす）。
    そのとき `directMonitorEntry` は `previous === undefined` として `lastGrowthAt = now` を置くため、
    **停滞の実開始時刻ではなく再観測時刻から計り直す**。
    どれかが欠けた run は**共有 guard の 120 分まで何も通知されないことがある**。
    **in-progress 集合から外れていればその 120 分すら来ない**（上記のとおり）
  - **停滞に対して自動 cancel request が作られるまで**: 既定で **両 provider とも 120 分**（共有 guard）。
    ここは変わっていない。**cancel request は停止そのものではない**（本節冒頭の注記と同じ）。
    **警告は cancel request すら作らない**
  - 15 分閾値の余裕は薄い。正常終了した codex 429 run の実測で、run ごとの最大無成長時間は
    **最大 512 秒（8分32秒）/ p95 201 秒 / 15 分超 0 件**であり、**観測最大の 1.76 倍しかない**。
    この余裕で worker を殺すのは危険だという判断が、警告と cancel を分けた根拠である
    （`t_a37e99b4f9eb716c` #4055）
  - `state` JSON の mtime は**進捗源に使わない**（起動後1秒以内に固定されるため。実測で不採用）。
    CPU 時間も診断材料にとどめ、判定には使わない
- **`run_stalled` / `run_stall_suspected` は orchestrator inbox の request を作る（2026-08-29 実装。
  main=755cebe / cd8fdf1）。**
  task event・operational notify（`run_stalled` はさらに §57.4 cancel request）に加えて、
  §55.2 の durable request family へ request を作る。**両者は同じ family を使うが `kind` と
  冪等キーの taxonomy を分ける**ため、衝突しない。

  | | `run_stalled` | `run_stall_suspected` |
  |---|---|---|
  | request `kind` | `run_stalled` | `run_stall_suspected` |
  | 冪等キー（`questionId`） | `run-stalled:<runId>:<sessionId>` | `run-stall-suspected:<runId>:<sessionId>` |
  | 同一 transaction の中身 | event + cancel request + orchestrator request | **event + orchestrator request のみ** |
  | `context` | `runId= sessionId= provider= reason=` の1行 | **警告 event payload の JSON 全体**（進捗ソース・閾値・worktree 補助証拠を含む） |

  - **event・cancel request・orchestrator request は同一 Store transaction に入れる。**
    次 tick は既存 event を見て skip するため、event 記録後に crash すると
    後続の request が永久に欠落するためである（実装前はこの窓が実在した）。
    `run_stall_suspected` も同じ規律に従う（cancel request が無いだけ）。
    **§38 operational notify は transaction の外（後）なので、この保証に含まれない**
  - 冪等キーは exact run 固定。同一 run 1件。
    出力が回復しても再送せず、replacement の新 run だけが新しい request になる
  - 配送先は §55.1/§69.3 の正本 resolver（`resolveOrchestratorDeliveryTargets`）を使う
  - 担当 identity に live session が無くても delivery は identity 宛てに pending で残り、
    次世代 session が同じ identity で claim する
  - **`orchestrator answer` / `escalate` は `kind=worker_question` 専用**であり、
    `run_stalled` / `run_stall_suspected` のいずれに対しても拒否する
    （`packages/cli/src/commands/orchestrator.ts`）。
    両者は `orchestrator resolve` で閉じる（**task 本文と worker session は変更しない**）。
    **fence が必須である**:
    `hachi orchestrator resolve <request-id> <handled|false_positive> <reason> --session <id> --generation <n> --claim <token>`
    - `handled` = 実際に手を打った（cancel した・待つと決めた等） / `false_positive` = 停滞していなかった
    - 生成される event は kind 別に分かれる:
      `orchestrator_run_stalled_resolved` / `orchestrator_run_stall_suspected_resolved`
    - **`run_stall_suspected` の resolve は run を止めない。**
    - **警告は同一 run につき1回きりである。resolve は不可逆な判断になる。**
      monitor は `stallSuspected` フラグと既存 `run_stall_suspected` event の両方で以後の警告を抑止するため、
      **その run が止まったままでも二度と警告は来ない**。
      したがって「様子を見る」を `handled` で閉じると、**その run に対する唯一の durable な伝達路を
      自分で閉じる**ことになり、次に何かが起きるのは共有 guard の 120 分（in-progress 集合から
      外れていればそれも来ない）になる。
      - **「待つ」を選ぶなら、期限付きの再確認を自分で持つこと。** 具体的には
        「いつ・何を見て・どうなっていたらどうする」を決めて resolve の理由文に書き、
        その時刻に自分で見に行く経路（watcher・wake）を張ってから閉じる
      - **何もしないことが正当な `handled` になるのは、再確認の必要が無いと判断できる時だけ**である
        （例: body の作業量から見て沈黙が妥当で、かつ終端 watcher が張られている）
    - **解消済み（2026-08-31 / main=`16555e5`）: 警告対象の run だけを狙って安全に止められる。**
      request は durable なので、claim した時点では警告対象の run が既に終了し、
      **replacement の新 run が走っていることがある**。素の
      `hachi task cancel <taskId>` は worker の run/session を引数に取らず
      `getLatestOpenRun()` を対象にする（`--session` は**操作主体の orchestrator session** であって
      worker session ではない）ため、これで打つと **replacement を誤って止める**。
      事前に current open run を照合しても**照合と cancel の間は原子的でないため TOCTOU が残る**。
      - **したがって停滞警告からの cancel は fenced cancel だけを使う。**
        `--expect-run <runId>` / `--expect-session <workerSessionId>`
        （少なくとも一方が必須。両方渡してよい）を付けると、
        `Store.createOrGetFencedRunCancelRequest` が **同一 transaction 内で** current open run と
        照合する。不一致・open run 不在なら **request / event / steer の mutation を一切行わず**
        `targetMatched: "no"` を返し、CLI は理由を出して exit 1 で終わる。
        **TOCTOU はこの経路では消えている**（照合と作成が同じ transaction にあるため）
      - **素の `task cancel`（expected 指定なし）を停滞警告の回収に使わない。**
        従来どおり `getLatestOpenRun()` を対象にするので、上の誤停止が起きる
      - fence に渡す識別子は下の「照合に使う識別子」の行から取る
        （`runId` = `questionId` の `run-stall-suspected:<runId>:<sessionId>`、
        `sessionId` = request の `context`）
      - **read 面は 2026-08-31 に解消した（main=`c6b542b`・`t_bc8a1008873b9d38`）。**
        `task show` は `currentRun` を返す。値は current open run の
        `id` / `sessionId` / `provider` / `transport` / `startedAt` / `status` の**6項目に限り**、
        open run が無ければ `null`。非 JSON 出力には存在する時だけ1行出す。
        worker の出力・transcript は**載せない**（orchestrator の二重トークン消費を招くため）。
        既存キー（`task` / `events` / `comments` / `cancelRequests` / `steerDeliveries`）は変えていない。
        なお `cancel-status` は従来どおり cancel request が無ければ何も返さない
      - **read 面だけでは TOCTOU は消えない。** 読んだ後に cancel を打つ間に run は置き換わりうる。
        原子性は下記 (1) の fenced cancel でしか得られない
      - **したがって本契約は、警告を受けて素の `task cancel` を打つことを標準手順にしない。**
        **止めると決めたなら fenced cancel（`--expect-run` / `--expect-session`）で打つ。**
        置き換わっていれば `targetMatched: "no"` で何も起きないので、
        「replacement が走っていない確証」を人手で持つ必要はもう無い
      - 恒久対策は (1) expected `runId` / worker `sessionId` を Store transaction 内で照合する
        **fenced cancel**（`t_b8cbb57dedbdb2d6`。**2026-08-31 実装・統合済み / main=`16555e5`**）、
        (2) current open run を返す **read-only 面**
        （`t_bc8a1008873b9d38`。**2026-08-31 実装・統合済み**）の2つで、**両方入った**。
        (2) は「いま何が走っているか」を知るため、(1) は「知ったものだけを確実に止める」ために使う
      - **残る限界: 止まったことの確証は別問題である。** fenced cancel が保証するのは
        **正しい run に対して cancel request を作ったこと**までで、停止そのものは
        §57.4/§57.5 の経路に委ねられる。exact-session stop 非対応 bridge では
        `cooperative_sent` のまま停止を確認できない（§57.5）。
        **「狙って止められる」を「止まった」と読まないこと**
    - **警告対象の run が既に終わっている / 置換されていた場合は `handled` で閉じる。**
      理由文へ `target run already ended or replaced; cancel skipped` に相当する記述を残す。
      **`false_positive` にしない** — `false_positive` は「停滞していなかった」を意味するので、
      実際に停滞した run が自然終了・置換された場合に使うと閾値評価と監査を歪める。
      照合に使う識別子は、`sessionId` が request の `context`（event payload の JSON）、
      `runId` が `questionId` の `run-stall-suspected:<runId>:<sessionId>` に入っている
  - worker-question の active-request 判定も `kind=worker_question` に限定した（§69.1 の kind 衝突回避）
  - **実装上の注記**: 凍結済み Store input を広げない代わりに、`questionId` の接頭辞
    （`run-stall-suspected:` → `run-stalled:` の順で判定）で kind を導出している。
    **`run-stalled:` を先に判定すると `run-stall-suspected:` は前方一致しないので順序は本質的ではないが、
    接頭辞が互いの前方一致にならないことは将来 kind を増やすときの前提条件である。**
    暗黙規約なので、kind を増やすときは明示化すること
  - **legacy 例外（既知・意図的に未対応）**: monitor は既存の `run_stalled` event がある run を
    skip するため、**755cebe より前に event を出して今も open な run は request を受け取らない**。
    routing の backfill は blocked な worker-question しか扱わない。
    2026-08-29 の実測では該当 0 件（`run_stalled` event 7件はすべて終了済み run、open run は 1件で
    該当なし）だったため reconciliation は実装していない。**将来 open な該当 run を見つけたら
    手動で resolve するか、reconciliation を起票すること**
- stall は terminal ではないので、**停止が完了するまでは** `hachi task await` は発火しない。
  即時の気づきは上記 inbox request が担う。
  **`run_stall_suspected` の発生と resolve それ自体では `task await` は発火しない**
  （警告は run を止めないため）。**ただしその後 task が終端すれば通常どおり発火する** —
  警告を受けても終端 watcher は張ったままにすること。
  警告そのものについては、**唯一 durable かつ claimable な処理経路が inbox request である**。
  §38 operational notify も併せて飛ぶが、そちらは best-effort の補助経路であり、
  取りこぼしても request は残る（逆は成り立たない）
- 注: artifacts の transcript-direct-*.txt は**終了時にのみ**書かれるため実行中監視には使えない
  （起草時の誤り。実装時に worker が指摘し本記述へ修正）
- **bridge run は本節（direct stall 検知）の対象外**である。bridge レーンには
  `state/direct-sessions/*.out` も `state/direct-sessions/<sessionId>.json` も存在しないため、
  三経路の判定はそもそも適用できない。**2026-08-29 に入った `run_stall_suspected` の警告も
  bridge には出ない。**
  **明示しておく: bridge には max-runtime より前に発火する停滞検知が現状ひとつも無い**
  （supervisor に bridge 用の無進捗タイマーも成長比較も実装されていない）。
  `/api/messages` は**人が状況を確かめるための診断材料**であって検知機構ではない。
  したがって bridge の停滞は §34 max-runtime まで自動では止まらず、
  in-progress 集合から外れた run はそれすら効かない。
  **これが bridge の正本方針である**（playbook 側に独自の検知規律を置かない。置くと本節と競合する）。
  改善が要るなら本節を先に改訂する

#### 50.2.3 cancel request は非破壊ではない — 作られた時点で finalize が恒久的に閉じる（2026-08-30 追記）

**本節および §57.4/§57.5 は「cancel request は停止そのものではない」と繰り返し述べている。
これは停止の保証について正しいが、"だから cancel request 自体は無害である" とは読んではならない。
実装では、cancel request が 1 行でも存在した瞬間に、その run の finalize が恒久的に閉じる。**

```
packages/supervisor/src/stages/cancel.ts:220-222
  cancellationForRun() = listRunCancelRequests().findLast(r => r.runId === runId) ?? null
  ← status フィルタが無い。core/src/db.ts:7856 の listRunCancelRequests は
    run_cancel_requests を無条件に返すため、failed / expired の request でも非 null になる

packages/supervisor/src/stages/finalize.ts:1618（本体）
  cancelRun !== null && cancellationForRun(store, cancelRun.id) !== null
    → rejectLateResultOnce(...) + continue（完走した handoff もここで捨てられる）
  同じ述語は :425 assertStillTargetSession / :442 exactTargetRun /
  :462 recordStaleFinalizeSkipped でも finalize を止める

packages/supervisor/src/stages/reap.ts:342（2026-08-30 追記）
  cancellationForRun(store, run.id) !== null
    → 「cancel stop 証拠待ち」として continue（**reap も閉じる**）
```

**閉じるのは finalize だけではない。reap も閉じる。** reap は `store.listOpenRuns()` を回して
orphan run を release するが、**cancel request が 1 行でもある run は skip する**。
`cancellationForRun` は status を見ないので、**fence が掛かるのは request の status を問わない**。

**したがって「open run が無期限に残る」の実体は、`failed` / `expired` に限らない。**
**exact-session stop capability が無い場合、cancel stage は request を終端させず
`pending`（通常は `cooperative_sent`）のまま維持して escalate する**
（`cancel.ts:655-657`「exact-session stop capability が無いため pending を維持します」）。
この**保留中の request も同じ fence を掛ける**ため、finalize も reap も通らない run になる。
**終端 status だけを探すと、いちばん起きやすいケースを取り逃がす。**
疑う条件は「**停止の証拠が無い cancel request が付いているか**」であって、
「in-progress 集合から外れたか」でも「status が failed/expired か」でもない。

したがって帰結はこうなる。

- **`resourceGuard.maxRunSeconds`（未設定時 120 分）を跨いだ run は、その後 worker が綺麗に完走して
  handoff fence を出しても `done` に到達できない。** cancel stage が自然停止を観測できた場合は
  `endRun(failed)` + `needs-manual: cancel stopped (...)` になる
- **worktree のファイル変更は残る。しかし「成果が全部残る」とは限らない。**
  finalize の cancel fence（`finalize.ts:1618`）は **`fetchTranscript`（同 :1714）より前に `continue` する**ため、
  **その run の transcript artifact は保存されない**。ファイルに落ちていない成果
  （調査結果・設計判断・handoff 本文・レビュー所見）は、**worktree にも artifact にも残らない**。
  したがって session / worktree を掃除する前に、**provider 側のネイティブログから transcript を
  自力で回収して保全する**こと。回収はいずれもオーケストレーターの手作業になる
- **`task await` が必ず発火するとは限らない。** 停止を観測できて task が終端へ移れば発火するが、
  exact-session stop 非対応・cancel の `failed` / `expired` では **run が open のまま
  task も in-progress に留まる**（§57.5）。その場合の要対応 wake の正本は
  **担当オーケストレーターの inbox** であって `task await` ではない
- **この 120 分は「時間上限経路で cancel request が作られる最早の時刻（既定値）」である。**
  無条件の最早ではない — confirmed crash 経路は codex 15 分 / claude 45 分で作りうるし、
  手動 cancel はいつでも作れるし、`resourceGuard.maxRunSeconds` を下げれば早まる。
  それでも **時間上限経路は例外ではなく既定の終わり方**であり、長時間 run はここに落ちる

**運用上の規則:**

- **ready の絶対条件（成果物 1 つ・「やめる条件」を書く。playbook §0.5.1）を守る動機は、
  レビュー往復の削減ではなく成果の保全である。** 実効上限から逆算して body の作業量を決める
- 停滞警告（`run_stall_suspected`）に対して「待つ」を選ぶときは、**共有 guard の 120 分が
  「まだ何も起きない時刻」ではなく「成果を捨てる時刻」である**ことを織り込む
- `resourceGuard.maxRunSeconds` を延ばす判断は、この帰結を承知のうえで行う
  （延ばすと bridge を含む全 run に効く。上の claude 180 分の項と同じ注意）

**未実装（起票対象）:** `cancellationForRun` を status で絞り、`failed` / `expired` の request が
finalize を閉じ続けないようにする。ただし「cancel を要求したが停止を確認できていない run の
late result を受け入れてよいか」は §57.5 の停止証拠規律と正面から関わるため、
**単純な status フィルタの追加として実装してはならない**。契約側の改訂を先に行う。

### 50.4 終了済みオーケストレーターthreadの再開（Codex thread heartbeat）

- `hachi task await` は対話中のCLI convenienceであり、1件を返してexitしたprocessから、既にturnを終了した
  Codex Desktop threadを能動的にwakeする公開契約は持たない。したがって `task await` processの生存だけを
  回収通知の正本にしてはならない
- Codex Desktopでは、stable orchestrator identityの責務ごとに有効な復帰予約を高々1つ持つ。
  **標準はworker dispatch時の見込み完了時刻に合わせた単発thread heartbeat予約**とする（2026-09-09ユーザー採択）。
  複数workerは次に回収する見込みへまとめ、対象thread・一回限定条件・時刻・有効状態を保存後にreadbackする。
  復帰時は当該予約を停止・readbackし、対象taskとdurable inboxを小さい出力で確認する。
  未終了なら現在の進捗から残時間を見積もり、必要な次の一回だけを同じautomationへ再設定する。
  対象なし・人間の回答待ちだけ・明示停止では再予約しない。短周期の無変化確認や無条件の固定間隔再予約はしない。
  固定間隔の回復策はユーザーが明示選択した場合だけ使う。予約失敗/停止不確定時に重複automationを追加しない。
  予約時刻は完了保証ではなく次の確認時刻。Mac停止/アプリ終了等の遅延を含む配送上限は保証しない。
- heartbeatはpollingのスケジューラであり、task transcriptを逐次読む機構ではない。回収対象が無ければ
  内容を読まず終了し、対象があれば playbook（core）§1.4 相当の分岐を処理して `task await --all --follow-new` と
  `orchestrator await` を再アームする。task状態とdurable inboxが正本で、heartbeat実行だけをdelivery receiptや
  task処理済みの証拠にしてはならない
- Mac/project singletonへ固定しない。各automationは対象identity・project・threadを明記し、別identityの
  primary taskを奪わない。複数identityが同一projectを分業する場合もautomationを責務単位に分ける
- planned thread交代では、§55のsession handoff accept後、新thread側がautomationのtarget threadと
  promptの担当情報を能動更新し、必要な予約のtarget/有効状態をview/readbackしてから旧threadを終了する。
  mutation前のsession/generationは現在値を解決し、古い予約に埋め込まれた値を権限証拠にしない。
  更新失敗時は旧automationを消さず、回収経路不成立として明示する。突然死takeoverも同じreadbackを行う
- 公式面がscheduled heartbeatのみで、外部eventから任意threadへmessage注入してwakeするAPIが無い環境では、
  即時wakeやreceiptを偽装せず、上記の時限回収とdurable queueで運用し、未実証のbounded latencyを約束しない

## 51. ワーカー子プロセスの回収と資源ハイジーン（v0.10）

背景: bridge（even-terminal → codex app-server）配下に終了済みセッションの子プロセスが蓄積し
（2026-07-08 実測: codex 本体配下に 760 プロセス、10時間超の MCP サーバー群を含む）、spawn 制限
（os error 35）でワーカーが自衛的に並列度を落とす性能劣化が反復していた（t_ef3c87b4）。
direct レーンは §34.2 で process group kill 実装済みのため、本節は bridge 孤児の定期回収を本丸とする。

### 51.1 direct レーンの完結性（補強）
- run の正常 close（finalize）時にも killProcessGroup を**ベストエフォート**実行し、リーダー終了後の
  残留孫プロセスを掃除する（既に空なら ESRCH を無視）。§34 max-runtime の stop が direct で
  発火することをテストで担保（既存機構の回帰固定）

### 51.2 bridge 孤児ハイジーン（reap ステージ拡張）
- 対象の特定: kanban-shared-app-server（launchd）の子 codex 本体を解決し、その**子孫プロセス**のうち
  **経過時間 > resourceGuard.maxRunSeconds（未設定時 7200s）+ 1800s マージン**のものを孤児と判定する
  （正当なセッションは max-runtime で回収されるため、それより古い子孫は定義上孤児）
- 回収: プロセスサブツリー単位で SIGTERM → 10s 猶予 → SIGKILL。**1 tick の回収上限 50**（暴走防止）
- 保護（fail-closed）: app-server 本体・codex 本体・閾値未満・bridge ツリー外は**不可触**。
  ps/pgrep/kill は DI 注入（テストは fake で、実プロセスに触れない）
- dry-run 既定に従う: apply 時のみ kill、非 apply は件数 note のみ
- 記録: reap notes + 回収数。1 tick で 10 件超を回収した場合は §38 operational notify で警告
  （静かな劣化と静かな大量回収の両方を防ぐ）

### 51.3 可観測性
- doctor に「worker process hygiene」検査: bridge 子孫総数 / 孤児判定数 / direct 残留 group 数を表示し、
  子孫総数 > 200 で warn 扱い
- reap の回収結果は tick_metrics（§43）に載る（専用テーブルは作らない）

### 51.4 ワーカー向け運用
- worker prompt 恒常節（§32.4 と同枠）に追記: 「ハング子プロセスは supervisor が run 終了時・定期に
  回収する。spawn 失敗（os error 35）時は自衛の直列化より、まず handoff/コメントで報告する」
- sandbox 内での ps/kill 許可整備は follow-up（sandbox ポリシーは bridge 側の領分のため本節対象外）

### 50.3 `hachi task logs` — ワーカーログの統一 CLI（§50 拡張）
- `hachi task logs <id> [--follow] [--tail <n>=40] [--head <n>] [--json]`
- **コンテキスト経済が第一要件**（ユーザー要望 2026-07-08）: 呼び出し側は LLM オーケストレーターであり、
  全量出力はコンテキストウィンドウを圧迫する。既定は末尾 40 行。`--head <n>` で冒頭 n 行（起動直後の
  プロンプト・初動確認用）、`--tail <n>` で末尾 n 行。--head と --tail の併用は「冒頭 n + … + 末尾 m」の
  省略表示。全量が必要な場合のみ `--tail 0`（無制限）を明示させる
- タスクの**最新 run** を解決し、transport に応じて出力を統一する:
  - direct: `state/direct-sessions/<sessionId>.out` を tail（--follow はファイル追尾）
  - bridge: adapter の fetchMessages（/api/messages）から text/tool イベントを人間可読に整形して表示
    （--follow は 5s ポーリングで差分追記。既存 read 経路を使い、生 curl / token 直扱いをしない）
  - run が無い/終了済み: artifacts の transcript（最新）を tail して「終了済み」を明示
- 読み取り専用・書き込みなし。--json は整形前のイベント/行をそのまま流す
- 用途は **reactive な診断に限定**する。参照してよい起点は、(1) worker-question を担当
  orchestrator が claim した時、(2) `task await` が `needs-manual:` / `review-required:` を返した時の
  初回原因確認、(3) 人間が明示的に状況照会した時、の3つ。`task await --all --follow-new` / `orchestrator await` の
  発火前に「進捗が気になる」という理由で繰り返し transcript を読む運用は禁止する。worker が生成した
  出力を orchestrator が再読込する二重トークン消費となり、イベント駆動監視の契約にも反するためである
- `--follow` は原則使用しない。例外的に使う場合は、上記3起点のいずれか、診断目的、終了条件を先に
  明示し、時限で終了する。常駐監視や stall 検知には使わない（stall は §50.2 の supervisor が担う）
- `--tail 0` は既定40行で原因を特定できないインシデント調査に限る。通常は `--head` / `--tail` の
  最小行数を選び、全 transcript をオーケストレーターのコンテキストへ取り込まない

## 52. オーケストレーター⇔ワーカーの双方向連絡（v0.10）

目的: 走行中レーンへの追加指示（orchestrator→worker）と、前提不足時の質問（worker→orchestrator）を
CLI と board の正規経路に載せる（curl/token 手打ちや推測続行の排除。t_ef3c87b4 の派生要望）。

### 52.1 orchestrator → worker: `hachi task steer`
- `hachi task steer <id> (<text> | --file <path>) [--wait <sec>] [--supersedes <deliveryId>] [--restart] [--json]`
- 最新 open run の transport で配送を分岐:
  - **bridge**: agent.message.v1（intent=steer, from-role=orchestrator）を書き込み、messages ステージが
    次 tick で injectSession 配送（既存機構の porcelain 化）。送信時に §58 の delivery を current
    task/run/session/cancel fence へ固定し、`--wait` は lifecycle をポーリングして
    transport accepted / session observed / acknowledged / unknown を区別して返す。
    `--supersedes` は同一 run/session の未acknowledged deliveryを明示訂正する
  - **direct**: 一方向プロセスのため**注入不可を明示して拒否**。`--restart` 指定時のみ
    exact active orchestratorとtaskの単一primary authority、current run/session/cancel fenceをStore transactionで
    durable intentへ固定してからstop（§34.2 process group）する。stop後のtransactionでも同じintent・authority・
    current run/session/fenceを再検証し、run を stopped で close → body 先頭に
    「## ⚠ オーケストレーター介入 (日時)」+ 指示文を prepend → ready へ再投入、を一括実行
    （進行は失われる。別owner、旧generation、旧run/fenceではstop前に拒否し、監査コメントを必ず残す）
- open run 無しは拒否（edit-body + re-ready を案内）。介入文は常に task コメントにも記録（監査）
- **transport 分岐は「このコマンドの挙動」ではなく、steer を受理する全経路の accept-time 不変条件である**
  （2026-09-04 追加）。`hachi msg send --intent steer` のような plumbing 経路を含め、**steer を受理する側は
  current open run の transport を見て、inject 非対応の transport なら delivery を作らずに拒否する**。
  拒否メッセージには代替経路（direct なら `hachi task steer --restart`）を必ず含める。
  - 受理してから配送段で落とす実装にしてはならない。§17.2 が要求する「明確なエラー」が
    §58 の `uncertain` に化け、**恒久的に不可能な配送が一過性の失敗と見分けられなくなる**
    （2026-09-04 実測: direct run へ `msg send --intent steer` が受理され、`serverUrl="direct"` を
    URL として解釈した配送段が `Invalid URL` で落ちて `steer_delivery_uncertain` になった）
  - 万一 accept 段を抜けて配送段に到達した場合も、**`uncertain` では終端させない**。
    「この transport は inject 非対応」と判別できる終端状態にする（§58）

### 52.2 worker → orchestrator: handoff outcome=question
- `hachi-handoff-v1` の outcome に **`question`** を追加: `{taskId, outcome:"question",
  summary:"<質問文>", context?:"<判断に必要な背景>"}`
- finalize は question を受けたら task を `worker-question: <質問文冒頭>` で blocked にし、同じ Tx で
  §55 の durable request / delivery / notification outbox を作る。bridge は §52.4 の session 温存、direct は run close。
  `worker-question:` は Web のオーケストレーター回収待ちレーンにも残し、inbox 障害時の recovery 面にする
- worker prompt 恒常節（§32.4 枠）に追記: 「前提・仕様が不足して判断できない場合は、推測で進めず
  outcome=question で質問して終了する。回答は再起動時の body 冒頭に届く」

### 52.3 orchestrator の回答: `hachi orchestrator answer`
- 標準は `hachi orchestrator await` で request を claim し、`hachi orchestrator answer <requestId> <text>
  --session <id> --generation <n> --claim <token>` で回答する（§55）。
- `hachi task answer <id> ...` は active orchestrator request が存在しない legacy/recovery タスク専用。
  active request があれば session fencing を迂回できないよう拒否する
- body 先頭に「## オーケストレーター回答 (日時)」+ 直前の質問（worker-question から転記）+ 回答文を
  prepend → `worker-question:` blocked から ready へ再投入。回答は task コメントにも記録（監査）
- 質問→回答の往復は task_events で追跡可能にする（question_asked / question_answered）
- fenced answer の受理後、messages stage が処理する前に task が done/archived へ到達していても、終端 task は
  復帰・本文変更せず `message_processed` + `message_target_terminal(intent=answer)` と exact `answer_key` の
  request resolve を同一 Tx で確定する。`orchestrator_request_terminal_answer_resolved` は requestId・
  consume/reconcile 区分・終端 status・根拠 event 名だけを持ち、回答本文や claim token を監査 payload に含めない。
  外側の終端判定後に終端化する競合も、answer fallback Tx の mark 直後に再検証して同じ terminal consume へ収束させる

### 52.4 worker 質問のライブ化（v0.10・Fable×Codex 5.5 x-high 設計 2026-07-08）
§52.2 の worker 質問は現状 run close→再起動（新セッション・文脈喪失）。bridge は injectSession できるため、
質問→**セッション温存**→回答**ライブ注入**で文脈を保って継続する（direct は resume 不可のため現行維持）。

- **result watermark（2026-07-09 修正）**: session_ended の watermark は **lastResultId（窓内最後の result の単調 id）優先・無ければ legacy resultCount**。
  bridge の 500 件リングバッファで resultCount(窓内件数)が非単調になり long session で回答注入後の完了検知が
  詰まる問題を根治（lastResultId は 500cap でも単調）。resultCount は併記のまま維持。以下は初版記述:
- **resultCount watermark**: monitor の `session_ended` payload に resultCount（そのセッションで観測した result 数）を
  持たせ、**同一セッションでも resultCount 増加ごとに session_ended を記録**（従来は session 単位1回）。
  legacy payload（resultCount 無し）は 1 相当・「記録済み最大 < 現在」でのみ追加記録（既存冪等性を壊さない）
- **question_awaiting**（bridge のみ）: finalize が outcome=question を検出したら run を**閉じず**、
  `worker-question:` 付替 + `question_awaiting`（sessionId, baselineResultCount, deadline, questionId）を記録。
  deadline = min(now + QUESTION_GRACE_SECONDS(1800), run.startedAt + maxRunSeconds)。
  再処理防止: resultCount<=baseline の間は finalize スキップ、resultCount>baseline（回答後の新 turn）で通常 finalize 再開
- **isLiveQuestionAwaiting(task, openRun, now)** 専用 predicate: reap/resource-guard のみが使う。
  **isInProgressReason は変更しない**（listInProgress/monitor が2 prefix 専用に依存するため）。
  reap は有効 question_awaiting の open run を孤児扱いしない。deadline 超過は `question_expired` で run を released。
  resource guard は question_awaiting の open run を maxInFlight にカウント（grace が上限の backpressure）
- **回答注入（lease-first・外部副作用 intent）**: §55 の fenced `orchestrator answer` が
  agent.message.v1(intent=answer, idempotencyKey) を書く。実処理は messages.handleAnswer:
  1. `question_answering` lease（leaseUntil = now + ANSWER_LEASE_SECONDS(120)）を Tx で claim（reap と競合）
  2. lease 勝ち + bridge + deadline 内 → `adapter.inject(ref, 回答)` → **成功時にのみ** message_processed を mark +
     `question_answered(injected:true)` + block_reason を `<provider>-in-progress:` へ復帰（run は open のまま worker 継続）
  3. inject 例外 → `question_answer_inject_failed` + lease 解除 → `worker-question:` のまま再回答可能（自動 fallback しない）
  4. lease 取得失敗 / run 閉 / direct / deadline 超過 → 現行 body prepend + re-ready（injected:false）
  - lease-first→inject→成功時mark が二重inject と回答喪失の両方を防ぐ。DB UNIQUE(§12.9-1)は完了記録として整合。
    §12.4/§12.10 の answer 分類は「bridge answer は lease-first の外部副作用 intent」として本節で上書きする
- **prompt.ts**: buildWorkerPrompt に transport を渡し、bridge は「質問後このセッションへ回答が注入される（待機）」、
  direct は現行「終了」文言に分岐
- **実装分割**（安全順）: ①resultCount watermark + legacy 互換 → ②question_awaiting/reap expire/resource guard/prompt
  分岐 → ③task answer/Telegram の live 化(lease/inject/fallback) → ④統合テスト + 通知 questionId

## 53. handoff 欠落の救済リプロンプト（v0.10、v0.12 抽出境界補強）

背景: bridge worker（特に大規模タスクの gpt-5.5）が作業を実質完了しながら、締めの
`hachi-handoff-v1` フェンス出力に到達せずターンを終えるケースがある（2026-07-08 実測: session_ended
直後に handoff_missing、生 rollout の handoff 出現はプロンプト側のみ）。現状は即 needs-manual 直行で、
オーケストレーターが手動で裏取り・クローズしていた。bridge セッションは thread/resume で永続するため、
needs-manual に落とす前に**1回だけ**締めの出力を促して自動回収する。

### 53.0 handoff / verdict フェンスの抽出境界
- handoff と reviewer verdict の正本は、adapter が返す**構造化された assistant 最終 result**である。
  prompt、user message、注入した形式例、tool input を含む transcript 全文へ正規表現を掛けてはならない
- 構造化 result が取得不能な fallback では、role 境界を保持した parser で assistant 発話だけを対象にする。
  role 不明・未知 message type・途中欠落は `extraction_failed` とし、user領域のフェンスへ探索を広げない
- 同一 assistant result に複数フェンスがある場合は**末尾の同名フェンスだけを評価し**、手前のフェンスは候補に
  しない（2026-09-02 改訂、t_c2b98b7cd04ac394。旧規則「末尾の**有効**フェンス」は、末尾のテンプレが malformed だと
  手前の valid フェンス（prompt エコー由来の task body 内 fence 等）を拾い、未実施の handoff を受理しうる）。
  末尾フェンスに対して taskId/run/session と schema を照合し、placeholder、taskId不一致、malformed JSON は
  それぞれ明示理由（malformed は `parse_invalid`）で fail-closed に拒否する
- reviewer verdict にも同じ抽出境界を適用する。prompt内の `hachi-verdict-v1` 例示を
  `verdict_missing` / `parse-invalid` の根拠として利用しない

### 53.0.1 実出力ゼロ・provider拒否の先行分類
- `turns=0` かつ input/output token が0、またはadapterがprovider拒否を構造化報告した run は、フェンス抽出より
  先に launch/provider failure として処理する。promptの例示フェンスから `placeholder_summary` や
  `verdict_missing` を生成しない
- 既知分類は `provider_capacity_exceeded` / `incompatible_model_transport` / `cli_startup_failed` /
  `worker_output_missing` / `extraction_failed` / `parse_invalid`。未知は安全側の `worker_output_missing` とするが、
  provider/CLI起因を worker の手抜き・形式違反と表示しない
- providerが再開時刻等を返した場合はredact後の短い診断だけをevent/commentへ保存する。自動再試行は既存budgetと
  同一reasonサーキットブレーカに従い、0-token failureをhandoff nudgeやreview reworkへ流さない

### 53.1 適用条件（すべて満たす場合のみ）
- finalize が handoff 欠落（block=null または parse 失敗）を検出
- transport=bridge（direct は一発プロセスで resume 不可のため対象外 = 従来どおり needs-manual）
- この run でまだ救済していない（`handoff_nudge_sent` イベントが当該 sessionId で未記録 = 冪等・1 run 1回）

### 53.2 動作
- needs-manual 付替の**代わりに**、bridge セッションへ救済プロンプトを injectSession（§52 の注入経路）:
  「作業は完了しているようですが、出力の最後に hachi-handoff-v1 フェンスがありません。**新たな作業はせず**、
  ここまでの outcome（done/review/question）と summary を hachi-handoff-v1 フェンスで今すぐ出力してください」
- `handoff_nudge_sent` イベント（sessionId・ts）を記録し、**open run は close せず維持**する
  （block_reason は in-progress のまま = monitor が継続監視）
- 注入失敗（bridge 不達・セッション消滅）は即 needs-manual に倒す（fail-open。従来動作へ）

### 53.3 グレースと確定
- 以降の finalize tick で transcript を再取得し、handoff が現れたら**通常の done/review/question 経路**で処理する
  （two-party gate 不変: 促しただけで検証は従来どおり）
- 救済プロンプトから **grace（既定 10 分・config 化不要の定数）** を超えても handoff が出ない場合、
  従来の needs-manual 付替を行う（コメントに「救済リプロンプト後も未取得」を明記して監査に残す）

### 53.4 非対象・follow-up
- direct レーンの救済（resume 不可）
- 未知 message type の生エントリ全文スキャンは行わない。adapter側でrole付き構造化 resultへ昇格できるまで
  `extraction_failed` として fail-closed に扱う

## 54. セッション完全記録の永続化と過去閲覧（v0.10）

背景: セッション詳細のライブ表示は bridge `/api/messages` に依存し、even-terminal は直近 **500 件**の
リングバッファしか保持しない（2026-07-08 実測: 終了セッションでも 500 件で頭打ち = 過去に遡れない）。
finalize が保存する transcript artifact は `result` テキストのみ（ツール実行・パッチ活動が欠落し薄い）。
完全な履歴は codex の生 rollout にのみ存在するが web は読んでいない。ライブ=揮発、過去=永続の二層に整理する。

### 54.1 run 終了時の完全記録アーカイブ（supervisor）
- finalize（run close 経路）で、**完全記録 artifact** を保存する:
  - codex bridge session: `~/.codex/sessions/**/rollout-*<sessionId>*.jsonl` を読み、full-fidelity な
    整形テキスト（`[user]` prompt / `[assistant]` text / `[tool] <name> <要約>` / `[patch] <path>` 等、
    除外せず時系列）を `transcript-full-<sessionId>.txt` として artifacts へ保存
  - direct session: `state/direct-sessions/<sessionId>.out`（全ログ）を同名規約で artifact 化
  - rollout/out が読めない場合は従来の bridge messages ベース transcript（500cap でも）をフォールバック保存し、
    その旨を記録（best-effort・fail-open。保存失敗で run close を止めない）
- 秘匿値は redact（既存 redactText）。サイズ上限（例 2MB）を超える場合は末尾を優先し先頭を省略注記

### 54.2 過去セッションの閲覧（web）
- `/api/session/:id/transcript` は完全記録 artifact（`transcript-full-*`）を優先し、無ければ従来の
  `transcript-*` にフォールバックする。sessionId→taskId の紐付けは task_runs（永続）で解決する
  （終了セッションでも解決可能にする。現行 runningSession 依存を残す場合も status 制約を課さない）
- セッション詳細ビュー: **state=ended は既定で完全記録を表示**（ライブ 500cap ではなく）。
  実行中（state=running）は従来どおりライブ + 直近窓
- 導線: タスク詳細から「セッション記録を見る」で過去セッションへ到達可能にする（running 一覧に無くても開ける）

### 54.4 実行中 direct セッションのライブ閲覧（v0.10・ユーザー要望 2026-07-08）
背景: direct transport（§49 override）は bridge を通らずライブ閲覧が一切できず（`/messages` は 501）、
完全記録 artifact は finalize（run 終了時）にしか生成されないため、**実行中は中身が全く見えない**という
実害があった。direct adapter は実行中も `state/direct-sessions/<sessionId>.out` に生ログを書き続けているので、
これをライブ表示に使う。

- web に `GET /api/session/:id/live?taskId=&tail=`（direct 専用）を追加:
  `$HACHI_KANBAN_HOME/state/direct-sessions/<sessionId>.out` を読み、末尾 `tail` 行（既定 200・上限で頭を省略注記）を
  返す。sessionId→taskId は task_runs（永続）で照合し、その run の transport=direct のときのみ許可（他は 404）。
  redactText 適用・パストラバーサル防止（`.out` パスが state/direct-sessions 配下に収まることを検証）
- SessionsPanel: `liveSupported=false`（direct）かつ run が open のとき、501「非対応」を出す代わりに
  `/live` を**ポーリング表示**（既定 3s・末尾追尾）。run が closed になったら §54.2 の完全記録表示へ切替
- direct の `.out` はセッション終了後も finalize が artifact 化するまで残るため、closed 直後の空白も
  `.out` フォールバックで埋められる（best-effort）

### 54.3 非対象
- bridge のリングバッファ拡張（even-terminal 本体の変更）は行わない。ライブ窓は 500 のまま、
  過去閲覧は完全記録 artifact で担保する

### 38.5 通知の先頭アクション見出し（v0.10・ユーザー要望 2026-07-08）
背景: iPhone push / Even G2 は通知の先頭数語しか見えず、現行フォーマット（先頭行 `title: <タスク名>`）
では「完了なのか新規起票なのか」が読み取れない。全通知の**先頭**に、絵文字+短い日本語アクション見出しを
付けて一目で種別が分かるようにする。

- NotifyMessage に `actionLabel: string`（例 `✅ 完了`）を持たせ、送信テキストの**最初**に出す:
  - Telegram 先頭行: `<actionLabel> — <title>`（その後に id / 理由 / url を従来どおり続ける）
  - macos: title を `<actionLabel>` に、message 先頭を `<title>` にする
- 見出しの導出（種別ごと・fail-closed で不明時は `🔔 通知`）:

| 種別 | 判定 | actionLabel |
|---|---|---|
| human-queue | `review-required:` | 🔍 要レビュー確認 |
| human-queue | `user-decision:` | 📋 要判断 |
| human-queue | `user-feedback:` | 💬 要フィードバック |
| human-queue | `needs-manual:` | ⚠️ 要対応 |
| human-queue | `auto-launch-failed:` | 🔁 起動失敗 |
| human-queue | `worker-question:` | ❓ ワーカー質問 |
| human-queue | `user-question:` | 📋 人間への質問 |
| watched 遷移 | to=done | ✅ 完了 |
| watched 遷移 | to=review | 🔍 レビュー入り |
| watched 遷移 | to=ready | 🆕 起票/着手可 |
| watched 遷移 | to=blocked かつ in-progress | ▶️ 進行中 |
| watched 遷移 | to=archived | 🗄 アーカイブ |
| watched 遷移 | 上記以外 | 🔄 状態変化 |
| operational | id=`brief` | 🗓 ブリーフ |
| operational | id が `bridgewatch:` 始まり | 🚨 bridge警告 |
| operational | id にhygiene/reap相当 | 🧹 資源警告 |
| operational | id にstall相当 | ⏳ 停滞警告 |
| operational | id が `orchestrator-question:` 始まり | 🤖 オーケストレーターへ質問 |
| operational | id が `human-question:` 始まり | 📋 人間への質問 |
| operational | id が `orchestrator-unavailable:` 始まり | ⚠️ オーケストレーター未回収 |
| operational | その他 | 🔔 通知 |
| steward escalate | ad-hoc kind=escalate | 📣 要方針判断 |
| steward promote | ad-hoc kind=promote | ⬆️ 昇格提案 |
| steward archive | ad-hoc kind=archive | 🗄 アーカイブ提案 |
| steward spec-lint | ad-hoc kind=spec-lint | 📝 仕様指摘 |
| steward（種別不明） | ad-hoc kind 無し | 🏛 steward |

- redaction は従来どおり title/理由に適用（actionLabel は固定語彙なので redact 不要）。
- steward 提案（ad-hoc 通知経路）は `sendAdHocNotification` に提案 kind を明示的に渡し、上表で label 化する
  （メッセージ本文の prefix 解析に依存しない）。kind 未指定は `🏛 steward`。
- 既存の inline keyboard（承認ボタン §42）・reasonHash・重複抑止は不変。

### 30.5 bridge ポート乗っ取りの自動修復（v0.10・ユーザー要望 2026-07-08）
背景: tenant-a の workerd 等が bridge port（3456/3457）を `127.0.0.1:<port>` で specific bind すると、
even-terminal（`*:<port>` wildcard）への localhost 接続を横取りし、bridge が 404 化する。webwatch は
identity 失敗を検知・通知するが自動修復せず、乗っ取り中は override が bridge capability を取れず direct に
落ちて G2 非表示になる実害があった（2026-07-07/07-08 の2回）。**明確な signature に限定した自動 kill** で根絶する。

- **発動条件（すべて満たす場合のみ・fail-closed）**:
  1. webwatch identity 失敗が `suspectPortHijack=true`（404/HTML/異形 = 応答者が even-terminal 本人でない）
  2. 連続失敗が閾値到達（乗っ取り種別は soft 扱い済みの現行 requiredBridgeFailures を流用）
  3. kill-switch `~/.hachi-kanban/webwatch-autoheal.disabled` が存在しない
- **kill 対象の特定（安全 signature）**: bridge port の LISTEN プロセスを lsof で列挙し、
  **`127.0.0.1:<port>` または `[::1]:<port>` の specific bind**（= 横取り側）だけを対象にする。
  **`*:<port>`（wildcard = even-terminal 本人）は絶対に kill しない**。even-terminal の wildcard bind が
  同時に存在すること（本物の bridge が下に生きていること）を確認できた場合に限り実行する
- **実行**: 対象 PID へ SIGTERM（プロセスグループでなく単一 PID。他への波及を避ける）。kill 後に identity を
  再確認し、回復したら `bridge_autoheal` イベント記録 + §38 operational notify（🧹 資源警告系。何を kill したか
  =PID/コマンド先頭のみ、機密は出さない）
- **冪等/暴走防止**: 1 tick 1 provider 1回。kill しても回復しない場合は通常の identity 警告へ倒し、
  同一 PID への再 kill はしない（同 PID を state で記録）
- lsof/ps/kill は DI 注入可能にし、テストは fake で実プロセスに触れない

### 30.6 非対象（従来どおり）
- wildcard bind の even-terminal 本人・bridge 死亡（応答なし）は kill 対象外（再起動は launchd KeepAlive に委ねる）。

## 55. worker 質問のオーケストレータールーティング（v0.11）

目的: `worker-question:` を人間へ直接転送せず、関心範囲を登録したオーケストレーターへ durable に配送し、
解決できない場合だけオーケストレーターが人間へ昇格する。複数 project・複数 worktree・同一 project 内の
複数オーケストレーターを前提とし、Mac 単位の singleton を仮定しない。

### 55.1 identity / session / watch
- **orchestrator identity** は責務を表す安定 ID。watch と task binding は identity に属し、セッション交代で変えない
- **orchestrator session** は一時的な実行実体。identity 内で単調増加する `generation` を持つ。
  claim/answer/escalate は `(orchestratorId, sessionId, generation, claimToken)` を Store 層で検証し、
  active でない旧 generation からの mutation は fail-closed で拒否する
- watch scope は `task | subtree | worktree | project`、role は `primary | collaborator | observer`。
  `worktree` は canonical realpath、project は Git common-dir（取得不能時は tenant）を識別子とする。
  subtree 継承は `subtask` link のみで、`depends-on` は責務継承に使わない
- task の明示 binding を routing の正本とし、解決順は
  `task binding > subtree > exact worktree > project > fallback`。observer は閲覧のみで claim 不可

### 55.2 durable request / delivery / claim

> **request kind（2026-08-29 拡張。main=755cebe → cd8fdf1）**:
> `worker_question | run_stalled | run_stall_suspected`。
> delivery と claim の機構は共通で、**解決操作だけが kind 別**である。
> - `worker_question` → `hachi orchestrator answer` / `escalate`
> - `run_stalled` / `run_stall_suspected` →
>   `hachi orchestrator resolve <request-id> <handled|false_positive> <reason>`
>   `--session <id> --generation <n> --claim <token>`（fence 必須）
>
> `answer` / `escalate` は `kind=worker_question` 以外を拒否し（`run_stalled` と
> `run_stall_suspected` の**どちらも**拒否する）、`resolve` は
> **`run_stalled` と `run_stall_suspected` の2つを受け、`worker_question` を拒否する**。
> resolve が作る event は kind 別に分かれる
> （`orchestrator_run_stalled_resolved` / `orchestrator_run_stall_suspected_resolved`）。
> **worker-question の active-request 判定も `kind=worker_question` に限定する**
> （§69.1 で指摘済みの kind 衝突を避けるため）。
> 各 kind の生成条件と冪等キーは §50.2 が正本
> （`run-stalled:<runId>:<sessionId>` / `run-stall-suspected:<runId>:<sessionId>`。
> 接頭辞が互いの前方一致にならないことが kind 導出の前提である）。
> **`run_stall_suspected` だけは cancel request を伴わない警告専用**であり、
> resolve しても run は止まらない（§50.2）。
> 配送先は kind によらず §55.1/§69.3 の正本 resolver を使い、live session が無い場合も
> identity 宛て delivery を durable に保持して次世代が claim する。

- finalize が `outcome=question` を受理する Tx で `orchestrator_requests` を一意な `questionId` から作り、
  対象 identity ごとの `orchestrator_deliveries` と FYI `notification_outbox` を同時に作る
- request status は `queued | delivered | claimed | answering | waiting_human | resolved | cancelled`。
  `orchestrator inbox/await` が delivery を `delivered` にし、claim 成功を acknowledge とする。
  未配送を「対応中」と表示しない
- primary が claim 可能。primary 不在・lease 切れ・明示 release 後に collaborator、最後に fallback が claim する。
  claim は CAS + lease。複数候補が同時実行しても resolver は1つだけ
- 既存 `task answer` / `msg send --from-role orchestrator` は active request を迂回できない。
  active request がある answer は、request に記録された idempotencyKey と fenced session claim が一致する場合だけ処理する
- messages stage は stale な `answering` request を毎 tick 冪等 reconcile する。ただし対象 task が done/archived で、
  **同一 task 上**に exact `answer_key` の `message_processed` と
  `message_target_terminal(intent=answer,status=done|archived)` が両方存在する場合だけ `resolved` へ進める。
  時刻・status 単独・片方だけの event・別 key/intent から推測して回収しない。queued/delivered/claimed/
  waiting_human と非終端 task はこの reconcile の対象外
- orchestrator-routing stageは`queued/delivered` requestを現在のtask bindingとactive watchへ毎tick冪等再評価し、
  作成後に追加された担当への不足deliveryだけを追加する。既存deliveryは削除・付け替えない。taskがdone/archivedへ
  先行し、まだclaimされていない`queued/delivered`だけは`cancelled`へ収束させる。`claimed/answering/waiting_human`は
  この回収対象にせず、既存claim/answer fenceを維持する

### 55.3 セッション交代
- 計画交代: `handoff prepare` で旧 session を `handoff_pending` にし新規 claim を停止する。
  `handoff accept` は新 generation 作成、旧 session の `superseded` 化、watch と claim の移管を同一 Tx で行う
- 突然死: heartbeat 期限切れの active session だけ `takeover --if-stale` を許可する。
  新 generation を作り、旧 claim は移管せず queued へ戻す。復活した旧 session の mutation は拒否する
- supervisor の `orchestrator-routing` ステージは 90 秒超の active session（期限内 handoff_pending を除く）を
  stale 化して claim を queued へ戻す。stale 化を通知だけへ置き換えず、屍体 session を active のまま維持しない。
  新セッションは `session takeover` または `session start` で能動的に世代更新する
- heartbeat 更新が直前の `heartbeat_at` から 90 秒超空いた場合は、更新と同一 Tx で
  `orchestrator_liveness_incidents` へ session/generation 単位の gap を先に記録する。復帰 heartbeat が
  `heartbeat_at` を更新しても incident は消えない。supervisor が active session を stale 化する場合も、同一 Tx 内で
  status 更新より先に同じ incident を `INSERT OR IGNORE` し、heartbeat 復帰との順序に依存せず少なくとも一方が記録する
- liveness incident は `pending | sent | exhausted`、通知試行回数、次回試行時刻、bounded error、送達時刻を durable に持つ。
  notification transport が `sent=true` を返した時だけ `sent` とし、attempted だけでは抑止しない。失敗は bounded backoff で
  再試行し、上限到達は `exhausted` として row・stage note・構造化 log から観測可能にする。同一 session/generation は
  unique とし、通知失敗・supervisor 再起動・late heartbeat で重複 incident/通知を作らない
- liveness 通知本文は gap 秒数と session/generation、provider/native session ID、手動の takeover/start 手順を含める。
  supervisor は通知のために session を active へ戻したり新 generation を開始せず、自動再登録もしない
- 並行分業は takeover/resume ではなく別 identity を register し、watch/binding を分割する
- `hachi orchestrator handover --apply`（後継 tmux セッションの自動起動）が tmux 起動・起動確認・
  token 送達のいずれかに失敗して補償境界へ入る場合、ownership 確認や kill より先に handoff token hash を
  CAS で使用不能な hash へ回転し、旧 token による後継の accept を締め出す。回転時は status を
  `handoff_pending` のまま、`handoff_expires_at` も元の TTL のまま維持する。回転が成立した場合だけ対象 tmux
  セッションの停止確認へ進み、停止を確認できたときだけ回転後 hash を CAS 条件として
  `cancelOrchestratorHandoff` で `handoff_pending → active` に戻す。`heartbeat_at` も同時更新して
  ロールバック直後の stale 判定を防ぐ。回転が成立せず、再読した旧 session が `superseded` なら後継の
  accept 済みとして kill せず handover 成功にする。それ以外は判定不能として kill も rollback も行わず、
  旧セッションとの二重稼働を避けるため手動対応を促す
- 起動前に cwd の Claude trust 承諾と、executable + argv 全体の UTF-8 byte 長（上限15,000）を
  preflight する。trust dialog は自動応答しない。起動プロンプトは token を argv に載せる現行契約を維持し、
  token と独立した launch nonce も載せる
- token 送達は後継 transcript jsonl の nonce 一致 `type:"user"` 行と、その後の `type:"assistant"` 行の
  2段階で確認する。ファイルの存在だけを送達証拠にしない。timeout・probe error・session 消滅は
  `unknown`（token 消費の可能性あり）であり未送達へ丸めず、同じ token で再 launch しない。
  停止・cancel 補償で active に戻した後の再実行だけが新 token を発行する
- 自動 cancel できず `handoff_pending` が残った場合は、exact tmux session・pane PID・process group の
  停止確認後だけ `orchestrator session handoff-cancel` を許す。同コマンドは generation・token hash の CAS と
  `--confirm-successor-stopped` を必須にする。JSON 出力は従来フィールドに加え、command byte 実測値、
  `delivery`、送達確認元を示す `delivery.confirmedVia`（`transcript` / `session-accepted`）、unknown 時の
  `tokenDisposition` / `retryPolicy`、必要時の `recoveryCommand` を返す。`recoveryCommand` の
  `--token-hash` は補償境界で回転した後の hash を指す

- `--apply` は `delivery.status=unknown` を **上限付きで自動再試行する**。`--max-attempts <n>` は
  1〜5 の整数で既定は 3。各試行は独立した durable slot・handoff token・後継 session id・launch nonce を
  新規に発行し、**同一 token で再 launch しない**。次の試行へ進むのは、直前の試行が
  (1) `delivery.status=unknown` であり、かつ (2) 補償が完了している（slot が `stopped`、exact tmux
  session / pane PID / process group の三点消滅、source session が同一 generation で `active` へ復帰）
  の両方を store から再読して確認できた場合だけとする。補償未完了なら再試行せず
  `retryInstruction="do-not-retry"` で止める（二重稼働の回避を上位に置く）。
- JSON 出力は `maxAttempts` と `attempts` を含む。`attempts` は試行ごとに `attempt` / `slotId` /
  `successorSessionId` / `slotStatus` / `failureReason` / `durationMs` を持つ。
- delivery 失敗時は `retryInstruction` と `retryGuidance` を返す。`retryInstruction` は
  `rerun-with-new-token`（補償完了・上限未到達）/ `retry-budget-exhausted`（補償完了・上限到達）/
  `do-not-retry`（補償未完了）の3値とする。**上限到達を1回失敗と同じ出力にしてはならない。**
  上限到達時は `attemptsExhausted` を真として載せ、`retryGuidance` は再実行を勧めず、後継 transcript の
  `type:"assistant"` 行の有無を確認したうえで手動ブートストラップ（旧 session close → 新セッションから
  `session start`）へ切り替えるよう案内する。これは運用 runbook のエスカレーション梯子
  （「落ち続けるなら手動ブートストラップへ倒す」）への到達条件を出力に残すためであり、
  上限を設けた目的そのものである。`--max-attempts 1` は自動再試行を明示的に降りた指定なので
  上限到達として扱わず `rerun-with-new-token` を返す。
- `retryPolicy` / `tokenDisposition` は再試行の有無にかかわらず従来どおり
  （`new-token-required` / `possibly-consumed`）とする。再試行ループは必ず結果を emit して終える。
  **無出力・exit 0 で返してはならない**（自動化からは成功と区別できないため）。

### 55.4 human escalation / Telegram
- worker 質問登録時の Telegram は「オーケストレーターへ登録済み・返信不要」の FYI のみ
- オーケストレーターが明示 `escalate` した場合だけ task を `user-question:` に付け替え、回答可能通知を送る
- Telegram の human answer は worker へ直接 agent.message.v1 answer を送らず、request を
  `waiting_human -> queued` に戻して回答本文を request へ保存する。再 claim したオーケストレーターが解釈して worker へ回答する
- 通知は `notification_outbox` のみを正本とし、dedupe key は
  `(requestId, escalationGeneration, kind, transport)`。finalize 即時通知と blocked 全走査による二重送信は禁止
- outbox は成功済み transport を `sent_transports` に保持し、部分失敗の再試行で成功済み transport を二重送信しない

### 55.5 永続テーブル（migration v11 / v12）
- `orchestrators`
- `orchestrator_sessions`
- `orchestrator_watches`
- `task_orchestrator_bindings`
- `orchestrator_requests`
- `orchestrator_deliveries`
- `notification_outbox`
- `orchestrator_liveness_incidents`（migration v22。heartbeat stale gap と bounded 通知 retry の task 非依存 durable 面）

v12 は `notification_outbox.sent_transports` と stable identity の一意 index
`(label, project, repo_common_dir)` を追加する。`orchestrator register` は同じ組を再利用し、
新セッションが既存 identity を見失って重複登録しない。

既存 DB の `worker-question:` は routing ステージが `question_asked` / `question_awaiting` event から冪等 backfill する。
既存 live worker session（§52.4）は維持し、期限切れ/direct は従来の body prepend + ready fallback を使う。

### 55.6 CLI / Web / doctor
- 担当範囲の読み取りは次で行う。**一覧専用の判定規則を新設せず、§69.3 の配送先解決をそのまま用いる**
  （配送先と一覧が乖離しないことが要件）:
  - `hachi task list --orchestrator <id>`: task binding の非 observer を優先し、binding が0件のときだけ
    scope tier 順（task → subtree → worktree → project）に watch を辿る
  - `hachi task list --subtree <task-id>`: 指定タスクと `subtask` 子孫を返す。循環リンクがあっても停止する
  - 絞り込みは `--limit` より先に適用する。`--limit` は「該当タスクの件数」を意味する
  - `hachi orchestrator watch list [--all]`: 既定は active のみ。並びは §69.3 の解決順とし、
    `subtree` scope は対象タスクのタイトルを添える
- **オーケストレーターのミッションとスコープは board で表す**（identity には目的を持たせない）。
  ミッション task の body に目的・完了条件・対象範囲を書き、配下を `subtask` で連ね、
  スコープを `watch add --scope subtree --selector <mission-task-id>` で宣言する。
  セッション交代時は**ミッション task ID 1行**を引き継げばよい（運用は playbook §0.7）
- 初回: `hachi orchestrator register --label <責務名> --project <project> --cwd <worktree>`。
  cwd と Git common-dir は canonical realpath 化し、identity/session generation/primary worktree watch を作る
- 既存 identity は `hachi orchestrator list --json` で発見する。同じ label/project/common-dir の
  `register` 再実行は既存 identity と live session を返す（冪等）
- 起票時は `task create ... --orchestrator <identityId>`、既存タスクは `orchestrator bind <taskId>`。
  enqueue 子タスクは親の明示 binding を継承する
- 通常待機は `orchestrator await --session <id> --generation <n>`。回答不能なら fenced claim のまま
  `orchestrator escalate`、作業を戻すなら `orchestrator release`
- 計画交代は `session handoff-prepare` → 新セッションの `handoff-accept`。突然死だけ `session takeover`
- Web task 詳細は active request / binding / claimant generation / human answer を表示する。
  doctor は stale session と配送先のない active request を NG とし、Unavailableの先頭request/task IDをbounded表示する

## 56. Runtime resource lease（v0.12）

目的: worktree 実行時に作成する TCP port・Docker/Compose・専用 PostgreSQL を、task/run と stable
orchestrator identity に紐づく durable lease として管理する。Docker 名、経過時間、空 network という推測から
削除せず、作成前に登録した managed lease が所有する exact object だけを host supervisor が fenced request に
基づいて解放する。詳細設計と migration v13 DDL 案の正本補助は
`docs/plans/runtime-resource-lease.md` とする。本節と補助設計が矛盾する場合は本節を優先する。

### 56.1 所有権・authority・永続モデル

- logical owner は `(board, taskId, runId?, orchestratorId, repoCommonDir, canonicalWorktree)` とする。
  `orchestratorId` は stable identity、session ID/generation は mutation authority/fence であり owner ではない。
  Git common-dir と worktree は realpath を保存し、canonical path を確定できない新規 managed lease は拒否する
- lease は正の単調整数 `fence` を持つ。state/owner/expiry/heartbeat を変更する CAS は fence を進める。
  cleanup request は `expectedLeaseFence` と member snapshot hash を保持し、承認・execution 開始・各 side effect
  直前のすべてで一致を要求する
- logical bundle と concrete object を分離する。migration v13 は additive に次の面を追加する:
  `runtime_resource_requirements` / `runtime_resource_leases` / `runtime_resource_members` /
  `runtime_cleanup_requests` / `runtime_cleanup_deliveries` / `runtime_cleanup_attempts` /
  `runtime_resource_events` / `runtime_resource_outbox` / `runtime_resource_exceptions`
- bundle kind の初期集合は `worktree_postgres | worktree_preview | shared_main_db_exception |
  legacy_observation`、member kind は `compose_project | docker_container | docker_network |
  docker_volume | tcp_port | postgres_endpoint` とする。未知 kind/version/field は fail-closed で拒否する
- lease state は `requested | provisioning | active | cleanup_pending | expired | releasing | released |
  quarantined | failed | cancelled`。member ごとに managed/ephemeral/cleanup policy、exact native ID、
  Docker context、immutable `objectFence`、provenance、last observation を保持する
- DB row、Docker label、Compose project/name のどれか一つだけでは ownership を証明しない。DB member、exact
  engine object ID、required Hachi labels、Compose standard labels、Docker context の一致を conjunction で検証する
- PostgreSQL password、Docker credential、executor/claim token 平文、secret を含む URL は DB/task/event/label/
  prompt/artifact/notification に保存しない。secret は `$HACHI_KANBAN_HOME/runtime-secrets/<leaseId>/` の
  containment 検証済み 0600 path に置き、worker へは値でなく scoped path を渡す

### 56.2 実行主体と禁止事項

- worker は requirement/status の参照・許可 kind の要求だけを行える。heartbeat/renew/release、cleanup
  approve/apply、legacy adopt、Docker socket/API の利用を許可しない
- 担当 orchestrator は §55 の active session/generation/claim token で cleanup request を承認・拒否できるが、
  raw Docker mutator を直接呼ばない。observer は参照のみ。primary 生存中の collaborator は claim できない
- Docker cleanup side effect は host supervisor の `resource-cleanup` stage だけが行う。worker と同じ OS user
  であっても role 名を authority として信用しない
- `docker system prune` / `docker network prune` / `docker volume prune` / `docker compose down -v`、prefix/glob/
  name だけの delete を禁止する。この禁止は config で解除できない
- built-in `bridge`、共有 main DB、legacy/unowned、provenance 不一致、usage 不明、旧 generation、
  `docker_volume` を v1 の自動削除対象にしない。volume は managed/未接続でも preserve する

### 56.3 Provision・port・worktree PostgreSQL

- task/resource requirement を durable に登録し、`resource-reconcile` が CAS claim → lease/member 作成 → fresh
  inspect/health 検証を行う。required lease が active/ready でない task は dispatch が claim せず skip する。
  failed/quarantined は fail-closed block へ倒す
- dispatch は task claim 後にも lease state/fence/owner/worktree を再検証する。launch 成功 Tx で `ownerRunId` を
  一度だけ bind し、launch failure/claim 不一致/partial provision は作成済み member を失わず
  `cleanup_pending` request を作る
- TCP port scan を allocation lock に使用しない。Docker service は host port 0 を要求し、起動後に container ID、
  `127.0.0.1` の actual mapping、required labels、health/identity を inspect してから active にする。
  wildcard bind、複数 mapping、未知 IPv6 bind は拒否する
- host-native service は `listen(0)` または reservation FD 継承を使う。FD 継承不能な legacy launcher は scan を
  hint に格下げし、bind failure の bounded retryと actual listener PID/start-time/health 検証を必須にする
- worktree PostgreSQL の既定は専用 container と Docker built-in bridge、`127.0.0.1` の ephemeral host port
  とする。built-in bridge を lease member/所有物にせず、作成・削除・disconnect・relabel しない
- main DB への env fallback は既定禁止。subnet/port/provisioning failure 時は専用 DB fallback または durable
  cleanup requestへ倒し、`localhost:5432` 等へ勝手に切り替えない
- 共有 DB 例外は human approval、期限、server fingerprint、専用 database/schema/role、access mode、revoke
  path を持つ `shared_main_db_exception` lease に限定する。既定 read-only。main database/public schema と同一、
  migration/drop/truncate を隔離できない例外は拒否し、物理 server cleanup 対象にしない

### 56.4 Cleanup eligibility・journal・control

- 自動解放は member ごとに次をすべて要求する。unknown は false とする:
  `managed AND ephemeral AND provenanceVerified AND unused AND
  (ownerTerminal OR leaseExpired OR partialProvisionFailed) AND lease/request/object fencing exact match`
- さらに kind allowlist、enforce mode、`resource-cleanup.disabled` 不在、cleanup budget/backoff 到来を要求する。
  explicit early release と policy=`orchestrator` は active primary の fenced approval、volume/legacy/data-bearing は
  human path を要求する
- side effect は exact engine object ID にのみ発行し、直前に fresh DB Tx + fresh Docker inspect + kill-switch を
  再確認する。container → network の順とし、port member は owner container remove の確認後に released 化する。
  任意 listener の kill や volume delete command は生成しない
- external effect 前に `runtime_cleanup_attempts` へ unique execution nonce、executor ID/generation、expected fence/
  member hash を intent-before-effect で記録する。effect 後/commit 前 crash は same intent + exact ID not-found を
  根拠に冪等回復する。同名で再作成された別 ID は削除しない
- cleanup は 1 tick の request/container/network/wall-clock budget、指数 backoff、最大試行数を持つ。
  in-use/Docker 不達/timeout は retry、label/ID/fence mismatch・unknown・最大試行超過は quarantine とする
- config `runtimeResources` 欠如時は `mode=observe` / `provisioningEnabled=false`。独立 kill-switch は
  `$HACHI_KANBAN_HOME/resource-reconcile.disabled` と `resource-cleanup.disabled`。`supervisor.disabled` は両方を包含する
- migration/backfill は Docker socketへ接続せず、外部 object を create/stop/remove/relabel しない。既存 object は
  required labels が無い限り `managed=0 / ephemeral=0 / cleanupPolicy=never / quarantined` として観測するだけにする
- auto cleanup rollout は watermark 以降に本システム自身が作成した provenance v1 container/network だけを対象にする。
  現在の32 network・接続0の20候補、3190/8977/5432 listenerは削除・停止・adoptしない

### 56.5 cleanup routing・session 交代・通知

- cleanup request と対象 identity ごとの delivery は同一 Tx で作る。watch/binding 解決規則は §55 を共有するが、
  worker question の table/state/outbox は流用しない。cleanup 専用 durable request/delivery/outbox を使う
- auto class は host executor、orchestrator class は primary→collaborator→fallback、human class は明示 human approval
  とする。delivery だけで対応中とせず、claim 成功を acknowledge とする
- orchestrator mutation は `(orchestratorId, sessionId, generation, claimToken, claimLease, expectedLeaseFence)` を
  Store CAS で同時検証する。planned handoff は未実行 claim を新 generationへ移管できる。stale takeover は旧 claim/
  approval を queued に戻し、旧 generation mutation を拒否する
- host が `executing` へ消費済みの request は session handoff で巻き戻さず、executor lease・単調 execution generation・
  execution nonce で回復する
- 通知 dedupe key は `(cleanupRequestId, expectedFence, kind, transport)`。通常 auto 成功は通知せず、判断待ち、
  quarantine/provenance mismatch、retry exhaustion、budget長期飽和、shared DB grant/expiry、inventory summary を通知する

### 56.6 supervisor・CLI・Web・doctor・検証

- stage 順は `scheduler → resource-reconcile → dispatch → monitor → finalize → review → orchestrator-routing →
  messages → reap → resource-cleanup → notify → webwatch → telegram-in → steward → brief`。`reap` は run/process
  hygiene に限定し、Docker runtime cleanup を実装しない
- CLI は read/status/request と fenced cleanup claim/approve/reject/release を提供する。raw apply/delete/prune/adopt
  command は公開しない。dry-run/observe を既定とする
- Web は lease/member/expiry/controller/fence/eligibility evidence と cleanup request を表示する。human approval は
  write token・same-origin・確認 dialog・request ID + expected fence 再照合を必須にし、generic Docker delete API を作らない
- doctor は config/kill-switch、Docker context/address pool、lease heartbeat/expiry、task/run矛盾、object ID/label drift、
  orphan managed label、legacy quarantine、stale claim/generation、budget、unexpected wildcard bind、未承認 main DB接続を
  read-only 検査する。`--offline` は外形 probeだけをskipし、修復・削除はしない
- unit/integration test は Docker/network/process/clock を DI fake で検証する。migration、並行 CAS、旧 generation、
  port race、provenance、usage、cleanup crash window、kill-switch直前、legacy32/20削除0、3190/8977/5432非干渉、
  main DB拒否、secret redaction を必須ケースとする
- live rollout の auto cleanup enable gate は observe期間中 false-positive 0、legacy delete plan 0、volume delete plan 0、
  main DB target 0 とする

## 57. Durable run cancel・exact-session stop・replacement gate（v0.13）

目的: cooperative steer の配送受理と cancel 完了を分離し、task/run/session 単位の cancel intent を永続化する。
他 session を巻き込む bridge/process 全体停止は行わず、停止証拠が確認できるまで run slot・worktree・runtime
resource と replacement/rework/restart を解放しない。

### 57.1 永続モデル・authority（migration v14）

- `run_cancel_requests` を追加する。owner は immutable な `(taskId, runId, sessionId, provider)`、mutation authority は
  `requestNonce`、正の単調 `cancelFence`、requester の stable `orchestratorId` と active `sessionId/generation` である。
- status は `cancel_requested | cooperative_sent | acknowledged | forcing | stopped | failed | expired`。
  許可遷移は次だけとし、同一状態・飛び越し・逆行は拒否する:
  `cancel_requested→cooperative_sent|forcing|stopped|failed|expired`、
  `cooperative_sent→acknowledged|forcing|stopped|failed|expired`、
  `acknowledged→forcing|stopped|failed|expired`、`forcing→stopped|failed|expired`。終端からの遷移はない。
- create は対象 task の最新 open run と run/session/provider の完全一致を要求する。orchestrator 起点は §55 の active
  session/generation と primary binding/watch を検証し、旧 generation を拒否する。host supervisor 起点は actor と
  current open run を検証する。request nonce の再送は同一 row を返し、異なる入力との衝突は拒否する。
- 同一 run の非終端 request は1件だけ。再試行は前 request が failed/expired の場合だけ、より大きい cancelFence と新 nonce
  で作れる。ただし run が open の間は replacement gate を解除しない。
- cancel request 作成以降、その run の worker/reviewer result・handoff・verify/review mutation は late として拒否する。
  stopped/failed/expired を含め、run close のための cancel engine mutation 以外は cancel fence を越えられない。
- 全遷移は task_events に `cancel_requested / cancel_injected / cancel_acknowledged / cancel_force_started /
  cancel_stopped / cancel_failed / cancel_expired / late_result_rejected` を同一 Tx で記録する。reason/evidence は redaction し、
  token・bridge credential・process環境・transcript本文を保存しない。

```sql
CREATE TABLE IF NOT EXISTS run_cancel_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id INTEGER NOT NULL REFERENCES task_runs(id),
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  status TEXT NOT NULL CHECK(status IN (
    'cancel_requested', 'cooperative_sent', 'acknowledged', 'forcing',
    'stopped', 'failed', 'expired'
  )),
  request_nonce TEXT NOT NULL UNIQUE CHECK(length(request_nonce) > 0),
  actor TEXT NOT NULL CHECK(length(actor) > 0),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  orchestrator_id TEXT REFERENCES orchestrators(id),
  requester_session_id TEXT NOT NULL DEFAULT '',
  requester_generation INTEGER,
  cancel_fence INTEGER NOT NULL CHECK(cancel_fence > 0),
  deadline_at INTEGER NOT NULL,
  acknowledged_nonce TEXT NOT NULL DEFAULT '',
  capability_snapshot TEXT NOT NULL DEFAULT '{}',
  stop_evidence TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_cancel_active
  ON run_cancel_requests(run_id)
  WHERE status IN ('cancel_requested', 'cooperative_sent', 'acknowledged', 'forcing');
CREATE INDEX IF NOT EXISTS idx_run_cancel_task_status
  ON run_cancel_requests(task_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_run_cancel_due
  ON run_cancel_requests(status, deadline_at, updated_at, id);
```

### 57.2 Cooperative cancel・ack

- cancel engine は高優先 `cancel.v1` envelope を exact run/session へ一度だけ inject する。payload は request ID/nonce、
  task/run/session、deadline、`新規tool・sub-agent・side effect開始禁止`、現在の副作用停止、ack と cancel handoff要求を含む。
- transport accepted / `message_processed` は `cooperative_sent` までであり ack ではない。`acknowledged` は worker が返す
  request nonce と run/session/cancelFence が一致した構造化 ack だけを受理する。確認不能は unknown のまま進めない。
- cancel 開始後は通常 steer を注入しない。queued steer は §58 の lifecycle で stale-cancel/supersede し、replacement runへ
  引き継がない。cancel envelope 自体は通常 steer の sequence に混ぜず、常に優先する。

### 57.3 exact-session stop capability

- adapter は `direct-stop-v1 | session-stop-v1 | unsupported` と `exactSession`、`childProcessTree` を広告する。
  未広告・probe失敗・未知protocolは unsupported。capability snapshot は force直前に保存する。
- direct は既存 process ownershipに基づく stop を `direct-stop-v1` として扱う。bridge は `session-stop-v1` を広告し、
  exact session ID と request nonce/run ID を照合できる場合だけ `stopExact` を呼べる。
- stop結果は `stopped | already-stopped | unsupported | rejected | unknown` と、非秘匿 evidence ID、観測session state、
  child process tree包含有無を返す。`stopped/already-stopped` でも adapter.status の idle/ended と同一 session IDを再確認する。
- capability無し/unknown/rejected は bridge全体restart、wildcard PID/process group killへfallbackしない。requestを
  failed/expiredとして記録しても replacement gateを維持し、担当orchestratorへdurable escalationする。
- ただしhostがこのstate machine外で既にbridge process generation全体を停止し、同一serverUrlの他open runが0件だった
  事後回復は、§57.5のfenced host attestationとして別扱いにする。これはforce失敗からrestartを起動するfallbackではなく、
  停止副作用を一切持たない証拠反映経路である。

### 57.4 Supervisor・replacement/resource gate

- cancel engine は `cancel_requested→cooperative_sent→acknowledged` を grace 内で進め、deadline 後は capability がある場合だけ
  `forcing` へ進む。1 tick の cancel数/force数/wall-clock budget、backoff、`cancel.disabled` kill-switchを持つ。
- stall/no-progress は直接run releaseせず cancel requestを作る。max-runtime、session自然終了、handoff競合、二重cancel、
  orchestrator takeoverを同じstate machineへ通す。
- stop/idle/endedのexact-session証拠を再確認するまで、runをreleased/failedへcloseせず、taskをreadyへ戻さず、同一task/
  worktreeのdispatch・rework・review/restart・replacementとruntime resource解放を拒否する。
- stop確認後だけ cancel engine が run close、taskの安全側遷移、resource guard解放を同一fenceの順序で行う。
  crash windowはintent-before-effectとidempotent再照合で回復し、late resultはtask mutation 0で監査eventだけ記録する。

### 57.5 CLI・Web・通知・検証

- CLIは `hachi task cancel <id> --reason <text> [--expect-run <runId>] [--expect-session <workerSessionId>]
  [--grace <sec>] [--force-if-supported]` と read-only statusを提供する。
  既定はcooperative、force指定も capability が無ければ pending/fail-closed。request/session/generation/fenceを表示するが
  credentialやtokenを出さない。
- **`--expect-run` / `--expect-session` は fenced cancel（§50.2）である。** 少なくとも一方を指定すると
  `Store.createOrGetFencedRunCancelRequest` が**同一 transaction 内で** current open run と照合し、
  不一致・open run 不在なら **request / event / steer の mutation を一切行わず**
  `targetMatched: "no"` を返して exit 1 で終わる。
  **停滞警告（`run_stalled` / `run_stall_suspected`）からの cancel では必ずどちらかを付ける** —
  expected を省いた素の cancel は `getLatestOpenRun()` を対象にするため、
  警告対象の run が既に置換されていると **replacement を誤って止める**。
  **ただし fenced であることは停止の保証ではない**（正しい run へ request を作るところまで。
  停止の確証は本節と §57.4 の exact-session 証拠が正本）。
- exact-session stop未対応bridgeを、他のopen bridge runが0件の状態でhostがprocess generationごと停止した例外時だけ、
  `hachi task cancel-host-stop <id> --request <cancelId> --evidence-id <id> --process-generation <id>` を使える。
  既定はdry-runで、active orchestrator principal、blocked in-progress、current active cancel/open run/session/provider/fence、
  run metaのbridge serverUrl、同一serverUrlの他open run 0件を確認する。`--confirm`時も同じ条件をTx内で再検証し、
  cancel=`stopped`、run=`failed`、task=`needs-manual: cancel stopped`を構造化`host-process-generation`証拠とprovenance付きで
  原子的に記録する。このCLI自体はprocessを停止せず、generic bridge restartや通常forceのfallbackには使わない。
  既存の`cancel-failure:<cancelId>` orchestrator requestを暗黙resolveせず、専用principal/CAS APIが無い限り別の回収対象として残す。
- task show/logs/await/Web は requested/sent/acknowledged/forcing/stopped と exact-session証拠を区別する。
  delivered/processedをapplied/acknowledgedと表示しない。Webからgeneric process kill/bridge restart APIを作らない。
- TelegramはFYI。判断が必要な cancel failure は担当identityのorchestrator inboxへ送り、解決不能時だけhumanへescalateする。
- unit/E2Eは capability無しでreplacement 0、capability有りで対象sessionだけ停止・別session継続、cooperative無視、
  ack nonce不一致、二重cancel、session自然終了、late handoff/result、旧generation/takeover、child process tree、direct非回帰、
  host process-generation recoveryのdry-run/active principal/同一bridge他run拒否/CAS/二重実行、kill-switch/budget、
  通知/await重複0を必須ケースとする。

## 58. Durable steer lifecycle・supersession（v0.14）

目的: busy turn 中の steer について、Supervisor/bridge の配送受理と worker の観測・acknowledge を分離し、
handoff/run close後に未観測の古い steer が再生されることを防ぐ。

### 58.1 lifecycle・順序

- status は `queued | dispatching | transport_accepted | session_observed | acknowledged | uncertain |
  superseded | stale_cancelled | failed`。
  `message_processed` と bridge inject 成功は `transport_accepted` まで。構造化された message ID/run/session/cancel fence の
  worker応答だけを `session_observed/acknowledged` とする。確認不能は unknown と表示し、適用済みを推測しない。
- 同一 run/session の通常 steer は正の単調 `sequence` を持つ。後発 steer は明示 `supersedesId` で、まだbridgeへ渡していない
  `queued`の旧steerだけをsupersededにできる。`dispatching`以降は取消API/ackなしに取消済みと記録せず、訂正指示を
  新sequenceで配送しつつ旧deliveryをunknownのまま残す。
- §57 cancel request作成後は通常steerを新規配送しない。cancel fenceより古い`queued` steer、handoff確定・run close・
  session終了時の未配送steerはstale_cancelledにし、replacement runへ再配送しない。`dispatching`/`transport_accepted`/
  `uncertain`はDBだけで取消済みとせず、C4のexact-session stop成功とsession静穏確認までreplacement gateを閉じる。
- migration v15 は `steer_deliveries` をadditiveに追加する。agent.message.v1 comment/idempotency key は入力監査として残し、
  steer lifecycleの正本はこのtableとする。

```sql
CREATE TABLE IF NOT EXISTS steer_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id INTEGER NOT NULL REFERENCES task_runs(id),
  session_id TEXT NOT NULL,
  message_key TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'dispatching', 'transport_accepted', 'session_observed', 'acknowledged',
    'uncertain', 'superseded', 'stale_cancelled', 'failed'
  )),
  supersedes_id TEXT REFERENCES steer_deliveries(id),
  expected_cancel_fence INTEGER NOT NULL DEFAULT 0 CHECK(expected_cancel_fence >= 0),
  observed_message_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  observed_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  UNIQUE(run_id, session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_steer_delivery_pending
  ON steer_deliveries(status, run_id, sequence, id);
CREATE INDEX IF NOT EXISTS idx_steer_delivery_task
  ON steer_deliveries(task_id, run_id, sequence, id);
```

### 58.2 CLI・bridge境界・検証

- `hachi task steer --wait` は `queued/transport-accepted/session-observed/acknowledged/superseded/stale-cancelled/unknown`
  を区別して返す。transport acceptedだけで成功終了した場合はobserved/appliedをfalseまたはunknownと明示する。
- bridgeがobserved/ack protocolを広告しない場合、Supervisorはtransport_acceptedより先へ進めない。別APIやtranscript本文から
  推測しない。外部bridge変更が必要なら所有repositoryを特定した独立タスクにし、旧システムへ暗黙実装しない。
- inject前に`queued→dispatching`をCASし、外部I/O中のcancel/supersedeと区別する。inject成功後はrun/cancel状態が
  変わっていても実配送の事実を`transport_accepted`として保存する。inject結果が曖昧な失敗は`uncertain`とし、
  `failed/stale_cancelled`へ縮退させない。遅延observation/ackは旧run close後でもexactなdelivery/run/session/fence一致を
  検証して履歴へ反映し、1件の矛盾で同batchの後続ack処理を止めない。
- E2Eはbusy中のA→訂正Bで未配送`queued` Aだけsuperseded、handoff前後の未配送`queued` steer stale-cancel、
  `dispatching`/accepted/uncertainは取消済みにしないこと、bridge受理後session終了、
  replacement誤配送0、task/run/session/fence不一致拒否、cancel優先を必須ケースとする。

## 59. model × transport 起動前互換性（v0.14）

目的: provider/profile/override から解決した model と transport が、実際に起動を担当する runtime で利用可能かを
worker run 作成前に判定する。新モデル追加直後に古い bridge 内蔵 CLI が 0-token で即死し、同じ組合せを反復起動する
事故を防ぐ。静的なモデル名推測や「HTTP応答がある」だけを互換性の証拠にしない。

### 59.1 runtime capability snapshot

- adapter probe は `execution-capability.v1` の snapshot を返す。必須フィールドは `provider`、`transport`、
  runtime の安定 `name` / `version` / `source`、versioned capability token、model catalog、model/effort/speed delivery、
  `observedAt` とする
- bridge は認証済み identity/capability endpoint の広告を使う。direct は対象 executable のローカル read-only probeを使う。
  runtime versionを取得できない、異形version、provider/transport不一致は unknown または unsupportedへ倒し、補完推測しない
- model catalogは `{knowledge:"known", models:[...], source:"advertised"}` または
  `{knowledge:"unknown", detail}`。広告面が無いことを既知の空catalogと同一視しない。空配列が明示広告された場合だけ
  known emptyとする
- capability tokenは重複を除去して辞書順へ正規化する。未知tokenは保持するが、それだけで対応を昇格しない。
  token、runtime名、version、model IDは安全な文字集合・件数・長さ上限を検証し、異形bodyはsnapshotを捏造せずprobe failureにする
- secret、Bearer token、token file path、home path、raw response本文はsnapshot・event・Webへ保存しない

### 59.2 trusted requirement と判定

- 判定入力は、解決済み `(provider, model, transport, effort, speed/source)`、runtime snapshot、trusted
  `ModelTransportRequirement`。requirementは設定/契約で管理し、runtime応答から自己申告させない
- requirementは provider/model/transport、requested effort/speed、required capability token、native
  model/effort/speed delivery要否、必要なら`policyId`と`minimumRuntimeVersion`を持つ
- trusted version policyはconfigの`modelTransportPolicies[]`で管理し、`id`、`provider`、`model`、`transport`、
  `minimumRuntimeVersion`を必須とし、`supportedEfforts`/`supportedSpeeds`で明示対応を追加できる。
  同じprovider/model/transportまたはpolicy IDの重複、allowlist外model、
  異形semverはconfig読込時に拒否する。allowlist自体をruntime対応の証拠へ昇格させない
- repo既定configはこのhostで実動確認したdirect runtimeを保守的な下限として、Codex各allowlist modelへ
  `0.144.1`、Claude各allowlist modelへ`2.1.207`を設定する。明示configを使う環境は同等のtrusted policyを
  保持しなければcatalog非広告direct経路がunknownでblockされる
- 判定は `supported | unsupported | unknown` の閉じたunion:
  - explicit model catalogに対象modelがある場合は `supported/evidence=advertised-model`
  - catalogがunknownでも、trusted minimum-version policyと有効runtime versionがあり閾値以上なら
    `supported/evidence=runtime-version-policy`
  - known catalogにmodelが無い、runtime version不足、provider/transport不一致、requested effort/speed非対応、
    required capability/native delivery不足は
    reason付き `unsupported`
  - catalog、version policy、runtime versionの証拠が揃わない場合は `unknown`。supported/unsupportedへ丸めない
- explicit catalogとversion policyが矛盾する場合はexplicit catalogを優先する。known catalogにmodelが無ければ、versionが
  新しくてもunsupported。必要capability/native delivery不足もmodel supportより優先してunsupported

### 59.3 package境界・互換性

- `admin resolve`の`resolution.transport`は設定解決値、`compatibility.expectation.transport`は読取時の
  互換性probe対象であり、dispatch時の採択や起動済みtransportを証明しない。既存fieldは維持し、
  単roleはトップレベル、`--role all`は各roleへadditiveな`transportContext`を返す。
  `policyTransport`/`probeTransport`は該当結果が無い場合null、`isLaunchEvidence`は常にfalse、
  `actualTransportSource`は`run-meta-or-launched-event`。text/helpもこの区別を示す。
  実行中の停止・steer判断は対象runのmetaまたはlaunched eventを確認する。
  direct-sessionファイル不在だけではbridgeと断定しない。

- Coreはsnapshot/requirement/decisionの凍結型とpure evaluatorを持つ。adapterはprobeと入力検証だけを担当し、
  dispatch状態遷移やretry判断を行わない
- 既存 `/api/info?provider=codex` の `capabilities.codex: string[]` は後方互換で受理するが、runtime/model catalogが
  無いlegacy応答はそれらをunknownとする。既存passthrough判定（§49.4）を広告以上に昇格させない
- direct/bridge、Codex/Claudeで同じsnapshot/decision語彙を使う。provider固有responseはadapter内で正規化し、
  supervisor/CLI/Webへraw bodyを漏らさない
- M1は型・pure evaluator・adapter probe・fake fixtureまで。worker claim前のblock/circuit breakerはM2、doctor/resolve/WebはM3。
  M1だけでdispatch挙動を変えない

### 59.4 必須テスト

- explicit model supported/unsupported、known empty、catalog unknown、runtime version境界、invalid semver、capability/native delivery不足
- legacy capability array、異形/過大body、auth/network/timeout、provider/transport不一致、unknown token、secret redaction
- direct/bridgeとCodex/Claudeの同一decision、既存§49.4 passthroughおよび通常dispatchの非回帰

### 59.5 doctor の使用中 transport 診断

- full `hachi doctor` は config の全 profile から使用中 `(provider, transport)` を導出する。profile の
  transport 省略は execution と同じく `bridge` と解決する
- bridge identity probe は使用中 provider×bridge だけに行う。profile が1件も bridge を使わない provider は
  `{ok:true, skipped:true, reason:"unused-transport"}` とし、外部bridge不在をportable direct構成の異常にしない
- 使用中bridgeのtoken pathが存在する場合は、外形probeより前に§12.13のowner/mode/regular file/symlink/size検査を
  行い、`--offline`でも不一致をNGにする。token valueは結果・ログへ出さない。path欠如をoffline readiness成功へ読み替えない
- model×transport compatibility は従来どおり全 profile を解決済み transport でprobeし、未使用bridge skipを
  direct runtime readinessへ読み替えない
- `--offline` で省略する外形監視/runtime probeは
  `{ok:true, skipped:true, reason:"offline"}` とし、detailにもreadinessの証明ではないことを明記する。
  offline全体の`ok=true`をworker起動可能の証拠に使わない
- JSON fieldはadditiveとし、既存`name/ok/detail`、失敗時exit code、full doctorのfail-closed判定を維持する。
  testはdirect-only、mixed、offlineのprobe回数と構造化skipを含む

## 60. 構造化 actor provenance（v0.15）

目的: `task_events.actor` / `task_comments.author` の表示文字列と、監査判断に使う操作主体を分離する。
表示名が `human` や `orchestrator` であることだけを根拠に主体を推測せず、stable orchestrator identity の
active session generation を Store transaction 内で照合できた操作だけを orchestrator 起点として記録する。

### 60.1 永続列と後方互換

- migration version 16 で `task_events` と `task_comments` の双方へ次の列を additive に追加する:
  `actor_kind TEXT NOT NULL DEFAULT 'unknown'`、`actor_id TEXT NOT NULL DEFAULT ''`、
  `actor_session_id TEXT NOT NULL DEFAULT ''`、`actor_generation INTEGER`。
- `actor_kind` は `human | orchestrator | service | unknown` の閉じた union。`actor_generation` は
  `NULL` または正の整数だけを許可する。Core は各 kind の組合せ不変条件も書込み前に検証する。
- migration 前の行は `unknown / '' / '' / NULL` とする。既存 `actor` / `author` は表示・後方互換用として
  一切書き換えず、文字列から provenance を backfill しない。
- ReadView / Store の `EventRow` / `CommentRow` は構造化 provenance を常に返す。legacy DB を開いた
  Store は migration 後の既定値を返し、読み手が表示文字列から補完してはならない。

### 60.2 provenance の不変条件

- `unknown`: `actorId=''`、`actorSessionId=''`、`actorGeneration=null`。provenance 未指定の既存 API と
  旧 CLI (`--author` だけを含む) は必ずこの値を使う。
- `human`: session と generation は空/null。v0.15 は OS user / IdP 認証を範囲外とするため、
  `actorId` は明示された表示ラベルを監査上の local claim として保存できるが、認証済み human identity とは扱わない。
- `orchestrator`: `actorId`、`actorSessionId`、正の `actorGeneration` をすべて必須とする。Store は
  `orchestrator_sessions.id / orchestrator_id / generation / status='active'` の完全一致を、対象 event/comment と
  同じ transaction 内で再照合する。不一致、旧 generation、別 identity、stale/closed/superseded は mutation 0 で拒否する。
- `service`: 非空 `actorId` を必須、session と generation は空/null。Core の内部呼出し面だけが生成でき、CLI parser・help・
  option union へ公開しない。service 名は固定された安全な識別子であり、表示文字列から推測しない。
- event/comment 本体と4列は単一 INSERT で原子的に保存する。後追い event、別 transaction、表示文字列の再解釈で補完しない。

### 60.3 Core API と mutation 伝搬

- 凍結型は `ActorKind`、`ActorProvenance` と、`EventRow` / `CommentRow` の `provenance` read field を持つ。
  DB列との対応は `kind / actorId / actorSessionId / actorGeneration` とする。
- 既存の表示 actor/author 引数を壊さない。provenance-aware mutation 面を additive に追加し、provenance を
  渡さない既存呼出しは `unknown` へ正規化する。
- `task create/move/comment/attach/block/unblock/watch/unwatch/edit-body/set-cwd` と admin の task mutation は、呼出し時の
  provenance を、同一 transaction で生成する全 task event/comment へ伝搬する。CAS が失敗した場合は provenance 行も作らない。
- `task create`で同時指定されたmodel/effort override eventもtask_createdと同じprincipalを使う。`task attach`は
  optional commentだけでなく、保存名・size に加えて添付時点の current open run の `runId` / `sessionId`（無ければ null）を持つ
  `artifact_attached`監査eventを必ず同じprincipalで残す（§32.5。2026-09-03 改訂。旧 event は name/sizeBytes のみ）。
  file copy失敗時はcomment/eventを0にし、監査INSERT失敗時は新規artifactをcleanupして部分成功を残さない。
- 内部 service が provenance-aware API を利用した場合だけ `service` を記録する。既存 supervisor 呼出しを
  actor文字列から一括 service 化しない。

### 60.3.1 knowledge provenance（migration v17）

- migration version 17で`knowledge`へ§60.1と同じ4列をadditiveに追加し、`KnowledgeRow.provenance`として公開する。
  既存rowはunknown、表示`actor`は書き換えず、文字列からbackfillしない。
- `hachi knowledge add`は共通principal flagsを受け、Storeはorchestratorのactive exact session/generationを
  knowledge INSERTと同じtransactionで検証する。重複content hashのno-opは既存rowをそのまま返し、title/actor/provenanceを
  後着callerで上書きしない。
- bulk ingestは外部document由来のため、明示principalを全新規rowへ一貫適用するかlegacy unknownのままにする。
  file名・front matter・source文字列からhuman/orchestratorへ昇格しない。

### 60.4 CLI principal flags

- 対象 mutation に共通 `--actor-kind <human|orchestrator>` を追加する。`service`、`unknown` は明示選択肢にしない。
  flag 無指定は後方互換で `unknown`。
- 既存 `--author` は表示ラベルだけを指定する。`--author` 単独利用は `unknown` のままであり、`human` / `orchestrator`
  へ昇格しない。
- `--actor-kind human` は orchestrator/session/generation flags を拒否する。provenance `actorId` には明示表示ラベルを保存し、
  session/generation は空/nullとする。
- `--actor-kind orchestrator` は `--orchestrator <identityId>`、`--session <sessionId>`、`--generation <positive int>`
  をすべて必須とする。欠落・矛盾・未知 kind・非正 generation は Store 呼出し前に fail-closed で拒否し、
  Store でも active session generation を再検証する。
- CLI help/test は上記選択肢と拒否条件を固定する。CLI parser の成功を監査 authority とせず、Store transaction の照合結果を正本とする。

### 60.5 必須テスト

- migration v16 の既存行既定値・冪等性・列制約、EventRow/CommentRow mapping。
- provenance 未指定、legacy、`--author` only が unknown のままであること。
- explicit human、active orchestrator、旧 generation、別 identity session、stale/closed/superseded と mutation 0。
- service が内部 API からだけ記録でき、CLI の option/help から指定不能であること。
- event/comment と provenance の原子性、CAS failure時の残骸0、主要 task/admin mutationへの伝搬、既存CLI互換。
- task createのtask/override全event、attachのcomment/event/file rollback、knowledge migration v17・duplicate no-op・
  Store active-generation再照合、CLI JSON/text/read viewの同一provenance。

## 61. orchestrator await の session 生存維持（v0.15）

目的: generation-fenced `hachi orchestrator await` が inbox を blocking 待機している間も、担当
orchestrator session を stale 判定から保護する。thread heartbeat automation や人間のCLI操作頻度を
session生存の根拠にせず、待機コマンド自身が生存契約を維持する。

### 61.1 TTL・heartbeat policy

- orchestrator session の stale TTL は90秒、`orchestrator await` の heartbeat 間隔は30秒とする。
  Coreの単一policy定数をCLI、Store、Supervisor、doctorが共有し、独立した数値を持たない。
- TTLとheartbeat間隔は正の整数かつ `heartbeat interval < stale TTL` を必須とする。不正な組合せは
  起動時にfail-closedで拒否し、安全値への暗黙補正は行わない。
- `orchestrator await --interval` は inbox poll 周期でありheartbeat周期ではない。長いpoll、cleanup inbox、
  `--max-wait` の有無に関係なく、heartbeatは独立timerで継続する。

### 61.2 generation fence・終了契約

- await開始時に `sessionId / generation` 完全一致のheartbeatを即時実行し、その後30秒ごとに同じ
  generation-fenced Store mutationを行う。旧generation、stale/closed/superseded sessionを復活させない。
- heartbeatが `SESSION_SUPERSEDED` またはその他のStore errorで失敗した場合、timerと現在のpoll待機を停止し、
  errorを呼出元へ伝播する。automationや別sessionへ暗黙fallbackしない。
- request/cleanup claim成功、`--max-wait`、通常error、SIGINT/SIGTERMのすべてでheartbeat/poll timerとsignal
  listenerを確実に破棄する。signal時は同期cleanup後に同じsignalを再送し、通常のprocess終了semanticsを保つ。
- planned handoff / stale takeover後は新session/generationでawaitを再アームする。旧awaitはfence拒否で終了する。

### 61.3 複数awaitとclaim競合

- 同一session/generationの複数awaitによるheartbeat更新は冪等に共存できる。
- 同じrequestまたはruntime cleanup requestを同時観測した場合、Storeが明示する既知のclaim CAS競合だけは
  敗者が再pollする。権限不一致、observer/collaborator gate、`SESSION_SUPERSEDED`、未知errorを競合として
  握り潰してはならない。
- claim勝者は通常returnして自身のtimerを破棄し、敗者は次のrequestまたはtimeoutまでheartbeatを維持する。
  cleanup claim token fileはCAS失敗時に削除し、残骸や別claimのtokenを残さない。

### 61.4 必須テスト

- 90秒TTLを実際に跨ぐ98秒以上の待機で30/60/90秒heartbeatが継続し、sessionがactiveであること。
- inbox着信、cleanup着信、max-wait、heartbeat失敗、handoff/takeover、SIGINT/SIGTERMでtimer/listenerが残らないこと。
- 同一session/generationの実CLI awaitを複数並行し、request/cleanup claim競合の敗者だけが再pollして生存し、
  勝者・敗者の終了後はいずれもheartbeatが増えないこと。
- TTL境界、policy不正値、長いpoll周期、未知claim errorの伝播、既存inbox/cleanup claimの非回帰。

## 62. done origin・gate自動完走率の read model（v0.15）

目的: done到達を `gate_passed | orchestrator_host_finalize | human_decision | unknown` に再現可能に分類し、
自動gate完走率・manual recovery率・unknown率をCLI/Webで読み取り専用表示する。表示用actor文字列を主体の
根拠にせず、確定event payloadと§60の構造化provenanceだけを使う。

### 62.1 done signal と fail-closed分類

- eventは `irrelevant | valid-done | invalid-done-signal` に分類する。JSON objectの `payload.to='done'` は
  done signalであり、`from`欠落・空値・異形payloadは invalid とする。
- `finalized`、`verdict_finalized`、`telegram_approve` はterminal候補eventである。壊れたJSON、`to/from`欠落、
  必須の固有証拠欠落を含む場合は invalid-done-signal として扱い、単に候補から捨ててはならない。
  完全な既知non-done形（`finalized` の `blocked→review/outcome=review`、`telegram_approve` の
  `blocked→ready/kind=steward-promote/source=telegram/nonceあり`）は irrelevant とする。それ以外の
  terminal候補non-done異形を楽観的に捨てない。terminal候補でない壊れたJSONや通常のnon-done eventは irrelevant とする。
- 1タスクの全event履歴に invalid-done-signal が1件でもある、または valid-done が0件/複数件なら
  originはunknown。完全なeventだけを選んで楽観分類しない。
- `gate_passed` は次の完全な確定eventだけ:
  - `finalized`: `from=blocked`、`to=done`、`outcome=done`、非空exact `sessionId`
  - `verdict_finalized`: `from=review`、`to=done`、`verdict=pass`、`confidence=high`、非空review `sessionId`
- `human_decision` は完全な `telegram_approve`（`from=blocked`、`to=done`、`kind=user-decision`、
  `source=telegram`、非空nonce）またはvalid-done eventのprovenance `kind=human`。
- `orchestrator_host_finalize` は上記gate/humanに該当せず、valid-done eventのprovenanceが
  `kind=orchestrator` の場合だけ。`actor` / `author` 文字列、旧行、unknown/service provenanceから推測しない。

### 62.2 集計期間・分母

- current board statsは現在doneの各taskについて全event履歴からoriginを1件導出する。
- 期間Metricsの分母は、inclusiveな `[fromTs, toTs]` 内にdone signalを1件以上持つtask IDの集合とする。
  origin分類には各taskの期間外を含む全event履歴を渡す。期間外doneとの重複を隠して既知originへ昇格しない。
- taskごとのoriginを `total`、各origin件数へ集約する。`automaticCompletionRate = gatePassed / total`、
  `manualRecoveryRate = (orchestratorHostFinalize + humanDecision) / total`、`unknownRate = unknown / total`。
  分母0の率は0。率の合計と件数の合計は同じ分母へ一致する。

### 62.3 表示・境界

- Coreはpureな導出・集計とReadView/Metrics read modelを持つ。schemaや過去eventを書き換えない。
- CLI `board`、`/api/board`、Web Metricsは同じ語彙・件数・率を返す。既存fieldを破壊せずadditiveに追加する。
- Webは読み取り専用で、unknownを非表示や既知originへ丸めない。402px/1440px、light/dark、console error 0を確認する。

### 62.4 必須テスト

- direct/review gate、構造化human/orchestrator、完全Telegram、legacy/unknown/service。
- 完全+不完全done、完全+壊れたterminal、複数valid done、terminalでない壊れJSON、from/to欠落。
- 期間外+期間内重複、期間境界ぴったり、複数期間内done、分母0、件数/率整合。
- current board・期間Metrics・CLI JSON/text・Web API/UIの同一集計、actor文字列非依存、既存board/metrics非回帰。

## 63. fan-out integration gate（F3、v0.15）

目的: §49.2の承認済みfan-out planについて、全childのboard/Git/verify証拠が統合可能な状態に揃った場合だけ、
host/orchestratorへff-only統合要求を返す。F3はread-only decision面であり、自動merge、conflict解消、branch更新、
task遷移を行わない。

### 63.1 CLI・authority fence

- CLIは `hachi fanout integration-check --parent <taskId> --file <plan.json>
  --approved-plan-hash <sha256> --orchestrator <id> --session <id> --generation <n>
  [--main-ref refs/heads/main] [--json]`。
- F1 canonical JSON/hash、plan payload、明示approved hash、F2の単一`fanout_plan_applied` authority eventの
  parent/plan hash/orchestrator/child key↔task ID対応をすべて完全一致させる。欠落・重複・driftは拒否する。
- callerはplan repositoryを所有するstable orchestrator identity、active exact session/generation、親taskの
  単一primary bindingと一致しなければならない。旧generation、別identity、observer/collaboratorの横取りを拒否する。

### 63.2 child board・verify gate

- `requiredChildren`、F2 authority、plan children、board evidence、Git evidenceは同じkey集合をexactly once持つ。
- 各childは承認済みtitle/body(cwd含む)/tenant/profileからdriftせず、単一primary ownershipがcaller identityと一致し、
  `status=done`、`completedAt`あり、open run 0でなければならない。
- 最新runは同taskの`done`かつ`endedAt`あり、task完了時刻はrun終了時刻以上。run metaの最新reviewer/verification
  `verify.status` は明示`passed`だけを許可し、missing/failed/skipped/異形を成功へ丸めない。
- late result、欠落child、旧runだけの証拠、実行中run、plan外taskの代用はmutation 0で拒否する。

### 63.3 Git・ownership gate

- `mainRef`は完全な`refs/heads/...`だけを許可する。repo common-dirはplanと実Gitのcanonical common-dirに一致し、
  child worktreeはGit登録済みのplan専用canonical path、同common-dir、非detached・相互に一意な専用branchであること。
- 各worktreeはtracked/untrackedを含めclean。hostはrepositoryのGit object formatをprobeし、main/child HEADは
  そのformatに一致する完全commit OID（`sha1`=40桁lowercase hex、`sha256`=64桁lowercase hex）でなければならない。
  plan hashのSHA-256とGit commit OIDを混同しない。固定したlatest main HEADを各child HEADの祖先に持つ。
  `main..childHEAD`の全変更pathはplan child ownership内で、未所有・scope外・異形pathを1件でも含めば拒否する。
- Git probeの前後でmain HEADが変化した場合はstale snapshotとして拒否する。共有branch、未登録worktree、dirty、
  detached、別common-dir、main未追従、ownership外変更をwarningへ落とさない。

### 63.4 decision・host finalize境界

- pass結果はversioned `fanout-integration-decision.v1` とし、`requestedAction=host-ff-only-integration`、
  parent/plan hash/orchestrator/session/generation/repo/main snapshot、各child task/run/branch/HEAD/worktree/changedPathsを持つ。
- decisionはread-only証拠snapshotであり、Git実行権限や将来状態の保証ではない。hostは各ff-only直前と全体検証前に
  session generation、main HEAD、child HEAD/clean/ownership/verifyを再検証し、変化があれば統合せず再checkする。
- 初期版は自動merge、non-ff、conflict解消、workerによるmain/worktree操作を行わない。pass/失敗ともboard/Git mutation 0。

### 63.5 必須テスト

- 正常3〜6 child、hash/authority/identity/session/generation不一致、required child欠落/重複、spec drift。
- not-done/open/late/latest run failed、verify missing/failed/skipped、別primary。
- dirty/untracked、未登録/共有/detached branch、別common-dir、main未追従/main race、ownership外path、異形path。
- pass時もboard/Git mutation 0、versioned snapshotの決定性、host直前再検証を要求する表示、既存F1/F2非回帰。

## 64. Steward done整合判定（O3、v0.15）

目的: `evidence_failed` / `verdict_missing` / `handoff_rejected` 等の後に独立検証・review・
host-finalizeを経た正当なdoneを、Stewardが直近eventの並びだけで矛盾扱いしないようにする。
done整合性はLLM推測ではなく、§62のdone signal分類と状態機械を使うpure決定表を正本とする。

### 64.1 pure決定表

- 対象は現在`status=done`のtask。判定には期間を切らず全event履歴を渡し、表示用`actor`文字列から
  主体や正当性を推測しない。
- §62の`valid-done`がexactly one、`invalid-done-signal`が0なら`consistent`。その前に
  `evidence_failed` / `handoff_evidence_failed` / `verdict_missing` / `handoff_rejected` / stale・late
  拒否eventがあっても、後続する確定doneを否定しない。
- `origin=unknown`は§62の正式な観測カテゴリである。exactly oneの完全なdone signalを持つlegacy/service
  provenanceを証拠欠落へ格上げせず、`consistent(origin=unknown)`のまま保持する。
- 状態機械上許可されない`from -> done`、valid signal 0件または複数件、invalid signal 1件以上は
  `escalate`。valid/invalid signalが0で旧run/fenceの拒否証拠だけが残る場合は
  `stale-fence-only`として区別する。不明・破損・重複をwarningへ丸めない。
- done以外は`not-applicable`。判定はread-onlyでtask/eventを修復・遷移しない。

### 64.2 Steward統合・重複抑制

- board snapshotは各done taskへdecision codeと§62 originを付ける。判断sessionには、done整合性を
  event順序から再推測せずpure決定表を正本にするよう明示する。
- `consistent`なdoneに対するLLMの`escalate`提案は破棄する。`escalate`判定のdoneは、同taskへのLLM提案を
  deterministicなexactly oneの`[done-consistency:<code>]` escalateへ置換し、同じpassでarchive等を適用しない。
- 通知・proposal eventは既存Stewardの冪等窓を通す。判定が同じままのtaskへ同一tickで重複通知せず、
  transport skipや通知失敗を成功扱いしない。

### 64.3 必須テスト

- 実incident同型のfailure/rejection後legacy host-finalize、構造化orchestrator host-finalize、独立review passは
  警告0。後続stale/late拒否eventがあっても確定doneを否定しない。
- legacy/service provenanceの`origin=unknown`が多数存在しても通知storm候補0。
- 不可能遷移、valid 0件、valid複数、invalid signal、stale-fence-onlyは各taskにつき一意のescalate。
- LLM誤escalate除去、異常doneのarchive抑止、既存24h冪等、dry-run/kill-switch/cadence、既存Steward提案の非回帰。

## 65. オーケストレーション摩擦の構造的削減（v0.16）

目的: task起票、機械可読CLI、steer回収、handoff欠落、隔離runtime割当で繰り返し発生した
オーケストレーターの手作業を、既存のauthority/session/resource安全境界を保ったまま決定論的な経路へ移す。
本節は2026-07-26に承認された改善群の共通契約であり、workerは本節を変更せず実装する。

### 65.1 task createの原子的なdepends-on指定

- `hachi task create` は反復可能な `--depends-on <taskId>` を受け取れる。指定IDは空文字・重複・
  不存在をfail-closedで拒否する。作成タスク自身を指定することはできない。
- task本体、model/effort override、primary binding、全depends-on linkは**単一DB transaction**で確定する。
  `--status ready`でもtransaction commit前のtaskをdispatchから観測可能にしてはならない。
- 依存linkの向きは§24と同じく`prerequisite -> created task`。既存の循環検査・actor provenance・
  primary bindingの独立性を弱めない。いずれか1件の検証・書込が失敗した場合、task/event/binding/linkを0件へrollbackする。
- JSON結果には既存`task`を保ったまま、確定したdependency ID列をadditiveに返す。CLI/core testは複数依存、
  ready作成、重複・不存在、途中失敗rollback、dispatchからpartial state 0を必須ケースとする。

### 65.2 canonical CLIのJSON stdoutとsingular resource envelope

- 機械処理の正規入口は`hachi` shim / repository `bin/hachi`とする。`--json`指定時は、document型commandの
  stdoutをexactly one JSON documentとし、package-manager banner、進捗、警告を混在させない。診断はstderrへ送る。
  `task logs --follow --json`等、契約上NDJSONであるstream commandは例外として明示する。
- `bin/hachi`はrepositoryが要求するtoolchainとinstall済みCLI runtimeを決定論的に解決し、PATH上の互換性不明な
  pnpmを優先してinstall/purgeを暗黙実行しない。依存不足はmutationせず明示エラーにする。
- singular resourceを返すJSONは、既存のnested fieldを削除せず、最上位へ`id`と利用可能な場合の`status`を
  additiveに持つ。対象はtask/schedule/knowledge/orchestrator等のcreate/show/mutation結果。list/board/metricsは対象外。
- unit testに加え、実`bin/hachi ... --json`のstdoutをそのまま`JSON.parse`できるprocess-level testを置く。
  stderr混在、NDJSON例外、既存nested consumerの非回帰も検証する。

### 65.3 handoff欠落時のbounded Git evidence

- `worker_output_missing` / handoff救済失敗でrunをcloseする前に、finalizeは対象taskのexact session/run fenceを再確認し、
  **read-only**のGit snapshotをbest-effortで取得する。probeはshellを介さないbounded argv、timeout、maxBufferを持つ。
- launch時snapshotはcanonical worktree、repo common-dir、HEAD OIDをrun metaへ保存する。終端snapshotは同じ
  canonical worktree/common-dirである場合だけ、HEAD OID、tracked/untrackedを含む変更pathの件数とbounded一覧、
  start..end commit countを返す。pathはrepo-relativeに正規化・redactし、file内容・diff本文は読まない。
- 証拠状態は`clean | dirty | unavailable`。取得不能・Git外・ownership不一致・timeoutは`unavailable`であり、
  cleanへ丸めない。snapshotはversioned eventとtask commentへ保存し、block reasonは既存`needs-manual:`を維持したまま
  状態・file数・commit数だけをboundedに付記する。`needs-integration:`等の新prefixは追加しない。
- Git probe失敗はrun closeとneeds-manual付替を妨げない。probeはcheckout/add/commit/reset/clean等のmutationを行わない。
  testはdirty/clean/commit済み/untracked/非Git/ownership drift/timeout/stale session/secret redactionを含む。

### 65.4 durable steerのread modelと終端summary

- §58の`steer_deliveries`を唯一のdelivery lifecycle正本とする。`transport_accepted`をobserved/acknowledged/appliedへ
  昇格せず、bridge capabilityが無い状態を推測で補わない。UI/CLIで`applied`という真偽値は作らない。
- `hachi task steer-list <taskId> [--json]`とtask detail read viewは、delivery ID、run/session、sequence、status、
  supersedes、created/observed/acknowledged/resolved時刻、redact済みlast errorをadditiveに表示する。
  Webは同じread modelを読み取り専用cardで表示する。
- run close/handoff確定時、Supervisorは同runのdeliveryを集計し、`acknowledged`、`session_observed`、
  `transport_accepted/uncertain`、`queued/dispatching`、`superseded/stale_cancelled/failed`の件数をversioned event/commentへ
  一度だけ記録する。未配送queuedは§58どおりstale_cancelledへ収束できるが、accepted/uncertainをDBだけで取消済みにしない。
- 未acknowledged steerだけを理由にtaskの成功handoffをblockしない。回収判断に必要なunknownを可視化し、
  自動failへ格上げする変更はbridge acknowledgement能力と別の承認済み契約を要求する。

### 65.5 project-scoped runtime resource profile

- §56のhost-owned lease/member/provenanceモデルを維持し、repository内の任意scriptやtask body自然文を
  provisioning authorityとして実行しない。profileはhost configのstrict schemaに置き、stable `project`、
  canonical repo common-dir、bundle kind、host adapter設定へexactに束縛する。
- `hachi task create --runtime-profile <profileId>`はactive exact orchestrator principalと単一primary bindingを要求し、
  task、binding、runtime requirementを§65.1と同じtransactionで作る。profile不存在、project/common-dir不一致、
  provisioning disabledはready taskをresource無しで起動せずfail-closedにする。
- v1 profileは既存host-owned `worktree_postgres` adapterだけを許可する。workerへはactive leaseのmanifest pathと
  scoped secret pathだけを渡し、shared main DB fallback、Docker socket、cleanup/renew/release authorityを与えない。
- project profileのcode/schema実装とlive enableを分離する。live configの`mode=enforce`、profile追加、実container作成は
  dry-run/doctor/readbackと人間承認を経る別rolloutであり、実装taskの完了条件に含めない。
- testはprofile/binding/principal/common-dir drift、ready前のatomic requirement、provision disabled、unknown profile、
  shared DB target 0、worker arbitrary command 0、secret stdout/board 0を必須とする。

### 65.6 工程・所有権

- 実装順は§65.1 → §65.2/§65.3/§65.4 → §65.5。§65.5のtask create拡張は§65.1の原子化APIを再利用する。
- 各実装は`~/.hachi-kanban/worktrees/`配下の専用branch/worktreeで行い、workerは本節と共有契約型を編集しない。
  review後のff-only統合、必要な共有型変更、live config、deployは担当orchestratorが行う。

## 66. portable local installation（v0.16）

### 66.1 clone と state の境界

- Git cloneが配るのはsource / lockfile / templateだけ。DB、config、token、artifact、provider login、native sessionは
  `$HACHI_KANBAN_HOME`側の端末固有stateであり、Gitや別PCと自動共有しない
- repository access、default branchへのmerge、利用者自身のprovider entitlement/loginはsetup scriptで補完しない
- 新規端末はrepo外bridgeに依存しないexplicit `transport=direct` configを推奨する。bridge/G2は外部appliance、URL、
  0600 token fileを用意した利用者だけが明示選択する。既存host configのtransportは自動移行しない

### 66.2 dry-run-first setup

- `scripts/setup-local.mjs`は既定dry-run、`--apply`だけがmutationを行う。Node.js >=22.13、transport、path、
  tracked config template/CLIをpreflightする
- applyはdependency installを`pnpm install --frozen-lockfile`に限定し、state root / `logs` / `credentials`を0700、
  新規configを0600で作る。state rootがfilesystem root、user home、root直下の広すぎるpath、symlink、非directoryなら拒否する
- configが既にあれば内容・modeを変更しない。CLI targetが無い場合だけclone内`bin/hachi`へのsymlinkを作り、
  同じtargetならno-op、通常file・別target・dangling symlinkなら上書きせずfail-closedにする
- `bin/hachi`は`HACHI_NODE_BIN`の明示 executableを最優先し、invalid path/versionはPATH fallbackせず拒否する。
  provider credentials、secret value、production stateをsetup引数やstdoutへ取り込まない

### 66.3 portable LaunchAgent render

- checked-in `runbooks/templates/*.plist`は`{{PLACEHOLDER}}`を含むsource templateで、直接installしない。
  `scripts/render-launchd.mjs`がclone root、home、state root、stable Node/pnpm executable path、launchd PATH、board、
  Web port、bridge URL/token **file path**、remote opt-inを検証してXML escapeする
- rendererは既定dry-runでhashとredact不要なpath/configだけを表示し、`--output-dir`指定時だけ生成する。
  live `~/Library/LaunchAgents`とその子への直接出力、未知/未解決placeholder、invalid XML character、unsafe board/port/URL、
  非regular executableを拒否する。既存生成物の置換には`--force`を要求する
- portable bridge token path既定は`$HACHI_KANBAN_HOME/credentials/{codex,claude}-bridge-token`。
  token valueはplistに入れず、remote bridgeは`HACHI_BRIDGE_ALLOW_REMOTE=1`の明示opt-inとHTTPSを両方要求する。
  runtimeはtoken fileをsymlinkを辿らず開き、regular file、現在user所有、group/other permissionなし、8 KiB以下を検証する
- Raycast scriptもscript位置からrepoを解決し、HOME/state/pnpm/node/port overrideを検証する。個人user/clone/toolchainの
  absolute pathをtracked fileへ固定しない
- process-level testは別home/clone、XML特殊文字、未知placeholder、live output拒否、symlink overwrite、path/port/remote検証、
  config生成permission/冪等/既存file保全を含む。macOS delivery前に生成4 plistすべてを`plutil -lint`する

## 67. role別 worker execution configuration（v0.17）

### 67.1 scope と解決順

- Hachi が設定する対象は Hachi が起動する `worker` と自動 `reviewer` であり、登録済みの人間操作
  orchestrator session の model / effort / speed を変更しない。rework は `worker` 設定を使い、reviewer 設定を流用しない
- worker は従来の task `profile/provider/model_override/effort_override` に `speed_override` を加える。reviewer は
  `review_*_override` を独立して持ち、未指定 profile は予約profile `review`へ解決する
- 各fieldは task override > 選択profile > runtime default の順に解決する。ただし provider/model のallowlist、
  model固有effort/speed、runtime version、transport delivery capabilityは、値の解決後に一組としてfail-closed検証する
- `max` は共通語彙に含めるが全model対応を意味しない。`fast` も同様で、`ModelTransportPolicy`の明示対応とruntime
  capabilityの二つが揃わなければlaunchしない。unknownをstandardや低いeffortへ黙ってfallbackしない

### 67.2 mutation とCLI

- `task create`はworker用`--speed`とreviewer用`--review-profile/--review-provider/--review-model/
  --review-effort/--review-speed`を受理し、task作成・override保存・最終解決検証を同一transactionで行う
- 既存taskのrole別設定変更はcompound mutationを使う。複数fieldを別transactionで変更してSupervisorに中間状態を
  観測させない。mutationは§60のexact active orchestrator provenanceに加え、task/subtree/worktree/projectの
  単一primary authorityを同じtransactionで照合し、起動中runとreview launch中は拒否する。execution指定付きの
  `task create`は明示bindingが無ければ作成者orchestratorを初期primaryとして同一transaction内でbindする
- `admin resolve <taskId> --role worker|reviewer|all`は要求値、source、transport、capability decisionを表示する。
  read-only resolveにmutation authorityは不要だが、表示結果をlaunch成功の証拠にはしない

### 67.3 speed の意味と配送

- speedは`standard | fast`。省略はruntime defaultへの委譲であり、`standard`と同義ではない。明示`standard`はuserの
  global fast設定を継承しないようadapterが明示的に無効化する
- Codex directはprocess-local configでstandard/fastを明示し、Claude directは公開CLI/settings面で確認できた値だけを
  配送する。bridgeはversioned speed capabilityとechoが揃うまでspeed指定をnative配送済みにしない
- run metaはrequested speed、source、`speedDelivery=native|none`を記録する。`native`は設定をruntimeへ渡した証拠であり、
  provider側fallbackを含む各requestの実効速度の証拠ではないため、観測不能時に`effectiveSpeed=fast`と記録しない
- worker dispatch、reviewer launch、rework launchは同じ起動前capability判定を通り、判定後からrun bindまでにtask設定、
  run/session、cancel fenceが変化した場合はorphan cleanupしてbindしない

### 67.4 初期model policy

- `claude-opus-5`をClaude allowlist候補として扱い、Opus 5の`max`/speedは該当runtime/transport用policyが明示する。
  allowlist追加だけで起動可能にはしない
- Codexの`max`/fastも対象modelごとのpolicyを要求する。Luna等のmodel名から速度を推測しない
- repo既定のCodex direct policyでは`gpt-5.6-sol`は`standard`のみ、`gpt-5.6-terra`/`gpt-5.6-luna`は
  `standard`/`fast`を明示対応とする。Solの明示`fast`は`speed-not-supported`でfail-closedし、速度省略は
  いずれのmodelでもruntime defaultへの委譲として速度配送を要求しない
- `gpt-6-astra`は明示opt-inの追加候補とし、既定worker/reviewer profileは変更しない。
  初期の評価対象はdirectの`low`/`medium`、speedは`standard`のみ。既存の動的allowlist、
  schema、role別overrideとcapability検証を利用し、共有型やG2契約を変更しない。
- Astraのversion policy候補は確認済みCLI版`0.153.0`を保守的下限とするが、版の存在だけを
  実model対応の証拠にしない。live採択前にlow/mediumの要求値・実配送・実行結果を照合する。
  未知価格は未計測として保持し、推定API費用をChatGPT実課金額に読み替えない。
- live config変更、provider課金tier変更、実worker canaryはcode/schema/test完了後の別承認gateとする

## 68. provider native communication（v0.17 observe / v0.18 delivery pilot）

### 68.1 route とauthority

- execution `Transport`とcommunication routeを分離する。communication routeは`hachi`、
  `claude-cross-session`、`codex-app-server`で、cross-providerは常に`hachi`とする
- board、task/run/session、cancel fence、structured actor provenance、`steer_deliveries`が唯一のdurable authorityである。
  native providerのsession/thread/agent IDや受理応答をownership、完了、acknowledgement、停止証拠へ昇格しない
- sourceはactive exact orchestrator identity/session/generation、targetはexact open run/session/cancel fenceで照合する。
  providerの表示名やsession nameからauthorityを推測しない

### 68.2 rollout とfallback

- provider別rolloutは`off | observe | canary | on | draining`。未設定はoff。v0.17はobserveまで、v0.18は
  canary/onの実配送面まで実装するが、repo例とlive configは`off`のままとする。live canary/onへの
  変更は別承認gateとする
- `auto`はsame-provider、same-host、version/capability、exact bindingが揃うときだけnative候補にできる。
  `off/observe`は既存Hachi配送を維持するが、`canary/on`のsame-providerでunsupported/unknownならfail-closedし、
  silent Hachi fallbackしない。explicit `native`も条件不足時にfail-closedする
- nativeが外部runtimeにaccepted/uncertainとなった後は二重配送を避けるためHachiへfallbackしない。未claim/明示rejectだけが
  同じdelivery/idempotency keyでfallback可能である

### 68.3 provider固有境界

- Claude cross-sessionは公開built-in `ListAgents`/`SendMessage`を使うgeneration-fenced relayを想定する。非公開socket
  protocolを実装しない。one-shot direct workerをnative対応済みとみなさず、長寿命named session、inbound policy、
  discovery ref、receiver evidenceが揃う別pilotを要求する
- Codex durable workerはHachi-owned top-level App Server threadを対象とし、native subagent treeは同じroot turn内の
  ephemeral childに限定する。App Serverはversion/schema pin付きopt-inとし、`turn/steer`受理をdescendant drainや
  exact-session stopの証拠にしない
- native binding/attemptはadditive tableに保存し、payload/comment/auditと外部I/O前claimをtransactionで束縛する。
  `transport_accepted`、`session_observed`、`acknowledged`を混同せず、unknown/uncertainをDBだけで成功へ丸めない
- v0.17の公開attempt APIはobserve用のHachi route記録だけを扱い、`steer_deliveries`を`queued`のまま残す。
  binding ID、caller自己申告のcapability、same-host判定からnative claimへ進めず、same-providerの`canary/on`はfail-closed、
  cross-providerはrollout状態にかかわらずHachi routeを記録する。native binding tableは後続pilot用の証拠基盤であり、
  trusted runtime probe、config generation、claim lease/recoveryが揃うまで配送済みの証拠にしない

### 68.4 v0.18 delivery lifecycle

- v0.18は`steer_deliveries`をmessage全体の正本にしたまま、`communication_delivery_attempts`へredact済みpayload、
  source/target binding、route/config/capability hash、claimant、lease、attempt nonce、receiptを追加する。migrationはadditiveな
  v20とし、旧binaryが新しいattemptを配送済みに丸めないよう既存statusの意味を変更しない
- native attemptは`recorded -> claimed -> dispatching -> transport_accepted -> session_observed -> acknowledged`を正常系とし、
  終端に`rejected | uncertain`を持つ。`claimed`はまだ外部副作用が無い状態、`dispatching`は外部runtimeへ要求を開始して
  二重配送の可能性が生じた状態である
- claimはexact active source orchestrator、単一primary authority、exact open target run/session/cancel fence、fresh binding、
  provider一致、same-host、minimum runtime version、capability/config hash、rollout/canaryを同一transactionで再検証する。
  claimとattempt nonce hash/lease保存はCASで行い、外部I/O開始前の`begin dispatch`でattemptと`steer_deliveries`を同時に
  dispatchingへ進める
- lease切れの`claimed`は、同じdelivery/attempt keyと新しいnonceでのみ再claimできる。lease切れまたはprocess消失後の
  `dispatching`は`uncertain`へ終端化し、Hachi/別native routeへfallbackしない。`recorded`または外部I/O前の明示rejectだけが
  rollout規則に従ってfallback可能である
- provider受理は`transport_accepted`に過ぎない。exact message keyをreceiver側sessionで観測して`session_observed`、receiverが
  Hachi CLIへexact attempt/delivery/run/session/fenceを返して初めて`acknowledged`とする。receiptの欠落や不一致を成功へ丸めない
- `off/observe/draining`とcross-providerは従来Hachi adapterを使う。`canary/on`のsame-providerはnative adapter/relayが無い、
  capabilityがunknown、bindingが古い、schemaがdriftした、source provider sessionが登録されていない、のいずれでもfail-closedする

### 68.5 Codex App Server delivery

- Hachi-owned Codex durable workerはversion/schema pin済みApp Serverをprovider adapterとして起動する。v0.18 pilotは同一hostの
  Unix domain socketを使い、`initialize`後に`thread/start`と`turn/start`を実行する。socket path、process、`threadId`、
  App Server `sessionId`、active `turnId`、runtime version、生成schema checksumをHachi session stateへ保存する
- launchが返す`SessionRef.nativeCommunication`は`route=codex-app-server`、exact `threadId`/`activeTurnId`、fresh capability
  evidenceを含む。Supervisorはrun bindと同じauthority検証内でtarget bindingを作り、再起動後も保存済みsocketへ再接続して
  `thread/read`でactive turnを再確認できる場合だけbindingを更新する
- steerはclaim/begin dispatch後に`turn/steer(threadId, expectedTurnId, input)`を1回だけ呼ぶ。JSON-RPC成功は
  `transport_accepted`、そのmessage keyを含むinput/item notificationまたは`thread/read`観測は`session_observed`とする。
  worker promptにはexact ack commandを含め、ackは看板へ戻す
- runtime version不一致、生成schema checksum不一致、unknown method、socket再接続不能、expected turn不一致はnative未対応または
  uncertainとしてfail-closedする。`turn/steer`や`turn/interrupt`の成功をdescendant drain、thread終了、exact-session stopの証拠にしない

### 68.6 Claude cross-session relay

- Claudeの`ListAgents`/`SendMessage`はClaude session内の公開built-inであり、Hachi TypeScriptから呼べるRPCとは扱わない。
  非公開socketへ接続せず、active exact Claude orchestrator sessionがrelay attemptをclaimしてbuilt-inを実行する
- native対象Claude workerはnon-bareのlong-running background sessionとして起動し、衝突しない`--name`、exact provider session ID、
  `ListAgents`が返すagent refをtarget bindingへ保存する。表示名だけで宛先を決めない。
  `crossSessionInbound: accept`はHachi-owned process-local launch settingsでconfigured evidenceとして固定し、
  `claude agents --json`が返さなruntime-observed欄を補完したと推測しない
- Hachi-owned launchはprocess-local settingsに`crossSessionInbound: accept`と公式`Stop`/`StopFailure` command hookを設定する。
  `claude agents --json`がpolicy/version/hashを返さないruntimeでは、exact session/ref/nameとowned launch設定をconfigured evidenceとして
  分離記録し、任意のruntime-observed値を捏造しない。hook inputのexact `session_id`、`transcript_path`、`last_assistant_message`を
  bounded helperでHachi stateへatomic captureし、Claudeのprivate session pathを推測しない
- `hachi communication relay claim`はClaude providerの単一primary orchestratorに、message key、exact target ref、payload、
  begin-dispatch nonceと期限を構造化JSONで返す。orchestratorはclaim後にbegin-dispatchしてから`ListAgents`でrefを再確認し、
  `SendMessage`を1回だけ実行する。`receipt` CLIは`transport-accepted | session-observed | acknowledged | rejected | uncertain`を
  exact nonce/provenanceで記録する
- relay claim後にorchestrator generationが変わった場合、外部I/O前ならlease expiry後に再claimできる。begin-dispatch後のhandoff、
  tool timeout、tool結果の異形は`uncertain`であり、後任generationが同じmessageを再送しない。receiverはenvelope内のexact ack commandで
  Hachiへ観測/ackを返す

### 68.7 queue、CLI、rollout

- structured `task steer`はrouteを最終決定せず、delivery、redact済みpayload、source principal、preferenceを同一transactionで
  `recorded` attemptへ保存する。runtime evidenceを持つSupervisorまたはClaude relay claimがfreshな最終routeを決める。
  legacy provenance無しsteerはnative候補にならず従来Hachi routeだけを使う
- `communication relay list/claim/begin/receipt`、`communication binding list`、`communication binding register-source`はJSONを
  正規面とする。`register-source`はactive orchestrator sessionのprovider/provider session、ローカルhostname、bounded provider version/
  capability probeから有限TTLのsource bindingを作り、caller指定host/providerへ差し替えさせない。claim/begin/receipt/registerは
  structured actor provenance必須、read-only listはsecret/nonce/payloadを既定表示しない。nonceの平文はclaim応答で一度だけ返す
- `canaryPercent`はtask IDとprovider別の固定cohort keyから決定論的に選出し、1..100だけを許可する。同一taskの
  worker/reviewer/rework launchと後続steerは必ず同じ選出結果を使い、legacy launchへnative steerだけを当てない。`rollout=canary`では
  `minimumRuntimeVersion`、`sameHostOnly=true`、`canaryPercent`を必須とし、`on`では前二つを必須とする。
  claim/binding TTLは正の上限付き秒数で、未指定時も有限の既定値を使う
- repo config、user live config、LaunchAgentをこのmigrationだけで変更しない。canary有効化はdoctor、fake adapter障害test、
  exact ack smoke、uncertain recovery、rollback確認後の別承認gateとする

### 68.8 v0.18 verification gate

- Core: migration self-heal/fail-closed、claim競合、lease再claim、dispatch crash、nonce replay、binding expiry、provider/host/version/
  config drift、cancel fence、cross-provider fallbackをDB testで固定する
- adapters: generated schema fixture/checksum、fragmented JSON-RPC、reconnect、expectedTurnId、runtime/schema drift、Claude agent list異形、
  duplicate name/ref、inbound policy、tool receipt parsingをmodel call無しのfake processで検証する
- Supervisor/CLI: queueからackまで、off/observe/canary/on/draining、Codex automaticとClaude relay、post-dispatch fallback禁止、
  restart/handoffをintegration testする。live provider canaryはunit/integration green後に別途1 deliveryずつ行う

## 69. steward 提案の orchestrator inbox ルーティング（v0.19）

§40 の steward 提案（promote / archive / spec-lint / escalate）は、対象タスクへのコメントと §38 通知だけを
出力とし、受け取り側に状態を持たない。結果として同一 (kind, taskId) が 24h 冪等窓の期限切れごとに
無期限で再送され、却下も延期も記録できない。2026-08-20 の実測では 6 週間で同一タスクへ 12 回、
promote 66 件・escalate 47 件がいずれも自動適用されないまま通知だけを増やしていた。
本節はこの提案を durable request 面へ移し、claim・accept・dismiss・defer を記録可能にする。

### 69.1 独立した request family（相乗り禁止）

steward 提案は `orchestrator_requests` を再利用せず、`steward_proposal_requests` と
`steward_proposal_deliveries` を新設する。`orchestrator_deliveries` と同じ
`(request_id, orchestrator_id)` 一意制約・`pending|delivered|acknowledged|dismissed` を持つ。

相乗りを禁止する理由は機能上の衝突である。`getActiveOrchestratorRequestByTask` は kind を問わず
`resolved|cancelled` 以外の request を返し、`task answer` と messages stage はこれを
「active request あり」として worker 質問の回答経路を塞ぐ。提案は長期滞留を前提とするため、
同居させると当該タスクの worker 質問へ回答できなくなる。

### 69.2 lifecycle

`queued | delivered | claimed | accepted | dismissed | deferred | superseded | cancelled`

- `queued -> delivered` は inbox/await が配送を観測した時点。claim 成功を acknowledge とする（§55.2 と同型）
- `claimed` は CAS + lease。担当が複数いても resolver は 1 つだけ
- `accepted` は提案を採用した記録であり、**状態遷移そのものは別操作**とする。request は採用の監査点であって
  タスク遷移の実行主体ではない
- `dismissed` は「今回は採らない」。理由必須。抑止窓は §69.4
- `deferred` は `defer_until` を持つ。その時刻まで同一 (kind, taskId) を再提案しない
- 対象タスクが done/archived へ先行した未 claim の `queued|delivered` は `cancelled` へ収束させる。
  `claimed` 以降は既存 claim を維持する（§55.2 の回収規則と同じ）
- steward が同一 (kind, taskId) をより新しい reason で再評価した場合、未 claim のものだけ `superseded` にできる

### 69.3 配送先の解決と unrouted

配送先は既存の binding→watch 解決をそのまま流用する（task binding の非 observer を優先し、
binding が 0 件のときだけ task/subtree/worktree/project の scope tier 順に watch を辿る）。
**提案専用の単一宛先ルールを新設しない。** inbox は pull 型で claim は CAS であり、
worker 質問が既に同一の多重 watch 環境で正しく動作しているため、fan-out は advisory な提案でも害にならない。

配送先が 0 件のときは **request を作らない**。従来どおりコメントと §38 通知へフォールスルーする。
§55.6 の「配送先のない active request は doctor NG」を踏まないための fail-closed であり、
binding も watch も持たないタスク（2026-08-20 時点で triage/todo 50 件中 9 件）で doctor を恒常的に赤にしない。

watch は worktree scope で登録されるため、worktree を削除しても active のまま残り、配送先解決に
影響し続ける。この失効は `hachi orchestrator watch prune --orchestrator <id>` で行う。

- 対象は指定 identity の **active かつ worktree scope** の watch のみ。他 identity・他 scope・
  既に inactive なものは走査対象にしない（`--orchestrator` は必須）
- 存在確認は realpath で行い、symlink 先が消えている場合も検出する
- **削除はしない。`active=0` にするだけ**（監査のため行を残す。復帰は `watch enable`）
- 既定は dry-run。`--apply` を付けたときだけ inactive 化する
- 「消えている」と断定できる `ENOENT` / `ENOTDIR` だけを stale とし、権限エラー等は
  fail-closed で watch を残す。判定できなかったものは理由付きで報告する
- selector が絶対パスでない watch も判定不能として残す（`watch add` は selector を trim するだけで
  絶対パスを強制しないため、相対 selector を realpath すると CLI の cwd 基準で無関係な場所を見る）

`orchestrator register` の再実行が cwd ごとに watch を増やす点自体は変更しない（prune で回収する運用とする）。

#### 69.3.1 tenant 既定の宛先（2026-09-02 追記。steward 提案だけの最終フォールバック）

上の fail-closed は正しいが、2026-08-20〜09-02 の 2 週間で `steward_proposal_unrouted` が 114 件出ており、
binding も watch も無い task への spec-lint 提案が**恒常的に誰にも届かない**。提案を作る側（steward）の判定は
律速になっている判断面そのものなので、宛先が無い時の最終フォールバックを 1 段だけ足す。

- config `orchestrator.tenantDefaults`（`{ "<tenant>": "<stable orchestrator identity id o_*>" }`、省略可）を追加する
- **binding→watch の解決（上記）で配送先が 0 件のときだけ**、task の `tenant` で `tenantDefaults` を引く。
  該当 identity に **active な live session がある場合に限り**その identity を宛先とし、request を作る。
  live session が無ければ従来どおり `steward_proposal_unrouted`（§55.6 の doctor 規則を踏まないため）
- tenant 既定で宛先が決まった request / event の payload に `routedBy: "tenant-default"` を残す。
  binding / watch 由来には付けない
- **対象は steward 提案（§69）だけ。** worker 質問（§52）、escalation、stall 警告の配送先解決
  （`resolveOrchestratorDeliveryTargets`）は変えない — それらは task の担当が明示されていることを前提にした
  経路であり、tenant 既定へ広げると担当外の identity が worker の質問を claim しうる
- binding / watch が後から付いた場合はそちらが優先される（本節は 0 件のときにしか評価されない）

### 69.4 再提案の抑止とバックオフ

同一 (kind, taskId) の再提案は次の順で抑止する。

1. 未終端（`queued|delivered|claimed`）の request があれば再提案しない
2. `deferred` なら `defer_until` まで再提案しない
3. `dismissed` なら却下回数に応じて窓を伸ばす: 1 回目 24h、2 回目 72h、3 回目 168h、4 回目以降 720h（上限）
4. `accepted` は当該 kind の提案が役目を終えたとみなし、タスクが同じ状態へ戻るまで再提案しない

却下回数は `(kind, taskId)` ごとの `dismissed` 累計で数える。窓の判定に用いる時刻は
`updated_at` ではなく最後の `dismissed` 時刻を保持した列とし、他の更新で窓が延びない。

### 69.5 通知の変更

- promote / archive / spec-lint の提案は **§38 の per-proposal 通知を出さない**。inbox が正本となる
- `escalate` は人間判断が要る種別のため、従来どおり §38 通知を維持する
- 未処理提案の可視化は §48 の朝夕ブリーフに集約する（件数と最古の滞留時間。全件列挙はしない）

### 69.6 適用権限（§40.4 を維持する）

- kind=archive かつ対象 status=done の **auto-archive は本節で変更しない**。機械検証可能な board 衛生として自動適用を続ける
- **tenant=hachi-kanban の promote は、orchestrator が accept しても人間承認ゲートで止まる**。
  §40.4 の自己改変ハザードは inbox 化によって緩和されない。accept は「人間へ上げる」までを意味し、
  タスクを ready/todo へ進める操作を含まない
- それ以外の promote も、accept は提案の採用記録であって遷移の実行ではない（§69.2）

### 69.7 観測

- `hachi orchestrator inbox` は既存 `requests` / `cleanupRequests` と並べて `proposals` を返す
- doctor は「未処理提案の最古滞留時間」と「配送先ゼロでフォールスルーした件数」を表示する。
  配送先ゼロは NG ではなく情報として扱う
- steward 実行結果（§40.5）に、発行した request 数・抑止した再提案数を加える

## 70. Durable successor launch authority（v0.20）

Codex 後継の provider session ID は起動前に指定できない。rollout transcript、環境変数、caller の
自己申告から ID を推測して session authority を移すことは禁止する。Hachi が開始した外部 launch attempt は、
SQLite の `orchestrator_successor_launches`（migration v23）を唯一の正本として扱う。

### 70.1 状態機械と replacement gate

状態遷移は次に固定する。

```text
armed -> runtime_bound -> attested -> accepting -> succeeded
  |           |             |            |
  +-----------+-------------+------------+-> stop_pending -> stopped
                                              -> uncertain

armed -> rejected | expired
uncertain --rollback-complete(explicit fenced recovery)--> stopped
```

- `armed|runtime_bound|attested|accepting|stop_pending|uncertain` は blocking status である
- blocking row は `orchestrator_id` ごとに kind を跨いで exactly one とし、partial UNIQUE index で強制する
- live runtime は `(observed_host_id, tmux_socket_path, tmux_server_lifetime_hash, tmux_pane)` を一意キーとし、
  attested binding `(target_provider, provider_session_id)` も重複不可とする。pane ID は tmux server の
  生存期間内だけ一意なので、host と pane だけを runtime authority にしてはならない
- runtime unique index の対象は `runtime_bound|attested|accepting|stop_pending|uncertain` だけとする。
  terminal `succeeded|stopped|rejected|expired` は reservation を保持せず、terminal CAS と同じ transaction で
  `runtime_ownership_claimed=0` へ収束させる
- `session start`、register による session 作成、handoff、takeover、final accept/takeover は共通 replacement gate を通る。
  final mutationだけが自分自身の exact slot を除外できる
- `uncertain` は自動的に `stopped` へ遷移させない。時間経過、次 tick、generic cleanup は解除根拠にならない

### 70.2 slot の authority と secret 境界

slot は少なくとも次を保持する。

- stable orchestrator、kind、target provider、source session/generation
- arm 時の expected canonical cwd/host/hook definition/helper hash と、readback した observed cwd/host/hook hash
- planned/exact tmux session、pane、pane PID、PGID、canonical tmux socket path、server PID/start time、
  server-lifetime nonce の hash、launch/owner nonce の hash、owner readback 時刻
- provider-generated session ID、provider session source、attestation handle の hash/TTL/consume 時刻
- handoff token fence、takeover arm 時に固定した stale cutoff、cancel/accept/stop fence、revision、barrier release authorization、deadline
- kill 直前 owner readback、kill result、session/PID/PGID 各停止値と観測時刻
- successor board session/generation、error、作成/更新/終端時刻

raw server-lifetime/launch/owner nonce、attestation handle、accept/stop fence は owner-only capability とする。read view、JSON、
task comment、artifact、構造化 log には出さない。raw attestation handle は resume で同じ値を再提示する期間だけ
owner-only SQLite 内に保持し、terminal 化時に消去して hash だけ残す。

successor session には `provider_session_source` も保存する。migration v23 前の row、空文字、unknown source は
manual と同じ未証明として扱い、provider-native binding/relay の source authority に使わない。
generic `session start` / `handoff-accept` / `takeover` Store API は trusted source を引数に取らず、provider/ID pair が
ある場合も `manual` を内部で導出する。`codex-session-start|claude-delivery` は successor final transaction だけが設定できる。

共有型は `packages/core/src/types.ts` を正本とする。既存 `KanbanStore` へ未実装 method を混ぜず、
後継起動は narrow capability interface `OrchestratorSuccessorLaunchStore` として定義する。DB 実装は migration v23 と
全 CAS を同時に実装してからこの interface を実装し、CLI の依存は両 store の intersection とする。

### 70.3 arm と runtime bind

`successor-launch arm` は外部 process 作成前に実行する。

- source session/generation/stable identity と common replacement gate を同一 transaction で検証する
- handoff は token hash 保存と `active -> handoff_pending` を slot INSERT と同一 transaction で行う
- takeover は caller が選んだ `staleBefore` を arm input に必須化し、同じ stale predicate を arm と final の
  両 transaction で検証する。cutoff は slot に保存し、final API は新しい cutoff を受け取らない。旧 session/status/claim は
  arm では変更しない
- caller-facing CLI から provider session ID、host、tmux 名、pane、nonce、hook hash を指定できない
- `armed -> rejected|expired` は runtime bind 前かつ barrier release 未承認の場合だけ許可する

spawn 前の失敗は `resolveUnboundSuccessorLaunch` で exact `armed -> rejected|expired` CAS を行う。tmux 作成後に
readback/bind が失敗した場合は、cwd/host/session/pane/PID/PGID/owner/hash のうち観測できた値と、未観測を示す
null/空値を保存し、barrier release を許可せず `markArmedSuccessorLaunchStopPending` で `armed -> stop_pending` とする。
一項目でも未観測なら停止成功を推測せず、exact owner/停止証拠が揃うまで `uncertain` として replacement gate を閉じる。
これら以外の経路で blocking `armed` を terminal 化してはならない。
handoff slot の unbound 解決では、source session/generation/status と slot に保存した handoff token fence を再検証し、
`handoff_pending -> active` と slot の `rejected|expired` 化を同一 transaction で行う。どちらか一方だけを commit しない。

tmux 作成後、CLI は exact session/pane/PID/PGID と owner nonce を readback し、`bind-runtime` が
slot/revision/status/deadline、planned session、arm 時の cwd/host と観測した canonical pane cwd/current host、
hook hash、canonical socket path、server PID/start time、server-lifetime hash を単一 transaction で検証して
`armed -> runtime_bound` を CAS する。commit 後だけ exact one-shot barrier を release する。
bind 後 release 前に caller が落ちても `runtime_bound` が replacement を止める。

server lifetime は bind 経路だけが spawn 後・bind 前に256-bit nonce候補を生成し、
`tmux set-option -s -o @hachi_runtime_lifetime_v1 <candidate>` で未設定時だけ初期化する。競合時は
`show-options -s -v` で読めた既存値を勝者とし、raw nonce は永続化・表示しない。
`tmux_server_lifetime_hash` は
`SHA-256("hachi-tmux-server-lifetime-v1\0" + canonicalSocketPath + "\0" + serverLifetimeNonce)` とする。
socket/PID/start time/nonce/session/pane/pane PID/cwd/owner は tmux→ps→tmux の before/after で同じ値を
観測した場合だけ stable readback とする。PID/start time は torn-read 診断用で、一意 authority にはしない。
attest/final 経路は lifetime nonce を新規作成せず、fresh readback だけを行う。

migration v25 は `tmux_socket_path TEXT NOT NULL DEFAULT ''`、`tmux_server_pid INTEGER`、
`tmux_server_start_time INTEGER`、`tmux_server_lifetime_hash TEXT NOT NULL DEFAULT ''` を追加し、旧 runtime index を
上記4要素の partial UNIQUE へ再作成する。順序は「列追加 → 旧index drop → 既存terminal ownership解放 →
新index作成 → version記録」を単一 transaction に固定する。legacy row の空 lifetime を現在の tmux server から
推測 backfill してはならない。claimed=1かつ lifetime 空の blocking legacy row は同一 `(host,pane)` の新bindを
互換 collision guard で拒否し、明示 recovery まで残す。

### 70.4 フェーズ別 deadline 予算（v0.21・2026-08-31 実測により追加）

> **実装状態: 統合済み（2026-08-31 / main=`3307129`・`t_d52e1bc290f69129`）。**
> 採用値は runtime bind 予算 **15 秒** / attestation 発行予算 **15 秒**（= arm + 30 秒） /
> attestation TTL **30 秒** で、いずれも下の「予算の値と境界」の範囲内である。
>
> **実機 canary: 取得済み・attestation 失敗 0 件。ただし n=4 であり「修正済み」ではない
> （2026-09-01 gen35 実測）。** 新コード判定は `attestation_deadline_at - created_at == 30`
> （旧コードは `15`）で行った。`gap=30` の attempt は 6 件で、内訳は次のとおり。
>
> | slot | 責務 | 終端 | `expires - issued`（TTL） |
> |---|---|---|---:|
> | `osl_e70fec2563ec9c15` | tenant-a | succeeded | 30 |
> | `osl_8e4225df937797cb` | self-improve | stopped（**delivery probe**・`issued_at IS NULL`） | — |
> | `osl_0b002a1f36a8b421` | self-improve | succeeded | 30 |
> | `osl_c2b935325fa84b6d` | tenant-a | stopped（**delivery probe**・`issued_at IS NULL`） | — |
> | `osl_943bb6cf15fcf527` | tenant-a | succeeded | 30 |
> | `osl_8b3bcd12fdbaff38` | self-improve | succeeded | 30 |
>
> - **attestation 経路を実際に通ったのは 4 件で、4 件とも成功した**（TTL はいずれも 30）。
>   残る 2 件は attestation 発行に到達する前に落ちているので、本節の修正の可否を問えない
> - 旧コード（`gap=15`）の attestation 系失敗 7 件（CAS 5 / TTL 2）は
>   **すべて 2026-08-31 の 1 日に集中しており、それ以前は 0 件**である。
>   したがって「従前の成功率 41%」（`k_ec79d87c218e`）は**その日の attempt 成功率**であって
>   長期レートではない。**n=4 の無失敗を有意と読まないこと**
> - **残っている失敗モードは delivery probe 側で、本節とは独立である**
>   （`t_552241be2373b74f`。窓の内側にデータが在るのに落ちる。実測3件とも user→assistant が
>   2.5 / 3.74 / 5.8 秒で deadline に 6〜8.7 秒の余裕があった。**窓を広げる提案をしない**）。
>   **観測された失敗割合は下がっていない**（標本上の記述であって母集団の失敗率ではない）
>   — 新コード 2/6 = 33%、
>   旧コード（`gap=15`・41 attempt）は 8/41 = 19.5%。**n=6 なので「増えた」とは言えないが、
>   本節の修正で delivery probe が改善したと読むこともできない。** 旧コードの stopped 17 件の
>   内訳は delivery probe 8 / attestation CAS 5 / attestation TTL 2 / runtime bind 1 /
>   caller 消失 rollback 1 である

**`runtimeDeadlineAt` と `attestationDeadlineAt` に同じ値を入れてはならない。両者は別フェーズの
期限であり、別々の予算を持つ。** `attestation_expires_at` に `attestation_deadline_at` を
代入してはならない。

§70.2 は slot の保持物として「attestation handle の hash/**TTL**/consume 時刻」と「deadline」を
別項目として挙げている。**契約は当初から TTL と deadline を別概念として扱っていたが、実装が
両者を1つの定数へ畳んでいた。** 本節はその区別を規範として明文化する。

#### 予算の定義

| 値 | 起点 | 支配するフェーズ |
|---|---|---|
| `runtimeDeadlineAt` | arm | spawn → owner readback → `bind-runtime` CAS → barrier release |
| `attestationDeadlineAt` | **`runtimeDeadlineAt`** | attestation が**発行**されるまで（Claude の delivery 確認 / Codex の SessionStart 待機を含む） |
| `attestation_expires_at` | **`attestation_issued_at`** | 発行済み attestation を final transaction が **consume** するまで |

- `attestationDeadlineAt` は `runtimeDeadlineAt` より**厳密に後**でなければならない。
  arm transaction はこの不等式を検証する（両者が `now` より後であることの検証に加える）
- `attestation_expires_at` は発行時刻に TTL を加えて算出する。**deadline から導出しない。**
  したがって「発行できたのに consume する時間が残っていない」状態は構造的に発生しない
- Claude 経路と Codex 経路は**同一の slot 値**を期限として読む。provider ごとに独立した
  ローカル定数（`startedAt + 定数`）で期限を再計算してはならない

#### なぜ分けるか（2026-08-31 の実測）

同一 board の `orchestrator_successor_launches` 14 件（2026-08-31）で、両 deadline に同じ
`arm + 15秒` を入れていた結果は次のとおり。**attestation 系の成否を分けていたのは、
delivery 確認が 15秒の何秒前に終わったかだけだった**（下表の「delivery 未確認」2件は別事象で、
窓内に nonce 一致行と後続 assistant 行が揃わなかったものである）。

| 終端 | 件数 | `attestation_issued_at` | `revision` |
|---|---:|---|---:|
| `succeeded` | 5 | deadline の **0〜5秒前** | 5 |
| `exact slot CAS に失敗` | 5 | **NULL**（発行に到達せず） | 4 |
| `attestation TTL が期限切れ` | 2 | **deadline と同一秒** | 5 |
| delivery 未確認 | 2 | NULL | 4 |

- **CAS 失敗と TTL 期限切れは同一根因である。** `issueSuccessorAttestation` の候補クエリは
  `attestation_deadline_at >= now` で絞るため、deadline 経過後は候補 0 件となり `null` を返す。
  呼び出し側はこれを「exact slot CAS に失敗」と表現するので、**別機序に見えていた**
- **`attestation_expires_at = attestation_deadline_at` は幅ゼロの TTL を生む。**
  deadline と同一秒に発行された 2 件は、その秒のうちに consume できなければ必ず失敗する
- runtime bind は全 14 件が **arm + 1〜2秒**（13件が1秒）で完了しており、`runtimeDeadlineAt` の 15秒は
  本来の用途に対して十分に余裕がある。予算を食い潰していたのは attestation 側である

#### 進行中判定は status 依存にする

`handover` の durable recovery が「既存 launch はまだ進行中か」を判定するとき、
**全 status を `max(runtimeDeadlineAt, attestationDeadlineAt)` で一律に判定してはならない。**

発行済み attestation の有効期間は `attestation_expires_at` であり、TTL の起点が発行時刻である以上、
これは `attestationDeadlineAt` **より後になりうる**。一律判定のままだと、
**発行直後に caller が落ちた slot を、まだ consume 可能なうちに terminal 化する** —
上の「consume する時間が残っていない状態は構造的に発生しない」が成り立つのは、
本項の status 依存判定を伴う場合に限る。

| status | 進行中と見なす上限 |
|---|---|
| `armed` | `runtimeDeadlineAt` |
| `runtime_bound` | `attestationDeadlineAt` |
| `attested` / `accepting` | `attestation_expires_at` |

#### 予算の値と境界

値を規定しないと「予算を分けた」と主張しながら実質的に異なる寿命を選べるため、範囲を固定する。

- `runtimeDeadlineAt - arm`（runtime bind 予算）は **15 秒**を維持する。
  実測で bind は arm + 1〜2 秒に完了しており、延長する理由が無い
- `attestationDeadlineAt - runtimeDeadlineAt`（attestation 発行予算）は **15 秒以上 60 秒以下**
- `attestation_expires_at - attestation_issued_at`（attestation TTL）は **30 秒以上 120 秒以下**
- **不変条件**: `attestationDeadlineAt + attestation TTL <= handoffExpiresAt` とする。
  handoff token が先に失効すると、有効な attestation を持ちながら final が通らない。
  現行の `HANDOFF_TTL_SEC = 600` は上記の上限値（15 + 60 + 120 = 195 秒）でも満たす
- 期限比較は epoch 秒で行い、**`>=` を「まだ有効」**とする（既存 CAS の
  `attestation_deadline_at >= now` と揃える）。境界秒は有効側に倒す
- arm transaction は既存の「両 deadline が `now` より後」に加えて
  **`runtimeDeadlineAt < attestationDeadlineAt`** を検証する。等値の arm を受理してはならない

#### 影響範囲（この変更が動かすもの）

- **crashed `--apply` の再入待ち窓が伸びる。** 上の status 依存判定により、落ちた `--apply` が
  再入をブロックする時間は最長 `attestation_expires_at` まで延びる（上限値なら arm + 195 秒）。
  **この延長は許容する**が、予算を決めるときは再入待ちの上限として明示的に評価する
- `armed -> expired|rejected` の判定（`failedAt > runtimeDeadlineAt`）と
  `bind-runtime` CAS の `runtime_deadline_at >= now` は **`runtimeDeadlineAt` のまま**であり、
  本節は意味を変えない
- schema 変更は不要である（`attestation_expires_at` 列は既に存在する）。migration を伴わない

## 71. Codex SessionStart attestation（v0.20）

### 71.1 静的 helper と入力

Codex 用 hook definition と helper は review 済みの静的 artifact 一組だけを使う。毎 launch の dynamic hook、
launch file、rollout transcript 探索を authority transport にしない。helper command は次に固定する。

```bash
hachi orchestrator successor-launch attest
```

helper が authority input として使うのは hook stdin JSON の `session_id`、`cwd`、`source`、
`hook_event_name` と、通常の tmux 子 process が継承した `TMUX_PANE` だけである。Codex の共通 hook payload に
含まれる `transcript_path`、`model`、`permission_mode` は size/schema を検証して受理してよいが、authority、
候補選択、binding、hash の入力には使わない。これら以外の field は fail-closed で拒否する。`--slot`、tmux
session/pane、owner nonce、provider session ID を caller 引数で指定する面は作らない。`TMUX_PANE` は
`^%[0-9]+$` の locator であり authority ではない。

Gate 4 の review 済み静的 hook/helper artifact と共通 resolver/manifest が導入されるまでは、production helper は
artifact path を `~/.codex` 等から推測せず hash probe 未構成として fail-closed にする。arm、attest、doctor は
publication 後に同じ canonical path/hash resolver を使い、`CODEX_HOME` と実際に呼ばれる helper entrypoint 全体を
反映する。

### 71.2 exact runtime 照合

helper は provider-generated ID を記録する前に次を行う。

1. `hook_event_name=SessionStart`、既知 source、JSON schema と size を検証する
2. exact pane から tmux session、pane ID/PID/PGID、pane cwd、owner nonce、canonical socket path、
   server PID/start time、既存 server-lifetime nonce を fresh readback する。nonce欠落時に初期化してはならない
3. current host、hook cwd、tmux cwd を canonical 化し、installed hook/helper hash を再計算する
4. host/cwd/session/pane/PID/PGID/owner/hook hash/deadlineに加え、socket/server PID/start time/lifetime hashが
   すべて一致する `runtime_bound` row を検索する
5. 結果が exactly one の場合だけ provider-generated session ID を保存し、`runtime_bound -> attested` を CAS する
6. 成功時だけ同じ raw handle を hook stdout の `additionalContext` へ返す

0件・複数件、`TMUX_PANE` 欠落/不正、same-cwd の別 pane、owner/hash/readback 不一致は authority 0 とする。
Codex が `TMUX_PANE` を helper へ継承しない場合も fail-open にせず、外側 timeout と exact rollback へ倒す。
`resume` の consumed 判定も同じ fresh server-lifetime 一致を要求し、旧 server lifetime の binding を再利用しない。

### 71.3 source と replay

- `startup` は新規 attestation を一回作る
- `resume` は同じ slot/provider session に同じ handle を返す。TTL は延長しない
- `compact|clear` は record、handle、binding を作らない
- `SubagentStart` と `agent_id` 付き入力は拒否する
- consume 後の resume は既存 board binding を維持し、新しい binding を作らない
- provider session ID は SQLite 以外の file/env へ書かない

## 72. Atomic accept/takeover と exact rollback（v0.20）

### 72.1 final transaction

Codex の正常経路は `--provider codex --attestation-handle <handle>` とし、
`--provider-session-id` の併用を拒否する。まず exact `attested -> accepting` CAS で accept fence を固定し、
続く単一 final transaction で次を再検証する。

raw accept fence は owner-only SQLite に保持する。同じ slot/handle の `accepting` retry は新しい fence を発行せず、
同じ値を返す。別 handle/operation/revision の retry は mutation 0 とする。

- slot ID/handle hash/revision/accept fence、kind と requested operation
- source session/generation/stable identity と、この slot だけが唯一の blocking row であること
- target/source が `codex/codex-session-start` または `claude/claude-delivery` の正しい組であり、provider session ID が
  非空・未使用であること。Codex だけに固定せず、Hachi 起動 Claude も同じ slot final transaction で完了させる
- host/cwd/session/pane/PID/PGID/owner/hook hash と attestation TTL
- canonical socket path、server PID/start time、server-lifetime hash。Codex SessionStart と Claude delivery は
  それぞれ attestation/final 前に fresh readback を行い、bound row と完全一致しない場合は
  attest/claim/finalを0回のまま exact rollbackへ送る
- handoff token hash/expiry、takeover では slot に保存した cutoff に対する current stale condition

成立時だけ同じ transaction で handle/provider session ID を一回 consume し、旧 session を
`superseded|stale` へ変更し、attested ID を持つ successor session を作成し、watch/claim を移管または requeue し、
slot を `succeeded` にする。caller が提示した provider session ID を board row へコピーしてはならない。

final mutation 失敗時は旧 session の authority/status/claim を維持し、slot を exact CAS で `stop_pending` へ送る。
handoff は同じ transaction で token hash を回転して新規 accept を締め出す。takeover は旧 session row を変更しない。
DB timeout は exact 再読込し、`succeeded` なら同じ結果を返す。再読込不能な `accepting` は blocking のまま残す。

server lifetime の欠落・不正・driftは
`SUCCESSOR_SERVER_LIFETIME_MISMATCH: slot=<id> expected=known observed=<missing|malformed|drift>; `
`attestation/final authority=0; exact rollback required` と分類する。raw nonce、raw fence、hash値そのものを
診断へ出してはならない。Claude delivery は bound row の値をそのまま attestation input にせず、delivery確認後に
fresh readbackと完全比較したruntime identityだけを使う。driftしたruntimeを generic killしてはならない。

### 72.2 stop と uncertain

`runtime_bound` 以後の timeout、hook failure、mismatch、accept conflict、TTL expiry は `rejected|expired` にせず
`stop_pending` とする。停止は次の順に固定する。

stop fence の raw 値は owner-only SQLite に保持する。同じ exact slot/revision を `stop_pending|uncertain` で
再 claim した場合は新しい fence を発行せず同じ値を返し、caller/reconciler crash 後も recovery capability を失わない。

1. exact slot/revision/stop fence を claim する
2. kill 直前に exact tmux session の owner nonce を readback して hash と時刻を保存する
3. owner 不一致なら kill せず `uncertain` にする
4. 一致時だけ exact tmux session を停止する
5. exact session 消滅、pane PID 消滅、PGID 消滅を個別に観測する
6. 三点すべて true の場合だけ `stopped` へ CAS する。handoff slot は source session/generation/status と slot に
   保存した handoff token fence を再検証し、`handoff_pending -> active` と slot の `stopped` 化を同一 transaction で行う
7. kill result 不明、観測不能、一点でも残存なら `uncertain` にする

generic kill、prefix/glob 探索、bridge restart、別 session stop への fallback を禁止する。
`succeeded|stopped|rejected|expired` へ遷移するCASは、同じtransactionで
`runtime_ownership_claimed=0`を設定する。`uncertain`はownership reservationを保持するが、legacy事故で既に0のrowを
時間経過やmigrationだけでterminal化してはならない。

### 72.3 explicit recovery

`successor-launch rollback-complete --slot <id> --fence <fence>` は既定 dry-run とし、`--apply` の場合だけ
row に固定済みの exact target を再観測する。caller は tmux/PID/PGID/nonce を上書きできない。

- slot/revision/fence と三点停止証拠が完全一致した場合だけ `stopped` へ CAS する
- handoff は handoff token fence 一致時だけ `handoff_pending -> active` と slot terminal 化を同一 transaction で行う
- takeover は source row を変更しない
- owner 不一致、session 再出現、PID/PGID 残存、fence 不一致は mutation 0 とする
- explicit `rollback-complete` に限り、`runtime_ownership_claimed=0` のlegacy `uncertain`でも、row固定の
  session/pane/pane PID/PGID/owner hash、保存済み`stop_owner_matched=1`、owner readback時刻、
  `kill_owner_readback_hash=owner_nonce_hash`、保存済みkill result、fresh三点不在、source/token fenceの全てが
  一致すれば回復できる。claimed flagはreservation状態であり停止証拠そのものではない。通常stop、自動tick、
  migrationへこの例外を広げない。保存済みkill resultはcaller入力で上書きせず、`unknown`でもfresh三点不在が
  揃えば回復可能とする

## 73. Provider compatibility、rollout、実装 gate（v0.20）

### 73.1 provider 入力行列

| 経路 | 契約 |
|---|---|
| Claude 正常系 | non-empty `--provider claude` と `--provider-session-id` を atomic pair で必須化。handle は禁止 |
| Hachi 起動 Claude | 同じ durable slot を使い、既存 transcript delivery 確認後に source=`claude-delivery` で attested 化 |
| Codex trusted | `--provider codex` と attestation handle が必須。caller session ID は禁止 |
| Codex manual | mode=`manual` かつ blocking slot 0件の場合だけ caller pair を受理。source=`manual`、native eligibility=false |
| mode=`enforce` | attestation なし Codex accept/takeover を拒否 |
| placeholder/register | provider/ID 全省略は維持。片方だけは拒否 |

blocking slot がある場合、Claude pair や manual Codex pair で別 slot から迂回してはならない。
`provider_session_source=manual|''|unknown` の session から native binding を作ることも禁止する。

### 73.2 config と publication gate

設定は次とする。

```text
orchestrator.codexSuccessorAttestation.mode = manual | enforce
default = manual
```

unknown mode/key は config 読込時に fail-closed で拒否する。`enforce` への変更は repository 実装ではなく
host publication であり、review 済み静的 hook/helper の install、exact hash/doctor 確認、必要な Codex restart、
実世代交代 canary と exact cleanup を含む人間承認 gate の後だけ行う。失敗時は manual へ戻し、generic kill は行わない。
実装・review・canary 承認までは manual `create_thread` を正式 fallback とする。App Server は後段検討とする。

### 73.3 実装順と検証

1. Gate 0: 本節、frozen `types.ts`、config schema/mode
2. Core/DB: migration v23、slot CAS、replacement gate、final transaction、stop/recovery
3. CLI/helper: provider 入力行列、静的 SessionStart helper、tmux readback abstraction
4. tmux launch: arm→spawn→owner readback→bind→barrier、15秒 timeout、exact rollback
5. doctor/docs/static template と offline integration
6. 人間承認後の publication/canary

実装 task の ownership は重複させない。Core/DB worker は frozen `types.ts` を変更しない。tmux task は
`orchestrator-handover.test.ts` を主要回帰面に含め、Claude 正常 argv/delivery を維持する。offline integration は
same-cwd cross-pane、heartbeat revival、final transaction race/replay、timeout/token fence、stop_pending/uncertain、
manual/enforce、Claude 正常系を含む。live hook/config、実 tmux/Codex、restart、publication は offline task の検証に使わない。

## 74. auto-archive の統合観測ゲート（v0.20）

目的: `steward_auto_archive` が「統合済み」を**観測せずに主張する**経路を塞ぐ。
2026-08-23〜24 に tenant=tenant-a で3件、未統合（worktree に未コミットの成果あり）の done タスクが
archived へ落ち、後任オーケストレーターから「終わった仕事」に見える状態になった。
うち2件は worktree ごと消滅している。

本節は §40.4 の自動適用規則を**制限する側**に足すものであり、§69.6 の
「kind=archive かつ status=done の auto-archive は §69 では変更しない」と矛盾しない
（§69 は inbox ルーティングの節であり、適用可否の述語は §40.4 が正本）。

### 74.1 前提となる事実（実装前の実測）

- 現行の適用条件は `kind === "archive" && status === "done"` と 24h 冪等のみである。
  **「完了後 N 時間経過」「統合済み」「gate_passed 起源」という条件はコードに存在しない。**
- steward イベントの `reason` は**判断 session（LLM）が生成した自由文**であり、
  `steward.ts:697` はそれをそのまま永続化している。「統合済みのためアーカイブ可」は
  機械検証の結果ではない。
- worker の既定は no-commit。したがって worker ブランチの HEAD は worktree 作成時点の
  main コミットに留まり、main が進んでも祖先であり続ける。
- **祖先関係は統合の証明ではない。** squash merge / cherry-pick で統合された場合、
  内容は統合先に入っているのにブランチ HEAD は祖先にならない。
  「祖先でない」だけを veto 条件にすると、これらを恒久的に未統合と誤判定する。
- **`git cherry` の patch-id 等価は厳密な同一性ではない。** 空白の扱いが異なる変更を
  同一と見なすことがあり、merge commit は評価対象から外れる。単独では統合の証明にならない。
- **観測できなかったことと、観測して統合済みだったことは別である。** 両者を同じ扱いにすると、
  probe が失敗した瞬間に本節の防御が丸ごと無効になる。

### 74.2 統合観測ゲート（決定表・pure）

適用前に、対象 done タスクについて次の決定表を評価する。`veto` の場合 archive を適用しない。
表は pure 関数として実装し、git 観測は別途注入する probe が行う（§64.2 の
done-consistency と同じ形）。

**評価の前に cwd を正規化する（§74.2.0）。** 決定表は正規化の結果を入力に取る。

| # | 状況 | 判定 | integrationEvidence |
|---|---|---|---|
| 1 | `cwd:` 行が無い | **veto** | `unobservable:no-cwd` |
| 2 | cwd を worktree identity へ正規化できない（非 git / ファイル / bare / 解決失敗） | **veto** | `unobservable:cwd-not-a-worktree` |
| 3 | cwd が **repo root**（linked worktree でない）・repo root は clean | allow | `not-observable:repo-root` |
| 4 | cwd が **repo root**・repo root が dirty | allow | `not-observable:repo-root-dirty` |
| 5 | linked worktree のパスだが**不在**。かつ **board の canonical worktree root 配下**である | allow | `not-observable:worktree-missing` |
| 6 | linked worktree のパスだが**不在**。canonical worktree root 配下**でない** | **veto** | `unobservable:cwd-not-a-worktree` |
| 7 | worktree 存在・統合先 ref を1つも解決できない | **veto** | `unobservable:no-integration-ref` |
| 8 | worktree 存在・**probe が失敗 / timeout した** | **veto** | `unobservable:probe-failed` |
| 9 | worktree 存在・porcelain 非空（dirty） | **veto** | `unintegrated:worktree-dirty` |
| 10 | worktree 存在・clean・§74.2.2 の **A**（到達可能）が成立 | allow | `clean-head-reachable` |
| 11 | worktree 存在・clean・§74.2.2 の **B**（patch 等価 + 内容一致）が成立 | allow | `clean-patch-equivalent` |
| 12 | worktree 存在・clean・A も B も成立しない | **veto** | `unintegrated:branch-commits-not-in-main` |
| 13 | 判定中に pin した HEAD / 統合先 ref / porcelain が変化した | **veto** | `unobservable:observation-drift` |

- **評価順は表の上から**（行番号順）。順序依存があるので必ずこの順で評価する。
  行13（observation drift）だけは例外で、**判定のどの段階で検出しても即座に veto へ倒す。**
- **allow は行3・4・5・10・11 の5行だけである。**
  - 行1は「特定できない」ので **veto**。dev board 実測で done+archived 696 件中 31 件（4%）であり、
    veto にしても board は詰まらない。
  - 行3・4 は repo root 直下の作業であり、worktree 単位の統合観測が**原理的に成立しない**
    （repo root の dirty は他のオーケストレーターの作業かもしれず、当該タスクへ帰属できない）。
    実測で 228 件（33%）を占めるため veto にすると board が詰まる。
    **repo root が dirty か否かで evidence を分け**、監査可能にする（§74.3 で計数する）。
    **「worktree が無い」と表示してはならない**（事実に反する）。
  - 行5は `stat` 等でパスの不在を確認でき、**かつそのパスが board の canonical worktree root
    （`$HACHI_KANBAN_HOME/worktrees/` 相当）配下**である場合のみ。
    body の `cwd:` は信頼できない外部入力であり、任意の不存在パスを書けば
    行1の veto を回避できてしまうため、配下判定で塞ぐ（行6）。
    エラーで不在を確認できなかったものはここへ倒さない（行2）。
- **行7〜8（worktree はあるのに観測できなかった）は veto にする。**
  「観測できたはずなのにできなかった」を allow に倒すと、probe が壊れた瞬間に
  本節の防御が全面的に無効になる。オーケストレーターが手動で archive する。
- worktree パスの解決元は task body 先頭の `cwd:` 行のみ（専用列は無い）。
- **cwd が repo root（行3/4）の場合は、porcelain 以外の git probe を実行してはならない。**
  main の作業ツリーが dirty なだけで全タスクの archive が一斉に止まるため。

#### 74.2.0 cwd の正規化（決定表の入力を確定する）

決定表を評価する前に、body の `cwd:` 文字列を**worktree identity へ正規化**する。
`cwd:` は信頼できない外部入力であり、正規化を省くと実装ごとに解釈が割れる。

1. パスを絶対化する（シンボリックリンクを解決する）
2. `stat` で存在と種別を確認する。**存在しない**なら決定表の行5/6へ
   （canonical worktree root 配下かで分岐）。**ディレクトリでない**なら行2
3. `git -C <path> rev-parse --path-format=absolute --show-toplevel --git-common-dir` 等で
   **toplevel と common-dir** を得る。失敗（非 git / bare / 権限）なら行2
4. 得た toplevel が repo root（common-dir の親）と一致すれば **repo root**（行3/4）。
   一致しなければ **linked worktree**（行7以降）
5. **cwd がリポジトリのサブディレクトリでも toplevel へ正規化する。**
   サブディレクトリ指定を別扱いにしない

正規化の結果（`worktreeIdentity`）は pin の対象に含め、§74.4 の再観測でも同一性を確認する。

#### 74.2.1 統合先 ref の解決（ネットワークアクセス禁止・順序付きフォールバック）

ローカルの `refs/heads/main` を決め打ちしてはならない。既定ブランチが main とは限らず、
ローカル main が origin より遅れていれば統合済みの成果を誤 veto する。

次の順で解決を試み、**最初に解決できた1つだけを統合先とする**。

1. `refs/remotes/origin/HEAD` の指す先（`git symbolic-ref` で解決）
2. `refs/remotes/origin/main`
3. `refs/heads/main`

- **候補を union にして「どれか1つに入っていれば統合済み」としてはならない。**
  `origin/HEAD` が `origin/develop` を指す構成で、古いローカル `main` にしか無い commit を
  「統合済み」と誤認するため。権威のある統合先は1つに定める。
- 選んだ ref は **ref 名と OID を対にして固定（pin）する。** 以降の判定と §74.4 の再観測は
  同じ pin を使い、途中で ref が force-update / 付け替えされていないことを確認する。
- **worktree 側も canonical パスと HEAD OID を pin する。** status / `merge-base` / `cherry` /
  `diff` の各コマンドへは pin した OID を渡し、コマンド間で HEAD が進んでも
  古い観測結果で新しい commit を見逃さないようにする。
- `symbolic-ref` が解決できないことは probe 失敗ではない。**次の候補へフォールバックする**。
- fetch / ls-remote などネットワークを伴う操作は行わない。
- 1つも解決できない場合は決定表の行7（veto）。

#### 74.2.2 統合証明の条件（すべて満たすときだけ allow）

祖先判定単独も `git cherry` 単独も統合の証明にならない（§74.1）。
clean な worktree について、次の **A または B** が成立するときだけ「統合証明が立つ」とする。

**A. 厳密な到達可能性**
- `git merge-base --is-ancestor <pin した worktree HEAD OID> <pin した統合先 OID>` が成功する
  （worker が commit していない既定ケースはここで通る）
- **A の成立は「タスクの成果が統合された」ことの証明ではない。** no-commit 運用では、
  成果を host-finalize した後の worktree も、成果を破棄・reset しただけの worktree も、
  同じく「clean かつ baseline HEAD」になる。A が証明するのは
  **「この worktree に未統合の成果は残っていない」**ことだけである。
  evidence 名 `clean-head-reachable` と §74.3 の文言はこの限界を反映しなければならず、
  「統合済み」と主張してはならない。

**B. patch 等価 + 補強（A が不成立の場合のみ評価する）**

まず次の2つの commit 集合を別々に取得する（**混同しないこと**）。

- `M = git rev-list --merges <統合先>..<worktree HEAD>` … ブランチ側の **merge commit**
- `N = git rev-list --no-merges <統合先>..<worktree HEAD>` … ブランチ側の **非 merge commit**

そのうえで次の3条件を**すべて**満たすこと。1つでも欠ければ B は成立しない（A も不成立なら行12の veto）。

1. **`M` が空である。** `git cherry` は merge commit を評価しないため、
   merge commit が残るブランチは patch 等価では判断できない
2. `git cherry <統合先> <worktree HEAD>` の出力に `+` 始まりの行が**1つも無い**
3. **`N` が触れたパスに限定した** `git diff --quiet <統合先> <worktree HEAD> -- <paths>`
   が差分なしを返す。パスは `git diff-tree -r --no-commit-id --name-only -z <N の各 commit>`
   のように **NUL 区切り**で列挙し、重複を除いて渡す
   （patch-id は空白の扱いが異なる変更を同一視するため、内容の一致を別途確認する）

- **`N` が空の場合（＝ブランチ側に非 merge commit が無い）は条件3を評価しない。**
  パス集合が空のまま `git diff -- ` を実行すると**ツリー全体の比較になり**、
  統合先の無関係な変更で必ず誤 veto になる。`N` が空かつ `M` が空なら
  条件1・2は自明に満たされ、A が成立していたはずなので、この経路には到達しない。
- 条件3で差分が出る場合、統合先が後からそのパスを触っていた可能性もあるが、
  この経路は「A が不成立」の狭いケースにしか到達せず、誤 veto は
  オーケストレーターの手動 archive で解消できる安価な失敗である。
- **条件3をゲートの主判定に使ってはならない。** B の補強としてのみ使う。

#### 74.2.3 probe の実行制約

git の実行は `packages/supervisor/src/handoff-git-evidence.ts` の hardened executor と
**同等以上**の制約を満たすこと。**cwd は task body 由来の外部入力**であり、
その先のリポジトリ設定も信頼できない前提で扱う。

- `execFile` を使い `shell: false`。ユーザー入力を shell へ渡さない
- `--no-optional-locks` と `-c core.fsmonitor=false` を付ける
- **`git diff` 系には `--no-ext-diff` と `--no-textconv` を必ず付ける。**
  リポジトリ設定の external diff driver / textconv フィルタは
  **supervisor のホスト権限で任意コマンドを実行させ得る**
- **パス指定は `--literal-pathspecs` と `--` セパレータを用いる**（pathspec magic を無効化する）
- git 関連の環境変数を無害化する（`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
  `GIT_EXTERNAL_DIFF` / `GIT_CONFIG*` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` などを
  継承させない）
- timeout と maxBuffer を必ず設定する（参考値 5s / 256KB）
- porcelain の判定は
  **`git status --porcelain=v1 --untracked-files=all --ignore-submodules=none`** の出力が非空かどうか。
  `--untracked-files=all` は必須である。`--porcelain=v1` 単独では
  リポジトリ設定 `status.showUntrackedFiles=no` を尊重してしまい、
  **未追跡の成果物を clean と誤判定する**（実 incident の成果物は未コミット・未追跡だった）。
  `git diff` で代用してはならない。
- **status の出力が maxBuffer を超えた場合は `dirty` として扱う**（行9の veto）。
  観測不能扱いにしてはならない。差分が大きいほど防御が外れることになるため。
  出力全体を保持する必要は無く、最初の1レコードが得られた時点で dirty と判定してよい。

##### 74.2.3.1 終了コードの解釈（「期待される非ゼロ」を失敗と混同しない）

参照実装の executor は非ゼロ終了を一律 `ok:false` として扱うため、そのまま再利用すると
**正常な判定結果が `unobservable:probe-failed` に化ける**。コマンドごとに次を定義すること。

| コマンド | 0 | 1 | その他 / signal / timeout |
|---|---|---|---|
| `merge-base --is-ancestor` | 祖先（A 成立） | **祖先でない**（B の評価へ） | 行8 |
| `diff --quiet` | 差分なし（条件3 成立） | **差分あり**（条件3 不成立） | 行8 |
| `symbolic-ref` | 解決 | **未解決**（次の候補へフォールバック） | 行8 |
| `rev-parse --show-toplevel` | 正規化成功 | **行2**（非 git / bare 等） | 行2 |
| `status --porcelain` | 出力で判定 | 行8 | 行8（ただし maxBuffer 超過は行9 dirty） |
| `rev-list` / `cherry` / `diff-tree` | 出力で判定 | 行8 | 行8 |

行番号は §74.2 の決定表を指す。**「1」の欄が veto 以外になっているコマンドは、
その終了コードを probe 失敗として扱ってはならない。**

### 74.3 理由文の機械化

- 適用イベント `steward_auto_archive` の payload に `integrationEvidence` を必ず載せる。
  値は §74.2 の enum のみ。
- **board から見える `reason` は `integrationEvidence` から機械的に生成した文字列でなければならない。**
  現行実装は判断 session の `proposal.reason` をそのまま永続化しているため、
  `integrationEvidence=not-observable:repo-root` と `reason="main へ統合済み"` が同居し得る。
  判断 session の自由文を board 可視の統合主張に用いてはならない。
  診断用に保持する場合は `reason` とは別のキー（例 `proposalReason`）へ置き、
  board 表示・通知の統合主張には使わない。
- **文言は evidence ごとに事実と一致させる。**「統合済み」と表示してよい値は無い。

| integrationEvidence | board 可視の文言（趣旨） |
|---|---|
| `clean-head-reachable` | **worktree は clean で、未統合の成果は残っていない**（成果が統合されたことの証明ではない） |
| `clean-patch-equivalent` | worktree は clean で、ブランチの commit は統合先と patch 等価かつ内容一致である |
| `not-observable:repo-root` | **repo root 直下の作業のため worktree 単位で統合を観測できない**（repo root は clean だった） |
| `not-observable:repo-root-dirty` | **repo root 直下の作業のため観測できない。かつ repo root に未コミットの変更があった** |
| `not-observable:worktree-missing` | worktree が既に存在せず統合を確認できない |

- **`clean-patch-equivalent` を `clean-head-reachable` と同じ値にしてはならない。**
  B の経路では HEAD は統合先へ到達して**いない**（patch 等価で通している）。
  同一視すると監査証跡が事実に反する。

- **`clean-head-reachable` / `clean-patch-equivalent` を「統合済み」と表示してはならない。**
  §74.2.2 A のとおり、成果を破棄した worktree も同じ観測結果になる。
- **`not-observable:*` で archive したものは計数し、可視化する。**
  §40.5 の steward 実行結果と §48 の朝夕ブリーフに
  「統合を観測せずに archive した件数」を evidence 別に出す。doctor にも直近の件数を表示する。
  本節の事故は「board が統合済みに見えた」ことで起きたため、
  観測できないまま archive したこと自体が後任から見える必要がある。

- veto 側の evidence（`unobservable:*` / `unintegrated:*`）は archive を適用しないため、
  適用イベントには現れない。§74.4 の veto イベントに記録する。

### 74.4 veto の記録・冪等・再観測

- veto は**専用イベント**として記録する（例 `steward_auto_archive_vetoed`）。
  payload に `integrationEvidence` と `integrationTarget` を含める。
  `integrationTarget` は**判別可能な構造**とする:
  `{ state: "resolved", ref, oid }` または `{ state: "unresolved", reason }`。
  `unobservable:no-cwd` / `unobservable:no-integration-ref` では pin した統合先が
  定義上存在しないため、欠落値や架空値を入れてはならない。
- **ゲートの評価そのものは、archive 提案を検討するたびに必ず実行する。**
  抑止するのは**重複イベントと通知だけ**である。evidence は probe しなければ決まらないため、
  「イベントがあるから probe を省く」設計にすると、24h 以内に dirty → clean へ変わった
  （＝統合された）タスクを永久に archive できなくなる。
- 重複抑止のキーは `(taskId, integrationEvidence)`、窓は既存の 24h 冪等窓と同じとする。
  同一タスク・同一 evidence の veto イベントと通知は窓内で1回に畳む。
  evidence が変われば（例 `unintegrated:worktree-dirty` → allow）窓内でも新たに処理する。
- veto したタスクへは**同 tick で他の提案を適用しない**（§64.2 に倣う）。
  `applyProposals` は提案を逐次処理するため、**提案をタスク単位にまとめ、
  archive の最終ゲートが確定するまで同一タスクへの全 mutation を保留する。**
  loop 前の事前判定だけでは足りない: 事前は allow でも適用直前の再観測で veto になる場合があり、
  archive 提案が末尾にあると先行する promote / spec-lint が既に適用済みになってしまう。
- **loop 前の判定を archive の適用根拠にしてはならない。** loop 前の probe から実際の遷移までの間に、
  worktree が dirty 化・commit 追加され得るほか、統合先 ref の force-update / 付け替えも起こり得る。
  **archive を適用する直前に §74.2 のゲート全体を再評価し、
  §74.2.0 で確定した `worktreeIdentity`、§74.2.1 で pin した統合先 ref 名 / OID、
  worktree HEAD OID、porcelain が いずれも一致することを確認する。**
  **一致しなかった場合は決定表の行13（`unobservable:observation-drift`）として veto する。**
  検出しただけで evidence を残さない実装にしてはならない。
  記録する `integrationEvidence` は**再評価の結果**とする。
  loop 前の結果は「どのタスクを veto 対象として扱うか」の順序制御にのみ使う。

### 74.5 必須テスト

- §74.2 の決定表の**全13行**を表駆動で網羅する（fixture JSON + pure 決定表。
  `steward-done-consistency` のテスト構成に倣う）。
- 実 incident 同型: cwd が linked worktree・porcelain 非空 → archive されないこと。
- **`status.showUntrackedFiles=no` が設定されたリポジトリで、未追跡の成果物がある worktree が
  dirty と判定されること**（設定非依存であることを明示的に検証する）。
- **`cwd:` 行が無い done タスクは veto され、`unobservable:no-cwd` が記録されること。**
- **cwd が repo root の done タスクは、repo root が dirty でも probe せず allow され、
  文言が「worktree が無い」ではなく repo root 由来であること。**
- **パス不在は `stat` で確認できた場合のみ allow され（行5）、確認に失敗した場合は行2の veto になること。**
- worker が commit を残し統合先に入っていない → archive されないこと。
- **cherry-pick / rebase で統合された（patch 等価かつ内容一致）ブランチ → veto されないこと。**
- **merge commit を含む clean なブランチで、merge 由来の内容が統合先に無い → veto されること。**
- **空白の扱いだけが異なる変更（patch-id は一致するが内容は異なる）→ veto されること。**
- **ブランチ側の非 merge commit が空でパス集合が空になる場合に、
  ツリー全体比較へ退行して誤 veto しないこと。**
- `origin/HEAD` が `origin/develop` を指す構成で、ローカル `main` にしか無い commit が
  「統合済み」と扱われないこと。
- ローカル `main` が遅れており `origin/main` にのみ統合されている → veto されないこと。
- **`symbolic-ref` の未解決（exit 1）が probe 失敗ではなく次候補へのフォールバックになること。**
- **`merge-base --is-ancestor` の exit 1 と `diff --quiet` の exit 1 が
  `unobservable:probe-failed` に化けないこと。**
- clean かつ厳密に到達可能 → 従来どおり archive され、
  `integrationEvidence=clean-head-reachable` が載ること。
  **その文言が「統合済み」を主張していないこと。**
- **`not-observable:*` で archive した件数が §40.5 の実行結果に evidence 別で計上されること。**
- **`integrationTarget` が `unobservable:no-cwd` / `unobservable:no-integration-ref` では
  `state:"unresolved"` になり、架空の ref/OID が入らないこと。**
- **worktree HEAD が判定コマンドの合間に進んだ場合、pin した OID との不一致を検出して
  archive を適用しないこと。**
- **事前判定 allow → 適用直前の再観測 veto となる場合に、archive 提案が末尾にあっても
  同一タスクの promote / spec-lint が適用されないこと**（mutation 保留の検証）。
- **§74.2.0 の正規化**: 非 git ディレクトリ / 通常ファイル / bare リポジトリ /
  権限エラーの各 cwd が行2（`unobservable:cwd-not-a-worktree`）になること。
- **リポジトリのサブディレクトリを cwd に指定した done タスクが、
  toplevel へ正規化されて linked worktree として扱われること**（別扱いにしないこと）。
- **canonical worktree root 配下でない不存在パスを cwd に書いても
  行5の allow へ逃げられないこと**（行6の veto になること）。
- **repo root が dirty な場合に `not-observable:repo-root-dirty` が記録され、
  clean な場合と evidence が区別されること。**
- **B 経路（cherry-pick / rebase 統合）で allow したとき、evidence が
  `clean-patch-equivalent` であり `clean-head-reachable` ではないこと。**
- **判定途中で HEAD / 統合先 ref / porcelain が変化した場合に
  `unobservable:observation-drift` で veto されること**（検出のみで evidence 欠落にしない）。
- **統合先 ref が1つも解決できない → veto かつ `unobservable:no-integration-ref`。**
- **git probe の失敗・timeout → veto かつ `unobservable:probe-failed`（tick を落とさない）。**
- **status が maxBuffer を超えるほど dirty な worktree → `unintegrated:worktree-dirty` で veto されること
  （`unobservable:probe-failed` に倒れないこと）。**
- **セキュリティ回帰**: `diff.external` / textconv フィルタ / 悪意ある pathspec を仕込んだ
  リポジトリを cwd に与えても、外部コマンドが実行されないこと。
- **判断 session が `reason="統合済み"` を返しても、board 可視の reason が
  `integrationEvidence` 由来に置換されること**（矛盾する proposal を意図的に与えるテスト）。
- **veto 冪等**: 同一 `integrationEvidence` の veto イベント・通知が窓内で1回に畳まれること。
  かつ **24h 以内の dirty → clean 遷移で archive が適用されること**
  （＝ゲート評価自体は毎回走ること）。
- **提案順序**: 同一タスクへ archive 提案が先頭にある場合と末尾にある場合の両方で、
  veto 時に promote / spec-lint が適用されないこと。
- **再観測**: loop 前は clean だった worktree が archive 直前に dirty 化した場合、
  archive されず `unintegrated:worktree-dirty` が記録されること。
  **統合先 ref が loop 前と適用直前で OID が変わっていた場合も再評価が効くこと。**
- 既存の 24h 冪等・dry-run・kill-switch・cadence・§64.2 done-consistency veto は非回帰。

### 74.6 本節の限界（意図的に扱わない範囲）

- **本節は事故防止（safety）であって、敵対的 worker に対する防御（security）ではない。**
  worker は同じ git common-dir へ書き込めるため、`origin/HEAD` や `origin/main` を
  付け替えれば到達性判定を通せる。OID の pin は観測後の変化を検出するだけで、
  ref の真正性を証明しない。
  host 所有の publication / integration attestation を正本にする設計は**別契約とする**
  （本節はそれが入るまでの間、誤操作・stale orchestrator による成果喪失を止める）。
- **`not-observable:*` は「統合されていない可能性を残したまま archive した」ことを意味する。**
  これを allow にしているのは board を詰まらせないためであり、
  安全だからではない。§74.3 の計数・可視化がその代償である。
- **git 観測と DB 遷移の間のレースは完全には塞げていない。** §74.4 の再観測は
  最終 git コマンドと `store.transition` の間の変化を検出できない。
  完全に塞ぐには host 所有の worktree fence を遷移中も保持する必要があり、本節では扱わない。
  行13（`unobservable:observation-drift`）は窓を狭めるが、無くすものではない。
- **`clean-head-reachable` / `clean-patch-equivalent` は成果の統合を証明しない**（§74.2.2 A）。
  タスク成果と main の対応を検証するには launch/finalize 時の差分 snapshot か
  成果 fingerprint が要るが、現状 done タスクからは run 行を引けないため本節では扱わない。

## 75. Runtime generation 中断分類（A0）

目的: worker/reviewer の valid な構造化結果が無いまま runtime generation が中断した事象を、
worker 自身の出力欠落と推測せず、exact launch binding と同じ generation の durable terminal transition が
揃った場合だけ machine reason `runtime_generation_interrupted` として分類する。本節は分類契約だけを定め、
process の停止、restart、auto-retry、auto-ready、usage/context guard、child reap の方式は変更しない。

### 75.1 Runtime generation identity と launch binding

runtime owner は run launch 時に、secret を含まない次の versioned identity を durable に bind する。

```ts
type RuntimeGenerationIdentityV1 =
  | {
    kind: "direct-process";
    generationId: string;
    runtimeModelId: string;
    ownerPid: number;
    ownerPgid: number;
    ownerProcessStart: string;
    spawnNonce: string;
  }
  | {
    kind: "hachi-owned-native-server";
    generationId: string;
    runtimeModelId: string;
    serverPid: number;
    serverProcessStart: string;
    spawnNonce: string;
    endpointIdentityHash: string;
  }
  | {
    kind: "external-shared-runtime";
    generationId: string;
    runtimeModelId: string;
    modelReadbackSource: "codex-applied-model" | "claude-runtime-model";
    writerPid: number;
    writerProcessStart: string;
    runtimePid: number;
    runtimeProcessStart: string;
    bootNonce: string;
    endpointIdentityHash: string;
    startedAt: number;
  };

interface RuntimeGenerationBindingV1 {
  version: 1;
  taskId: string;
  runId: number;
  sessionId: string;
  role: "worker" | "reviewer";
  provider: "codex" | "claude";
  transport: "bridge" | "direct";
  runtimeKey: string;
  identity: RuntimeGenerationIdentityV1;
  boundAt: number;
}
```

- `runtimeKey` は canonical endpoint / owner lane を表す固定識別子とし、credential を含む URL、token、
  process env を保存しない。Unix socket identity は endpoint substitution veto に使えるが、socket inode 単独を
  process generation とみなさない
- `direct-process` は run ごとに spawn した owner の PID、fresh readback した PGID、OS process start identity、
  spawn nonceを必須とする。`hachi-owned-native-server` は Hachi owner が受けた exact child PID、OS process start
  identity、spawn nonce、endpoint identityを必須とする。`external-shared-runtime` は external writer 自身と
  実 runtime の双方について PID + OS process start identityを持ち、writer発行のgeneration/boot nonceと
  endpoint identityを必須とする
- variant は実際の runtime owner topology から1つだけ選ぶ。provider/transport名だけから variant を推測したり、
  別 variant の欠測 fieldを省略して代用したりしない。variantの未知値、必須 field の空値・非正値、
  `runtimeModelId` 欠測は binding 全体を invalid とする
- `runtimeModelId` は runtime から readback した実効 model identity であり、§49 の task指定値や未解決の
  `model_override` をそのまま写した値ではない。model自体は停止原因の証拠ではないが、launch identityの
  完全一致に必須とする
- binding は exact current run/session/role/provider/transport と launch 成功を確定する同じ CAS 境界で保存する。
  terminal 観測時の PID、`updatedAt`、診断文から遡って生成してはならない

本節の runtime generation は、§55 の orchestrator session generation、§56 の lease fence/execution generation、
§57.5 の事後回復用 `processGeneration` 文字列とは別の identity である。これらを相互に流用しない。

### 75.2 Durable terminal transition

runtime owner / host observer は、launch binding と独立に次の transition を durable に記録する。

```ts
interface RuntimeGenerationTransitionV1 {
  version: 1;
  runtimeKey: string;
  identity: RuntimeGenerationIdentityV1;
  kind: "stopped" | "replaced";
  exitCode?: number;
  signal?: string;
  lastSeenAt: number;
  stoppedAt?: number;
  replacementIdentity?: RuntimeGenerationIdentityV1;
  replacementFirstSeenAt?: number;
  source: "owner-wait" | "host-supervisor" | "endpoint-observer";
}
```

- `stopped` は同じ identity の lifecycle を owner wait または host supervisor が確定し、`stoppedAt` を
  持つ場合だけ valid とする。PID 消滅だけ、status文字列だけ、`updatedAt`だけでは成立しない。
  `exitCode` / `signal` は得られた場合の補助情報であり、欠測を推測で補わない
- `replaced` は同じ observer の連続 snapshot で旧 identity の `lastSeenAt` と消滅を確認し、その後に完全な
  `replacementIdentity` と `replacementFirstSeenAt` を初めて観測した場合だけ valid とする。observer gap、
  read failure、新 generation の出現単独は `unknown` である
- binding と transition は `runtimeKey`、`identity.kind`、variant別の全必須 fieldを byte-for-byte / scalar exact
  matchする。両側で同じ field が欠測していても一致ではない。PID単独、process start単独、nonce単独、
  free-text diagnostic、同時刻に失敗したrun数を exact evidenceへ昇格しない
- `replacementIdentity` は旧 identity と異なる完全な identity でなければならない。PID reuse は OS process start
  identityとnonceの不一致により別 generation として扱う
- durable evidence の storage envelope は schema version、source観測時刻、保存時刻、有限の source TTL / expiryを
  持つ。schema不正、redaction違反、TTL欠測・期限切れ、時刻逆転は invalid とする。source TTL は §75.3 の
  30秒相関窓と別物であり、受理済み durable record の保持期間を30秒に制限する意味ではない

external shared writer の authority、exact file/path、schema owner は実装 task の ready 前に host 側の現物から
固定する。本節はそれらを推測して決めない。authority を固定できない external evidence は
`external-shared-runtime` の confirmed evidenceとして受理しない。

### 75.3 `runtime_generation_interrupted` の発行 predicate

worker/reviewer 共通 classifier は、次の conjunction が**すべて**真の場合だけ
`runtime_generation_interrupted` を発行する。unknown はすべて false とする。

1. taskの exact current open run、session、role、provider、transport と §75.1 の launch binding が一致する
2. 対象出力に valid な構造化 handoff / verdict が存在しない。valid fenceは outcome / verdict内容にかかわらず
   本分類で上書きしない
3. 現行分類なら `worker_output_missing` となる terminal failure、または runtime transport close を表す
   versioned structured diagnostic code がある。前者は `worker_output_missing` 自体を machine code として扱い、
   free-text の部分一致、短いrun duration、zero-token単独は structured diagnosticの代わりにしない
4. transition の `runtimeKey` と完全な `identity` が §75.2 の規則で binding に exact matchする
5. `stopped` の点区間 `[stoppedAt, stoppedAt]`、または `replaced` の閉区間
   `[lastSeenAt, replacementFirstSeenAt]` が、分類時点までの exact run 生存区間と交差する
6. terminal/close の durable 観測時刻から前項の transition区間までの最短距離が
   **30,000ms以下**である。30秒は保存incidentで観測された10〜12秒にobserver/scheduler jitterを加えた
   false attribution抑制用の相関上限であり、単独の因果証拠、待機時間、TTL、retry delayではない
7. binding、transition、diagnostic、保存payloadが versioned schema、redaction、有限TTL/expiryの検証を通る

同じ generation に exact bindされた複数 run が同じ30秒窓で失敗した場合は、検証済みrun IDを
`correlatedRunIds` として補強情報にできる。ただし単一runでも1〜7を満たせば分類でき、複数runの時刻近接を
4〜7の代替にはしない。

分類結果は少なくとも次の fixed field を versioned event / run metaへ保存する。

```json
{
  "version": 1,
  "reason": "runtime_generation_interrupted",
  "taskId": "t_...",
  "runId": 1,
  "sessionId": "...",
  "role": "worker",
  "provider": "codex",
  "transport": "direct",
  "runtimeKey": "...",
  "generationId": "...",
  "transitionKind": "replaced",
  "terminalObservedAt": 0,
  "transitionObservedAt": 0,
  "deltaMs": 0,
  "diagnosticCode": "runtime_transport_closed",
  "correlatedRunIds": []
}
```

`transitionObservedAt` は `stopped` なら `stoppedAt`、`replaced` なら `replacementFirstSeenAt` とし、
`deltaMs` は §75.3.6 の最短距離を非負整数msで保存する。

payloadへ生 diagnostic、transcript、process env、credential、tokenを入れない。表示用 diagnostic が必要なら、
既存 comment境界と同じ redaction・長さ上限を通した別 fieldに限定する。

### 75.4 Unknown・互換性・既存分類との優先関係

- §75.3 の分類候補で binding / transition / time / model / schema / redaction / TTL のどれかが missing、
  mismatch、stale、unknownなら新理由を発行せず、既存 `worker_output_missing` と versioned
  `infraCorrelation.state="unconfirmed"` へ倒す。本節の候補外で既存 classifier が返す別理由は変更しない
- `infraCorrelation.state="unconfirmed"` は因果確定、stop証拠、replacement許可を意味しない。PID単独、
  `updatedAt`単独、free-text diagnostic、new generation出現単独、複数run相関だけの場合も unconfirmed とする
- generation bindingを持たないlegacy run/event/metaは現行どおり読み、現在の分類結果を変えない。
  version無しの既存recordをv1 bindingへ推定変換しない
- 本理由は §21.1 の reviewer `failureCause` ではなく、`worker_local` へ暗黙変換しない。新しいblock prefixや
  human queue laneを追加せず、worker/reviewerとも既存 `needs-manual:` の回収laneを維持する。
  auto-rework、auto-retry、auto-readyを発火しない
- §53.0 / §53.0.1 の valid handoff/verdict抽出を先に行い、構造化結果が無い terminal failureだけを本節へ渡す。
  既存のone-shot救済、Git evidence、archiveは新理由でも非回帰とし、trigger enumが必要なら additive に広げる
- §49〜§50 のmodel解決、transport選択、await/stall観測はcorrelation入力にはなり得るが、それだけでruntime
  interruptionを確定しない。§51 のage/tree heuristicやreap結果もlaunch binding / transitionの代替にしない

### 75.5 Run close・回収・replacement境界

- confirmed分類でもrunは現行 `worker_output_missing` と同じく一度だけ `failed` でcloseし、既存
  `needs-manual:` laneへ置く。分類処理自体はprocess signal、restart、cancel、resource cleanup、dispatchを行わない
- re-ready / rework / review再起動 / replacementの前に、正規read viewで同じtask/worktreeのopen runが0、
  §75.2のexact evidenceで旧 runtime identity が停止済み、worker/reviewer session bindingが解放可能であることを
  再確認する。`session_ended`、`worker_output_missing`、unconfirmed correlationだけでは解除しない
- runtime resourceの解放は§56のlease/member/cleanup fenceをすべて維持する。本分類やrun=`failed`だけで
  `unused`、ownership、cleanup eligibilityを真にせず、workerがrenew/release/cleanupを行わない
- active durable cancelがある場合は§57を優先し、exact-session stop再確認、cancel=`stopped`、run close、
  session/resource guard解放、replacementの順序と同一fenceを維持する。本分類をcancel ack/stop evidenceや
  `cancel-host-stop` attestationへ流用せず、cancel=`failed|expired`でもreplacement gateを開けない
- cancelが無い自然なruntime interruptionでも、validな`stopped`または`replaced` transitionは旧 generationの
  消滅を分類する証拠に限る。§51のchild ownership/reap、§56のresource release、§57のreplacement gateを
  省略する権限を与えない

### 75.6 本節の実装外境界

- §75.1〜§75.5 は分類のA0契約を採択する。external shared writer の file/path/schema/authority と
  producer/consumer ownership は後続のA1-S契約（§75.7〜§75.13）で固定する。DB migration、host publication、
  process操作、restart、canaryはA1-Sでは実装しない
- usage/context sample・guard・threshold・cancel介入（B0/B1）と exact child ownership/reap（C0/C1）の方式、
  §51の既存heuristicは変更しない

### 75.7 External runtime generation status の path と authority（A1-S）

本節以降は `ExternalRuntimeGenerationStatusV1` の cross-repo wire 契約である。基準は hachi-kanban
`c942bffc93a9cbe078a2ad0466a6b6498e196efa` と legacy-hermes
`c6ef8492205d13b8eae32150118c9221401c584e` とし、provider/lane と canonical path を次の2行に固定する。

| provider | lane | `runtimeKey` | canonical status path | one-writer lifecycle authority |
|---|---|---|---|---|
| `codex` | `even-shared` | `external-shared-runtime/codex/even-shared` | `$HERMES_HOME/even-shared/external-runtime-generation-status.json` | `even-terminal start --provider codex` の exact process。`runtimePid` はその process が所有する Codex app-server child |
| `claude` | `even-claude` | `external-shared-runtime/claude/even-claude` | `$HERMES_HOME/even-claude/external-runtime-generation-status.json` | `even-terminal start --provider claude` の exact process。Claude SDK/session が同一process内なら `writerPid === runtimePid` を許す |

- `$HERMES_HOME` は producer と consumer の各host launchでP1が同じ値を配線するabsolute runtime rootであり、consumerが
  producer processのenv、cwd、argvから逆算する値ではない。A1-Hがrootを得る唯一のauthorityはhostがsupervisor launch時に
  注入したroot DIとする。`packages/supervisor/src/main.ts`だけが起動時にrootを一度resolveし、A1-H所有の新規
  `packages/supervisor/src/external-runtime-generation-root.ts`がvalidated canonical rootをbounded readerへconstructor injection
  する。reader/stage/core Storeは`process.env`を再読込せず、rootやpathを独自resolveしない
- root DIのprecedenceは、supervisor自身のhost-owned launch environmentに`HERMES_HOME` keyが存在する場合はその非空値、
  keyが存在しない場合だけhost OS account homeのreadbackに`.hermes-hachi-dev`をjoinしたdefaultとする。空文字、相対path、
  NUL/control文字、`.`/`..` component、重複separator、root以外の末尾separatorはinvalidでありdefaultへfallbackしない。
  hachi `config.json`、repository `.env`、task/body/run meta、status file、endpoint/response payload、producer envのprobe、近傍fileの
  scanをoverride/authorityにしない。custom producer rootを使うP1は同じcanonical valueをsupervisor launchにも明示配線し、
  欠測または不一致ならそのprovider/lane sampleを`unknown`とする
- resolver/readerはlexical normalize後のpathが入力とbyte-exactであることを要求し、filesystem rootから各existing componentを
  `lstat`/directory fd + `O_NOFOLLOW`相当で検証する。`realpath` readbackはlexical canonical valueとbyte-exactでなければならない。
  OS ancestryはrootまたは現在uid所有かつgroup/other非writable、`HERMES_HOME` rootからstatus fileのparentまでは現在uid所有を
  必須とし、symlink、非directory、owner/mode不一致、permission denied、raceならfail-closedとする。missing rootも別root探索や
  default再試行をせず`unknown`とし、起動後のenv変更ではDIを差し替えない
- status file は現在uid所有のregular file、mode `0600`、最大 `1 MiB` とする。file自身または途中componentの
  symlink、hard-link countが1以外、directory/device/FIFO/socket、owner/mode不一致を拒否する。lane directoryは
  mode `0700` とする
- writer は同じlane directory内のmode `0600`の一意なtemporary regular fileへ完全なJSON 1 documentを書き、
  file `fsync` → 同一filesystemのatomic replace → directory `fsync` の順でpublishする。status pathへのtruncate/
  in-place rewrite、別filesystemからのrename、symlink追従を禁止する。失敗時はlast-known-good fileを壊さず、
  その`expiresAt`超過によってconsumerを`unknown`へ倒す
- laneごとの短時間exclusive lockと既存statusのrevision CASでwriteを直列化する。lock待ち、既存JSON不正、
  revision競合、revision overflowでは上書きしない。同一laneに2つのlive lifecycle ownerを検出した場合も
  publishせず`unknown`とする
- live lifecycle ownerが存在する間は、そのinstrumented lifecycleだけが`running`をpublishする。owner自身の
  graceful exit hookまたはownerをwaitするhost wrapperはterminalをpublishできる。owner crash後のhost wrapperは、
  previous identity/revisionをexact matchできる場合だけ`stopped|unknown`を書けるが、PID消滅単独から`stopped`を作らず、
  dead ownerに代わって`running`を発行しない。この限定handoffも同じlock/revision CASを通す
- repository authorityは legacy-hermesだけである。hachi-kanbanはこの2ファイルをread-onlyで読み、自身の
  Storeへ検証結果を保存するだけで、作成・修復・chmod・削除しない。legacy-hermesの
  `scripts/kanban-shared-app-server.sh` と `scripts/kanban-claude-even-server.sh` がlane ownerを選び、installed
  even-terminal lifecycle patchがexact child/session readbackを発行する
- `$HERMES_HOME/even-shared/passthrough-patch-status.json` は§49.5のpatch適用/readiness専用であり、上表の
  statusとはpath・schema・writer責務が別である。`state`、`updatedAt`、`bridgePid`、LISTEN PID、doctor/readback、
  run meta統計をgeneration attestation、terminal transition、revisionの代用にしない

### 75.8 `ExternalRuntimeGenerationStatusV1` wire schema

JSONのnumberはすべて非負または正の`Number.isSafeInteger`、時刻はUnix epoch millisecondsとする。
`null`を示したfieldは省略せず、未知key、duplicate key、non-finite number、BOM、複数JSON documentを拒否する。

```ts
interface ExternalRuntimeGenerationIdentityV1 {
  kind: "external-shared-runtime";
  generationId: string;
  runtimeModelId: string;
  modelReadbackSource: "codex-applied-model" | "claude-runtime-model";
  writerPid: number;
  writerProcessStart: string;
  runtimePid: number;
  runtimeProcessStart: string;
  bootNonce: string;
  endpointIdentityHash: string;
  startedAt: number;
}

interface ExternalRuntimeGenerationAttestationV1 {
  version: 1;
  schemaHash: string;
  provider: "codex" | "claude";
  lane: "even-shared" | "even-claude";
  runtimeKey: string;
  statusRevision: number;
  state: "running";
  identity: ExternalRuntimeGenerationIdentityV1;
  observedAt: number;
  ttlMs: 180000;
  expiresAt: number;
}

interface ExternalRuntimeGenerationTransitionV1 {
  version: 1;
  revision: number;
  kind: "running" | "stopped" | "replaced" | "unknown";
  oldIdentity: ExternalRuntimeGenerationIdentityV1 | null;
  newIdentity: ExternalRuntimeGenerationIdentityV1 | null;
  lastSeenAt: number | null;
  stoppedAt: number | null;
  replacementFirstSeenAt: number | null;
  observedAt: number;
  ttlMs: 86400000;
  expiresAt: number;
  source: "owner-wait" | "host-supervisor" | "endpoint-observer";
}

interface ExternalRuntimeGenerationStatusV1 {
  schema: "external-runtime-generation-status/v1";
  schemaVersion: 1;
  schemaHash: string;
  provider: "codex" | "claude";
  lane: "even-shared" | "even-claude";
  runtimeKey: string;
  revision: number;
  state: "running" | "stopped" | "replaced" | "unknown";
  attestations: ExternalRuntimeGenerationAttestationV1[];
  transitions: ExternalRuntimeGenerationTransitionV1[];
  observedAt: number;
  ttlMs: 180000;
  expiresAt: number;
}
```

schema signatureは次のASCII 1行（末尾newlineなし）とし、そのSHA-256をstatus/attestationの
`schemaHash`へ `sha256:8b401504c7412dd865f97240995c4c38b59b7dbd8e813b88ccebf0f2c2f15208` として保存する。

```text
ExternalRuntimeGenerationStatusV1{schema=external-runtime-generation-status/v1;schemaVersion=u53:1;schemaHash=sha256;provider=enum(codex,claude);lane=enum(even-shared,even-claude);runtimeKey=string;revision=u53;state=enum(running,stopped,replaced,unknown);attestations=ExternalRuntimeGenerationAttestationV1[0..32];transitions=ExternalRuntimeGenerationTransitionV1[0..256];observedAt=epoch-ms;ttlMs=u53:180000;expiresAt=epoch-ms}|ExternalRuntimeGenerationAttestationV1{version=u53:1;schemaHash=sha256;provider=enum(codex,claude);lane=enum(even-shared,even-claude);runtimeKey=string;statusRevision=u53;state=literal(running);identity=ExternalRuntimeGenerationIdentityV1;observedAt=epoch-ms;ttlMs=u53:180000;expiresAt=epoch-ms}|ExternalRuntimeGenerationIdentityV1{kind=literal(external-shared-runtime);generationId=hex128;runtimeModelId=string;modelReadbackSource=enum(codex-applied-model,claude-runtime-model);writerPid=posint;writerProcessStart=os-start-v1;runtimePid=posint;runtimeProcessStart=os-start-v1;bootNonce=hex128;endpointIdentityHash=sha256;startedAt=epoch-ms}|ExternalRuntimeGenerationTransitionV1{version=u53:1;revision=u53;kind=enum(running,stopped,replaced,unknown);oldIdentity=ExternalRuntimeGenerationIdentityV1|null;newIdentity=ExternalRuntimeGenerationIdentityV1|null;lastSeenAt=epoch-ms|null;stoppedAt=epoch-ms|null;replacementFirstSeenAt=epoch-ms|null;observedAt=epoch-ms;ttlMs=u53:86400000;expiresAt=epoch-ms;source=enum(owner-wait,host-supervisor,endpoint-observer)}
```

- `revision` はlane fileの初回publishを1とし、heartbeatを含むatomic replaceごとに必ず1増やす。既存のvalid fileを
 読めない場合や最大safe integer到達時に0/1へ戻さない。attestationの`statusRevision`とtransitionの`revision`は、
  それぞれを初めてdurable publishしたstatus revisionで固定し、後続heartbeatで書き換えない
- `attestations` は同一runtime generationでruntimeからreadback済みの`runtimeModelId`ごとに最大32件とし、
  §75.11のcanonical JSONによるidentity byte列のunsigned byte lexicographic昇順に並べる。`transitions`は最大256件とし、
  `revision`の数値昇順、その中では`transitionKeyBytes = canonicalJson([kind, oldIdentity, newIdentity])`のunsigned byte
  lexicographic昇順に並べる。同じatomic publishで作る複数entryは同じ`revision`を持ってよく、一意keyは
  `(revision, transitionKeyBytes)`とする。この複合keyの重複、同順序keyで別payload、順序逆転をfile全体invalidとする。
  identity byte列と`transitionKeyBytes`はいずれもvalidation用のderived keyでありwire fieldへ追加せず、schema signature/hashを
  変更しない。
  unexpired entryをcapacity都合でevictせず、capacity超過時は新attestation/transitionを一部だけ発行せず、
  last-known-good fileを期限切れにして`unknown`へ倒す
- status/attestationは `expiresAt === observedAt + 180000`、transitionは
  `expiresAt === observedAt + 86400000` をexactに満たす。producerはrunning中60秒以下の間隔でstatusをheartbeatする。
  status/attestation TTLはlaunch readbackのfreshness、transition TTLはdurable terminal evidenceの保持期限であり、
  §75.3の30秒相関窓とは別の境界である。期限切れentryを新しい`observedAt`で再生しない

### 75.9 Identity、model、endpoint の生成規則

- `generationId` と`bootNonce` はそれぞれ32文字のlowercase hex（128-bit CSPRNG）とする。`bootNonce`はexact
  lifecycle owner processのbootごと、`generationId`は`runtimePid + runtimeProcessStart`が変わるたびに新規生成し、
  PIDや時刻だけから決定的に作らない。再起動、PID reuse、endpoint差替えで旧値を再利用しない
- `writerPid`は上表のexact even-terminal lifecycle owner、`runtimePid`は実際にprovider request/sessionを処理した
  runtime processである。Codexではmemory内`ChildProcess`として所有するapp-server childのPIDを使い、bridge PID、
  LISTEN PID、wrapper PIDで代用しない。Claude SDK/sessionがeven-terminal process内で動く現topologyでは両PIDが
  同値でもよいが、unused Codex app-server child（既定8766）をClaude runtimeとして記録しない
- `writerProcessStart` / `runtimeProcessStart` は `LC_ALL=C /bin/ps -p <positive-pid> -o lstart=` のtrim済み出力に
  `darwin-ps-lstart:` を前置した値とする。producerはpublish直前、consumerは受理直前に同じOS readbackを行い、
  空、複数行、control文字、PID不在、不一致を`unknown`とする。`startedAt`、elapsed time、PID単独はOS start identityの
  代替ではない
- `startedAt` はproducerが同じruntime PID/OS startを初めて完全にreadbackした時刻で、
  `startedAt <= observedAt <= expiresAt` を必須とする。clockを巻き戻して旧identityをfreshにせず、5秒を超える未来時刻は
  consumerが拒否する
- `endpointIdentityHash` はcredentialを含まないconsumer-visible bridge originから作る。canonical byte列は
  `external-shared-runtime/v1\0<provider>\0<lane>\0<lowercase-scheme>\0<WHATWG URL hostname>\0<decimal-port>`、
  値は `sha256:<64 lowercase hex>` とする。schemeは`http|https`、URLはuserinfo/query/fragmentなし、pathは`/`だけを
  許可し、`localhost`と`127.0.0.1`、IPv4とIPv6を同一視しない。producer/consumerが独立に算出したhashが一致しない
  endpointをexact evidenceにしない
- `runtimeModelId` は1〜200文字の`[A-Za-z0-9._:/@+-]`だけを許可し、configured/requested modelのechoを禁止する。
  Codexはそのexact app-server childの`threadStartFull` resultから得た`appliedModel` readbackだけを
  `modelReadbackSource="codex-applied-model"`で採用する。ClaudeはSDK/session初期化後に実runtimeが返すeffective model
  readbackだけを`modelReadbackSource="claude-runtime-model"`で採用する。task/profile/model override、request body、
  `HACHI_*MODEL`、allowlist、静的installed source inspection、delivery flagだけではattestationを発行しない

### 75.10 Producer state machine と durable transition

producerはstatus publishと同じrevision CASの内側で次を行う。`running`以外はlaunch attestationではなく、
`stopped|replaced`だけが§75.2へ投影可能なterminal evidenceである。

| kind | 必須 old/new identity | 時刻 | 意味 |
|---|---|---|---|
| `running` | `oldIdentity=null`、完全な`newIdentity` | `lastSeenAt/stoppedAt/replacementFirstSeenAt=null` | provider runtime readbackと双方のPID/OS startを同じgenerationで確認し、attestationを先にdurable publishした |
| `stopped` | 完全な`oldIdentity`、`newIdentity=null` | `lastSeenAt`と`stoppedAt`必須、他はnull | owner waitまたはhost supervisorがold lifecycleのterminalをexactに確定した |
| `replaced` | 相異なる完全なold/new identity | `lastSeenAt`と`replacementFirstSeenAt`必須、`stoppedAt=null` | gapのない同一observerがoldの最終観測、消滅、newの初回観測を順に確定した |
| `unknown` | last-known oldがあれば完全に保持、newは完全に証明できる時だけ保持 | 未確定時刻はnull | read/observer gap、owner競合、partial/mismatch等によりstopped/replacedを証明できない |

- `running` attestationはstatus fileへのatomic publish成功後にだけ `/api/prompt` 成功responseのadditive field
  `runtimeGenerationAttestation`として同じobjectを返す。session作成後にpublish/responseが欠けてもdirect fallbackや
  同一prompt再送を行わず、hachiはbindingなしのlegacy/unconfirmed経路へ倒す
- producerは成功したlaunchごとにactual model readbackを取り、同じ`runtimeModelId`の既存entryがあっても新しい
  `statusRevision/observedAt/expiresAt`を持つattestationへ置き換えてからresponseを返す。これはlaunch attestationの
  renewalであってheartbeatではない。同じgeneration/modelの`running` transitionは初回だけappendし、renewalごとに
  terminal historyを増やさない
- heartbeatはrevisionとstatusの`observedAt/expiresAt`だけを更新し、既存attestationの発行時刻、identity、
  transition時刻を変更しない。同一generationで別model readbackを得た場合は同じprocess fieldsと新しい
  `runtimeModelId/modelReadbackSource`を持つattestationをappendする
- stopped/replaced/unknownへ移る時は、lock取得後のCAS snapshotで対象generationのcurrent attestationを全件captureする。
  generationの同一性はenclosing provider/lane/runtimeKeyに加え、identityの`generationId/writerPid/writerProcessStart/runtimePid/
  runtimeProcessStart/bootNonce/endpointIdentityHash/startedAt`のscalar exact matchで決め、`runtimeModelId`と
  `modelReadbackSource`だけをmodel別subjectとして除外する。各captureからexact copyした`oldIdentity`を1件ずつ使い、
  model名やarray indexからold identityを補完・対応付けしない
- state-change batchは1つのkindと1つのnext status revisionを持つ。`stopped`の`newIdentity`は全件null、`replaced`は同じgap-free
  observationで完全に証明したnew generation identity群のうち§75.8のidentity byte列が最小の1件をreplacement anchorとし、
  全entryの`newIdentity`へそのexact copyを置く。`unknown`は同規則で完全に証明できるanchorがある場合だけ全件同じanchorを置き、
  それ以外は全件nullとする。候補identityがpartial/mismatchなら`replaced`を発行せず`unknown`へ倒す
- producerは同じCAS内で、capture全件に同じnext revisionのtransitionを作成し、§75.8の複合key順にappendし、capture全件を
  current `attestations`から除き、top-level `revision/state/observedAt/expiresAt`を更新した完全payloadを1回だけatomic publishする。
  transitionだけの先行publish、attestation除去だけの先行publish、modelごとの分割revision、batchのsubset成功を禁止する。
  publish失敗/競合/capacity超過時は全変更を破棄してlast-known-goodを保ち、fresh CASから全batchを再試行する以外の縮退をしない。
  成功済みbatchのold identityは後続revisionで再consumeせず、identityはtransition TTL中保持する。新generationのrunning
  publishはvalidなterminal transitionを消さない
- owner wait/host supervisorのexact terminal resultが無くPID消滅だけを見た場合、observer gap、新generation単独、
  endpoint probe failure、unknown modelでは`unknown`にする。unknownから後でnew generationを完全観測しても、欠測区間の
  stopped/replacedを遡及生成せず、新しい`running`として始める
- state/field組合せ不正、revision非単調、old/new exact match不成立、同一identityのreplaced、時刻逆転、unexpired history欠落は
  file全体をinvalidとする。producer/consumerともfree-text、PID単独、`updatedAt`、patch statusから修復・補完しない

### 75.11 Hachi bounded reader、replay防止、launch CAS

- A1-H readerは上表のallowlist pathを`O_NOFOLLOW`相当で1回openし、`fstat`でregular/owner/mode/link count/1 MiB上限を
  検証してEOFまで最大1 MiBだけ読む。pathの事前`lstat`とopen後inode/devが変わる、read/parseが失敗する場合はretryで
  意味を推測せず、そのsampleを`unknown`とする
- schema literal/version/hash、provider/lane/runtimeKey、全field/array上限、TTL、時刻、redaction、status stateをすべて
  検証する。launch attestationはstatus/attestationの`observedAt`が5秒超未来、`now > expiresAt`、current writer/runtimeの
  OS process startまたはendpoint hashのfresh readback不一致なら保存しない。terminal old identityは停止済みであるため
  live PID readbackを要求せず、durable bindingとのexact match、transition自身のTTL/source/時刻で検証する。`replaced`の
  new identityをcurrent launchへ使う場合だけnew PID/OS startとendpointをfresh readbackする。top-level statusが期限切れでも、
  schema/revisionがvalidでtransition自身がunexpiredならterminal evidenceを期限切れ扱いしない
- Storeはprovider/laneごとにhighest accepted `revision`とcanonical payload SHA-256をdurableに持つ。digest対象はraw file bytes
  ではなく、UTF-8をfatal decodeし、BOM/duplicate key/unknown key/型・範囲・schema・配列順序をすべて拒否した後のvalidated
  `ExternalRuntimeGenerationStatusV1`全体を次のcanonical JSONで再encodeしたbyte列だけとする。response attestation単体、path、
  inode、mtime、raw whitespaceをhash対象へ混ぜない
  - object keyは各階層でkeyのUTF-8 byte列によるunsigned byte lexicographic昇順、arrayはvalidated wire順を保持する。
    `{}`/`[]`、`,`、`:`以外のwhitespaceを出さず、末尾newlineを付けない
  - numberはvalidated non-negative safe integerをASCII最短10進（zeroは`0`、sign/小数点/exponent/先頭zeroなし）で出す。
    `null`/`true`/`false`はそのlowercase ASCII literalとする
  - string/keyはUnicode scalar value列として扱い、unpaired surrogateとcontrol文字をvalidationで拒否する。Unicode normalizationは
    行わず、全体をASCII `0x22`で囲み、内部のU+0022を`0x5c 0x22`、U+005Cを`0x5c 0x5c`へescapeする。
    `/`その他のscalar valueはescapeせずUTF-8で出し、入力時の`\u`表記差はdecoded scalarへ畳み込む
  canonical byte列のSHA-256は`sha256:<64 lowercase hex>`とする。小さいrevisionはreplay、同revisionで別のvalid canonical
  digestはequivocationとして拒否し、同revision・同digestだけidempotent readを許す。raw key順/whitespace/number/escape表記だけが
  違ってもvalidated valueが同じvalid fileは同digestになる。§75.8に反するarray順はdigest比較前にinvalidとして拒否し、
  array順を含む全validationを通った別のsemantic valueは別digestになる。大きいrevisionでもgeneration/boot/process/provider/lane
  mismatch、history欠落を正当化しない
- dispatch/reviewer launchはresponseの`runtimeGenerationAttestation`とstatus内の同一attestationまたはunexpired transitionの
  identityをscalar exact matchする。responseだけ、fileだけ、`appliedModel`だけではbindしない。validなobjectだけを
  exact task/run/session/role/provider/transport、launch成功と同じStore CASへ渡し、§75.1の
  `RuntimeGenerationBindingV1.identity`として保存する。status TTLはCAS時に検証し、CAS後のdurable binding自体の保持期限には
  しない
- terminal readerはtransitionの`oldIdentity`を§75.2の`identity`へ、`newIdentity`を
  `replacementIdentity`へ投影する。`running|unknown`、期限切れ、replay、stale、partial-write、provider/lane/path mismatch、
  current bindingと1 fieldでも不一致なら`infraCorrelation.state="unconfirmed"`と既存`worker_output_missing`へ倒す
- missing fileはproducer未deployまたは未観測として`unknown`であり、legacy runをv1へ推定変換しない。unknownはlaunch成功、
  stop、replacement、retry、auto-ready、resource releaseの証拠ではない。prompt side effect後のattestation欠測時もat-most-onceを
  守り、direct fallbackしない
- status/attestation/transitionにendpoint URL、host、port、token、credential、argv、env、cwd、home path、task本文、transcript、
  email/user名、free-text diagnosticを保存しない。schema許容外keyまたはcontrol文字をredactionで救済して受理せず、
  record全体を拒否する。
  event/commentへ出す場合は固定codeとhash先頭12文字までに限定し、既存`redactText`を最終文字列へ適用する

### 75.12 A1-E / A1-H ownership と acceptance

A1-Sのhost-finalize後にだけA1-EとA1-Hを並列ready化できる。片方の実装がもう片方のrepository fileを変更してはならない。

- **A1-E（legacy-hermes producer）**: `scripts/kanban-shared-app-server.sh`、
  `scripts/kanban-claude-even-server.sh`、`scripts/lib/external-runtime-generation-status.sh`、
  `patches/even-terminal-model-passthrough/`のapply/verify/self-test/manifest/escrowを所有する。Codex child lifecycleを得るため、
  現v6に無いinstalled `dist/startup/common.js` / `dist/startup/instance.js`をescrowのcomplete file setへ加える場合もA1-Eだけが
  所有する。path/schema/atomic writer、Codex child replace、Claude effective model readback、全4 state、revision/TTL/permission/
  replay fixtureをproducer self-testで証明する
- **A1-H（hachi-kanban consumer）**: `packages/adapters/src/session.ts`のadditive response parse、
  `packages/core/src/db.ts` / `readview.ts` / `index.ts`と新規
  `packages/core/src/external-runtime-generation.ts` Store module、
  `packages/supervisor/src/main.ts`のhost root配線、新規`packages/supervisor/src/external-runtime-generation-root.ts`のroot authority/DI、
  `packages/supervisor/src/external-runtime-generation-reader.ts` bounded reader、
  `packages/supervisor/src/stages/dispatch.ts` / `review.ts`のlaunch binding CAS、
  `packages/supervisor/src/stages/finalize.ts`のclassifier、および同居testだけを所有する。必要なDB migration、reader DI、
  worker/reviewer両role、Codex/Claude両lane、replay/stale/partial/mismatch/unknown/legacy/at-most-once fixtureを含める。
  凍結共有契約`packages/core/src/types.ts`を変更せず、専用interfaceを新moduleに置く
- cross-repo offline fixtureは、同一generationに2以上のmodel attestationを持つ`stopped|replaced|unknown`各batchが単一revision・
  derived key順・全件除去でpublishされる例と、同じvalidated payloadに対するraw key順/whitespace/number/escape表記違いを含める。
  A1-E/A1-Hは同じcanonical byte列と固定`sha256:<64 lowercase hex>`をassertし、duplicate/unknown keyとarray順違いはinvalid、
  validationを通る同revisionのsemantic value違いはequivocationとしてassertする。A1-Hはさらにroot DIのoverride/default precedence、
  custom root一致、empty/relative/symlink/owner/mode/permission/missingのfail-closedをfixtureで固定する
- A1-Eはhachi DB/task/runを読まず、A1-Hはexternal statusをwrite/repairしない。schema/path変更は片repoだけで先行せず、
  本節のschema version/hashを更新する新しいcontract adoptionを先にhost-finalizeする

### 75.13 Publication gate

A1-E/A1-Hのunit/self-testとcross-repo fixture合格はdeployment authorityではない。installed even-terminal escrow適用、
LaunchAgent/plist/config変更、status writerのlive配置、bridge/processのstop・restart、production observation、live canary、
rollback実行はすべてP1の人間承認gateに残す。A1-S/A1-E/A1-Hのworker、reviewer、supervisorはこれらを自動実行せず、
承認前のacceptanceはrepository内のoffline fixtureまでとする。

## 76. review 必須ポリシー — worker の outcome 自己申告だけで reviewer をスキップさせない（2026-09-02）

背景: reviewer は task が `review` 状態になった時だけ起動する（§21）。worker が `outcome: "done"` を書くと
finalize は task を直接 `done` へ遷移させ（`finalize.ts` の `to: handoff.outcome === "done" ? "done" : "review"`）、
二審が入らない。2026-08-20〜09-02 の finalized 402 run のうち 38（9%）がこの経路で done になり、
08-25 には未レビューの実装 2 件が main へ入った（`k_f87a0858e228`）。body に「outcome=review 必須」と
書くことが唯一のレバーだったが、書き忘れは検知されない。

### 76.1 設定と既定

- profile entry（`profiles.<name>`）に `reviewPolicy: "required" | "worker-outcome"` を追加する。
  **省略時の既定は `required`**。既存 config は無変更で `required` になる（後方互換は「安全側に倒れる」方向）
- `required`: worker の handoff が `outcome: "done"` でも finalize は `outcome: "review"` として扱い、
  task を `review` へ遷移させる。run meta に `reviewPolicyApplied: "required"` と、元の申告
  `workerOutcome: "done"` を残す（監査用。verdict の判定材料にはしない）
- `worker-outcome`: 従来挙動（`done` 申告は `done` へ直行）
- `outcome: "question"` は本節の対象外（§52 の経路のまま）

### 76.2 task body による opt-out

- body の機械可読宣言 `review-policy: worker-outcome` で、その task だけ従来挙動へ倒せる。
  **走査は §43 の `handoff-policy` と同じ行単位規則**（body を行へ分割し、`^review-policy:` に前方一致する
  最初の行だけを宣言とみなし、`/^review-policy:[ \t]*(\S+)[ \t]*$/` に一致した時だけ値が確定する）
- 認める値は `required` / `worker-outcome` の 2 つだけ。**それ以外の値、および行があるのに正規表現へ一致しない
  場合は `invalid` とし、`worker-outcome` へ寄せずに検証失敗として扱う**（`review-policy 宣言が不正` と
  分かる文言で run を failed にし、task は `review-required:` block へ）。opt-out は権限縮小の逆方向なので、
  typo を「レビュー不要」へ寄せてはならない
- 宣言が無い場合は profile の `reviewPolicy`（既定 `required`）に従う。body の宣言は profile より優先する

### 76.3 変えないもの

- reviewer の起動条件（`review` 状態）と verdict の意味論（§21〜§22）は変えない
- `review-required:` / `user-decision:` の block reason 語彙は変えない
- working tree / commit / artifact の証拠検証（§43）は**元の申告 outcome** で評価する（`required` で
  `review` へ倒しても、`done` 申告に対する検証を弱めない）
- steward / brief の判定（§40, §74）は `reviewPolicyApplied` を読まない

## 77. セッション消費モデルと引き継ぎ推奨 — (provider, model, effort) 別（2026-09-02）

playbook §0.7 が事実上の仕様だった「消費計測・損益分岐・引き継ぎ閾値」を契約へ移し、モデルと effort に
応じた推奨を出せる形に改める。動機: 2026-09-02 時点で `claude-fable-5-1` が価格表に無く effectiveCostUsd が
判定不能、損益分岐 N は既定単価 $0.50/MTok（Fable 5.1 の実単価 $0.25 の 2 倍）と別 identity の
gen44 定数 `{c0: 101231, s: 1.95}` で計算され、Fable 5.1 では実態の約 1/4 の N を「urgent」と報告していた。

### 77.1 範囲と非対象

- 対象は **orchestrator session**（Claude transcript / Codex rollout から観測できるもの）。
- worker run は対象外。bridge run の `lastResult` は provider が送る literal `costUsd:0` の偽ゼロ
  （`docs/plans/direct-run-usage-cost-audit.md`）であり、bridge 側の usage 取得が直るまで
  worker routing を費用で判断しない。本 § はその前提を変えない。
- 出力する推奨は 2 種類で、混ぜない: **(a) 引き継ぎ時期**（§77.5）と **(b) effort 助言**（§77.6。情報のみ）。

### 77.2 観測 — turn ごとに provider / model / effort を付ける

- `MainSessionUsage` は turn ごとに `provider` / `model` / `effort` を持つ。Claude は assistant 行の
  top-level `effort`、Codex は `turn_context.effort`。取れない turn は `effort: null`（既定値で埋めない。
  effort は session 内で変わるため session 単位に丸めない）。
- output の**内数**として thinking / reasoning トークンを記録する（Claude `usage.output_tokens_details.thinking_tokens`、
  Codex `reasoning_output_tokens`）。output の合算値は変えない（単価は同じ）。
- 集計キーは三つ組 `provider/model/effort`（`perExecution`）。既存の `perModel` は互換のため残す。
- `contextModel` に加えて `contextEffort`（文脈を決めた最後の message turn の effort）を出す。

### 77.3 単価 — effort は単価を変えない。Codex は台帳を選ぶ

- 単価は model 単位。**effort は単価を変えず、消費トークン量だけを変える**（Anthropic / OpenAI 公式。
  reasoning / thinking は出力単価で課金）。したがって effort は §77.4 の係数側に現れ、価格表には現れない。
- 価格表は LiteLLM からの生成物と `PRICE_TABLE_REF`（§14.5.1）のまま。config
  `orchestrator.pricing.overrides[modelId]`（`ModelPrice` + 必須の `source` 文字列）で個別上書きできる。
  上書きは `priceTableRef` と並べて `priceSource: override` を残す。
- Codex の台帳は `~/.codex/auth.json` の `auth_mode`（API キー無しの OAuth = ChatGPT サインイン）で判定する。
  ChatGPT サインインの session には USD 単価を適用しない。config `orchestrator.pricing.codexCreditUsdRate`
  （1 credit あたり USD）が無ければ、当該モデル分の effectiveCostUsd は unmeasured
  （理由 `codex-credit-ledger-unpriced`）とし、`orchestrator.pricing.codexCredits[modelId]`
  （input / cached / output credits per 1M、`source` 必須）があれば credits で表示する。**換算率を推測して埋めない。**

### 77.4 係数テーブル — 実測・provenance 付き

- board DB に `session_usage_profiles` を持つ。key `(provider, model, effort)`。値: `turns`（標本数）、
  `cacheReadPerTurn`、`cacheWrite5mPerTurn`、`cacheWrite1hPerTurn`、`outputPerTurn`（`reasoningPerTurn` を内数で併記）、
  `contextGrowthPerTurn`、`updatedAt`、`sourceSessionIds`（直近 N 件）、`computedFromRef`。
- 係数は transcript / rollout から CLI（`hachi orchestrator usage-profile refresh`）または supervisor stage が計算する。
  **手書きの定数テーブルを置かない**（`usage.ts` / `types.ts` / `orchestrator-session-budget.ts` の既存規則）。
- 標本が `minTurns`（既定 30）未満の三つ組は unmeasured。unmeasured の係数を使う推奨は出さない。

### 77.5 コストモデル — S は導出する。R と比べて初めて推奨になる

- **C₀（立ち上げの床）**: identity ごとに「直近 K 世代（既定 5）の main-chain 15 ターン目の `contextTokens` の中央値」。
  境界規則はこれ 1 つに固定する（境界を変えた値どうしを比較しない）。未測なら config
  `orchestrator.sessionBudget.costModel.c0` を使い、`c0Source: measured | config` を出す。
- **S（乗り換え費用）**: 定数ではなく `S = C₀ × p_write1h(model) + bootOverheadUsd` で導出する。`p_write1h` は
  §77.3 の単価解決に従う。`bootOverheadUsd` は起動直後の prefix 再書き込みの実測（knowledge `k_a705c5514d6d`:
  $0.377〜0.483）を identity ごとに測り、未測は config `costModel.bootOverheadUsd`（既定 0.40）。
  既存の `costModel.s` は**非推奨**。設定されていれば S を上書きするが `sSource: config-legacy` と表示する。
- **N（損益分岐ターン数）**: `N = S / ((C − C₀) × r(model))`。`r` は cache read 単価（解決順は context-model →
  dominant → default。既定値使用時は `source: default` を必ず表示）。
- **R（残作業見込みターン数）**: identity に bind された `ready / in-progress / review` タスク数 × `turnsPerTask`
  （§77.4 の実測。未測は config 既定 8）+ 未処理 inbox request 数 × 2。
- **推奨 (a)**: `R ≥ N` なら `handoff-at-boundary`（次の区切りで引き継ぐ）、`R ≥ 2N` かつ段階 urgent なら
  `handoff-now`、`R < N` なら段階に関わらず `continue`（理由 `R<N` を明示）。既存の `handoffValue` 軸の
  段階判定は残すが、**推奨の決定変数は R と N の比較**である。
- effectiveCostUsd の閾値（既定 $15 / $30 / $60）は**絶対額の上限**であり model 非依存とする（Fable 系は Opus の
  半分のターン数で達する。それは意図どおり）。

### 77.6 推奨 (b) — effort 助言は情報のみ

- 観測した `(model, effort)` の 1 ターンあたり費目（cache read / cache write / output）と USD を出し、同 model の
  **別 effort の係数が測れている場合に限り**「effort を X に下げると 1 ターン約 $Y 減」を `effortAdvisory` として添える。
  標本が無い effort については何も言わない。
- 助言は情報であり、**自動で effort を変えない**。変えるのは orchestrator（自セッション）か人間である。

### 77.7 出力と通知

- `hachi orchestrator usage --check` の stdout 先頭行に `[provider/model/effort]` を付け、JSON に
  `recommendation: { action, n, r, model, effort, nSource: {c0Source, sSource, priceSource}, reasons[] }` と
  `effortAdvisory | null` を載せる。exit code の契約（0 / 10 / 11 / 12）は変えない。
- supervisor stage `session-budget-monitor`（既定 15 分間隔、config で変更可）が **active な全 orchestrator session**
  を評価し、段階または `recommendation.action` が変わったときだけ、(1) 当該 identity 宛の orchestrator request
  `kind=session_budget`（context に recommendation JSON）と (2) §38 の運用通知を出す。dedupe key は
  `(sessionId, stage, action)`、窓は 15 分。identity の配送先解決は §55.3 / §69.3.1 に従う。
  この request の閉じ方は `hachi orchestrator resolve <request-id> handled|false_positive <理由> --claim <token>`
  （run_stalled と同じ経路。`orchestrator answer` は受理しない）。閉じないと claim が失効して再キューされ、
  inbox watcher を周期的に起こし続ける（2026-09-03 実測 `or_406b005ac9a703fe`）。
- UserPromptSubmit フックは残す（セッション内の即時表示）。フックと stage は同じ CLI 判定を使う。

### 77.8 自動引き継ぎ（規定のみ。実装は別起票）

- config `orchestrator.sessionBudget.autoHandover: off | propose | apply`（既定 `propose`）。
- `apply` は `recommendation.action = handoff-now` かつ区切り条件（identity 配下の open run 0、`user-decision` block 0、
  未処理 inbox 0）が揃ったときだけ、supervisor が `hachi orchestrator handover --apply` を実行する（§55 / §0.8 の
  preflight と補償はそのまま）。`propose` は通知までで止まる。

### 77.9 実装上の確定事項（2026-09-02 起票時に凍結）

- `MainSessionUsage` は集計値に加えて **turn 系列**（`turnSeries`: provider / model / effort / contextTokens / 4 系統トークン /
  reasoning 内数 / timestamp）を持つ。C₀ の「15 ターン目」と `contextGrowthPerTurn`、boot overhead の標本は
  この系列から計算する（評価のたびに transcript を読み直さない）。
- 立ち上げ標本は `session_boot_samples`（identity / session / `contextAtTurn15` / `bootOverheadUsd` / provenance）に
  保存し、C₀ と bootOverhead はその直近 K 世代の中央値とする。
- R の対象は identity に **scoped**（binding + watch。§55.3 の配送先解決と同じ集合）なタスクとする。
  未処理 inbox の件数から `kind=session_budget` 自身は除く（自己参照防止）。
- `p_write1h` は `cacheCreation1h ?? cacheCreation5m ?? input` の順で解決する（OpenAI 系は 1h 単価を持たない）。
- `turnsPerTask` は実測が揃うまで config のみ（既定 8）。
- `kind=session_budget` の orchestrator request は `notification_outbox` 行を作らず、§38 通知は monitor stage が送る
  （二重通知の防止）。request の `questionId` は `(sessionId, stage, action, 15 分 bucket)` で作り、永久冪等にしない。
- 実装は T1 observe → T2 price → T3a profiles → T3b assessment → T4 notify の順（T1 ∥ T2、T3a←T1,T2、T3b←T3a、T4←T3b）。

### 77.10 残作業 R の対象拡張とアイドル失効コスト（2026-09-03 追記。§77.5 の R 定義を置き換える）

- **R は `todo` を数える。** §77.5 の対象（scoped な `ready / in-progress / review`）に scoped な `todo` を加える。
  todo は担当 identity が起票した残作業であり、数えないと R が 0 に貼り付いて推奨が `continue` に偏る
  （2026-09-03 gen43 実測: §77 の 5 タスクが todo に並んでいる間ずっと R=0 だった）。
  **ミッション task（title が `[mission]` で始まる、または identity の subtree watch の root）は除く。**
  `triage` は数えない（仕分け待ちで担当が確定していない）。JSON に
  `remaining.breakdown = { todo, ready, inProgress, review, inbox }` を載せ、`rBasis` は `scoped-with-todo`。
- **アイドル失効コスト。** prompt cache は TTL を超えて idle すると失効し、次の 1 turn で文脈全体 C が write 単価で
  書き直される。TTL は観測できないので config `orchestrator.sessionBudget.costModel.cacheTtlSeconds`（既定 3600。
  Claude の既定 1h）。`idleRewriteUsd = C × p_write(TTL)`（TTL ≥ 3600 なら `cacheCreation1h`、未満は
  `cacheCreation5m`、無ければ `input`。§77.9 と同じ解決順）。後継へ乗り換えれば S で済むので
  `idleHandoverSavingsUsd = idleRewriteUsd − S`。
- **推奨 (c)**: `recommendation.idle = { ttlSeconds, rewriteUsd, savingsUsd, action }`。`action` は `savingsUsd > 0` なら
  `handoff-before-idle`、それ以外は `continue`。**(a) と混ぜない** — (a) は「働き続ける場合」、(c) は「これから
  TTL 超の待ちに入る場合」の判断で前提が違う。どちらの状況かは CLI では判定できないので `--check` は両方を並べ、
  待ちに入るかどうかは orchestrator（playbook §0.7.2.2 の確認待ちに入る瞬間）が決める。
- **stage による検知**: `session-budget-monitor` は active session の provider ネイティブログ（transcript / rollout）の
  mtime から idle 秒数を求め、`idleSeconds ≥ cacheTtlSeconds × idleWarnRatio`（config `monitor.idleWarnRatio`、
  既定 0.5）かつ `savingsUsd > 0` のとき、`kind=session_budget` の request（questionId
  `session-budget:<sid>:idle:handoff-before-idle:<15 分 bucket>`）と §38 通知を出す。dedupe は §77.7 と同じ
  `(sessionId, stage='idle', action)`。**失効後（idleSeconds ≥ TTL）は通知しない** — もう遅く、次の turn を打つか
  外部から引き継ぐかは人の判断。閉じ方は §77.7 と同じ `orchestrator resolve`。
- 実装は T5 R-todo ∥ T6a idle-assess → T6b idle-notify（T6b←T6a）。

## 78. G2 relay control socket — 認可問い合わせの唯一の面（2026-09-04）

§68.6 と `docs/plans/g2-orchestrator-design.md` の G2 配信は、hook（出力）・route guard（表示と操作）・
channel plugin（入力）の 3 者が同じ registry を見る前提で設計されている。ところが実装は
`RelayRegistry`（`packages/core/src/relay-registry.ts`）と `decideRelayAuthorization`
（同 `relay-authorization.ts`）という純モジュールだけが存在し、**それを hosting して外へ出す面が無い**
（`new RelayRegistry` の呼び出し元 0 件 / `decideRelayAuthorization` の呼び出し元 0 件）。
その結果 2026-09-04 に channel plugin 側（`t_6de53165c66fe8a7`）が `/v1/registry/active-owner` と
`/v1/channel/delivery-uncertain` を呼ぶ client を独自に作り、**counterpart が存在しないまま**
3 度 review を落とした。本節は面を 1 つに固定し、以後の実装が独自 protocol を発明することを禁じる。

### 78.1 面と所在

- 面は **Unix domain socket 上の HTTP/1.1 + JSON** 1 本に限る。TCP port を新設しない
  （runbook の port 台帳にある 3458 予約は将来の別用途として残し、本節の面では使わない）
- socket path は `$HACHI_KANBAN_HOME/state/relay/control-<evenTerminalBootEpoch>.sock`。
  親ディレクトリは 0700、socket は 0600。**boot epoch を path に含める**ことで、再起動後の古い
  socket を新しい boot の面と取り違えない
- **単一 hosting は §50.1.1 の共有flock primitiveで所有する（2026-09-05 是正）。**
  daemon process自身がprivate FDのownerであり、socket/registry/recorder操作も同processのguarded面だけが行う。
  - canonical homeは `realpathSync.native(resolve(hachiKanbanHome))`。同じhome/epochの全D1は
    `state/relay/control-<epoch>.flock` / `.owner` を使用し、socketは同stemの `.sock` とする。
    PID、relayId、generation、任意prefixをlock名へ含めない。別home/epochは独立する。
  - epochの既存validationを維持する。共有primitiveへの全引数はlockPath=上記`.flock`名、
    ownerMarkerPath=同.owner名、recheckDirectoryPaths=[canonical relay directory]、maxBytes=0。
  - home/stateは共有directoryであり作成/chmodしない。current uid・通常directory・非symlink・
    group/other非writableをlstat/no-follow open/fstat/lstat/realpathで検査し、**各取得時identityを保存する**。
    state0755と0700を受理し、不在はINVALID_SOCKET_PATHで開始拒否する。
    D1が作成できるのは直下relayだけ（non-recursive mkdir0700、fchmod/fsync）。既存relayの不正modeは直さず拒否する。
  - **全guardでhome/stateの取得時identityをD1が独立再検査し、その後shared assertを行う。**
    relayのinodeが同じだけでは親差替えを検出できない（新stateへ元relayを再配置できる）。
    state0755を700専用recheckDirectoryPathsに渡して回避しない。shared同期APIは変更しない。
  - busyはALREADY_RUNNING、構造違反はINVALID_SOCKET_PATHで開始拒否する。取得後違反では
    同期的にpoisonして新規accept/全registry/recorder操作を拒否する。raw registryは外部へ公開せず、
    現公開メソッドを前後guard付き同期façadeで包む。export済みerror unionやwireを変更しない。
  - startではlock取得後、stale socketのlstat/unlink、listen、socket lstat/chmodの各直前/完了直後にguardする。
    非socketを削除しない。runningではrequest parse後、各registry操作前後、recorder呼出直前/await完了直後にguardする。
    stop/poisonは新規acceptを止め、unlink前後にguardし、socket identityも一致するときだけ削除する。
    guard失敗後はsocket/marker/lock pathnameをunlinkせず、進行中recorderのsettle後にprivate FDをcloseする。
  - 同期registry操作はguardから完了までawaitしない。非同期境界の前後検査はTOCTOUの検出であり原子化ではない。
    §50.1.1の同uid信頼境界・fail-closed・旧/new非共存を適用し、recorder自体のfencing/idempotencyを維持する。
  - connectの生存確認は診断だけに使う。PID、marker、stale fileによる奪取や恒久残骸lockへfallbackしない。
- client は path を設定から受け取る。**探索・推測・fallback を実装しない**

### 78.1.1 pathless listenerの実装・build境界（2026-09-06）

§78.1のguard失敗後pathname操作禁止を満たすため、D1は同processのprivate plain N-API bindingで
AF_UNIX FDをbindし、公開 `http.Server.listen({fd})` に渡す。Nodeへsocket pathnameを渡さず、
private Node API/外部listener process/park-restore renameを使わない。FDのfstat identityとsocket
pathnameのlstat identityは別namespaceとして保存し、相互比較を削除条件にしない。

- bindingはsocket、CLOEXECのfcntl設定/再検査、bind、失敗時の一度だけのcloseに限定する。
  unlink/chmod/rename/link/open/stat/mkdirなどのpathname cleanupを行わない。absolute/NUL-free/
  platform sun_path byte上限を同期検証し、切詰めない。LinuxはSOCK_CLOEXEC、Darwinはfcntlを使う。
  通常Node child_processのCLOEXEC_DEFAULTをraw native forkへ一般化しない。
- D1はNode v24.20.0、Darwin arm64またはtarget-host build済Linux x64/glibc、main thread/cluster primary
  だけを対象とする。raw native fork/execや非協調private FD操作が競合するhostingは対象外。
  最終production entrypoint完成時に監査する。repo全体のNode要件やwire/error unionは変更しない。
- raw bind直前guardからpost-bind lstat/chmod/guard、listen同期復帰と直後のownership判定までは
  awaitせずsync APIで行う。listen前にerror handlerを設置する。server.listeningが同期trueなら
  Node-ownedとなり、以後はpathless server.closeを使う。false/throwではfstat EBADFなら再closeせず、
  保存FD identity一致ならcallerが一度だけclose、別identity/観測不能/close errorはownership unknown。
  compare/closeは原子的ではなく、§50.1.1の同process協調境界を維持する。
- ownership unknownは同期terminal stateとprocess-local sticky invalidにし、SOCKET_PROBE_FAILEDで拒否する。
  通常catchでstoppedへ戻さず、server.close/unlink/SidecarLock.closeを追加実行しない。private flockと
  既存registry reservationをprocess exitまで保持し、同instance/新instanceの全D1再startを拒否する。
  hostがexact owner process終了を確認しkernel cleanup後だけ置換する。stopもunknownを正常化しない。
  既知所有権の通常poisonは§78.1のrecorder settle後closeを維持する。
- 新しい外部依存やinstall lifecycleを追加しない。coreの `build:relay-native` をhost/CIから明示実行し、
  同じ実行Nodeのreal executableに隣接する `../include/node` のheadersだけを使う。node_version.hを
  24.20.0へ照合し、別cache/download/env header pathへfallbackしない。compiler argv/envを固定し、
  CPATH等を継承しない。未build/未対応/不一致は最初のrelay namespace操作前に開始拒否する。
- build/load rootはmodule自身から導出するworktree内 `packages/core/dist/relay-native/` に固定する。
  native source/build script/固定argv/Node全header set/Node executableとversion/platform/arch/
  compiler/host OS release/Linux glibc/binary hashをreceiptへ記録する。generationはgeneration fieldを
  除いたcanonical receipt全体のsha256（binary hashを含む）。private temp generationを完成・fsync・
  rename後にcurrent.json pointerをatomic publishする。既存generationを上書きせず、symlinkを拒否する。
  lazy loaderはcurrent sourceと全build inputs、receipt再計算hash/directory名/pointerの三者一致、
  binary hashを照合する。core通常importはnativeを要求しない。live D1とbuild/pointer更新を共存させない。
- loaderの明示preflight `assertNativeSocketRuntime()` は毎start前に上記の完全照合を行い、
  module cacheを照合省略の根拠にしない。失敗時は以前のpreflight成功状態も無効化する。
  初回loadのgeneration/binary realpath/hashを固定し、同processで別generationへの切替を拒否する。
  native moduleをunloadしたと仮定せず、generation更新後はexact owner終了後の新processを必要とする。
  `bindUnixSocketNoUnlink()` は明示preflight済み状態とenvironment/sticky guardを検査するだけで、
  receipt/header/source/binaryの全面走査をraw FD所有権の同期区間へ持ち込まない。
  preflight未実施/失敗後のbindはnative呼出前に拒否する。呼出側D1はnamespace操作より前にpreflightする。
- 固定core rootからdist/relay-native/generations/generationまでの全directoryと、pointer/receipt/binary/
  source/scriptのnon-symlink・適切なfile種別を検査する。generationはlowercase hex64でpath traversalを拒否する。
  compilerは固定pathをrealpath解決したregular targetとそのhashを照合し、固定pathのsymlink自体は拒否しない。
  Linux glibcはreceiptの存在だけでなく実runtime versionへ完全照合する。runtimeでcompilerをspawnしない。
- native bind成功後のfstatがEBADFならcloseを追加せず失敗とする。それ以外のfstat失敗は
  ownership unknownとしてcloseせずsticky拒否する。確認済みcaller-owned FDのclose失敗も
  NATIVE_SOCKET_OWNERSHIP_UNKNOWNへ正規化し、retry/次bind/通常cleanupを禁止する。
- 検証は明示preflight後にpreflight専用FS readをtest-onlyに計測/拒否してbind成功・read0を確認し、
  未preflightではnative呼出0を確認する。loaderの改変検査は複製fixtureへ閉じ、実checkout/global headerを
  書換えない。実build receiptを実loaderへ通し、test側の同型再実装だけで照合成功としない。
- target host上でbuildし他hostへbinaryを配布しない。Linux CIはUbuntu24.04/Node24.20.0の一環境だけの
  証拠とする。公開D1の実UDS/guard後pathname mutation0、recorder settle順序、unknown時別process busyと
  owner exit後recoveryをDarwin/Linuxで検証する。spike成功を本体採択の代わりにしない。
  Linux gateと旧runtime exact停止の条件は維持し、それまで本体採択・展開しない。

### 78.2 endpoint（3 本。増やすときは本節を改訂する）

すべて `POST`、request / response とも `application/json`。

| endpoint | 呼び出し主体 | 用途 |
|---|---|---|
| `/v1/authorize/observer` | even-terminal の route guard | 表示・履歴・SSE・prompt・interrupt を通してよいかの判定 |
| `/v1/authorize/owner` | relay owner を代行する client（channel plugin） | 自分の fence が今も active かの照合 |
| `/v1/delivery/uncertain` | channel plugin | at-most-once の不確定（`sending` 残骸）の報告 |

### 78.3 observer 経路 — fence を名乗らせない

route guard は owner ではないので `relayId` / `fencingToken` を持たない。

- request: `{ route, sessionId, provider, host, evenTerminalBootEpoch,
  requestingServerUrl, observations: { processLiveness, transcriptExists } }`
- **`relayId` / `fencingToken` / `handoverGeneration` を request に含めてはならない。** 含まれていたら
  判定せず `400 invalid_input` を返す（daemon が registry から解決した値と、呼び出し側の自称が
  食い違う経路を作らないため）。observer は generation も名乗らない — 名乗れる立場ではない
- **未知 field も `400` で拒否する。** wire は `unknown` として受けて明示的に検証すること。
  TypeScript の型（`kind:"observer"` の `never`）は wire の防御にならない
  （2026-09-04 の実測: 純関数は observer 入力に owner-only field を混ぜても拒否しなかった）
- daemon は `RelayRegistry.activeRegistration()` で owner を解決し、その `relayId` / `fencingToken` を
  `decideRelayAuthorization` の入力へ埋める。active owner が居なければ判定関数の未登録経路へ落ちる
- `observations.processLiveness` は `alive | absent | unknown` の三値で、**呼び出し側が観測した値**を
  そのまま渡す。省略・不正・`unknown` は判定関数の規定どおり `relay_unavailable` /
  `process_liveness_unknown` で閉じる（503）
- response は `RelayAuthorizationDecision` をそのまま JSON にしたもの。**daemon は decision を
  要約・変換・上書きしない。** HTTP status は decision の `httpStatus` をそのまま使う

### 78.4 owner 経路 — 完全一致だけを許す

- request: `{ sessionId, provider, host, evenTerminalBootEpoch, handoverGeneration, relayId, fencingToken }`
- **owner 照合を `route:"prompt"` で表現しない（2026-09-04 訂正）。** prompt 転送は P3-2b まで
  無条件に閉じている（`prompt_forwarding_disabled`）ため、prompt を使うと **fence が完全一致でも
  必ず 409 になり、正当な owner の生存確認も §78.5 の記録前照合も成立しない**。
- 代わりに **owner 照合専用の判定**（`action:"owner_check"` 相当の専用経路、または fence 検証関数）を
  使う。これは転送可否とは独立の問い（「この fence はいま active か」）である
- daemon は **呼び出し側が名乗った** `relayId` / `fencingToken` を入力にし、active registration と
  完全一致しなければ `owner_conflict`（409）で閉じる。**現 fence は成功し、旧 fence は 409 になる**
  ことを endpoint テストで固定する
- lease 失効後の旧 owner はここで落ちる。**静的 binding file を認可の根拠にしない**という要求
  （`t_6de53165c66fe8a7` の R2）の唯一の実装経路がこれである

### 78.5 不確定配送の報告

- request: `{ sessionId, handoverGeneration, relayId, fencingToken, eventId, observedAt, reason }`
- `reason` は `sending_remnant`（送信済みか不明のまま再接続した）に限る。増やすときは本節を改訂する
- daemon は owner fence を §78.4 と同じ規則で照合してから記録する。**照合に失敗した報告は記録しない**
- 記録は **(sessionId, eventId) で冪等**とする。同じ不確定を何度報告しても 1 件へ収束し、応答は
  `{ recorded: true, duplicate: <bool> }` を返す
- **報告の失敗を「配送成功」と読み替えてはならない。** 報告に失敗した client は次の接続時に再報告する。
  再報告が `duplicate: true` を返すことは、配送が成功した証拠ではない
- 記録は運用者が読める面（event / 通知）へ出す。**黙って捨てない**

#### 78.5.1 永続記録と運用者の読み取り面（2026-09-07）

- 専用 `relay_delivery_uncertain_events` tableへappend-onlyで保存する。task FKや擬似taskを作らない。
  keyはBINARY比較の(session_id,event_id)。初回に認可された報告の全wire値、host固定config由来の
  provider/host/even_terminal_boot_epoch/canonical_server_url、DB受領時のrecorded_atを保存する。
  prompt/tool payload/credentialは保存しない。recorded_atは既存StoreのUnix秒規約に従う。
- `recordRelayDeliveryUncertain` はcurrent fence認可済みD1 closureからだけ呼ぶprivate persistence port。
  DBでowner/fence/ownership lookupを再実装しない。host属性をwireから信じない。
  INSERTの競合対象を(session_id,event_id)へ限定し、同keyだけduplicate=true、他の制約/DB失敗はthrowする。
  原記録のfenceとは**初回authorized report時のcurrent fence**であり、外部送信時fenceではない。
  重複時にfence/observedAt/recordedAtその他の既存列を更新しない。再起動・複数connectionでも同keyは一行。
- schemaはprovider/reasonの既定enum、generation/tokenの正safe integer、時刻の非負safe integer、
  非空identityを制約で検証する。observedAtのwire単位/値を変換しない。
- `KanbanReadView` の単件(sessionId,eventId)と一覧、read-only `hachi relay deliveries` を提供する。
  一覧はrecorded_at DESC, session_id BINARY ASC, event_id BINARY ASC。optional session完全一致filter、
  limit既定100/1〜1000をAPIでも検証する。全体/単session用indexを持ち、不正行をfilterせずthrowする。
  Store再open・競合・原記録保持・制約/DB失敗と、D1→実UDS→Store→read面を検証する。
  Store単体greenをD1/production hosting/実G2受入の代替にしない。

### 78.6 共通規則（fail-closed）

- daemon が応答しない・path が無い・schema 不一致・timeout は**すべて拒否**として扱う。
  従来の `query({ resume })` 経路や cross-session socket へ fallback しない
- 判定は hachi 側に一本化する。even-terminal / plugin 側へ判定ロジックを複製しない
  （even-terminal の dist は npm 更新で戻るため）
- request / response の未知フィールドは拒否する（前方互換のための暗黙の無視をしない）
- socket は同一ユーザーだけが read/write できる。認証 token を平文で載せない

### 78.7 検証ゲート

- daemon 側: 3 endpoint × （active owner / lease 失効 / generation 不一致 / boot epoch 不一致 /
  未登録 / observations 欠落）の判定が期待どおりであること
- **client を迂回したテストを green の根拠にしない**（`t_6de53165c66fe8a7` が 3 度目に落ちた理由）。
  少なくとも 1 本は実 socket を通す統合テストにする
- stale socket が残った状態からの起動と、二重起動の拒否

### 78.8 本節が依存している前提（2026-09-04 時点で未充足）

**次の 2 つが入るまで、§78 の実装は完成しない。** 実装者はこれを自分で直そうとせず、
前提タスクの統合を待つこと。

- ~~**registration が provider と canonical server identity を持つこと**（`t_274ef70def2136e2`）~~
  → **2026-09-04 に充足（main=5133518、未 push）。** `RegisterRelayInput` / `RelayOwnerFence` /
  `RelayRegistration` が provider と canonical `serverUrl` を持ち、**registration key の完全一致検証に
  使われる**。全 route で不一致は `stale_or_foreign` として拒否される。
  **ただし active registration を索く scope key には含めない（§78.9）。** 当初この 2 つを混同して
  scope 側へ入れた実装が fencing を破っており、main=4850313 で canonical session 単位へ是正した
- ~~**transcript-only 経路の入力分離**（`t_5253fe7055709fca`）~~
  → **2026-09-04 に充足（未 push）。** `RelayAuthorizationInput` は `kind=owner` / `kind=observer` の
  discriminated union になり、observer は `handoverGeneration` / `relayId` / `fencingToken` を
  名乗らずに判定できる。transcript-only の照合は `task_runs` に現存する
  provider / transport / serverUrl の exact-one 一致だけを使う。
  **§78.3 の request はこの observer 形に合わせること。**
  host / evenTerminalBootEpoch まで所有 authority に含めたい場合は、`task_runs` / `RunRow` と
  writer 側へ両値を足す独立タスクが要る（本節の範囲外）

**ownership projectionの決定（2026-09-07）**: lookupは `task_runs.session_id` のBINARY完全一致行を
id ASCで全件返す。status filter/LIMIT/dedupeは禁止。providerはcodex/claude、metaはJSON object、
transportはbridge/directを検証する。bridgeのserverUrlは既存helperでcanonical化可能なHTTP(S) URL、
directは既存writerのsentinel `serverUrl="direct"` だけを受理する。未知meta fieldは許容するが、
必要field欠落・型不正・未知transport・不正URL/sentinelが一行でもあればlookup全体をthrowする。
正当なdirect/provider不一致/server不一致行を結果から除かない。認可側のownership validatorも
同じtransport別規則とし、valid direct行の存在だけでownership_lookup_failedにしない。
exact-oneは全valid行のうちprovider一致・bridge・canonical serverUrl一致の件数で判定する。
0行は空配列、取得不能はthrow。namespace変換やfallbackを追加しない。

**決定（2026-09-04・旧「未確定」を解消）**: G2 route の canonical session ID は
**provider-native の session id** とし、その board 側の記録が `task_runs.session_id` である。

根拠:

- `RunRow` は `sessionId` を 1 本しか持たない。run 層に別個の「Hachi 内部 session id」は**存在しない**
- G2 の呼び出し側は既にこの値を名乗っている — Even は `POST /api/prompt {sessionId}` を送り、
  even-terminal はそれを `query({resume: sessionId})` へ渡す。**resume できる id ＝ provider-native**
- §78.8 の transcript-only 照合（`RelaySessionOwnershipLookup`）も同じ値で `task_runs` 行を引く
- したがって wire identity・resume identity・board の記録が**同一文字列**になり、
  変換表が要らない。変換表を置かないことが、cross-session 認可の再混入を構造的に防ぐ

**名前空間をまたぐ解決を実装してはならない（fail-closed）。** 呼び出し側が名乗った値が
`task_runs.session_id` と完全一致しなければ認可しない。一方から他方を導出・推測・正規化しない。

**必須の route-level test（両者を意図的に異ならせる）**: Hachi が採番した session id
（direct adapter の `direct-<nonce16hex>` 形。§17.2）を持つ run に対し、provider-native 風の
id を名乗る request が**認可されない**こと、およびその逆が成り立つこと。
どちらの方向も「片方で通ったから」を根拠にしない。

### 78.9 fencing の scope は canonical session であって (provider, server) ではない（2026-09-04 追加）

**generation・owner conflict・fencing token は、不変の canonical session identity 単位で共有する。**
provider と canonical server identity は §78.3 の**完全一致検証に使う属性**であって、
**scope を分割する key にしてはならない。**

2026-09-04 の実測で、active registration の scope を `(sessionId, provider, serverUrl, host)` に
分割した実装は、**generation 8 の owner が生存中でも、同じ sessionId の generation 7 を
別 `serverUrl` で登録でき、`history` route が `active_owner / 200` を返した**。
旧世代による read・ingress・ack・interrupt と、複数 owner の同時稼働が可能になる。
**provider/server を名乗り分けるだけで fencing を迂回できてはならない。**

### 78.10 production hostの登録authorityと再起動境界（2026-09-07）

本節はproduction hostingの追加要件。D1/nativeの局所実装だけで充足したとしない。
§78.1のlaneごとのsocket/lockを維持しつつ、両provider/laneを扱う専用relay hostが
board instance・実hostごとのsingletonと共有canonical-session authorityを保持する。
supervisorプロセスへの埋込み、各D1への独立counter生成、旧静的enableからの自動登録は行わない。

#### 78.10.1 singletonと導入

- singleton/receipt namespaceはOSの `userInfo().homedir` 配下の固定
  `.hachi-kanban/relay-authority/<boardInstanceId>/`。boardInstanceIdは開いたStoreのimmutable値を
  検証して用い、caller指定host文字列/HACHI_KANBAN_HOME/別名でlockを分割しない。
  同board UUIDなら別home alias/DB copyでも同じhost lockへ収束する。
- §50.1.1の採択済み共有flock primitiveでprocess lifetimeを所有する。uid/mode/non-symlink/
  no-follow/取得時inodeのguardを保ち、private directoryだけを作成する。共有parentをchmodしない。
  新singleton未参加のlegacy D1/launcherを同時稼働させない。初回切替もrollbackもexact owner停止が先。
- 通常serveはinstallationを作らない。別の明示one-time adoption actionだけがexpected board identityと
  host-owned identityを確認し、DB installationと別rollback domainのprivate receiptを作る。
  両方無しは未導入として通常起動拒否。片方欠落、board/adoption/host identity不一致は復旧gate。
  DBとreceiptの両方を失うwhole-host restoreは自動識別不能であり、continuity証拠をbackupから保全し、
  喪失時は旧owner全停止と明示再採択を要する。静的enable、PIDfile、TTLを導入/回復証拠にしない。

#### 78.10.1.1 namespace初期化とhost identity（2026-09-07）

- host-owned identityは固定OS-homeの `.hachi-kanban/relay-authority/host-identity.json` に保存する
  `schemaVersion:1` と `hostIdentityDigest` だけの厳密JSON。digestはrandomBytes(32)のlowercase hex。
  DBのhostIdentityとreceiptのhostIdentityHashへ同じ値を渡し、再hash/hostnameからの導出をしない。
  これはauthority rootの継続identityであり物理machine証明ではない。whole-host clone/restoreは
  自動検出不能のためauto-startを禁止し、旧host全停止と明示復旧の外部gateを要する。
- 通常serveはnamespace directory/identityを作成しない。明示adoptionだけが欠落private directoryを
  non-recursive mkdirで作る。共有parentをchmodしない。共有ancestorは現在uid所有・group/other
  writable禁止、authority root/board directoryは0700を要求する。root mkdir成功processだけが
  identity作成者となり、mkdir直後・identity作成前にparent fdをfsyncする。EEXIST側は完成identityを
  読むだけ。既rootでidentity欠落/異形なら再生成せず復旧gate。identity完成前にboard dirを作らない。
- creatorは同root内tempをO_EXCL/O_NOFOLLOW・0600で作成し、held fd/inodeを検証してwrite+fsync、
  link(temp,final)でno-clobber公開する。final/held fdのinode一致とnlink2を確認してtemp unlink、
  final nlink1を再確認してroot fd fsync。途中失敗時root/temp/finalをcleanupして再試行可能にしない。
  readerもstable root/file fd・uid/mode/nlink1/inode/exact bytesを検査し、file fd fsync→root fd fsync→
  同root/file/inode/bytes再検査後だけ成功する。公開途中nlink2は拒否してよい。厳密UTF-8と4096bytes上限。
- singleton取得には採択済みSidecarLockを使う。返却前のthrowのFD回収はprimitiveの責務。
  SidecarLockBusyErrorだけ非fatal競合拒否とし、その他はfactoryのsticky fatalにする。
  返却後の検査失敗は取得済みraw lockを強参照でprocess終了まで保持し、unlock/close/再取得しない。
- factoryはopaque host leaseとしてhostIdentityDigest、assertAuthorityHeld()、receiptStore、
  closeAfterAllLanesDrained()だけを返す。SidecarLock互換wrapperは内部だけに隠しreceiptへ注入する。
  guardは取得時home/ancestor/root/board directoryとidentityのinode・uid/mode/exact bytesを照合後、
  underlying assertOpenAndLockedを実行する。失敗は一次causeをsticky保持し以後のguard/close/再初期化を
  同causeで拒否する。通常closeはunderlying closeを1回だけ呼び、close失敗を正常終了にしない。
  release capabilityをD1/channel/lane controllerへ渡さず、hostが全lane drain/owner退役完了後だけ呼ぶ。
  factoryはDBへ書かず、既存receipt reserveとcoordinatorのreceipt先行DB mutation順序を維持する。

#### 78.10.2 一度限りの登録claim

- host内部専用 `RelayOwnerAuthority` が `issueRegistrationClaim` / `activateRegistration` /
  `retireRegistration` を持つ。D1の3 HTTP endpointへ登録操作を足さない。
  claim発行/消費はhost-owned lane controllerだけが行い、D1/hook/channelへraw Registry/registerを渡さない。
- candidateはhostがfresh native identityを実観測して構築する。purpose(initial/restart/handoff)、
  canonical sessionId、provider/server/host/boot epoch/generation、native evidence digest/timeを束縛する。
  §78.8のnamespaceを変換しない。callerのverified flagや旧enable/bindingだけでcandidateを作らない。
  relayId/claimId/claim secretはhostが新規発行する。secretはhashだけ永続化しログ/boardへ出さない。
- initialはsession HWM無し、restartはdurable maxと同generationかつlatest registration一致、
  handoffはmaxより高generationかつ旧activeのdrain/retire完了を要求する。
  現host epochの未消費・未期限切れclaimだけを消費できる。低generation/旧epoch/旧relayId/再消費は拒否。
  同provider processのrestartでもfresh再観測と新claim/new relayId/new tokenを要する。
- durable状態はinstallation(board/adoption/host identity、hostEpoch、authorityRevision)、
  session authority(BINARY session PK、token HWM、maxGeneration、latestRegistration、revision)、
  claim(hash、full binding、purpose、native evidence、expected token/generation/revision、expiry、
  issued/active/retired/cancelled state、assigned token/consume/retire情報)へ分ける。
  session単位active partial uniqueと(session,relayId) uniqueを持たせる。
  token/generation/revisionはsafe integer範囲、overflowは副作用前に拒否する。
  hostEpochはevenTerminalBootEpoch文字列と別の正safe integerとし、初回は1。
  installation authorityRevisionとsession/claim revisionを混同しない。初回adoptionは
  authorityRevision未存在から1、session token HWM未存在から1とし、永続値0は導入しない。

#### 78.10.3 DB rollbackを越えて番号を再利用しない

- receiptの `revisionFloor` はDB commit後のmirrorではなく、**DB mutation前の予約**である。
  lock下で現DB revisionとreceipt floorの一致を確認し、次revisionをreceiptへdurable publishしてから、
  DBをそのrevisionへ更新する。adoption/claim発行/consume/retire/host epoch変更もこの順序に従う。
  不正input/期限切れ/世代不一致/active conflict/overflowは予約前に検証して副作用なしで拒否する。
  DB transaction内のCAS再検査で前提不一致を検出した場合は、予約済みfloorを戻さず復旧gateへ閉じる。
- receiptはboardInstanceId/adoptionId/host identity/revisionFloorを保持する。secure exclusive temp作成→
  write→file fsync→atomic rename→final identity照合→parent fsyncを行い、前後でlock/parent guardする。
  DB transactionはclaim CAS、active conflict、generation/overflow検証、HWM/claim/revision更新をまとめる。
- DB commit後、DB revision===receipt floorを再確認してからvolatile登録、enable/binding、readyを公開する。
  receipt先行後のDB失敗/不明はhost down・lock保持・復旧gate。DB先行も通常起動では拒否する。
  番号を欠番にした後、古いDB copyからその番号を再発行しない。receiptを下げて復旧しない。
  host再起動時の旧epoch activeはretired(host_restart)にし、active state/eventを暗黙復元しない。
- StoreのIMMEDIATE transactionで現行CAS/意味条件を検査した後、最初のDB更新前にhost専用の
  同期beforeMutation(previousAuthorityRevision,nextAuthorityRevision)を一度だけ呼び、receiptを予約する。
  expiryはcallback前の単一transaction時刻で判定し、予約中の時刻経過で通常rejectへ変えない。
  commit後はreadInstallationでglobal authorityRevisionを再読し、その操作のnextAuthorityRevisionと
  receipt floorの一致を確認する。commitから再読・volatile公開までは同process直列・awaitなしとする。
- volatile Registryへのhost専用publishはDB確定tokenをそのまま採用し再採番しない。既存local HWM以下、
  generation rollback、失効済みを含む旧registration残存は公開拒否し、hostがfatalへ倒す。
  exact identity/fenceのretireはlease失効後も可能で、registrationとingressを消しlocal HWMを維持する。
  既存register互換は保持するがproduction向け型に登録/publish/retireを公開しない。

#### 78.10.3.1 Store登録authorityの詳細（2026-09-07）

- 配送記録のRelayControlPersistenceや運用者read viewと別のhost専用RelayOwnerAuthorityStoreを使う。
  readInstallation/readSessionAuthority/readRegistrationClaimとadoptInstallation/advanceHostEpoch/
  issueRegistrationClaim/activateRegistration/retireRegistrationを持ち、read結果へclaim secret hashを出さない。
  既存RegisterRelayInputのsessionIdとproviderSessionIdの両方を保持し、namespace変換をしない。
- sessionのHWM/maxGeneration/latestClaimIdは未成立なら全NULL、成立後は全非NULLとする。latest claimの
  full binding/token/stateを登録の正本にし、(session,latestClaimId)の複合FKで別session参照を拒否する。
  sessionごとのactiveとissuedのpartial uniqueを各々持つ。claimId重複と(session,relayId)重複は予約前に拒否する。
- issue時に未期限切れissuedまたはactiveがあれば拒否する。期限切れissuedのcancelと次claim発行は
  一つのauthority mutationで行う。issueはsession revisionだけ進め、発行後revisionをclaimのexpected値へ保存する。
  initialのsession revisionは1で、HWM/max/latestはまだNULL。claim revisionは1から始める。
- restart/handoffのexpectedPreviousRegistrationは旧ownerのfull fence完全一致に用い、fresh candidateとは分ける。
  restartはlatest retiredと同generation、handoffはexact latest retired(handoff_drained)・drain evidence・高generation。
  candidateは新relayIdとfresh観測を持ち、旧boot epoch/providerSessionId/server等の一致を誤って要求しない。
- activateはissued/current epoch/hash/expiry/expected HWM/max/session revision/active不存在を一括検査し、
  tokenを未成立から1またはHWM+1として確定する。retireはlatest active/full fence/claim revision完全一致で、
  lease期限を条件にしない。epoch変更は全activeをhost_restart退役、全issuedを取消し、HWM/max/latestを保持する。
  各影響sessionのrevisionは一回だけ進め、global/epoch/claim/session全更新のoverflowを予約前に検査する。
- host入力nowを単一transaction時刻としてsnapshotし、callbackをまたいで取り直さない。callback開始前は
  DB write 0、callbackは一度だけ同期実行し、thenable返却やauthority mutation再入を拒否する。
  inputは内部snapshot化しcallbackに渡さない。callback開始後の例外はmutation-uncertainとして通常rejectと区別し、
  hostが実receipt予約結果を保持する。後続DB失敗を補償するreceipt rollbackは提供しない。

#### 78.10.4 facadeと停止

- D1にはauthorizeObserver/authorizeOwner/recordUncertain/ingest/ack等の必要操作だけを持つprivate facadeを
  渡す。raw RelayRegistry、register、claim操作を型面でも公開しない。全facadeはsingleton guardの
  開始直前/await復帰後/response・enable・binding公開直前検査を通す。失敗は全facadeをpoisonする。
- 最小初期版ではhot epoch切替を提供せず、lane down→新規操作拒否→in-flight drain→retire→host終了→
  明示再登録とする。入力の自動replayはしない。重要出力/確認待ちと入力sending/uncertainを混同しない。
  current owner照合に失敗した旧fenceを§78.5の報告へ復権させない。
- native ownership unknownや不明settlementでは正常cleanupへ戻さず、lock/reservationを保持する。
  新hostはexact owner process終了とkernel lock解放後だけ開始できる。
  別process singleton競合、同session両lane競合、claim再消費/旧世代拒否、receipt前後crash/DB copy rollback、
  公開直前drain競合、unknown lock保持をprivate fixtureで検証し、最後に両provider実G2 gateを通す。


#### 78.10.4.1 D1 private host facadeとdrain（2026-09-07）

- D1はRegistryを生成・公開せず、同期authorizeObserver/authorizeOwnerと非同期recordUncertainの
  private host portを注入する。recordUncertainはcurrent owner照合と永続記録をhostの一つのin-flight
  operationに含める。D1に成功/dedupe cacheを残さず、各requestをhostへ渡す。ownershipLookupはhost内部。
  observer responseは既存decision全体、ownerはstatusと{}、uncertainはdeny statusと{} / allow 200とresultだけ。
- D1はadmissionと既受理continuationを区別する。stop/poison/unknown開始stack内で新規admissionを閉じる。
  handler起動前にsettlement PromiseをSet登録し、body readからresponse/error/destroyまで全体を追跡する。
  正常stopはserver close成功と既受理handlerのsettlementを待つ。request/host portのasync contextからの
  start/stopはstate変更・cleanup開始前に拒否し、handler→stop→handlerの自己待ちを作らない。
- hostへの同期lifecycleはstop_requested / normal_poison / ownership_unknown / drainedを各kind一度だけ
  通知する。onceはcallback前に記録し、通常poison後のunknown昇格は独立に通知できる。drainedはserver
  close成功と全handler settlement後、lane lock解放前。unknownではdrainedを出さない。
- lifecycle callback throw/thenable返却（then getter throw含む）/callback内start・stop再入はstickyな
  lifecycle settlement unknownへ移す。再入attemptはcallbackが例外を握り潰しても正常復帰後に検出する。
  native unknownを捏造せず、内部causeを保存しSOCKET_PROBE_FAILEDで拒否し、正常cleanup/再startへ戻さない。
  unknown/lifecycle unknownではlock/reservationをexact owner process終了まで保持する。
- cleanup許可はserver close成功・全handler settlement・drained callback正常復帰と再入/thenable検査成功の
  正の条件でのみ確定する。hostは停止通知内で全facadeを即閉鎖し、drained内でexact retireを同期完了する。
  guard失敗後pathname操作禁止、既存closeServerOnceの一度性とnative ownership/cause保持は維持する。


#### 78.10.4.2 Registryのprovider別epoch（2026-09-07）

- production hostは1つのRegistryでcanonical-sessionのactive/token HWM/maxGeneration/ingressを共有し、
  provider別immutable boot epoch mappingを使用する。providerごとにRegistry/同session counterを分割しない。
  mappingは既知provider keyのみ・1件以上・各epoch非空、両provider構成時はepoch相違を要求する。
  Codex限定pilotではCodexだけを構成でき、未構成laneのepochを捏造しない。未構成providerは拒否する。
- legacy single-epoch options/register APIは維持する。新multi-lane optionsとの同時指定/両方欠落は拒否する。
  mappingはconstructorで検証・private copyし、callerの後続変更やprovider追加でhot切替しない。
  runtime照合はprovider/host/epochの組で行う。bootEpochFor(provider)は構成済みproviderの値だけを返す。
- legacy evenTerminalBootEpoch getterはlegacy modeだけで従来値を返し、multi modeはINVALID_CONFIGURATIONで
  拒否する。片lane値へfallbackしない。host/coordinatorはprovider別lookupとlane-bound authorization viewを
  用い、D1にraw Registryを公開しない。providerをまたいだ同sessionの競合/HWM規則は既存どおり維持する。

#### 78.10.4.3 Coordinatorのlane/owner facade（2026-09-07）

- 単一RelayAuthorityCoordinatorのprivate Registryからlane-bound createControlPortとowner-bound
  createRuntimePortを作る。前者は§78.10.4.1の3操作、後者はheartbeat/ingest/acknowledgeだけ。
  raw Registry/Store/register/claimを外へ出さず、lane/owner inputは検証後private copyする。
  laneはprovider/固定host/provider別boot epoch/canonical server URLを束縛する。
- facade生成と各操作はsingleton guard・DB/receipt現状態照合に加えready phaseかつadmission openを
  必須とする。未ready/正常closedは副作用前にINVALID_INPUTで拒否する。observerのtranscript-only
  経路も未readyから許可しない。issue/activateにもadmission条件を追加し、通常closed後retireは許す。
- observerはprovider/host/epoch/requestingServerUrlのlane一致をownership lookup前に要求する。
  URL不正はinvalid_input、他laneはstale_or_foreign_registrationで409/owner:null/lookup0。
  正laneだけ既存判定と実Store ownership projectionへ渡し、既存transcript-only allowed.owner:nullを維持する。
  ownerは入力のprovider/host/epochとallowed ownerのcanonical server URLをlaneに一致させる。
  不一致はowner_conflict/active_owner_conflict/409とし、他laneのownerを公開しない。
- recordUncertainは毎回delivery_uncertain_checkで現在fenceを照合し、allowed ownerの全lane属性を
  固定bindingへ照合してから同期RelayControlPersistenceへ記録する。初回/duplicateで認可を省略しない。
  owner照合→同期Store→result検証→帰路guard→admission/fatal再検査を同stackで完了し、戻り値だけ
  Promiseへする。Promise.thenへ記録を遅延せず独自async writer/drainを追加しない。
  Store失敗は帰路guard後reject、異形resultはsticky fatalとする。再実行や成功への読み替えをしない。
- 全facadeを既存mutationInFlightの同期再入防止へ含め、allow/deny/throwの全帰路でguardを通す。
  closeAdmissionsは最初に閉鎖latchを不可逆に立て、guard中も共通busyを保持する。
  既closedでもbusy検査より先にreturnせず、通常closed後retire中のclose再入もfatalにする。
  callbackが再入例外を握り潰してもfatalは解除せず、allowや正常cleanupを返さない。
- provider別Registry optionsを利用し、issueのepoch照合はbootEpochFor(candidate.provider)を使う。
  未構成providerはStore/receipt mutation前にINVALID_INPUTで拒否する。既存adopt/advance/activate/retireの
  authority transaction/receipt予約/volatile公開本体をこのために書き換えない。
- 後続hostはactivate結果の全ownerをsessionIdごとにlane/exact fence/expected claim revision付きで追跡する。
  全admission閉鎖後、各D1のdrained callback内で当該laneの全ownerを同期retireしてから返す。
  全D1停止成功とowner map空はsingleton解放の必要条件であり、十分条件は§78.10.4.4に従う。
  最初のlane lockを先に解放してから
  他lane drain後にretireする順序は認めない。retire失敗はcallback failureとしてlock保持へ移す。


#### 78.10.4.4 host lifetimeとnative controller（2026-09-07）

- core host、provider controller、CLI/専用entryを分離する。controllerはnative spawn/観測/停止を担当し、
  raw Registry/Store/receipt/authority releaseを受け取らない。Codexのevidence用controllerやWS close、
  Claude pluginのsocket close/process.exitCodeをproduction exact exit証拠に昇格しない。
- fresh native観測がclaimより先に必要なため、hostは副作用なしでcontroller handleを作り、immutableな
  attemptId/laneとstart settlementを所有mapへ登録してからstartを呼ぶ。全spawn/socket意図を副作用前に
  inventoryへ記録し、実PID/start identity/parent/PGID/socketを束縛する。claim無しの失敗もmapから落とさない。
- activate直前にattemptをactivatingへ記録する。activate throw、または成功後のclaim再読失敗/不一致は
  activation unknownをsticky保持し、claim無しattemptのcleanup成功としてreleaseしない。
  activate直後の同同期stackで元claimIdを実Storeから再読しnonnull/active/claimId/full owner/assigned token/
  hostEpoch/registration一致を照合して実claimRevisionをowner mapへ保存する。前後guardを必須とし、
  発行revision+1を推定しない。Registryはcoordinator内で公開済みであり二重publishしない。
  host外部binding/enable公開はこの記録後だけとする。
- lifecycle callbackはhost公開禁止latchを先に立て、coordinator.closeAdmissionsをtryし、失敗を一次causeへ
  保存、finallyでroot事前登録stopRequestedをresolveする。closeAdmissions失敗はその後再throwしてD1の
  lifecycle settlementをunknownに保つ。callbackからD1.start/stopを呼ばず、queueMicrotaskによるrequest
  context持越しも使わない。pumpはD1 start前のroot文脈に登録する。
- root pumpは全controllerへrequestStopを先に発行する。各handleのthrowを捕捉しても残る全handleへ発行する。
  controllerはreturn前に不可逆stop latchを立て、以後は新しいspawn intent/fork grant/exec release/
  activation publicationを発行しない。hostもclaim/activate/外部publish直前で公開禁止latchを検査する。
  次にattempt別の期限付きstart settlementを待ち、timeoutは
  unknown+host failedへ固定する。cleanupはstart Promiseへ従属させず期限付きで行う。遅れてstart成功しても
  新規公開をせず既存inventoryだけをexact cleanupする。timeoutを停止成功と扱わない。
- 起動許可の線形化点はcontrollerのgrant/release発行時点であり、別processの物理fork/exec時刻ではない。
  intent→一度限りfork grant→exact child bind→exec releaseの発行・settlementをattempt inventoryへ保存する。
  latch前に発行済みのfork grant/exec releaseはin-flight start settlementで、helperがlatch後にfork/execする
  可能性を認める。pipe内へwrite済みのreleaseをcloseで取り消したと扱わない。発行済みcapabilityの
  exact bind/abort settlementだけはstop後も期限付き受理し、同attemptの所有から外さずstop/観測を行う。
  late Readyをclaim/activate/publishへ昇格しない。未確定identity/未解決intent/期限超過/部分観測は
  Cleanup.unknownとしてsingletonとreservationを保持する。inert forkだけを例外化して発行済みexec
  releaseの遅延実行を無かったことにしない。latch後の新grant/release発行は常に禁止する。
- 成功開始D1のstopと全controller cleanupをrootから要求し、各D1 drained callback内で当該lane全ownerを
  同期retireする。成功したownerだけmapから削除する。D1 start failure、retire失敗、ownership unknownを
  cleanへ戻さない。D1 lane lockのcleanupは既存D1契約に従い、board singletonは下記条件まで保持する。
- D1 start/stopにもcontrollerとは別のdeadlineを設け、元Promiseをlane recordへ保持したまま観測だけを
  timeoutさせる。starting中のD1へstopを先行発行しない。start timeout後の遅延成功はroot文脈から
  stopを一度開始し、stop timeout後も元Promiseのsettlementを観測する。host timeoutはsticky failedとし、
  遅延成功をpublic stop成功やsingleton解放へ昇格しない。遅いdrained callbackも当該laneのexact ownerを
  同期retireし、成功時は正常returnする。host timeoutだけをcallbackから再throwしてD1をpoisonしない。
  retire/guard/closeAdmissions失敗は従来どおりthrowし、全laneが後でdrainしてもhost singletonは保持する。
- planned whole-host handoffはstop({mode:"handoff"})を使い、通常stopとは最初の同期呼出でplanを固定する。
  同modeだけ保存Promiseへjoinし、異modeは副作用なしで拒否する。handoffでは全producer exact cleanupを
  先に完了して証拠材料をfreezeし、その後D1 stopへ進む。各drained callback内でlane/activation/producer
  exit証拠/board/adoption/host identity/handoff stop idと当該D1 drain時刻をcanonical JSONへ束縛してhashし、
  handoff_drained理由とdigest/drainedAtで同期retireする。public成功結果へpayload/digest/full previous ownerを残す。
  cleanup unknown/期限超過、または証拠材料完成前の自発drainではhandoff eligibilityを不可逆に落とし、
  callbackはnormal_shutdownかつdrain evidence nullで退役する。正常retire後はreturnするがpublic handoffは
  rejectしsingletonを保持する。遅い成功でhandoffへ戻さず、通常退役を高generation後継の根拠にしない。
- controller cleanupはhost-supplied exact attempt identityに束縛したverified_exited/unknownの判別union。
  active時はclaimId/実claimRevision/full owner/nativeEvidenceDigestと実process-start identityへ追加束縛する。
  activating/activation unknownはrelease 0。verified_exitedにはfencedな全process/group/socket/関連tmuxと
  未解決intent無しの観測証拠digest/timeを要する。単なるPromise resolve/stop signal/部分cleanup/異形result/
  identity不一致/期限切れはunknown。hook/pluginの別processも同attemptのinventoryへ含める。
- 全D1 stop成功・owner map空・全attemptのexact producer exitが揃ってから、verifiedなattemptのledger
  reservationだけを解放し残0を確認、authority guard成功後にのみopaque leaseをcloseする。
  unknownやstart/retire/cleanup/release failureならsingletonと未解放reservationを保持する。
  ledger scopeはboard+canonical sessionの継続identity、activationはfull fence付き一回の起動identityとして
  区別し、owner退役だけで書込み停止を証明しない。coreはprocess.exitせず、外側専用entryが終了を担う。

#### 78.10.4.4.1 初回native session確定と予約

- startAttemptのtargetはnew_native(launchKey)またはresume(sessionId)の判別unionとする。
  new_nativeはpurpose=initial/expectedPreviousRegistration=null、resumeはpurpose=restart|handoffと
  同session/provider/laneのexpectedPreviousRegistrationを要求する。generationの既存Store条件は維持する。
- new_nativeのlaunchKeyは外側bootstrapが同一論理起動要求へ一度発行・保持するopaque識別子で、
  hostはlane+launchKey予約とattempt/start settlementをcreate前に所有する。同key再要求はcreate0で拒否。
  仮canonical IDやcontroller外prelaunchは使わない。resumeは従来どおり既知sessionをcreate前に予約する。
- AttemptIdentityはattemptId/lane/handoverGeneration/targetのimmutable snapshot。Readyにはnativeから
  観測したobservedSessionIdとproviderSessionIdを別々に保持し、無変換でcanonical IDを使う。
  一律等値強制/相互導出をせず、resumeだけobservedSessionId===target.sessionIdを要求する。
- new_native Readyのexact attempt/identity/evidence検査直後の同同期stackで停止latchを確認し、session
  reservationをclaim/activate/publish前に取得する。late Ready/停止後はsession予約取得0/claim0/publish0。
  controller start後のReady不正/ID競合/resume不一致は一次cause保持とwhole-host stop pumpを開始する。
  ID未確定/競合attemptも元AttemptIdentityとnot_activatedに束縛してcleanupする。他attempt予約を消さない。
- 予約解放は全D1停止/owner map空/全attempt exact verified後のglobal release passだけとし、予約の
  owner attemptIdを完全一致させる。session未取得attemptは自身のlaunchKeyのみ、取得済みは自身の
  launchKey/sessionのみ解放する。unknownは未解放予約とleaseを保持する。claim/retire/handoff証拠の
  sessionIdは観測確定値へ束縛し、AttemptIdentity.targetを途中で書き換えない。

#### 78.10.4.5 Claude channel bindingと現D1 wire（2026-09-07）

- pluginはhost-owned activationとしてだけ起動する。binding schemaVersion=2はexact fields
  enabled/owner/ledgerScopeId/activationId/socketPath/relayControlSocketPath/dedupePath/pluginRoot/pluginSha256
  を持つ。ownerはsessionId/providerSessionId/provider:"claude"/serverUrl/host/evenTerminalBootEpoch/
  handoverGeneration/relayId/fencingTokenのfull fence。serverUrlはhost確定canonical値をそのまま使い、
  direct sentinelをURLへ補完しない。bindingは候補identityであり、静的fileだけで認可成功にしない。
  sessionIdとproviderSessionIdを相互導出/等値強制しない。claimId/revision/hostEpoch/processStartsは
  hostがactivationId材料として保持し、plugin bindingへ重複fieldを増やさない。
- pushはschemaVersion=2、idempotencyKey/owner/content/optional meta。ownerは上記full fenceでbindingと
  全field一致を要求する。旧binding/push schema1とledger schema2は暗黙変換せず拒否する。
  旧ledgerを削除して空に作り直すことは禁止。明示移行・保全はhost統合gateに残す。
- ledgerScopeIdはcanonical JSON配列["hachi-channel-ledger-scope-v1",boardInstanceId,sessionId]のSHA256
  lowerhex。activationIdは["hachi-channel-activation-v1",ledgerScopeId,attemptId,claimId,claimRevision,
  hostEpoch,fullOwnerFence,nativeEvidenceDigest,canonicalProcessStarts,socketPath,relayControlSocketPath,
  dedupePath,canonicalPluginRoot,pluginSha256]の同hash。object keyは再帰的辞書順、processStartsはintentId順。
  enabled/lease expiry/現在時刻をactivation hashに含めない。pluginはopaque activationIdとfull owner/
  runtime path/pinのstartup snapshotを保持し、再読時全field照合する。enabled=falseは常に拒否する。
- 最小ledger schema3はexact schemaVersion:3/ledgerScopeId/sessionId/entries、各entryはeventId/state
  (sending|delivered)のみ。activationやgeneration変更でsendingを失わない。scope/sessionをbindingへ
  exact照合する。hostはscope/pathを単一activationへ予約し、旧plugin全関連processのexact exit確認後だけ
  次activationへ渡す。TTL/owner退役/ファイル消失はwriter停止証拠にしない。unknownではreservationと
  singletonを保持する。process内mutexを別process排他の代替にしない。
- 同eventはledger判定より先にcallerごとの処理順を直列化する。先行Promiseの結果を後続callerへ
  duplicate成功として共有しない。各callerはlock内で自身のbinding/fenceをdynamicに照合する。
  absentでは自身のsendingを永続予約してnotify直前にowner_checkし、認可拒否なら自予約だけ解除。
  先行stale拒否後のactive後続は状態を読み直して一度だけ配送する。deliveredは認可後だけduplicate。
  sendingはnotifyを再実行せずcurrent fenceでuncertainを再報告する。報告成功でもDELIVERY_UNCERTAIN、
  失敗はRELAY_UNAVAILABLEとし、sendingをdelivered/duplicate成功へ変換しない。
- startup sending再報告も同event直列化とcurrent binding/fence照合を通し、fresh activationは自身の
  fenceで旧sendingを報告する。旧送信ownerを復元・復権させない。observedAtは報告時の非負safe integer
  Unix秒を生成し、wireで単位変換しない。報告失敗後もledgerを保持して次の試行で再報告する。
- clientはPOST /v1/authorize/ownerへ§78.4の7fieldだけ、POST /v1/delivery/uncertainへ§78.5の7fieldだけを
  送る。providerSessionId/serverUrl/schemaVersionなどをD1 wireへ追加しない。ownerは200+exact {}だけ
  成功、uncertainは200+exact {recorded:true,duplicate:boolean}だけ成功。409/503+exact {}は拒否、
  その他status/body/未知field/不正JSON/期限超過はprotocol failureとして閉じる。active owner取得endpointを
  新設・仮定しない。pluginへ@hachi/core依存を追加せず、実D1 UDSとのwire受入を局所testで確認する。
  bundle/pinの生成と実native起動、PC/両provider実G2往復は別のhost統合受入を必要とする。

#### 78.10.4.6 G2入力のCore受付台帳（2026-09-08）

- CoreにRelayInputAdmissionStoreとprovider-bound coordinatorを分離して設ける。SqliteKanbanStoreが実SQLを所有し、
  専用moduleは型/validator/row mapperだけを持つ。D1の3endpoint・observer prompt拒否は変更しない。
  本節はCoreの永続化契約であり、HTTP公開/状態wire、provider adapter、実G2受入の許可ではない。
- v33でrelay_input_receiversとrelay_input_admissionsを追加する。receiverは非空opaque receiverInstanceIdをPK、
  board/adoption/host identity・hostEpoch・claimId/claimRevision・full owner snapshotとopen/closedを保持する。
  hostだけがnative binding/transport確認後にopen portを呼ぶ。Storeは同一IMMEDIATE transaction内でinstallation、
  session.latestClaimId、active claim/実revision/full ownerの完全一致を再確認し、hostの同期guardをwrite直前に呼ぶ。
  guard throw/thenable/reentrant mutationはwrite0に倒す。DB単体がnative readyを証明したと扱わない。
- admit/beginSend/rebindQueuedは同じDB transaction内で上記authority照合、receiver open、状態のCASを行う。
  別connectionのowner変更が照合とwriteの間に割り込まない。authority不一致・closedは副作用0で拒否する。
  receiver閉鎖はopen→closedの不可逆CASで、古いreceiverを再openしない。closeはowner退役後もexact receiver
  identityに束縛したprivate host portから実行できる。closedで新admit/new beginSendは常に0。
- admissionは非空opaque admissionIdをPK、provider、canonical/native session IDs、full owner snapshot、
  originalReceiverInstanceId/currentReceiverInstanceId、sourceKey nullable、inputText、state、sendAttemptId nullable、
  providerReceipt nullable、createdAt/updatedAtを保持する。時刻は非負safe integer Unix秒、counterは正safe integer。
  task FKや既存task/event/commentのmutationは作らない。原宛先/世代/本文/sourceKey/original receiverはimmutable。
- sourceKeyは1〜128 ASCII英数字/underscore/hyphen。非null (provider,sessionId,sourceKey)へBINARY partial UNIQUEを置く。
  同keyはそのcallerのcurrent authority照合後、同一TXで原記録の世代/full owner/本文の完全一致を確認して原receiptを返す。
  異なる内容/世代はconflict。他のDB制約/例外をduplicate成功へ変換しない。key無しは毎回新admissionで、
  本文hashをdedupe keyにしない。sourceKeyが存在しても初回処理以外のcaller認可を省略しない。
- inputTextは1〜16384 Unicode code points。同sessionの全記録上限は初期実装では1000、上限時は新規受付0。
  既存同keyの認可済み再読は上限で拒否しない。既存記録を追い出さず、自動削除/TTL失効を実装しない。
  本文はdispatch専用private portだけへ返し、logger・event・comment・一般read面へ出さない。
- stateはqueued/sending/provider_accepted/uncertain/rejected/cancelled。admitはqueuedをdurableにcommitしてから返す。
  不変receiptは{admissionId,sessionId,provider,receivedAt}で現在stateを含めない。state照会は別snapshotとする。
- beginSendはqueued→sendingをcommitし、一回だけsendAttemptId付きdispatch permitを返す。sendAttemptIdは
  非空opaque unique IDであり、別admissionに再利用できない。重複beginSendはpermit0。
  許可発行を線形化点とし、発行済みpermitの物理送信がclose後に起こり得ることをinflightとして保持する。
- settleSendは(admissionId,sendAttemptId,state=sending)へCASし、provider_accepted/rejected/uncertainの一つへ一度だけ確定する。
  timeoutとACKが競合しても既確定stateを上書きしない。unknownから自動成功化/再送しない。遅延ACKは将来の別観測面へ
  残す対象であり、本節のsettleはchanged:falseで現在stateを返す。providerReceiptはopaque非空IDのみで本文/secretを含めない。
  close/owner退役後も元sendAttemptへのsettlementを許し、新ownerを借りてbeginSendすることは許さない。
- cancelQueuedはqueued→cancelledだけを許す。sendingの取消を未送信表示へ変換しない。復旧処理はclosed receiverに属する
  sendingだけをuncertainへCASし、自動再送しない。起動時に他の生存receiverのsendingを一括変更しない。
- rebindQueuedは明示操作だけとし、queued/同session/full owner/generationと新receiver openを同一TXで確認して
  current receiverだけをCAS更新する。original receiverは保持する。generation変更時の移送・原宛先書換えは禁止する。
  同generation再接続でも自動dispatchしない。別receiverのcloseが新receiverの記録を巻き込まない。
- read portは単件とsession完全一致一覧を提供し、admissionId/宛先/状態/時刻だけを返す。inputText/sourceKey/
  fence token/providerReceiptを返さない。createdAt DESC,admissionId BINARY ASC、limit既定100/1〜1000。
  不正行をfilterして隠さずthrowする。既存KanbanReadView/CLI/HTTPへの公開は次の別実装で行う。
- 同Storeの入力mutationとauthority mutationの相互再入を拒否する。guard内で例外を握り潰した再入も失敗としてlatchし、
  外側transactionをrollbackする。入力writeでauthorityRevision/claimRevisionを勝手に進めない。
- 実Storeの二connection/再open、owner更新との競合、同key同時受付、正当同文2件、二重beginSend、close前後permit、
  ACK/timeout両順序、旧receiver再開、旧generation拒否、sending復旧、上限、DB/guard失敗を試験する。
  Core greenをHTTP/provider/G2会話成立やcontroller exact終了の証拠に昇格しない。

#### 78.10.4.7 private入力coordinatorとhost接続（2026-09-08）

- RelayInputAdmissionCoordinatorを独立moduleに置き、RelayHostLifetimeがauthority coordinatorと並列に所有する。
  authority coordinatorの同期mutation lock内でasync provider送信を待たない。HTTP/D1 endpoint変更、実provider
  RPC、CLI公開は本節に含めない。入力本文・sourceKey・raw fence・Store・dispatch permitを外部へ出さない。
- host optionsへoptionalなinputAdmission={store,sendTimeoutMs}を追加する。未設定では入力coordinator/receiverを
  作らず既存hostを維持する。設定時はauthorityStore/persistence/inputAdmission.storeのobject同一性を要求する。
  timeoutは正safe integerかつtimerで表現可能な上限2147483647ms以下。無効設定は副作用前に拒否する。
- controller handleへoptional prepareInputTransport(publishActivationと同じ入力)を追加する。入力opt-in時は必須で、
  inert handle作成・attempt inventory登録後、native start前に存在を検査する。既存start/activate/publish後にだけ
  呼び、startからの単一期限を再起算せず観測する。新nativeを起動せず既存attemptに属するtransportだけを準備する。
  transportの全socket/関連processは同attemptの既存inventory/cleanup契約に従う。遅い成功はreceiver公開へ戻さない。
- transportはimmutableに照合したfull ownerとsend(input):PromiseLike<unknown>を持つ。open時にowner snapshotと
  callable sendを一度だけcaptureし、後からtransport propertyを差し替えても採用しない。send inputは
  admissionId/sendAttemptId/provider/canonical sessionId/native providerSessionId/inputText/full ownerを束縛する。
  hostはprepare成功後、ownerMapのexact activationとtransport.owner、実Storeのcurrent installation/active claimの
  actual revisionを再照合し、stop/期限guard後にreceiverをopenする。receiverInstanceIdはhost生成の非空一意ID。
  openしたportだけをhost-private getInputReceiver(attemptId)で取得できる。wireからownerを自己申告させない。
- receiver portはadmit({admissionId,sourceKey,inputText,now})、dispatch({admissionId,sendAttemptId,now})、
  cancelQueued(admissionId,now)、close(now)だけを持つ。coordinatorはopenReceiver、同coordinator内のportだけを
  受け付けるrebindQueued、closeAdmissions、drainを持つ。raw Store/settle API/receiver fenceはportへ露出しない。
  admitはdurable receiptを返すだけで自動dispatchしない。重複admitも送信を起動しない。再接続rebindも明示操作だけ。
- 公開guardはlease保持、host running/stopPlanなし、coordinator受付open・fatalなし・receiver openを確認する。
  open/admit/beginSend/rebindとreceipt返却前に用いる。Store callbackでは外部guard呼出の前後にlocal latchを再検査する。
  coordinatorは同期busy latchを持ち、guard/Store再入を拒否する。close/closeAdmissionsはbusy検査より前に
  不可逆close latchを立てる。busy中はStore closeを再入させず、外側TX退出後に保留したcloseを実行する。
  guard内でclose再入を握り潰しても外側writeをrollbackし、permit/adapter呼出を0とする。
- continuation guardはlease保持とexact coordinator/receiver/sendAttemptだけを確認する。host停止、receiver閉鎖、
  owner退役、公開fatalを理由に既発行送信のsettle/receiver closeまで拒否しない。lease guard失敗や永続化不明は
  sticky settlement_unknownへ記録し、公開を閉じる。安全な他attemptのclose/settle処理は継続する。
- dispatchはStore beginSendを同期に一度呼び、permitがnullならprovider呼出0。permit取得直後にinflightを登録し、
  adapterを同期に一度だけ呼ぶ。permitのcommitを線形化点とし、その後のcloseは発行済みpermitを取り消さない。
  adapter呼出前に公開guardを再要求しない。adapter内stop再入時もinflightを失わない。sendAttempt二重呼出で再送しない。
- adapter結果はexact {kind:"accepted",receipt:<非空opaque ID>} / {kind:"definitely_rejected"} / {kind:"unknown"}。
  同期throw、reject、then getter throw、thenable異常、未知field/型不正、timeoutはunknown。adapterの通常異常だけで
  coordinatorをfatalにせずuncertainへsettleする。送信後の一般RPC errorをdefinitely_rejectedと推定しない。
- 送信観測はsend呼出前に期限を固定し、期限内の最初の結果を一度だけsettleSendへ渡す。acceptedはprovider_accepted、
  definitely_rejectedはrejected、unknown/期限超過はuncertain。timeout後の遅いresolve/rejectはconsumeだけ行い、
  二度目のsettle/再送/accepted化をしない。adapterのPromiseが未解決でも期限で観測を終える。
  settleのguard/DB失敗・異形Store結果はsettlement_unknownをsticky保持し、acceptedを返さず同じsettleを自動再試行しない。
  dispatch結果はmetadata stateまたはsettlement_unknownであり、inputText/fence/providerReceiptを返さない。
- close/closeAdmissionsは受付と新permitを同期閉鎖し、queuedを保持する。drainは当該coordinatorの既発行送信だけを
  期限付きで観測し、全settle成功かつreceiver close成功ならdrained、それ以外はsettlement_unknownを返す。
  drainはcloseAdmissions済みだけで使用し、未閉鎖なら副作用なしで拒否する。drainをprovider exact exitと読み替えない。
  process再起動後のreceiver列挙/復旧は未実装の別private read契約とする。
- host closeAdmissionsSyncはauthority側closeを先行し、成否にかかわらず入力側close latchも必ず立てる。
  §78.10.4.4の全controller requestStop先行を維持し、入力drainをその前へ挿入しない。requestStopを全件発行後に
  input drainを開始し、既存start settlement/cleanup/D1停止を妨げず、最終lease解放前にdrain結果を照合する。
  lane drainでは当該owner receiverをcloseしてから既存retireへ進む。close失敗は記録し他owner/controller cleanupを続ける。
  input settlement_unknown/close失敗はhostを失敗に保ち、全producer exact exitでもleaseを解放しない。
- 実Storeを用い、permit一回・正当同文・同keyretry・close/guard再入・send内stop・ACK/timeout両順序・遅い結果・
  settle失敗・rebind後の旧receiver close・opt-in無し互換・遅いtransport準備・全requestStop先行・input不明時のlease保持を
  検証する。mock transport成功を実Codex/Claude配送や両provider実G2会話成立の証拠にはしない。

#### 78.10.4.8 Codex専用queue transport（2026-09-08）

- @hachi/adaptersにCodexRelayQueueTransportを独立実装する。既存worker向けcodex-app-server-v2 schema、
  JSONL RPC、initialize既定、worker起動を変更しない。CLI 0.153.0の生成schemaとpinned sourceへ束縛し、
  Core実装関数へ依存せず型だけ参照する。ws@8.21.3/@types/ws@8.18.1はこのWS-over-UDS専用に使う。
- factory optionsはhostが供給する専用Unix socket path、connectionEpoch、runtimeVersion="0.153.0"、
  full owner(provider=codex、native providerSessionIdはUUID)、cwd、expectedCodexHome、expectedPlatformOs、
  接続/要求の正timeout、および同期assertBindingを持つ。env/既定socket/既存Desktop/PID探査から宛先を推定しない。
  factory作成だけではnative spawn/resumeを行わない。接続するのはhost inventory内の既存attempt endpointだけ。
  assertBindingはendpoint/attempt/connection identityの検査であり、発行済みpermitの公開受付guardと混同しない。
- socketはNode netの明示pathによるcreateConnectionで接続し、TCP/redirect/fallbackを許さない。WSのHTTP pathは
  /rpc、perMessageDeflate=false、UTF8検証有効、maxPayload=1048576。接続後close/errorは当該instanceの終端であり、
  同instanceの再connect/自動再送は禁止する。socket/connectionEpoch/full owner/cwdは作成時copyして固定する。
- initializeはclientInfo.name="hachi-g2-queue"、version="1.0.0"、capabilities.experimentalApi=trueを明示する。
  responseはcodexHome/Unix platformFamily/platformOs/userAgentを検証し、expectedCodexHome/expectedPlatformOsへ一致。
  userAgentは非空stringとして検査し、保存済みthread.cliVersionを実行中serverの版証拠へ使わない。
  server版はhostのnative起動証拠で確認する。initialized通知後にthread/read({threadId,includeTurns:false})を行う。
- ready条件はthread.id===owner.providerSessionId、cwd完全一致、status.typeがidleまたはactive、
  canAcceptDirectInput===true。同responseの別field thread.sessionIdからthreadIdを導出しない。activeFlagsは
  waitingOnApproval/waitingOnUserInputの既知値だけを許す。未知/未ロード/systemError/field欠落/nullはnot-ready。
  thread metadataのうち宛先/状態/直接入力可否を検証するprojectionであり、turn内容の全schema検証とは称さない。
- transport.sendは§.7と構造的に同じ入力/結果を持つ。admissionId/sendAttemptId/両session ID/provider/full owner/
  本文を確認してからattemptをcheckingへ同期登録する。1instance最大1000attempt、pending request最大32、
  上限は新送信0で拒否し既存記録を追い出さない。同attempt同内容は既存結果Promiseへjoin、異内容は送信0で拒否する。
- sendは同connectionでthread/readを再確認し、checking→dispatchedの一回CASとopen/connectionEpoch/pendingを
  同一同期stackで再検査してからqueue/addを一度だけws.sendする。closeが先ならqueue/add write0、dispatchが先なら
  既発行inflightとして扱う。遅いread応答や重複応答でclosed/terminal attemptをdispatchedへ戻さない。
  loaded確認後にunloadするTOCTOUは残るため、成功は指定threadへのdurable queue受付だけを意味する。
- queue/add paramsは{threadId:owner.providerSessionId,clientUserMessageId:admissionId,
  input:[{type:"text",text:inputText,text_elements:[]}]}。正当同文をhashでdedupeせず、clientUserMessageIdをproviderの
  冪等性保証と称さない。入力本文は1〜16384 Unicode code points。admission/attempt原宛先を変更しない。
- 成功responseはexact {queuedSubmission:{id,input,clientUserMessageId}}。非空id、追跡ID、単一textのtype/text/
  text_elementsの完全一致を検証する。text_elements省略だけは公式既定[]へ正規化する。成功resultは
  {kind:"accepted",receipt:queueId}。送信後error/reject/切断/timeout/壊れた応答は{kind:"unknown"}とし、
  server errorを一律definitely_rejectedへ変換しない。ローカルscope/入力/容量拒否だけは送信0のdefinitely_rejected可。
- JSON-RPCは一WS text message内の一objectとし、request IDの型と値を完全一致で相関する。idとresultまたはerrorを
  排他的に要求し、optional jsonrpcがあれば"2.0"だけ許す。batch/binary/壊れたJSONはcloseしてpendingをunknownにする。
  未知request ID/期限後responseはdiscardし、同ID再利用や別requestへの転送をしない。methodを持つserver request/
  notificationをqueue responseとして扱わない。承認/質問への自動回答は送らない。本文/secret/生RPC errorをlogへ出さない。
- closeは最初の同期stackでclosed latchを立て、checking/未確定requestをunknownへ収束してからWSを終了する。
  close中のlate handshake/read成功でready/queue送信へ戻らない。adapter socket終了はnative/controller終了証拠ではない。
  queue/start/delete/reorder、thread/start/resume/turn/startを不明結果の解消として送らない。
- tmp Unix socketの実WS fixtureでexperimental handshake/loaded照合、idとsessionIdの区別、exact receipt、
  duplicate send/合法同文、close中の遅いread、dispatch後切断、応答ID異型/遅延/重複、binary/JSON破損、timeout、
  capacity、scope mismatch、auth/approval requestを勝手に返答しないことを試験する。外部network/providerは起動しない。
  本節の局所成功をnative controller接続、再起動復旧、実G2会話成立へ昇格しない。


#### 78.10.4.9 オーケストレーター会話への接続と起動wrapper（2026-09-08ユーザー決定）

- 主目的はMac上の同一nativeオーケストレーター会話へPCとEven G2の両方から質問・追加指示・確認への
  回答を送り、返答・進捗・確認待ちを読むこと。G2 detach後もMac会話とworker作業は継続する。
  workerの起動完了・進捗・終了は看板の責務とし、G2が全worker/任意tool子プロセスの起動・終了を
  見届けることを会話接続の受入条件にしない。遠隔権限承認は引き続き別gateとする。
- Claudeは専用wrapperによるtmux+Claude Code起動とG2有効化を受容し、既存handoverの後継起動へ
  同じ設定を渡す。全Claude Code会話の既定有効化は理想だが必須ではない。通常claudeコマンドや
  global plugin設定を無断で置換しない。Codexも起動時opt-inを受容する。
- Codex Appの既存会話との連携は同じ責務分離で別途検討する。CLI app-server新規起動、保存履歴resume、
  App内agent専用toolの存在を外部G2から既存Desktop会話へ接続できる証拠としない。App連携の未成立で
  Claude wrapper/既存Codex経路を止めず、これまでの実装を土台として維持する。
- native起動だけではG2送信可能と表示しない。native identity、active orchestrator session/generation、
  provider入力口と返信観測の準備を照合してから公開する。G2接続準備の失敗だけで正常なMac会話を
  停止・作り直さない。PC会話は利用でき、G2は未接続と表示する。
- 本方式のG2/relayはnative/workerの終了・自動再起動を所有しない。切断時は新入力を閉じ、未送信/
  送信済み/送信結果不明を区別し、不明結果を成功にしたり勝手に再送したりしない。最終更新時刻/idleは
  接続・活動の参考であり、入力可能性や裏の作業停止の証拠にしない。
- §78.10.4.4の全descendant起動前inventory/verified_exitedはnative lifecycleを所有する既存host方式の条件。
  本方式ではnative/worker終了保証から接続の責務を分離し、会話接続をその未実装だけでblockedにしない。
  既存hostのunknownをverified_exitedへ変換する迂回、singleton/reservationの強制解放は禁止する。
  接続を所有する境界の実装ではrelay自身のwriter/socket/ledger所有と旧世代入力・返信拒否を証明する。
  生きた旧writerとの共有ledger再利用をnative終了保証の免除から導かない。
- 計画的引き継ぎは既存boardのhandover契約に従う。旧G2配信先を無効化し、後継会話の新identity/
  generationと送受信準備を確認してから公開する。旧宛先の未確定入力を新宛先へ自動移送しない。
  board世代交代/G2配信先切替と同一native会話の再接続を区別する。
- 両provider実G2複数ターン、PC会話継続、宛先世代一致、二重起動・重複送信・入力欠落防止、切断/
  引き継ぎ表示、再現可能な起動・接続解除手順の受入は維持する。本節は責務境界の採択であり、
  未実装wrapper/接続準備/App接続/実機試験の成功を意味しない。



#### 78.10.4.9.1 接続専用sessionのdurable scope（2026-09-08）

- 既存native_ownedとconnection_onlyの終了意味を混同しないため、DB v34でrelay_session_authoritiesへ
  lifecycle_mode TEXT NOT NULL DEFAULT 'native_owned'を追加し、両値だけのCHECKを付ける。既存sessionは
  native_ownedとして保存する。新規DBとv33以前からの移行を同じ列へ収束させ、migrationは一度だけ適用する。
  v31のCREATE TABLEが再実行されても列を失わない。scopeの変更・手動解除APIは追加しない。
- RelayIssueRegistrationClaimInputへoptional lifecycleModeを追加する。省略だけnative_ownedとして扱い、
  null/空/未知値はmutationとbeforeMutation callback前に拒否する。snapshotにmodeを固定する。
  session初回INSERTでmodeを保存し、既存sessionへの全purpose(initial/restart/handoff)では保存modeと
  要求modeの完全一致を同じIMMEDIATE transaction内で検証する。issued期限切れ、host epoch更新、retire、
  activation、rollback/reopenによってmodeを変更しない。不一致は既存INVALID_INPUTで副作用0の拒否とする。
- RawRelaySessionAuthorityRowは列の存在と既知値を検証する。破損/NULL/未知値をnative_ownedへfallbackしない。
  公開RelaySessionAuthorityへoptional lifecycleModeを加える。既存出力形状を維持するためnative_ownedでは
  propertyを省略し、connection_onlyでは必ずlifecycleMode:'connection_only'を返す。hostは省略だけを既存
  native_ownedと解釈し、不明値を受け入れない。新scope定数/型はrelay-authority-storeの公開exportへ追加する。
- scopeはcanonical sessionに固定する。connection_onlyからnative_ownedへ別モードで同じsessionを再開せず、
  新native会話は別canonical sessionとしてinitialにする。connection_onlyの同一session再接続は、旧ownerが
  retired、同generation、previous full fence一致、同scopeという既存restart条件をすべて満たす場合だけ許す。
  normal_shutdownという既存退役理由だけからnative終了を推定しない。modeはretire後も残す。
- 本工程はscope保存・照合のみ。connection-only host/factoryの起動やdetachを実装済みとはしない。
  native-owned既存入力は省略時の動作・出力形状を維持し、DB v33データの全既存列/行/foreign keyを保存する。
  両modeの初回issue、同mode restart、両方向cross-mode拒否とcallback0/revision不変、reopen後の保持、
  v33→v34移行の冪等性と既存行保持をtmp DBの実Store経由で試験する。実board DBへのSQLは発行しない。



#### 78.10.4.9.2 既存hostへの接続専用lifetime追加（2026-09-08）

- §.9.1のdurable scope実装・host統合を前提に、RelayHostLifetimeへoptional lifecycleModeを追加する。
  省略はnative_owned、connection_onlyはhost作成時に固定する。未知値を拒否し、途中変更はしない。
  既存native_ownedのnew_native/resume、非空processStarts、verified_exited、normal/handoffの意味は保持する。
  RelayNativeControllerAttemptIdentityにもmodeを固定し、scope省略は既存native_ownedだけの互換とする。
- targetへ{kind:'attach_existing',sessionId,providerSessionId,socketPath}を追加する。両IDは独立した非空値、
  socketPathはNUL無し絶対Unix pathとして検査し、immutable copyへ固定する。connection_onlyだけ受け付け、
  同modeではnew_native/resumeを拒否する。接続epochはhostが毎attempt発行するattemptIdとし再利用しない。
  factory/create前に既知sessionを予約する。同session二重attachはcreate0で拒否する。
- attach_existingのinitialはprevious=null、restartはprevious必須とし、previousのsessionId/providerSessionId/
  provider/host/serverUrl/evenTerminalBootEpochをtarget/laneへ副作用前に一致させる。handoff purposeはこの
  接続専用経路では拒否する。boardの後継が別native会話を開始する時は別canonical sessionのinitialとする。
  same canonical/same generationの再接続だけrestartとし、旧未確定入力を新receiverへ自動移送しない。
- Readyはactual live native観測を前提とし、observedSessionIdとproviderSessionIdをtargetの各IDへ独立に一致
  させる。connection_onlyのprocessStartsだけ空配列を許す（プロセス起動無しの接続）。native_owned条件は
  緩めない。接続factoryはnative start/resume/stopを行わず、startはlive観測とrelay接続準備だけを行う。
  provider固有endpoint/native観測の実装は後続factory工程で実証し、caller指定IDだけでReadyを作らない。
- coordinator.issueの既存input spreadを経てlifecycleModeをStoreへ渡す。activateの前後で既存claim/full owner/
  実revision照合に加え、readSessionAuthorityのmode（省略はnative_owned）もhost modeへ一致させる。
  保存scope不一致/未知値を成功にしない。DB v34以前のwriterとの同namespace並行稼働はpublication前に除く。
- cleanup unionにverified_connection_closedを追加する。attempt/activationContext/evidenceDigest/observedAtを
  既存と同じ厳密さで照合し、attempt.mode、attach targetの両ID/socketPath、attemptId(connection epoch)も
  一致させる。connection_onlyはこの結果だけ、native_ownedはverified_exitedだけをcleanとする。
  異scope結果や旧attempt/異endpoint/異epoch、malformed、timeoutはunknownへ倒す。
  verified_connection_closedをverified_exitedやnativeプロセス終了へ読み替えない。
- connection_onlyのstopはmode:'detach'を既定とし、native_ownedは従来mode:'normal'を既定とする。
  異scopeの明示modeは副作用前に拒否する。最初のstop plan固定・同mode join・異mode拒否は維持する。
  root lifecycle/failureからのstop planもhost modeに従い、connection_onlyからnormal/handoffを生成しない。
  detach成功は{mode:'detach'}だけを返し、native handoffのproducerExitEvidencePayloadを作らない。
- detachでも既存admissions close→全controller requestStop先行→期限付きsettlement、input drain、D1 stopと
  drained内owner退役、全connection cleanupを実行する。退役理由はnormal_shutdownを維持しdurable scopeで
  意味を区別する。全relay effectが収束し全owner退役とauthority guard成功が揃ってだけ、所有予約とleaseを
  解放する。callback/late write/cleanup不明・activation unknown・failureLatchedは既存どおりsticky保持する。
  requestStopはrelayの新入力/観測/書込みを不可逆に閉じるが、native/workerへ停止信号を送らない。
- 装着解除・G2表示クライアントの通信断だけでhost.stopを呼ばない。host detachはrelay接続全体を明示終了する
  操作であり、Mac会話は残る。start/enable失敗の回収もrelayだけを対象にし、PC会話を停止・再起動しない。
- 局所受入は実Store/D1 fixtureで、attach→入力→detachと別hostから同nativeへのrestart、native呼出0、
  二重attach/create0、両ID/endpoint/epoch不一致、両scope cleanup混同、late Ready/close競合、unknown時
  lease保持、旧owner拒否、新canonical後継initialを確認する。既存native-owned testsを維持する。
  所有はhost-lifetime本体・同test・必要index exportだけ。DB/Store/coordinatorの再実装はしない。
  factory/起動wrapper/HTTP receipt表示/実provider/実G2受入は次工程であり、本局所成功へ混同しない。


#### 78.10.4.9.3 Codex queue接続の閉鎖完了観測（2026-09-08）

- §.9.2のconnection_only cleanupを実装するため、既存CodexRelayQueueTransportへ
  waitForClose(): Promise<void>を追加する。既存close():void/send/ownerとqueue wire・宛先照合・unknown/
  at-most-once規則は維持する。waitForClose自体は接続/再接続/送信/closeを起こさず、同じPromiseを返す。
- closeは従来どおり同期的にclosed latchを立て、新規送信を拒否し、pending requestと送信attemptを既存規則で
  settleして所有WebSocketをterminateする。これはMacのapp-server/TUI/native会話を終了する操作ではない。
- waitForCloseのfulfilledは、そのconnectionが所有したWebSocketの実close eventを観測し、pending RPC/
  attemptのsettlementを実施済みの場合だけ許す。WebSocketをまだ一度も作っていない状態でcloseに至った時も
  fulfilledにできるが、socket/WSを作った後はローカルclosed flag、readyStateだけ、terminate呼出/timeoutを
  実closeの代替証拠にしない。closeより前のwaitはpendingとする。二重close/late responseは収束を覆さない。
- terminateがthrowし実closeを観測できない場合はclose():void互換を保ちつつwaitForCloseは未解決に保つ。
  実closeが後から観測された時だけ収束できる。未解決の期限判定とlease保持は外側のhost/controllerに任せ、
  timeoutを成功へ変換しない。close観測Promiseはrejectせず、未証明をpendingで表す。
- createCodexRelayQueueTransportのcopy/検証失敗は副作用前に従来どおり拒否する。connection生成後の
  initialize失敗はcloseを要求しwaitForClose収束後に元の失敗を返す。閉鎖未証明ならcreate Promiseもpendingで
  保持し、外側の単一期限がunknown/lease保持へ倒す。失敗したcreateの背後に未追跡socketを隠さない。
- 既存の再接続禁止、native start/resume/turn-start禁止、owner guard、既定runtime/home/platform/
  threadId/cwd/direct-input照合を緩めない。閉鎖待ち追加を理由に既存testを削除/skip/timeout緩和しない。
- 局所検証は実WS-over-UDS fixtureで、正常close/peer close/二重wait+close、close前pending、terminate遅延/
  throw時pending、実close後fulfilled、初期化失敗時のcreate settlement順、inflight sendのunknown保持と
  追加queue送信0を確認する。実provider/native/TUI/G2は起動しない。所有は既存queue transport本体と
  同testの2filesだけ。connection controller/observer/output mapper/起動wrapperは次工程とする。


#### 78.10.4.9.4 Codex通知から既存ingressへの純粋変換（2026-09-08）

- native wrapperの購読clientとconnection_only controllerの接合に先立ち、adaptersへ純粋関数
  mapCodexRelayNotification(message:unknown, expectedProviderSessionId:string): readonly CodexRelayNotificationSpec[]
  を追加する。specはkind:RelayIngressEventKind、turnId:string|null、toolId:null、payload:RelayJsonValue、
  dedupeKey:string|nullだけを持つ。owner/session/generation/sequence/eventIdは作らず、I/O・native API・
  queue送信・DB/Registry mutationを行わない。後続controllerが固定ownerとconnection epochへ束縛し、
  owner-bound runtimePort.ingest直前に停止/現在ownerを検証する。本関数だけを旧owner拒否の証明にしない。
- expectedProviderSessionIdは空白のみ/NUL/512 UTF-8 bytes超をthrowする。messageは非null非array objectで、
  id propertyを持たないnotificationだけを受け付ける。params.threadIdがexpected IDと完全一致しない、
  未知method、未知/不正fieldは空配列。JSON-RPC request（approval/user-input含む）は表示/回答とも扱わず、
  未検証requestをnotificationへ読み替えない。IDは相互導出しない。
- 実native通知のrootに付く任意のemittedAtMsは、非負のsafe integerだけを受け付ける。
  省略も許容するが、null・負数・小数・非number・safe integer超は通知全体を拒否する。
  この時刻は転写せず、owner権限・順序・時計・event ID・dedupeKeyの根拠にしない。
  rootの他の未知fieldとid propertyの拒否は維持する（2026-09-09実通信で確認）。
- item/completedのitem.type=agentMessageだけをtextへ写す。threadId、turnId、item.idが上記ID条件に合い、
  item.textがstringの時だけ、payload={text,truncated}、dedupeKeyはJSON.stringify(["item",turnId,item.id])。
  textは既存export redactClaudeHookRelayTextを全文へ適用した後にUTF-8 16KiBへcodepoint境界で切る。
  cutしてからredactしない（長いPEM/JSONを漏らさない）。内部の推論、tool引数/結果、diff、画像、未知itemは
  表示しない。既存Claudeのredaction実装を複製/変更しない。deltaは本工程では無視し、完成messageと二重表示しない。
- turn/startedは非空turn.idとturn.status=inProgressを要求し、status {state:"busy"}を1件返す。
  dedupeKey=JSON.stringify(["turn-start",turn.id])。turn/completedはstatus=completed/failed/interruptedだけを
  受け付け、result {success:status==="completed",status}を1件返す（textを再複製しない）。
  dedupeKey=JSON.stringify(["turn-end",turn.id,status])。turn.errorやitemsは転写しない。
- thread/status/changedはidle→status {state:"idle"}、active→status {state:"busy",waitingOnApproval:boolean,
  waitingOnUserInput:boolean}。activeFlagsは既知2値だけのarrayを要求、未知値/非arrayは全体を無視する。
  waitingOnApprovalがあれば続けてpermission_request {message:"PCで権限確認を待っています",displayOnly:true}。
  waitingOnUserInputがあれば続けてstatus {state:"busy",message:"PCで回答を待っています",displayOnly:true}。
  both flagsはこの順で両方を返す。notLoadedはstatus {state:"disconnected"}、systemErrorはerror
  {message:"Codexの接続状態を確認してください"}とする。status由来はturnId/toolId=null、dedupeKey=null。
  状態通知に安定event IDはないので同じ状態への後の遷移を恒久dedupeしない。これらは表示情報であり
  idleを入力可能/全worker終了の根拠にしない。権限承認やuser-input質問本文/回答の配信は後続の別接合。
- 戻り値はcallerのmessageと参照を共有しない。malformed/別thread/requests/未知itemでraw内容をthrow/logしない。
  実0.153.0生成schemaとactive queue実測を根拠とする。局所testsは全通知分岐・別thread・不正入力・request拒否・
  nested secret/PEM/UTF-8上限・入力/出力参照分離・定常status反復・安定dedupeKeyを確認する。
  所有は新codex-relay-notification-mapper.ts/.test.tsとindex exportだけ。controller/observer/wrapper/CLI/
  実G2受入は後続工程であり、この純粋変換の成功を完成へ読み替えない。


#### 78.10.4.9.4.1 再利用redactorの機密値型・次行値修正（2026-09-08 correction）

- .9.4の既存redactor再利用指定に対し、既存redactClaudeHookRelayTextが§79.9/§79.9.2を
  満たさないことをpublic mapper経由の合成markerで確認した（object/array/次行値が残存）。.9.4の
  「既存redactorを変更しない」はこの修正工程に限りsupersedeする。秘密除去契約は弱めず、既存mapper本体/
  exportとredactor APIを維持して、共有するClaude adapterのredactor本体とtest、Codex mapper testだけを修正する。
- redactStructuredJsonは機密keyなら値型を問わずsubtree全体を[REDACTED]へ置換する。string/object/array/
  number/boolean/nullの全てを対象とし、機密subtree内部のkey/valueを再帰結果として残さない。
  非機密keyの再帰・key redactionと衝突回避・JSON parse可能性/要素数保持は既存どおり。
- redactFreeTextの機密代入を検出した行は従来どおり値の終端を探さず行末までマスクする。delimiter後が
  空又は水平空白だけなら、続く空行を越えた最初の非空行全体も保守的にマスクする。LF/CRLF/CRを扱い、
  その非空行自身も値無しの機密代入を含む場合は次行マスクを継続する。直接JSONとしてparseできる入力は
  既存の構造経路で処理し、非機密fieldを壊さない。authorizationは既存adapterの値全体マスクを維持し、
  未知schemeの最初のtokenを保存しない。Core側の他consumer/redactorを本工程で変更しない。
- 公開redactClaudeHookRelayTextとmapCodexRelayNotificationの両方を経由して、機密値6型、非機密兄弟保持/
  parse可能性、複数key衝突、未知authorization scheme、次行値/空行/CRLF/CR/連続値無し代入、長いPEMと
  UTF8 bounded表示を試験する。現mapperの41testとClaude既存236testを維持し、型軸を実テストへ追加する。
  合成markerだけを使い実credentialを読まない。redactionを切断後や表示後へ移さず、mapperの全文redact→truncateを保つ。
- 所有はclaude-hook-relay-adapter.ts/.test.tsとcodex-relay-notification-mapper.test.tsの3files。mapper本体/index/
  queue/native observer/Core/依存/contractはworker所有外。新しい隔離WTへ既存mapper成果をhostがsnapshotし、
  修正と独立review後に元mapperも再受入する。元のblockedを無検証でdoneへ変えたり同一WTへreplacementを起動しない。


#### 78.10.4.9.5 Codex queueの実native canonical ID opt-in照合（2026-09-08）

- 既存native_owned callerのcanonical IDはlogical IDであり、thread.sessionIdと同一と推定しない。
  connection_onlyでは.9.2の両native ID照合を送信直前にも維持するため、既存queue transport optionsへ
  expectedNativeSessionId?:stringを追加する。未指定/undefinedは既存互換、指定値は非空（空白のみ不可）、
  NUL無し、UTF-8 512bytes以内を要求し、null/非string/不正値はsocket/guard callback前に拒否する。
  copyOptionsでprivate immutable copyへ固定し、callerの後の変更を反映しない。owner.sessionIdから
  暗黙補完しない。connection_only factoryはtarget.sessionIdを必ず明示設定する（factoryは後工程）。
- isCodexRelayReadyThreadResponseへ第4optional引数expectedNativeSessionId?:stringを追加する。
  未指定/undefinedでは既存3引数の全挙動を維持する。指定値が不正ならfalse、正しい値なら既存条件に加え
  実response.thread.sessionIdとの完全一致を必須にする。thread.idとsessionIdの等値強制/相互導出はしない。
- transportのinitializeと各sendのfresh thread/read validationへcaptured expectedNativeSessionIdを渡す。
  初期化時不一致は既存NOT_READY失敗と.9.3実閉鎖待ちで回収する。送信直前不一致はqueue/add前に
  definitely_rejected、queue/add0とする。read結果不明/閉鎖/late raceは既存unknown/at-most-onceのまま。
  expected値指定はnative start/resume/retry/reconnectを許可しない。waitForClose/owner/既存guardは維持する。
- testsは既存未指定かつlogical owner.sessionIdとnative sessionIdが異なる成功を維持し、指定一致の成功、
  initial mismatch時queue0/actual close、send read mismatch時queue0/definitely_rejected、caller値変更に
  影響されないこと、不正optionでguard/socket0、片方だけ一致の拒否、protocol第4引数の不正と互換を確認する。
  実WS-over-UDS fixtureを使い、実provider/G2を起動しない。所有はqueue-protocol.ts/.test.tsと
  queue-transport.ts/.test.tsの4filesのみ。index/mapper/Core/contract/依存の変更と広範refactorは禁止。


#### 78.10.4.9.6 Mac起動時のCodex native resume観測接続（2026-09-08）

- 最初のCodex限定経路は専用app-server endpointで既知の正確なprovider thread IDを起動時resumeし、標準
  TUI --remoteで同じIDを開く方式とする（実測済み）。新規会話の自動発見やDesktop既存会話後付けとは区別する。
  native起動wrapperだけがcreateCodexNativeResumeObserverを呼ぶ。connection_only controllerは生成済み
  observerのobserve/subscribeだけを使い、create/resume/closeを呼ばない。G2 detachはsubscriptionとqueueだけを
  閉じ、Mac所有observer/app-server/TUIは残す。専用app-server/TUI起動CLIは次工程。
- 新adapters moduleのoptionsはsocketPath（NUL無し絶対Unix path）、providerSessionId（非空/空白のみ不可、
  NUL無し、UTF8 512bytes以内）、cwd/expectedCodexHome（NUL無し絶対path）、expectedPlatformOs（非空）、
  runtimeVersion:"0.153.0"、connectTimeoutMs/requestTimeoutMs（1..2147483647のsafe integer）。
  すべて副作用前に検証してprivate copyへ固定する。環境変数/別endpointへのfallbackはしない。
- createは実WS-over-UDS（perMessageDeflate:false、maxPayload:1MiB）を1回だけ作り、initialize
  {clientInfo:{name:"hachi-g2-native-observer",version:"1.0.0"},capabilities:{experimentalApi:true}}、initialized、
  thread/resume {threadId:providerSessionId,excludeTurns:true}の順で送る。initializeは既存protocol validatorで
  codexHome/platformを検証。resumeのthread.id/cwd/directInput/statusも既存validatorで照合し、実thread.sessionIdを
  上記ID規則で検査して独立に捕捉する。thread.idとsessionIdの等値強制/相互導出は禁止。
  thread/start、turn/start、queue/add、interrupt、approval/user-input responseはAPIに持たない。
- createはさらにobserveを1回実行して成功後だけobserverを返す。observeは固定socket上でfresh
  thread/loaded/list {}→thread/read {threadId,includeTurns:false}を行う。loaded.dataは文字列arrayでexact IDを含み、
  readは既存ready条件と捕捉したnative sessionId完全一致を要求する。失敗を前のsnapshotで代用しない。
  返すsnapshotはproviderSessionId/sessionId/cwd/socketPath/codexHome/platformOs/runtimeVersion/status
  (idle|active)/waitingOnApproval:boolean/waitingOnUserInput:boolean/observedAt（観測後のepoch秒）だけ。
  raw turns/items/response/errorは返さない。identityにも同じ固定ID/path/runtime（status/time以外）をreadonly copyで公開。
- 戻り値CodexNativeResumeObserverはidentity、observe():Promise<snapshot>、
  subscribe({onNotification:(message:unknown)=>void,onDisconnected:()=>void}):{close():void}、
  close():void、waitForClose():Promise<void>を持つ。subscriptionは同時1個、live中の二重subscribeは副作用前throw。
  subscribeはnative RPC/resume/replayを行わず、今後届くexact params.threadIdのnotificationだけを渡す。
  subscription.closeは同期latch/解除し、その後の通知/切断callbackを呼ばない。再subscribeは新handleとする。
  callbackに渡すmessageは内部pending stateと参照を共有しない。callback throwは当該subscriptionを解除するが
  observer/native会話を停止しない。throwしたraw内容はlog/再throwしない。closed observerへのsubscribe/observeは拒否。
- incoming frameはJSON-RPC messageのmethod有無をpending response ID照合より先に分類する。
  methodとidを持つserver requestは、client RPCと同じidでもpendingをsettleせず、callbackへ渡さず、返答も送らない。
  同じthreadを購読するTUIが確認に回答する。自動error/deny/approveは先にnative requestを解決しPC操作を妨げ得るため禁止。
  thread-scoped要求の複数接続配信/共有callbackはpinned outgoing_message.rsとbespoke_event_handling.rsで確認済み。
  methodだけのnotificationはexactthreadだけ、responseは既知pending IDだけを処理する。RPC IDは毎connectionの
  private prefix付きstringを使う。未知response IDは無視し、binary/不正JSON/上限超frameはobserverだけを閉じる。
- RPC pendingは最大32、response error/timeoutはraw server errorを漏らさない固定codeの失敗。容量超は書込み前拒否。
  timeout/connection障害はobserverを閉じ、pendingをすべてsettle、active subscriptionへonDisconnectedを一度通知する。
  closeはnative API/プロセス停止/再接続を行わず、実socketだけを閉じる。waitForCloseは同一Promiseで副作用無し、
  実WS close eventと全pending settlement後だけfulfilled。terminate throwでclose未観測はpendingに保つ。
  create途中失敗はclose→実閉鎖収束後に固定codeでrejectし、自動resume再試行をしない。native resumeが部分実行済み
  かもしれないことを失敗の再送理由にしない。wrapperはG2未接続とし正常Mac会話を止めない。
- 局所testsは実WS-over-UDS fixtureでwire順序/各1回、実both IDとfreshloaded/read照合、mutable options不影響、
  別thread/旧subscriptionの通知0、二重subscribe拒否、callbackthrow隔離、server requestとRPC responseのID衝突で
  自動返答0かつ本来responseまでpending、error/timeout/peerclose/late response、閉鎖前pending→実close後fulfilled、
  初期化/resume/read失敗の回収、禁止RPC0を確認する。実provider/TUI/G2は起動しない。所有は新codex-native-resume-observer.ts/.test.tsと
  index exportの3filesのみ。queue/mapper/Core/CLI/contract/依存は変更しない。factory/起動CLI/実機は後続受入。


#### 78.10.4.9.7 Codex connection_only factoryの接合（2026-09-08）

- .9.2/.9.3/.9.4/.9.5/.9.6の受入を前提に、adaptersへcreateCodexRelayConnectionFactory(options):
  RelayNativeControllerFactoryを追加する。optionsはobserver:Pick<CodexNativeResumeObserver,
  "identity"|"observe"|"subscribe">、connectTimeoutMs/requestTimeoutMs（queueと同じ有効範囲）、
  onConnectionFailure:(attempt:RelayNativeControllerAttemptIdentity)=>void。実observerはMac起動wrapperが
  先に作成して所有する。factoryにはobserver生成/close/resume、native process/worker終了、raw Store/
  Registry/lease/claim APIを渡さない。queueとmapperを再実装せず既存関数を呼ぶ。
- factory作成時にoptions/observer identityとbound methodsをprivate copyへ固定する。各createはmode=
  connection_only/provider=codex/attach_existingと、targetの両ID/socketPathがobserver identityの実両ID/
  endpointに一致することを副作用前に検査する。attemptId/generation/laneをimmutable copyする。
  異mode/異provider/別targetはsubscribe/observe/queue0で拒否。targetのIDを相互導出しない。
- handle.startは一度だけ開始し同じPromiseへjoinする。まずobserver.subscribeを取得し、その後fresh observeを
  実行する。通知は.9.4でspecへ変換し、activation前は最大500specをFIFO保持する（raw payloadを保持しない）。
  overflow/観測切断は停止をlatchしReadyにしない。observeのsnapshotの両ID/endpoint/cwd/home/platform/runtimeを
  固定identity/targetと一致させ、idle|activeとpositive safe observedAtを検査する。Readyはその実観測両ID、
  processStarts:[]、attempt+snapshotのcanonical JSON SHA256をnativeEvidenceDigest、snapshot時刻を返す。
  stopが先なら遅いobserve成功もReadyへ昇格しない。start失敗の自動再試行はしない。
- publishActivationはstart成功後だけ、inputのattempt/full owner/registration/nativeEvidenceDigest/processStartsが
  自分のReady/target/lane/generationへ一致することを検査する。claimIdは非空、claimRevision/hostEpochは
  positive safe integerとして初回に捕捉する。
  ownerのsessionIdとproviderSessionIdもtargetへそれぞれ一致。ownerは既存validateRelayOwnerFenceValue/
  relayOwnerFenceEqualsを使う。runtimePortはbound methodsを固定し、heartbeatの返すfull owner一致を確認する。
  同一inputの再呼出は同Promise、異input（runtimePortが別objectの場合も含む）は副作用前に拒否する。
- publish成功時にbufferをFIFOでflushし、その後の通知は同期的に既存owner-bound runtimePort.ingestへ渡す。
  各event前に停止latchを検査し、runtimePort.heartbeatとfull owner一致、再度停止latchを検査する。
  sessionId/generationはcaptured owner、sequenceはactivationごとに1から増加（safe integer枯渇で停止）。
  eventIdはSHA256([owner.sessionId,owner.providerSessionId,owner.handoverGeneration,spec.kind,
  spec.dedupeKey??JSON.stringify([attempt.attemptId,sequence])])へcodex-relay-を前置する。payload/turnId/toolIdは
  specだけから取る。ingestのaccepted/duplicate/droppedは再送しない。guard/ingest throwは停止latchとfailure通知へ。
- prepareInputTransportはpublish成功後かつ同じpublication inputだけを受け付け、一度だけ既存queueを作る。
  queue optionsは固定observer identityからcwd/home/platform/runtime/socket、connectionEpoch=attemptId、owner、
  expectedNativeSessionId=target.sessionIdを必須で渡す。assertBindingは停止latch→runtimePort.heartbeat/full owner
  一致→停止latchを検査する。戻り値は既存RelayInputTransportへwrapしprovider=codexと入力full fenceを維持する。
  callerが別inputへ変更したduplicate prepareは拒否、同一inputは同Promise。queue結果unknownを成功へ変更しない。
- requestStopは最初に不可逆停止latch、buffer破棄、subscription.close、準備済みqueue.closeを同期実行しlatchedを
  返す。いずれかcloseがthrowしても他のcloseを試み、cleanup未証明を記録する。準備中queueが遅れて成功したら
  即closeしてwaitForCloseまで追跡し、transportを公開しない。旧notification callbackはlatchでingest0。
  observer.close/新resume/プロセス停止は常に0。G2表示client単体の切断ではこのrequestStopを呼ばない。
- Ready後のobserver切断、意図しないqueue実close、guard/ingest失敗、buffer/sequence枯渇はrequestStop後に
  onConnectionFailureを当該attemptにつき一度通知する。callback throwは外へ漏らさず記録する。rootはこの通知で
  既存host.stop({mode:"detach"})を開始する。callback失敗をhost cleanup成功の証拠にしない。Ready前の失敗は
  start拒否でhostへ渡す。正常なrequestStopによるqueue closeを再びruntime failureとして通知しない。
- cleanupはrequestStopを実行し、取得済みstart/publish/prepareの元Promiseと遅いqueue close収束を待つ。
  observer自体のWS閉鎖は待たない。subscription解除成功、全buffer/遅いcallbackの無効化、生成したqueueの
  waitForClose実fulfilled（又はqueue未生成かつcreate失敗の閉鎖収束済み）を確認した場合だけ.9.2の
  verified_connection_closedを返す。attempt/activationContextはcopyして厳密一致させ、active contextは保存済み
  activationがあればそれとも一致させる。activation_unknown、close/failure callback throw、context不一致はunknown。
  cleanup evidenceDigestはschemaVersion:1/attempt/activationContext/socketPath/connectionEpoch/購読解除/
  queue閉鎖状態のcanonical JSON SHA256、observedAtは収束後epoch秒。native終了証拠は作らない。
  pending queue/createをtimeoutでfulfilledにしない。外側hostの単一期限/unknown時lease保持を維持する。
- 局所testsは実Store/D1+実WS-over-UDS fixtureでattach→入力台帳→queue→通知ingest→detachと同native restartを
  最低1経路通す。他は制御observer/queue fixtureで両ID/lane/owner mismatch、duplicate呼出、buffer順/overflow、
  stop先行のlate observe/queue、queue実close前cleanup pending、旧callback0、owner失効、runtime loss一度通知を
  検証する。Mac所有observerのcloseとnative start/resume/kill呼出0を確認し、既存Core gateを置換しない。
  所有は新codex-relay-connection-factory.ts/.test.tsとindex exportの3filesだけ。native実機/起動CLI/HTTP表示/
  planned handoverは後工程。依存3taskの実source受入・統合後にworker snapshotを準備してreadyへ進める。


#### 78.10.4.9.7.1 Codex接続の無通信継続とguard失敗の即時停止（2026-09-08）

- .9.7のfactoryはpublication後のowner lease継続も所有する。通知/入力が無い正常なMac会話を
  lease失効にしない。optionsにheartbeatIntervalMs?:numberを追加し、省略時30_000、明示時は
  1..2_147_483_647のsafe integerとしてfactory作成時にprivate copyする。不正値はobserver副作用前に拒否。
  起動compositionはRegistryのheartbeatIntervalSeconds*1000を同値で渡し、leaseTtlSeconds*1000未満を
  構成時に検査する。既定は30秒/90秒。factory内部でRegistryを別生成せず、TTLやownerを推定・変更しない。
- publishActivationの初回成功処理で、owner照合とbuffer flush完了後、Promiseをfulfilledにする前に
  当該attempt専用のsetIntervalを1本だけ開始する。timerはunrefし、正常なMac寿命を保持する根拠にしない。
  duplicate publishでtimerを増やさない。prepare待機中も定期更新する。callbackは停止latchを先に検査し、
  captured runtimePort.heartbeat→full owner一致→停止latch再検査を実行する。更新失敗は下記即時停止へ。
  timer設定失敗もpublish失敗として停止する。通知を作ったり、未確定入力を再送したりしない。
- requestStopは不可逆latchの直後にtimerをclearして参照を消し、続けて既存buffer破棄/subscription.close/
  queue.closeを行う。失敗/正常detach/cleanupのすべてで新たなheartbeatを止め、既にqueue済みのtimer callbackも
  latchで副作用0とする。正常停止でonConnectionFailureを重ねない。timerはcleanup成功時に残存しない。
- prepareInputTransportへ渡すassertBindingは、停止latch→heartbeat/full owner→停止latchの検査をcatchし、
  外へ固定エラーを返す前にfailConnection相当の不可逆停止とReady後の一度限りfailure通知を同期実行する。
  queueのterminate/waitForCloseが遅延・throw・未解決でも、observer購読解除とhostへの停止通知を先送りしない。
  実queue closeはcleanupの閉鎖証拠であり、停止latchを許可する条件ではない。callback throwは従来通り記録する。
  queue生成時のguardから同期failure callback→host cleanupが再入しても、元のprepare Promiseを取得済みとして
  追跡する。queue生成を呼ぶ前にPromiseを公開し、cleanupが遅いqueue生成/実closeを見落とさない。
- focused回帰は、Registry clockとtimerを同じ時間軸で進めた実Registry/Host経路で90秒以上のidle後も通知を受理し、
  停止後は時刻を進めてもheartbeatが増えないことを確認する。所有者失効/更新throwは一度停止通知し、旧callback0。
  実queue/WS-over-UDSで公開transport.sendのguardを失敗させ、WebSocket.terminateを保留してもqueueAdd0かつ
  subscription解除/failure通知済みを検証する。その時点のcleanupはpending、実close解放後だけverifiedにする。
  timer上限/不正値、duplicate publish、stop-before-publishも既存fixtureで確認する。実G2受入は後工程のまま。
- 修正所有はadaptersのfactory.ts/.test.tsだけ。これは固定入力比較後の修正版であり、元の比較標本を上書きしない。


#### 78.10.4.9.8 G2表示へ渡すowner-bound出力port（2026-09-08）

- 既存Registry.ingressEvents/acknowledgeを接合し、別のingress queueやRegistryを作らない。
  CoordinatorにcreateOutputPort(ownerFence):RelayAuthorityCoordinatorOutputPortを追加する。
  portはreadEvents():RelayIngressEvent[]とacknowledge(eventId:string):RelayIngressEventだけを持つ。
  createRuntimePortの既存3methodは変えない。HTTP/D1へraw Registry/Store/lease/registerを公開しない。
- createOutputPortは既存validateRuntimeOwnerでfull ownerを検証・private copyし、生成と各操作を
  既存runMutation/ready+admission/入口帰路guard/DB-receipt照合へ含める。各操作はcaptured ownerで
  Registry.ingressEvents/acknowledgeを呼び、finalizeFacadeReturn後だけ成功を返す。callerはownerを
  引数で差し替えられない。未知/失効/旧token/別sessionは既存Registry規則で拒否する。
  readEventsは既存deep copy結果を返し、読み取りだけではqueue削除やheartbeatを行わない。
- RelayHostLifetimeにgetOutputPort(attemptId):RelayAuthorityCoordinatorOutputPort|nullを追加する。
  startAttemptのpublication（設定時はinput transport準備も）が成功し、最終running検査を通ったattemptに
  だけ公開する。同じattemptは同じport。未知/未開始/pending/失敗/停止開始後はnull。raw runtimePortを返さない。
  port生成失敗も既存activation pipeline失敗処理で停止へ収束し、部分成功としてstartAttemptを返さない。
- hostが返す各port methodは、呼出前後にhost running/admissionと同じattempt/active owner登録を検査し、
  coordinatorのowner-bound portへ委譲する。stopPlan確定/正常stop/reactive stop/D1停止/activation失敗の
  後は、callerが以前保持したportもread/ackを拒否する。旧世代・旧hostのportを新接続へ付け替えない。
  facadeは同期操作だけで、別のin-flight drainやtimeout成功扱いを作らない。既存closeAdmissionsで即時閉鎖する。
- acknowledgeは「host内の表示配信側がそのeventを引き取った」というqueue削除であり、G2実機で読まれた
  証明ではない。callerは取得済みeventを表示側で保持した後だけackする。HTTP/SSE切断・再表示・送信不確定の
  扱いは次のHTTP接合で決める。表示client単体の切断をhost.stopの理由にしない。既存D1 endpointは増やさない。
- focused検証は既存実Store/receipt/Registry+制御controllerのhost fixtureを使い、(1)publication/input準備前の
  nullと成功後同一port、(2)ingest→readの順序/payload copyとack削除、(3)両IDを異ならせた別session/owner拒否、
  (4)guard/receipt drift/closeAdmissions/stop呼出直後の保持port拒否、(5)detach→同native再接続後も旧port拒否、
  (6)queueに存在しない/他session eventIdのack拒否を確認する。実provider/G2/CLI/HTTPは所有外とする。
- 所有はcoreのrelay-authority-coordinator.ts/.test.tsとrelay-host-lifetime.ts/.test.tsの4filesだけ。
  source+focused testsで1成果（既存hostから安全に通知を取り出す入口）とし、HTTP表示とCLI起動は別工程。


#### 78.10.4.9.9 既存boardを使う接続hostの起動composition（2026-09-08）

- CoreのopenRelayConnectionHost(options):RelayConnectionHostが、既存SqliteKanbanStore、
  readBoardInstanceId、openRelayAuthorityNamespace、RelayHostLifetimeを組み立てる。
  lifecycleModeはconnection_only固定。別Registry/Store実装/receipt/ledger/state machineを作らない。
  raw Store/lease/receipt/Coordinatorおよびnamespace factoryをbarrelへ公開しない。
- optionsは既存HostLifetimeOptionsからauthorityLease/authorityStore/persistence/boardInstanceId/
  lifecycleMode/inputAdmissionを除いた設定とdbPath、inputSendTimeoutMsを持つ。入力は必須で、
  同じStoreをauthority/persistence/input storeの3役へ渡す。adoptionId/startupModeはcallerが明示し、
  adoption ID/既存authorityを自動生成・採用・変更しない。controllerFactoryはcallerが既存adapterから渡す。
- DB新規作成をこの入口に含めない。Store生成前にreadBoardInstanceId(dbPath)のreadonly+fileMustExist
  を通し、Store生成後も同じboard IDを再確認する。namespaceにはそのboard IDと明示adoption/modeを渡す。
  home/namespaceは既存OS-home固定契約に従い、callerの任意pathでauthority rootを差し替えない。
- RelayConnectionHostはstate、start()、startAttempt(input)、getInputReceiver(attemptId)、
  getOutputPort(attemptId)、detach()だけを持つ。既存hostの型付き結果を委譲する。
  getInputReceiver/getOutputPortはhostがrunningでなければnull。HTTP側へowner/登録mutationを露出しない。
  detachはhost.stop({mode:"detach"})を直ちに呼び、最初のPromiseを再利用する。
  正常stopのfulfilled後だけStore.closeを一度呼び、既存detach結果を返す。
- Store取得後・lease取得前の失敗はStoreを閉じて元の失敗を返す。lease取得後のconstructor/start/stop失敗は
  既存sticky保持契約に従い、Store/lease/hostの到達可能な参照をmodule-privateに保持する。
  不完全stop/DB close失敗を成功へ変換しない。成功detach後だけ保持集合から外す。
  reactive failureのstateだけを見て自動DB close/lease解放をしない。native起動/停止を所有しない。
- lane/config/tuningの配列・値は入口でprivate copyする。registry heartbeat/TTLは省略時30/90秒とし、
  heartbeat*1000が1..2_147_483_647のsafe integerでTTL未満をlease取得前に検査する。
  Codex factoryへ同じ値を渡す責務は次のCLI組立側にある。Coreはadaptersへ逆依存しない。
- 新relay-host-composition.ts/.test.tsとindex.tsの必要最小限のexportだけを所有する。controllerや公開facadeに
  必要な型はtype exportできるが、raw authority実装のvalue exportは禁止。
- focused検証は既存実Store/namespace/制御controllerで、既存DBのみ・不正設定拒否、正常attach→input/output→
  detachと同じdetach Promise、停止直後のgetter/保持port拒否、二重hostのsingleton拒否、post-lease failure保持、
  stop incomplete時Store未closeを確認する。OS-home差替えは既存test fixture方式だけで行い、実boardを使わない。
  CLI/HTTP/native/G2/全repo gateは別工程。


#### 78.10.4.9.10 HTTPへ渡すCodex会話facade（2026-09-08）

- adaptersのcreateCodexRelayHttpFacade({host,activation,observer}):CodexRelayHttpFacadeが、受理済みの
  RelayConnectionHost、RelayHostLifetimeActivationIdentity、CodexNativeResumeObserverを接合する。
  source+focused test+index exportの3filesだけを所有する。Core/HTTP/CLI/observerを変更しない。
  raw Store/Registry/lease/registration API、native create/resume/close、購読やqueueを追加しない。
- 生成時にattempt.mode=connection_only、provider=codex、target.kind=attach_existing、processStarts空を検査する。
  validateRelayOwnerFenceValue等の既存検査を用い、ownerの両session ID/provider/generation/full laneが
  attempt/targetと一致し、targetの両ID/socketがobserver.identityと一致することを確認する。
  observerのcwd/socket/codexHome/platformOs/runtimeVersionは既存observerのidentity規則で検査・private copyする。
  不一致は入力送信/observer.observe前に固定エラーで拒否する。host/observer/取得portのmethodはbound copyする。
- host.getInputReceiver(attemptId)とgetOutputPort(attemptId)がともに非nullの同じportであり、hostがrunningの
  間だけ操作を許す。生成時と全methodの前後でこの条件を検査する。observer.identityとactivationを後から
  callerが書き換えてもbindingを更新しない。旧attempt/旧portを後継へ付け替えない。
- facadeのpublic bindingはimmutableな{sessionId:providerSessionId,cwd,provider:"codex"}だけ。
  G2既存wireのsessionIdはprovider thread IDを使用し、Coreのcanonical sessionIdは内部で照合する。
  owner fence/receipt本文/native credentialをHTTPへ公開しない。検査エラーは固定code/messageで返す。
  下位例外の生message/causeをHTTP応答へ転記しない（HTTP接合側も固定errorに変換する）。
- public methodは次の5つだけ。owner/port/observer/activationのsetterやraw object返却を作らない。
  1. admitPrompt({admissionId,inputText,now})。sourceKey:nullで既存input.admitへ委譲する。
     receiptのcanonical sessionId/providerを照合し、{admissionId:元receiptのID,receivedAt,duplicate}だけ返す。
     入力本文hashでdedupしない。clientの安定送信ID/自動再送の有無はまだ実測していない。
  2. dispatchPrompt({admissionId,sendAttemptId,now})。既存input.dispatchへ1回委譲し、await帰路もactive検査する。
     既存RelayInputAdmissionStateまたはsettlement_unknownの{state}だけ返す。retry/別queue/timeoutを足さない。
     送信結果不明を成功に変換せず、host失効後に古いPromiseを成功として返さない。
  3. observeNative()。同じobserver.observeを1回呼び、snapshotの全identityをprivate identityと照合する。
     getter一致だけをauthorityの証拠にせず、awaitの前後にoutput.readEventsを呼んで既存owner/DB/receipt guardを
     通す（読むだけでack/heartbeatしない）。status idle/activeをidle/busyへ写し、waitingOnApproval、
     waitingOnUserInput、observedAtのみ返す。未知状態/不正snapshot/guard失敗は成功へ変換しない。
  4. readOutput()。既存output.readEventsへ委譲し、全eventのcanonical sessionId/generationを照合する。
     kindはtext/status/result/error/permission_requestだけとし、eventId/sequence/turnId/kind/payloadだけの
     private copyを返す。sessionId/toolId等の余分なfieldをspreadで漏らさない。payloadは既存RelayJsonValue。
     異形/別宛先eventをfilterして隠さず全体を拒否する。表示wire変換/ring/pumpは次のHTTP実装に置く。
  5. acknowledgeOutput(eventId)。既存output.acknowledgeへ1回委譲し、返ったeventのID/session/generationを
     照合してからvoidで返す。ack済みをG2閲覧済みとしない。保存後ackの順序はHTTP callerの責務。
- read/input/ackは既存port自身のguardに加えhostの同一port前後検査を通す。observeNativeは上述のread guardで
  検査する。failure時にnative observerをcloseしたりhostを再起動したりしない。呼出側が未接続/結果不明を表示し、
  既存detach→fresh observation→new bindingの接続手順に従う。historyや権限承認のAPIはこのfacadeに追加しない。
- focusedは既存実Store/receipt/Registryを持つhost fixtureと制御observerを使う。両IDが異なる正常系、
  owner/target/socket/lane/generation不一致、両port準備前拒否、元receipt ID、出力copy/field制限、入力dispatchの
  await中detach、状態observeのawait中detach/identity差替え/DB-receipt drift、停止後旧facade拒否を確認する。
  facadeの入れ物だけをmockして全guard検証を代替しない。実native/G2/HTTPは後工程である。


## 79. credential redaction の不変条件（2026-09-04）

目的: board・ログ・通知へ出る文字列から credential を落とす処理の**保証**を固定する。
2026-09-04 までに 4 回 review を回して 4 回とも新しい漏れが出た。**毎回、実装は
「その時点で書かれていたこと」を満たしていた。** 書かれていなかったのは以下である。

実装は現在 2 本ある（`packages/core/src/redaction.ts` と
`packages/adapters/src/claude-hook-relay-adapter.ts`）。**本節は両方を拘束する。**

### 79.1 保証（これが満たすべき唯一の性質）

**機密な代入を含む入力に対し、出力に秘密値の文字が 1 文字も残らないこと。**
「どの規則が担当したか」は保証の対象ではない。**担当が決まらない入力があってはならない。**

### 79.2 経路は 2 つだけで、両者は全域を覆う

- **構造経路**: 入力が JSON として **parse に成功した場合だけ**、構造的に値を差し替える
- **自由文経路**: それ以外の**すべて**。値の開始位置から**行末まで無条件にマスクする**

**parse に失敗した入力は「構造経路が扱った」と見なしてはならない。必ず自由文経路へ落とす。**
JSON らしい見た目（quoted key など）を構造経路の担当と決めつけると、
**JSON として壊れた quoted-key 断片がどちらの経路にも拾われない穴になる**
（2026-09-04 の実測。`"api_key": "…"` 形が parse に失敗すると credential が残った）。

### 79.3 自由文経路は終端を探さない

閉じ引用を当てにいかない。lookahead で「次が `, "` なら…」のような判別を入れない。
**行末まで消す。散文が巻き添えで消えることを許容する**（漏らすより安い）。
これは意図した過剰マスクなので、**そうなることをテストで固定する**。

**key の検出は bare key と quoted key の両方を認識する。**
`api_key=` と `"api_key":` を別経路の担当だと考えない（§79.2）。

### 79.4 二重適用の安全性を「すでにマスク済みなら飛ばす」で実装しない

redaction は多層で適用されるため冪等性が要る。しかし
**「値の前方が `[REDACTED]` に見えるから行全体は安全」と判定してはならない。**
`api_key=[REDACTED]<まだ生きている秘密>` を素通しする（2026-09-04 の実測）。

冪等性は**もう一度マスクすること**で得る — 行末まで消す操作は 2 回適用しても結果が同じである。
**飛ばすことで得ようとしない。**

### 79.5 検証は「例の列挙」で行わない

4 回の review はいずれも、直前に見つかった例を塞ぎ、次の例で落ちた。
**手で並べた入力の一覧は、それ自体が例ベースであり、次の形を予測できない。**

検証は**組み合わせで生成する**こと。少なくとも次の軸の直積を回し、
埋め込んだ目印文字列がどれも出力に残らないことを assert する:

- key の形: bare / quoted
- 入力の構造: parse できる JSON / **壊れた JSON** / 自由文
- 値の形: 素の値 / escaped quote を含む / カンマで継続し次も引用される /
  URL userinfo（`scheme://user:pass@host`）/ **すでに `[REDACTED]` を前方に含む**

新しい漏れが見つかったら、**規則の分岐ではなく軸に足す**。

**軸カバレッジの検査は生成された `input` に対して行う。`id` の文字列一致で代用してはならない（2026-09-05 実測）。**
生成器が軸の組み合わせを取りこぼしても、識別子は軸を名乗ったまま作れる。実際に、
`stdoutPrefixedBrokenJson` × bare key の 24 ケースが接頭辞を持たない通常の壊れた JSON へ
フォールスルーし、**`id` だけがその軸を名乗っている**状態が生まれた。
カバレッジテストが `id` を数えていたため、この 24 ケースは「軸が埋まっている」と報告された。

したがってカバレッジテストは、**その軸に属するケースの `input` が実際にその軸の性質を持つこと**を
assert する（接頭辞を名乗る軸なら `input` がその接頭辞で始まること、壊れた JSON を名乗る軸なら
`JSON.parse` が実際に失敗すること）。**軸の数を数えるのではなく、軸の性質を検査する。**

### 79.6 両実装は同じ生成器で検証する

片方で見つかった欠陥は、必ずもう片方にも当てる。2026-09-04 に、core 側で見つかった
「カンマ継続の入れ子引用」を統合済みの adapters 実装へ当てたところ**同じく漏れた** —
片方だけ直して「閉じた」と board へ書いた後だった。

**将来的に実装を 1 本へ統合するのが望ましいが、本節は 2 本あることを前提に、
同じ生成器を両方へ適用することを要求する。**

### 79.7 構造経路の出力は終端である（2026-09-05 追加）

**構造経路を通した値の直列化結果に対して、行指向のマスカ（自由文経路）を重ねて適用してはならない。**

自由文経路は §79.3 のとおり値の開始位置から行末まで無条件に消す。直列化された JSON は
1 行であるため、この操作を重ねると**最初の機密代入より後ろの区切り文字ごと消える**。
2026-09-05 の実測では、`redactCancelJson` が構造経路の正しい出力
`{"outer":{"nested":["Authorization: Bearer [REDACTED]","token=[REDACTED]",...]}}` を
`redactRuntimeObservationText`（内部で行指向のマスカを呼ぶ）へ通した結果、
`{"outer":{"nested":["Authorization: Bearer [REDACTED]` になり、**JSON として parse できなくなった**。
秘密は漏れていないが、payload を読む側は全員壊れた JSON を受け取る。

したがって:

- **path マスク等の追加規則は、直列化の前に、走査中の文字列リーフへ適用する。**
  直列化後の全体へ当てない
- **「JSON かもしれない文字列」を受け取る境界は、§79.2 の振り分けを行う単一の入口を通す。**
  呼び出し側が行指向のマスカへ直接 JSON 文字列を渡す形を残さない。
  parse に成功するかどうかを呼び出し側ごとに判断させると、同じ穴が境界の数だけ増える
- 冪等性（§79.4）はこの規則と両立する。**同じ経路をもう一度通すことは安全でなければならない**が、
  **別の経路を後段に重ねることは安全ではない**

**検証の軸に「すでに構造経路を通った直列化 JSON（`[REDACTED]` を含む）」を足す**（§79.5）。
出力が JSON として parse できること、および目印文字列が残らないことの両方を assert する。

### 79.8 構造経路は key も走査する（2026-09-05 追加）

**秘密は値だけでなく key にも入る。**構造経路が値リーフしか走査しないと、key の秘密は
構造経路をすり抜ける。すり抜けた分を後段の自由文経路で拾う設計は §79.7 が禁じている
（直列化結果へ行指向マスカを重ねてはならない）ので、**key の秘密は構造経路の中で落とすしかない。**

2026-09-05 の実測: transcript の `tool_use` block は `JSON.stringify(block.input)` で再直列化される。
`{"sk-…secret…":"value","cmd":"ls"}` の key に入った秘密は `redactJsonStrings` をすり抜け、
後段の `redactText` が拾っていた。行末マスク（§79.3）が入ると、その拾い方は
**同じ行の非機密 key（`cmd`）ごと消す**ため、契約 §28.6-3 の「非機密の内容は応答本文へ残る」
という要求と衝突する。**一方を満たすともう一方が壊れるのは、走査の対象が足りないからである。**

したがって:

- 構造経路は object の **key にも同じ leaf 規則を当てる**
- **redact 後の key が衝突しても last-wins で上書きしない。** arity を保ち、
  黙って要素を落とさない形にする

**検証の軸に「秘密が key 側に入った JSON」を足す**（§79.5）。出力が `JSON.parse` に成功すること・
目印文字列が残らないことに加えて、**同じ object の非機密 key が出力に残っていること**を assert する。

### 79.9 機密キーの値は「型」を問わない（2026-09-05 追加・push 前レビューで検出）

**機密キーに紐づく値は、型を問わず subtree 全体をマスクする。**
string のときだけ全体置換し、object / array のときは再帰して string リーフを個別に見る実装は、
**リーフが既知パターンに合致しない限り秘密をそのまま通す。**

2026-09-05 の実測（§79.1〜§79.8 をすべて満たした実装に対して）:

```
入力 : {"api_key":{"value":"NESTEDSECRET"},"password":["ARRAYSECRET"]}
出力 : {"api_key":{"value":"NESTEDSECRET"},"password":["ARRAYSECRET"]}   ← 素通し
```

**8 周のレビューと 216 ケースの生成器がこれを検出できなかった理由は §79.5 の軸にある。**
軸は key の形・入力の構造・**値の形**を挙げていたが、**値の型**を挙げていなかったため、
生成器は機密キーの値として **string しか作らなかった**。

したがって §79.5 の軸に **値の型**（string / object / array / number / null）を足す。
機密キー配下は型を問わず出力に目印文字列が残らないことを assert する。


#### 78.10.4.9.11 Codex接続のEven HTTP表示と入力（2026-09-08ユーザー承認）

**利用体験**

G2から送った入力を、Macと同じCodex会話へ既存の接続APIで送る。返信とPCでの確認待ちをG2へ表示する。G2の通信が切れてもMacの会話とworkerは続く。HTTP接続を閉じる処理はnative会話やhostを停止しない。

旧HTTP試用版に固定されたreadOnly policy/model/UDS設定を新接続の条件にしない。HTTPはMac側の権限設定を変更しない。認証tokenと宛先の一致検査は保持する。実G2往復、clientの再送挙動、history非対応時の互換性は後続の実機受入まで未証明とする。

**実装契約**

- 採択済み0.8.1配布ESMの独立copyを改修する。生成元TSは未取得。所有はdist/dedicated/entry.js、scope.js、routes/core.js、routes/events.js、新dedicated/relay-wire.jsと専用test。元候補と稼働サービスは変更しない。
- 新公開createDedicatedRelayHttpBinding(scope,{relay})はimmutableな{app,start,close}を返す。appはExpress境界、startは表示pumpを一度開始、closeは同期latchで受付/pump/SSEを閉じる。closeは冪等でnative/host/observerに終了操作をしない。listen/server.closeはlauncher所有。旧factoryは旧test経路として保持できるが新production経路で使わない。
- relayは確定済み§78.10.4.9.10のbindingと5methodsだけ。methodはbound copy、scopeとのID/cwd/provider一致を生成時に検査する。旧client/provider生成、独自入力queue、native RPC、authority object、setterを持ち込まない。
- scope.jsにfreezeRelayHttpScopeを追加する。fieldはrootThreadId,cwd,provider,authToken,authTokenSource,model,codexVersionのみ。既存のexact UUID/canonical existing cwd/codex provider/bounded外部secret token検査を再利用する。新production factoryはexternal-secretのみ。model/codexVersionは非空NUL無しUTF8 256bytes以内の表示metadataで、権限証拠ではない。旧pilotの固定readOnly policy/model/udsProxyPathを要求しない。
- 既存Bearer/query排他、定数時間token比較、route/query allowlistとscalar化、exact provider/cwd/sessionId、prompt4field allowlist/10KiB/NUL拒否を共用する。承認/登録/新規会話/interrupt等のrouteを追加しない。
- POSTはfresh UUID admissionId→admitPrompt→戻りreceipt.admissionIdでfresh sendAttemptIdをdispatchPromptへ1回渡す。nowはhostのepoch秒。clientからauthority/time/送信IDを受け取らず、本文hash dedupや自動再送を作らない。
- provider_acceptedだけ既存exact202 {ok:true,sessionId,provider}を返す。rejected/cancelledは固定非2xx未送信、uncertain/settlement_unknown/dispatch throw/close中の帰路は固定非2xx結果不明。queued/sendingも未確定。admit throwは未送信。下位errorのraw message/causeを応答/logへ転記しない。未送信と結果不明は別の固定error表示をringへ残す。
- ringはapp/binding専用500entriesとnumeric SSE ID。eventId/ack状態はprivate。relay.readOutput→検証/純粋wire変換→ringへ保存→acknowledgeOutputの順を守る。同eventIdを重ねて表示しない。未ack/ack不明entryをevictしない。全entry保護なら引取り停止。ack throwでは保存済み表示を維持し新pull/再ackを止める。resume APIを追加せず既存detach→fresh bindingを使う。無制限dedup mapは作らない。
- startは250msの単一pump。SSE clientゼロでもringへ保持する。読み取り/変換/保持/ack失敗時はpumpと入力受付を止め、可能な範囲で固定接続errorを記録する。故障時も保持済み表示を消さず/messagesとSSEから読めるようにする。別portへfallbackしない。
- wireはpayload spread禁止。text→text_delta{text}、status busy/idle→status{state,sessionId,provider}、disconnected→固定error、result→result{success,text:""}、error→error{message}。waitingOnUserInput/permission_requestはPCでの確認待ちという固定text_delta通知にし、承認button/response IDを出さない。未知kind/異形をfilter成功にしない。eventId/sequence/turnId/余分なpayload fieldをwireへ漏らさない。
- /status・/sessions・正常時/messagesは同relay.observeNativeへ委譲し、待ちフラグをawaitingへ写す。/sessionsはscopeの1会話だけ、titleは固定、timestampはobservedAtから生成する。/infoはscope metadataのみ。historyは501 {history:[],error:"relay-history-not-supported"}。/messages故障時は保持済みmessagesとconnectionState:"disconnected"を返し、idleを接続成功と説明しない。
- SSE replay/15秒heartbeat/numeric IDを維持する。client切断はclientだけを除く。新bindingは新app/ringとし、旧ownerの表示と未確定入力を移送しない。

**検証と受入**

実HTTP middlewareとfake relayで認証/誤宛先時の副作用0、元receipt ID、全dispatch state、保存→ack、ack内部成功後throw、500件保護、payload allowlist、2binding分離、SSE切断/replay、close中POSTと閉鎖後拒否を検証する。legacy provider生成とnative通信は0。実port guardは確定済みfacadeのtestsに委譲する。

2026-09-08ユーザーの「実装進めて」により局所実装へ進むための契約追加を承認済みであり、稼働サービスへの反映や実G2成功の受入とは区別する。client timeout後の再送挙動とhistory501の実client互換は後続で検証する。両provider実G2受入という全体目標は維持する。


#### 79.9.1 scheme の保存は固定 allowlist に限る

`authorization` 系で scheme を残す実装は、**値の最初の token を無条件に scheme と見なしてはならない。**
`{"authorization":"FIRST_SECRET SECOND_SECRET"}` が `FIRST_SECRET [REDACTED]` になり、
credential の一部が残る（2026-09-05 実測）。残してよいのは
**既知 scheme の固定 allowlist（`Bearer` / `Basic` / `Token` / `Digest` 等）に完全一致した場合だけ**で、
合致しなければ値全体をマスクする。

#### 79.9.2 自由文経路は「値が同じ行に無い」場合も塞ぐ

代入の区切りの直後が行末・空白のみなら、**次の非空行までを保守的にマスクする**。
`stdout: {"api_key":\n"MULTILINE_SECRET"}` が素通しになる（2026-09-05 実測）。
§79.3 の「終端を探さない」はここにも適用する — 巻き添えを許容して広くマスクする。

## 80. task 状態に依存しない人間判断依頼

### 80.1 独立した依頼と安全境界

`human_decision_requests` は人間への `approval | decision | review` を保持する独立familyとする。既存
`orchestrator_requests` のkindを増やさない。triage/todo/doneを含む既存taskへ複数作成でき、作成・回答・
受領・解決のいずれもtask row全field（status/blockReason/assignee/updatedAtを含む）を変更しない。
task event/commentの代理書込み、ready化、worker起動、merge/publish、遠隔permission承認も行わない。
task終端による自動cancelはない。ownerは作成時のactive exact orchestrator identityへ固定し、taskの
watch/binding変更で付け替えない。ownerが不在でも依頼・回答は消去しない。

状態は `waiting_human → answered → claimed → resolved`。ownerの明示cancelだけがwaiting_humanを
cancelledへ進められる。回答はrevision 1の一回限りで変更不可。訂正は同owner・同taskの旧依頼を
relatedRequestIdで参照する新依頼として作る。関連付けだけで旧依頼をsupersede/reopenしない。
不要になった回答はclaim後に理由付きobsoleteとしてresolveできる。

無回答時の方針はkindからapproval=`deny`、decision=`retain_current_state`、review=`not_accepted`を
導出する。deadlineは期限超過表示のためだけに使い、期限による回答生成・状態遷移・操作実行はしない。

### 80.2 入力、回答、冪等性

作成入力はtaskId、kind、title、question、idempotencyKey、任意deadlineAt/links/relatedRequestId。
titleは1..200文字、questionは1..12000文字、keyは1..128文字。日時は非負safe integerのUnix秒。
approvalはaction（1..200文字）とtargetRevision、reviewはtargetRevisionが必須。decisionだけがchoicesを
持てる（最大10、idは1..128文字・重複不可、labelは1..200文字）。kindに無関係なfieldは拒否する。
targetRevisionはgit_commitの40/64桁lowerhexまたはsha256の64桁lowerhex。可変branch/URLだけを
承認対象にはできない。

linksは最大10件のtyped参照とし、非空labelとURL、artifactName、taskIdのいずれかを持つ。URLは
http(s)かつuserinfo無し。task参照は存在を、artifact参照は安全なbasenameと同taskのartifact_attached
登録を確認する。これは物理ファイルの現在存在・将来の残存保証ではなく、取得失敗は表示側で明示する。
artifact resolverや新しいStore constructor依存は導入しない。関連requestのowner/task不一致は拒否する。

approval回答はapprove/reject、review回答はaccepted/changes_requested。decisionはchoicesが非空なら
exact choiceIdのみ、空ならtrim後非空textのみ。任意comment、自由text、resolve/cancel理由は最大12000文字。
choiceIdとtextの両指定やkind不一致は拒否する。answerはexpectedRevision=0とanswerIdempotencyKeyを持つ。

askの同owner+keyはunique。hashはversion/task/owner/kind/title/question/action/targetRevision/choices/
links/defaultOutcome/deadlineAt/relatedRequestIdの全immutable値を既定値へ正規化して計算する。配列順は保持。
同key同hashは既存row、同key差分はIDEMPOTENCY_CONFLICT。answer hashはversion/requestId/revision/
normalized answer/comment/human actorId。保存済みanswer key/hash/actorの一致をstatus/CASより先に照合し、
claimed/resolved後も同じrevision 1を返す。別keyや同key差分での再回答は拒否する。

### 80.3 provenance、claim、session lifecycle

create/cancel/claim/release/resolveは§60のorchestrator provenanceを要求し、既存active exact session/
generation検証を同じtransaction内で行う。owner不一致・旧世代・stale/closedはmutation 0。
answerはkind=human、非空actorId、空session、null generationのlocal claim。IdP認証済identityとは扱わない。
Webは§31のBearer write capabilityとsame-origin規律を検証し、provenance/nowをserver側で構成する。
HTTP JSONからowner/actor/nowを受け取らない。

claimはcallerが生成した非空claimTokenのSHA-256だけを保存する。claim DTO/read DTOは平文tokenもhashも
返さない。answeredまたはlease期限切れclaimedだけをactive ownerがCASで取得できる。leaseUntilはnowより後の
safe integer秒。releaseはexact owner/claimant/session/generation/tokenでclaimedをansweredへ戻す。
未奪取ならlease切れ後もrelease可。resolveは同fenceにleaseUntil>nowを追加してresolvedへ進める。
resolved/answeredへの遷移ではclaim欄を消去し、回答と元answeredAtは保持する。

planned handoffは同identity successorへclaimant session/generationを移し、token hash/leaseを保持する。
close、stale expiry、takeoverでは回答を保持してansweredへrequeueする。これらは既存session操作と同じ
transaction内で処理し、次の全6経路を覆う: successor launch付きhandoff accept、同takeover、従来handoff、
従来stale takeover、close、expire stale。旧session/generationや奪取前tokenの操作は拒否する。

### 80.4 Core APIとDB

型・validation/canonicalization・row mapping・HumanDecisionError・HumanDecisionRequestStore・
HumanDecisionReadViewは新human-decision.tsへ置く。既存types.tsは変更しない。SqliteKanbanStoreと
KanbanReadViewCapabilitiesにadditive capabilityとして実装し、index.tsからexportする。

Store APIはcreateHumanDecisionRequest、answerHumanDecisionRequest、cancelHumanDecisionRequest、
claimHumanDecisionResponse、releaseHumanDecisionResponse、resolveHumanDecisionResponse。各inputは
provenanceと任意nowを含むobject。answer/cancelはexpectedRevision=0、claim/release/resolveは=1。
claimはrequestId/claimToken/leaseUntil、releaseはrequestId/claimToken、resolveはそれに
resolution={outcome:handled,note?}|{outcome:obsolete,reason}を加える。全mutationはread DTOを返す。

Read APIはgetHumanDecisionRequest(id)、listHumanDecisionRequests({taskId?,tenant?,statuses?,limit?})、
listHumanDecisionResponses({ownerOrchestratorId,limit?})。getは不存在ならnull、listは作成時刻/id順、
responsesはanswered/claimedだけを元answeredAt/id順で返す。limit省略は全件、指定時は1..1000。
tenant絞り込みはtasksとのJOINでLIMITより前に適用する。Webの一覧はtask単位dedupeや暗黙の先頭件数切捨てで
依頼を隠さず、詳細にも既存tenant境界を適用する。read DTOはask/answer/provenance/claimant/leaseを含む。

migration v32で独立一表を追加し、既存v30/v31のdataは変更しない。v29へv32を単独先行統合しない。
列groupは次とし、nullable/空値/requiredの組合せとkind/status/revisionの不変条件をCHECKで固定する。

- identity: id（hd_+16lowerhex）、task_id FK、owner_orchestrator_id FK。
- ask: kind/title/question/action、target_revision_kind/value、choices_json/links_json、default_outcome、
  related_request_id self-FK、deadline_at、ask_idempotency_key、ask_payload_hash。
- lifecycle: status、answer_revision（0|1）、created_at、updated_at。
- answer: answer_idempotency_key、answer_payload_hash、answer_payload_json、answered_at。
- claim: claimant_orchestrator_id/session_id/generation、claim_token_hash、claim_lease_until。
- terminal: resolution_outcome/reason、resolved_at、cancel_reason、cancelled_at。
- audit: request/answer/cancel/resolveそれぞれをprefixとする§60と同じ4列provenance。

UNIQUE(owner_orchestrator_id,ask_idempotency_key)をBINARYで保持し、status/created_at/id、task/status/created_at/id、
owner/status/answered_at/id、claimant_session/generation/statusのindexを作る。JSONはcanonical、hashは64lowerhex。
answerとcancelはwaiting_human/revision0条件の単一UPDATEで競合させ、一方だけがchanges=1となる。

ReadView constructorはreadonly openのみ。新query呼出時にmigration32を確認し、未適用なら
SCHEMA_UNAVAILABLEをthrowする（空queueで隠さない）。readonly側でmigration/journal設定変更を行わない。
v31時点で生成した同じviewが、別Storeによるv32更新後に新queryを使えることを保証する。

error codeはINVALID_INPUT/TASK_NOT_FOUND/REQUEST_NOT_FOUND/REFERENCE_NOT_FOUND/ACTOR_UNAUTHORIZED/
SESSION_SUPERSEDED/OWNER_MISMATCH/IDEMPOTENCY_CONFLICT/REVISION_CONFLICT/STATE_CONFLICT/CLAIM_CONFLICT/
SCHEMA_UNAVAILABLEに限定する。Webは順に入力400、不存在404、主体403、競合409、schema未適用503の群へ対応する。

### 80.5 CLI/Webと受入

CLIはorchestrator askとhuman-decision専用answer/show/cancel/claim後のresolve/releaseを提供する。
既存worker_question専用answer/escalateとstall等resolveのkind境界を維持する。inboxは3familyを併記する。
awaitは同pollで既存orchestrator/cleanup/human response候補を列挙し、合計1件だけclaimする。
claimableAtは既存orchestrator.createdAt、cleanup元request.createdAt、human.answeredAt。kind/idでtie-breakし、
lease失効でも元時刻を保持する。未選択候補はcredential無しsummary、選択後CAS競合は再pollする。

Webの回答POSTだけを§14の限定writeへ加え、§31の既存requireWriteAuth/WriteTokenModal/一回retryを再利用する。
未認証/別origin/不正payload/stale revisionはmutation 0。GETはHumanDecisionReadViewだけを使う。
全task row不変、複数依頼、回答/cancel競合、終端後同answer retry、owner/tenant分離、6session経路、期限の
副作用なし、v31→v32と新規1..32/reopen、既存G2data保持を公開APIで検証する。UIの実browser証跡はworkerがattachする。
holder表示とCIのtruth sourceは後続設計とし、task statusだけでCI待ちを捏造しない。

#### 80.5.1 トップの確認ドロワー（2026-09-10）

- 初回/再読込は閉じた右ドロワーとし、小画面は全画面。未回答/新着でも自動展開しない。
  ヘッダー入口はトップのみ常設し、waiting_humanのみをバッジ集計（期限超過を含む）。0件は数値を隠す。
  対象は選択tenant（未選択は全体）で、検索/状態/watchの絞込は適用しない。ドロワー内に対象を明示する。
- 確認待ち=waiting_human、回答済み=answered/claimed（処理待ち/処理中）、履歴=resolved/cancelled
  （解決済み/取消）の3タブとし、既存の取得順を維持。開くたび確認待ちを選び、空なら
  「確認待ちはありません」と他タブへの入口を示す。回答後も閉じない。
- データ取得/送信の所有者を一つにし、閉じていても既存30秒pollingを継続する。
  開閉/タブ切替で下書き・送信中・不確定回答の冪等キーを破棄しない。同一tenantのトップ滞在中だけ保持し、
  tenant切替は既存epoch分離で旧内容/遅延応答を隔離。再読込後の永続保存はしない。
- 回答成功をサーバーで確認してから件数/所属を更新し、「回答しました。回答済みで確認できます」を通知、
  確認待ち見出しへfocusを移す。送信中/不確定/失敗を成功扱いしない。
- 初回取得中/失敗を0件と表示しない。更新失敗は前回件数に警告を付け、内部に理由と再取得を置く。
- モーダルはRadix Dialog（@radix-ui/react-dialogを@hachi/webの許可依存へ追加）で実装する。
  背景操作を遮断し背景クリックで閉じない。閉じるボタン/Escapeで閉じトリガーへfocus復帰。
  WriteTokenModalも同primitiveへ接合し、認証が上にある間はそのEscape/focusを優先する。
  その他メニューを閉じてから確認を開く。
- 320/375/768/1280pxで重なり/操作欠落/ページ横スクロールなし、keyboard、light/dark、成功/不確定再送/認証、
  開閉後の入力保持、tenant遅延応答、取得失敗を合成fixtureで検証。既存回答API/承認の意味/task状態は不変。




#### 78.10.4.9.12 接続先board sessionのreadonly解決（2026-09-08）

- 起動CLIが真のreadonly接続からnative bindingを解決するため、readview.tsのadditive capabilityへ
  freshActiveOrchestratorSessionByProvider({provider,providerSessionId})を追加する。戻り値は
  FreshActiveOrchestratorBinding | null。公開型はreadview.tsに定義し、既存barrel経由で公開する。
  bindingのreadonly fieldsはid（board session ID）、orchestratorId、generation、provider、
  providerSessionId、providerSessionSource、heartbeatAt。types.ts/DB schema/既存Store/CLIは変更しない。
- 入力providerはcodex/claude、IDは非空・空白のみ不可・NUL不可。暗黙trim/ID変換はしない。
  同一SELECT snapshotでprovider/native IDをBINARY exact検索し、既知statusを検証してactiveだけを選ぶ。
  activeが複数ならfreshness/sourceで都合よく1件へ絞らずthrow。active 0件はnull。
  他provider/他nativeのrowは混ぜない。missing schema/column、未知statusはthrowでfail-closed。
- 選ばれたactive rowのid/orchestratorId/native IDは非空・空白のみ不可・NUL不可、generationは正safe integer、
  heartbeatAtは非負safe integerとして検証する。heartbeatは呼出し時のfloor(Date.now()/1000)から90秒以内
  （ちょうど90秒を含む）かつ未来でない場合だけfreshとする。古い/未来heartbeatはnull。
  clockはcallごとに一度読み、公開APIへcaller指定時刻を追加しない。
- sourceはcodex-session-start（codex）/claude-delivery（claude）の一致だけをnative eligibleとする。
  manual/空文字/NULLのlegacyはnull。未知source、providerと逆のtrusted sourceはthrow。
  返却は新しいplain objectで、DB row参照/書込能力/Store/private importを公開しない。
  heartbeat更新後の再readを反映し、handoff_pending/superseded/stale/closedはnullを返す。
- factoryは既存createKanbanReadViewを使いreadonly/fileMustExistを保つ。DBの新規作成、migration、journal変更、
  heartbeat更新をしない。実board DBをtest fixtureにしない。
- tmp実Storeでseedしreadonly factoryから正常両provider、BINARY ID、inactive、90秒境界、future、
  unknown/corrupt/duplicate、untrusted source、read後の世代/status/heartbeat変更、返却値mutationの独立性、
  missing schema/fileとDB非変更をfocused testする。破損fixtureのSQLはtmp DBだけに限定する。
- これは局所read APIであり、初回captureだけでは継続中の権限を証明しない。CLI/hostの各送受信guardへの
  exact binding再照合の接合、別processのrestart fence取得、実G2受入は後続工程とする。


#### 78.10.4.9.13 接続先board bindingの継続確認（2026-09-09）

- Coreのpackage-private module relay-board-binding-checker.tsで、既存readonly resolverだけを使う
  createRelayBoardBindingChecker(dbPath:string):RelayBoardBindingCheckerを提供する。barrelへexportしない。
  新Store/schema/ledger/clock/timer/通知/終了処理は作らず、真のreadonly handleを一つ所有する。
- RelayBoardBindingCheckerはcapture({provider,providerSessionId,generation}):RelayBoardBindingCaptureと
  close():voidを持つ。入力をprivate copyし、provider/IDは.9.12と同じ、generationは正safe integerとして検証する。
  captureはfreshActiveOrchestratorSessionByProviderを一度読み、null/throw/generation不一致を拒否する。
  caller指定binding、guard、readView、clock、sourceを受け取るAPIを作らない。
- RelayBoardBindingCaptureはreadonly binding:FreshActiveOrchestratorBindingとassertCurrent():voidだけを持つ。
  capture objectと返すbindingをfreezeし、内部比較値はcallerから書き換えられないprivate copyへ固定する。
  比較値はid/orchestratorId/generation/provider/providerSessionId/providerSessionSourceの六値。
  heartbeatAtはcapture時の観測値であり同値比較しない。各assertで既存resolverを再読してfreshnessを確認する。
- assertCurrentは同期。再読null/throw/六値不一致でそのcaptureを不可逆にinvalidatedへ固定し、固定errorをthrowする。
  失効後は同じrowがfreshへ戻ってもDBを再読して復活しない。他captureを自動失効させず、provider/nativeの異なる
  複数captureを独立保持できる。host全体の利用拒否/解除signalは後続のhost接合が所有する。
- RelayBoardBindingErrorは固定codeをINVALID_INPUT/BINDING_UNAVAILABLE/BINDING_INVALIDATED/CHECKER_CLOSEDから
  一つ持つ。null/破損/DB例外の生message/cause/IDをerrorへ転記しない。生成時open失敗とcapture時不成立は
  BINDING_UNAVAILABLE、capture後の失効はBINDING_INVALIDATED。入力不正はINVALID_INPUT。
- closeは全captureの以後の利用を同期拒否してからreadonly handleを一度閉じる。成功後は冪等、失敗は固定errorを
  BINDING_UNAVAILABLEとして保持し、後続closeでもthrowして成功へ変換しない。
  閉鎖済みserviceのcapture/assertはCHECKER_CLOSEDを返す。
  captureの単独失効ではhandleを閉じない。host/observer/native/authorityの終了操作は行わない。
- serviceのmodule-private WeakSetによるisRelayBoardBindingChecker(value:unknown):value is RelayBoardBindingCheckerを
  同module内の内部exportとして用意する。shapeだけ一致する偽objectはfalse。barrelへexportしない。
  これは後続の内部host注入の取り違え防止であり、同processの任意コードに対する隔離境界とは扱わない。
- focusedはtmp実Storeのseedと真のreadonly factoryを使う。両provider正常、heartbeat更新許可、六値差替え拒否、
  stale/future/inactive/unknown/duplicate/DB失敗、失効後復活拒否、複数capture独立、caller mutation独立、
  不正入力/generation、副作用なし・missing file、close後拒否/一度close、nominal検査を確認する。
  close例外だけはreadonly closeへの制御fault注入を許す。実boardをfixtureにせず、host/API/CLIへの接合は別工程。
- 所有は上記moduleと同名testだけ。readview.ts/types.ts/index.ts/DB/host/adapterは変更しない。


#### 78.10.4.9.14 board bindingをhostの送受信へ束縛する（2026-09-09）

- .9.13のcheckerを既存RelayHostLifetimeのconnection_only attemptへ接合する。Mac nativeの停止権限を
  増やさず、新Registry/Store/ledger/再送/cleanup state machineを作らない。正規production組立は次の
  composition工程でこの経路を必須にする。従来native_ownedと既存の低水準fixture経路は変更しない。
- constructorの第二引数として内部hook `{checker:RelayBoardBindingChecker,requestDetach:()=>void}` を任意に取る。
  hookはconnection_only専用とし、isRelayBoardBindingCheckerによる実体検査とfunction検査を生成時に行う。
  checker参照とcallbackを一度だけprivate copyする。hook型をbarrelへ追加exportしない。
  openRelayConnectionHostの公開optionsへcaller指定guard/checker/readView/clockを増やす変更はしない。
  hook無し低水準経路を、board継続確認済みのproduction接続として扱わない。
- startAttemptは既存入力検証後、attempt/予約登録とcontroller factoryより前に、正確なprovider、
  attach_existing.providerSessionId、handoverGenerationをchecker.captureへ渡す。失敗は副作用前に拒否する。
  canonical native target.sessionIdはproviderSessionIdと別IDのまま保持する。captureはattemptごとに固定し、
  異なるprovider/nativeの複数attemptを単一captureへ縮退させない。
- 登録済みattemptのcapture object identity、provider/native/generation、record identityを検査し、
  factory/startの直前と帰路、claim/activate/publication/input準備の前後、最終成功帰路でもassertCurrentする。
  起動pipeline内の失効は既存外側catchのfailureLatched/firstStopFailure/sticky規律を維持する。
  active成功後のboard失効だけをauthority guardのfatal poisonへ変換しない。
- runtime portをcontrollerへ渡す前にfrozen wrapperへ固定し、heartbeat/ingest/acknowledgeの前後で
  attemptのboard captureとhost利用可否を照合する。保存済みwrapperの再利用も同じ検査を通す。
- input receiverはcleanup用raw receiverと公開frozen wrapperを別保持する。admit/cancelQueuedは前後、
  dispatchは一度だけ内部dispatchを呼ぶ前とPromise成功帰路で検査する。内部settlement結果は書き換えない。
  public closeはcleanup操作としてraw receiverへ委譲でき、board checkerを通さない。closeで新送信をしない。
  drain/retire経路はraw receiverを使い、公開wrapperを迂回することをcleanup権限の緩和と混同しない。
- outputは既存host wrapperの前後検査へcapture確認を加える。getterは有効中に同じ公開wrapper identityを返し、
  未準備/失効/停止後はnull。getInputReceiverにも同じ規律を適用する。getterが失効を発見しても例外を
  生詳細付きで外へ漏らさず、下記latch/通知後にnullを返す。
- RelayAuthorityCoordinator.guardとinput coordinatorのpublic/continuation guardは既存のまま保つ。
  board条件をDB mutation/settlement/receiver close用guardへ合成しない。失効後も既存writer/full ownerが
  有効なら、発行済み送信permitの結果と未確定記録を保存し、connection cleanupとretireを実行できる。
  送信の内部settlementがacceptedでも、失効後の公開成功帰路はNOT_RUNNINGで拒否する。再送しない。
- 最初の失効はhost全体のconnection利用拒否latchを同期で立て、requestDetach callbackを一度だけ呼ぶ。
  同stackではstop/closeAdmissions/close/retireを直接実行せず、Promise継続を新規登録しない。
  callbackの責務はcompositionがroot文脈で事前登録したdetach signalをresolveすることだけ。
  callback throwはfirstStopFailureへ保存し、成功へ隠さない。呼出側へ返す失効エラーは固定NOT_RUNNINGとする。
- requestConnectionDetach():voidを低水準hostへ追加し、内部hook有効時だけ同じ利用拒否latch/一度通知を行う。
  これはfactory failureの接合先であり、detach完了の証拠を返さない。hook無し/別modeはINVALID_CONFIGURATION。
  失効後はstart/startAttemptと全利用portを拒否する。state表示はstop_requested相当とし、実停止結果は既存stopの
  Promiseでのみ判定する。checkerがfreshへ戻ってもlatchを解除しない。新しいhost/captureで明示再接続する。
- 現行stop単位はwhole-hostのため、一つのattempt失効でそのhost配下のG2接続を全てdetachする。
  Macの各会話は続く。per-attempt detachの新機構を今回作らない。既存stopPlan/stopExecutionPromiseを再利用し、
  不完全停止やauthority喪失時のsticky保持、Store close条件を緩めない。checkerのcloseはcomposition所有のまま。
- focusedは既存実Store/namespace/controller fixtureに真のcheckerを接合して、世代不一致のfactory副作用0、
  heartbeat更新、複数captureのidentity、active後失効の同stack拒否→root detach、保存port/getter拒否、
  send中失効の内部receipt保存と公開成功抑止、raw close/drain、起動途中失効のsticky、authority失効のsticky、
  callback一度/throw、native stop 0を確認する。所有はlifetime.tsと新relay-host-board-binding.test.tsだけ。
  composition/adapter/HTTP/CLI wiringと全体gateは別工程であり、本工程だけで実G2接続済みとしない。

#### 78.10.4.9.15 production compositionのboard bindingと解除完了（2026-09-09）

- openRelayConnectionHostは同じdbPathからcreateRelayBoardBindingCheckerを必ず生成し、.9.14の内部hookへ接合する。
  既存board ID読取り→Store生成→board ID再照合→checker生成→namespace lease取得→lifetime生成の順とする。
  caller指定checker/readView/board clock/guardを公開optionsへ追加しない。registryTuning.nowは既存registry専用であり、
  board鮮度確認の時計へ流用しない。native identityのcaptureは引き続きstartAttemptで行う。
- checkerはStore/lease/hostとともにmodule-private retained objectが所有する。lease前のエラーでは、生成済みの
  checkerとStoreをその順に両方closeする。closeが失敗しても残るcloseを試み、元の起動エラーを投げる。
  一つでもclose失敗なら参照を保持する。lease取得後の生成失敗はchecker/Store/leaseを閉じずsticky保持する。
- root文脈でdetach signalのPromise継続を一度だけ登録し、lifetimeへ渡すrequestDetach callbackはsignalのresolveのみを行う。
  signal継続からfacade.detach()へ入る。guard/controller callbackの同stackでstop/close/new thenを実行しない。
  facade参照が設定される前のsignalもmicrotask継続で処理する。生成途中でfacadeが成立しなかった場合は保持した
  resourceを独断で解放せず、unhandled rejectionも起こさない。
- 公開面はRelayManagedConnectionHost extends RelayConnectionHostを追加し、openRelayConnectionHostの返り型を
  RelayManagedConnectionHostにする。既存RelayConnectionHostの最小面は保持する。新型はcompositionとcore barrelから
  exportする。raw checker/Store/lease/hostは公開しない。
- 新公開面はrequestConnectionDetach():voidとreadonly detached:Promise<Extract<RelayHostLifetimeStopResult,
  {readonly mode:"detach"}>>。requestConnectionDetachはlifetimeの同名methodへ委譲し、同期利用拒否を確定する。
  factoryのonConnectionFailure接合に使え、解除完了を表さない。detachedはgetterで安定した同一Promiseを返す。
  facadeのown propertyへprivate resourceを漏らさない。
- detachedはfacade生成時から存在し、未解除の間はpending。明示detach()は既存host.stop({mode:"detach"})を最初の
  呼出stackで一度だけ要求し、常にdetachedと同一のPromiseを返す。自動解除・明示解除・再入は同じ結果へjoinする。
  成功条件はhost stop成功→checker.close成功→Store.close成功の全成立。stop失敗なら両handleを閉じない。
  stop成功後はchecker/Storeを各一度closeし、先のcloseがthrowしても後のcloseを試みる。最初のclose failureでrejectし、
  retained集合から削除しない。全成功時だけ削除してdetach結果でfulfillする。再呼出で失敗を成功へ変換しない。
  detachedのunhandled rejectionは生成時に登録したcatchで防ぐが、元Promiseのrejectは保持する。
- state=stoppedだけをclean detachの証拠にしない。起動側はdetachedで解除結果を観測する。Mac native停止権限を
  増やさず、未確定入力の自動再送・移送を追加しない。再接続は新host/captureで既存会話へ明示接続する。
- 実openRelayConnectionHostを使うfixtureは実tmp boardへtrusted sessionをseedする。checker省略やproduction時計注入で
  旧fixtureを通さない。core composition実装/fixtureと、adapterの既存実host fixture更新はpackage所有を分ける。
- focused受入は既存singleton/authority/sticky回帰に加え、本物board bindingでの接続、世代違いのfactory0、active失効の
  同期port/getter拒否と自動detach、明示/自動/再入一度stop、detached同一性/pending/成功/失敗、close各失敗時の順序と
  retained保持を確認する。core担当はcomposition.ts/composition.test.ts/index.tsだけ。lifetime/checkerは変更しない。
  adapter fixture/結合確認、全repo gate、CLI wiring、実G2受入は後続工程。ここだけで全体完了を主張しない。

#### 78.10.4.9.16 受入済みHTTPのworkspace配布

- §78.10.4.9.11の受入済みHTTPをpackages/relay-http（@hachi/relay-http、private ESM）へ配布する。
  dedicated/entry.jsの静的import closure 15ファイルを受入manifestとbyte一致で再利用し、SHA256を照合する。
  HTTPの送受信/認証/close処理を変更せず、旧providerへの呼出を追加しない。
- 公開valueはcreateDedicatedRelayHttpBindingだけ。公開型はscopeと{app:node:http RequestListener,start():void,
  close():void}、optionsは{relay:CodexRelayHttpFacade}。HTTP serverの起動/終了はCLIが所有する。
- 外部実行依存は既存lockfileと同じexpress 5.2.1とws 8.21.3。adapters型参照はworkspace依存とする。
  既存の無関係依存は更新しない。必要な型検証用依存は既存TypeScript/Node typesだけを用いる。
- 受入済み15 HTTP testsと配布manifest検査を行う。CLIからの絶対.evidence path依存を作らず、
  sourceの再実装や再コンパイルをしない。配布の成立を実G2での成功や全体完了と扱わない。


#### 78.10.4.9.17 Codex CLIのG2接続管理

目的: 常駐Mac ownerが保持する同じobserverへ、受入済みhost/factory/HTTPを接合する。Mac起動コマンドから使う内部moduleを先に実装し、その後コマンド登録と実機受入へ進む。

所有: packages/cli/src/codex-g2-connection.ts と同名test。依存@hachi/relay-httpの追加とlockはhostが担当。Core/adapter/HTTP実装は変更しない。

入力: Mac所有observerのidentity/observe/subscribeだけ（close/waitForCloseは受け取らない）、実board/adoption/host設定、active generation、Mac ownerのHTTP runtime boot epochとcanonical URL、明示listen address/port、external auth token、表示metadata、既存接続timeouts。対象native両ID/socket/cwdはobserver.identityから取得。最新会話探索や別endpointへのfallbackなし。

公開面: state、connect()、detach()。状態は利用者表示と同時操作の排他用で、ledger/authorityの代替ではない。initial→connected→detached後に明示connectする。接続中は二重connect拒否、同じdetach呼出は一つのPromiseへjoin。解除結果不明は不可逆unknownとし、再connectを拒否する。Mac observerを停止/再生成しない。

接続: 同一managerのboot epoch/URL/native/generationは固定。初回はpurpose initialとprevious null、clean detach後だけpurpose restartと前activation.ownerの完全fenceを利用する。新hostへstartupMode serveを使い、adoptによる初期化は初回だけ。受入公開APIでfactory→openRelayConnectionHost→start→startAttempt→facade→HTTP binding→Node listener→HTTP startと接合する。activation前にHTTP入力を公開しない。connect失敗は接続資源のcleanupを試み、Mac会話には触れない。未知のlease/claim状態を初期値へ戻さない。

解除: 公開HTTPのcloseで受付/pump/SSEを閉じ、Node serverのcloseを完了させ、host.detach()/安定detached Promiseの成功を待つ。成功resultはmode detach。state stoppedだけで完了判定しない。HTTP close/server closeが失敗してもhost解除を試みる。一つでも不明・失敗ならunknownを保持し、残るhandle参照を捨てない。factory lossとboard自動detachは同じcleanupへ合流する。callback同stackから重いstop/新Promise継続を組まず、rootで事前登録したsignalを利用する。

競合: connect中detachは即座に停止要求を記録し、以後の公開を禁止する。各await帰路で停止要求を照合する。進行中操作の結果を観測してから一度cleanupし、古いconnect継続が新接続やconnected状態を復活させない。起動/解除に失敗したhostを再利用しない。

検証: 呼出順序、provider IDとcanonical IDの独立、二重connect拒否、clean detach再接続のfull fence/serve、detach失敗後再connect拒否、HTTP listen失敗でもMac未停止、起動中detachで未公開、factory loss/board lossによる自動解除と明示解除のjoin。既存host/adapterの意味をmockで証明した扱いにせず、実host fixture/全体gateと実G2受入を後続で必須とする。

確認済み: fresh host + serve、同epoch/URL、same generation + exact previous fenceのrestartは既存Core結合testで対応済み。旧ownerはprevious照合だけに使用し、新activation.ownerを保存する。

自動解除の順序: board失効はCore内部から解除が進む。CLIはhost.detachedのresolve/rejectをrootで事前購読し、残るHTTPを閉じて管理状態を合流させる。この経路にはHTTP先行を要求しない。host非running時のHTTP facadeは既存検査で利用を拒否する。明示解除とfactory lossではCLI側からHTTPを先に閉じる。host.detached.finally(() => detach())だけを唯一の監視路としない。

実装固定事項: factory関数名createCodexG2Connection。公開はreadonly state、connect():Promise<void>、detach():Promise<void>。stateはdisconnected/connecting/connected/disconnecting/unknown。同時connectは拒否、各接続cycleのdetachは安定Promiseへjoinする。unknownから復帰しない。optionsはobserver最小面、hostOptions（既存公開型からlanes/startupMode/registryTuningを除いたもの）、初回startupMode、handoverGeneration、canonicalServerUrl、listenHost/listenPort、external authToken、model、native connect/request timeout、HTTP listen/close timeoutとする。listener期限は正safe integer。listenPortは1〜65535、canonical URLのeffective portと一致させ、port0/暗黙fallbackは禁止。設定は生成時captureし、observer identityもcaptureする。実HTTP runtime epochはこのmanagerの生成時randomUUIDを一度生成して全再接続に保持する。

API利用: observerのclose/waitForCloseをcapture/呼出しない。native ID/cwd/socketをoptionで重複指定させない。HTTP scope.rootThreadIdはidentity.providerSessionId、target.sessionIdはidentity.sessionId、target.providerSessionIdはidentity.providerSessionId。HTTP scope.codexVersionはidentity.runtimeVersionから表示用に構成、authTokenSourceはexternal-secret。

失敗規律: host.start成功後は次のopenにserveを使う。activation成功時点でownerを保持し、HTTP listen失敗でも忘れない。全cleanup成功ならdisconnectedに戻して次の明示connectを許すが、activation済ならrestartが必須。host生成でthrowした場合は内部retained状態を区別できないためunknownにする。開始失敗後もhost.detachを試みて安定detachedへjoinする。stop失敗/HTTP close失敗/期限切れはunknownのまま保持。後発成功でunknownを上書きしない。未知handleはmodule-private retained集合へ残す。

HTTP: createServer(binding.app)はactivation/facade生成後だけ。listen成功後にbinding.start。closeの各失敗を固定errorで返し、生token/native IDs/cwdをmessage/causeへ含めない。listen/closeはbounded Promise。HTTP closeがthrowしてもserver close/host detachを試みる。closeAllConnectionsによる強制成功化や他serverの停止をしない。

実装は上記moduleと同名focused testsだけを一成果物とする。mock boundaryは呼出順/競合/所有範囲の証拠に限定し、実host結合/全体gate/実G2を置き換えない。上記検証を完了したら終了し、コマンド登録・Mac起動owner・実provider・実board・ネットワーク・追加agent・publicationは本workerへ含めない。

#### 78.10.4.9.18 Codex起動時のrelay専用登録証明（2026-09-09）

##### 利用体験と範囲

明示した既知threadを専用app-serverでresumeし、Macで同じ会話を使いながらG2を接続する。G2準備・登録証明・HTTP起動の失敗はG2未接続として返し、正常なMac会話を停止しない。TUIの終了を会話終了とみなさない。新しいprocess ledger、owner lease、TUI監視state machineを作らない。

##### 登録証明の意味

sourceは`codex-native-resume`。通常register/session-startはmanualのまま。新値はrelay用read resolverだけが認識し、successor attestation、native communication、通常CLIのsource指定権限へ広げない。これは実起動から登録された由来を表し、現在のMacプロセスの生存やrelay所有をsource値単独で証明するものではない。

production入口はMac owner wrapperに限定する。callerのJSON、socket pathだけ、外部から渡されたobserver shapeだけを登録証明へ昇格させない。wrapperが専用0700 directoryを作り、endpoint非存在を確認して起動したapp-serverと実observer factoryを保持する。既知thread/cwd/home/runtime、実native両ID、endpoint属性・起動したprocessとの関係を確認する。Popenのlauncher PIDをそのままUDS holderとみなさない。各Mac起動で確認を再実行し、sourceの既存値で省略しない。

同processの任意コードや同UIDによる任意board改変に対する隔離を、このwrapperの型・object brandで提供すると主張しない。実装の正規経路で確認を省略できない構造と、異なるendpoint/会話の取り違えを防ぐ検証を対象にする。正本§50.1.1（2884-2902行）の同uid協調境界と§78.1（6418-6422行）の適用を維持し、下記の前後照合を使う。実FD peer PID取得のための新native binding、private Node API、別proxyをこの工程で追加しない。

###### 起動確認の固定方針

- Mac ownerはDarwin上で、自ら作ったrandom専用directory（0700/current uid/非symlink）と、起動前に不存在だった明示UDSだけを使う。既存socketを採用・削除・置換せず、設定探索/fallbackをしない。
- retained app-server起動handleの終了状態と、実UDS holderのPID/start identity・launcherからの親子関係を確認する。lsofは当該起動treeに絞りexact pathnameを保持する候補だけを取り、PIDそのものや自己申告metadataだけでは一致としない。候補複数・検査失敗・上限超はG2未接続。TUIや無関係workerの全process追跡を条件にしない。
- 実observer生成/resume/fresh observeの前後、およびG2接続前に、directoryとsocketのlstat属性・dev/ino/uid・socket0600・holderのPID/start/親子関係を照合する。同一でなければ登録操作へ進まない。前後検査はraceの検出であり原子性や悪意ある同uidに対する保証ではない。観測不一致を復元して成功扱いにしない。
- wrapperは実factoryが生成したobserverをprivate保持し、外部callerからobserver/検査済flag/sourceを受け取るCLI経路を作らない。同じobserverをmanagerへ渡し、G2 detach/reconnectではresume/observer再生成をしない。
- sourceが既に登録済みでも新Mac owner起動時の検査を省略しない。Mac/nativeの終了・observer失敗は既存connection failureと未接続表示へ合流し、source bitを生存証拠にしない。TUIのcloseだけでは失効させない。

##### 接合順序

1. Mac起動と実observerのfresh観測を成功させ、immutableな観測結果を保持する。
2. 既存`openRelayConnectionHost`でboard/adoption namespaceの排他を取得する。
3. 同host所有のStoreを使う狭い登録操作を実行する。raw Store/leaseをwrapperへ公開しない。
4. `host.start`より前、host state=newの間だけ登録操作を完了する。各await帰路の停止要求を確認し、detach要求後に登録/公開を継続しない。
5. 同じcaptured observerで既存factory/startAttempt/facade/HTTPへ進む。native両IDとendpoint、generation、full ownerの既存検査を維持する。

失敗時は既存managerのcleanupへ合流する。登録sourceを未確認値へ戻す補償処理やHTTP失敗後の自動再送を追加しない。新managerが既存HWMをinitialで迂回できない規則を維持する。

##### Store操作

exact orchestratorId/sessionId/generation/provider thread IDを入力とし、clockはStore側で取得する。単一IMMEDIATE transactionでactive、fresh（未来heartbeat不可、90秒以内）、provider=codex、ID完全一致、同native IDのactive row一意を確認する。manualから新sourceへCASする。既に新sourceなら同じexact rowだけ冪等成功を許すが、起動側の再確認を省略しない。他provider/source、空source、別session/gen、stale/inactive、重複、DB不整合はmutation 0で拒否する。

この操作はproviderSessionId、generation、status、heartbeat、handoff tokenを更新しない。既存`codex-session-start`の正規sessionは通常の既存接続経路を使い、sourceを書き換えない。source変更は利用中captureの比較に影響するため、namespace排他取得後・新capture前だけに限定する。

##### 公開接合APIの固定方針

`attestCodexNativeResumeOnHost(host, input):void`をcomposition moduleからadditiveにexportする。inputはreadonlyなorchestratorId/sessionId/generation/providerSessionIdの四値だけ。任意source、clock、Store、lease、guard callbackは受け取らない。実Mac起動確認済みのwrapperからの由来申告を保存する入口であり、このCore関数自身がOSプロセスを起動・観測したと主張しない。

hostは同moduleが作成した実facadeのみ受理する（private WeakMap/instance identityで照合）。shape互換fake hostを拒否する。既存RelayManagedConnectionHostの必須methodを増やさず、既存fixtureのinterfaceを一斉変更しない。内部でstate=new、detach未開始、単一codex lane、retained Store/leaseが当該hostに対応することを確認し、lease.assertAuthorityHeld→同Storeの狭いCAS→lease.assertAuthorityHeldを同期に実行する。開始後/停止要求後/閉鎖後の操作は副作用前に拒否する。post-assert失敗時は成功を返さず、sourceを補償更新せず、既存sticky/cleanup規律を維持する。

Store具体classに`attestCodexNativeResumeSession(input):void`を追加する。inputの全fieldはNUL無し非空bounded IDと正safe generationとしてDB操作前に検査してcopyする。返却はvoidで、前述の不成立は固定error codeにする。生SQL/native ID/cwd/tokenをerrorへ載せない。一般KanbanStore interfaceや通常CLIのsource指定面へ追加しない。

managerにはoptionalな`nativeResumeSession:{orchestratorId,sessionId}`をcaptureする内部optionだけを追加する。generation/providerSessionIdは既存captured値を使い、重複指定させない。optionがある時はhost生成・detached監視登録後、assertContinuable→attestCodexNativeResumeOnHost→assertContinuable→host.startの順。無い場合は従来のtrusted登録経路を保つ。wrapperはnative resume由来のmanual sessionで必ずこのoptionを設定する。callback注入や外部CLIの検査済flagを作らない。

登録のtransaction内部では、入力検査後にnowSecondsを取得し、前述のfreshnessとsource CASを行う。lease検査はcomposition所有のままとしStoreにrawleaseを渡さない。Storeの単体テストは登録由来の保存・DB競合の証拠に限り、OS確認成功の証拠としない。

##### schemaと影響範囲

ProviderSessionSource unionとorchestrator_sessions CHECKへ新値を追加する。歴史V23 SQLの書換えだけで済ませず、既存DBへ適用する新migrationを用意する。session row、全FK参照、index、既存sourceを保存し、migration失敗はtransactionをrollbackする。successor_launches CHECKと既存source allowlistは変更しない。

移行方式は単一IMMEDIATE transaction内で、id/sourceの一時退避→source列のDROP COLUMN→拡張CHECK付き同列ADD→id一致で元source復元→一時退避削除→FK検査→migration記録とする。foreign_keysをOFFにしない。予期しない列依存/index等でALTERが失敗したらrollbackし、制約を削除する別方式へfallbackしない。適用済みversionの再実行では列をdropせず、期待CHECKを検査する。実SQLite 3.53.2の一時DBでFK ON・参照3行・非source index保持、controlled rollbackによる旧CHECK復元を確認済み（source-column-migration-probe-result.json）。これは方式の成立確認であり、実schema全体の移行テストを代替しない。

relay readviewとcheckerのsource union・provider/source検証だけを新値へ対応させる。六値の完全比較と不可逆失効、freshness、board drift時のroot detachは維持する。新sourceが未知の古いconsumerにはfail-closedであることを確認する。

##### 必要な検証と分担

- Core: migration前後の全session/FK/index保存、再実行、失敗rollback。StoreのCAS・競合・冪等・異provider/source拒否。relay resolver/checkerの新sourceと世代変更拒否。successor/native communicationの権限非昇格。
- composition/manager: namespace取得失敗時writer 0、writer失敗時factory/startAttempt/HTTP公開0、stop競合、登録前後のboard drift、cleanup成功/unknown、Mac observer close 0。
- Mac wrapper: 実factory生成とowned起動確認を必須化し、偽入力・別ID/endpointを拒否。G2失敗後Mac継続、detach/reconnect時同observer、明示Mac終了との区別を実providerで確認する。
- 全typecheck/test/lint後に実G2で往復と切断・再接続を受け入れる。fixture成功や新source追加だけでは限定試用成立とも全体完了とも扱わない。

設計判断と共有types変更はhostが担当。本節の起動確認・登録source/CAS・接合方針を凍結する。局所実装と全体検証を分け、稼働サービスへの反映と実G2受入はhost後工程に残す。

局所工程Aはdb.ts/readview.ts/relay-board-binding-checker.tsと新codex-native-resume-binding.test.tsだけを所有する。types.tsのProviderSessionSource unionはhostが先に変更する。Store inputは四値の明示構造型とし、一般KanbanStore interfaceやindex exportを増やさない。入力不正は固定CODEX_NATIVE_RESUME_BINDING_INVALID_INPUT、照合不成立/DB失敗は固定CODEX_NATIVE_RESUME_BINDING_UNAVAILABLEでthrowする。既存allowlistを拡張せず、composition/manager/OS起動は次工程に分ける。新migrationはv35とし、未知のschema/index/制約依存を安全に移行できない場合はrollbackして報告する。

#### 78.10.4.9.19 Claude channelの初回binding公開待機（2026-09-09）

目的: Mac会話のSessionStartが先に届き、hostがnative identityとactivationを確定した後に既存bindingを公開する順序を支える。Claude2.1.266の実測でSessionStart→10秒遅延MCP初期化→channel受信が成立した。MCPだけの停止・標準/mcp Reconnect後もMac会話が継続することを確認したが、これは本番D1/ledger/owner接合の受入ではない。

- plugin serverの既存loadActiveBindingより前に、明示opt-inの短時間待機を追加する。環境変数HACHI_CHANNEL_BINDING_WAIT_MSは未設定/文字列0で従来の即時検証、1〜10000の十進整数で最大待機msを指定する。空白・符号・小数・指数・空文字・上限超を拒否する。変更所有はpluginのbinding-wait.ts/.test.ts、server.ts、pin.tsとREADMEだけ。新外部依存・binding/ledger/wire schema変更なし。
- 待機するのはbindingがENOENTの時だけ。存在する不正/disabled/別pinのbindingを待って置換成功にしない。公開を観測した後は既存loadActiveBindingをそのまま使い、full fence/path/plugin hash/単一writer条件を緩めない。新helperもpin対象へ追加する。
- opt-in待機ではbinding pathをcanonical absolute parent配下に限定し、parentの0700/current uid/dev/inoを記録して確認前後に照合する。symlinkや別directoryへの入替、watch失敗/エラーは固定errorで失敗する。存在監視は当該parentのfs.watchと単一deadlineで行い、watch登録直後にも再確認して公開競合を取りこぼさない。定周期poll、無期限待機、別path探索はしない。
- timeout・失敗・成功でwatcher/timerを必ず閉じる。期限後の遅いfile公開で成功へ戻さず、timeout後のbinding消去/再生成/再送をしない。待機中はMCP notification、ingress socket、ledger writer、D1接続を作らない。Mac終了権限を追加しない。
- 満たさない時はpluginの接続準備失敗であり、正常なClaude会話を終了しない。hostは未接続として扱い、後の明示再接続で新plugin起動を行う。既存pluginの起動後binding固定と、旧plugin終了確認後だけledgerを次activationへ渡す規則は維持する。再接続の自動化・controller/owner/HTTP組立は後続工程。
- 局所検証は既存binding即時検証、atomic公開、watch登録競合、不正/disabled/pin拒否、deadline後公開、parent入替/不正mode/非canonical path、設定値境界を確認する。bundle再生成とhash・全体gate後、既存channelと実D1を含む実native試験を別途行う。待機helper成功を両provider実G2完成と扱わない。

## 81. Codexオーケストレーションの出荷収束ゲート

本節は2026-09-09のCodex限定恒久対策として採択した契約。実装・独立レビュー・全体検証・host切替gateを通るまでlive scopeの登録・適用を開始しない。型やCLI名の存在を実装済み・接合済みの証拠にしない。

### 81.1 管理開始・authority

出荷scopeは明示選定したroot taskを主キーとする。`registerConvergenceScope`は§55のprimary責務解決と§60のactive exact orchestrator provenanceを同一Txで照合し、そのactive session.providerがcodexの場合だけ初回登録できる。workerのTaskRow.provider、表示author、モデル名で判定しない。rootの既存primary ownerと登録者stable identityは一致必須。unknown/human local claimは登録authorityにならない。humanの承認は既存host承認経路で確認し、文字列`--actor-kind human`だけでは代替しない。

対象集合は登録rootとそのsubtask子孫、明示収録taskの永続membership。depends-onは所属継承しない。登録Txで現存subtask子孫もmembershipへ収録する（最大1000件、超過時は登録全体拒否しhostが出荷単位を分割）。新規子の作成・subtask link追加は分類とscope revision変更と原子的に行う。複数scopeへの収録、管理scope同士の重複subtreeは拒否。登録時点の走行runには適用せずsnapshotを保全する。次のready/再投入ではspec採用が必須。

所属後のbinding削除、subtask link解除、unknown caller、owner session不在は管理解除にならない。binding resolverと保存ownerが不一致なら新規mutation/launchを拒否。新しいClaude親や無関係legacy rootには自動適用しない。管理済みscopeのCodex→Claude交代は自動解除しない。`migrateConvergenceOwner`によるhostの明示移行を要し、移行後もその既存scopeだけ§81を保持する。これはClaude親への新たな自動適用ではない。今回、管理解除APIを設けない。旧ownerと新ownerのactive tupleを照合できない場合は既存§55のhost復旧手順を先に完了させる。

本保証は対応したhachi Store/CLI/host入口内。任意の無所属rootを同じ出荷だと意味推定しない。同一OS userの生DB改変・任意gh/git・prompt全文の意味証明は保証外。service provenanceもOS認証ではない。既存の信頼境界を強化したと偽らない。

### 81.2 revision・現在形spec

scope documentはimmutable revision。更新は`expectedRevision`とのCAS、成功時のみ+1。taskは明示的に採用したrevisionを保持し、変更されなかったtask specなら古い採用revisionも利用可能。最新document内の同task spec hashが採用spec hashと異なる場合は次のready/launchを拒否し、明示採用を要する。親の説明・他taskだけの変更で再採用を要求しない。

active runのspecはrun開始時に固定し、後からrevision採用やbody差し替えをしない。新revisionの登録は可能だが走行taskへの採用は不可。cancel中もexact-session停止確定までは同じ扱い。terminal taskのspecは監査専用であり、追加実装は新task。既存終端状態からreadyへ戻す例外は作らない。

bodyはspecから決定的に全生成する。順序はschema識別→cwd→verify→目的/完了条件→BASE/必要commit→所有/禁止→consumer/setup/検証表。旧回答・旧bodyを素材にprepend/mergeしない。説明文は非規範であり、BASE/ownership/permission/verifyを説明から解決しない。構造欄と矛盾した散文をhost/reviewerが差し戻す（自動semantic判定とはしない）。既存`assertTaskBodyValid`、verify予約語、no-push/approval/安全policyの検査を生成後にも適用する。新specの採択は既存の許可を勝手に広げない。

### 81.3 共通型・validation limits

IDは既存ID検証を再利用し、以下の追加IDはASCII `[a-z][a-z0-9_-]{0,63}`。revisionは1..2^31-1、expectedRevisionの0は初回登録のみ。時刻はUnix秒の非負safe integer。hashはSHA-256小文字64桁、Git OIDは完全長40または64桁（repo object format一致必須）、短縮OID不可。全JSONはUTF-8最大1MiB、unknown field/undefined/重複キー/NaN/Infinity/NULを拒否。canonical JSONはキーを辞書順、配列順序は保存、文字列は入力のLFへ正規化してからhash。集合配列は重複拒否・ID昇順へ正規化。

pathは絶対canonical cwd、repo内pathは相対POSIX形式、`..`/絶対/空/制御文字を拒否。fileとdirectoryはkindで区別し、directoryは末尾`/`へ正規化。globは使わず、directory prefixで所有を表す。symlinkは実体pathも所有内か実行時検証。path最大4096bytes、短い識別/理由は各2048bytes、目的と完了条件は各8192bytes、commandは8192bytes、説明は16384bytes。task/scope最大1000、task当たり所有/禁止path各128、必要commit128、consumer接点128、check128、check入力path512、明示toolchain入力128、setup入力128、check output32、receipt artifact32。超過を切り詰めず拒否。コマンド/ログにsecretを埋めない。配列空可は明記箇所のみ。

```ts
type ConvergencePhase = "ready" | "launch" | "draft" | "merge";
type ObservationPhase = "ready" | "claim" | "launch";
type DiscoveryClass = "planned" | "required_bug" | "required_verification" | "follow_up";
interface OwnedPath { path: string; kind: "file" | "directory"; }
interface RequiredCommit { repo: string; oid: string; producerTaskId: string; }
interface ConsumerContact {
  path: string;
  symbol: string;
  kind: "api" | "state_branch" | "fixture";
  checkId: string;
}
interface CheckOutput extends OwnedPath {
  purpose: "setup" | "log";
}
interface SetupInput {
  checkId: string;
  path: string;
}
interface CheckSpec {
  id: string;
  kind: "install" | "setup" | "consumer" | "suite" | "review" | "host_acceptance";
  executorTaskId: string;
  command: string | null;
  cwd: string;
  inputPaths: string[];
  setupInputs: SetupInput[];
  toolchainInputs: OwnedPath[];
  outputs: CheckOutput[];
  resourceRequirementIds: string[];
  requiredFor: ConvergencePhase[];
}
interface CurrentTaskSpec {
  taskId: string;
  objective: string;
  completion: string;
  cwd: string;
  repo: string;
  baseOid: string;
  requiredCommits: RequiredCommit[];
  owns: OwnedPath[];
  forbids: OwnedPath[];
  restrictions: string[];
  verify: string;
  setupNotRequiredReason: string | null;
  contacts: ConsumerContact[];
  checks: CheckSpec[];
}
interface ScopeEntry {
  taskId: string;
  classification: DiscoveryClass;
  reason: string;
  included: boolean;
  followUpTaskId: string | null;
  spec: CurrentTaskSpec | null;
}
interface ConvergenceDocument {
  schema: "hachi.convergence.v1";
  outcome: string;
  includedScope: string;
  excludedScope: string;
  entries: ScopeEntry[];
}
interface ConvergencePrincipal {
  orchestratorId: string;
  sessionId: string;
  generation: number;
}
interface Candidate {
  repo: string;
  headOid: string;
  worktreeDigest: string;
}
interface ConvergenceIssue {
  code: ConvergenceErrorCode;
  taskId: string | null;
  checkId: string | null;
  field: string | null;
}
interface ConvergenceReadiness {
  managed: boolean;
  allowed: boolean;
  revision: number | null;
  specHash: string | null;
  candidate: Candidate | null;
  issues: ConvergenceIssue[];
}
```

`restrictions`は非空の明示禁止条項、所有は実装taskで非空。read-only taskの所有空は`restrictions`にsource変更禁止を必須化。 禁止の意味はscope採択時のhost/reviewerが確認し、pure schemaは非空の明示条項という構造を検査する。特定の日本語・英語の部分文字列を許可語として独自に固定してはならない。`verify`は既存文法の唯一のdirective値（noneも含む）。`checks`はnoneでも後続専用検証taskを指定できるが、当該task自身が実行不能なcommandをverifyへ書かない。`command=null`はreview/host_acceptanceだけ許可。それ以外は非空command。setup不要ならreason必須、setup checkと同時指定不可。この併存禁止はkind=setupだけを対象とし、kind=installはsetup不要理由と併存できる。install不要はcheckなしとし、hostがscope採択時に必要性を判断する。必要install/setupは別checkでready/launchに指定する。

included=trueにはspec必須、spec.taskId一致。follow_upはincluded=falseかつ既存followUpTaskId必須・self不可・spec=null。planned/required_bug/required_verificationはincluded=true、spec必須、followUpTaskId=null。plannedは初期予定の機能・検証taskに使用可で、bugへの偽装を要求しない。

初期予定は初回registerのimmutable revision=1のentriesのtask ID集合で固定する。hostは登録前に初期機能taskを作成し全件収録する。Storeはrevision=1との集合比較で判別し、後続put/create/linkによる新entryにplannedを認めない。後から発見したentryはrequired_bug/required_verification/follow_upのいずれかと理由が必須。保存後のclassificationは変更不可。初期plannedのspec更新も元のincludedScopeを越えるPR範囲拡張を許可するものではなく、後発課題は新entryで既存3分類へ分ける。既存taskの目的を拡張してplannedへ隠す意味上の逸脱は既存host/scope reviewで差戻し、構造validatorが意味を証明したとはしない。初期予定の後日分解が必要な場合もplannedの追加を黙認せず、この境界で未充足としてhostへ返す。除外は一般的境界をexcludedScopeへ、具体的発見はfollow_up entryへ残す。保存済みentryの削除禁止、terminalのspec改訂禁止。scope rootだけは進行管理の例外としてentriesへ入れずmembershipのみ持ち、adopted_revision=nullで実行不可。root自身の実装は別taskへ分ける。

checks.idはscope内一意、contacts.checkIdは同scopeのconsumer/suite checkを参照。executorTaskIdは実在する専用検証taskまたは実装taskを指す。command=nullのhost_acceptanceは進行管理rootを担当として指定可、issuerはhostだけ。reviewは対象実装taskと別task・別実施runを要する。requiredForは非空、重複不可。ready/launch checkを対象自身の未開始runの成果に依存させない（循環条件を拒否）。検証成果が実装開始後に必要ならmergeだけへ配置。draftはscope/candidate/authority/未実施一覧が揃えば許可し、全checkを暗黙にdraft必須化しない。

### 81.4 SQLite schema

以下は既存Storeの`runMigrations`へ追加するDDL。各FKはON DELETE RESTRICT（省略時も削除cascadeなし）。Store read面はKanbanReadView経由へ追加。schema_migrationsを再利用し独立DBなし。JSON内部の型・サイズ・参照整合は同一Tx内の上記validatorで強制する。JSONは`CHECK(json_valid(...))`だけで型証明したと扱わない。

```sql
CREATE TABLE convergence_scopes (
  root_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  owner_id TEXT NOT NULL REFERENCES orchestrators(id),
  registered_session_id TEXT NOT NULL REFERENCES orchestrator_sessions(id),
  registered_generation INTEGER NOT NULL CHECK(registered_generation > 0),
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  FOREIGN KEY(root_task_id, current_revision)
    REFERENCES convergence_revisions(root_task_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE convergence_revisions (
  root_task_id TEXT NOT NULL REFERENCES convergence_scopes(root_task_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB)) <= 1048576),
  document_hash TEXT NOT NULL CHECK(length(document_hash) = 64),
  actor_session_id TEXT NOT NULL REFERENCES orchestrator_sessions(id),
  actor_generation INTEGER NOT NULL CHECK(actor_generation > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(root_task_id, revision)
);
CREATE TABLE convergence_members (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  root_task_id TEXT NOT NULL REFERENCES convergence_scopes(root_task_id),
  adopted_revision INTEGER,
  CHECK(adopted_revision IS NULL OR adopted_revision > 0),
  FOREIGN KEY(root_task_id, adopted_revision) REFERENCES convergence_revisions(root_task_id, revision)
);
CREATE INDEX convergence_members_root ON convergence_members(root_task_id);
CREATE TABLE convergence_run_specs (
  run_id INTEGER PRIMARY KEY REFERENCES task_runs(id),
  root_task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  spec_hash TEXT NOT NULL CHECK(length(spec_hash) = 64),
  candidate TEXT NOT NULL CHECK(json_valid(candidate)),
  FOREIGN KEY(root_task_id, revision) REFERENCES convergence_revisions(root_task_id, revision)
);
CREATE TABLE convergence_receipts (
  id TEXT PRIMARY KEY,
  root_task_id TEXT NOT NULL REFERENCES convergence_scopes(root_task_id),
  check_id TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  issuer_kind TEXT NOT NULL CHECK(issuer_kind IN ('supervisor','host')),
  issuer_ref TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND length(CAST(evidence AS BLOB)) <= 1048576),
  result TEXT NOT NULL CHECK(result IN ('passed','failed','skipped')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(root_task_id, check_id, input_hash, issuer_kind, issuer_ref)
);
CREATE TABLE convergence_answers (
  request_id TEXT PRIMARY KEY REFERENCES orchestrator_requests(id),
  answer_key TEXT NOT NULL UNIQUE,
  root_task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('explanation','adopt_spec')),
  text TEXT NOT NULL,
  FOREIGN KEY(root_task_id, revision) REFERENCES convergence_revisions(root_task_id, revision)
);
CREATE TABLE convergence_host_actions (
  root_task_id TEXT NOT NULL REFERENCES convergence_scopes(root_task_id),
  action_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('draft','merge','pause','resume')),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  owner_session_id TEXT NOT NULL REFERENCES orchestrator_sessions(id),
  owner_generation INTEGER NOT NULL CHECK(owner_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('prepared','succeeded','uncertain')),
  result TEXT NOT NULL CHECK(json_valid(result)),
  PRIMARY KEY(root_task_id, action_key)
);
```

`orchestrators`、`orchestrator_sessions`、`orchestrator_requests`はBASEの既存DDL名と照合済み。revision/receipt/run_specs/answersはINSERT ONLY、UPDATE/DELETE禁止triggerを付ける。membersは所属root変更/DELETE禁止、adopted_revisionだけCAS更新可。scopeの削除禁止、owner変更は専用移行Txのみ。host_actionsはprepared→succeeded/uncertain、uncertain→succeededのreadback確定だけ可、再実行へ戻さない。独立のtask/request/daemon状態を追加しない。ホスト外部作用の不確定を表す3値は二重実行回避に必要な最小journalであり、workflow engineではない。

created_at以外の不要なupdated_at、別のverified bool、global stale flag、waiting task statusは作らない。run_specsは新規managed runだけに作る。登録前active runに追記しない。FK確認・trigger・登録の遅延FKは既存SQLite transaction内、constructor cleanup規則を維持する。

### 81.5 Store API契約

全mutationは既存Store transactionに統合し、validation→authority→CAS→書込/eventを単一IMMEDIATE Txで行う。外部commandをTx中に実行しない。下表の`P`はConvergencePrincipal、`R`はrootTaskId:string、`E`はexpectedRevision:number。契約上の拒否はConvergenceErrorでthrow、書込・enqueue・mark・body変更は0。IMMEDIATE transaction開始時のSQLITE_BUSYは下記§81.6のDB運用例外とする。既存mutationの戻り値型は維持し、追加optional contextを未管理taskだけ省略可とする。validatorは内部とreadで同じpure evaluationを使うがreadiness.allowedは許可tokenではない。

既存APIへの追加引数は末尾の`convergence?: {expectedRevision:number; expectedSpecHash:string; observationId:string|null}`に統一する。createTaskは既存TaskCreateInputに`convergence?: {rootTaskId:string; expectedRevision:number; entry:ScopeEntry}`を追加するが、管理子はcreateManagedTaskの内部Txだけから呼ぶ。updateBodyの内部全生成はpublic optional flagで許可せず、adoptのprivate write helperを使う。ready/claim/launchそれぞれに必要な非同期観測はhost/supervisor collectorが事前取得し、transition/unblock/claim/startRunのcontextへ渡す。構造化回答の採用時は§81.8のanswer対象ready観測を取得し、consumeConvergenceAnswerのobservationIdへ渡す。通常CLIのmove/unblockは正式host collectorに接合して取得し、collector未接合時はCANDIDATE_UNAVAILABLEで拒否する。createManagedTaskでready指定した新taskは未取得の観測を推測しないため通常は拒否し、triage/todo作成→観測→readyを使う。

| symbol / 引数 | 戻り値 | 原子操作・authority |
|---|---|---|
| registerConvergenceScope({rootTaskId, document, expectedRevision:0}, P) | {rootTaskId, revision:1, documentHash} | Codex active primary、重複subtreeなし、既存子分類の全収録、scope/revision/members。body/statusは変更しない |
| putConvergencePlan({rootTaskId, expectedRevision, document}, P) | {rootTaskId, revision, documentHash} | owner active、E一致、revision INSERT+pointer CAS。同一hashでもE検査後は既存revisionを返し副作用0 |
| adoptConvergenceSpec({rootTaskId, taskId, expectedRevision, expectedAdoptedRevision:number\|null, revision}, P) | {task:TaskRow, adoptedRevision:number, specHash:string} | current E一致、採用targetは最新同task spec、open run/claimなし、非終端。body全生成とmembership CAS。status変更なし |
| createManagedTask({task:TaskCreateInput, rootTaskId, expectedRevision, entry:ScopeEntry}, P) | {task:TaskRow, revision:number} | task IDをTx内採番しentry/specへ代入（入力taskIdは空のみ）。create/link/binding/revision/member/adoptを一括。ready指定ならready guardも同一Tx |
| getConvergenceReadiness({taskId, phase:ConvergencePhase, candidate:Candidate\|null}) | ConvergenceReadiness | read-only、candidate未提供なら必要phaseでunavailable。取得した観測値をcallerの真実として信頼しない |
| prepareConvergenceAnswer({requestId, answerKey, expectedRevision, revision, kind, text, claimToken}, P) | OrchestratorRequestRow | request/task/rootをStore解決。existing beginAnswer fenceを保持しanswer row+message enqueueとansweringを同一Tx |
| consumeConvergenceAnswer({taskId, answerKey, runId:number\|null, sessionId:string\|null, observationId:string\|null}, internalService) | {request:OrchestratorRequestRow, disposition:'explained'\|'adopted'\|'terminal'\|'stale', readiness:ConvergenceReadiness\|null} | exact row/key必須。adopt_specはanswer対象ready観測の変更前CASと採用予定spec/bodyを照合し、単回消費・採用・条件付きready・mark/監査/resolveを同一Tx。null可の分岐は§81.9のみ。実行条件変更をlive注入しない |
| beginConvergenceCheck({rootTaskId, checkId}, internalIssuer) | {executionNonce:string} | §81.7の正式runnerが実行前envelopeを固定してから実行。callerのhash/担当/結果は受け取らない |
| recordConvergenceEvidence({executionNonce}, internalIssuer) | {receiptId:string, reused:boolean} | 同じissuerの保持envelope・実終了結果・実行後projectionだけから生成。外部ReceiptEvidence JSONは受け取らない |
| migrateConvergenceOwner({rootTaskId, expectedRevision, newOwnerId, newSessionId, newGeneration, reason}, P) | {rootTaskId, ownerId, revision} | 旧owner Pと新primary active tuple、claim/open runなし、既存binding移行と同一Tx。revisionは+1（document不変）、監査に両tupleと理由 |
| assertConvergenceMutation({taskId, operation, expectedRevision, expectedSpecHash, claimToken:string\|null, observationId:string\|null}) | void | Store内部専用、operationはcreate/link/adopt/ready/claim/start_run/body/answer/publication。public bypass boolを設けない |

`internalService/internalIssuer`はCLIで構築不可のmodule-private capability（Store factoryでsupervisor/host bootstrapへだけ渡すclosure）。文字列service名やActorProvenanceだけをreceipt発行能力として受けない。型ブランドは補助、実行時の同一capability object照合と既存run/session/actor fenceも必須。workerのKanbanStore/read viewにはissuer closureを配らない。同一OSコード差し替えへの防壁とはしない。

CLI契約（実装・切替gate通過後に利用可能）: `hachi convergence register|put|adopt|readiness`（register/putは`--file`、mutationは`--expected-revision`、既存principal flags）、`hachi orchestrator answer ... --convergence-file <file>`（既存session/generation/claim必須）。fileのschemaは該当API objectそのもの、principal/claim/secretはfileへ含めない。既存createに`--convergence-file`を足してcreateManagedTaskへ分岐。未知optionを黙認しない。receiptの`--passed`/汎用import、scope解除コマンドは作らない。

### 81.6 error codes・拒否規則

ConvergenceErrorは `{code, issues:ConvergenceIssue[], nextAction:string}` を持つError。code unionは下表の閉集合。nextActionは固定文言の構造化経路案内であり回答本文、claim、SQL、envを含めない。CLIはerror時exit 1、JSON時 `{ok:false,error:{code,issues,nextAction}}`、readinessは評価完了ならexit 0でallowed=falseも返す。issuesはcode/taskId/checkId/fieldでsortし重複除去、最大128件、それ以上は末尾LIMIT_EXCEEDEDを返す。

| code | 拒否対象 |
|---|---|
| INVALID_INPUT / LIMIT_EXCEEDED | 型、未知field、制約、サイズ、重複 |
| NOT_FOUND / SCOPE_CONFLICT | 非存在、複数scope、entry漏れ、所属削除 |
| AUTHORITY_REQUIRED / OWNER_MISMATCH | unknown/local human claim、旧session、provider交代未移行、binding不一致 |
| REVISION_CONFLICT / SPEC_NOT_ADOPTED | CAS不一致、current task specと採用hash不一致 |
| ACTIVE_RUN / TERMINAL_TASK | active/cancelling runへの採用、終端再投入 |
| STRUCTURED_PATH_REQUIRED | managed旧edit-body/set-cwd/旧answer/body付き旧enqueue等 |
| CANDIDATE_UNAVAILABLE / CANDIDATE_CHANGED | Git実測不可/入力閉包不明、観測後candidate変化/検証前後入力不一致 |
| COMMIT_UNREACHABLE / OWNERSHIP_CONFLICT | 必要commit非包含、別repo、所有重複/越境 |
| RECEIPT_MISSING / RECEIPT_STALE / ISSUER_DENIED | 未実施/skipped、入力差分、worker偽passed |
| RESOURCE_INVALID / REQUEST_FENCE | 正式lease不一致、request kind/claim/key不一致、観測phase誤用/消費済み/claim競合・別retry |
| ADAPTER_UNSUPPORTED / APPROVAL_REQUIRED | 実接続なし、既存publication承認不足 |
| ACTION_REPLAY / ACTION_UNCERTAIN | key異入力、旧owner/event、外部結果不確定 |

DB運用例外: IMMEDIATE transaction開始時の書込競合SQLITE_BUSYは、revision CAS不一致や構造検証失敗へ変換しない。既存SQLite例外（code=SQLITE_BUSY）の伝搬を許可し、CLIは既存失敗経路のexit 1とする。書込・enqueue・mark・body変更は0、失敗transactionはrollback、暗黙retry・部分成功・passed化はしない。SQL/bind等を例外へ追加してはならない。この例外を他のDBエラーへ一般化しない。

request/staleの消費は「API失敗」ではなく上表consumeのdispositionとして監査する。旧writerによる拒否は副作用0であり、staleとして先にmarkしてから拒否する実装は禁止。

### 81.7 receipt issuerと入力単位

ReceiptEvidenceは以下の厳密object。任意Recordや自由なpassed fieldから構築しない。

| field | 型 / 定義 |
|---|---|
| executorTaskId / runId / sessionId | string / number\|null / string\|null。supervisorは実行したrunのexact組を必須、hostはrunなし可だがissuer_refにactive host sessionと実行nonceを保存 |
| candidate | Candidate。repo=Git common-dirのcanonical path、worktreeDigest=HEADからのtracked変更、staged変更、untrackedファイルのpath/type/content digestをsortしたSHA-256。ignored出力を暗黙検査対象にしない |
| checkSpecHash / inputsHash | SHA-256。実行前に固定したcheck定義と入力projectionのdigest。実行後の別入力へ貼り替え禁止 |
| executionNonce / beforeEnvelopeHash | string / SHA-256。Store生成一意nonceと正式issuer実行前envelopeのhash |
| afterInputsHash / failureReason | SHA-256\|null / null\|execution_failed\|input_changed\|interrupted。未取得はnullでpassed不可 |
| outputDigests | `{path:string,kind:"file"\|"directory",digest:string}[]`。setup outputの実行後実体digest、最大32。logはartifactsへ |
| command / exitCode / result | string\|null / integer\|null / passed\|failed\|skipped。command型checkのpassedは実runner exit 0のみ。timeout/signalはfailed、未実行はskipped。review/hostはexit=nullと正式verdict receipt必須 |
| resources | `{requirementId:string,leaseId:string,fence:number,ownerTaskId:string,ownerRunId:number\|null,worktree:string}[]`。secret値/pathを持たせない。使用しないなら空 |
| artifacts | `{path:string,digest:string}[]`。既存task artifact許可範囲、実在とdigest照合。完全logと終了codeを保存し切り詰めstdoutを根拠にしない |
| verdictRef | string\|null。review/hostの既存verdict/承認記録参照、他はnull。自由event名だけを証拠にしない |

receiptのSQL input_hashは`SHA256({checkSpecHash,inputsHash})`。入力projectionはsource inputPathsのpath/type/content/欠損marker、command/cwd、lockfile、担当executor、toolchainInputsの実体とtoolchain識別、setupInputsが参照するproducer receipt/output digest、必要commit集合、resource要求・実lease/fence/実行環境fingerprintで構成する。秘密env値をhash/転記せず正式setup/resourceの非secret version/fenceを使う。取り込み不能な依存・不明な入力閉包は未充足として発行拒否し、無差別な全filesystem hashへ倒さない。

**入出力定義。** inputPathsはGit source treeの相対file/directoryであり、`.`はsource tree全体の指定に限る。tracked（staged/dirty含む）と非ignored untracked sourceのpath/type/contentを取り込み、Git内部metadataは除く。ignored依存を暗黙に安全とせず、必要な生成物はsetupInputs、明示toolchain実体はtoolchainInputsへ分離する。node_modulesはinstall/setupの明示outputとproducer digestを経由する。`.`でnode_modules・runner logを毎回sourceとして列挙しない。source pathの削除は欠損markerとなる。source外の必要入力を宣言できないcheckは未充足。

outputs/setupInputs/toolchainInputsは必須配列（不要なら空）。outputは最大32件、path/kindは§81.3の相対POSIX規則、`.`/Git metadata/上位escape/symlink escapeは禁止。cwdはrepo内の検証worktree、outputの実体もその中に限定し、重複/prefix重複を拒否する。setup purposeはinstall/setup checkのみ、logは正式runnerの専用logのみ。directory digestは正規化した子path/type/contentの全件から作り、サイズ超過や読取不能で切り詰めない。receipt JSONは既存1MiB上限、digest一覧はoutput32件内であり生成物本体をJSONに格納しない。

before/afterのsource projectionからoutputを除外できるのは、実行前に確定した宣言であり、tracked source・明示source input・lockfile・check定義・toolchainInputs・setupInputsの実体との重複がなく、source依存ではない生成物/正式logであることを既存scope/reviewが確認した場合だけ。`.`に含まれる専用生成directoryはこの条件を満たす場合に限り除外可。宣言後にsourceをoutputへ移す変更はcheckSpecHashを変え、gate弱化として既存host/reviewを要する。宣言のない生成物を後から除外しない。正式runner logはsource inputでなくartifactsとして扱うが、任意sourceをlogと名乗らせない。正規output作成のみは入力変更ではない。

実測readerへ渡すproducerの作業directoryは、receiptのcheckSpecHashに対応する同scope内immutable check定義からStore resolverが解決したproducerCwdを用いる。consumer cwdやproducer taskの現在bodyから推測しない。定義を一意に解決できない場合は観測不能とする。artifactの正式許可rootは、host bootstrapのConvergenceArtifactPolicyReaderがStore解決のexact task/run/sessionに対して既存のtask artifacts・cwd・承認済み追加evidence-dir規則から返し、resolverがartifactRootsとして渡す。readerがworkerのbody/envから許可rootを増やすことは禁止。これらは内部観測用の解決値であり、scope documentや外部receiptの任意JSON入力fieldを増やさない。

setup成功時は全declared setup outputの実在・実体digestを終了時に固定しoutputDigestsへ保存する。後続consumerはsetupInputsのcheckId/pathから最新の有効producer receiptを解決し、そのreceipt IDとdigestおよび現在実体一致を実行前後に検証して自分のinputへ取り込む。producerが書く自身のoutputを自身の入力へ二重計上しない。依存は循環禁止、欠落/変更/producer failedは未充足。toolchainInputsはsetup出力以外の明示実体入力で、sourceと同じpath規則・containmentを要する。

**実行順序。** 正式issuerのrunner wrapperだけがbegin→command/verdict実行→finishを所有する。beginは現在checkSpecHash、scope評価revision/採用spec hash、入力projection、担当/exact run、candidate A、必要commit、resource、output宣言と一意executionNonceを実行前envelopeへ固定する。Store private capabilityがこのimmutable envelopeをnonceに結び付け保持し、固定完了より前に実行しない。caller JSONのhash/exitCodeで代用不可。終了時は同じrunnerの終了結果に加え同じ規則のprojectionを再取得し、check定義/担当/必要commit/resource/採用specおよび関連入力が一致した場合だけpassedを発行する。global revisionだけの変化は最新同task spec/check/関連projection一致の場合のみ許容する。途中の関連revision採用/check差替えはStore変更履歴でも検出し、終了時に戻っていてもinput_changedとする。

一致しなければ実exit 0でもresult=failed、failureReason=input_changedを同じ実行前envelopeへ記録し、afterInputsHashに終了時値を残す。非0はexecution_failed、timeout/signal/中断はinterrupted、後観測不能はpassed不可。候補Aの結果に実行後候補Bのhashを貼り替えずcandidateはAの来歴を保持する。nonceは同一issuer/exact実行だけに使用し、receiptのissuer_refはこのnonceと正式終了eventを参照する。finishは単回、同一finish再送は既存receiptを返し異結果は拒否する。SQL evidenceへ追加fieldsを格納し既存table追加は不要。issuer再起動で未完了envelopeを失った実行は既存実行監査へ中断/証拠未充足を記録し、新nonceで再実行するまでpassedなし。DBは任意外部Git編集をlockしない。専有worktree規律と前後観測を前提とし、検出不能な外部編集/復元まで連続不変を証明したとは扱わない。

exact run/session/nonceは実行前envelopeとreceiptの来歴・発行fenceであり、後続consumer自身のrun IDとの一致は再利用条件にしない。担当executorは入力projectionへ含める。

candidate全体は実測来歴で保持するが、receipt再利用はcheck定義/入力projection/担当/環境/必要commitの一致で判断する。global scope revisionや無関係pathのcandidate変更だけで失効しない。新candidateへ再利用する場合もconsumer collectorが入力projection一致を再計算し、現在candidateのlaunch observationへ参照を固定する。新候補の関連path、lockfile、command、setup出力、runtime環境が変われば当該checkのみstale。他checkまでinvalidateしない。所有/要求checkの削除によるgate弱化はrevision採択時のhost/review判断を要する。

既存 `review.ts:resolveVerifyPlan/executeVerifyPlan` の実行計画・実終了結果を最小接合し、`finalize.ts:runVerifyForDoneDirect` とreview経路の両方で同じissuerを使う。既存skipをpassedへ変換しない。`captureHandoffGitEvidenceForVerification`は候補来歴の材料、worker handoffは成果主張に過ぎない。検証担当が実行したverify/suiteとexact runを突合してからreceiptを発行する。失敗後に同入力で再実行した場合は新issuer_refを持つ新receipt。最新の正式実行結果（created_at、同秒は実行順nonceではなく監査event ID順）を選ぶため、issuer_refには一意な既存実行完了event IDも含める。失敗後に古いpassedだけを選択してはならない。

host検証も同じrunnerのhost wrapperでcommand/start/end/inputを観測する。hostがworkerログを読んでpassedを転記するCLIは作らない。レビューの意味判断は正式独立review結果、scope分類とpublication最終受入はhostの明示判断であり、command exit 0で代替しない。


**receipt wire v1の保存・照合契約。** 以下は§81.7のissuer_ref/完了eventを実装間で統一する規範。実装と全体gateを通過するまでlive登録へ使用しない。

配置: 新 packages/core/src/convergence-receipt-wire.ts。既存型のimport元はtypes.ts、digest型はconvergence-runtime-ports.ts（相対importは.js）。
```ts
export interface ConvergenceHostSessionV1 {
  orchestratorId: string; sessionId: string; generation: number;
}
export interface ConvergenceSupervisorIdentityV1 {
  issuerKind: "supervisor"; executorTaskId: string; runId: number;
  sessionId: string; hostSession: null;
}
export interface ConvergenceHostIdentityV1 {
  issuerKind: "host"; executorTaskId: string; runId: null;
  sessionId: string; hostSession: ConvergenceHostSessionV1;
}
export type ConvergenceIssuerIdentityV1 = ConvergenceSupervisorIdentityV1 | ConvergenceHostIdentityV1;
export interface ConvergenceIssuerRefV1 {
  schema: "hachi.convergence.issuer-ref.v1"; issuer: ConvergenceIssuerIdentityV1;
  executionNonce: string; completionEventId: number;
}
export interface ConvergenceReceiptEvidenceV1 {
  executorTaskId: string; runId: number | null; sessionId: string | null;
  candidate: Candidate; checkSpecHash: string; inputsHash: string;
  executionNonce: string; beforeEnvelopeHash: string; afterInputsHash: string | null;
  failureReason: null | "execution_failed" | "input_changed" | "interrupted";
  outputDigests: ConvergenceOutputDigest[]; command: string | null;
  exitCode: number | null; result: "passed" | "failed" | "skipped";
  resources: ConvergenceResourceBinding[]; artifacts: ConvergenceArtifactDigest[];
  verdictRef: string | null;
}
export interface ConvergenceBeforeEnvelopeV1 {
  schema: "hachi.convergence.before-envelope.v1"; rootTaskId: string; checkId: string;
  issuer: ConvergenceIssuerIdentityV1; executionNonce: string;
  revision: number; adoptedRevision: number; taskSpecHash: string;
  checkSpecHash: string; inputsHash: string; candidate: Candidate;
  requiredCommits: RequiredCommit[]; outputs: CheckOutput[];
  runtime: ConvergenceResourceSnapshot;
}
export interface ConvergenceCheckStartedV1 {
  schema: "hachi.convergence.check-started.v1"; rootTaskId: string; checkId: string;
  issuer: ConvergenceIssuerIdentityV1; executionNonce: string;
  revision: number; adoptedRevision: number; taskSpecHash: string;
  checkSpecHash: string; inputsHash: string; beforeEnvelopeHash: string;
}
export interface ConvergenceCheckCompletedV1 {
  schema: "hachi.convergence.check-completed.v1"; rootTaskId: string; checkId: string;
  issuer: ConvergenceIssuerIdentityV1; executionNonce: string; startedEventId: number;
  beforeEnvelopeHash: string; result: "passed" | "failed" | "skipped";
  failureReason: null | "execution_failed" | "input_changed" | "interrupted";
  receiptId: string | null; evidenceHash: string | null;
}
export interface ConvergenceStoredReceiptV1 {
  id: string; rootTaskId: string; checkId: string; inputHash: string;
  issuerKind: "supervisor" | "host"; issuerRef: string; evidence: string;
  result: "passed" | "failed" | "skipped"; createdAt: number;
}
export interface ConvergenceExecutionSnapshotV1 {
  starts: readonly EventRow[]; completions: readonly EventRow[];
  receipts: readonly ConvergenceStoredReceiptV1[];
}
export declare function encodeConvergenceIssuerRef(value: ConvergenceIssuerRefV1): string;
export declare function decodeConvergenceIssuerRef(json: string): ConvergenceIssuerRefV1;
export declare function encodeConvergenceReceiptEvidence(value: ConvergenceReceiptEvidenceV1): string;
export declare function decodeConvergenceReceiptEvidence(json: string): ConvergenceReceiptEvidenceV1;
export declare function encodeConvergenceCheckStarted(value: ConvergenceCheckStartedV1): string;
export declare function decodeConvergenceCheckStarted(json: string): ConvergenceCheckStartedV1;
export declare function encodeConvergenceCheckCompleted(value: ConvergenceCheckCompletedV1): string;
export declare function decodeConvergenceCheckCompleted(json: string): ConvergenceCheckCompletedV1;
export declare function hashConvergenceBeforeEnvelope(value: ConvergenceBeforeEnvelopeV1): string;
export declare function hashConvergenceReceiptEvidence(value: ConvergenceReceiptEvidenceV1): string;
export declare function hashConvergenceCheckSpec(value: CheckSpec): string;
export declare function hashConvergenceReceiptInput(value: { checkSpecHash: string; inputsHash: string }): string;
```
全interfaceは列挙keysが全てrequired、nullableは明記したunionだけ。hostのrunはnull、sessionIdはhostSession.sessionIdと同一。
既存EvidenceのsessionId:null許容型は保持するが、このv1正式issuerでは両kindとも非null必須。supervisorのhostSessionは必ずnull。
全object（nestedを含む）はplain JSON object・closed keys。undefined/重複decoded key/unknown/NaN/Infinity/NULを拒否。
各保存JSON・envelopeはUTF-8最大1,048,576bytes。issuer_refも同上。サイズ超過はLIMIT_EXCEEDED、その他wire不正はINVALID_INPUT（ConvergenceError）。
rootTaskId/executorTaskId/checkId/receiptId/orchestratorId/host sessionIdはASCII `[a-z][a-z0-9_-]{0,63}`、既存IDとのexact lookupも必須。
supervisor sessionIdはproviderのopaque ID、1..2048 UTF-8bytes、制御文字U+0000..001F/007Fを拒否し、trim/case変更せずrun rowとexact照合。
nonceはStore生成 `cn_` + 暗号乱数32bytesの小文字hex64桁（67 ASCIIbytes）、task IDではない。全保存開始eventで重複を拒否し再生成する。
runId/event ID/generation/fenceは正のNumber.safeInteger、revision/adoptedRevisionは1..2147483647、createdAtは非負safe integer。
整数はcoercion禁止、-0禁止。hash/digestは小文字hex64桁。exitCodeはsafe integer|null。Candidate/path/OID/配列上限は§81.3/81.7既存validatorを共用。
codecはparseConvergenceJson→既存normalizer共用→構造検証→canonical化。独自lexer/JSON.parse単独/文字列splitを追加しない。
canonicalはconvergence-schema.tsのcanonicalJson/hashCanonicalを内部共用化（現在非export）。文字列LF正規化、object key辞書順、配列順保存、集合は既存規則で重複拒否・sort。
encoderは正規化済みcanonical JSONを返す。decoderは同じencoder結果と入力bytesの一致も要求し、保存の空白/順序/数値表記差も非canonicalとして拒否する。
hash関数は同じvalidation・正規化後canonical JSONのSHA-256。evidenceHashはevidence全体、input_hashは宣言した2keysだけ。
checkSpecHashは既存CheckSpec正規化の結果全体のhash（task hashの流用ではない）。参照check存在/循環等のcross checkはimmutable specの解決時に既存document validatorで行う。
envelopeのcheckSpecHash/inputsHashは同一before計測から構築し、runtimeはそのinputsHashを作った同一snapshot。二度目のobserve値を混ぜない。

**正式eventとreceiptの保存・照合**
reserved typeは厳密に `convergence_check_started_v1` / `convergence_check_completed_v1`、payloadは上記同名のStarted/Completed型だけ。
両eventのtask_idはrootTaskId。開始はenvelope固定後・command開始前のIMMEDIATE Txで保存、実idをprivate nonce slotへ保持する。
開始payloadのrevisionは評価scope revision、adoptedRevisionはexecutorのimmutable spec位置。taskSpecHash/checkSpecHashはその位置から再計算一致必須。
開始payload各共通fieldはenvelopeとexact一致、beforeEnvelopeHashは上記全envelopeのhash。hashだけから実行envelopeを再構築しない。
終了は同nonce slotの実ExecutionCompletionだけから生成する。startedEventIdは同DBの実開始id、開始id < 終了id、createdAt開始<=終了。
終了/開始でroot/check/issuer全tuple/nonce/envelope hashが完全一致。completion IDはpayloadに自己参照させずEventRow.idをissuer_refへ格納する。
通常finishはreceipt IDをStore採番し、終了event INSERT→実id入りref作成→receipt INSERTを単一Txで行う。created_atは終了eventと同値。
receipt row root/check/issuer_kindはeventと一致、ref.issuer/nonceは開始終了と一致、ref.completionEventIdは終了eventの実idと一致。
終了receiptIdはrow.idと一致、evidenceHashはdecode済みevidence全体のhash、SQL resultは終了/evidence.resultと一致し、終了.failureReasonもevidence.failureReasonとexact一致する。
evidenceのexecutor/run/session/nonce/beforeEnvelopeHash/checkSpecHash/inputsHashは開始tuple/hash群と一致、input_hashも共有関数で一致。
candidate/command/resources等は発行時envelope・immutable checkと照合し、完了後projectionでcandidate Aを貼り替えない。history read時もimmutable check/開始参照とevidenceHashを検証する。
passedはfailureReason=null・afterInputsHash=inputsHash必須、command checkはexitCode=0、review/hostはexitCode=nullと正式verdict検証必須。
failedはfailureReason非null。非0/実行例外/後観測不能はexecution_failed、関連入力変化はinput_changed、timeout/signal/中断はinterrupted。中断を優先し、次にinput_changed。
skippedはfailureReason=null・exitCode=null・afterInputsHash=null、実行しない。passed扱い不可。出力やartifactsの欠落を偽のdigestで補わない。
終了のreceiptId/evidenceHashは両方非nullか両方null。両nullは再起動等でenvelopeを失った中断記録だけ（failed/interrupted）に限定。
再起動recoveryは保存開始のtuple/hashを引用した中断終了eventを専用capabilityで作れるが、失ったenvelopeからreceipt/passedを復元しない。
recoveryは旧未終了開始をfailed/interruptedで閉じてから同root/checkの新beginを許可する。生存中の正式実行は閉じず新beginを拒否する。
同nonce finish再送は保存済み終了/receiptを返す（reused=true）、実結果差分は拒否。nonceごと開始1件・終了最大1件をTxで強制し、並行finishも重複不可。

**正式性境界**
一般addEventだけでなくtransitionTask(opts.eventType)等、任意typeを渡せる全writerにreserved拒否を適用する。
共通insertTaskEventでprivate実行intent/capabilityを要求する二重防御を置く（owner移行intentの既存方式参照）。actor文字列・payload印・public booleanで解除不可。
通常writerはSTRUCTURED_PATH_REQUIREDで副作用0。開始/終了の専用closureはStore/bootstrap所有で、public barrel/CLI/worker/外部receipt importへ公開しない。
開始/終了payloadはcanonical encode結果を保持してinsert（既存JSON.stringifyにはcanonicalキー順のdecode objectを渡す）。EventRow actor文字列は認可根拠にしない。
host event provenanceはkind=orchestrator、actorId/session/generationがissuer.hostSessionと一致。supervisorは正式service provenanceに加えprivate runnerのrun exact bindingを必須とする。
予約制導入前に同名eventが既に存在すれば自動正式化せずCANDIDATE_UNAVAILABLEで拒否しhostへ報告。移行時の既存予約type衝突検査がC7有効化の必須条件。
既存一般verify/verdict eventやworker handoffだけを正式completionに昇格しない。DB外改竄の署名証明は追加せず、既存Store書込境界を前提とする。

**最新選択・producer解決**
KanbanReadView経由の同一read snapshotで同root/checkの開始・終了とreceiptを読む。result/input_hashで先にpassed候補を絞らない。
全reserved候補をstrict decodeし参照整合を検証する。破損/不正参照/重複nonce・終了/来歴矛盾は観測不能（CANDIDATE_UNAVAILABLEをthrow）、黙って候補から落とさない。
最新の正式終了は `(EventRow.createdAt, EventRow.id)` の降順最大。同秒は実event ID、nonce/receipt ID/receipt生成順で代用しない。
未終了の正式開始があれば古いpassedへ戻らず未充足。issuer再起動で失われた開始も新nonce実行までpassed不可、既存run終了だけから成功を推測しない。
正式開始/終了なし、最新failed/skipped/interrupted、正式終了のreceiptId=null又は参照先receipt row不存在はunmet（RECEIPT_MISSING）。
逆に存在するreceiptのrefが構文不正・別event・終了event不存在・tuple不一致なら観測不能。eventは正しくreceiptがまだない場合と区別する。
最新failed/skipped/interrupted・receipt不足・未終了はRECEIPT_MISSING。最新receiptがあっても入力/必要commit/runtime/outputの現在一致がなければunmet（RECEIPT_STALE）。古いpassedへのfallbackを全て禁止する。
producerCwdは開始adoptedRevisionのexecutor specをimmutable convergence_revisionsから解決し、taskSpecHashとreceipt.checkSpecHashを再計算して一致したcheck.cwdを用いる。
位置不明/定義非一意/参照破損は観測不能。現在body/consumer cwd/最新specから補完しない。別revisionに同一specが反復しても保存位置を使う。
解決結果は既存ConvergenceProducerInput（checkId,path,receiptId,producerCwd,completionEventId,output）へ投影し、declared output実体digestをbefore/afterで検証する。
ConvergenceObservationResultにはunavailable armを増やさず、観測不能はConvergenceError(CANDIDATE_UNAVAILABLE)、正式不足だけkind:unmet。issuesは既存RECEIPT_MISSING/RECEIPT_STALEを使い、taskId=executorTaskId・checkId=対象check・field="issuer_ref"に固定する。

**発行時fenceと歴史的再利用**
begin/finishは現在scope ownerとactive発行authorityをStoreで照合。supervisorは実runnerに束縛されたexecutor/run/session、hostはactive owner/session/generationを検証する。
worker doneやtask_runsの正常endedAtだけで正式verify runnerを異常としない。finalize/reviewの実行capabilityが同runから有効に渡されたことを確認し、cancel/supersede/別runは拒否する。
host sessionの終了/世代交代がfinish前なら新passed発行不可（専用中断監査可）。終了後にsessionが非active化しただけなら既存receiptは有効性を保持する。
consumer再利用は歴史的run rowのtask/session、開始終了保存tuple、host session rowのowner/generationと当時の正式発行を照合し、過去sessionに現在activeを要求しない。
現在consumer owner/session/fence・採用spec・現在入力観測は別に検証。producer run IDとconsumer run IDの一致やproducer現在status=runningを要求しない。


host issuerへの正式active principal注入はhost bootstrapで接合する。既存session registryを利用し、未接合はISSUER_DENIED。local human claimやservice名で代用しない。

### 81.8 ready/dispatch fence

readyは所属/採用spec/所有整合/必要commitのconsumer到達性/ready check/install/setup/正式runtime要件を確認。requiredCommitsはcanonical repoで`cat-file`相当のcommit実在確認と`merge-base --is-ancestor <oid> HEAD`相当の到達性をhost/supervisor collectorが実測する。producer done/archivedで代替しない。squash/cherry-pickはhostが新OIDを新specへ明示採用し検証し直す。ownership重複は同時実行候補間でdirectory prefixも含め検査し、shared typesは先行taskからconsumerへcommitを渡す。

必要resourceのreadyはtask/worktree割当と生存lease、launchは既存§56のrun binding段階に従いtask/run/worktree/expiry/fenceを再照合。dispatchによる正規割当が必要でready時未割当なら、hostが正式割当を先に完了するかreadyを保留する。body/env/固定portから認定しない。後続host検証用resourceをworkerへ割当済みと数えない。

非同期観測は新 `collectConvergenceObservation`（supervisor）で行い、Store内部の一回限りobservationIdへphase/変更前task状態・採用revision・spec hash・body hash/owner tuple/candidate/receipt IDs/resource snapshotをbindする。通常観測の評価対象は現在採用spec/body、構造化adopt_specのready観測だけは下記の採用予定spec/bodyと変更前snapshotの二つを区別してbindする。claim観測はclaim無しsnapshot（既存claimTask CASが照合する値を含む）、launchは新しいexact claim tokenを追加でbindする。readiness入力や外部JSONから発行できない。観測は内部capability管理の単回tokenで、新SQL tableは不要。5秒で失効し、再起動時は全て失効・再観測する。

collector signatureは`collectConvergenceObservation(deps, input:{taskId:string; phase:ObservationPhase; expectedRevision:number; expectedSpecHash:string; claimToken:string|null; answerKey:string|null}): Promise<{observationId:string; readiness:ConvergenceReadiness}>`。answerKeyはreadyの構造化adopt_specだけ非null、それ以外はnull必須（claim/launchでは拒否）。expectedRevisionは観測開始時のscope current revision、expectedSpecHashは評価対象spec hashで、answer対象では採用予定hashを指す。depsは既存Store内部発行closure・Git実行器・runtime reader・clockのみ。command/candidateをcallerが上書きするfieldはない。`ConvergencePhase`はcheck.requiredForおよびreadinessのgate選択（ready/launch/draft/merge）、`ObservationPhase`はmutation観測順序（ready/claim/launch）であり別型。claimはrequiredForへ追加せずready条件を再照合する。

| 観測phase | 発行前snapshot / guard | 唯一の消費Tx |
|---|---|---|
| ready（answerKey=null） | ready遷移元task、claim無し、ready条件・現在body/spec/owner/candidate。claimToken=null | transition/unblockのready Tx。既存状態CASと同時に消費。構造化consumeへ流用不可 |
| ready（answerKey非null） | exact answering request/immutable adopt_spec answerをStore解決。変更前snapshotと採用予定spec/generated body、owner/candidate、予定specのready条件。claimToken=null | 同じtask/keyのconsume Txだけで変更前CAS・予定spec照合と単回消費。採用・条件付きready・回答消費を一括。transition/unblockへ流用不可 |
| claim | task.status=ready、claim無し、既存claim CAS snapshot、ready条件の再照合と現在body/spec/owner/candidate。claimToken=null | claimTaskの既存CASと同一Txで単回消費し新claimを作成。ready消費済みtokenは不可 |
| launch | claimTask成功後の新exact claim必須。従来launch条件と§56のtask/worktree/lease/fence/run binding段階を照合 | startRun Txで単回消費しrun specと既存§56 ownerRunId bindingを確定 |

answer対象ready観測は、Storeがexact task/answerKeyからrequest ID・answer row・指定revisionのimmutable specを解決し、予定bodyを同じ生成器で生成・検証する。callerがspec/body/snapshotを渡して差し替える入口は設けない。観測開始時に変更前のtask status/block reason・採用revision（null含む）/spec hash/body hash・claim無し/open run無し・scope current revision・owner tuple・既存request claim/answer fenceを固定する。評価には予定specのcwd/所有/必要commit/check/resourceと予定bodyを用い、採用整合だけを「同Txでこの予定specを採用する」条件として評価する。未採用を無条件に許可する一般例外ではない。観測終了時とconsume Txで変更前snapshotをCAS再照合し、answer row/key/指定revision・予定spec hash/再生成body hash・最新documentの同task spec一致も要求する。変更前bodyは競合検出用であり、予定specのgateを旧bodyで評価しない。観測はallowed=falseでも不足一覧を予定specに結び付けて保持できるがready許可にはならない。

commit直前の外部snapshot再確認はTx外で行い、Tx内ではphase/未消費/期限・DB snapshot・owner/spec/body・既存CAS/lease fenceを照合する。allowed=falseの観測は許可にならない。CAS競合や不一致の観測も再利用せず破棄し再収集する。collector後の他者claim・claim解除後の別claim・別retry・bridge/direct fallbackへの流用は拒否。phaseと対象operationの対応が違えばREQUEST_FENCE、candidate差分はCANDIDATE_CHANGEDで副作用0。各消費は内部token予約と既存Tx成功の境界に閉じ、並行消費不可、rollbackしたtokenも失効とする。launch観測はcollectorが管理する現在のdispatch試行に限定し、同claimでも試行終了/失敗/fallback開始で未消費tokenを失効させる。次試行の発行前に前試行tokenを破棄し、常に新observationIdを要求する。

既存dispatchStageのclaim前はclaim観測、claim後preflightからlaunch直前は新launch観測を用い共通validatorを実行する。direct/bridge/fallbackの各別試行で再観測しstartRunへ渡す。既存body hash/config snapshot/runtime fenceを維持する。claimTask/startRun直接呼出しもmanagedは対応contextなし拒否。launch中差分は既存orphan/stale launchのdurable cancel経路で処理し、そのrunへ新specを貼らない。DB transactionが任意外部Git編集をロックすると主張しない。専有worktreeとhost所有規律を前提にし、外部書込検知は起動前後snapshotでfail-closedにする。

### 81.9 answer/request状態 — 新request statusなし

1. `prepareConvergenceAnswer`は既存queued/delivered/claimed等のclaim規則と`beginOrchestratorRequestAnswer`を使いansweringへ。構造入力検証/CAS/claim/監査メッセージのいずれか失敗ならenqueueも0。旧answer経路はbeginより前に拒否。
2. explanationは現在採用revisionを指定し、説明監査だけを消費、resolvedへ。live transportに説明を送るなら既存exact run/sessionとclaimを保持する。body/readyは変えない。実行条件の許可変更には使えない。
3. adopt_specは新revisionを指定。messagesはprepare後、非終端かつopen run/claim無しの対象についてanswerKey付きready観測を取得し、そのobservationIdをconsumeへ渡す。consumeは§81.8の変更前snapshot CAS・exact answer・予定spec/bodyの照合後、token単回消費、予定body全生成・明示採用、回答監査、exact key mark、resolvedを一Txにする。返すreadinessもこの予定specの評価である。allowed=trueかつworker-question blockのときだけ同Txでreadyへ。それ以外は同じblockedを維持し、readinessの不足を読み出せる。有効なallowed=false観測は採用と回答消費に使えるが、観測の欠落/null・期限切れ・別key/通常ready token・CAS不一致をgate不足として採用してはならず、副作用0で拒否して再収集する（下記stale/terminal分岐を除く）。resolvedは回答消費の完了であり検証完了ではない。後からreceiptが揃っても自動再回答せず、hostの明示ready操作を一度だけ行う。
4. 消費前に別revisionで同task specが変更されたらdisposition=staleとしてbody/status不変でexact keyを監査消費・resolved。新回答を古いkeyへ上書きしない。hostは新しいspecを明示採用する。終端へ先行した場合は既存§52.3のterminal consume/reconcileと同じ証拠対・Txを維持する。
5. active run向けadopt_specはprepare時ACTIVE_RUNで拒否。途中でactiveになった競合もconsume側でstale消費し条件変更を注入しない。cancel/replacementは§57を維持し新しい停止手順を設けない。
6. explanation、既存terminal consume、上記4/5のstale消費、既に消費済みkeyの冪等再呼出しはobservationId=nullを許す。これらはready遷移もspec採用も行わず、有効ready tokenを要求しない。終端/意味的staleの判定はTx内で先に行い、渡された未消費tokenは破棄する。単なる観測期限切れ/変更前snapshot競合をstale回答消費へ読み替えない。messages stageの反復では同key副作用0。claim/answer_key/stateの既存reconcileは変更せず、管理answerの非終端resolveは専用consume Txだけで実施する。汎用addEventで同名を追加してresolve/receipt発行に使えない。

### 81.10 host publication/wait実行adapter

新たなhachi host入口をCLI packageに置く。publicationは `executeConvergencePublication`、waitは `executeConvergenceWait`。これは任意gh/gitを監視・禁止するdaemonではない。既存のhost運用がこの入口へ移行することを受入gateとする。

```ts
interface HostActionInput {
  rootTaskId: string;
  expectedRevision: number;
  actionKey: string;
  principal: ConvergencePrincipal;
}
interface PublicationInput extends HostActionInput {
  phase: "draft" | "merge";
  candidate: Candidate;
  repository: string;
  pullRequest: number | null;
  approvalRef: string;
}
interface WaitInput extends HostActionInput {
  operation: "pause" | "resume";
  threadId: string;
  providerSessionId: string;
  goalId: string;
  capabilitiesDigest: string;
  cursorFile: string;
  event: { source: "task" | "inbox" | "user"; id: string } | null;
}
interface HostActionResult {
  status: "succeeded" | "unsupported" | "denied" | "uncertain" | "replayed";
  code: ConvergenceErrorCode | null;
  externalRef: string | null;
}
interface ConvergencePublicationAdapter {
  execute(input: PublicationInput): Promise<HostActionResult>;
  readback(input: PublicationInput): Promise<HostActionResult>;
}
interface ConvergenceWaitAdapter {
  execute(input: WaitInput): Promise<HostActionResult>;
  readback(input: WaitInput): Promise<HostActionResult>;
}
```

public wrapperの引数/戻り値は`executeConvergencePublication(deps, input:PublicationInput): Promise<HostActionResult>`、`executeConvergenceWait(deps, input:WaitInput): Promise<HostActionResult>`。depsはStore内部host journal closure、正式adapter、既存承認checker、candidate/owner reader、clockのbootstrap依存。adapter portのexecuteは1回の外部作用だけ、readbackは読取のみ。root単位readinessのdraft/mergeはincluded全taskのphase条件を集約し、PublicationInput.candidateのrepoへ当該PR対象の出荷差分が統合されていることを検証する。他repoの必要commitはrequiredCommitsの明示依存で確認し、同文字列OIDだけで別repoのPRに包含済みと扱わない。

host_actions.resultは`{externalRef:string|null; cursorFile:string|null; event:{source:'task'|'inbox'|'user';id:string}|null; readbackHash:string|null}`に固定し、prepared時も同object（未取得はnull）。action_keyは最大128bytes（生成resume hashは64文字）。resultに任意payload/回答本文/credentialを格納しない。capabilitiesDigest、owner/thread/goal、approvalRef、candidateはinput_hashへ固定し、再読可能な正式host参照をcallerが保つ。外部結果が不確定でinputを再構成できないときはACTION_UNCERTAINのままhost判断を要し、推測再実行しない。

上記executeはhost wrapper内からだけ呼ぶportであり、validatorをcaller任せにしない。public wrapperはbootstrapから注入された正式adapter/承認checkerの有無を先に検査し、未接合ならunsupported+ADAPTER_UNSUPPORTED、DB/action journal/goal/PRの副作用0。架空のshell fallbackを作らない。正式host adapter選択はpackage初期化時に行いworker/CLI optionから任意moduleを指定させない。

接合時の順序はcapability確認→既存approval/no-push等確認→共通phase validator→owner/revision/candidate再照合→action journal preparedの一意INSERT→外部execute→readback→succeeded。prepared後のtimeout/通信断/crashはuncertainとして復旧し、同keyのexecute再試行は禁止、readbackのみ。readbackで未実行と断定できても自動再送せずhostが新keyの判断を行う。外部exactly-onceをローカルjournalだけで保証しない。

draft: scope/review可能候補/作成権限と既存publication gate、未実施check一覧が必要。PR番号は初回null、作成結果をexternalRefへ。merge: PR番号必須、候補HEADとremote PR headの一致、全merge必須receipt/独立review/host acceptance/必要統合/UI証跡（対象時）と既存承認が必要。remote headを比較条件として実行adapterへ渡し、外部側が条件付きmergeできなければunsupported。draftの成功receiptをmerge許可へ転用しない。現時点でlive push/merge承認はない。

wait: pauseはevent=null、resumeは検証済み実event必須。goalIdはhost ownerが返す実goal識別（APIがIDを持たなければthread内objectiveのdigestをowner readbackから生成し、勝手な新objectiveへ置換しない）。current Desktop capability JSONは接続証拠でなく入力根拠。digest一致だけでenabledにせず、hostがexact owner/thread/provider sessionを正式接続で解決した受入証拠が必要。endpoint等の秘密はartifactへ記載しない。

既存 `task.ts:runAwait/runCheckpointedFollowNewAwait` と `orchestrator.ts:runAwait` のcursor/claimを使う。cursor fileはboard/filter/責務に固有、tenant/filter変更時は新path（既存v1/v2互換維持）。event.idはtask event ID、inbox request IDとdelivery世代、user入力は正式host event ID。timeout/無出力/heartbeatはresume入力にできない。pause readback後のcursorより新しく担当範囲に一致するtask終端、inbox質問/stall/監視異常、ユーザー入力だけ対象。同eventのactionKeyは`resume:<source>:<id>`をhash化した64文字IDとし、scopeの全sessionを通じ一意。input_hashにはthread/session/goal/cursorを含め、同key別inputはACTION_REPLAY。

pause時にcursorを確保し、pause/readback後に同cursor以後を再取得してpause中のevent消失を防ぐ。resume成功のreadbackとjournalを確定するまでcursor配送のackを進めない。既存CLI cursorが先へ進んでもjournalに保留event参照を保存してからackすること（result JSONにeventとcursorのみ、本文/claimなし）。既存inbox claimを恒久保持する仕組みは追加しない。generation交代時は旧actionをresumeせず、新ownerがreadbackと既存handoffで引き継ぐ。

正式接合の受入は同一owner/thread/session、pauseの状態readback、実event1回でresumeしreadback、stale owner/replay拒否、通信断時二重resumeなしを専用host検証で証明する。別app-serverを起動して既存threadを二重resumeしない。新しい定期wake/goal complete/blockedによる休止代替をしない。未接合は一度制約を報告してアプリ側停止を要し、五要件完全達成へ算入しない。


### 81.11 既存契約への限定例外

| 正本節 | 追記する本文案 |
|---|---|
| §5 | 「§81のadditive tablesはStore管理。旧writerを混在させたenforcementは不可。migration版は適用時に採番する。」 |
| §6/24 | 「管理scopeのready/claim/launchは§81の現在spec・consumer到達性・担当receiptを追加で必要とする。done/archived依存充足はこれを代替しない。」 |
| §39/43 | 「既存verify/runner/finalizeの実行前envelopeと同実行の終了結果・前後入力一致のみ§81のissuerへ接合できる。verify:none/skippedとworker handoffはpassed receiptにならない。既存gateの省略許可を追加しない。」 |
| §52.3 | 「§81管理taskのみprependを行わず、構造化answerの監査消費とspec全生成を行う。説明はready化せず、adopt_specのgate不足はblockedを維持する。terminal consumeとexact answer_key規則は不変。」 |
| §52.4 | 「§81管理taskへの条件変更回答は走行runへ注入せず、停止確認後の新revision明示採用を要する。説明配送には既存live claim/session規則を適用する。」 |
| §55.2 | 「§81のresolvedは回答消費を意味しready成立を意味しない。新request statusは追加しない。構造化prepare/consumeは既存claim/answer key/terminal reconcileを迂回しない。」 |
| §56 | 「§81は正式lease参照の消費のみ。resource発行/renew/cleanup権限・secret取扱い・dispatch時run bindingは本節を維持する。」 |
| §60 | 「管理scopeはunknown provenanceやbinding解除で解除しない。内部receipt issuerは表示actor/service文字列と別の非公開呼出し能力を要する。human local claimは承認証明にしない。」 |
| §50.1/50.4 | 「§81のwaitは既存cursorを利用しtimeoutをresume eventにしない。protocol pausedとDesktop正式owner接合は別の受入証拠。未接合時は副作用0のunsupported、新規定期wakeで代替しない。」 |

priority/steer自体の改修、review全文保存、P0/G2/nativeの契約は追加しない。旧自由文で実行条件を迂回注入することだけは§81の入口で拒否し、steer配送方式を設計し直さない。

