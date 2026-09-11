# オーケストレーター reference（作業時参照）

本書は `runbooks/orchestrator-playbook.md`（**core**）の作業時参照である。
core 冒頭の「段階的な読み方」が起動時の入口。本書は**操作直前に該当節だけ引くもの**。

- **§ 番号は両書で一意**。本書へ移した節も元の番号のまま持ち越している
  （コード・スクリプト・knowledge が § 番号で名指ししているため振り直せない）
- どの作業でどれを引くかは **core の「この文書の使い方」の trigger index** にある
- **判断規律は本書に無い。** 規律は「知らないと踏む」ので core にある。本書にあるのは手順だけ

## 0.6 モデルrouting決定表（唯一の運用正本）

ここで定めるのは Hachi が起動する worker/reviewer の運用判断であり、登録済みの
orchestrator session の設定を変更するものではない。task body と `hachi admin resolve` の結果を
照合し、判断できない入力は低いモデルや速い速度へ黙って fallback せず、人間確認へ倒す。
設計権限の階層、分解ゲート、per-task 指定の手順は core §0.5 が正本であり、ここでは再掲しない。

### 0.6.1 複雑度シグナルとスコア

該当するシグナルを各1点として数える（同じシグナル内の要素は重複加点しない）。

| シグナル | 1点と数える条件 |
|---|---|
| `R` | route/history、Back/Forward、lazy/Suspense のいずれかを、別の navigation state と組み合わせて扱う |
| `Q` | cache、previous-data、prefetch、invalidation、error/retry のいずれかを、別の query/state owner と組み合わせて扱う |
| `D` | DOM identity、focus、scroll、keyboard、a11y の副作用を trigger と async phase をまたいで扱う |
| `P` | 永続化、復元、hydration、外部 store の整合性を扱う |
| `W` | write の部分成功、idempotency、並行更新、外部副作用を扱う |
| `M` | 同じ不変条件を独立更新される3個以上の state/UI/channel/tab、または複数 process/service で維持する |

重大シグナルは、認証・認可・tenant分離・secret、migration・データ消失・取り消せない外部操作・
重複送信、runtime resource・lease・cancel・fencing・cleanup、durable concurrencyである。
未確定の設計選択肢はモデル選定前に解消する。`R/Q/D/P/W/M` は分解後の残る複雑さを判定するために使う。

**2026-09-09 ユーザー裁定: 初回選定は次の2段階に限定する。旧Sol/high・Sol/xhighの3段階表を置換する。**
基本はLuna/maxで扱える粒度への分解であり、Astraを使うために大きいtaskを維持しない。

| 初回routing | 分解・仕様凍結後に満たす条件 | speed |
|---|---|---|
| `gpt-5.6-luna/max/standard` | 重大シグナルなし、スコア0〜1、別async ownerとの結合なし。対象・不変条件・反例・focused test・evidenceが一意 | 明示 `standard` |
| `gpt-6-astra/low/standard` | 分解しても重大シグナル、スコア2以上、または別async ownerとの結合が残る。残る複雑さと分解した境界をbodyへ記録する | 明示 `standard` |

「Astra RAW」という表記は今回のユーザー発話末尾の指定に合わせてAstra **low** と読む。
別のeffort値を作らず、CLIでは `--model gpt-6-astra --effort low --speed standard` と指定する。
fast経路をこの初回選定表に追加しない。実配信はlive configとready直前の`admin resolve`で確認する。

**Astra/mediumの例外gate（全条件必須）**

1. 高複雑度であることを、不変条件とstate/async ownerの結合で説明できる。
2. さらに分解できないことを説明できる。分割候補と、分割すると同一不変条件の実装・検証が
   成立しない理由を記録する。ファイル数や納期だけを理由にしない。
3. 同じ課題について`gpt-6-astra/low`で少なくとも1回実装を試し、worker品質に起因する失敗を
   run ID・実model/effort・レビュー指摘または検証結果で確認できる。

3条件を満たした場合だけ、orchestratorが根拠をtaskへ記録して
`gpt-6-astra/medium/standard`を指定できる。**初回からmediumは禁止**。
Luna/Solでの失敗、長時間実行、利用枠・起動障害、環境/evidence不足、仕様不足、後発変更は
Astra/lowの実装失敗の代わりにならない。mediumを常設の第3段階や自動fallbackにしない。

### 0.6.2 レビュアーの指定と worker fail の分類

**レビュアーの指定**

- 実装は独立した`gpt-6-astra/low/standard` reviewerで二審する。workerがAstraでも別runで行う。
- 実装の例外gateを、reviewerの初回medium指定の根拠に流用しない。
- model/effort/transportが利用不能なら暗黙にSol・旧モデル・mediumへfallbackしない。
  `admin resolve`とcapability probeを確認し、その起動を止めて原因を解消する。
- 走行中のrunはこの方針変更だけを理由に中断しない。新規起票と次回worker/reviewer起動から適用し、
  既存taskのoverrideも次回起動前に見直す。既存Sol runの失敗だけではmediumを許可しない。

**worker fail の分類と replacement**

worker品質（不変条件違反・実装/test不足）、spec不足、環境/evidence制約、後発変更を区別する。
worker品質のblocking指摘を含むreview cycleを1回と数え、issue件数では数えない。

| 状況 | 対応 |
|---|---|
| worker品質fail 1回目、局所修正可能 | 現行2段階routingに適合する場合だけ同じroutingの自動reworkを最大1回。分割可能なら先に分割する |
| Lunaの重大failまたは反復fail | specと分解を再点検し、残る複雑さに応じてLuna/maxまたはAstra/lowへ再選定。mediumへ直行しない |
| Astra/lowのworker品質fail | 分解・spec補強を優先。§0.6.1の3条件がすべて成立した場合だけmediumを許可 |
| spec不足 / 環境・evidence / 後発仕様 | 原因を整備して再判定。medium許可の失敗実績へ加算しない |
| Astra/mediumでも失敗 | 追加のモデル引上げや同じbodyの反復ではなく、分解・spec再作成・人間判断へ戻す |

replacementはdurable cancel契約に従い、exact sessionの停止証拠まで同じworktreeへ起動しない。
自動rework枠は**タスク生涯で1回**（`rework_launched`累計、contract §21.1）。
worker変更でも枠は回復せず、mediumの許可と自動reworkの可否は別判定である。

レビュアーはfail verdictに`failureCause`を付ける。現行Supervisorは`worker_local`の1回目だけ
同じroutingを自動reworkし、`worker_major`と2回目の`worker_local`は
`orchestrator_sol_xhigh_replacement`として停止する。この名称は**既存の機械識別子**で、
Sol/xhighを起動する指示ではない。Supervisorはreplacementを起動しないため、orchestratorが
今回の2段階表とmedium例外gateを適用する（機械payloadと上限はcontract §21.1）。
既存の旧routing overrideは次回自動rework/reviewの前に正規CLIで更新する。
`spec_ambiguity` / `environment_evidence` / `late_requirement_change` / `unknown`は同じworkerを
再起動しない。cancel、body補強、execution override、再readyはorchestratorの責務である。

### 0.6.3 Luna worker task-body checklist

core §0.5 の「対象ファイル・使用 API・状態遷移・テスト戦略・禁止事項まで書き切ってから ready」を、
Luna 向けにチェック可能な項目へ展開したもの。1項目でも未確定なら plan/設計へ戻す。

- 対象 file、symbol/component、所有範囲、変更禁止範囲。
- 守る不変条件と、変更しない正常系。
- `trigger × state owner × async phase × navigation/channel` の反例マトリクス。
- 通常入力、空、pending/lazy、error/retry、連打、Back/Forward、復元後の該当ケース。
- focus/scroll/intent があれば、生成・消費・破棄の時点と DOM anchor identity。
- focused test は helper 単体だけでなく、実 trigger から route/cache/DOM までの経路を通す。
- 正確な test、typecheck、lint、design-ratchet コマンド。
- UI 変更なら route/Story、viewport、初期 state、mouse/keyboard、light/dark、console error、画像名。
- 認証後 UI 等で resource が必要なら ready 前に manifest/lease を確保し、未確保なら runtime evidence を別 gate にする。
- 未解決の設計選択肢を残さない。残る場合は Luna へ渡さない。

## 0.7 セッションの長さとトークン効率 — 作業時の手順

> 判断規律（切りどき・立ち上げ・引き継ぎ・自己計測）は core の §0.7 にある。ここは手順だけ。

### 0.7.5 後継セッションの起動（provider 別）

後継プロセスの spawn 機構は provider ごとに異なる。
board 側の世代交代（`handoff-prepare` → `handoff-accept`）は core §0.8 を参照。

#### Claude 経路（tmux）

> **⚠ この経路に入る前に core §0.8 の「argv の罠」と §0.8.1 の生存5点を読むこと。**
> 判断規律は core が正本で、ここには**実行手順だけ**を置く。
>
> **掃除（旧世代の heartbeat / watcher を止める）**
>
> ```bash
> # 1) 候補を列挙する（まだ kill しない）
> ps -eo pid,ppid,etime,command | grep -a 'session heartbeat\|orch-watch/' | grep -av grep
> # 2) argv に `claude --session-id` を含むものを除外する（それはオーケストレーター本体）
> # 3) PID ごとに引数全文を確認してから kill する（-p と -e は併用しない。-e が勝って全件出る）
> ps -ww -o args= -p <pid>
> # 4) watcher は wrapper → 子孫の順（子を先に殺すと wrapper が次の子を起こして孤児が増える）
> ```
>
> **起動後の生存確認（5点。core §0.8.1 が正本）**
>
> ```bash
> tmux has-session -t <tmuxSessionName>
> ps -eww -o args= | grep -a "claude --session-id <successorSessionId>" | grep -av grep
> grep -ac '"type":"assistant"' ~/.claude/projects/<proj>/<successorSessionId>.jsonl   # 2回引いて増加を見る
> hachi orchestrator session resolve --provider-session-id <successorSessionId>        # matches=0 は exit 1
> hachi orchestrator list --json                                                        # liveSession.heartbeatAt の前進
> ```
>
> **後継を失った時は、孤児 heartbeat を殺す前に**
> `hachi orchestrator handover --session <死んだ世代> --generation <n> --apply` を回す。
> 先に殺すと `session-generation-match` preflight が落ちて handover が使えなくなる。
>
> **K1（`t_35ba1bad5d2d91a5`）は統合済み（2026-08-31 / main=16555e5）だが、掃除の手順はまだ要る。**
> K1 は**これから起動する世代の argv だけ**を変えた。pre-K1 に起動された claude 本体は
> 旧形式の argv（`os_*` と `session heartbeat`）を載せたまま生き続ける
> （gen31 時点で 8 本稼働）。**pre-K1 プロセスが全滅するまで core §0.8 の掃除手順を守ること。**
> **新形式の heartbeat が supersede で自己終了することは実測で確定した**（2026-08-31 gen31→gen32。
> 手動 kill なしに約21秒以内で消滅・pidfile も削除。`t_35ba1bad5d2d91a5` #4388）。
> **ただしこれは post-K1（`bootstrap-heartbeat`）の loop に限る。**
> pre-K1 の素の `while true; do ... session heartbeat ...; sleep 30; done` には
> supersede 検知が無いので**自滅せず、手で落とす対象のまま**である
> （2026-08-31 時点で 3 本が ppid=1 の孤児として稼働中だった）。
> 見分けは argv — post-K1 は `bootstrap-heartbeat`、pre-K1 は `session heartbeat` を含む。
>
> **watcher の側は post-K1 でも手が要る**: `hk-gen<N>-inbox.sh` は `matches=0` ×10 で
> self-exit するが、**`hk-gen<N>-terminal.sh` には self-exit 経路が無く、
> sidecar lock を握ったまま残る**。**即時に落とす必要があるのはこの terminal watcher
> （とその `task await` の子）だけ**で、inbox watcher は放置しても 5 分で消える。


##### HHN シム（Claude 候補の解決と選択）

repo の実体は `scripts/hachi-handover-now`。`~/.local/bin/hachi-handover-now` と
`~/.local/bin/hhn` は host が置く `exec` シムであり、worker は設置しない。設置手順は
core §0.7.2.1 の host コマンドを使う。シムは自前で board の identity/session/watch を走査せず、
`hachi orchestrator handover --json` の `resolution` と `provider-launchable` preflight だけを読む。

Claude/tmux 経路では `--apply` が既定で、`-n` または `--dry-run` で dry-run にする。
Codex セッションから HHN を使うと `provider-launchable` preflight が dry-run から非0になり、
下記 Codex Desktop 経路を案内する。`--orchestrator` と `--mission` は
handover CLI へ素通しする。`resolved` は通常どおり実行し、apply 成功後は tmux の外なら
`attach`、中なら `switch-client` の接続コマンドを表示する。

`ambiguous` は、非TTYまたは `--no-input` なら `resolution.candidates[].command` を全文そのまま出して
非0終了する。TTY では番号選択を受け付け、選択した候補の引数で実行する。EOF・Ctrl-C・不正入力・
タイムアウト時は実行せず、同じ候補 command 一覧を出して非0終了する。`none` は候補の
`takeover` command を出して非0終了し、対話しない。

##### `hachi orchestrator handover` CLI

`hachi orchestrator handover` CLI が起動プロンプト・tmux コマンドを生成する。起動方式は
**tmux new-session の argv に起動プロンプトを直接載せる**（2026-08-21 実機検証:
claude 2.1.228 / tmux 3.6a / macOS）。`claude [options] [prompt]` の位置引数プロンプトは対話モードの
まま第1ターンとして自動送信されることが判明したため、旧来の paste-buffer 経由の貼り付け・pane
readiness 確認・`send-keys` 経路は不要になった。

```bash
# dry-run: 起動プロンプト・tmux コマンド・handoff token プレビュー値を得る（DB へは保存されない）
hachi orchestrator handover --session <id> --generation <n> --mission <task-id> --json

# 実行
hachi orchestrator handover --session <id> --generation <n> --mission <task-id> --apply
```

dry-run 出力に含まれるもの:

- `successorSessionId`（採番済み UUID）— `startupPrompt` と `tmuxCommandLine` の両方に同じ値で現れる
- `startupPrompt`（ミッション task ID・旧 session id・provider session id・handoff token 実 hex 値・launch nonce・
  「playbook §0.7.4 に従って立ち上げよ」の 1 行。会話履歴は含めない。この文字列がそのまま tmux argv の
  末尾要素として載る）
  - **dry-run 時に埋め込まれる token はプレビュー値であり DB には保存されていない**。
    dry-run 出力の `startupPrompt` をそのまま Codex `create_thread` 等に貼り付けると
    後継の `handoff-accept` が silent に失敗する。実運用では必ず `--apply` を使う
    （下記 Codex Desktop 経路を除き、`--apply` が採番した token を DB に保存し同じ値を argv に載せる）
- `tmuxCommandLine`（表示用。
  `tmux new-session -d -s <name> -c <cwd> claude --session-id <uuid> -- "<startupPrompt>"`。
  `--` は必ず挟む。`--add-dir` 等の variadic option が後から追加されると位置引数プロンプトを
  食ってしまう既知の危険があるため）
- `tmuxArgs`（**実行用の argv 配列**。dry-run と `--apply` の実 argv は末尾要素も含めて完全一致する）
- `tmuxCommandBytes` / `tmuxCommandMaxBytes`（executable と argv 全体の UTF-8 byte 実測値 / 上限）
- `preflight` / `blocked` / `blockReasons` / `missionState` / `handoffPreparePreview`

**実行するときは `tmuxArgs` を `execFile` へ渡す。`tmuxCommandLine` を shell へ渡してはならない。**
cwd は task body 由来の任意文字列で、`;` や backtick が通る（`parseCwdFromBody` は空白のみ弾く）。
表示用は POSIX quoting 済みだが、shell 経由の実行を前提にしない。

正常入力の事前検査（`preflight`）は tmux の有無・セッション名衝突・ミッション妥当性・generation 一致・
cwd が絶対パスの実在 directory か・Claude trust 承諾済みか・ミッション task が当該 orchestrator の
担当範囲か・tmux argv 全体が15,000 bytes以下か・旧 session provider が `claude` か、の9項目。
最後の `provider-launchable` は `codex` と不明値を fail-closed に止める。1つでも不可なら
`blocked: true` になる。
trust dialog は自動応答しないため、`cwd-trusted` が失敗したら当該 cwd で Claude を手動起動して承諾する。

`--apply` は起動確認後、transcript の nonce 一致 user 行と後続 assistant 行が揃って初めて
`delivery.status=confirmed` を返す。timeout 等は `unknown` であり同じ token を再送しない。
補償で active へ戻った後の再実行だけが新 token を発行する。停止未確認等で `handoff_pending` が残った場合の
exact-session 停止確認と `session handoff-cancel` 手順は core §0.8 を参照する。

後継は次を実行して世代交代を完了する（`--token` と `--provider` も必須）。

```bash
hachi orchestrator session handoff-accept <oldSessionId> \
  --token <token> --provider claude --provider-session-id <successorSessionId> --json
```

##### 起動したら接続コマンドをユーザーへ必ず渡す（聞かれる前に）

`--apply` は後継を **detached**（`new-session -d`）で起こす。ユーザーの端末は旧セッションに
繋がったままで、**自動では移動しない**。黙って引き継ぎを終えると、ユーザーは動いている後継に
話しかける方法が分からないまま取り残される。したがって引き継ぎ報告には、
`--apply` の戻り値 `tmuxSessionName` を埋めた接続コマンドを**必ず一緒に載せる**。

```bash
# ユーザーが tmux の外に居る場合
tmux attach -t <tmuxSessionName>

# ユーザーが既に tmux の中に居る場合（旧セッションに attach 中はこちら。attach を入れ子にしない）
tmux switch-client -t <tmuxSessionName>
```

- どちらを使うかはユーザーの現在地で決まる。`tmux ls` の `(attached)` が付いている行が現在地で、
  旧セッション（`hachi-orch-<orchestrator>-<旧 claude session id 先頭8桁>`）に付いていれば
  `switch-client` を案内する
- 旧セッションから離れるだけなら prefix + d（detach）。旧セッションは `SESSION_SUPERSEDED` で
  board を変更できないので、残しておいても実害はないが、用が済んだら
  `tmux kill-session -t <旧セッション名>` で畳んでよい
- 後継が `handoff-accept` を完了したこと（board の generation が +1 され status=active になること）を
  確認してから案内する。宙吊りの `handoff_pending` を掴ませない

#### Codex successor attestation 経路

commit `7c22bc7` は、Hachi が durable slot と exact tmux runtime を先に固定し、Codex の root
`SessionStart` hook が返した provider-generated session ID と短命 handle だけで世代交代するための
offline 実装を持つ。ただし、**現行 `7c22bc7` と host の Gate 4B publication は BLOCKED** である。
live config は `orchestrator.codexSuccessorAttestation.mode=manual` のまま維持し、後述の publication
prerequisite がすべて実装・レビュー済みになるまで、host への publish、canary、`enforce` への変更を
行わない。offline 実装・test 完了は live readiness ではなく、publication/canary の承認にも代わらない。
BLOCKED または rollback 中は、後述の manual `create_thread` を正式 fallback とする。

##### review 対象の repo artifact

- hook template: `packages/cli/artifacts/codex-successor-session-start-hook.json`
- manifest template: `packages/cli/artifacts/codex-successor-attestation-manifest.example.json`
- 実装の正本: `packages/cli/src/successor-attestation-artifacts.ts`

hook group の exact definition は次である。`async` は置かず、同期 command として実行する。

| field | exact value |
|---|---|
| `matcher` | `startup\|resume\|clear\|compact` |
| `type` | `command` |
| `command` | `hachi orchestrator successor-launch attest` |
| `timeout` | `10` |
| `additionalContextLimit` | `1024` |

`startup|resume` で新しい authority が一意に成立したときだけ、helper は stdout へ次の JSON 1 行と
末尾 newline を返す。`<handle>` は owner-only capability であり、task comment、artifact、通常 log、
通常の CLI JSON envelope へ転記しない。`compact|clear` と consume 済み `resume` の正常 no-op は
stdout が空である。

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Hachi successor attestation handle: <handle>"}}
```

##### Gate 4B publication prerequisite（現時点は BLOCKED）

static artifact の schema/path/mode 契約は次のとおりである。これは将来の repo-owned publication helper が
満たす出力契約であり、operator が手作業で host file を作る手順ではない。

- manifest の install 先は、コード定数 `CODEX_SUCCESSOR_ATTESTATION_MANIFEST_RELATIVE_PATH` が固定する
  `$HACHI_KANBAN_HOME/state/codex-successor-attestation-manifest.json` だけである。manifest が無い状態で
  `CODEX_HOME`、hooks、helper の path を推測して埋めない
- `codexHome` は非空の `CODEX_HOME` があればその canonical absolute directory、無ければ OS home の
  `.codex`。`installedHooksPath` は exact `<codexHome>/hooks.json` である。symlink、dot segment、
  realpath と不一致な path は使わない
- `helperExecutablePath` は exact runtime の PATH を先頭から走査して選ぶ最初の executable regular file
  `hachi` の canonical absolute path である。resolver は空・相対・symlink・dot segment の PATH entry と
  helper symlink を拒否する
- manifest は unknown field を許さず、`schemaVersion="codex-successor-attestation-publication.v1"`、
  `codexHome`、`installedHooksPath`、`helperExecutablePath`、`expectedHookDefinitionHash`、
  `expectedHelperExecutableHash` の6 fieldだけを持つ
- manifest mode は exact `0600`。installed hooks は owner-read 必須、special bits / owner-execute /
  group-write/group-execute / other-write/other-execute 禁止（通常 `0644`）。helper は owner-read と
  owner-execute必須、special bits / group-write / other-write 禁止かつ current user から executable
  （通常 `0755`）。現行 resolver は uid/gid を照合しないため、doctor OK は file owner の証明ではない

`7c22bc7` の canonical hook definition hash は
`e163d38108e953c81a4be78a7d6be1293ded73cd7d9d8d26ae0703c15634fe55` である。次の再計算は review 対象
checkout と実装の **offline 照合だけ**に使う。固定 commit/hash や、その checkout での再計算結果を live
readiness、host publication、trust、canary 許可の証拠にしてはならない。

```bash
pnpm exec tsx -e 'import { expectedCodexSuccessorHookDefinitionHash } from "./packages/cli/src/successor-attestation-artifacts.ts"; process.stdout.write(expectedCodexSuccessorHookDefinitionHash() + "\n");'
```

現行 resolver の helper hash は PATH で選んだ `hachi` entrypoint file の bytes しか覆わない。その file が
delegating shim の場合、実際に実行される委譲先 `bin/hachi`、`tsx`、CLI main、import された source/dependency
まで hash authority に含まれない。このため static helper authority は成立していない。次のいずれかが
実装・レビューされるまで publish/canary/enforce を禁止する。

- review 済み bytes だけで自己完結し、immutable に配備できる helper
- execution chain 全体を解決して hash/readback する resolver と、その authority を定めた contract 更新

現行 resolver の exact group 重複検査は、manifest の `installedHooksPath` が指す **1つの
`hooks.json` 内だけ**である。Codex が合成して読む user、project、inline、plugin の全 active layer に同じ
Hachi attest command が無いことは証明しない。successor-launch start が実際に起動する exact runtime の
`/hooks` で全 active layer と trust 状態を列挙し、Hachi 側がその合計に Hachi attest command が exactly one
であることを機械検証できる仕組みと手順が実装・レビューされるまで canary を禁止する。human の `/hooks`
目視は補助的な承認 checkpoint であり、再起動後も維持される永続的な `enforce` 証明ではない。

trust の対象は「Codex Desktop 一般」ではない。successor-launch start が実際に起動する exact `codex`
binary、`CODEX_HOME`、PATH、runtime と、その runtime が表示する `/hooks` である。Desktop での承認状態が
その exact runtime と共有されることの readback/証明が無い限り、Desktop の trust や再起動を代替証拠に
してはならない。

backup、JSON-aware merge、publish、readback、restore は repo-owned host publication helper の責務とする。
helper は少なくとも same-directory temp、file と親 directory の fsync、atomic rename、mode/owner の保持・
検証、backup hash、publish 後 readback、dry-run/apply 分離、exact backup への rollback を持ち、既存の全
hook entry を保持して Hachi group を1つだけ mergeしなければならない。この helper が実装・レビューされる
まで host write を禁止する。手書き backup/merge/publish/restore、template 全体での上書き、半端な artifact
組の復元を実行可能な代替手順にしてはならない。

##### staged doctor と canary（prerequisite 完了後の将来手順）

**現行 `7c22bc7`/host では以下を実行しない。** 上記の helper authority、全 active hook layer の exactly-one
検証、exact successor runtime の trust readback、repo-owned atomic publication/rollback helper がすべて
実装・レビュー済みとなり、その helper で publication を完了した後も、最初は mode=`manual` のまま次を
実行する。

```bash
hachi doctor --offline
hachi doctor
```

両方の出力で exact check が
`[OK] codex successor attestation: mode=manual static hook/helper exact一致` になることを確認する。
manifest 未配備時の
`mode=manual publication manifest未配備; manual create_thread fallback（readiness証明ではありません）`
も overall OK だが、publication readiness ではない。static exact一致も delegating execution chain、全 active
hook layer、runtime trust の証明を別途満たさない限り readiness ではない。別 doctor check の NG も無視しない。

人間が source session/generation と canonical cwd を再確認し、**同時に1件だけ**実世代交代 canary を起動する。
この `start` 自体が mutation であり `--apply` は無い。caller supplied provider session ID や handle は渡さない。

```bash
hachi orchestrator successor-launch start \
  --kind handoff \
  --source-session <active-old-session-id> \
  --generation <active-generation> \
  --cwd <canonical-absolute-cwd> \
  --json

hachi orchestrator session status --orchestrator <orchestrator-id> --json
```

`start` が `status="succeeded"`、`successorSessionId`、`successorGeneration=<old+1>` を返し、status JSON の
新しい row が `status="active"`、`provider="codex"`、
`providerSessionSource="codex-session-start"` であることを確認する。旧 row は `superseded` であり、成功した
successor runtime は新しい active generation なので cleanup 名目で停止しない。失敗時の exact cleanup は、
start の error が示す exact `slot` の terminal status が `stopped|rejected|expired` であることまで確認する。
`uncertain` は cleanup 完了ではなく replacement blocking である。

manual canary 成功、全 prerequisite の再readback、人間承認後だけ live config の既存 `orchestrator` objectを保持して
`codexSuccessorAttestation.mode` を `enforce` に変更する。変更後に両 doctor の exact check が
`mode=enforce static hook/helper exact一致` であることを確認し、同じ手順で同時に1件だけ enforce canary を
行う。manual/enforce の各段で1件を完了させるまで、次の launch を並行させない。

##### rollback（prerequisite 完了後の将来 gate）

将来の enforce または canary が失敗したら、host authority がまず mode=`manual` へ戻し、新規
`successor-launch start` を止める。失敗した start が `stopped|rejected|expired` を返していれば、その exact
attempt の自動補償は terminal である。`uncertain` は cleanup 完了ではなく replacement blocking である。

raw stop fence は owner-only capability だが、`7c22bc7` には通常 operator が安全に取得・受渡しできる CLI
がない。このため通常 operator 向けの `rollback-complete` 実行手順は提供しない。owner capability の安全な
受渡しが実装・レビューされるまで、`uncertain` の manual rollback-complete は実行不能である。generic kill、
tmux 名の prefix/glob 探索、別 session stop、bridge/Codex の一括 kill、fence の hash/別 attempt からの復元、
DB 生 SQL、推測による停止完了へ倒さず、exact slot を blocking のまま維持して human へ escalation する。

artifact rollback は、上記 repo-owned host publication helper が記録した exact backup/hash と
dry-run/apply gate を使い、hooks/helper/manifest の整合した組だけを atomic に復元する。手書き restore や
half-published な組の組立てはしない。helper の rollback readback と exact runtime の全 layer `/hooks` 検証が
成功した後にだけ両 doctor を再実行する。manual fallback check が overall OK でも readiness ではなく、
`uncertain`、artifact rollback、trust readback のいずれかが未完了なら replacement blocking を解除しない。

##### manual fallback（Codex Desktop `create_thread`）

`create_thread` は `codex_app` ツール名前空間の**ツールであり CLI コマンドではない**。
hachi CLI からは起動できず、**オーケストレーター自身がツール呼び出しで実行する**。

手順（Codex 経路は `--apply` を使わない。tmux ではなく `create_thread` で後継を作るため、
DB への token 保存だけは別途 `handoff-prepare` で行う必要がある）:

1. `hachi orchestrator handover --session <id> --generation <n> --mission <task-id> --json` を
   dry-run で実行し、`startupPrompt` の骨組み（ミッション ID・旧 session id・provider session id
   の埋め込み済み文字列）を得る。**dry-run が返す `startupPrompt` の `handoff token: <hex>` 行に
   埋め込まれている hex 値はプレビュー値であり DB には保存されていない**。この値をそのまま
   後継へ渡すと handoff-accept が確実に失敗するので、必ず次の 2〜3 で差し替える
2. `hachi orchestrator session handoff-prepare <oldSessionId> --generation <n> --json` を実行し、
   実際に DB へ保存される token を取得する（core §0.8 参照）
3. dry-run の `startupPrompt` 内の `handoff token: <プレビュー値>` 行**まるごと**を
   `handoff token: <2 で取得した実 token>` に差し替える（プレビュー値は絶対にそのまま使わない）
4. `create_thread` を呼ぶ:
   - `prompt`: 差し替え済みの起動プロンプト
   - `target`: `{type: "project", environment: {type: "worktree"}}`
   - `title`: 任意（ミッション名など）
5. 後継スレッドが `handoff-accept <oldSessionId> --token <token> --provider codex
   --provider-session-id <後継自身の rollout session uuid>` を実行して世代交代が完了する。

   **起動プロンプトに埋まっている `provider session id:` の値は使わない。** あの行は Claude の
   `--session-id` 用に事前採番した UUID であり（`runHandover`）、codex には `--session-id` 相当が
   無いので rollout 名には現れない。**codex 経路では手順3の token 差し替えに加えて
   `provider session id:` 行も落とすか、意味が無い旨を明記して渡すこと。**

   渡すべきなのは codex の usage 収集が引く uuid である。収集は
   `~/.codex/sessions/**/rollout-<ts>-<uuid>.jsonl` を uuid の**完全一致**で探す
   （`packages/adapters/src/native-usage.ts`）。

   > **⚠ この ID 特定警告は manual fallback にだけ残る（2026-08-24 gen57）。** `7c22bc7` の
   > attestation 実装は SessionStart の `session_id` を exact slotへ bindするため、この探索を authority に
   > しない。ただし Gate 4B publication は上記 prerequisite 完了まで BLOCKED である。manual fallback の
   > 現行 runtime では
   > `CODEX_THREAD_ID` と rollout ファイル名の uuid と `session_meta.payload.id/session_id` が
   > 一致して見えるが、App Server は `thread.id` と `thread.sessionId` を別物として持つため、
   > 「どれを渡せば必ず当たるか」は実機で確かめていない。**同時に複数 codex セッションが
   > 走っている状況では、別会話の rollout を掴んでも `usage` は成功に見える**（ファイル名一致
   > だけを見ているため）。特定手順の確定は `t_0898fd0005b3eb56` が持つ。

   accept 後、**旧セッションを閉じる前に** `hachi orchestrator usage --session <新 session> --json`
   を実行し、`measurement` が非 null で `log-not-found` が出ていないことを確認する
   （`--json` の成功時に `reason` フィールドは出ない。`null` が入るのではなく欠落する。
   `--check` は理由を stderr に出すが `--json` は stdout に返す）。誤った id を渡すと
   `log-not-found` になり、`--check` は exit 0 の fail-open で通ってしまう（§0.7.3.1 と同じ穴）

#### 使ってはいけないもの

| 手段 | 理由 |
|---|---|
| `claude --fork-session` | 文脈を複写するためトークン削減の目的に逆行する |
| `claude --cloud` | ローカルの未コミット状態が見えない（GitHub remote を clone する） |
| `codex remote-control` | start/stop/pair のみでスレッド作成には使えない |

#### 未確定事項

- `create_thread` が Codex Desktop 限定かどうか（`codex-tui` / `codex_exec` 由来セッションでは未確認）
- `create_thread` の `model` / `thinking` 引数は実運用で通るが、取得済み inputSchema には定義されていない

## 1. 標準サイクル — 作業時の手順

> 監視（§1.3）と終端対応の分岐表（§1.4）は core にある。ここは起票・worktree・統合・記録の手順。

### 1.1 起票
- planner テンプレ準拠: `cwd:` 行必須 / `## 目的`（契約 § 参照 + 「必ず読むこと」）/ Scope / 禁止事項 /
  完了条件に **「handoff は必ず outcome=review（done 直行禁止）」**
- 検証分担をする実装taskは、bodyに独立行`verify: <対象テストと型検査の実行コマンド>`を入れ、
  全体gateの担当taskまたはhostを明記する（core §0.5、契約§39.1）。「focusedのみ」と本文へ書くだけでは
  tenant既定verifyを上書きできない。ready前に実行コマンドと所有範囲の対応を確認する。
- UI タスク: §37.6 準拠明記 + §32 スクショ定型 + 「実ブラウザ実測を summary に記載」
- **`handoff-policy` は既定が `no-commit` になった（2026-08-23・契約 §43。実装 `228c4c4`）。**
  worker に commit させないタスクは**宣言不要**。宣言するのは commit まで worker に委ねる例外的な
  タスクだけで、その場合に `handoff-policy: commit` と明示する（dirty tree が fail-closed になる）。
  `no-commit` / `commit` 以外の値、および壊れた宣言は `invalid` として検証失敗になるので、
  書くなら正確に書く。成果物が cwd 外なら `evidence-dir: <絶対パス>` を宣言する（既定反転の影響を受けない）。
  非コード・docs-onlyタスクは加えて `verify: none` を宣言する
- 大型タスクは分解する（**1 worker ≒ 30 turns 目安**。max-turns 50 到達は分解不足のシグナル）

#### 1.1.1 ready 直前の検査（core §0.5.1 の実行手順。全項目 yes でなければ ready にしない）

**粒度（数える。見込まない）**

- [ ] **主関心事（independently reviewable outcome）が 1 つ**か。
      ファイル数ではなく「レビュー時に 1 つの成否として判定できる成果」で数える。
      **その focused test と付随ファイル（型・barrel export 等）は同じタスクに含めてよい**
      （§0.5「局所実装 + focused tests」と整合させる。source + test = 2 ファイルは分割理由にならない）
- [ ] 「実装」と「検証手段の構築」（Storybook・fixture・seed の新規構築）が**同居していない**か
- [ ] evidence の範囲が**実装した箇所の bounded な確認に収まっている**か。
      §1.1 のとおり **UI タスクは実ブラウザ実測を summary に書くのが必須**なので、
      自分が変えた画面を確認して撮ることは同居してよい。**分けるのは
      full / integration 検証・全 repo 検証・React Doctor・広域の証跡取得**（§0.5 の phase 分割）
- [ ] **解決済みの実行時上限内で終わる量か**（下の「実行時上限」を参照。7200s は既定値であって固定値ではない）

**完了条件（やめる条件が書けているか）**

- [ ] 「どうなったら終わりか」が書いてあるか。evidence の列挙だけで終わっていないか
- [ ] 「正本と突き合わせる」系の指示に、**扱いか回数の固定**があるか
      （例:「差分は直さず handoff に列挙する」「1 巡だけ」）
- [ ] 末尾に **「上の 1〜N だけで終える。それ以外の実装・修正・リファクタ・テスト追加をしない」**
      に相当する一文があるか
- [ ] handoff は `outcome=review`（done 直行禁止）と明記してあるか

**環境（worker が evidence を取れる状態か）**

- [ ] §1.1.3の検証表をbodyへ記入し、担当・コマンド・resource・verify・禁止事項が一致しているか

- [ ] worktree に**対象 repo が定める依存インストール**を済ませたか
      （コマンドは対象 repo の `AGENTS.md` / lockfile が正本。tenant-a は独自の install ラッパー、
      hachi-kanban は §1.2 のとおり `pnpm install --frozen-lockfile`）
- [ ] 画面 evidence を求めるなら、**env / DB / seed / preview 経路まで用意**したか
      （tenant-a では対象 repo の setup スクリプト（例 `pnpm run setup` → dev bootstrap → preview）を順に流す。
      用意せずに ready にすると worker が真っ白な SPA を見て誤診する）
- [ ] `hachi admin resolve <task-id> --role all --json` で worker / reviewer の設定解決値と互換性probeを確認したか。
      transportは起動前候補であり、実行中の操作では対象run meta/launched eventのtransportを照合する
- [ ] **実行時上限**: 解決された transport と live config（`resourceGuard.maxRunSeconds` 等、
      direct は provider 固有の上限）を確認したか。**7200s は bridge の既定値**であり、
      設定次第でこれより短い。「2 時間で終わる」を上限確認なしの根拠にしない

**走行後の縮退（起票時に決めておく）**

- [ ] evidence が取れない場合の縮退先を body に書いたか。
      「無言で縮小せず worker-question で上げる」と明記したか

#### 1.1.3 検証の受渡し表（起票時に記入し、ready直前に再照合）

対象repoのAGENTS、package scripts、commit/CI hookから、変更箇所に効く既知の条件を拾う。
検査を後段へ分けても、その検査が課す実装条件は最初のbodyへ含める。
tenant-aでは対象checkout側の検証runbook（例 `docs/runbooks/<tenant>-task-verification.md`）を使う。新規worktreeに文書が
未反映なら運用正本checkoutの同文書を参照し、コマンドは必ず対象BASEのsourceと照合する。

bodyに次の表を入れる。これは運用上の受入表であり、新しいCLI構文や自動判定schemaではない。

| 検証項目・対象 | 実行コマンド（cwd込み） | 実行担当 | 環境の証拠 | 合格条件・記録先 |
|---|---|---|---|---|
| 局所検証 | 実際のコマンド | worker/task ID | 不要、または割当証拠 | 期待結果・handoff |
| DB/UI実行検証 | 実際のコマンド | worker/task IDまたはhost identity | lease/manifest、接続・起動確認 | 期待結果・担当task comment |
| 全体gate | repo正本のコマンド | host identityまたは検証task ID | 対象BASE・統合候補 | 全gate結果・host受入記録 |

- 「host」「後で検証」だけで終えず、担当identity/task IDとコマンド・受渡し条件を確定する。
  不要な行は理由付きで省略できる。秘密値・接続文字列を表へ貼らない。
- worker担当の全行が実行可能であることをready前に確認する。DB/previewは§1.2.1の正式な割当と
  worker promptへの配送を確認し、task bodyや既存.envだけを割当証拠にしない。
- resource未確保なら、readyを保留するか、実行可能な局所作業とhost所有の検証へ分ける。
  後者ではworkerの `verify:` と完了条件から未割当の検証を外し、host側で実行環境の存在も確認する。
  全体受入から検証を消さない。shared DBへのfallback、偽manifest、環境不足をモデル失敗扱いすることは禁止。
- 上の表と独立行 `verify:`、禁止事項、review範囲を突合する。例えばReact Doctor禁止のworkerへ
  同検査の実行を要求しない。具体的な実装条件はbodyへ渡し、実行は指定した検証担当へ渡す。
- reviewerは担当外の未実行検証をpassの証拠に数えず、hostは全行の結果と対象差分を照合して受入する。
  既知条件の漏れで後段修復になった場合は、この表とrepoの検証案内を修正してから次を起票する。

#### 1.1.4 CLI構文の確認と失敗後の再利用

CLI構文は稼働checkoutの `hachi <command> --help` とsourceを正本にする。まず該当階層だけのhelpを読む。
unknown command/optionが出たら、同じargvの再試行をやめ、訂正した構文と確認したCLI revisionを
担当taskコメントに1行記録する。バージョン更新時は必要な構文だけ再確認する。

| 目的 | 確認済み入口（2026-09-09） |
|---|---|
| identityの発見 | `hachi orchestrator list --json` をローカルで必要なidentityだけ投影 |
| 自分のsession/generation | `hachi orchestrator session resolve --provider-session-id <provider-id>`（このコマンドに `--json` は付けない） |
| worker questionへ回答 | `hachi orchestrator answer --help`。request kindと現行claimを照合 |
| stall警告の分類 | `hachi orchestrator resolve --help`。run_stalled / run_stall_suspected専用 |

`orchestrator show` は存在しない。構文の再利用とlive状態の確認を混同しない。
identity/session/generation、request kind/claim、resource fenceはmutation直前に取り直す。
JSONはモデルへ返す前に必要なfieldへ投影する。ヘルプを読んだことをready gate通過の代用にしない。

#### 1.1.2 複数行 body の安全な入力

- `task create --body` へ **`JSON.stringify(body)` の結果をそのまま渡さない**。外側の引用符付き文字列も
  literal `\n` を含む文字列も、CLI が起動前に `code=literal-newline-escape` で拒否する
- literal `\n` / `\r\n` は**自動展開されない**。CLI は unescape せず fail-fast で落とす
  （黙って展開すると `cwd:` 行が独立行にならず、supervisor が「cwd 未指定」の user-decision へ誤送する）
- 新規起票の複数行 body は heredoc でファイル化してから渡す:

  ```sh
  cat > /path/to/scratch/body.md <<'EOF'
  cwd: /path/to/worktree
  ## 目的
  ...
  EOF
  hachi task create --title "..." --tenant "..." --body "$(cat /path/to/scratch/body.md)"
  ```

- 既存 task の本文置換は `hachi task edit-body <id> --file <path>`（stdin 不可、`--file` 必須）
- **意図的な backslash は unescape しない**。`## 目的: literal \n 表記` のように空白で挟んだ表記、
  inline code 内の `` `\n` ``、`C:\new\name` のような Windows path はそのまま受理される

### 1.2 worktree
- **必ず `~/.hachi-kanban/worktrees/<name>`**（/tmp・/private/tmp は再起動で全消去。2026-07-07 に5本喪失の実害）
- `git worktree add -b <branch> ~/.hachi-kanban/worktrees/<name> HEAD` → **`pnpm install --frozen-lockfile` 必須**（**ready にする前に済ませる**。忘れると未変更コードの型エラーが数十件出て、worker が自分の変更由来と誤診する）
- 契約/型に触れる場合は orchestrator が worktree ブランチへ**先行コミット**してから起票

#### 1.2.1 Runtime resource（contract §56）

- worker promptへ渡るresource割当は、DBのready requirementに紐づくactive leaseのID/kind/fenceが正本。
  task/run未紐付け、別realpath worktree、stale run bind、legacy/quarantined leaseを割当として扱わない
- 専用DBやpreview起動に失敗しても、workerへshared main DB（`localhost:5432`等）へのenv fallbackを指示しない。
  共有DBが必要なら期限・監査・隔離を持つ`shared_main_db_exception`を人間承認で発行する
- workerへDocker prune/down/deleteやlease cleanupを依頼しない。address pool・port・DB残骸はcleanup requestとして
  記録し、host supervisorのfenced cleanup stageが未実装/無効なら削除せずblock・escalateする

#### 1.2.2 Runtime resource の観測・cleanup 判断

- Web の supervisor パネルにある `resource health` は読み取り専用の観測面。lease/member/controller/fence、
  cleanup request と保存済み eligibility evidence を確認できるが、`autoEligible=false` は削除許可ではない
- CLI の初手は `hachi resource list --inventory --json` と `hachi resource doctor --json`。個別確認は
  `hachi resource show <leaseId> --events <n> --json` を使い、名前や空network件数だけで所有権を推測しない
- release希望は `hachi resource request-release <leaseId> --fence <n> --reason "..."` でdry-run確認後、
  必要時だけ `--confirm` してdurable requestを作る。Docker delete/pruneを直接実行しない
- cleanup claim/approve/reject/release は担当identityのactive session/generationとexpected fenceを再照合する。
  claim tokenは `$HACHI_KANBAN_HOME/runtime-secrets/<leaseId>/` 配下の0600通常ファイルだけで受け渡し、
  stdout・argv・boardコメントへ平文を出さない
- expiry超過はWebでstale表示する。heartbeat許容間隔を保存済みread modelから証明できない場合は
  `heartbeat_deadline_unknown` とし、超過を断定しない

### 1.5 統合チェックリスト（host-finalize）
担当分担はcore §0.1を必須とする。workerのhandoffと独立review結果を引き継ぎ、親はbranch/SHA・
所有ファイル・gate結果を照合して統合操作を行う。以下の検証が同一候補ですでに成功していれば、
既存証跡を使い再実行しない。未実施検証・競合解消・失敗調査は担当へ戻す。必須hookは省略しない。
このチェックリストを、親がraw diff/ソースを再調査する根拠にしない。

PRのpublication gateは次のとおり:

- オーケストレーターが作成・更新するPRは、タイトル・概要・変更点・検証・注意事項を日本語で記載する。
  コード識別子・コマンドは原文のまま記載してよい。
- UIの追加・変更・挙動変更を含むPRは、承認済みの実画面キャプチャをPR本文へ添付し、GitHub上で表示される
  ことまで検証する。画面キャプチャ作成ゲートとGitHub添付ゲートは別に扱い、画像がないままready/mergeへ
  進めない。
- Storybook等の合成fixtureによるUIキャプチャは、白塗り・ぼかし・黒塗りなどの画像加工でマスキングしない。
  秘密・顧客・個人・実データが混入した場合は、画像を加工して隠すのではなく、合成fixtureへ置換して再撮影する。
  マスキング済み証跡はPRへ添付せず、添付前にfixtureが合成であることを確認する。
- このタスクが自分で開いたChrome/Codex内ブラウザのタブは、アップロード・描画検証・ユーザー確認が完了したら閉じる。
  明示的に残す依頼がある場合、または現在ユーザー確認待ちの画面だけ残す。既存のユーザー/無関係タブは閉じない。
- UI変更がない場合も、PR本文に「UI変更なし」と明記する。

1. worktree で: 競合マーカー0 → `pnpm -r typecheck` / `pnpm -r --workspace-concurrency 1 test` /
   `pnpm run lint` / `pnpm --filter @hachi/web run build`
2. worker のスクショ（ui-*.png）は **attach してから削除**（.gitignore 済みだが commit 巻き込みに注意）
3. commit → main が先行していれば **branch 側で `git merge main`** → 競合解消（keep-both が基本）→ 再検証
4. main で `git merge --ff-only <branch>`（ff 不可なら止まって理由を確認。**強行しない**）
5. lockfile 変化時は main で `pnpm install --frozen-lockfile`。web 変更は build 必須（古い dist は /api 404 の実績）
6. デプロイ: 該当分だけ `launchctl kickstart -k gui/$UID/com.hachi-kanban.{supervisor,web}`
7. 実機スモーク: API 応答 + （UI なら）playwright スクショ判定（402px/1440px・light/dark・コンソール0）
8. スクショを task/epic に attach（外出先確認 = §32.4）
9. クローズコメント: 検証実測値（テスト数）・merge hash・実機確認内容・（該当時）verify evidence
10. worktree remove。**ブランチは push 完了まで温存**
11. **await 再アーム**（統合の最終手順。忘れると監視が空く — 2026-07-08 に2度実害）。
    **`hachi task await --all --follow-new --json --cursor-file <board>-<責務>.json` を background へ（例 `dev-orchestrator-main.json`。**世代・セッション名を入れない**。契約 §50.1.1）。
    走行レーンが無くても張る** —
    `--follow-new` は初期集合が空でも待機を継続し、あとから ready 化したタスクを拾うため、
    「監視対象なし」で終えると次に起票した瞬間から穴になる（2026-08-29 に `--follow-new` 追加）

#### depends-on の解放条件は「done」であって「統合済み」ではない（2026-08-20 実害）

`depends-on` の依存充足判定は前提タスクの status が `done` または `archived` になった時点で成立する
（`isDependencyFulfilled`）。**host-finalize してコミットするまで、後続 worker の worktree には
前提タスクの成果が1行も入っていない。**

2026-08-20、Core タスクが done になった瞬間に後続の Supervisor タスクが自動起動し、
まだコミットしていない Core API を参照できない状態で着手した。後続 worker が前提 worktree から
成果を前方コピーして自力復旧したため実害は出なかったが、偶然に頼った回復である
（同時に、Core が interface 宣言を落としていた欠陥もこの経路で初めて露見した。reviewer は見逃していた）。

規則:

- **実装が連鎖する depends-on では、前提の host-finalize（検証 → commit → main 統合）を終えてから
  後続を ready にする。** 前提を先に ready にして「done で自動起動」に任せない
- 後続 body に「前提が review・host-finalize 済みであること」と書くだけでは足りない。
  **自動化はその前提を強制しない**
- やむを得ず並行させる場合は、後続 body に前提 worktree の絶対パスと
  「前提成果を取り込む手順」を明記し、二重実装ではなく取り込みであることを handoff で証明させる

### 1.6 記録の家
| 内容 | 置き場所 |
|---|---|
| 監査（何をいつ判断したか） | board コメント/イベント |
| 教訓（再発防止規則） | tasks/lessons.md（legacy-hermes）→ **「知らないと踏む」なら core、「必要になった時に引ければよい」なら本書**へ昇格 |
| 仕様 | docs/contract.md（**唯一の正本**・orchestrator のみ編集） |
| **判断規律**（読まずに作業すると事故る） | **core（`orchestrator-playbook.md`）。本書へ書かない** |
| **手順**（作業に入る時点で引けば間に合う） | 本書（reference） |
| セッション横断の文脈 | Claude memory（本書と重複させない。ポインタ主体） |
| **仕様・運用の変更周知** | 契約/本書の更新 + **knowledge に spec-change エントリ**（`hachi knowledge add --tags spec-change,...`）。各セッションは開始時と設計前に `python3 scripts/read-operations.py knowledge --limit 20`で索引を読み、対象語で検索して関連IDだけ本文を引く（CLAUDE.md 入口にも記載） |

## 2. 品質規律 — 作業時の手順

> done 照合（§2.1）と検証の代替不可原則（§2.3）は core にある。

### 2.2 レビュー運用
- **reviewer のモデル指定は §0.6.2 が正本**（本節に規則を再掲しない）。実値は config.json が正
  （profile 変更時に本書は更新しない）
- 停止規則: 統合前レビューは **P0/P1 のみ修正**、それ以外は follow-up 起票してコミット優先
- merge 解消のレビュー対象は `git show --remerge-diff`（機能全体は二審済みなので再レビューしない）

### 2.25 ブラウザ操作のコスト規律（2026-08-20 実測）

ブラウザ操作の戻り値はオーケストレーターセッションで最も高価な入力である。実測で1回の画面表示が
645〜856KB（≒16〜21万トークン）を返し、以降の全ターンで再送される。2026-08-19 の
オーケストレーターセッションはツール出力が文脈の49.1%を占め、その大半がブラウザ由来だった。
**文脈圧縮は一度も発生していない**（一度入ったら最後まで残る）。

- **「開いて」は開くだけ。** ユーザーが表示を頼んだ時に、開けたか確認するための
  スクショ・ツリー取得・DOM 読み取りをしない。内容の読み取りは「中身を見て」と
  明示された時だけ行い、その場合も対象セレクタへ絞る。ページ全体のツリーを取らない
- **オーケストレーターは UI 検証を自分でやらない。** 実ブラウザ検証は worker の責務で、
  オーケストレーターは attach された画像を見て判定する（§32.4）。自分でブラウザを駆動するのは
  worker の仕事を最も高いコストで再実行することに等しい
- **同じ画面を繰り返し開かない。** 一度取得した証跡は attachment を正本に再利用する。
  実測では同一確認が15回繰り返され、1つの確認に 12.8MB を費やしていた
- **入れた文脈は毎ターン課金され続ける。** ブラウザ由来の16〜21万トークンは、以降の全ターンで
  読み直される（core §0.7.0 の 12.5倍ルール）。1回の取得が高いのではなく、**残り続けることが高い**。
  コストモデルの正本は §0.7

worker 側も同じ規律に従う。UI タスクの body には、取得してよい範囲（対象セレクタ・viewport）と
「ページ全体のツリーを取らない」ことを明記する。

## 3. インシデント runbook（症状 → 処置）

| 症状 | 診断 | 処置 |
|---|---|---|
| handoff がテンプレのまま done | cwd 消失 or 縮退 worker | dispatch kill-switch → 実体確認 → archive+再起票（done は不可逆なので新タスク） |
| `Reached maximum number of turns` | タスク過大 | 継続指示 prepend → re-ready。頻発するなら分解粒度を細かく |
| /api/prompt タイムアウト | bridge 一時飽和（セッション5-6本+同時起動） | 健全性確認 → re-ready。再発は容量ガード起票 |
| worktree 消失 | 再起動（/tmp 時代の遺物）or 手動削除 | `git worktree prune` → 恒久パスに再作成 → 影響タスクの実体照合（core §2.1） |
| main に見覚えのない dirty/巻き戻り | **並行オーケストレーター** | 触らず内容確認 → ユーザーに確認 → 消失セッションなら検証の上**保全コミット**（出所を commit message に明記） |
| 監視が「早すぎる」終了 | watcher 論理バグ | 単発クエリで実状態確認 → 条件を --json 照合に修正して張り直し |
| 盤外完了タスクのクローズで dispatch に拾われた | todo→done 直遷移が無く ready 経由を強制（2026-07-07 実害: 孤児 worker が launchd 操作を実行） | **不要化は todo/triage→archived（既存遷移）を使う**。盤外完了の done 化は todo→done 遷移（t_93ecd144 で追加）。それまでの ready 経由が必要な操作は先に `touch ~/.hachi-kanban/dispatch.disabled` で dispatch を止める |
| 孤児 run が released 後も行動継続 | bridge session は stop 非対応（§34）・released 後は steer 不達 | bridge `/api/prompt` に sessionId 指定で中断文を直接注入（token は `docs/contract.md` の env 表が正本。旧記載の「§7.2 の token」は誤りで、playbook §7.2 に token の記述は元から無い）。**走行中の巻き戻し合戦をしない** — idle 化を待ってから状態を復旧する（launchctl は disable も戻すこと）。恒久対策は reap の自動注入（t_1b797ddb） |

## 4. 並行オーケストレーター共存

- **契約採番**: 追記前に `grep -n "^## <N>" docs/contract.md` で空きを確認。衝突したら**後着が改番**
  （2026-07-05 の §32 衝突の教訓）。大きめの節は main に採番予約コミットを先に置いてよい
- **main の dirty**: 自分の変更以外を見つけたら上書き・checkout せず §3 の手順へ
- **コミットは pathspec 限定**（`git add -A` は他者/スクショの巻き込み事故のもと。worktree 内は例外的に可）
- **統合の前に必ず `git branch --show-current` で現在地を確認する**（2026-08-20 実害）。
  `git merge --ff-only origin/main` は他ブランチ上でも成功するため、
  「main へ ff できた」ことは main 上に居る証拠にならない。実際に他セッションの
  マージ済み PR ブランチ上で統合と push を行い、他人のブランチへ余計なコミットを積んだ
- **push はブランチを明示する**（`git push origin HEAD:main`）。bare `git push` は
  現在ブランチの upstream へ送るため、現在地を取り違えていると誤ったブランチへ届く
- **push はユーザー承認制**。main 直 push はフックでブロックされる（承認時は bare `git push`）
- ブランチ掃除は「push 完了済み かつ 他 worktree が使っていない」ものだけ

## 6. ポート台帳（既定の予約。ホストごとに読み替える。他プロジェクトの dev サーバー等で使わない）

| port | 用途 | 主 |
|---|---|---|
| 3456 / 8765 | even-terminal codex bridge（worker/reviewer 起動・G2） | kanban-shared-app-server |
| 3457 / 8766 | even-terminal claude bridge（対話セッション G2 配信） | kanban-claude-even-server |
| 3458 | （予約）claude worker G2 relay 案 | 未実装 |
| 9131 | hachi-kanban web | com.hachi-kanban.web |
| 9443 | リバースプロキシ（例: tailscale serve）→ 9131 | 各ホストの proxy |

- **乗っ取りの実害（2026-07-07）**: tenant-a の workerd が 127.0.0.1:3456 を specific bind し、
  even-terminal（*:3456 wildcard）への localhost 接続を全て横取り → codex 起動が 404 で全滅。
  wildcard bind と specific bind は共存できてしまう（EADDRINUSE にならない）ことに注意
- 検知: doctor / webwatch の identity 検査（t_3ac14932 で常設化）。「応答がある」ではなく
  「even-terminal 本人の応答形か」まで見る。症状が 404 のときはまず `lsof -nP -iTCP:<port>` で
  bind 主を確認する

### 6.1 even-terminal の再起動（走行中は絶対にやらない）

**`/api/messages` は even-terminal のメモリ上リングバッファであり、再起動で消える。**
保持上限は 1 セッションあたり 500 件（runtime 既定）。これは supervisor が
bridge worker の出力を読む**唯一の窓**なので、走行中に再起動するとその worker の成果を失う。

- ディスク（`~/.claude/projects/<proj>/<sessionId>.jsonl`）を読むのは `/api/sessions/:id/history`
  と `/api/info` のほう。`/api/messages` と混同しない（2026-08-20 に取り違えた）
- 500 件を超えると古いものから落ちる。M3a は `lastEntryId: 509` で既に欠落していた。
  長い run では「窓に残っている」ことすら保証されない
- **再起動前ゲート（両方を満たすこと）**
  ```bash
  pgrep -f "claude-agent-sdk-darwin"                 # 空であること（bridge の実行体）
  hachi task list --status blocked | grep -c .        # claude-in-progress の理由が無いこと
  ```
  `blocked` は「実行中」を表す状態でもある（`block_reason` が `claude-in-progress:` 系）。
  停止中と読み違えない

**`--stop` の silent fail は 2026-08-20 に修正済み**。`legacy-hermes/scripts/kanban-claude-even-server.sh`
の `pid_on_port()` / `ppid_of()` は末尾がパイプで、未 listen 時に `lsof` が rc=1 を返すと
`set -euo pipefail` が拾って**呼び出し側ごと無言で終了**していた（8766 未 listen が常態のため
`--stop` は常に効かず、停止済みの検出分岐にも到達できなかった）。関数定義に `|| true` を足して
「空文字＝見つからない」に正規化した。現在は次のように応答する。

| 状況 | 出力 | rc |
|---|---|---|
| 稼働中 | `停止しました (even-terminal pid=…)。` | 0 |
| 停止済み | `停止対象の server は見つかりませんでした (port 3457 は未 listen)。` | 0 |
| 別プロセスが占有 | `エラー: … 安全のため停止しません` | 1 |

いずれにせよ `lsof -nP -iTCP:3457 -sTCP:LISTEN -t` で listener が消えたことは目視すること。

### 6.2 bridge 経路の制約（direct には無いもの）

| | direct | bridge |
|---|---|---|
| G2 に映る | ✗ | ✓ |
| モデル/effort 配送 | ✓ | ✓（2026-08-20 修正。それ以前は既定モデルへ黙って落ちていた） |
| ターン上限 | なし | runtime 既定 50。hachi は `CLAUDE_BRIDGE_MAX_TURNS` を送って回避する |
| 出力の保持 | プロセスの stdout | メモリ上リング 500 件・再起動で消滅 |

- ターン上限に当たると handoff を書く前に打ち切られる。分類は `run_truncated_max_turns`
  （`packages/supervisor/src/fence-extraction.ts`）。`worker_output_missing` と出たら
  まず打ち切りを疑う前に、この分類が付いているかを見る
- even-terminal のパッチ（`hachi-patch:` マーカー）は **npm 更新で消える**。生存確認は
  `hachi admin resolve <task-id> --role all --json` の `compatibility.observed` を見る。
  `runtime.name` が `even-terminal-hachi-patch`、`capabilities` に `model-passthrough-v1` /
  `effort-passthrough-v1` / `max-turns-passthrough-v1` が在ればパッチは生きている
  - **bridge の `/api/info` を見てはならない**（2026-08-21 に誤判定しかけた）。port 3457 の
    `/api/info` が返すのは claude CLI 側の `account` / `model` / `version` / `provider` であって、
    `capabilities` フィールドは存在しない。無いことをパッチ消失と読み違える
- **パッチが消えたときの挙動**（素の上流 0.8.1 を読んで確認）。`/api/prompt` は
  `{text, sessionId, provider, cwd}` しか受け取らず、`model` / `effort` / `maxTurns` を
  **黙って無視して 202 を返す**。409 にはならないので「エラーが出ないから効いている」は成り立たない
- **検知は effort 側で起きる**。`deliveryRequirements.effort` は `resolution.effort !== undefined`
  なので、profile が effort を指定していれば `effortDelivery: "none"` となり `nativeMissing` で
  run が止まる（`blockClaimedTask` + `bridge_native_missing` イベント + セッション中断）。
  implement profile は `effort: xhigh` を持つのでこれが効く。
  **profile から effort を外すとパッチ消失が完全に無検知になる**ので外さないこと
- **model 単独では検知できない**。`deliveryRequirements.model` は task override があるときだけ
  真になるため、profile 由来の model が無視されても素通りする。常時化するには先に `codex.ts` へ
  passthrough を渡す必要がある（現状 codex bridge は必ず `modelDelivery: "none"` になり、
  常時化すると codex の run が全部止まる）。手順は `t_7544cf4bd8d4bf00` に凍結済み

## 7. 他リポジトリからの利用（cwd 非依存の動線）

本ボードは hachi-kanban 自身の開発専用ではなく、任意のリポジトリのタスク管理に使う。
オーケストレーターがどの cwd にいても、以下の動線で完結する。

### 7.1 参照ドキュメント（すべて絶対パス。cwd に依存しない）

| 資料 | パス |
|---|---|
| 運用の正本（core・冒頭の必読節と作業別索引） | `~/develop/private/hachi-kanban/runbooks/orchestrator-playbook.md` |
| 作業時参照（本書・trigger index で引く） | `~/develop/private/hachi-kanban/runbooks/orchestrator-reference.md` |
| 契約 | `~/develop/private/hachi-kanban/docs/contract.md` |
| 入口スキル | `~/.claude/skills/hachi-kanban-orchestrator/SKILL.md`（グローバル登録・全リポジトリで発火） |
| CLI/planner/curator スキル | `~/.claude/skills/hachi-kanban*/SKILL.md` |

### 7.2 CLI はどこからでも `hachi`

`~/.local/bin/hachi`（PATH 上のシム）が repo の `bin/hachi` に委譲し、`bin/hachi` が
`pnpm --dir ~/develop/private/hachi-kanban --silent hachi` に委譲する。`cd` 不要。
シムが無い／非対話サンドボックス（.zshrc を読まず pnpm が PATH に載らない）環境では
repo の `~/develop/private/hachi-kanban/bin/hachi <cmd>` を直接使う
（node/pnpm が PATH に無い時だけ既知 toolchain path を存在確認付きで補完してから起動する）。
従来の `pnpm --dir ~/develop/private/hachi-kanban --silent hachi <cmd>` は pnpm が PATH にある環境向け。

### 7.3 他リポジトリのタスクを起票する規約

- **tenant** = 対象リポジトリ/プロジェクト名（例: tenant-a, tenant-b）。ボードのテナントタグ・
  メトリクス・steward の判断単位になる
- **cwd: 行** = 対象リポジトリ側の worktree 絶対パス。worktree は対象 repo で
  `git -C <対象repo> worktree add ~/.hachi-kanban/worktrees/<name> -b <branch>` のように
  **~/.hachi-kanban/worktrees/ 配下に**作る（/tmp 禁止は対象 repo でも同じ）
- **verify gate（§39）は tenant 別**: 新しい tenant は `~/.hachi-kanban/config.json` の
  `verify.tenants` に検証コマンドを登録する。未登録 tenant は構文ゲートのみになる
  （= done の信頼度が下がる）ことを統合時に織り込む
- **host-finalize は対象 repo の規約に従う**: 統合・push の前に必ず `git -C <対象repo> remote -v` で
  対象を確認（外部書き込み前の remote 確認原則）。push 承認・PR/direct 等の方針は repo ごとに異なる
- 凍結ファイル・live config 不可触、done 照合、監視 watcher 等の規律（core §1〜§5 / 本書 §1〜§3）は tenant を問わず同一

## 8. ユーザーへの連絡経路（エスカレーション階梯）

ユーザー判断が必要な中断が起きた時の連絡手段。上から順に試す。

| 段 | 経路 | 使う条件 |
|---|---|---|
| 1 | セッション内で質問（AskUserQuestion / 返信） | ユーザーが Mac の前にいる前提の既定 |
| 2 | `task block --reason "user-decision: ..."` → §38 通知 | **タスク形の判断は常にこちら**（Telegram に承認ボタン付きで届き、監査・nonce・ボード紐付けが付く） |
| 3 | `tg-notify --body ... [--title ...] [--url ...]` | タスクに紐づかないセッションレベルの連絡で、セッション内の問いかけに **~10分応答なし** or **離席・外出宣言あり** のとき |

- 実体: `scripts/orchestrator-notify.sh`（token は `~/.hachi-kanban/telegram-token`、宛先は config の
  notify.telegram.chatId。送信者表記「🤖 orchestrator」で supervisor 自動通知と区別）
- 文面規約・禁則（再送30分・最大2回・秘匿値禁止・返答方法の明記）はスキル
  `~/.claude/skills/telegram-escalate/SKILL.md` を正とする
- 返信は受け取れない片方向（受信は §42 の task 承認のみ）。返答はセッション/ボードで受ける前提で書く
