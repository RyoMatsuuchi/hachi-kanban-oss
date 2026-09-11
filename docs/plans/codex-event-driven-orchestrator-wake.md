# Codexオーケストレーターのイベント駆動再開

2026-09-09 調査・設計案。tenant購読と監視起動修正はmain b397a1aへ実装済み。専用wake hostは未実装。
正本変更前の提案であり、以下の新CLI名はまだ実行できない。

## 推奨

既存のイベント検知を再利用し、Hachi側に永続通知とprovider別wake adapterを持つ小さなホストを加える。
goalの休止は必須要件にしない。まずgoalをactiveに保ったままホストがイベント待機でき、無変化時に
モデルを呼ばない方式をG0で確認する。それが成立しない場合だけ、待機中pausedに保ち、対象イベントで
同じ会話へ必要な1turnを開始する方式を採る。tenant購読はこの実証と独立して先行できる。
Desktop会話の正当な接続先が取得できなければDesktop対応は未成立とし、別app-serverへの履歴resumeで代用しない。

## 調査結果

### Claudeとの違い

Claudeの実績ある経路は `Hachi await → stdout/log → Claude Monitor → 会話へ通知`。
CLIだけでClaudeを起こしていたわけではなく、Monitorが会話ホストとの橋渡しを担っていた。
core §1.3.1には、nohupのログ追記だけでは会話を起こせなかった実測も残る。

CodexでもHachi awaitは動く。現在のセッションに公開されたツールには、任意のCLI stdoutを
永続購読してモデルを再開するMonitor相当の面が確認できない。端末の待機結果をAstraが回収すると
モデル呼び出しが発生する。今回の監査ではAstraによる10秒の回収待ち指定と、goal自動継続による
再開の両方を観測した。前者は指示で改善できる選択であり、goal自体の欠陥とは断定しない。
G0の過去canaryはAPI-level出力上限未保証と提出script/log不整合により判定根拠から撤回された。
active goal待機の成功・失敗は未証明とし、追加canaryは行わない。
通知を非表示にするだけではモデル呼び出しは抑制できない。

| 層 | 現在できること | 足りないもの |
|---|---|---|
| Hachi task await | カーソルでイベントを追い、終端を出してreturn | tenant購読と永続的な受信確認まで含む配送 |
| Hachi orchestrator await | 質問・stall等をclaimしてreturn | claimしない通知購読 |
| Codex App Server | goal操作、turn開始、native通知 | 正しい既存Desktopホストへの接続証明とwake接合 |
| Codex側の会話制御 | goal継続で作業を反復 | 外部待ちと独立作業を分離した休止の運用 |

awaitは全status変化を無条件に通知するものではない。task終端とinboxの要対応イベントを分けて扱う。
workerプロセスの正常終了だけでは、finalize/reviewを通ったtaskの受入完了を意味しない。

### 現行CLIの境界

- `packages/cli/src/commands/task.ts:1871`はdedupeKeyを付けてstdout書込を待つ。
  `:2484`付近ではその後checkpointを保存してreturnする。OSへの書込成功と下流の永続受信は別であり、
  パイプ受信後・下流保存前のcrashを現在のcheckpointだけで保証しない。
- `packages/cli/src/commands/orchestrator.ts:940`のrunAwaitはheartbeatし、deliveryを更新し、
  requestをclaimしてtokenを返す。通知だけの常駐hostが既存awaitを連打してclaimを保持する方式は採らない。
  runtime cleanup、人間判断回答も候補として扱っており、質問とstallの2種類だけに縮めない。
- `packages/adapters/src/codex-app-server.ts:deliver`はactive turnのturn/steer。
  終了済みオーケストレーターを起こす実装としてそのまま使えない。worker launchはthread/startを使い、別用途。
- 契約§50.4には固定間隔thread heartbeatを使う規定が残る。前回のrunbook改善だけではこの正本の改定が
  未了である。イベントwakeの成立後、同節を「標準はイベント、定期wakeは明示選択の回復策」へ改める必要がある。

### Codexで確認できたAPI

ローカルcodex-cli 0.153.0から `app-server generate-json-schema --experimental` を実行。
ClientRequest.json SHA-256: `05c82ead1a820c765c23d3a1d262e4ae54889785276ee1acf7c494141fd94d70`。

- `thread/goal/set`のstatusにpausedがある。objectiveを省略して状態だけ変更する形が可能。
- `turn/start`で同じthreadへ新しいturnを開始できる。`turn/steer`はactive turn専用。
- `thread/inject_items`は履歴への追加であり、単独のidle wakeではない。
- `thread/queue/add`と`thread/queue/start`は存在する。ただしenqueue成功を実行開始や冪等性の証拠にしない。
- `mcpServer/event/stream/start`もschemaにあるが、MCPイベントが自動でLLMを再開する契約は確認していない。
  名前だけでMonitor互換と扱わず、G0の代替候補として扱う。

公式資料もgoal pauseとturn/startを説明する。schemaの存在は、今開いているDesktop会話への到達証明ではない。
この会話から利用できるsend_message_to_threadも、外部Hachiプロセスが呼べるAPIの証拠にはならない。

## 2026-09-09 Desktop単発wake実験の結果

現行Desktop会話で `functions.exec` 内の45秒timer後に公開アプリtool `send_message_to_thread` を呼ぶ実験は、
idle wakeとして不成立だった。前turn完了は14:55:02 JST。callbackは14:55:38に次toolを要求したが、
そのcommandとsend toolは14:58:13のユーザー入力で始まった次turnへ持ち越された。
send tool自体の所要121ms、send-returnedは14:58:20。成功応答はユーザーが再開した後の配送成功である。
従ってこの仕組みをMonitor代替や「event時だけ自己再開できる」として運用しない。定期timer実験は繰り返さない。

公開CLI `codex app-server daemon version` は既定control socket不在で失敗した。
これは現在のDesktopに接続できる公開owner endpointの証明が取れないことを示すが、製品全般の不可能性の証明ではない。
別serverへの既存thread resume、非公開socket推測、GUIへの盲目的な入力は代替にしない。
このDesktop会話への自動wakeは未成立として残し、製品側の外部イベント受付が必要かを切り分ける。

G0 taskの過去2 canaryは出力上限未保証と提出script/log不整合により判定根拠から撤回された。
修正版はモデルを起動しないcapability probeのみ。公開turn/startのoutput hard cap不足により、
指定された実験境界ではG0未証明とする。過去usage値は成功/失敗の根拠にしない。
通常の同期toolに追加async:false fieldを要求しない。Desktop owner確認はdisposable試験とは別gateとする。
追加実験を繰り返さず、tenant購読と既知の監視起動競合の修正を優先する。
証拠: `~/.hachi-kanban/worktrees/codex-event-wait-g0/.evidence/codex-event-wait-g0.md`。

2026-09-09のユーザー指示に従い、tenant購読と監視安定化を先行し、自動復帰は次の2案を独立して比較する。
単発scheduleは同一会話で一度だけ実行されるscheduler能力、worker native messageはworkerから既存Desktop ownerへ
到達する公開能力を確認する。いずれも未実証の機能を運用手順として記載しない。

## 選択肢

| 方式 | 判断 |
|---|---|
| await + Astraが結果を定期回収 | 不採用。無変化でモデルが動く |
| 定期thread heartbeatで回収 | 即時性・無変化ゼロを満たさない。明示選択の回復策に限定 |
| Codexの純正event streamがwakeまで担う | G0で先に確認。成立すれば最小構成として優先 |
| Hachi hostが同一Codex ownerへイベント時だけturn開始 | 推奨する実装候補。owner接続とgoal制御の成立が前提 |

専用App Server/TUIは接続先を起動時に明示できるため検証しやすい。ただしDesktop対応の代替達成とは数えない。
G2のqueue/observerは別セッションで開発中。§78.10.4.8/.9のowner照合や通知購読の考え方を再利用するが、
G2 detachにwake hostの終了を連動させない。G2 observerに禁止されたturn/start/goal操作を継ぎ足さず、
Mac会話ownerの別capabilityとして設計する。

## 代替wake経路の比較（2026-09-09追記）

| 案 | 公開面の確認 | 未成立のgate |
|---|---|---|
| 単発schedule | 一回限定保存・同一会話target・親final後の実wakeを確認 | 1回観測後PAUSED確認。Hachiイベント直結は未検証 |
| 独立workerから直接送信 | App公開send_message_to_threadは既存会話へ送信できる | Hachi worker自身へのtool公開、正しいDesktop宛先、親final後の実wake |
| Desktop内subagent通知 | collaboration.send_messageは親へ配送できる | 稼働中親への配送と、final後の新turn起動の違い |

単発scheduleは時限回復策として評価し、イベント直結と同一扱いしない。一回限定を保証できなければ、
定期scheduleへ自動で置き換えない。native案は独立workerの公開tool一覧を確認してから一度だけ試す。
親自身のpending exec内で送る方式は既に不成立のため再試行しない。
Hachi既存native steerは主にorchestratorからactive workerへの配送であり、逆方向Desktop ingressの証拠ではない。
公式の既存会話schedule説明: https://learn.chatgpt.com/docs/automations?surface=app#schedule-a-task-inside-a-chat

## 単発scheduleの実測結果（2026-09-09）

同一Desktop会話への時限復帰は成功した。前turnは16:17:29 JSTに完了し、その後に人間の入力を挟まず、
16:20:09 JSTにautomation起点の新turnが同じ会話で開始された。予定時刻16:20に対し通知時刻は約9.7秒後。
一回限定設定と対象thread IDは保存設定で確認し、実際の復帰を1回観測した後にautomationをPAUSEDへ更新・再確認した。
設定受付だけの成功ではない。一方、Hachiの終端イベントを直接契機にする復帰はこの試験の対象外である。

運用候補は「待つ必要がある時だけ次の確認を一回予約し、作業終了時は再予約しない」という時限回復策。
既存await/inboxをイベント正本として維持し、schedule起動そのものをworker完了やsession生存の証拠にしない。
無変化で定期再予約する方式を標準にはしない。専用wake hostの実装前に利用できる小さい選択肢として扱う。
証拠: `state/orch-watch/tenant-await/one-shot-schedule-test.json`、automation ID `automation`（試験後PAUSED）。

## CLIと責務の提案

新しいCLI群の仮名は `hachi orchestrator wake`。既存awaitの出力形式・claim契約は変更しない。

| 操作案 | 意味 |
|---|---|
| doctor | endpoint所有・版・thread/native session/cwd・goal制御・通知購読の可否をread-only診断 |
| enable / disable | 明示したidentityのwake利用許可。disableはworkerを止めず未処理通知を保存 |
| park | 担当会話が独立作業を終えたことを伝え、fencedな待機epochを確立する |
| status | parked / running / delivery-unknown / disconnected等を短いJSONで返す |
| receive / ack | wake batchのIDと参照を取得し、受信・対応結果を区別して記録する |

hostは既存supervisorのstageとしてイベント収集・reconcile・配送を持ち、モデルが監視プロセスを手組みしない。
常駐接続は既存adapterのlifecycleへ統合する。初期実装から独立daemonとsupervisorの二重監視は作らない。

terminal収集はKanbanReadViewのイベント走査と既存終端判定を共有する。採用イベントをoutboxへ保存した後だけ
収集cursorを進める。この境界は同一Store transactionで固定するか、先行永続化と一意event keyでcrash再生を保証する。
既存stdout consumerの後付けだけでexact deliveryを称さない。

inbox側はpeek通知と業務claimを分ける。通知時はrequest IDだけをoutboxへ入れ、再開したorchestratorが
既存fenced経路でclaimする。hostは質問への回答やcleanup approveを代行しない。

## 永続状態と配送

- subscription: board instance、tenant集合、filter revision、stable identity、session/generation、scope、binding revision、owner endpoint証明、
  runtime版/schema、park epoch。socketやPIDを探索して宛先を推測しない。
- delivery: source event/request ID、対象identity、通知revision、batch ID、attempt ID、state、provider receipt。
  task.body、transcript、claim token、secretをwake本文へ入れない。
- 状態例: pending → dispatching → accepted → observed → acknowledged。
  write後timeout/切断はunknownとして保持し、安易にpendingへ戻して再送しない。
  API receipt、turn開始、モデルによる受信、task処理済みはそれぞれ別の証拠。
- 原則at-least-once。source keyとbatch keyの一意性、fenced業務mutationで重複処理を防ぐ。
  providerに冪等開始の保証がなければunknown後の自動turn再作成をしない。
- scope解決は既存binding/watch resolverを再利用。observerへの通知をclaim権限へ昇格しない。
  session交代時は旧宛先attemptの結果を確定・隔離してから新generationへ未配送分を振り替える。
- 無意味な数値更新、通常heartbeat、同じbudget continueはwakeしない。terminal、worker質問、stall、
  human decision回答、要対応cleanup、監視故障等を通知理由として定義し、未知kindは黙って捨てない。
- 短時間の複数イベントはbatch化。busy中はpendingに保持し、turn完了通知で再判定する。
  approval/user-input待ちは勝手に回答せず、ユーザーの入力順序を越えてturnを開始しない。

## tenant購読と既存課題

既存課題 `t_282fc30032fb476f`「task await に tenant フィルタが無く、全オーケストレーターが他責務の終端で起床している（回避策の二重管理も発生中）」
を共通CLI側の先行課題として扱う。2026-09-09照会時点でtriage、priority=93。
課題本文にはtenant-aの約40分で担当外終端5件、dial/tenant-aの個別DB直読ルーターで判定規則が食い違う実害が記録されている。
初回調査時点ではtenantフィルタが無かった。その後§50.1.2として実装・統合した。
watch scopeもtask/subtree/worktree/projectのみで、tenantをprojectやcwdから推測する代替は採らない。

以下は初期の設計候補。実装済みtenant-onlyの正本は§50.1.2であり、host/outbox/担当OR等の未実装案と区別する。

- `task await --all --tenant <name>`を繰り返し指定可能にする。複数tenantはOR、未指定は従来の全board。
  明示task IDとの併用は拒否し、空値も拒否する。存在するtaskが0件でも将来のfollow-new対象として有効。
- host購読も同じ正規化済みtenant集合を保存し、モデルを起こす前に絞る。後からLLMが担当外を捨てる方式にしない。
  tenantフィルタは通知対象の選択であり、binding/watchのprimary/observerやclaim権限を変更しない。
  同tenant内の別担当も絞る場合は明示した担当scopeとのANDとし、暗黙の「tenant OR binding」は作らない。
  tenantだけの終端監視は可能とするが、通知を受けても業務mutationは既存の宛先・権限検査に従う。
- inboxの業務requestは既存宛先解決を先に満たした上でtenantを絞る。taskに紐づかないowner接続故障等は
  tenant不明として捨てず、購読自身の制御イベントとして別経路で通知する。
- cursorはboard全体の走査位置として、除外したイベントも反映する。対象イベントはoutboxへ永続化してから進める。
  走査位置とtenant別配送状態を混同しない。target集合も同じイベント接頭辞と整合させる。
- checkpoint.v1はexactな4fieldでfilter情報を持てない。tenant付きには版を上げたcheckpointを契約化し、
  正規化tenant集合とfilter revisionを保存する。異なるfilterで同じcheckpointを再利用した場合は拒否し、
  暗黙resetしない。未指定の既存v1利用は維持する。新filterは新購読としてarm時点の稼働snapshot＋以後のeventを対象とし、
  過去の対象外終端を遡及配信したい場合は明示replayを別途設計する。
- 配送対象のtenantは候補を永続化した時点のtask.tenantを保存し、後の変更で配送先を書き換えない。
  過去イベント発生時tenantを復元できるとは称さない。未収集中のtenant変更を含む意味は契約に明記し、
  歴史的tenantによる配送が必要ならイベント側に情報を持たせる追加設計が必要。
- 新規tenant指定のJSONにはtenantを含める。既存の無指定JSONは厳格consumerを壊さないよう維持し、
  全tenantをmetadata付きで読む用途は明示した新出力版で提供する。orchestrator IDを出す場合は
  現在の宛先metadataと明示し、権限証明やイベント時の担当者と見なさない。

先行課題はClaude Monitorにも直接効き、Codex owner接続のG0と独立して進められる。
共通coreのtenant predicateをCLIとhostで再利用し、個別ルーターをどちらか一系統で置換検証してから廃止する。
必須テストはtenant A→B→Aの終端列、後発task、複数tenant、0件tenant、filter変更拒否、crash再arm、
同tenant別担当、別tenantの既存binding、tenant無し制御イベント。Bの終端でAのモデル呼び出しは0回とする。

## parkとgoalの競合

parkはHachi側の外部イベント待機状態であり、Codex goalのpausedと同義にはしない。
G0では「active goal＋単一のイベント待機」を先に試す。指示には、短周期回収の禁止、独立作業がない場合の
待機、無変化timeoutを進捗判断の理由にしないことを短く明記する。指示だけでホストのtimeoutや自動継続規則を
変更できるとは扱わない。無変化30分でモデル呼び出し0を満たせばgoal状態の変更機能は実装しない。
以下は、その条件を満たせずgoal休止方式が必要になった場合だけ適用する。

1. scopeとイベントcursorを確立し、待機epochを永続化する。
2. 同一ownerで現在goalを読み、状態だけpausedへ変更してreadbackする。objective・予算・使用量をリセットしない。
3. current turnが完了するまでnative通知で待つ。無変化でmodelを起こさない。
4. cursor後の再照合を行い、park中に届いたeventを取りこぼさない。
5. eventがあればfreshなowner/generation/goal/approval状態を検査してbatchの1turnを開始する。
6. goalを自動activeへ戻さず、そのturnで残作業を処理して再parkする方式をG0で確認する。

goal/setにcompare-and-set revisionがないため、get→setだけではユーザーによる同時goal変更との競合を閉じられない。
goalのpause制御を同一hostで直列化できる証明が必要。できなければ自動goal変更は無効とし、ユーザーによるpause後に
イベントturnだけを開始する。ユーザーの手動停止/paused/completeをホスト判断でactiveへ戻さない。
endpoint切断時もworkerを停止しない。wake host単独の生存を会話の生存と見なしてheartbeatを永久維持しない。
owner接続・park lease・generationが有効な期間だけ生存信号を更新し、喪失時は既存recovery規則へ委ねる。

## 実装前のG0と分割

G0: 専用の許可されたcanary会話で、まず改善済み指示＋active goal＋単一イベント待機を検証する。
無変化中のtool timeout、goal自動継続、モデル呼び出しを区別して計測する。
Desktopの同一owner接続、CLI/TUI接続、event-stream wakeの可否を確認し、active維持が成立しない場合は
paused goalのまま1turn開始できるかを検証する。busy/approval/user入力との競合も比較する。
既存稼働中G2会話にはprobeを送らない。過去canaryは判定根拠から撤回済み。追加canaryは停止し、単発scheduleの別検証を先行する。

G0合格後の実装順:

1. core: source key/outbox/cursor/park fenceの狭い契約とfocused crash tests。
2. adapters: 独立したorchestrator wake capability。worker adapterとG2 input adapterを変更しない。
3. supervisor: collection、connection lifecycle、batch dispatch、unknown recovery。
4. CLI: doctor/enable/park/status/receive/ack。hostの共有実装を呼び、CLI独自のstate machineを持たない。
5. 全体検証: fake ownerと実canary。最後に契約§50.4、§55、§77とrunbookの切替を行う。

受入条件:
- 無変化30分のモデル呼び出し0、worker作業と必要なheartbeatは継続。
- terminal・質問・人間回答・監視故障で同一会話が再開。通常時の検知→開始遅延目標10秒以内（provider遅延は別測定）。
- park境界、outbox保存境界、send応答喪失、再起動、generation交代の欠落0・二重業務処理0。
- busy/approval待ちで強制interrupt、別会話resume、無許可のgoal再有効化0。
- worker/reviewerの既存gate非回帰。API usageとレートリミット消費率を混同しない。

## 根拠

- core playbook §1.3.1、契約§50.1/.4、§55、§78.10.4.8/.9.6。
- knowledge k_87562c29256b、k_d2e57210669b（G2接続境界。実装済みと推定しない）。
- knowledge k_423db2763c81（G2 HTTP接合。既存relayの限定APIを利用する契約であり、汎用wake/goal操作の許可ではない）。
- task t_282fc30032fb476f本文・コメント、現行task await help、checkpoint.v1 schema（契約§50.1.1）。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): goal状態操作、turn/start、steerと履歴注入の違い。
- [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals): pause/resumeの公開操作。

schemaはCLI版の証拠。Desktopの実行バイナリ・同一owner endpoint・権限・同時入力動作は別途実測する。
