# Shared runtime usage authority / isolated canary contract

Status: **review proposal**。本書は B0-R の source 調査と後続 acceptance を凍結する設計成果物であり、
`docs/contract.md`、producer、reader、guard、host runtime の採択・実装・publication は行わない。

## 0. 調査境界と結論

### 0.1 固定した基準

| 対象 | task 指定 ref | 調査時の `HEAD` | 調査時の `origin/main` | drift |
|---|---|---|---|---|
| hachi-kanban | `3253bb8dd0c0a89596e94a20171f47c18ec92d88` | 同左 | 同左 | なし |
| legacy-hermes | `70c97f770bc821143f96886d7006bbab8749450d` | 同左 | 同左 | なし |
| installed Codex CLI | `0.144.1` | `codex-cli 0.144.1` | N/A | version drift なし |

source ref は調査中に更新していない。`pull`、`fetch`、`rebase`、`merge`、`checkout`、
`reset` は行っていない。task log、transcript、利用者データ、外部 tenant repo、live runtime、
browser は読んでいない。live/synthetic canary、process 操作、network 送信、DB/board/config mutation、
commit/push も行っていない。

installed Codex の generated locator は次の再生成結果を指す。成果物へ schema bundle は持ち込まない。

```text
codex app-server generate-ts --experimental --out <tmp>/ts
codex app-server generate-json-schema --experimental --out <tmp>/json

以後の codex-generated:ts/... は <tmp>/ts/... の file:line
```

補助確認では、同じ installed binary から2回生成した
`codex_app_server_protocol.v2.schemas.json` の raw SHA-256 はそれぞれ
`4e3aeabd...` と `fa821921...` になった一方、`jq -S` 後の SHA-256 は双方
`2665d486...` で一致した。差分は definition の object key order だった。
したがって raw bundle hash の不一致を usage schema の意味 drift とは扱わない。ただし Hachi の pin は
raw bytes の再現可能性を前提にし (`packages/adapters/src/schema/codex-app-server-v2.ts:76-94`)、
installed protocol の `InitializeResponse` 自体は schema version/checksum を持たない
(`codex-generated:ts/InitializeResponse.ts:6-20`)。Hachi は response に任意 field が無ければ
locally expected value を capability として返す (`packages/adapters/src/codex-app-server-rpc.ts:756-777`)。
この hash を running usage の runtime attestation へ昇格しない。

`verify: none` のため test suite は実行しない。完了検査は本ファイルだけが変更されたことと
`git diff --check` に限定する。

### 0.2 authority class

| class | 本書での意味 | hard action |
|---|---|---|
| `exact` | provider の parent request usage semantics と全必須 field が、同じ atomic sample、同じ runtime generation、同じ effective model に bind され、fresh readback と replay 検査を通る | 許可候補。B0-S/B0-E/B0-H/B1 の host-finalize 後に限る |
| `derived` | finalized record の選択・差分・集計など、明示した規則で再構成した値。対象時点または atomic binding が source 自身にない | 禁止 |
| `advisory` | UI/telemetry 用の途中値、意味・完全性・ordering・binding のいずれかが未証明 | 禁止 |
| `unavailable` | field/source が無い、または存在しても hard predicate の全必須 binding を作れない | 禁止 |

「wire type が exact」は、その payload を hard authority と認める意味ではない。欠測同士の一致、
別時点の exact 値の join、定数 window、最新 finalized response、`running_stats`、
`thread/read.updatedAt` を `exact` へ丸めない。

### 0.3 provider verdict

| provider | current source verdict | 理由 | hard action |
|---|---|---|---|
| Codex | **`unmeasured`** | `thread/tokenUsage/updated` は `threadId/turnId/total/last/modelContextWindow` を持つ有力な protocol candidate だが、`contextModel/turns/counterEpoch/observedAt/sourceAttestationId` と runtime generation/PID binding が無い。`thread/read` に usage readback はなく、current Hachi は notification を typed 化・保存していない | 禁止。B0-CX が全 acceptance を pass し、後続を host-finalize するまで禁止 |
| Claude | **`unmeasured`** | native collector は最新 assistant 応答groupの最大output行を完了相当として選び、context を derived 再構成する。shared `running_stats` は running request 中に出るが cumulative/advisory で model/window/epoch/generation binding が無い | 禁止。B0-CC が新しい exact source を立証できなければ正式に unmeasured のまま |

これは「source が無いので設計不能」という question ではない。**unmeasured は正式な結論**であり、
当該 provider の threshold crossing、steer、cancel request、stop/restart、replacement を usage だけから
発行してはならない。既存の独立した max-runtime/stall/cancel 契約は変更しない。

## 1. Current source fact table

### 1.1 Codex candidate と current Hachi surface

| source / field | current fact | 更新時点 | 証拠 | 強度 |
|---|---|---|---|---|
| `thread/tokenUsage/updated` | server notification union に存在する | provider notification 発行時 | `codex-generated:ts/ServerNotification.ts:77` | wire method の存在は exact。usage authority は未成立 |
| notification payload | `threadId`, `turnId`, `tokenUsage` だけを持つ | 同上 | `codex-generated:ts/v2/ThreadTokenUsageUpdatedNotification.ts:4-6` | wire shape は exact。generation/model/sequence/time は unavailable |
| `tokenUsage` | `total`, `last`, nullable `modelContextWindow` | 同上 | `codex-generated:ts/v2/ThreadTokenUsage.ts:4-6` | wire shape は exact。`last` が parent-request context と等しい意味は schema にない |
| breakdown | `totalTokens/inputTokens/cachedInputTokens/outputTokens/reasoningOutputTokens` | 同上 | `codex-generated:ts/v2/TokenUsageBreakdown.ts:5` | provider numeric fields。内数・reset・compaction semantics は canary 未証明 |
| `thread/read` params | `threadId` と optional `includeTurns` | read request 時 | `codex-generated:ts/v2/ThreadReadParams.ts:5-9` | exact |
| `thread/read` response | `Thread` だけを返す | read response 時 | `codex-generated:ts/v2/ThreadReadResponse.ts:4-6` | exact |
| `Thread` / `Turn` | thread は identity/status/updatedAt/turns、turn は items/status/start/completion/duration を持つが token usage を持たない | read response 時 | `codex-generated:ts/v2/Thread.ts:13-108`, `codex-generated:ts/v2/Turn.ts:9-37` | `thread/read` は usage の独立 readback にならない |
| compaction / reroute | compaction は `threadId/turnId`、reroute は `fromModel/toModel/reason` を別 notification で返す | 各 event 時 | `codex-generated:ts/v2/ContextCompactedNotification.ts:5-8`, `codex-generated:ts/v2/ModelReroutedNotification.ts:4-6` | event 自体は exact。usage payloadとの atomic join/counter epoch は unavailable |
| Hachi schema pin | Hachi の最小 fixture は initialize/thread/start/turn/start/thread/read/steer/interrupt だけ。token usage notification を含めない | build 時固定 | `packages/adapters/src/schema/codex-app-server-v2.ts:1-25`, `packages/adapters/src/schema/codex-app-server-v2.ts:27-74` | usage surface は未typed |
| Hachi RPC notification | `method: string`, `params?: unknown` のまま callback へ渡す | socket frame 受信時 | `packages/adapters/src/codex-app-server-rpc.ts:15-20`, `packages/adapters/src/codex-app-server-rpc.ts:573-610` | opaque |
| Hachi notification consumer | callback は native message key が params 内にあるかだけを再帰探索する | notification callback 時 | `packages/adapters/src/codex-app-server.ts:293-318`, `packages/adapters/src/codex-app-server.ts:472-484` | token usage は未実装・未保存 |
| Hachi `thread/read` | required Thread fieldsを検証し raw objectを返す。status/active turn以外の usage parse はない | bounded read 時 | `packages/adapters/src/codex-app-server.ts:157-172`, `packages/adapters/src/codex-app-server.ts:646-693`, `packages/adapters/src/codex-app-server.ts:900-908` | usage は opaque/unavailable |
| bridge generation field | `/api/prompt` の `runtimeGenerationAttestation` はadapterで `unknown` として受け、object形状だけ確認して運ぶ | launch response時 | `packages/adapters/src/session.ts:19-32`, `packages/adapters/src/session.ts:224-249` | generation planeのtyped validation前境界。usage fieldではない |
| bridge `/api/messages` | entries は `Record<string, unknown>[]`、state は unknown | poll 時 | `packages/adapters/src/session.ts:298-344` | opaque |
| bridge transcript | `running_stats` を telemetry として除外する | transcript 構築時 | `packages/adapters/src/session.ts:565-599` | advisory のまま |
| shared Codex running counter | turn 開始時に input/output を0へ戻し、10秒 timerを開始する | parent turn start | 旧システムの escrow パッチ実装 | advisory |
| shared Codex counter 更新 | input/output は `turn/completed.turn.usage` で初めて更新される | turn completion | 旧システムの escrow パッチ実装 | running parent request 中は0のままになり得る |
| shared Codex result | completion 後に result を発行し `turns:1`, `costUsd:0` を入れる | turn completion | 旧システムの escrow パッチ実装 | finalized/advisory。parent lifetime turns ではない |

Codex の静的 schema は候補を補強するが、current bridge producer はその notification を usage source として
処理していない。`turn/completed.turn.usage` も generated `Turn` 型には存在せず、欠測時は0へ落ちる。
従って current shared Codex の running parent request に hard authority はない。

### 1.2 Claude collector と shared producer

| source / field | current fact | 更新時点 | 証拠 | 強度 |
|---|---|---|---|---|
| native file binding | Claude は launch 時の native session UUID と完全一致する file を読む | file scan 時 | `packages/adapters/src/native-usage.ts:1-12`, `packages/adapters/src/native-usage.ts:172-185` | session file binding は exact。runtime generation bindingではない |
| response grouping | assistant usage rowを `(requestId,message.id)` でgroup化し、最大 output の1行を最終行として採る | collector read 時 | `packages/adapters/src/native-usage.ts:534-552`, `packages/adapters/src/native-usage.ts:578-615` | derived。running requestの完了markerではない |
| parent context | sidechainを除き、最新 group の最後の message iteration input sideを `contextTokens` とする | collector read 時 | `packages/adapters/src/native-usage.ts:345-401`, `packages/adapters/src/native-usage.ts:484-530` | derived。running requestの未完了/完了をatomicに区別しない |
| parent model | 同じ選択済み messageから得られた場合だけ `contextModel` を付ける | 同上 | `packages/adapters/src/native-usage.ts:311-314`, `packages/adapters/src/native-usage.ts:524-530` | 選択行内では同時点。running generation/PIDは未bind |
| context window | Claude transcriptには window が無く、定数逆引きを禁止して省略する | collector result 構築時 | `packages/adapters/src/native-usage.ts:391-401`, `packages/core/src/usage.ts:56-62` | unavailable |
| direct adapter status | incomplete logを measured にしないため process exit file 後だけ collectorを呼ぶ | direct run terminal 後 | `packages/adapters/src/direct-claude.ts:229-257` | terminal-only |
| orchestrator usage CLI | 同じ collectorをread-onlyで流用し、判定不能は exit 0、提案であって自動実行しない | CLI invocation時 | `packages/cli/src/commands/orchestrator-usage.ts:1-10`, `packages/cli/src/commands/orchestrator-usage.ts:94-107` | derived/advisory。hard action sourceではない |
| shared Claude running stats | turn startで countersを0にし、10秒 timerを開始する | parent query start | 旧システムの escrow パッチ実装 | advisory |
| shared Claude input/output | SDK `message_start`ごとに input+cache read+cache creationを累積し、`message_delta` outputを更新する | stream event 時 | 旧システムの escrow パッチ実装 | running telemetry。parent/tool/advisor semantics、gap/resetは未証明 |
| shared Claude emission | duration/input/outputだけを `running_stats` として送る | 10秒 timer | 旧システムの escrow パッチ実装 | advisory。model/window/turn/epoch/time/generation無し |
| shared Claude result | final result の modelUsage合計、num_turns、duration、costを送る | SDK result 時 | 旧システムの escrow パッチ実装 | finalized result。running parent contextではない |

### 1.3 runtime generation/model plane

| source | current fact | 更新時点 | 証拠 | 強度 |
|---|---|---|---|---|
| §75 scope | generation classification は usage/context guardを変更せず、B0/B1を明示的に実装外とする | contract adoption時 | `docs/contract.md:4496-4502`, `docs/contract.md:4700-4705` | exact contract boundary |
| identity | provider/lane/runtimeKeyに加え generation/model、writer/runtime PID+OS start、nonce、endpointを持つ | launch attestation時 | `docs/contract.md:4761-4788` | exact generation identity |
| one writer/path | providerごとのlane、canonical path、exact lifecycle ownerを固定する | writer lifecycle | `docs/contract.md:4707-4716`, `docs/contract.md:4741-4751` | exact generation authority |
| atomic publication | mode 0600 temporary fileへ書き、file fsync→atomic replace→directory fsync | status publish時 | `docs/contract.md:4734-4743`, 旧システムの外部 runtime 世代ステータス実装 | exact generation publication |
| TTL | status/attestation 180s、transition 24h。heartbeatは60s以下 | publish/heartbeat時 | `docs/contract.md:4841-4844` | exact generation freshness |
| model source | Codexは exact child `threadStartFull` applied model、Claudeは SDK init effective modelだけ | provider session init | `docs/contract.md:4867-4871`, 旧システムの escrow パッチ実装 | exact generation/model plane |
| external writer request | generation descriptorと runtime modelを helperへ渡し、helperが双方の PID/startをreadbackする | attestation publish時 | 旧システムの escrow パッチ実装, 旧システムの外部 runtime 世代ステータス実装 | exact generation plane。usage counter無し |
| launch binding | response objectとstatus file内objectをscalar exact matchし、launch CASへ保存する | launch成功CAS時 | `docs/contract.md:4943-4953` | exact generation plane。別時点usageのbind代用不可 |

§75 object に usage fieldsを足したり、別時点の `running_stats` と時刻近接でjoinしてはいけない。
generation/model attestation が exact でも、usage payload自身が同じ identity を持たなければ usage authorityは
`unavailable` のままである。

## 2. Provider field availability matrix

セルの `D` は derived、`A` は advisory、`G` は exact generation plane **だけ**、`U` は hard authority として
unavailable を表す。`U(candidate)` は static protocolに候補fieldはあるが、意味またはbindingが未成立である。

| required field | Codex current | Claude current | hard predicateでの判定 |
|---|---|---|---|
| `contextTokens` | `U(candidate)`: `tokenUsage.last.inputTokens/totalTokens` はあるがどれが parent-request contextか未定義。shared counterは completionまで0 | `D`: 最新選択済み message input side。shared counterは `A` cumulative | 両provider unavailable |
| `contextWindowTokens` | `U(candidate)`: nullable `modelContextWindow` はあるが context model と非atomic | `U`: transcript/running_statsとも欠測 | 両provider unavailable |
| `contextModel` | `U`: 別notificationのreroute、別planeのgeneration model、direct log `turn_context` はある | `D/G`: finalized message modelまたはSDK init model。usage sampleと非atomic | 両provider unavailable |
| `turns` | `U`: usage notificationに無し。bridge resultの固定 `1` はparent lifetimeではない | `D`: finalized group/`num_turns`。running statsに無し | 両provider unavailable |
| `counterEpoch` | `U` | `U` | 両provider unavailable |
| `observedAt` | `U`: notificationにsource timestamp無し。thread `updatedAt` は別snapshot | `U`: running_statsに無し。native row timestampはfinalized row | 両provider unavailable |
| `sourceAttestationId` | `U` | `U` | 両provider unavailable |
| writer `PID/start` | `G` | `G` | usage sampleへatomic bind不可 |
| `provider/lane/runtimeKey/generationId` | `G` | `G` | usage sampleへatomic bind不可 |
| parent request identity | thread/turn IDはcandidateにあるが generation/counter epoch無し | session IDはあるが running request/message IDのcomplete binding無し | 両provider unavailable |
| atomic same-generation sample | `U` | `U` | **No / No** |

Codex direct native collectorは累積 counter差分を最後のcontextとして使い、counter減少時にbaselineを0へ戻す
(`packages/adapters/src/native-usage.ts:747-843`)。これは有用な derived collectorだが、resetを識別する
`counterEpoch`を発行せず、shared writer PID/start/generationともbindしない。shared hard authorityへ流用しない。

## 3. Authority / fail-closed counterexamples

| tempting inference | 反例 | required result |
|---|---|---|
| `last.inputTokens` が current context | cached token の内数、outputとの関係、compaction後の意味がschemaにない | B0-CXで parent request semanticsを実測できなければ unmeasured |
| `total` と `last` の差分でturn数/epochが分かる | notification欠落、reconnect、reset、resume、compactionで同じ数列を作れる | source sequence + counterEpochが無ければhard action 0 |
| `modelContextWindow` があればwindowはexact | nullableかつcontextModel無し。reroute前windowとreroute後usageをjoinできる | 同一sampleのmodel/windowまたはcanary済みatomic join必須 |
| §75 `runtimeModelId` をusageのmodelとみなす | 同一generation内で別model attestationを持てる。§75自体もmodel rerouteをusage counterへbindしない | usage sampleのfull identityに `contextModel` を含めexact match |
| `thread/read.updatedAt` がusage observedAt | thread mutation時刻でありusage notificationのsource時刻ではない | writerがcallback receiptを明示し、source ordering/TTLを別fieldで持つ |
| `thread/read` とnotificationのthread/turn IDが同じならusage readback一致 | read responseにusage field自体がない | usageの独立readback無しはfail |
| latest finalized Claude responseがrunning requestのcurrent context | tool/API call中は次のmessageが未finalizeで、collectorは直前responseを返す | running sourceが無ければunmeasured |
| Claude `running_stats.inputTokens` がcontext | 複数 `message_start` を累積し、advisor/tool/subagent/compaction semanticsが無い | absolute値もgrowthもadvisory |
| 欠測fieldが両sourceで同じならmatch | missing==missingはidentity一致ではない (§75も同じ規則) | 必須field欠測はsample全体invalid |
| configured/model overrideとruntime modelが同じ | request echoとeffective runtime readbackは別 | §75 exact readbackとusage identityのscalar exact match |
| writer PIDが同じならsame generation | PID reuse、process restart、endpoint replacementがある | PID + OS start + generationId + nonce + endpoint exact match |
| schema hash/versionが合うのでnotification完全 | current initializeはschema checksumを必須報告せず、Hachiはlocal expected値を使える | runtime sample自体のversion/hash/field validationが必要 |
| stale sampleでもthreshold超過なら安全側 | compaction/reset/model reroute後の旧高値で不要なcancelを起こす | TTL、revision、epoch、generation、current parent requestの全一致。1つでも不明ならaction 0 |

## 4. Recommended sibling usage attestation

### 4.1 方式比較

| 案 | 後方互換 | one-writer / atomicity | TTL / replay | reader fail-closed | 判定 |
|---|---|---|---|---|---|
| §75 `ExternalRuntimeGenerationStatusV1` を拡張 | unknown key rejectとschema hashを変えるためproducer/consumer同時移行が必要。generation terminal readerにもusage churnが波及 | generation heartbeatとhigh-frequency usage revisionが同じCASを奪い合う | usage短TTLとterminal 24h historyが同居 | usage不具合でgeneration file全体invalidになり、A0/A1分類を壊す | 不採用 |
| domain-separated sibling status | §75 path/schema/hash/readerを不変に保てる。providerごと段階採択可能 | 同じ lifecycle ownerが別pathへ1 documentをatomic publish。sample内にfull §75 identityを埋める | usage専用の短TTL/revision/epochを持てる | usage invalidをaction 0へ閉じつつgeneration terminal evidenceを維持 | **推奨** |

推奨は `$HERMES_HOME/<lane>/external-runtime-usage-attestation.json` を新しいdomainとして追加する案である。
repository authorityとone-writer lifecycle ownerは§75と同じ legacy-hermes / exact even-terminal ownerにするが、
lock、revision、schema hash、TTL、canonical digest、reader stateを§75から分離する。

### 4.2 B0-S が採択する場合の shape

次は B0-S の入力案であり、本taskで positive contractとして採択しない。B0-CX/B0-CCをpassしたprovider/sourceだけを
`sourceKind` enumへ入れる。passしないproviderは `state="unmeasured"` だけを許す。

```ts
interface ExternalRuntimeUsageStatusV1 {
  schema: "external-runtime-usage-attestation/v1";
  schemaVersion: 1;
  schemaHash: string;
  provider: "codex" | "claude";
  lane: "even-shared" | "even-claude";
  runtimeKey: string;
  revision: number;
  state: "measured" | "unmeasured";
  sample: ExternalRuntimeUsageSampleV1 | null;
  unmeasuredReason:
    | "source-unavailable"
    | "source-gap"
    | "parent-request-unbound"
    | "generation-mismatch"
    | "model-unbound"
    | "window-unavailable"
    | "counter-reset"
    | "compaction-order-unknown"
    | "reroute-order-unknown"
    | null;
  observedAt: number;
  ttlMs: 30000;
  expiresAt: number;
}

interface ExternalRuntimeUsageSampleV1 {
  version: 1;
  sourceKind: AcceptedUsageSourceKind;
  sourceAttestationId: string;
  sourceSequence: number;
  parentRequest: {
    providerSessionId: string;
    parentThreadId: string | null;
    parentRequestId: string;
  };
  contextTokens: number;
  contextWindowTokens: number;
  contextModel: string;
  turns: number;
  counterEpoch: string;
  runtimeIdentity: ExternalRuntimeGenerationIdentityV1;
  observedAt: number;
  ttlMs: 30000;
  expiresAt: number;
}
```

normative rules proposal:

1. `sample` は listed fieldをすべて同じ in-memory captureから1 documentへ入れる。optional化しない。
   `state="unmeasured"` では `sample=null`、reason非nullとし、偽0を作らない。
2. `runtimeIdentity` は§75 identityの全fieldをexact copyし、
   `runtimeIdentity.runtimeModelId === contextModel` を必須とする。readerはlaunch binding、current §75
   attestation、fresh writer/runtime PID+OS start、endpointをscalar exact matchする。
3. cross-file atomicityを推測しない。usage sample内のfull identityとdurable launch bindingが一致しなければ拒否する。
   §75 statusのheartbeatで進んだtop-level revision/digestをusage sampleへ固定して、正常な後続heartbeatを
   mismatchにしてはならない。model rerouteでlaunch bindingのfull identityと一致しなくなった場合は、
   このv1では再bindを推測せずunmeasuredへ倒す。
4. `AcceptedUsageSourceKind` はcanaryをpassしたsourceだけのclosed enumとする。`sourceAttestationId` は one writerが allowlisted source tuple
   `(sourceKind,parentRequest,counterEpoch,sourceSequence,usage fields,runtime identity)` のcanonical bytesから作る
   domain-separated SHA-256 とする。raw prompt/response/transcriptをhash入力・保存しない。
   Codexなら`parentThreadId=threadId`, `parentRequestId=turnId`を候補とし、Claude mappingはB0-CCで
   exact source IDが立証できた場合だけB0-Sが固定する。
5. `sourceSequence` はproviderが出すgap-detectable sequence、またはindependent readbackでcontinuityを証明してから
   writerが確定したsequenceに限る。callbackを受けた回数だけのlocal counterは不可。同一`counterEpoch`でstrict monotonic、duplicate/gap/reorderは即
   `state="unmeasured", reason="source-gap"`。reconnect後に independent readbackでresyncできない間は measuredへ戻さない。
6. compaction、counter decrease/reset、resumeでcounter continuityを証明できない時、model reroute時はfresh random
   `counterEpoch`へ切り替える。旧epoch sampleを新epochのbaselineやrateへ使わない。ordering fenceを先にpublishできない
   providerはその期間unmeasuredとする。
7. `turns` はparent requestだけのexact lifecycle count。tool call、advisor、subagent/child threadを加えない。
   event gapを検出できないproviderではderived countを発行しない。
8. `observedAt` はprovider source時刻が無ければ writer callback receipt timeであることをB0-Sに明記する。
   source eventの時刻と偽称しない。`expiresAt === observedAt + 30000`、future/stale/clock reversalを拒否する。
9. publishは§75と同じ安全性（0600 unique temp、file fsync、same-directory atomic replace、directory fsync、
   lane lock、revision CAS、last-known-good）を別file/lockで実装する。in-place rewrite、repair、revision resetは禁止する。
10. bounded readerは1 MiB以下、no-follow、owner/mode/link、strict JSON、unknown/duplicate key、schema hash、canonical digest、
    revision replay/equivocation、TTL、identity、parent requestを全検証する。missing/malformed/stale/mismatchは常にunmeasured、
    action 0とする。

30秒は**提案値**でありcurrent source factではない。B0-Sはcanaryの最大通知間隔とhost scheduling jitterを根拠に
短縮できるが、延長してsource gapを隠してはならない。

## 5. Codex / Claude isolated canary acceptance matrix

### 5.1 共通fixtureと証跡境界

各canaryは別task・別worktree・別runtime manifest/leaseで並列実行する。production `even-shared` /
`even-claude`、既存 user session、既存 `$HERMES_HOME`、shared DBを使わない。固定synthetic inputだけを使い、
raw prompt、assistant text、tool output、transcript、credentialを成果物へ保存しない。

観測artifactは provider event name、allowlisted ID/hash、numeric usage、callback order、monotonic time、
writer/runtime PID+OS start、generation/model readback、pass/fail reasonだけを持つ。各taskのrepository成果物は1ファイル:

- B0-CX: `docs/plans/shared-runtime-usage-codex-canary-result.md`
- B0-CC: `docs/plans/shared-runtime-usage-claude-canary-result.md`

canary phases:

1. isolated generationを起動し、writer/runtime PID+OS start、generation、effective modelをfresh bindする。
2. top-level parent session/requestを開始し、final result前の2つ以上のbarrierでusageを観測する。
3. parent内 tool call、child/subagent、parent再開を順に実行する。
4. compactionを明示的に発生させ、前後のcounter/epoch/orderを観測する。
5. host-controlled model rerouteを発生させ、旧/new modelとusage/windowのorderingを観測する。
6. isolated source reconnect/counter resetを発生させ、gap/reset fenceとresyncを観測する。
7. notification直前/直後のindependent readbackと、writer identityのfresh before/after readbackを照合する。
8. result後にisolated finalized logをoracleとして比較する。ただしoracleをrunning authorityとは扱わない。

phaseを安全に発生させられない、providerがeventを出さない、fixtureがskipされた場合はpassではなく
`inconclusive => unmeasured` とする。定数、近似、別model、最新finalized値で穴埋めしない。

### 5.2 acceptance matrix

| dimension | Codex B0-CX observation / pass | Claude B0-CC observation / pass | fail / stop condition |
|---|---|---|---|
| running parent request | `turn/completed`前にparent `threadId/turnId`へ2回以上のusage updateがあり、current context semanticsをoracleと矛盾なく説明できる | SDK final `result`前にparent requestへ2回以上のsource updateがあり、latest finalized responseではないことを示す | completion後しか更新されない、直前finalized値の再掲、0 timerだけ |
| numeric semantics | `total/last`各fieldの内数、contextに採るfield、output除外、cachedの扱いを固定 | message_start/delta/assistant usageのどれがparent contextかを固定 | 候補が複数残る、定数/推測が必要 |
| parent/tool boundary | tool call前後のparent sampleが同じparent requestへbindされ、tool output tokenを二重計上しない | 同左。advisor/internal callも区別する | tool/API call countとparent turn/contextを混同 |
| subagent boundary | child `parentThreadId/threadId`を別subjectとして観測し、parent sampleへchild usage/turnsを混ぜない | child/sidechain/agent identityを別subjectとして観測 | child IDが無い、parent aggregateしか得られない |
| compaction | compaction event、counter変化、fresh `counterEpoch`、旧sample無効化の順序を証明 | compact hook/eventまたは同等のprovider sourceとepoch fenceを証明 | compactionを数値低下だけから推測、fence前に旧sampleがactionable |
| model reroute | `model/rerouted`を観測し、旧model sampleを先にunmeasured化する。新modelのfull identityをdurableに再bindする別契約が無いv1ではmeasuredへ戻さない | SDKのactual reroute/effective model changeを観測し、同じく旧sampleをunmeasured化する | event前後のorderingを観測できない、旧model/windowがactionable、configured modelで代用 |
| counter reset | reset前後でepochが必ず変わり、revision/source sequenceが旧counterを跨がない | 同左 | decreaseを0 baselineで継続、resetかcompactionか不明 |
| notification ordering/gap | turn start/usage/compaction/reroute/completion、disconnect/reconnect順を記録し、gap検出かauthoritative resyncを証明 | SDK stream sequenceまたは同等のgap検出とresyncを証明 | callback local orderだけでlost notificationを否定、gap後すぐmeasured |
| independent readback | notificationと`thread/read`または別provider-owned usage readbackがsame thread/turn/counterを返す | SDK resume/session stateの独立usage readbackがsame request/counterを返す | current Codex schemaのようにreadbackへusageが無い、Claudeにequivalentが無い |
| context window | same sample/epoch/modelのprovider-observed positive window | same sample/epoch/modelのprovider-observed positive window | null/absent、model定数表、別時点modelから補完 |
| turns | parent turn lifecycleをsource sequenceからexact countし、tool/subagentを除外 | 同左 | result `num_turns`やgroup数をrunning parent turnへ丸める |
| source identity | source kind、source sequence、source attestation IDがduplicate/reorder/replayを拒否 | 同左 | writer-mintedIDだけでsource gapを検出できない |
| generation/model/PID | sample前後で§75 full identity、writer/runtime PID+OS start、effective modelが一致し、sample内へatomic copyされる | 同左。`writerPid===runtimePid`でもOS startを双方検証 | PID単独、generation statusの別時点join、1 field mismatch |
| TTL/replay | fresh/stale、same revision same digest、same revision equivocation、old epoch replayをfixture化 | 同左 | stale/replay/equivocationのどれかがmeasuredになる |
| notification vs finalized oracle | running samplesからfinalized counterへの関係を説明し、source gap無し | 同左 | oracleとの不一致を「provider差」として無視 |

canary provider verdictは次の2値だけを許す。

- `authoritative`: 上表の全provider該当行がpassし、未実行/skip/inconclusiveが0。
- `unmeasured`: 1行でもfail、未観測、independent readback無し、またはatomic binding不能。

`partial`, `advisory but safe`, `window only`, `numeric exact` をhard authorityの中間stateにしない。

### 5.3 cleanup boundary

- canary workerはshared processのrestart/kill、lease renew/release、Docker prune/down/deleteをしない。
- isolated runtimeのstopとresource cleanupはhost supervisor/orchestratorがexact manifest、generation、PID/start、
  resource listを照合して行う。workerのsuccessをstop証拠にしない。
- host-finalizeはartifact review、canary terminal、別lane/production impact 0、secret/raw text 0、
  rollback/cleanup結果を確認する。単なるtask `done/review`をhost-finalizeとみなさない。
- cleanup失敗、identity mismatch、observer gapなら後続をready化せず、resourceを推測削除しない。

## 6. Follow-up DAG, ownership, and stop conditions

```text
B0-R (this document, host-finalize)
  ├─ B0-CX Codex isolated canary ─┐
  └─ B0-CC Claude isolated canary ├─ both host-finalized
                                  ↓
                                B0-S contract
                                  ↓ host-finalized
                     ┌────────────┴────────────┐
                     ↓                         ↓
               B0-E producer             B0-H bounded reader
                     └────────────┬────────────┘
                                  ↓ both host-finalized
                                B1 guard
```

board上の`depends-on`がdoneになったことだけではready化しない。各矢印でorchestratorがhost-finalize evidenceを
確認し、source ref、ownership解放、runtime resource、provider verdictをtask bodyへ再固定してからready化する。

| task | exclusive ownership / one artifact | acceptance | stop condition |
|---|---|---|---|
| B0-CX | Codex isolated canary実行と `docs/plans/shared-runtime-usage-codex-canary-result.md` だけ。production code/contract変更なし | §5 Codex列全passまたは正式unmeasured | shared runtimeしか使えない、reroute/compaction/reset/readbackの1つでも未観測 |
| B0-CC | Claude isolated canary実行と `docs/plans/shared-runtime-usage-claude-canary-result.md` だけ。production code/contract変更なし | §5 Claude列全passまたは正式unmeasured | running source/window/readback/bindingの1つでも未成立 |
| B0-S | hachi-kanban `docs/contract.md` の usage sibling domainだけ。§75 schema/hash/path/state machineを変更しない | canaryでauthoritativeになったprovider/sourceだけをpositive enumへ採択し、他はunmeasured/hard-action禁止を明記 | 両canaryのhost-finalize未確認、canary外のsourceを追加、§75拡張が必要 |
| B0-E | legacy-hermesの新usage writer/helper、provider event wiring、wrapper env/path、offline fixtures/self-testだけ。generation status schema/helperの意味変更なし | one writer、atomic file、TTL/revision/epoch、full identity、provider別sourceを証明 | source verdict=unmeasuredのproviderへmeasured producerを作る、installed/shared publicationが必要 |
| B0-H | hachi-kanbanの新usage schema/strict bounded reader/root DI/read-only integrationと同居testだけ。`packages/core/src/types.ts`を変更せず専用moduleへ置く | path/owner/mode/no-follow/size/schema/replay/TTL/identity/parent bindingを検証し、全invalidをunmeasuredへ落とす | B0-E wire fixture未固定、readerがstatusをwrite/repair、hard actionを追加 |
| B1 | hachi-kanbanのdurable bounded sample ledger、role別threshold、notice soft steer、hard durable cancel requestまで。producer/reader/schemaを変更しない | authoritative providerだけでfresh sample crossingを作用させ、unmeasured/mismatch/stale/resetでaction 0。stop/restartはしない | B0-E/B0-Hどちらかhost-finalize前、provider sourceがunmeasured、shared process stopが必要 |

provider別branch rule:

1. B0-CX/CCの一方だけauthoritativeなら、B0-S/E/H/B1はそのproviderだけpositive branchを持つ。
   もう一方は明示的unmeasuredでhard action 0をtestする。
2. 両方unmeasuredならB0-Sはnegative contractだけをhost-finalizeし、B0-E/B0-H/B1のshared usage
   positive implementationをready化しない。別のauthoritative provider sourceを新taskで立証するまで停止する。
3. B0-EとB0-HはB0-S host-finalize後に並列可能だが、cross-repo fixture/schema/hashを同じ固定値で開始し、
   相手repoを編集しない。片方のrework中にB1をready化しない。
4. installed runtimeへのpatch適用、LaunchAgent/config変更、process restart、production observation、publicationは
   このDAG外のhost gateに残す。repository test passをpublication authorityにしない。

## 7. Unestablished fields and hard-action prohibition

current sourceで未成立なのは次の通りである。

- Codex: parent-request contextとしてのnumeric semantics、current `contextModel`、parent `turns`、
  `counterEpoch`、source ordering/gap、`observedAt`、`sourceAttestationId`、usageのindependent readback、
  usageと§75 generation/writer PID+startのatomic binding。
- Claude: running parent requestのexact `contextTokens`、`contextWindowTokens`、running `contextModel/turns`、
  `counterEpoch`、source ordering/gap、`observedAt`、`sourceAttestationId`、independent readback、
  usageと§75 generation/writer PID+startのatomic binding。
- 共通: compaction/model reroute/resetの前後で旧sampleをactionableにしないordering fence。

これらのうち1つでも欠測・mismatch・stale・replay・unknownなら、usage-driven hard actionは0である。
禁止対象は少なくとも次を含む。

- threshold crossingの確定、warning/notice steer、durable cancel requestの新規作成
- run close、session interrupt、process signal、shared runtime restart/replacement
- auto-ready/retry/rework、resource release/cleanup
- 別modelのwindow、設定定数、latest finalized値、`running_stats` growthによる補完

soft telemetry表示は `advisory` と明示し、threshold判定と同じfield名・stateへ入れない。
providerにauthoritative sourceが存在しないこと自体をerror/questionへ変換せず、
`unmeasured` と `hardActionAllowed=false` を正本にする。
