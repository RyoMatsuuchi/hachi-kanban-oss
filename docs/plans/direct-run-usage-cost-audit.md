# direct run の token usage / cost 監査可能化 — 設計文書

対象タスク: `t_d652c676ae86f709`（調査・設計のみ。実装は行わない）
関連（範囲外・分離を維持）: `t_c526241a56976daf`（モデル routing 正本化）

## 0. 要約

- **direct 経路（codex/claude 双方）は `SessionStatus.lastResult` を一度も埋めていない**。原因は
  provider が usage を返さないからではなく、adapter が構造化出力を要求せず人間可読 stdout をそのまま
  `.out` に捨てているため（§2-A）。
- **bridge 経路も codex に限り実質的に壊れている**。本番 DB（`dev` ボード。他ボード `tenant-a` は
  `task_runs` 0行のため対象外）`task_runs.meta` の codex bridge run は876行中816行が
  `lastResult.costUsd` キーを持つが、**その816行は全件** `costUsd=0, inputTokens=0` かつ
  `outputTokens` 最大値も0（残り60行は素直にキー自体が無い「未提供」。§2-B）。しかし codex 自身の
  ネイティブログ
  （`~/.codex/sessions/**/rollout-*.jsonl`）を同じ `session_id` で突合したところ、同一 session に
  実トークン数（例: `total_token_usage.input_tokens:83499, output_tokens:729`）が記録されている
  ことを確認した。**「未提供」ではなく「経路はあるが誤配線されている」**ケースであり、これは
  本タスクが警告する unknown/未提供/実測0 の混同がすでに本番で起きている実例である（§2-B）。
- claude 側は bridge で実際に機能している（86 行中 84 行が非ゼロ、金額分布も妥当）。
- 提案: 数値をそのまま持つ `lastResult` を廃止・凍結し、**metric ごとに状態＋出所（provenance）を
  持つタグ付き値**の新キー `usage`（仮称）を導入する。旧 `lastResult` は `legacy-unverified` として
  読み替え、collected/measured 側の集計には算入しない（§3, §5）。
- **重要な相互作用**: codex/claude に構造化出力フラグを素朴に足すと `.out` が JSON/JSONL に変わり、
  supervisor の handoff fence 抽出（生テキスト前提）を壊す。usage 取得と transcript 取得を分離する
  sidecar 設計が必須（§5.3）。
- 未解決のユーザー判断が2件ある。outcome は `blocked`（§7）。

---

## 1. 現状の経路図

`WorkerAdapter.provider ∈ {codex, claude}` に対し、実際には6つの実装クラスが存在する。

| # | クラス | provider | transport | `lastResult` を埋めるか |
|---|---|---|---|---|
| 1 | `CodexAdapter`（`packages/adapters/src/codex.ts`） | codex | even-terminal bridge (HTTP) | **埋める（が値が壊れている。§2-B）** |
| 2 | `ClaudeAdapter`（`packages/adapters/src/claude.ts`） | claude | even-terminal bridge (HTTP) | 埋める（実測値として機能） |
| 3 | `DirectCodexAdapter`（`packages/adapters/src/direct-codex.ts`） | codex | `codex exec` を detached spawn | **埋めない（キー自体が無い）** |
| 4 | `DirectClaudeAdapter`（`packages/adapters/src/direct-claude.ts`） | claude | `claude -p` を detached spawn | **埋めない（キー自体が無い）** |
| 5 | `CodexAppServerAdapter`（`packages/adapters/src/codex-app-server.ts`） | codex | Hachi 独自 App Server RPC | 埋める仕組み自体が無い（未モデル化） |
| 6 | `ClaudeCrossSessionWorkerAdapter`（`packages/adapters/src/claude-cross-session.ts`） | claude | claude Stop hook 経由 transcript 中継 | 埋めない（transcript 中継のみ、usage 非パース） |

`#1/#2` は `packages/adapters/src/session.ts` の共通実装（`getSessionStatus`/`extractLastResult`）を
薄くラップしているだけで、bridge が返す `/api/messages` 最後の `type:"result"` イベントから
`costUsd/turns/durationMs/inputTokens/outputTokens` を抽出する（`session.ts:315-336`、契約 §13.3/§14.5）。

`#3/#4` は `packages/adapters/src/direct-process.ts` の `resolveDirectStatus()`（同ファイル 132-140行）
を共有しており、これは `{state, lastActivityAt, resultCount}` の3値しか返さない。`lastResult` を
構成するコードパス自体が存在しない。

`#5` は「Hachi-owned Codex App Server durable worker」と自称する別プロトコル実装で、契約 §68.2 に
よれば **v0.18 は canary/on の実配送面まで実装するが、repo 例と live config は `off` のまま**と
明記されている。実データでも `native_session_bindings` テーブルは0行、`task_runs.meta` に
codex-app-server 由来の行は0件（本番未使用、pilot段階）。usage/cost は `codex-app-server.ts` /
`codex-app-server-rpc.ts` / `schema/codex-app-server-v2.ts` のいずれにも1語も出現しない
（プロトコル自体が概念としてモデル化していない）。

`#6` は `direct-claude.ts` からは一切 import されていない別 adapter で、Claude Code の Stop hook が
渡す `transcript_path`（実体は `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`）を境界読み取りし、
`ClaudeStopResultArtifact`（`claude-transcript-hook.ts:59-67`）へ `transcriptBytes` /
`lastAssistantMessageBytes` のみを記録する。transcript 自体は turn 単位の `usage` フィールドを
持つ（実機の `*.jsonl` で151行中に `"usage":{"input_tokens":14722,...}` 形式を確認済み）が、
hook 側はそれを一切パースしていない。

### 経路図（テキスト）

```
[codex CLI / claude CLI]
   │
   ├─ bridge (even-terminal, HTTP) ──▶ /api/messages type:"result" ──▶ session.ts extractLastResult()
   │                                                                        │
   │                                                                        ▼
   │                                              SessionStatus.lastResult { costUsd?, turns?, ... }
   │                                                                        │
   │        codex: 全フィールドが常に 0（誤配線。§2-B）                        │
   │        claude: 実測値として機能                                          │
   │                                                                        ▼
   │                                          finalize.ts fetchLastResultForEndRun()
   │                                          → buildEndRunMeta() → store.endRun(meta.lastResult=...)
   │                                                                        │
   │                                                                        ▼
   │                                                     task_runs.meta（唯一の永続面。§4.1）
   │
   └─ direct (detached spawn, stdout→.out ファイル) ──▶ resolveDirectStatus()
                                                          → {state, lastActivityAt, resultCount} のみ
                                                          → lastResult は永久に undefined
                                                          → buildEndRunMeta() は lastResult 無しで
                                                            早期リターン（meta.lastResult キー自体が
                                                            book に一度も現れない）
```

---

## 2. 欠損の根因（切り分け）

タスクが求める3分類（unknown / 未提供 / 実測0）に加え、実データから **2つの追加パターン**
（「経路はあるが誤配線」「provider に概念自体が無い」）が実在することを確認した。単純な
nullable number では表現しきれない理由がここにある。

### 根因A: adapter が構造化出力を要求していない（direct codex / direct claude）

- `direct-codex.ts` の `buildLaunchScript()`（57-90行）は `codex exec -c model=... --cd <cwd> - <
  <promptFile> > <outFile> 2>&1` を組み立てる。**`--json`（JSONL構造化イベント出力）フラグは無い**。
  ローカル `codex exec --help` で `--json  Print events to stdout as JSONL` の存在を確認済み。
  現状の `.out` は人間可読の TUI 風出力で、実運用サンプル
  （`~/.hachi-kanban/state/direct-sessions/direct-01b64fadfff03c70.out` 末尾）には
  ```
  tokens used
  26,800
  ```
  という**平文サマリー行**が出るのみで、adapter 側はこれを一切パースしていない。
- `direct-claude.ts` の `buildLaunchScript()`（79-101行）は
  `claude -p --model <model> --dangerously-skip-permissions < <promptFile> > <outFile> 2>&1` を
  組み立てる。**`--output-format json` は無い**（既定 `text`）。ローカル `claude --help` で
  `--output-format <text|json|stream-json>`（`-p` 使用時のみ有効）の存在を確認済み。実際に
  `claude -p --output-format json ...` を実行したところ、以下が確実に得られた:
  ```json
  {"is_error":false,"duration_api_ms":2438,"num_turns":1,"total_cost_usd":0.1464183,
   "usage":{"input_tokens":2,"cache_creation_input_tokens":23137,
            "cache_read_input_tokens":25151,"output_tokens":3},
   "modelUsage":{"claude-sonnet-5":{"inputTokens":2,"outputTokens":3,"costUSD":0.1464183}},
   "type":"result"}
  ```
  実運用 `.out`（`model:"claude-sonnet-5"` の direct セッション3件）を
  `grep -iE 'usage|cost|token|\$[0-9]'` した結果は**3件とも0ヒット**。text モードである以上、
  原理的にも一致する。
- 保存先スキーマは既に存在する: `packages/core/src/types.ts:784-791` の `SessionResultStats`
  （`costUsd?/turns?/durationMs?/inputTokens?/outputTokens?`、全フィールド optional）と
  `SessionStatus.lastResult?`（同768-782行）。bridge 経路（claude）がまさにこの型を実際に埋めている
  ため、**「schema が無い」のではなく「direct 経路がこの schema を一度も埋めていない」**が正確な
  切り分けである。
- Claude 側にはもう一つの経路がある: `direct-claude.ts` は現状フラグを変えなくても、Claude Code
  CLI が副作用として書く `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`（ネイティブ transcript）
  に turn 単位の `usage` が既に記録されている。ただし `direct-claude.ts` は `--session-id <uuid>`
  を渡していないため、どの `.jsonl` がどの direct session に対応するか決定的に紐付けできない
  （後述 §5.3 で解決策を示す）。

### 根因B: 経路はあるが正しく配線されていない（codex bridge の実測0）

- 本番 `~/.hachi-kanban/boards/dev/kanban.db`（読み取り専用で自ら SQL 実行して確認。他ボード
  `tenant-a` は `task_runs` が0行のため対象外）の `task_runs` を `provider` × `meta.serverUrl`
  （transport の実体。bridge は `http://127.0.0.1:34xx`、direct は文字列 `"direct"`、
  `meta.serverUrl` 自体が無い古い行は `(none)`）で集計した結果:

  | provider | transport | 総run数 | `lastResult.costUsd` キーあり |
  |---|---|---|---|
  | codex | bridge (`:3456`) | 876 | 816 |
  | codex | direct | 197 | 0 |
  | codex | (none、legacy) | 6 | 0 |
  | claude | bridge (`:3457`) | 87 | 86 |
  | claude | direct | 20 | 0 |
  | claude | (none、legacy) | 7 | 0 |

  この分解により、**「codex 1079行中263行（1079-816）でキーが無い」の内訳**が明確になる:
  - 197行は **codex direct**（キーが無いのは当然。根因A、direct は `lastResult` を一度も書かない）
  - 6行は `meta.serverUrl` 自体を持たない legacy 行（原因未特定、根因A/Bどちらにも断定しない）
  - **残り60行が codex bridge 自身のキー欠落**（876−816）。これは同じ bridge transport 内に、
    「キーが無い＝素直な未提供」と「キーはあるが全件0＝誤配線」という**2つの異なる欠損パターンが
    共存している**ことを意味する。原因は run 途中で bridge 呼び出しが失敗した等が考えられるが
    本リポジトリからは断定できない。
  - claude bridge も同様に87行中1行（87−86）だけキーが無い（素直な未提供）。

  さらに codex bridge の**キーがある816行は全件が厳密に `costUsd=0, inputTokens=0`**
  （`MIN=MAX=0`）。一方 claude bridge の86行は84行が非ゼロで、2行が厳密に0（0トークンで即終了
  した等の正当な実測0とみなせる）。**同じ「キーはある・値は0」でも codex816行と claude2行では
  意味が異なる**——後述のネイティブログ突合により codex 側は「誤配線による偽の0」と判断できる
  のに対し、claude の2行はサンプル数・分布（非ゼロ84行と桁が揃う運用実態）から正当な実測0と
  みなせる。
- `session.ts:323-335` の `extractLastResult()` は `type:"result"` イベントの各フィールドが
  `typeof value === "number"` の場合のみ採用する。**キーが欠落しているのではなく、bridge が
  literal に `costUsd:0` 等の「数値としての0」を送ってきている**ということが、DB に値そのものが
  書き込まれている事実（キー自体が欠落していれば `buildEndRunMeta` は `meta.lastResult` を
  一切書かない）から確定できる。
- 実際に codex の1件（`task_runs.id=2`、`session_id=019f22ac-8d6a-7672-bb97-def401d39c86`、
  `task_id=t_ba4efa15871dee7a`）を、対応する codex ネイティブログ
  `~/.codex/sessions/2026/07/02/rollout-2026-07-02T20-52-41-019f22ac-8d6a-7672-bb97-def401d39c86.jsonl`
  （ファイル名にsession_idがそのまま含まれ一意に対応。契約 §54.1 が言及する完全記録の一次ソース）
  と突合した。同ファイルの最後の `"type":"token_count"` イベント（`event_msg.payload`）は
  ```json
  {"total_token_usage":{"input_tokens":83499,"cached_input_tokens":67072,
    "output_tokens":729,"reasoning_output_tokens":264,"total_tokens":84228},
   "last_token_usage":{"input_tokens":21238,"cached_input_tokens":20864,
    "output_tokens":175,"reasoning_output_tokens":72,"total_tokens":21413},
   "model_context_window":258400}
  ```
  であり、同じ run について `task_runs.meta.lastResult` は `costUsd=0, inputTokens=0` を記録して
  いた。**codex 自身は実測トークンを保持しているが、even-terminal bridge の `result` イベントには
  反映されていない**ことを、DBとネイティブログの直接突合で確認した。同ファイル中に `"cost"`
  という語は0件（`grep -c '"cost"' <file>` = 0）。
- even-terminal 自体は本リポジトリ外のアプライアンス（契約 §68 系の記述参照）であり、ソースコードは
  ここには無いため、bridge 側の正確な不具合原因（codex 用マッピングの欠落なのか、bridge が
  codex の token_count イベントを購読していないのか）は本リポジトリからは断定できない。
  ただし**「未提供」ではなく「値として0が誤って報告されている」**ことは実データで確定している。
  これは今回のスコープが求める「実測0」判定を素朴に信用すると、816件の誤情報を正しい実測値として
  扱ってしまう典型例である。

### 根因C: provider に USD という概念自体が存在しない（codex の cost）

- codex 自身のネイティブ rollout ログには `"cost"` という語が一件も出現しない。代わりに
  `"rate_limits":{...,"plan_type":"pro","credits":{"has_credits":false,...}}` という**サブスクリ
  プション枠消費**の記録がある。codex は従量APIではなく Pro プラン枠消費モデルであるため、
  per-request の USD コストという概念がそもそも無い可能性が高い。
  これは「未提供」でも「経路の誤配線」でもなく、**「その provider では意味を持たない値」**という
  第4のカテゴリであり、costUsd を単純な nullable number として扱うと、この状態と「本当は取得
  できるが失敗した」状態を区別できない。
  対応方針はユーザー判断が必要（§7 Q1）。

### 根因D: 経路自体が usage/cost を一切モデル化していない（codex-app-server）

- `codex-app-server.ts` の `status()`（679-695行）は `{state, lastActivityAt, resultCount, raw}`
  のみを返す。プロトコル実装（`codex-app-server-rpc.ts`、`schema/codex-app-server-v2.ts`）を
  含め usage/cost/price/billing に該当する語は一切出現しない。契約 §68.2 により本番 rollout は
  `off` で、実データでも0行（pilot 未使用）。**現時点では「欠損」ですらなく「対象外」**。
  将来この経路を本番投入する際は、新規に usage モデリングが必要になる（本文書では前方互換の
  注記に留める。§5.5）。

### 一次証拠まとめ表

| 経路 | 総run数 | costUsd キーあり | 実データでの分類 |
|---|---|---|---|
| codex direct | 197 | 0 | **未提供**（根因A。adapter が構造化出力を要求していない。取得可能） |
| claude direct | 20 | 0 | **未提供**（根因A。同上。または native `.jsonl` 側で回収可能） |
| codex bridge | 876 | 816（**全件0=誤り**）、残り60は未提供 | **経路誤配線**（根因B。同一 transport 内に「未提供」と「偽の実測0」が共存） |
| claude bridge | 87 | 86（84行非ゼロ+2行正当な0）、残り1は未提供 | 機能している（provenance 未記録という限定的な弱点のみ） |
| codex-app-server | モデル化なし | モデル化なし | **対象外**（pilot 未使用、schema 自体が無い） |
| codex の cost 概念そのもの | Pro枠消費でUSD概念無し | （tokenは実在） | **provider不適用**（要ユーザー判断） |

---

## 3. 提案 schema

### 3.1 なぜ nullable number では不十分か

根因B（codex bridge の誤ゼロ）と根因C（codex の cost 概念不在）が、単純な
`costUsd?: number` では**表現不可能な2つの異なる「0/undefined」**であることを証明している。
- 根因Bの `costUsd:0` は「値」としては正しい JSON だが「意味」としては嘘（未提供が実測0を
  偽装している）。
- 根因Cの「codex に cost が無い」は、値が取れないのではなく**尋ねること自体が無意味**。

どちらも今の `SessionResultStats`（`costUsd?: number` のみ）では「0」または「キー欠落」としてしか
表現できず、read model 側（metrics.ts）はこの2つと「本当に $0 だった run」を区別する手段を持たない。

### 3.2 提案する型（`packages/core/src/types.ts` へ追加。既存 `SessionResultStats` は変更しない）

```ts
/**
 * metric 単位のタグ付き値。数値の隣に理由を必ず持たせ、値と理由の drift を防ぐ。
 * legacy-unverified は measured と構造的に別 state にする（同じ判別子の下にぶら下げない）。
 * こうすることで `switch (v.state) { case "measured": ... }` を書いた実装が legacy-unverified
 * を暗黙に取り込むことをコンパイラレベルで防げる（exhaustiveness チェックで別 case を強制できる）。
 */
type MetricValue =
  | { state: "measured"; value: number; provenance: MetricProvenance }
  | { state: "not-provided" }          // 経路はあるが今回この run では返らなかった
  | { state: "unavailable-by-design" } // provider の課金モデル上その概念が存在しない（根因C）
  | { state: "unknown" }               // そもそも取得経路が無い/未実装（根因D 等）
  | { state: "legacy-unverified"; value: number }; // 旧 lastResult からの読み替え（§5.2）。
                                                    // measured ではない。既定集計（§4.2）は
                                                    // この state を機械的に除外する

/** どの経路が生成した数値か（measured のみが持つ）。監査可能性の核。§4.3 の二重集計防止にも使う。 */
type MetricProvenance =
  | "bridge-result-event"      // even-terminal /api/messages type:"result"
  | "cli-json-result"          // codex --json / claude --output-format json の直接出力
  | "cli-native-session-log";  // ~/.claude/projects/*.jsonl や ~/.codex/sessions/*.jsonl の事後読み取り

interface RunUsage {
  costUsd: MetricValue;
  inputTokens: MetricValue;
  outputTokens: MetricValue;
  turns: MetricValue;
  durationMs: MetricValue;
  /** この usage オブジェクトを書いた adapter/バージョン（回帰調査用） */
  collectedBy: string; // 例: "direct-codex@jsonl-v1", "bridge-session@v1"
}
```

- 全フィールド `MetricValue` で統一し、「値」と「値が無い理由」を同じオブジェクトに閉じ込める。
  `costUsd?: number` と `costStatus?: ...` のような**別々のフィールドに分けない**
  （分けると実装時に drift する）。
- `state: "measured"` のときだけ `value` を持つ判別ユニオンにし、`value` を読む前に必ず `state`
  を判定させる（zod 等での閉じた検証と相性が良い）。
- 根因Bの再発防止: 新しい collector（direct 実装、bridge の再検証）は、provider から生の
  `token_count`/`usage` イベントを **1件も観測できなかった場合は `not-provided`**、観測できたが
  値が構造的に0（例えば per-request 0トークンで完了した）場合だけ `measured, value:0` を書く、
  という規約を徹底する。「イベント自体を見ていない/信頼できない」ときに 0 を書いてはならない。

### 3.3 redaction 境界（allowlist のみ）

- 保存してよいのは `RunUsage` の数値フィールド＋`model` id ＋`provenance`／`collectedBy` の
  文字列のみ。**allowlist 抽出**とし、denylist（「危険そうな文字列を除去」方式）は禁止。
- `claude --output-format json` の応答本体（`result`/`text` フィールドの会話文）、
  codex rollout JSONL の `credits`/`plan_type`/`rate_limits`（アカウント面データ）、
  `SessionStatus.raw`（`types.ts:780-781` のコメント自身が「ログには要 redaction」と明記）は
  **`task_runs.meta` へマージすることを明示的に禁止**する。usage 抽出コードは、パース後に
  allowlist フィールドだけを持つオブジェクトを構築し、元の生payload参照を残さない。
- secret／prompt本文／customer data は、usage 抽出パイプラインが読む入力ソース
  （`.out`、bridge JSON、CLI JSON、ネイティブ `.jsonl`）のいずれにも触れてはならない
  フィールドとして扱う（今回の抽出対象キー一覧に無いものは全て捨てる）。

### 3.4 正本の置き場所

- `task_runs.meta` は変わらず唯一の永続面（§4.1 で詳述）。新キー `meta.usage: RunUsage` を追加し、
  旧 `meta.lastResult` は**書き込みを凍結**（新規 collector は書かない）。読み取り側は
  `usage` を優先し、`usage` が無い古い行だけ `lastResult` を `state: "legacy-unverified"`
  （§3.2。`measured` とは別の state）として読み替えてよいかどうかは §5.2 のユーザー判断に従う。

---

## 4. read model と表示の責務分担

### 4.1 正本 vs 派生

- `~/.hachi-kanban/logs/supervisor.jsonl`（580MB）を `costUsd`/`lastResult`/`inputTokens` で grep
  した結果は**0件**。terminal event / ログには数値が一切載っていない。
  **`task_runs.meta` が唯一の永続面**であることが実データで確定している。
- 提案: この構造を維持する。terminal event（`run_ended` 等）には **数値を載せず、
  `usageCollected: boolean` 相当の状態フラグと provenance だけ**を持たせる。イベント側に数値の
  写しを作った瞬間、`task_runs.meta` との間で二重集計・不整合のリスクが生まれるため、意図的に
  避ける。

### 4.2 CLI / Web / retro の責務分担

| 面 | 現状 | 提案する責務 |
|---|---|---|
| Web `RunsCard.tsx` | `task_runs.meta.lastResult` を読み、`formatStat()`（`format.ts:74-76`）が `undefined/null → "-"`、それ以外は値をそのまま表示。**0と未計測を既に正しく区別している**唯一の面。 | `meta.usage` の `MetricValue` を読み、`state` に応じて `"-"`（unknown）/`"N/A"`（unavailable-by-design）/`"(未取得)"`（not-provided）/実測値、の4値表示に拡張する。表示ロジックのみ変更、DB役割は変えない。 |
| Web `/metrics`（`MetricsReader`、`packages/core/src/metrics.ts`） | `profileProviderStats()` が `json_extract(...) IS NOT NULL THEN value ELSE 0` で **SUM に不明分を無音で0算入**。`run_count = COUNT(*)` は既知/不明を問わず全run。 | 集計は裸の合計を返さない契約に変更する: `{measuredTotalUsd, measuredRunCount, notProvidedRunCount, unavailableRunCount, unknownRunCount}` の組で返す。「総額」を見せる場合は必ずカバレッジ（何件中何件が実測か）を併記する。 |
| CLI（`packages/cli/src`） | cost/token 表示面が**存在しない**（grep 0件）。`hachi retro` のようなコマンドも無い。 | 本文書のスコープでは新規 CLI コマンド実装は含めない（実装タスクで判断）。ただし read model 契約（`RunUsage`/カバレッジ付き集計）を CLI が将来利用可能な形で core に置くことを設計要件とする。 |
| retro（契約 §43.2） | `hachi retro` という集計コマンドは存在せず、「レトロ」は schedule 経由で起票される週報タスク雛形を指す。budget/spend への言及は無い。 | 週報タスクのプロンプトに `/metrics` のカバレッジ付き集計を引用させる形で足りる。retro 専用の新規集計ロジックは不要（`MetricsReader` を再利用）。 |

### 4.3 二重集計にならない境界

- 書き込みは `finalize.ts` の `buildEndRunMeta()` 一箇所のみ（`lastResult:` 代入は
  リポジトリ全体で `finalize.ts:325` の1箇所のみと grep で確認済み。`session.ts` はあくまで
  adapter が返す `SessionStatus` を構成するだけで DB には触れない）。新設計でもこの
  **単一 writer 原則**を維持し、`usage` フィールドも `finalize.ts` からのみ書く。
- CLI/Web/retro はいずれも `task_runs.meta` の読み取りのみを行う派生面とし、集計ロジックは
  `packages/core/src/metrics.ts`（`KanbanReadView`/`MetricsReader` 相当）に集約する。Web パッケージ
  から生 SQL を書かない、という既存の契約 §14.1 の原則をそのまま usage 集計にも適用する。

---

## 5. migration / 後方互換

### 5.1 スキーマ変更の要否

- `task_runs` テーブルは `meta TEXT NOT NULL DEFAULT '{}'`（`db.ts:1061-1070`）という単なる
  JSON文字列カラムで、専用の migrations ディレクトリも無く、番号付き `ALTER TABLE` が `db.ts`
  内にインラインで管理されている。`meta` 列自体への `ALTER TABLE` は過去に一度も無い。
  → **DB migration は不要**。新キー `usage` を JSON 内に追加するだけで既存行と共存できる
  （`meta` は自由形式の JSON なので古い行に `usage` キーが無くても壊れない）。

### 5.1.1 改正が必要な `docs/contract.md` 条項

本提案は既存の正本テキストと正面から矛盾するため、実装フェーズの着手前に契約改正が要る
（契約の編集はオーケストレーターのみ）。

- **§14.5「コスト/トークンの永続化」（`docs/contract.md:642-646`）**: 「取得できた lastResult を
  run の meta へマージ保存する」と規定しているが、本提案は `lastResult` への新規書き込みを凍結し
  `usage` キーへ切り替える。§14.5 は `usage`/`MetricValue`/`legacy-unverified` の記述に差し替える
  改正が必要。
- **§43.1「データ（migration v6 を予約）」（`docs/contract.md:1538-1542`）**: 「run 系メトリクス
  （成功率・rework率・コスト）は task_runs/task_events からの集計ビュー」とだけ規定しており、
  返り値がカバレッジ情報（`measuredRunCount`/`notProvidedRunCount` 等）を伴う点が明文化されて
  いない。`ProfileProviderStat` の戻り値形状を変える提案（§4.2）は Web `/metrics` の consumer に
  対する破壊的変更でもあるため、§43.1/§43.2 にカバレッジ付き集計であることを追記する改正が必要。

### 5.2 旧902行（うち816行は誤り）の扱い

- 816行の codex `costUsd:0` は「経路誤配線による既知の誤り」であり、これを素朴に
  `measured, value:0` として再解釈すると、この偽ゼロが集計を恒久的に汚染する。
- 推奨（§3.2/§3.4 と対応）: 旧 `lastResult` は新規書き込みを止め、読み取り時のみ `state:
  "legacy-unverified"`（`measured` とは構造的に別の判別子）として扱う。既定の集計（§4.2 の
  `measuredTotalUsd` 等）は `state === "measured"` の行だけを対象にする実装になるため、
  `legacy-unverified` は**型レベルで自動的に除外される**（別 case を書かない限り集計に混入
  できない）。個別 run 詳細画面（Web `/task/:id`）では「(旧形式・要確認)」等の注記付きで
  参考値として表示することは許容する。
  ※ この判断は codex bridge の「キーがあり値が0」の816行のみが対象。同じ bridge の中でも
  「キー自体が無い」60行（§2-B）は素直な `not-provided` であり、この判断の対象外（そのまま
  未提供として扱える）。
- claude の86行（84行が妥当な実測値、2行が正当な実測0）まで一律に隔離するのは過剰である可能性が
  高い。ここは provider 別に閾値を分けるか、一律隔離するかでユーザー判断が必要（§7 Q2）。

### 5.3 fence-extraction との相互作用（設計上の最重要制約）

`fetchDirectTranscript()`（`direct-process.ts:143-149`）は `.out` を verbatim で返し、
supervisor の `fence-extraction.ts` はこれを**生テキストとして正規表現的に検索し**
`hachi-handoff-v1` フェンスを取り出す（`fence-extraction.ts` 冒頭コメント:
「user prompt を含む bridge transcript は検索せず、adapter が保証する構造化 result だけを扱う」）。
Web の artifacts 表示もこの `.out`/transcript をそのまま使う。

**codex に `--json`、claude に `--output-format json` を素朴に追加すると、`.out` の中身が
単一JSON/JSONLになり、handoff fence が JSON 文字列フィールド内にエスケープされて埋め込まれる
（改行が `\n` に、`"` が `\"` に変換される）。これは全 direct run の handoff 抽出を静かに壊す**。
usage を取りに行く変更が、この副作用を意識せずに実装されると本番障害になる。

提案: **usage 取得と transcript/fence 取得を分離する（sidecar 方式）。`fence-extraction.ts` 自体は
変更しない**。

- **codex**: `codex exec` は `-o, --output-last-message <FILE>`（最終 assistant メッセージを
  別ファイルへ書く）を持つ。現行どおり `.out` へは通常の stdout（人間可読）をリダイレクトし
  fence 抽出はそのまま維持する。usage だけを別途取りたい場合、`--json` の出力先を**新規の
  sidecar ファイル**（例 `<sessionId>.events.jsonl`）へ redirect し、`token_count` タイプの
  イベントだけを抽出する専用パーサ（`direct-process.ts` 内、adapter local）を新設する。
  `.out`/fence 抽出コードパスには一切触れない。
- **claude**: claude CLI に `-o` 相当（最終メッセージ別ファイル出力）は無いため、2つの選択肢が
  ある。
  (a) `.out` は現状どおり text モードのまま変更せず、`--session-id <uuid>` を明示的に付与して
      （`claude --help` で存在確認済み、現状 `direct-claude.ts` は未使用）
      `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`（Claude Code が副作用として必ず書く
      ネイティブ transcript）を run 終了後に決定的なパスとして読み、`usage` フィールドを
      集計する。**CLI起動フラグそのものは変えず、`.out`/fence 抽出への影響ゼロ**。実機で
      同ファイルに `"usage":{"input_tokens":...}` を含む行を151件確認済み。
      注意: このパスは `$HACHI_KANBAN_HOME` の外（`~/.claude/projects/`、Claude Code 自身の
      ホームディレクトリ配下）を読む提案であり、state root 境界の外に一次資料を持つ。
      `claude-transcript-hook.ts` が Stop hook 経由で同種の境界読み取りを行っている前例が
      あるため方針自体は妥当と考えるが、実装時にこの境界越えを明示的にレビュー対象とすること。
  (b) `--output-format json` に切り替え、`fetchDirectTranscript()` 相当の関数を
      JSON-aware にし、`result` フィールドの文字列を「アンラップした transcript」として
      fence-extraction へ渡す（`fence-extraction.ts` 自体は変更不要、adapter 側で吸収）。
  → (a) の方が影響範囲が小さく（CLI起動方法・fence抽出のどちらも不変）、既に副作用として
  書かれているファイルを読むだけなので推奨。ただし並行 direct session が同一 cwd で走る場合の
  ファイル特定の確実性（`--session-id` により uuid は一意なので問題ないはず）は実装時に
  focused test で固定する（§6）。

### 5.4 起動スクリプト変更の順序調整

`direct-codex.ts`/`direct-claude.ts` の `buildLaunchScript()` は `t_c526241a56976daf`
（モデル routing 正本化）が model/effort/speed フラグの扱いで触る可能性がある同じ関数である。
本文書はスコープ分離のため実装順序を指図しないが、実装フェーズでは**同一ファイルへの並行編集
衝突を避けるため、どちらのタスクが先に着手するか orchestrator 側で調整が必要**、という点だけ
明記しておく。

### 5.5 codex-app-server への前方互換

現時点で usage/cost をモデル化しないことは正しい判断だが、将来 rollout=on にする際、本文書の
`RunUsage`/`MetricValue` 型がこの経路にもそのまま使えるよう、**schema は「bridge か direct か」
を前提にしない**（`collectedBy`/`provenance` に第3の値を追加するだけで済む）設計とする。

---

## 6. 検証戦略

### focused test で固定する項目（実装フェーズ向けの指針。本タスクでは実装しない）

1. **カバレッジ集計**: `metrics.ts` の `profileProviderStats()` 相当のテストに、
   `lastResult`/`usage` が欠損した run を混在させたフィクスチャを追加し、「裸の合計」ではなく
   `(measuredTotalUsd, measuredRunCount, notProvidedRunCount, ...)` の組が返ることを assert する。
   現状 `metrics.test.ts` の `insertRun` ヘルパーは常に `lastResult` 有りの fixture のみを
   挿入しており（欠損ケース無テスト）、ここが最初に落ちるはずの穴である。
2. **偽ゼロの非分類**: codex bridge の実データ形（`costUsd:0` が literal に存在するが
   provenance が `legacy-unverified`／`bridge-result-event` のいずれであっても、ネイティブログの
   `token_count` と矛盾する場合にどう扱うか）を再現するフィクスチャで、
   「明示的な数値0」が無条件に `measured` へ分類されないことを assert する。素朴な実装が
   最も陥りやすい失敗パターンなので明示的にテストする。
3. **direct adapter の usage 抽出**: 本調査で取得した実サンプル
   （`~/.hachi-kanban/state/direct-sessions/*.out` の平文 `tokens used` 行、
   `claude -p --output-format json` の実測 JSON）を golden fixture として保存し、
   direct adapter の usage パーサがそこから正しく `RunUsage` を構成することを固定する。
4. **fence 抽出の非回帰**: §5.3 の sidecar 方式を採用する場合、`.out` の内容・形式が変更前後で
   完全に同一であることを保証する回帰テストを追加する（handoff fence 抽出のテストスイートに、
   usage sidecar 導入後も同じ入力で同じ結果が出ることを assert するケースを足す）。
5. **単一 writer の維持**: `lastResult:`/`usage:` への代入が `finalize.ts` の該当関数以外に
   存在しないことを、grep ベースの lint か静的テストで固定する（今回は手動 grep で確認したのみ）。

### 実機で確認する項目

1. `codex exec --json` を実際に実行し、`token_count` イベントの正確なスキーマ
   （`input_tokens`/`cached_input_tokens`/`output_tokens` 等のキー名、複数ターンでの累積 or
   差分か）を確定する（本調査ではネイティブ rollout ログでの類似イベントのみ確認、`--json`
   モード自体の出力は未実行）。
2. `claude --session-id <uuid>` を direct 起動に付与した際、対応する
   `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` が確実に作成されること、および同一 cwd で
   複数 direct session が並行しても衝突しないことを確認する。
3. even-terminal bridge 側の codex 誤配線について、bridge の設定/バージョンで再現条件が
   変わるか（既知の bug なのか、config によるものか）を、bridge 運用者（もしくは even-terminal
   のドキュメント）に確認する。本リポジトリのコードだけでは断定できない。

---

## 7. 未確定でユーザー判断が要る点

### Q1: codex に USD コスト概念が無い場合の扱い（根因C）

codex は Pro プラン枠消費モデルで、rollout ログに `cost` フィールドが一切無い一方、
「費用対効果の継続評価」という本タスクの目的上、無視できない論点である。

- **選択肢a**: token 数のみを `measured` として報告し、`costUsd` は
  `state: "unavailable-by-design"` のまま公開する。実装コストが最小で、嘘をつかない。
- **選択肢b**: 公開されている codex の価格表（token単価）から USD を**合成計算**する。
  費用対効果の比較がしやすくなる反面、「実測」ではなく「推定」であることを明示する
  provenance（例: `"estimated-from-price-table"`）が必須になり、schema がもう1段複雑になる。
- **選択肢c**: Pro プランの credit 消費量（`rate_limits.credits` 相当）を別軸の指標として
  追跡し、USD と並べて表示する。プラン変更に強いが、モデル routing の費用対効果評価という
  当初目的には直接繋がりにくい。

**推奨**: 選択肢a（token のみ実測、cost は unavailable-by-design で正直に表示）を既定とし、
選択肢bを「後日、価格表が安定してから追加できる拡張」として schema 上の余地だけ残す。
費用対効果評価の第一関門は「無いものを0と誤認しないこと」であり、合成推定はその次のフェーズで
良いと考える。ただし最終判断はユーザーに委ねる。

### Q2: 旧816行（codexの偽ゼロ）を含む既存 `lastResult` 902行をどう扱うか

- **選択肢a**: 全 provider 一律で `legacy-unverified` に隔離し、既定集計から除外する
  （§5.2 で述べた推奨）。実装が単純で、偽ゼロの再発を確実に防ぐ。claude の妥当な84行も
  「参考値」に格下げされる副作用がある。
- **選択肢b**: provider ごとに扱いを分け、claude の旧 `lastResult` はそのまま `measured`
  （`provenance: "bridge-result-event"` 相当）に昇格し、codex の旧 `lastResult` だけ
  `legacy-unverified` にする。claude 側の実測データを活かせるが、「provider ごとに信頼度が
  違う」という例外ルールを read model に持ち込むことになる。
- **選択肢c**: 旧816行（codex）を明示的に削除・null化する（データ修正）。本文書は
  live config 変更や DB 書き込みを行わない調査タスクのため、選択したとしても本タスクでは
  実施しない。

**推奨**: 選択肢b（provider 別）が実利は最も高いが、判断はユーザーに委ねる。

---

## 付録: 一次証拠の所在（再現用）

- `codex exec --help` の `--json`/`-o, --output-last-message` フラグ（ローカル `codex-cli 0.144.1`）
- `claude --help` の `--output-format`/`--session-id` フラグ（ローカル `~/.local/bin/claude`）
- `~/.hachi-kanban/state/direct-sessions/direct-01b64fadfff03c70.out`（codex direct、末尾の
  `tokens used\n26,800` 平文）
- `~/.hachi-kanban/state/direct-sessions/direct-018a58d4eb221663.out` 他2件（claude direct、
  usage/cost 系文字列0ヒット）
- `~/.hachi-kanban/boards/dev/kanban.db` の `task_runs` テーブル（読み取り専用SQLを自ら実行し確認。
  codex 1079行中816行が`costUsd`キー保持・全件0、claude 114行中86行が`costUsd`キー保持・84行非ゼロ
  /2行が正当な実測0。`tenant-a`ボードは`task_runs`0行で対象外）
- `~/.codex/sessions/2026/07/02/rollout-2026-07-02T20-52-41-019f22ac-8d6a-7672-bb97-def401d39c86.jsonl`
  （`task_runs.id=2`のsession_idとファイル名一致で突合。`token_count`イベントに
  `input_tokens:83499, output_tokens:729`等の実トークン数、`cost`語は同ファイル中0件）
- `~/.claude/projects/<project-slug>/42d1e897-*.jsonl`
  （turn単位 `usage` フィールドを含む151行を確認）
- `~/.hachi-kanban/logs/supervisor.jsonl`（580MB、`costUsd`/`lastResult`/`inputTokens` は0件）
- `packages/adapters/src/session.ts:315-336`（bridge 側 `extractLastResult`）
- `packages/adapters/src/direct-process.ts:132-149`（direct 側 `resolveDirectStatus`/`fetchDirectTranscript`）
- `packages/supervisor/src/stages/finalize.ts:270-328`（`task_runs.meta` への唯一の write path）
- `packages/core/src/metrics.ts:298-337`（`profileProviderStats` の `SUM(...ELSE 0)`）
- `packages/core/src/db.ts:1061-1070`（`task_runs.meta TEXT NOT NULL DEFAULT '{}'`）
- `packages/web/src/client/components/RunsCard.tsx`（`formatStat` による "-" 表示、既に0と未計測を区別）
- `packages/supervisor/src/fence-extraction.ts`（handoff fence の生テキスト前提）
- `docs/contract.md` §13.3/§13.6/§14.5/§43.1-43.2/§54.1/§68.2

---

# 設計改訂（2026-08-20・オーケストレーター確定）

本節は §7 の未確定2点を確定し、既存ライブラリ調査の結果にもとづいて §0 の結論を一部差し替える。
**以降は本節が正本**であり、§7 の推奨と食い違う場合は本節を優先する。

## R1. 既存ライブラリ調査（新規）

`ccusage`（https://ccusage.com）が同じ課題を解いており、次が確認できた。

- Claude Code と Codex CLI の**両方**に対応する（Codex 用は `@ccusage/codex`）
- 価格表は **LiteLLM の `model_prices_and_context_window.json`** を参照する。100以上の provider を
  網羅し GitHub Actions で自動更新される、事実上の標準データ
- 算出モードは `display`（記録済みコスト） / `calculate`（トークン×単価） / `auto`
- 読むトークン項目は `input` / `output` / `cacheCreate(5m,1h)` / `cacheRead` の**4系統**

### 決定: ライブラリは依存として入れず、「単価表」と「算出式」だけ借りる

理由は §R2 の3点により、ccusage の出力をそのまま看板の比較指標に使えないため。
依存を足しても結局こちらで書く部分が残るので、見返りが小さい。

- 単価は LiteLLM の JSON を参照する（自前の単価表を持たない）
- 算出式は ccusage の `calculate` モードに合わせる（**4系統すべてを足す**。ここを落としたのが根因）

## R2. ccusage の値だけでは足りない理由（実測）

1. **集計単位が違う**。ccusage は日/月/モデル/セッション別であり、**看板の task という概念を持たない**
2. **サブエージェントが別ファイルになる**。
   `~/.claude/projects/<enc-cwd>/<sessionId>/subagents/agent-*.jsonl` が本機に **515 件**存在する。
   本タスクのワーカー自身もサブエージェントを3本呼んでいた。
   **1 task のコスト = 親セッション + 配下サブエージェント全部**であり、親だけでは過小評価になる
3. **時刻ベースの相関は保証されない**。実測では S1 の worktree で 4 ログ = 4 run が時刻で一致したが、
   これは「1 worktree に同時 1 run」という運用が守られた結果であって、契約上の不変条件ではない

## R3. 相関は起動時に確定させる（時刻推測をやめる）

両 CLI ともセッション ID を外部から制御できることを確認した。

- Claude: `claude --session-id <uuid>`（`--resume` / `--fork-session` も同系統）
- Codex: `codex exec --json` でイベントを JSONL 出力できる。`resume <id>` があり session id は一級市民

**起動時に run と 1:1 の UUID を渡し、ログのファイル名を run 識別子そのものにする。**
これにより時刻ウィンドウ推測が不要になり、同一 worktree の並行 run でも曖昧さが出ない。

## R4. §7-Q1 の確定: codex の USD は価格表から推定する（ユーザー決定 2026-08-20）

選択肢 b を採用する。ただし**推定を実測と混同させない**ため、§3.2 の `MetricValue` に state を追加する。
provenance ではなく **state** として分けるのは、`switch (state)` の網羅性検査で
既定集計が推定値を暗黙に取り込むことをコンパイラレベルで防ぐためである（§3.2 の設計意図と同じ理由）。

```ts
| { state: "estimated"; value: number; basis: "price-table"; priceTableRef: string }
```

- 対象は codex の**主要モデル**（現行 allowlist の `gpt-5.6-*` 系）。価格表に無いモデルは
  `unavailable-by-design` のままとし、勝手に0や近似値を入れない
- `priceTableRef` に参照した価格表の版（LiteLLM の commit か取得日時）を残し、後から再計算できるようにする
- 既定集計は `measured` のみを合算し、`estimated` は**別列として並べて表示**する。合算しない

## R5. §7-Q2 の確定: 行単位ではなく metric 単位で分ける

§7 の選択肢 b（provider 別）を **metric 単位へ精緻化**して採用する。実測で次が判明したため。

Claude の生ログ実サンプル:

```
"usage":{"input_tokens":2, "cache_creation_input_tokens":1895,
         "cache_read_input_tokens":144970, "output_tokens":7588}
```

DB に記録されていたのは `inputTokens: 2` 相当のみで、**cache read の 144,970 が捨てられていた**。
つまり「claude の 86 行は信頼できる」という前提が metric によって成り立たない。

| 対象 | state |
|---|---|
| codex の旧 816 行（全項目0） | `legacy-unverified` |
| claude 旧行の `costUsd` | `measured`（値が妥当で、費用対効果評価の主目的に直接使える） |
| claude 旧行の `inputTokens` / `outputTokens` | `legacy-unverified`（cache 分の欠落が確定しているため） |
| 失敗 run のゼロ（例: 3,203 秒走って failed した run 626） | `unknown`。`measured` にしない |

## R6. 過去分の遡及再構築（新規・§5 を補う）

ネイティブログが本機に残っている（codex rollout **5,473** ファイル / Claude Code **603** ファイル）ため、
**過去 902 行は捨てずに再構築できる**。

- 遡及分は R3 の exact session id を持たないため、`cwd + 時間窓`で突き合わせる
- 遡及分の provenance は `cli-native-session-log` とし、**別 state `reconstructed`** を与えて
  R3 以降の exact 相関と区別する。曖昧一致（同一 worktree に時間帯が重なる run が複数）は
  再構築せず `legacy-unverified` のまま残す
- 遡及は読み取り専用の再計算であり、ネイティブログを書き換えない

## R7. 実装フェーズの分割

1. **計測**: 起動時 session id 付与、終了時にネイティブログ（サブエージェント込み）を読んで
   `task_runs.meta` へ `RunUsage` を記録する
2. **集計・表示**: task / tenant / model / effort 別のコスト比較を CLI と Web に出す。
   `measured` と `estimated` を混ぜない
3. **遡及再構築**（別ゲート）: 過去分の再計算。1 と 2 が動いてから行う
