# steward / brief direct session auto-disable 診断

調査日: 2026-08-28 JST

対象: current main `84aa3db42baafff20b9145da357bf1cf5e196bb4`（`origin/main` と一致）

task: `t_ff8dd30a3700b713`

## 結論

steward と brief は、`claude-sonnet-5` の direct session を起動するところまでは成功していたが、
assistant response を1件も受け取れないまま Claude first-party API の retry を続け、各stage固有の
300秒 timeout 判定に達した。取得できた1セッションの Claude telemetry は retry attempt 9 の原因を
`Connection error.` と記録している。残り6セッションには同じ粒度の telemetry が残っていないため、
7件すべての下位原因（DNS/TLS/local network/upstream のどれか）まで同一だったことは未確定である。

auto-disable の直接原因は、同じ「assistant response なし → timeout」が steward で3回、brief で
stateへ受理された3回、連続したことである。brief は実際には4 sessionを起動したが、supervisor restart
をまたいで2 sessionが重なり、片方のstate writeはbaseline不一致で拒否された。この1件は
`consecutiveFailures` に加算されていない。

300秒を延ばすだけでは根本是正にならない。失敗したsessionは実測301〜1138秒待っても assistant eventが
0件であり、steward/brief の同期waitはその間 supervisor tick 全体を止めていた。推奨は、automation direct
sessionを通常workerと同様のdurableな非同期runへ分離し、restartをまたぐexact-session fence、provider障害時の
backoff/circuit breaker、直近attempt履歴を実装することである。手動解除はこの再発防止実装とは分け、
既存のfenced CLIだけを使う。

## 証拠の読み方

- **強**: current-main code、live state、session file、構造化logが直接示す事実。
- **中**: 複数の直接証拠が一致するが、一部sessionで同じ低層telemetryが欠落している判断。
- **弱**: 現存証拠だけでは決められない候補。採用せず、必要な追加観測を明記する。

再現のためのsession起動、state変更、process操作は行っていない。

## current-main fact table

| fact | file:line / live evidence | 強度 |
| --- | --- | --- |
| live steward profileは`claude / claude-sonnet-5 / direct / low`、cadenceは60分。brief固有profileは無く、code既定の`claude / claude-sonnet-5 / direct / medium`へ落ちる。 | `~/.hachi-kanban/config.json:3-7,259-260`; `packages/supervisor/src/stages/brief.ts:40-44,645-665` | 強 |
| steward/briefの完了待ちはともに既定300秒、1秒poll。`idle && resultCount >= 1`だけを完了とする。 | `packages/supervisor/src/stages/steward.ts:64-68,1317-1353,1400-1405`; `packages/supervisor/src/stages/brief.ts:35-37,465-466,517-540,592-597` | 強 |
| timeoutはlaunch前ではない。adapter launch後、`status()` poll中にdeadlineを超えた段でthrowし、finallyでexact sessionをstopする。 | `packages/supervisor/src/stages/steward.ts:1331-1388`; `packages/supervisor/src/stages/brief.ts:499-570` | 強 |
| DirectClaudeAdapterはprompt/out/exit/stateを作り、detached `claude -p` を起動する。statusはexit fileの有無とleader PID生存だけで`idle/active`を決める。 | `packages/adapters/src/direct-claude.ts:104-127,160-199,229-238`; `packages/adapters/src/direct-process.ts:198-216` | 強 |
| 失敗7 sessionは全てstate JSONと`.out`があり、`.exit`が無い。native transcriptはuser/attachmentとstop時の`[Request interrupted by user]`だけで、assistant eventは0件。 | `~/.hachi-kanban/state/direct-sessions/direct-{be4667bc159e16d3,b31568d11eb0fb5b,9be430419defdbbd,b2538ad5557386ee,4977ae5a651e864b,a1ccf875403cf00f,f34b83a44e62e03a}.{json,out}`; 対応する`~/.claude/projects/.../<nativeSessionId>.jsonl:1-8` | 強 |
| 取得できた`direct-4977...`のClaude telemetryでは、first-party providerのattempt 9が`Connection error.`、delay 35,436msだった。 | `~/.claude/telemetry/1p_failed_events.b3f96ca1-a4bf-4fe1-8a2c-007dc9945d38.9221eaa0-4299-4290-950f-338586f2fc0a.json:1`（`additional_metadata`をdecodeして確認） | 強（当該1件） |
| `.out`先頭の`Write(/tmp/ocr_*)` permission警告は根本原因ではない。同じ警告を持つ直前のsteward/brief sessionがexit=0で正常応答している。 | `~/.claude/settings.json:19`; `direct-53bf456a0fa2de78.out:1-3` + `.exit:1`; `direct-57ea646c3b0d430e.out:1-20` + `.exit:1` | 強 |
| stewardはsession例外を1失敗として加算し、3以上でauto-disableする。成功したparseだけが0へresetする。 | `packages/supervisor/src/stages/steward.ts:1538-1586,1593-1640` | 強 |
| briefはsession、空出力、notify失敗を同じcounterへ加算し、3以上でauto-disableする。成功時だけ`lastRunAt`更新とcounter resetを行う。 | `packages/supervisor/src/stages/brief.ts:575-589,681-734` | 強 |
| briefは失敗時に`lastRunAt`を進めないため、未処理slotが次tickでもdueのままになり、backoffなしで再起動候補になる。 | `packages/supervisor/src/stages/brief.ts:620-633,681-691,729-734` | 強 |
| state writerはtick開始時snapshotとの一致を要求し、重なった古いwriterを拒否する。今回`direct-4977...`のwriteはこのguardで拒否された。 | `packages/supervisor/src/stages/brief.ts:121-158`; `~/.hachi-kanban/logs/supervisor.jsonl:171540-171543` | 強 |
| supervisorはstageを順次`await`する。steward/briefの300秒待ちはworker runのような別runではなく、tickそのものを止める。 | `packages/supervisor/src/supervisor.ts:136-180`; 実測`supervisor.jsonl:171185-171190,171709-171716,171873-171879` | 強 |
| 通常worker directはdispatch後にmonitorされ、既定max run 7200秒、provider別stallはCodex 120分/Claude 180分。automationの同期300秒laneとは制御経路が異なる。 | `packages/supervisor/src/stages/monitor.ts:39-62,735-805` | 強 |
| doctorはstateの`autoDisabled`とreasonを表示しているだけで、timeout原因の再判定や解除はしない。 | `packages/cli/src/commands/doctor.ts:1217-1269,1309-1379` | 強 |
| live stateはsteward/briefとも`consecutiveFailures=3`, `autoDisabled=true`。kill-switch、pending journal、automation lockは調査時点で存在しない。 | `~/.hachi-kanban/state/steward.json:1`; `~/.hachi-kanban/state/brief.json:1`; 2026-08-28 read-only `stat` | 強 |

## timeout の実体

### どの待ちが切れたか

1. stageが0700の一時Git workspaceを作る。
2. DirectClaudeAdapterがdetached shell経由で`claude -p`を起動し、session stateを保存する。
3. stageは1秒ごとにadapter statusをpollする。
4. `.exit`が無くleader PIDが生きている間、statusは`active`のままである。
5. `Date.now() + 300秒`のdeadlineを次のloop判定で超えると、`steward/brief direct session timeout`をthrowする。
6. finallyでprocess groupをstopする。今回の7件は全てstop成功で、briefはpost-stop `idle`, `residual=false`も記録した。
7. stageのcatchが失敗counterを加算し、受理された3回目でauto-disable stateを書いた。

したがって落ちた段は**起動後・最初のassistant response受信前のstatus待ち**である。出力parse、proposal適用、
brief notifyには到達していない。

設定値は300秒だが、これはprocessへ設定したhard kill timerではない。1秒sleep後にevent loopが戻った時だけ
deadlineを再評価するため、host sleep、event-loop停止、signal処理などが重なると実wall timeは300秒を超える。
今回のtimeout検出は301〜1138秒後だった。どの要因が各超過分を作ったかはlogだけでは未確定だが、
300秒を下回って誤判定した事例ではない。

## 失敗の時系列

時刻はJST。`startedAt`はdirect session JSON、timeout/stop/state結果は構造化supervisor logから取得した。

### steward: stateへ受理された3回

| # | sessionId | start | timeout/stop | 実wall time | response/exit | state結果 |
| --- | --- | --- | --- | ---: | --- | --- |
| 1 | `direct-be4667bc159e16d3` | 8/27 19:03:31 | 19:09:49 | 約378秒 | assistant 0、exitなし | 失敗1として受理 |
| 2 | `direct-b31568d11eb0fb5b` | 8/27 20:03:59 | 20:22:57 | 約1138秒 | assistant 0、exitなし | 失敗2として受理 |
| 3 | `direct-9be430419defdbbd` | 8/27 21:05:18 | 21:13:58 | 約520秒 | assistant 0、exitなし | `consecutiveFailures=3`、auto-disable |

log位置: `~/.hachi-kanban/logs/supervisor.jsonl:171185-171190,171709-171716,171873-171879`。
3件の`.out`は同じ244 bytesで、permission設定警告の後に`Execution error`だけを記録する。native transcriptにも
assistant eventは無い。低層telemetryは3件分残っていないため、全3件のconnection error分類は**中**の確度だが、
少なくとも同じresponse未取得timeoutが3連続したことは**強**である。

### brief: 4回起動、stateへ受理された3回

| 実行 | sessionId | start | timeout/stop | 実wall time | state結果 |
| --- | --- | --- | --- | ---: | --- |
| A | `direct-b2538ad5557386ee` | 8/27 19:39:27 | 19:45:04〜05 | 約338秒 | 失敗1として受理 |
| B | `direct-4977ae5a651e864b` | 8/27 19:40:16 | 19:45:17 | 約301秒 | Aと重複。baseline変更済みのためstale write拒否、counter非加算 |
| C | `direct-a1ccf875403cf00f` | 8/27 19:45:35 | 19:52:48〜49 | 約434秒 | 失敗2として受理 |
| D | `direct-f34b83a44e62e03a` | 8/27 19:53:06 | 20:00:44〜45 | 約458秒 | 失敗3として受理、auto-disable |

log位置: `~/.hachi-kanban/logs/supervisor.jsonl:171513-171543,171562-171565,171585-171588`。
Aの実行中に旧supervisorがSIGTERMを受け、新supervisorが起動してBを開始した
（同log `171514-171534`）。single process内のrunning guardはあるが、restartをまたぐdurable lease/fenceが
automation sessionには無いため重複できた。state baseline guardが二重加算は防いだが、provider requestの
二重起動自体は防いでいない。

Bのtelemetryだけはfirst-party `Connection error.` retry attempt 9を保存している。A/C/Dもassistant event 0、
exitなし、同じ時刻帯・同じmodel・同じstop結果であるため同一障害の可能性が高い。ただしA/C/Dの
低層error分類は証拠欠落のため未確定である。

## 他の direct lane との差

### B0-CX / B0-CCは同じ比較対象ではない

- B0-CX `t_20ff6430fc2eb965` のboard workerは`codex / gpt-5.6-sol / direct`で、保存済みdirect runは
  exit=0だった。
- B0-CC `t_e4ed1b42c3e024f4` もboard worker自体は`codex / gpt-5.6-sol / direct`だった。
  task内部で使ったClaude canaryは専用`CLAUDE_CONFIG_DIR`の隔離runtimeであり、16:45〜16:55 JSTに実行された。
- 最初の今回障害は19:03 JSTで、providerも時刻帯もcontrol pathも異なる。B0 2件の成功はCodex direct laneの
  健全性は示すが、19時以降のClaude first-party接続を反証しない。

### automation lane固有の差

| 項目 | 通常worker direct | steward / brief |
| --- | --- | --- |
| provider（今回比較） | B0はCodex | Claude Sonnet 5 |
| lifecycle | dispatchでdurable run作成、後続tickのmonitor/cancel/finalizeが追跡 | stage内でlaunchから完了まで同期wait |
| timeout | config max run既定7200秒、provider別stall | hard-coded 300秒をstage内poll |
| supervisor tick | worker実行中も次tickで他stageを処理 | wait中はtick末尾とheartbeat更新を止める |
| restart fence | task/run/sessionをdurableに追跡 | session IDはfile/logのみ。restart後の新stageが同じdue slotを再起動可能 |
| retry cadence | task state machine | stewardは失敗時`lastRunAt`更新で60分後、briefは成功まで`lastRunAt`不変で次tick再試行 |

「steward/briefだけが落ちた」の直接理由は、同時期に同条件のClaude worker directが無かったことと、
automationだけが同期300秒laneを使うことである。prompt sizeはbrief約2.6KB、steward約34.7KBと異なるのに
同じresponse 0症状であり、特定promptのparse/サイズ問題は支持されない。

## 根本原因候補

| 候補 | 支持する観測 | 反証・限界 | 判定 |
| --- | --- | --- | --- |
| Claude first-party接続障害 | 代表sessionのtelemetryがattempt 9 `Connection error.`。7 session全てassistant event 0。直前までは同じprofileが成功。 | 低層のDNS/TLS/local/upstream分類は無い。6件は同粒度telemetry欠落。 | **一次原因。中〜強** |
| 300秒が短すぎた | Claude CLIは少なくとも9回retryし、1回のdelayは35秒超。短い一過性障害なら延長で回復余地はある。 | 実際には最大1138秒でもresponse 0。延長はsupervisor停止時間と重複窓を拡大する。 | **単独是正として棄却** |
| automation lifecycleの欠陥 | 同期waitがtickを最大約19分止めた。restartでbriefが重複起動。briefはbackoffなしで同じdue slotを連続再試行。 | 接続障害そのものは作っていない。 | **障害増幅・再発原因として確定** |
| `~/.claude/settings.json:19`のpermission rule | 全failure `.out`に警告がある。 | 同じ警告を含む多数の直前sessionがexit=0で正常応答。 | **一次原因として反証済み**。別途config hygiene対象 |
| prompt/workspace固有不具合 | 両laneともephemeral workspaceを使う。 | prompt sizeが異なる両laneで同じ症状、かつ同経路の過去runは成功。 | **支持なし** |
| notify / steward output parse失敗 | counter実装上は同じauto-disableへ入る可能性がある。 | 今回はassistant response前にtimeout。notify/parseへ未到達。 | **今回原因ではない** |

## 自動無効化の解除条件と正規経路

解除はstate手編集やdisabled file削除では行わない。active exact orchestrator identity/session/generationを
Storeで再照合する次の専用CLIだけが正規経路である。

```text
hachi admin steward-enable --actor-kind orchestrator --orchestrator <id> --session <id> --generation <n> --json
hachi admin steward-enable --apply --actor-kind orchestrator --orchestrator <id> --session <id> --generation <n> --json

hachi admin brief-enable --actor-kind orchestrator --orchestrator <id> --session <id> --generation <n> --json
hachi admin brief-enable --apply --actor-kind orchestrator --orchestrator <id> --session <id> --generation <n> --json
```

既定はdry-runで、`--apply`だけが変更する
（`packages/cli/src/commands/admin.ts:215-264,411-459,952-975`）。applyは`lastRunAt`や既存件数を保持し、
`lastError=''`, `consecutiveFailures=0`, `autoDisabled=false`, `autoDisabledReason=''`だけをresetする
（`packages/cli/src/steward-enable.ts:175-197`; `packages/cli/src/brief-enable.ts:137-159`）。kill-switchは
別authorityであり変更しない。stateはstrict schema、regular file、size、inode/hash、共有lock、pending journal、
board auditで保護される。

### apply前の前提

1. active exact orchestrator principalをliveで取得し、旧generationを使わない。
2. `steward.disabled` / `brief.disabled`、pending journal、automation lockの有無を再確認する。
   2026-08-28調査時点では全てabsentだが、apply時に再確認する。
3. Claude first-party接続が回復したことを、automationと同じprovider/model/auth境界を使うboundedな隔離smokeで
   先に確認する。smoke実施は本taskのscope外であり、今回は起動していない。
4. 解除は一方ずつ行い、次の実sessionが正常終端するまで他方を解除しない。restart中の重複sessionが無いことも確認する。

### apply後の完了条件

- doctorのauto-disable NGが解消するだけでは不十分。
- stewardは次cadence run、briefは未処理slotの再試行が1回成功する。
- operational notify成功後にだけbrief `lastRunAt`が進む。
- direct sessionのexit/terminal証跡があり、process残留が無い。
- 再度counterが1へ上がった場合は続けて解除・再試行せず、provider障害または実装欠陥として停止する。

契約上の正本は`docs/contract.md:1843-1872,2129-2154`。

## 是正方式の比較

| 方式 | 効果 | 欠点 | 採否 |
| --- | --- | --- | --- |
| timeoutを300→600/1200秒へ延長 | 一時的な長いprovider retryを許容 | response 0の障害では単にtick停止を延ばす。今回1138秒でも回復なし | 単独では不採用 |
| 現状のまま手動enable | 配信を早く再開できる | 接続未回復なら同じ3連を再現。briefは短時間で再disable | 緊急復旧のみ。前提gate必須 |
| automation専用Claude configへ隔離 | user settings/plugin/hook driftを除外し、permission警告も消せる | 今回確認できたfirst-party connection error自体は直さない | 防御的改善として併用、主修正ではない |
| 同期waitのままbackoffとattempt履歴を追加 | brief連打と調査証拠欠落を軽減 | 300秒以上tickを止める構造、restart重複は残る | 暫定策 |
| durable非同期automation run + restart fence + provider circuit breaker/backoff | tickを止めず、exact sessionを世代越しに追跡し、共通provider障害で両laneがcounterを焼くのを防ぐ | contract/state machine変更とmigration、focused/full検証が必要 | **推奨** |

### 推奨方式

steward/briefのLLM生成部分をsupervisor stage内の同期`while`から分離し、automation attemptをdurable stateとして
`launching/running/terminal/failed`で追跡する。最低限、次を同じ再発防止設計へ含める。

- `(lane, dueSlot/cadence, provider, generation)`で一意なlaunch fence。restart後もopen exact sessionがあれば再起動しない。
- monitor/cancel相当の別tick追跡。steward/brief待ちでsupervisor heartbeatを止めない。
- provider failure classと`lastAttemptAt/nextRetryAt`。briefの`lastRunAt`は成功意味のまま保持し、失敗backoffを別fieldにする。
- 同一Claude providerの接続障害を共有circuit breakerで抑止し、stewardとbriefが同じincidentで別々にcounterを焼かない。
- 直近3〜5 attemptのbounded history（timestamp、sessionId、phase、errorClass、stop result、state-write outcome）。prompt/outputは保存しない。
- timeoutはprovider/lane別にconfig化できるようにしてもよいが、値変更は上記lifecycle修正後に実測で決める。
- automation専用Claude configを採る場合は、subscription authとnative usage transcriptの正本位置を崩さない契約を先に定める。

## 後続タスクへの分解案

### 1. 解除手順の整備とauthority-gated live recovery

scopeはrunbook/運用とlive recoveryだけに限定する。

- active exact orchestrator principal取得、dry-run、apply、1 laneずつのcanary、doctor、process残留確認を手順化する。
- provider接続smokeの成功をapply前gateにする。
- steward/brief stateを直接触る手順やkill-switch削除を禁止する。
- まずstewardまたはbriefの一方だけを解除し、1回成功後に他方へ進む。
- 成果はboard audit (`steward_enabled` / `brief_enabled`) とdoctor/terminal証跡で確認する。

### 2. 再発防止: automation direct sessionのdurable非同期化

scopeはcontract/state machine/supervisor/adapters/tests。

- 同期waitをdurable attempt lifecycleへ置換する。
- restart fence、exact-session stop、provider circuit breaker、brief backoffを実装する。
- supervisor restart中の同一due slot二重起動fixture、connection error連続fixture、tick heartbeat非阻害fixtureを追加する。
- auto-disable thresholdは「独立した受理済みattempt」だけを数え、stale writer/重複sessionは数えない契約を固定する。

### 3. 観測性とconfig hygiene（2から分離可能）

- stewardにもbrief同等のsession start/timeout/post-stop構造化logを追加する。
- bounded attempt historyとprovider error classをstateまたは専用nonsecret ledgerへ保存する。
- automation開始前にClaude settings/plugin/hookの警告をhealth面へ出すが、warningだけで接続障害と誤分類しない。
- user configに残る`Write(/tmp/ocr_*)`警告は`Edit(...)`への修正候補として別authorityで扱う。今回のauto-disable解除と混ぜない。

依存順は `3の最小観測面 → 2の非同期化 → 1のlive recovery` が安全である。ただし緊急復旧を先行する場合も、
1のprovider smoke gateとone-lane canaryを省略しない。

## 未確定事項と決定に必要な観測

| 未確定 | 現在の証拠 | 決めるために必要な観測 |
| --- | --- | --- |
| 7件すべてが同じ`Connection error.`だったか | 1件だけtelemetryあり。他6件はassistant 0/同症状 | automation-owned bounded error classを各attemptで保存する |
| connection errorの下位原因 | firstParty connection errorまで | credentialを含めないDNS/TLS/HTTP status/timeout分類とhost network epoch |
| timeoutが300秒を超過した各区間の理由 | wall timeとlog gapのみ | monotonic deadline、poll開始/終了、event-loop lag、sleep/wake epochを記録する |
| timeoutを何秒にすべきか | briefの過去成功は約12〜15秒。stewardは直近成功が約28秒、近時成功が約22〜82秒。今回失敗は最大1138秒response 0 | 非同期化後のlane別の成功/一過性障害の分位値。先に値だけ変えない |
| isolated Claude configがconnection errorを減らすか | B0-CCは別時刻に成功、今回と同時比較ではない | 同時刻・同provider・同modelのhost-owned比較canary。production laneを再現に使わない |

## このtaskで行った検証

- `HEAD == origin/main == 84aa3db42baafff20b9145da357bf1cf5e196bb4`
- live state、direct session state/out/exit有無、native transcript event type、限定supervisor log、限定telemetryをread-only確認
- steward/briefの起動、enable、state編集、process kill/restartは未実施
- production code、contract、runbook、configは未変更
