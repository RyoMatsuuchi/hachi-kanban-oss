# G2 双方向オーケストレーター設計レビュー

## 1. 設計の致命的な穴

**致命的な穴はある。現状の設計のまま P3 を ready にしてはいけない。** 少なくとも次の 2 点を設計契約として先に閉じる必要がある。

1. **差し替え点は `claude provider.prompt()` の 1 箇所では完結しない。** G2 は `GET /api/sessions`、history、SSE、`POST /api/prompt` に加えて `POST /api/interrupt` も使う。登録済み relay セッションだけを列挙・閲覧・操作可能にし、未登録の生存中オーケストレーターを隠して拒否する認可境界が、全経路に必要である。現案には sessionId の所有者、relay の生存性、even-terminal の起動世代、hachi の handover 世代、重複登録を一意に判定する registry/fencing 契約がない。「登録済みなら転送」は stale relay や旧世代にも転送し、「それ以外は resume」は transcript だけ残ったオーケストレーターを意図せず再開し得る。`t_eabaccdfd82ccdaf` を先に処置するという依存だけでは、直接の history/SSE/interrupt と競合時の安全性までは保証しない。
2. **メガネから承認結果を返すプロトコルが未定義である。** 資料で実測されている G2 の入力は文字列の `/api/prompt` だけであり、permission request の request ID と allow/deny/review を対応付けて返せる事実はない。通常の会話入力と承認回答の多重化、同時に複数の承認が待つ場合、遅延・再送・二重回答、旧世代への回答をどう扱うかも未設計である。同期 `PermissionRequest` hook を 600 秒待たせるだけでは双方向承認にならず、誤承認経路になる。未改修の Even アプリで相関付き応答ができない場合、P3-4 は現在の制約内では実現不能として止める必要がある。

## 2. 観点 1〜7 への所見

### 1. 差し替え点の妥当性

**既存の `claude` provider に相乗りする判断には同意する。** Even アプリから観測された provider 値が `codex` と `claude` だけで、第 3 の値を選ばせられる根拠がないためである。アプリが provider capability の列挙・選択を将来サポートする、または relay セッションと通常 Claude セッションを UI 上も完全に分離できる場合には、新 provider の方が列挙・認可・互換性の境界が明瞭になる。現時点では公開 provider 名は増やさず、内部では `legacy-claude` と `orchestrator-relay` を別の session kind として扱うべきである。

**`prompt()` 冒頭で resume を止めること自体には同意するが、3 分岐は網羅的でない。** 最低でも次の状態を分ける必要がある。

- 登録済み、relay 応答あり、sessionId・host・even-terminal boot epoch・handover generation が一致し、所有 relay が 1 つだけ: 現在の relay へ転送する。
- 登録済みだが relay が死んでいる、応答不能、または enqueue の確認前に切れた: unavailable として fail-closed。**resume へ fallback しない。**
- 登録済みだが boot epoch / generation / host が不一致: stale/foreign として拒否し、一覧から外す。
- 同じ sessionId に複数 relay が登録を要求: 生存中の所有者がいれば後発を拒否する。takeover は旧所有者の失効確認と新しい fencing token の発行後だけにする。
- 未登録でプロセスが生存: 現案どおり拒否する。
- プロセスはないが transcript がある: `legacy-claude` として even-terminal が所有していた明示的な記録がある場合だけ従来 resume を許す。オーケストレーター由来、別マシン由来、所有元不明は拒否する。
- sessionId が不存在・不正: 404 相当で拒否する。これも従来 resume へ流さない。

状態確認後に relay が落ちる TOCTOU もあるため、「登録を読んでから送る」だけでは足りない。転送は fencing token 付きの enqueue と受領確認を 1 操作として扱い、失敗時は G2 に明示的なエラーを返す必要がある。

また、安全境界は prompt だけでなく、sessions/history/SSE/interrupt に同じ active-registration 判定を適用する必要がある。`POST /api/interrupt` の request shape と現 provider での効果は資料にないため、正確な差し替え箇所は資料不足で判断できない。確認すべきなのは、どの sessionId にどう紐付き、relay セッション選択中に何を停止するかである。

### 2. 順序

**出力を先に検証し、承認を最後にする大枠には同意する。一方、提示された順序には安全上の逆転がある。**

- P3-1b で relay セッションを G2 に見せた時点から、利用者は入力と interrupt を送れる。P3-2 が未導入なら、その間に従来の `query({resume})` が動く危険がある。したがって「登録セッションを見せる前」に、未登録・stale・入力未有効の全状態を fail-closed にする routing firewall が必要である。
- P3-2 の「登録済みなら channel へ転送」を P3-3 より先に完成させると、まだ受信側のない経路へ入力を流すか、fake だけで成功扱いにすることになる。安全化を先にする判断は正しいが、**P3-2 を『拒否ガード』と『転送有効化』に分けるべき**である。

推奨順は、`P3-1a（relay 登録と出力 ingress）→ P3-2a（全 route の fail-closed guard）→ P3-1b（登録済みセッションだけ表示）→ P3-3（channel を隔離環境で受信可能にする）→ P3-2b（G2 入力の転送を有効化）→ P3-4（承認）` である。P3-1b は途中の観測ゲートであって最終スコープではなく、P3-2b までを同じ双方向 milestone として追跡する。

### 3. タスク分割の粒度

**現案の全タスクに共通して、成功時の成果物は書かれているが「何が起きたら変更を止めて question/review にするか」が完了条件にない。したがって、現状の記述のままでは §0.5.1 の 2 条件を満たさない。**

- P1: 粒度は妥当。ただし起動手順と実測を別成果物にせず、1 本の E2E 実測記録にまとめる。P2 が否定結果、ID 対応が一意でない、または disposable 環境で入力が競合した時点で共有 8765 へ進まない、を停止条件にする。
- P2: 小さく見えるが、P1 の可否を決める独立した破壊防止ゲートなので分ける意味がある。ただし「2 購読者」だけでなく、通知 fan-out、片方の切断、同時 `turn/start`、進行中の `turn/steer` と expectedTurnId まで 1 つの競合実測行列として扱う。
- P3-1a: **大きすぎる。** hook payload の未検証、14 種への変換、async の順序制御、relay daemon、登録・生存・fencing が 1 タスクに混在している。payload 契約実測、relay core、hook adapter の 3 つに分けるべきである。
- P3-1b: relay からイベントを受けて整形表示する 1 integration artifact とするなら妥当。ただし registered-only の sessions/history/SSE と 500 件上限時の縮約まで完了条件に含め、入力未有効時は必ず拒否する。
- P3-2: 3 分岐テストだけなら局所的だが、状態行列が不足し、P3-3 より先に置くための安全ガードと最終転送が混在している。P3-2a/P3-2b に分ける。
- P3-3: channel plugin 1 個に所有権を限定すれば妥当。対象認証で channel が使えない、同一 session への push が確認できない、または session/generation を検証できない場合は、fallback を作らず停止する。
- P3-4: **大きすぎる。** 未改修アプリでの応答可能性の実測、承認相関プロトコル、同期 hook、remote approval policy、再送防止を分離する。まず feasibility task を置き、成立した場合だけ実装へ進む。

### 4. hooks 経路の妥当性

資料には「even-terminal の 14 種の出力イベント」の名称・必須 field・順序契約がないため、対応表の網羅性は判断できない。確実に指摘できる不足は次のとおりである。

- Claude hook 一覧にある `UserPromptSubmit`、`PermissionDenied`、`PostToolBatch`、`SubagentStart`、`SubagentStop`、`SessionEnd` が現マッピングにない。すべてを表示すべきとは限らないが、drop する理由と、特に `SessionEnd` による登録解除の代替が必要である。
- `Stop` を本文/result と status の両方に使う一方、重複排除と順序が未定義である。`MessageDisplay` が full snapshot か delta かも未確認なので、本文の重複・欠落・逆順が起き得る。
- `PostToolUse` の `tool_result` をそのまま送ると、秘密情報・巨大出力・バイナリ相当の内容を G2 と 500 件リングへ流す危険がある。許可 field の抽出、サイズ上限、redaction、1 行要約を先に定義する必要がある。
- `async: true` の hook は互いに完了順が逆転し得る。relay 停止時には送信 timeout 中の hook process が増え、後続イベントだけ届くこともある。sessionId・generation・turn/tool ID・単調 sequence・event ID を持つ bounded queue と idempotency が必要である。
- `Notification(permission_prompt)` は表示用の非同期イベント、`PermissionRequest` は判断を返す同期 hook として別経路にする。同じ emitter 設定を共有すると、同期応答が無視されるか、非同期出力が承認を遅らせる。二者の相関 ID と重複表示規則も必要である。
- 600 秒 timeout を通常の待ち時間として使うと、relay 障害 1 回でセッションが最大 10 分停止する。短い relay health check、期限表示、切断時の即時 deny、期限切れ後の回答拒否を定義すべきである。
- hook の exit code 2 が各 hook 種別で「blocking error」「deny」「単なる失敗」のどれになるかは資料にない。この観点は資料不足で判断できない。同期/非同期、`PermissionRequest`/その他を分けて、終了コード 0/2、timeout、stdout 不正 JSON を隔離セッションで測る必要がある。
- hooks は global なので、単なる opt-in ファイルの存在確認だけでは worker への誤発火を防げない。enable record は sessionId・provider session ID・handover generation・relay ID・期限を含み、hook payload と全て一致した時だけ送信する必要がある。不一致時は stat 相当の局所 read だけで終了する。

### 5. 失敗モード

設計が壊れる順序は次のようになる。

1. **relay が落ちる:** registry は登録済みのまま残る → async hook の送信が timeout/欠落する → G2 の prompt は登録済み分岐へ入る → 死んだ relay への転送に失敗または入力が消える → 同期 PermissionRequest は最長 600 秒止まる。必要なのは lease/heartbeat、失効後の一覧除外、送信失敗の即時エラー、resume へ落ちない規則である。
2. **even-terminal が再起動する:** memory 上の registry と 500 件リングが消える → relay/hook/channel は旧 boot epoch を持ったまま動く → 再登録前は生存中未登録として拒否される（これは安全）→ stale 登録を復元すると旧 relay に誤配送する。新 boot epoch への明示的な再登録・再認証が完了するまで表示も入力も閉じる必要がある。token の再利用/rotation と relay 再接続の挙動は資料不足で判断できない。
3. **handover で世代交代する:** 新 generation が有効になる → 旧 relay の登録と pending approval が残る → G2 の入力/承認が旧 relay に届く → 旧セッションが処理するか、回答だけ消える → 新旧両方の出力が同じ session 表示へ混ざる。generation 切替を registry の CAS とし、旧 fencing token を即時無効化し、pending approval を deny で閉じてから新世代を公開する必要がある。handover 前後で sessionId が同一か変わるかは資料にないため、実測が必要である。
4. **同じ sessionId に relay が 2 つ付く:** 両方が登録成功する → 出力が重複または競合する → prompt/approval の consumer が不定になる → 同じ操作を二重実行、または別世代が承認を消費する。`(sessionId, host, generation)` に active owner を 1 つだけ許し、後発は conflict、takeover 後は単調 fencing token で旧 owner の write/ack を拒否する必要がある。

### 6. セキュリティ

**条件付きで受け入れられるリスク:** pidfile が所有者限定の権限である現状は、同一 OS user を信頼する単一ユーザー・ローカル試験に限れば暫定許容できる。開発用チャネルの読み込みフラグは secret ではないため argv に見えること自体が主リスクではない。手動 opt-in、絶対 path、内容の pin/hash 検証、対象 session 限定、終了時の無効化がある開発運用なら条件付きで許容できる。

**受け入れてはいけないリスク:** bridge の認証 token を長寿命 relay/approval token と共用すること、token を query/log/artifact へ出すこと、任意の development channel を名前解決して読み込むこと、G2 の次の自由文を pending approval へ暗黙に対応付けることは不可である。remote approval は少なくとも sessionId、generation、toolUseId、tool 名、入力 digest、decision 候補、期限、one-time nonce に束縛し、再送を拒否する。relay 切断・timeout・曖昧な応答は deny とする。外部送信、credential、破壊操作などをメガネだけで許可してよいかは別の policy gate とし、少なくとも初期版では remote allow の対象を allowlist で狭めるべきである。G2 と relay 間の transport confidentiality、および現在の bearer がどの API 権限まで持つかは資料不足で判断できないため、承認機能の可否判断前に確認が要る。

### 7. Codex 側（P1 / P2）

**P2 を別 app-server インスタンスで先に測る方針には同意する。ただし P1 と P2 は独立ではない。** `even-terminal codex` では TUI と even-terminal が同一 thread に関与するため、2 購読者可否と control 競合は G2→Codex 入力の前提である。P2 を P1 の gate に変更すべきである。

「起動コマンドを替えるだけ」は表示の試験仮説としては妥当だが、双方向の完了見積りとしては楽観的である。未検証なのは 2 番目の `thread/resume` だけでなく、どちらが `turn/start`/`turn/steer` を発行するか、通知が両 subscriber に同じ順序で届くか、一方の切断が thread に影響するか、5 種の ID のどれを G2 sessionId として固定するかである。P2 は passive subscriber の追加だけで成功扱いにせず、同一 disposable thread に対する二重 control、active turn 中の steer と expectedTurnId、切断・再接続まで測る。否定結果なら共有 `ws://127.0.0.1:8765` へ進まず、P1 を question にする。

## 3. タスク分割の修正案

| 順序 | 修正後タスク名 | 粒度・成果物の形 | 明示する停止条件 |
|---:|---|---|---|
| 1 | P2 Codex 二購読者・二制御者の隔離実測 | disposable app-server 上の競合行列をまとめた実測記録 1 本 | 2 番目が拒否、通知欠落、ID 不一致、二重 control が fail-closed でない場合は P1 へ進まない |
| 2 | P1 Codex G2 双方向 E2E | 起動 argv、ID 対応、G2→Codex→G2 の 1 往復を収めた実測記録 1 本 | P2 未通過、shared 8765 以外で再現不能、既存 thread へ誤配送した時点で停止 |
| 3 | P3-0 Hook/approval 契約実測（追加） | payload、順序、MessageDisplay の粒度、exit 0/2、timeout、stdout、PermissionRequest 応答を収めた fixture/report 1 本 | MessageDisplay が安全に縮約不能、または同期 decision の契約が確定しなければ実装へ進まない |
| 4 | P3-1a-R relay registry/core | active owner、lease、boot epoch、generation、fencing、event ingress を実装・検証する patchset 1 本 | relay 重複、stale write、再起動後の暗黙復元を拒否できなければ表示連携へ進まない |
| 5 | P3-1a-H async output hook adapter | P3-0 の確定 payload を ordered/bounded event に変換する hook adapter patchset 1 本 | worker 誤発火、順序逆転の未処理、secret/oversize result の未処理があれば停止 |
| 6 | P3-2a even-terminal routing firewall | sessions/history/SSE/prompt/interrupt を active registration で gate し、入力未有効時は 503/409 で閉じる patchset 1 本 | unknown/stale/foreign/transcript-only が resume・閲覧・interrupt 可能なら公開しない |
| 7 | P3-1b registered-only G2 display | relay event の整形、session 列挙、history/SSE、500 件上限の縮約を含む even-terminal patchset 1 本 | 未登録 session が見える、入力が従来 resume へ落ちる、relay 死亡を active 表示する場合は停止 |
| 8 | P3-3 channel ingress | relay から対象 generation の同一 session へ 1 回だけ push する channel plugin patchset 1 本 | 対象 auth 非対応、session 束縛不能、重複排除不能、custom channel load 不能なら fallback せず question |
| 9 | P3-2b G2 text forwarding enablement | fencing 付き enqueue/ack と channel 受信までを結ぶ routing patchset 1 本 | ack 不明、relay 切断、generation 不一致時に resume/fallback または入力消失が起きれば有効化しない |
| 10 | P3-4a G2 approval feasibility（追加） | 未改修 Even アプリで request ID 付き decision を往復できるかの実測記録 1 本 | 自由文しか返らない、相関 ID を保持できない、同時 request を区別できない場合は P3-4b を起票しない |
| 11 | P3-4b remote approval state machine | one-time decision、期限、deny fallback、policy allowlist、旧世代無効化を含む patchset 1 本 | replay、旧世代回答、曖昧回答、切断時 allow のいずれかが成立するなら release しない |

統合単位は、(A) P3-1a-R/H + P3-2a + P3-1b の「入力を閉じた出力観測」、(B) P3-3 + P3-2b の「通常テキスト双方向」、(C) P3-4a/b の「remote approval」の 3 つにする。(A) は途中の検証点であり代替ゴールにしない。(B) までを双方向 UX の本体として同じ milestone で完遂し、(C) は権限境界が別なので独立した security review gate を通す。

## 4. 着手前に測るべきこと（優先順）

1. **未改修 Even アプリの承認往復能力:** permission request をどう表示し、返送が `/api/prompt` の自由文だけか、request ID/decision を保持できるか、同時 request を区別できるか。できなければ P3-4 は制約内で不成立と判断する。
2. **relay session の全 route 契約:** disposable even-terminal で sessions/history/SSE/prompt/interrupt の request shape、sessionId の解決、processless session の列挙・切断時表示を測る。特に interrupt の対象と効果を確定する。
3. **hook 契約:** `MessageDisplay` の payload と snapshot/delta、Stop との順序・重複、各 hook の ID、async 完了順、exit code 2、timeout、stdout 不正 JSON、SessionEnd、PermissionRequest と Notification の相関を隔離セッションで測る。
4. **channel の対象環境適合:** 実際に使う認証方式で custom development channel が load でき、同一 session/generation に push でき、再接続・重複入力が fail-closed になるかを隔離セッションで測る。
5. **registry/fencing の故障注入:** relay kill、even-terminal restart、handover、同一 sessionId の二重登録を disposable 構成で順に起こし、stale owner が write/ack/approval できないことを測る。
6. **Codex P2 の subscriber/controller 競合:** 別 app-server の disposable thread で 2 resume、通知 fan-out、同時 turn/start、active turn の steer、片側切断・再接続を測る。これを P1 の gate にする。
7. **イベント量と縮約:** MessageDisplay と tool result を含む長い 1 turn で、500 件リングから重要な status/error/permission が押し出されない上限・coalescing・redaction を測る。
