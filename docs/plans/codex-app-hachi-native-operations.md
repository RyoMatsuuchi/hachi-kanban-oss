# Codex App orchestrator / Hachi worker native 通信の恒久運用設計

- status: implementation plan / live rollout 未承認
- task: `t_a57272ef804ce226`
- baseline: `main` / `efd2a33`（2026-08-19 確認）
- authority: `docs/contract.md` §52, §55–§68、`runbooks/orchestrator-playbook.md`

## 1. 結論

恒久運用では、看板・run・orchestrator request・outbox・steer delivery を唯一の
authority/audit plane とし、Codex App Server は同一 provider・同一 host の配送面にだけ使う。
native 配送を選べるのは、Hachi が起動・所有する durable App Server worker lane の active turn
だけである。既存の one-shot direct worker、bridge worker、Codex App 内の一時 subagent は
native worker lane とみなさない。

現行 v0.18 の基盤は再利用するが、次の四点を閉じる前に live rollout を有効化してはならない。

1. worker の実行 lane を communication rollout から分離し、run 作成前に固定する。
2. orchestrator の provider session は caller 自己申告ではなく、Codex が発行した
   `SessionStart` attestation から登録する。
3. App Server worker の質問回答は終了済み turn への `turn/steer` ではなく、同じ thread の
   新しい `turn/start` として配送する。
4. route claim と外部 I/O の直前に current config hash、binding、capability、cancel fence を
   同一 CAS で再検証する。

Codex App Server の公式 protocol は `initialize` 後に thread/turn を操作し、`thread/start` が
`thread.id` と root `sessionId` を返す。`turn/steer` は active turn と一致する
`expectedTurnId` を必要とし、active turn がなければ失敗する。そのため thread/session/turn は
推測せず応答と `thread/read` から取得する。

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)

## 2. 2026-08-19 時点の確認結果

| 項目 | 確認結果 | 判定 |
| --- | --- | --- |
| live `communication` config | 未設定 | effective rollout は `off` |
| 対象 task の run | one-shot direct Codex | native target ではない |
| source/target binding | なし | native route 不成立 |
| relay attempt / steer delivery | なし | 外部配送は未開始 |
| active orchestrator session | live session なし。保存済み session は stale | trusted source を新規登録する必要あり |
| offline / online doctor | overall `ok` | config 未設定時に native readiness 行が出ない不足あり |
| live side effect | なし | config、Supervisor、socket、worker を変更していない |

この状態での正しい route は Hachi の既存 direct 経路である。現在の terminal question は
終了済み direct run の handoff であり、active turn への native steer 対象ではない。

### 2.1 現行実装から閉じる gap

| 現行箇所 | gap | 実装先 |
| --- | --- | --- |
| supervisor の `nativeLaunchSelected` | communication rollout が native 配送可否だけでなく worker の起動 lane まで選ぶ | A/D: lane を独立して run へ固定 |
| core の `prepareNativeSteer` | rollout `off/observe/draining` では既存 native run も Hachi route を返し得る | A/D: open native attempt/run の route stickiness |
| App Server adapter の `inject` | 常に `turn/steer` のため、question で completed になった turn へ回答できない | A/C/D: question answer 専用 `turn/start` |
| orchestrator session 登録 CLI | `--provider-session-id` を caller が指定でき、その値から source binding を作れる | A/B: hook attestation を native trust の必須条件にする |
| supervisor messages stage | stage 開始時の config object を配送まで使い、外部 I/O 直前の host config 再読込がない | A/D: begin 直前の config reload + CAS |
| doctor | `communication` 未設定時は native readiness check 自体を出さない | B/E: effective `off` を常時表示 |

これらは live 設定の不足ではなく、canary 前にコードと契約で閉じるべき境界である。

## 3. lane と route の判定表

`workerLane` は run 作成前に `legacy-direct | legacy-bridge | codex-app-server` のいずれかへ固定し、
communication rollout の変更で途中から切り替えない。

| source → target / event | lane / 前提 | route | fail-closed 動作 |
| --- | --- | --- | --- |
| Codex App orchestrator → direct Codex worker | `legacy-direct` | 走行中 steer は非対応。必要なら exact stop 後の既存 restart | native binding を作らない |
| Codex App orchestrator → bridge Codex worker | `legacy-bridge` | 既存 Hachi bridge injection | native App Server へ fallback しない |
| Codex App orchestrator → Hachi-owned App Server worker | `codex-app-server`、active turn、全 gate 合格 | `turn/steer` | gate 不明・不一致なら外部 I/O 前に reject |
| 他 provider / 他 host → worker | 任意 | Hachi delivery | same-provider native を選ばない |
| rollout `observe` | native 候補 | route decision のみ記録し Hachi delivery | App Server I/O を行わない |
| rollout `draining/off` へ変化した既存 native run | native attempt あり | dispatching 以後は同じ native attempt を観測・回復 | Hachi へ silent fallback しない。新規 claim は停止 |
| direct worker → orchestrator question | terminal handoff | durable `orchestrator_request` を一件作成 | 回答は exact terminal/stop 後の再 dispatch |
| App Server worker → orchestrator question | turn completed、thread/run は保持 | durable `orchestrator_request` を一件作成 | 回答は同じ thread の新規 `turn/start`。`turn/steer` 禁止 |
| worker → orchestrator wake | open request あり | `orchestrator await` と既存 heartbeat は通知補助 | mirrored request / mirrored steer を作らない |
| done/review terminal handoff | 全 lane | supervisor finalize | native message attempt を作らない |
| Codex App 内の一時 subagent | App 内部 turn child | Codex App 内部だけ | Hachi durable worker/task として登録しない |

## 4. authority と配送の不変条件

### 4.1 一意性

- 人間または orchestrator の一つの意図につき、authority record は一つだけ作る。
- orchestrator → worker は `steer_delivery`、worker → orchestrator の質問は
  `orchestrator_request`、終端結果は run finalize が正本である。
- native attempt は authority record の delivery attempt であり、別の request/message ではない。
- idempotency key は task、run、source session generation、authority record id、message digest を含む。
- `recorded` より前の純粋な route 判定以外に、board 外だけで成立する配送を作らない。

### 4.2 exact binding

source binding は次を満たす場合だけ trusted とする。

- active orchestrator identity、session id、generation、provider=`codex` が current である。
- provider session id は Codex `SessionStart` hook の短命・一回限り attestation から得る。
- attestation は Hachi 管理の `0600` scoped file に置き、event、session id、cwd、発行時刻、
  hook executable/definition hash を署名または owner-only nonce とともに持つ。
- CLI の `--provider-session-id` や message payload による自己申告は legacy metadata としてのみ保持し、
  native eligibility には使わない。
- attestation は root orchestrator session だけを許し、subagent session は拒否する。

通常起動時の attach は二段階にする。

1. review 済み `SessionStart` hook が `session_id`、`cwd`、`source` を scoped helper へ標準入力で渡す。
   helper は Hachi API 経由で pending attestation を作り、短命の opaque handle だけを hook の
   `additionalContext` として root session に返す。
2. root orchestrator の register/session-start は provider session id を受け取らず、その handle を
   提示する。core は host、canonical cwd、provider、TTL、未消費、hook definition/executable hash を
   CAS 検証し、current stable identity/session/generation へ一回だけ attach する。
3. `startup` / `resume` の同一 session id は冪等、`compact` は新規 binding を作らない。候補が複数、
   stale、既消費、cwd 不一致なら自動選択せず拒否する。

trust boundary は review 済み local hook config、同一 OS user/host、owner-only Hachi state までである。
local account 自体の侵害はこの protocol で救済できないため、doctor は hook/config/helper hash の drift を
fail-closed で報告する。

Codex hooks は `SessionStart` で provider-generated `session_id` を渡す。一方、公開されている
Codex 環境変数には session/thread id の安定した契約がないため、非公開 env や transcript 形式には
依存しない。hook の追加・変更は Codex App の live behavior 変更なので、実装と template の生成は
可能でも実際の導入は canary 承認 gate に置く。

target binding は Hachi-owned App Server 起動応答から取得した次の exact 値を run に固定する。

- socket endpoint と owner process/tree identity
- `thread.id`、root `sessionId`、current `turn.id`
- App Server version、runtime capability、request/notification schema checksum
- task id、run id、worker lane、host identity、config hash、cancel fence

target の turn が変わるたびに CAS 更新し、古い turn id は再利用しない。

### 4.3 capability と config drift

- `initialize` の protocol/capability と生成済み JSON schema を version ごとに検証する。
- undocumented socket、method、notification、transcript field は利用しない。
- route decision、claim、外部 I/O 直前の begin の三地点で live config を再読込する。
- begin は expected config hash、source/target binding revision、capability hash、run revision、cancel
  fence を一つの transaction/CAS で比較する。
- begin 前の drift は `rejected` とし外部 I/O を行わない。
- begin 後に応答が欠落した場合は `uncertain` とし、同じ意図を Hachi delivery へ送り直さない。

### 4.4 cancel / recovery / replacement

- cancel intent、transport acceptance、session observation、worker acknowledgement、process/tree stop を
  別の事実として記録する。
- `turn/interrupt` の成功は exact session/process tree stop の証拠ではない。
- App Server adapter が exact-stop capability を提供できない間は、cancel 後の同一 worktree replacement
  を自動起動しない。`needs-manual` で停止する。
- lease expiry、ownerRunId 不在、socket EOF、turn completed のいずれも単独では stop 証拠にしない。
- `dispatching`、`transport_accepted`、`session_observed`、`uncertain` の attempt は同一 route 上でのみ
  reconcile し、別 route へ再送しない。

## 5. delivery state と監査項目

標準遷移は次とする。

```text
route_decided
  -> recorded -> claimed -> dispatching
  -> transport_accepted -> session_observed -> acknowledged
  -> rejected | uncertain
```

- `route_decided`: 候補 route、選択理由、非選択理由、effective rollout、worker lane
- `recorded`: authority record、idempotency key、payload digest
- `claimed`: actor provenance、orchestrator session/generation、claim token、claim expiry
- `dispatching`: 外部 I/O 開始時刻、expected CAS 一式
- `transport_accepted`: App Server request id と accepted thread/turn id
- `session_observed`: `thread/read` または notification で確認した exact session/turn 状態
- `acknowledged`: worker が対象 steer/answer を処理した durable acknowledgement
- `rejected`: 外部 I/O 前の理由付き拒否、または App Server の明示的非受理
- `uncertain`: 外部 I/O 後に受理・適用を確定できない状態

全 event に task/run、source/target binding revision、provider/host、config/capability/schema hash、cancel
fence、actor provenance、時刻を含める。socket path や credential は redacted reference とし、secret
本文を event/detail/log に保存しない。単一の `applied: true` で複数段階を潰さない。

## 6. 質問、steer、handoff の分離

### 6.1 orchestrator → worker steer

active turn が exact target binding と一致する場合だけ `turn/steer(expectedTurnId)` を使う。
request 応答だけを acceptance とし、worker 適用は notification/ack で別途確定する。

### 6.2 worker → orchestrator question

question は常に durable `orchestrator_request` を先に一件だけ作る。native wake を将来追加する場合も、
同じ request id に紐づく通知 attempt とし、別 request や `steer_delivery` を複製しない。

- direct/bridge: 既存の terminal handoff と再 dispatch を維持する。
- App Server: question turn を completed にし、thread と Hachi run を `question_awaiting` で保持する。
  回答時は `thread/read` で exact idle、request claim、cancel fence、session を CAS 確認し、同じ thread に
  `turn/start` で回答を渡す。受理した新 turn id を target binding へ CAS 更新する。
- `turn/start` の応答喪失は `uncertain`。同じ回答を `turn/steer` や Hachi restart へ再送しない。

### 6.3 terminal handoff

`done` / `review` は supervisor finalize の入力であり、native delivery ではない。run close、task transition、
cleanup request の既存 two-party gate を維持する。

## 7. rollout off の readiness

config 未設定を黙って診断対象外にせず、doctor は常に次を表示する。

```json
{
  "effectiveRollout": "off",
  "nativeSideEffectsAllowed": false,
  "sourceBindingRequired": false,
  "targetBindingRequired": false,
  "status": "ok"
}
```

加えて read-only の `hachi communication readiness --task <id> --json` を追加する。これは以下を表示し、
DB、config、socket、process、task state を変更しない。

- effective config と canonical hash、rollout、deterministic canary cohort
- resolved provider、worker lane と lane 選択理由
- source trust/attestation の有無と不足項目（値そのものは redacted）
- expected target capability/schema/host と既存 target binding
- open authority record、attempt、native run、cancel/replacement fence
- `wouldRoute` と gate ごとの pass/fail、`sideEffectsPerformed: false`

off では App Server の存在を必須にせず `ok` とする。ただし live 有効化した場合に不足する項目は
`advisory` として可視化する。これにより off のまま readiness と drift を検証できる。

## 8. 実装子タスク案

以下は review 単位の提案であり、この計画タスクでは board へ起票・promote しない。承認後に専用
worktree、`status=triage`、`outcome=review` で作成する。

依存 DAG:

```text
A core authority/state
  ├─> B CLI / trusted attestation / readiness
  └─> C App Server adapter / fake server
B + C ─> D supervisor routing / recovery
D ─> E integration tests / runbook
```

### A. Core: native authority と CAS 契約

- scope: `packages/core`
- 追加: trusted attestation provenance、immutable worker lane、binding revision、config/capability hash、
  question answer delivery、route/audit state、begin CAS、migration v21
- 完了: stale generation/config/cancel/binding が外部 I/O 前に拒否され、accepted/uncertain が別 route に
  戻らない unit test
- 境界: 凍結中の `packages/core/src/types.ts` が必要なら変更せず orchestrator に契約更新を依頼する

### B. CLI: trusted source registration と off-readiness

- scope: `packages/cli` と配布用 hook helper/template
- 追加: `SessionStart` attestation の生成・一回消費、caller-supplied session の untrusted 化、常時表示する
  doctor check、pure `communication readiness`
- 完了: forged/stale/replayed/subagent attestation の拒否、config 未設定 off の成功、全 dry-run が副作用ゼロ
- 境界: hook を user/live config へ実際に導入しない

### C. Adapter: exact App Server session/turn protocol

- scope: `packages/adapters`
- 追加: exact initialize/schema probe、thread/session/turn binding、active turn `turn/steer`、question answer
  `turn/start`、receipt/notification reconcile、redacted audit result
- 完了: fake App Server で accept/observe/ack/reject/timeout/connection-loss/version mismatch を検証
- 境界: `turn/interrupt` を exact-stop と広告しない

### D. Supervisor: lane 固定、route stickiness、recovery

- scope: `packages/supervisor`
- 追加: communication rollout と独立した worker lane 解決、launch-time run binding、I/O 直前 config 再読込、
  begin CAS、question/steer/finalize 分離、draining/off 中の既存 attempt reconcile
- 完了: direct/bridge/native の判定表、drift、cancel、uncertain、restart/replacement fail-closed の stage test
- 境界: live config/Supervisor を変更・再起動しない

### E. Integration: fake E2E、read model、運用手順

- scope: `packages/testing`、関連 read model、`docs/contract.md`、runbook
- 追加: fake App Server の end-to-end、off/observe 非回帰、監査表示、canary/rollback checklist
- 完了: typecheck/test/lint、off で App Server I/O ゼロ、duplicate request/delivery ゼロ、監査 event 全段階
- 境界: contract 更新は orchestrator 所有で先行または統合時に行う

各 task body には専用 `cwd`、対象 package、変更禁止領域、検証コマンド、`handoff-policy: no-commit`
を明記する。A/B/C は並列着手せず、A の public contract が review 済みになってから B/C を開始する。

## 9. 別承認の canary 手順

ここから先は実装完了後の別承認 gate であり、今回は実行しない。

1. 全子タスクを review・統合し、typecheck/test/lint と fake App Server E2E を成功させる。
2. live config 未変更のまま readiness を実行し、対象 task 一件、source identity/session/generation、
   `workerLane=codex-app-server`、expected config hash を保存する。
3. Codex `SessionStart` hook の定義と executable hash を人間が確認して導入する。既存 session は
   後付けで trusted にせず、新しい orchestrator session から attestation を取得する。
4. active orchestrator と exact provider session の trusted binding を登録し、再度 readiness を行う。
5. 人間の明示承認後だけ live config を `canary` にし、min version、same-host、exact cohort を指定する。
   Supervisor 再起動後に config readback、canonical hash、doctor を確認する。
6. harmless な canary worker 一件を起動し、steer 一件だけを送る。
   `route_decided → transport_accepted → session_observed → acknowledged` と、Hachi fallback ゼロを確認する。
7. worker question 一件、orchestrator answer 一件を試し、request が一件、新しい turn が一件、duplicate
   steer/restart がゼロであることを確認する。
8. cancel/replacement の fail-closed は fake E2E を正本とし、exact-stop 未実装の実機で replacement を
   強行しない。

## 10. rollback 手順

1. 新規 native claim を止めるため rollout をまず `draining` に変更し、再起動と config readback を行う。
2. open native run と `dispatching` / accepted / uncertain attempt を列挙する。それらを Hachi route へ
   戻さず、同じ native route で観測・手動回復する。
3. open attempt/run がゼロになったことを監査面で確認してから rollout を `off` に変更し、再起動と
   doctor で確認する。
4. exact owner/process-tree stop 証拠なしに socket、process、worktree、runtime resource を削除しない。
5. source hook は active session handoff と binding expiry の後にだけ無効化する。
6. config hash drift、readback failure、uncertain が一件でもあれば rollback 完了を宣言せず
   `needs-manual` で停止する。

## 11. 現フェーズの承認境界

本計画で許可・実施したのは read-only 調査、設計文書、off の診断とテストだけである。次はすべて未実施で、
個別のユーザー承認が必要である。

- board 上の子タスク作成、依存 link、promote
- Codex hook の user/live config への導入
- `$HACHI_KANBAN_HOME/config.json` の変更
- Supervisor 再起動
- native worker の実機 canary
- production rollout、commit、push、PR
