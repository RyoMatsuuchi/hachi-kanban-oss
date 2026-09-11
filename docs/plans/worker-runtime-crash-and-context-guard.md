# Worker runtime crash classification / context guard / exact child ownership

Status: **review proposal**。本書は read-only 調査結果であり、契約変更・実装・host
publication の採択を行わない。採択 authority は orchestrator / human に残す。

## 0. 調査境界と結論

### 0.1 調査境界

- 調査対象 SHA は task が指定した
  `2ec2f950745400691d4c782ffeeac9df65ca5489` であり、worktree の `HEAD` と一致した。
  調査時点の local `origin/main` は
  `0b8009ba09874f1a07c6949260e8aebfb3201460` まで進んでいたが、本書へは混ぜていない。
  後続 task は ready 前に採択 SHA を取り直す。
- incident input は task `t_705668b4484a8728` の本文と comment #3158 / #3316 /
  #3414 だけである。外部 tenant の repo、task log、transcript、process env は読んでいない。
- browser、process stop/restart/kill、cancel、load/crash canary、Docker、DB mutation は実行していない。
- `verify: none` のためテストは実行していない。完了時検査は変更範囲と
  `git diff --check` だけとする。

### 0.2 証拠強度

| 強度 | 意味 | 本書での扱い |
|---|---|---|
| E3 | production code と test、または durable な exact identity 証拠が一致 | 自動分類・自動介入の必要条件にできる |
| E2 | production code で観測面はあるが、run との exact bind または lifecycle の片側がない | correlation / observe-only |
| E1 | contract、診断文、時刻近接、件数など単独では因果を証明しない情報 | 補助説明だけに使う |
| E0 | 推測、欠測、model/owner/generation mismatch | unknown。破壊的 side effect は 0 |

保存済み incident は次を示すが、root cause までは示さない。

- comment #3158: input token が 674,246 / 1,146,915 に達した 10〜12 秒後に
  shared app-server が再起動した相関が 2 回ある。2 回目には context 衛生の body 注意書きが
  既にあった。
- comment #3316: `diagnostic=codex app-server ws closed`、run duration 561ms、同時刻の
  runtime process start という相関がある。
- comment #3414: A の誤分類を P0 とし、B/C は独立 task に分割する方針である。

これらは有力な E1/E2 incident evidence だが、「context 増大または child leak が
app-server crash を起こした」という因果証明ではない。

### 0.3 推奨の要約

1. **A / 最優先**: 新しい machine reason `runtime_generation_interrupted` は、診断文字列ではなく、
   exact run/session/role が launch 時に bind した runtime generation と、その**同じ generation の
   stop/replacement transition**を terminal 時に照合できた場合だけ発行する。診断だけ、短時間終了だけ、
   同時刻の複数 run だけなら既存 `worker_output_missing` のままにし、correlation を添える。
2. **B**: provider native の親 session usage を走行中に bounded sample し、
   `usage.contextModel === launch 時に runtime が readback した modelId` を exact 照合する。
   window が同じ sample から観測できない provider は、model ごとの attested window が無ければ
   saturation を `unmeasured` にする。ただし shared bridge はその状態を B1 完了後まで持ち越さず、
   exact model/window/usage semantics を runtime generation に bind する attested source を B0 で先に配備する。
   warning は一度だけ soft steer、hard guard は既存 durable cancel request の作成までとし、
   run close/stop/restart を直結しない。
3. **C**: child reap は `(taskId, runId, sessionId, runtimeGeneration, pid, pgid,
   OS process start identity)` を spawn 時と signal 直前に完全照合できる child だけに限定する。
   shared app-server 配下で session→child ownership が出ない現状は相関計測だけに留める。

## 1. Current-main fact table

### 1.1 状態機械と観測面

| 面 | current-main fact | 証拠 | 強度 / 欠落 |
|---|---|---|---|
| task run | `RunRow` は `id/taskId/provider/sessionId/status/meta/startedAt/endedAt` を持つ。run meta には role、profile、serverUrl、model、transport、nativeCommunication が入る | `packages/core/src/types.ts:149-158`, `packages/supervisor/src/stages/dispatch.ts:370-399`, `packages/core/src/db.ts:5155-5164` | E3。runtime generation / process owner はない |
| session ref | `SessionRef` は provider/session/serverUrl/model/modelDelivery/startedAt と optional native communication を持つ | `packages/core/src/types.ts:1211-1225` | E3。PID/PGID/process start/generation はない |
| native Codex endpoint | Unix socket の canonical path、parent/socket の dev/ino/uid/gid/mode を保存する | `packages/core/src/types.ts:1238-1263`, `packages/adapters/src/codex-app-server-rpc.ts:139-182` | E3 の endpoint identity。process generation ではない |
| bridge terminal status | `/api/messages` の最後の `result` から turns/duration/input/output を読む。`running_stats` は raw には残るが typed `lastResult` へは上げない | `packages/adapters/src/session.ts:368-414` | E3。typed live usage、timestamp、model/window はない |
| bridge end | idle + result watermark を 60 秒静穏確認し、`session_ended` に session/provider/result watermark/observedAt を保存する | `packages/supervisor/src/stages/monitor.ts:481-585` | E3。runtime generation/close cause はない |
| direct terminal | `.exit` があれば idle、無くても leader PID が消えれば idle/resultCount=1 | `packages/adapters/src/direct-process.ts:198-216` | E3。正常 exit と crash/kill を区別しない |
| direct exit code | launcher は shell の `$?` を `.exit` に書く | `packages/adapters/src/direct-codex.ts:69-108`, `packages/adapters/src/direct-claude.ts:93-127` | E2。current status/finalizer は値を読まず、存在だけを見る |
| direct process | state JSON は PID、task、paths、model、adapter clock の startedAt を持つ。detached spawn の PID を PGID として使う | `packages/adapters/src/direct-process.ts:9-26`, `packages/adapters/src/direct-process.ts:184-196`, `packages/adapters/src/direct-process.ts:278-299` | E2。OS start identity、runId、actual PGID readback がない |
| native Codex close | socket close は in-memory pending request を connection error で reject する | `packages/adapters/src/codex-app-server-rpc.ts:543-555` | E2。close timestamp/event/process exit は durable でない |
| native Codex reconnect | reconnect は保存 socket snapshot と同じ endpoint だけ受理し、置換 endpoint を拒否する | `packages/adapters/src/codex-app-server-rpc.ts:440-500` | E3 の endpoint substitution veto。旧 process の stop 証拠ではない |
| native Codex status/stop | status は thread state/raw を返すが usage は返さない。stop は turn interrupt を試すだけで exact session/tree stop は unsupported | `packages/adapters/src/codex-app-server.ts:679-694`, `packages/adapters/src/codex-app-server.ts:719-748` | E3。shared process stop へ昇格不可 |
| durable cancel | current open run/session/provider/fence に bind し、`cooperative_sent` を ack/stop とみなさず、exact stop が無ければ pending を維持する | `docs/contract.md:2922-2946`, `docs/contract.md:2984-3016`, `packages/supervisor/src/stages/cancel.ts:565-718` | E3。B の介入先として再利用必須 |
| host generation attestation | `cancel-host-stop` は host が既に止めた generation の caller-provided evidence を記録するだけで、停止や generation discovery を行わない | `packages/cli/src/commands/task.ts:983-1056`, `packages/cli/src/commands/task.ts:1079-1136` | E3 の事後回復 shape。A の live observer ではない |
| human queue | `needs-manual:` は既存の orchestrator recovery lane。再-ready 前に owner/binding/open run 0 と session stop を照合する | `runbooks/orchestrator-playbook.md:701-725`, `docs/contract.md:2328-2345` | E3。新 block prefix は不要 |

### 1.2 `worker_output_missing` の全生成経路

production code で literal machine reason を返すのは、共有関数
`classifyExecutionFailure` の次の 4 分岐だけだった。その後 worker finalizer と reviewer finalizer の
2 consumer へ流れる。

| # | predicate | source | 現在の結果 |
|---|---|---|---|
| W1 | direct assistant output が空または固定文言 `(出力ファイルなし)` | `packages/supervisor/src/fence-extraction.ts:244-248` | `worker_output_missing` |
| W2 | structured rejection または zero-token で diagnostic はあるが既知語彙に一致しない | `packages/supervisor/src/fence-extraction.ts:251-258` | `worker_output_missing` |
| W3 | structured rejection/zero-token の direct fallback も空 | `packages/supervisor/src/fence-extraction.ts:261-269` | defensive duplicate。現制御順では W1 が先に返すため shadow される |
| W4 | structured rejection/zero-token の direct fallback が未知文言 | `packages/supervisor/src/fence-extraction.ts:270-276` | `worker_output_missing` |

補足:

- 既知 diagnostic は max-turns、capacity/quota/429、model/transport incompatible、CLI
  spawn/startup に限られ、`codex app-server ws closed` は含まれない
  (`packages/supervisor/src/fence-extraction.ts:183-212`)。
- bridge で structured result も stats も無い場合は `extraction_failed` であり、W1〜W4 ではない
  (`packages/supervisor/src/fence-extraction.ts:261-264`)。
- worker finalizer は failure event に `sessionId/diagnostic` だけを保存し、run を failed で閉じ、既存
  `needs-manual: 実行失敗 ...` へ付け替える
  (`packages/supervisor/src/stages/finalize.ts:748-805`,
  `packages/supervisor/src/stages/finalize.ts:823-857`)。
- reviewer も同じ classifier を使い、`needs-manual: レビュー実行失敗 ...` へ付け替える
  (`packages/supervisor/src/stages/review.ts:1847-1902`,
  `packages/supervisor/src/stages/review.ts:3153-3188`)。
- unit test は未知の `process exited before output` と direct の未知文言を
  `worker_output_missing` とする現契約を固定している
  (`packages/supervisor/src/fence-extraction.test.ts:176-201`,
  `packages/supervisor/src/fence-extraction.test.ts:255-266`)。finalizer の direct output missing と
  Git evidence も固定済みである
  (`packages/supervisor/src/stages/finalize.test.ts:686-739`)。

### 1.3 分類時に使える情報 / 使えない情報

| 欲しい情報 | current availability | 判定 |
|---|---|---|
| exact runId/taskId/sessionId/provider/role/model/transport | open run と run meta から取得可 | E3 |
| structured diagnostic | final status raw / direct output から取得可。500文字へ bounded | E2。単独で原因にしない |
| zero token / result success | terminal status から取得可 | E3。ただし valid structured success は failure より優先 |
| run start/end | run row と ref にある | E3。短時間だけでは原因不明 |
| provider close timestamp | current eventにはない | E0 |
| exit code / signal | direct `.exit` に code はあるが未読。bridge/native はない | E0/E2 |
| runtime owner PID/PGID/OS start | direct は PID+assumed PGIDのみ。bridge doctor は listener PIDのみ | E0/E2 |
| runtime generation at launch | 保存されない | E0 |
| old generation stop/replacement transition | 保存されない | E0 |
| same generation の複数 run correlation | generation key がないため query 不能 | E0 |
| native Codex endpoint replacement | socket snapshot mismatch は検出可 | E2。process crash の証明ではない |
| wrapper patch process identity | doctor は status file の bridgePid と LISTEN PID を照合する | E2。inner Codex app-server generation ではない (`packages/cli/src/commands/doctor.ts:795-920`) |

したがって、保存済み incident を current code だけで retrospective に E3 へ上げることはできない。
A の修正は diagnostic regex ではなく、まず runtime owner が generation transition を発行する観測面を
追加する必要がある。

## 2. A — infra crash 分類

### 2.1 選択肢

| 案 | 長所 | 反例 / 欠点 | 判定 |
|---|---|---|---|
| diagnostic 文字列を追加 | 小さい差分 | wording変更、proxy error、正常 reconnect、Claude/別 transport を誤分類する | 不採用 |
| run duration が短い時だけ infra | 保存 incident を拾いやすい | CLI reject、config error、即時 worker output も同じ | 不採用 |
| 同時刻に複数 run が閉じたら infra | shared failure に強い | provider capacity、host suspend、独立 failure が重なる | E2 correlation のみ |
| 新しい runtime PID/start 時刻を見たら旧 crash | restartを拾える | 旧 generation の停止、PID reuse、observer gap が不明 | E2 correlation のみ |
| exact generation bind + exact transition + bounded time + terminal failure | 原因を「worker output」から「runtime interruption」へ安全に分離できる | host/runtime wrapper の観測実装が先に必要 | **推奨** |

### 2.2 凍結する分類契約案

#### Launch binding

runtime owner は run launch 時に、secret を含まない次の versioned evidence を durable に bind する。

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
    writerPid: number;
    writerProcessStart: string;
    runtimePid: number;
    runtimeProcessStart: string;
    bootNonce: string;
    endpointIdentityHash: string;
  };

interface RuntimeGenerationBindingV1 {
  version: 1;
  taskId: string;
  runId: number;
  sessionId: string;
  role: "worker" | "reviewer";
  provider: "codex" | "claude";
  transport: "bridge" | "direct";
  runtimeKey: string;       // canonical endpoint / owner lane。URL credential は禁止
  identity: RuntimeGenerationIdentityV1;
  boundAt: number;
}
```

identity は provider/transport に対応する variant を1つだけ許し、各 variant の
`generationId/runtimeModelId/PID/OS process start` をすべて必須にする。証明元は次のとおり。

- direct: spawn 結果の PID、fresh readback した PGID、OS process start identity、spawn nonce の合取。
- Hachi-owned native app-server: parent が受けた exact child PID + OS start identity + wait/exit lifecycle。
- external shared wrapper: wrapper 自身が発行する monotonic generation/boot nonce と、listener/app-server
  PID+OS start identity の readback。status file の `updatedAt` または bridgePid 単独は不可。
- Unix socket identity は endpoint substitution veto として加えるが、socket inode 単独を process generation
  と呼ばない。

`packages/supervisor/src/stages/dispatch.ts` は adapter launch result と shared runtime generation writer の
attestation を、`startRun` と同じ launch CAS で binding へ保存する。shared writer の exact file path と
schema owner は A1 ready 前に host repo から readback して task ownership に固定し、未固定なら A1 を開始しない。

`runtimeModelId` 自体は stop の因果証拠ではないが、完全な launch identity と B の model/window fenceを
一体にする必須 field とする。欠測時は binding 全体を invalid とし、A は既存
`worker_output_missing`、B は `unmeasured:model-unknown` へ倒す。A だけ欠測を許す例外は設けない。

#### Terminal transition

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

`replaced` は「新 generation が見えた」だけでは成立しない。同じ observer の連続 snapshot で旧
generation が消滅し、新 generation の exact identity が初めて現れたことを記録する。observer gap や
read failure は `unknown` である。

#### Predicate

`runtime_generation_interrupted` を返すのは次の conjunction がすべて真の場合だけとする。

1. exact current open run、session、role、provider、transport と launch binding が一致する。
2. valid `success:true` structured handoff/verdict は存在しない。
3. 現行 classifier に渡せば `worker_output_missing` になる terminal failure、または runtime transport
   closed の**構造化 diagnostic code**がある。free text の部分一致だけは不可。
4. transition の `runtimeKey`、`identity.kind`、および variant の全必須 field が binding と exact match する。
   欠測 field 同士を一致とみなさず、variant mismatch や `undefined === undefined` は常に false とする。
5. `stoppedAt` または `[lastSeenAt, replacementFirstSeenAt]` が run 生存区間と交差し、terminal/close
   観測から推奨 30 秒以内にある。30 秒は保存 incident の 10〜12 秒へ observer jitter を加えた
   correlation bound であり、単独の因果証拠ではない。採択時に定数と根拠を contract へ固定する。
6. transition evidence 自体が redaction/schema/TTL 検証を通る。

同 generation の複数 run が同じ 30 秒窓で失敗した場合は `correlatedRunIds` として強度を補強するが、
4 の代替にしない。単一 run でも 1〜6 を満たせば分類できる。

分類結果には最低限次を versioned event/run meta へ保存する。

```json
{
  "version": 1,
  "reason": "runtime_generation_interrupted",
  "taskId": "t_...",
  "runId": 1,
  "sessionId": "...",
  "role": "worker",
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

生 diagnostic、transcript、process env、credential を payload に入れない。短い redacted display
diagnostic は既存 comment と同じ境界で別フィールドにできる。

### 2.3 unknown / state machine / compatibility

- binding/transition/time/model のどれかが missing/mismatch/stale なら、新理由を発行しない。
  既存 `worker_output_missing` に `infraCorrelation.state="unconfirmed"` を付けるだけにする。
- run は現行どおり `failed`、block reason prefix は worker/reviewer とも既存 `needs-manual:` を維持する。
  **新 block prefix や human queue lane を増やさない**。machine reason と表示文だけを additive にする。
- 初期版では confirmed infra でも auto-retry / auto-ready しない。run close 後、old generation が消滅し、
  same worktree の open run が 0、session/resource binding が解放可能であることを orchestrator が確認して
  初めて re-ready できる。`session_ended` / `worker_output_missing` だけでは replacement を許さない
  (`runbooks/orchestrator-playbook.md:723-725`)。
- 既存 event/run meta は version 無しでも読み続ける。generation binding がない legacy run は現在と同じ
  `worker_output_missing`。既存 Git evidence は新理由でも capture するか、trigger enum を additive に広げる。
- worker と reviewer は共有 predicate を使うが、role と current session fence を必ず event に残す。
- current `cancel-host-stop` の `processGeneration` 文字列は external stop 後の attestation shape であり、
  A の observer-generated launch binding に流用しない。

## 3. B — usage / context guard

### 3.1 provider / transport ごとの current observability

| provider / path | 走行中に current code が取得するもの | terminal 時に取得するもの | context guard に足りないもの |
|---|---|---|---|
| Codex / even-terminal shared bridge | `/api/messages` raw の最新 `running_stats(durationMs,inputTokens,outputTokens)`。adapter は typed usage にしない | 最後の result の turns/duration/input/output | input の累計/現在文脈 semantics、model、window、turn timestamp、generation |
| Claude / even-terminal shared bridge | 同上 | 同上 | 同上。Claude の window は bridge payload にない |
| Codex / direct CLI | `.out` size/process を monitor。usage collector は実行中に呼ばない | exact native session rollout から turns、累計 input、直近 context、同じ turn の contextModel、観測 window | provider session ID は `.out` header が現れるまで不明。live bounded read/cursor と sample persistence |
| Claude / direct CLI | process/output を monitor。launch 時の native UUID は state にある。usage collector は実行中に呼ばない | native transcript から parent turns、累計 input、直近 context、同じ応答の contextModel。window は常に欠測 | live bounded read/cursor、model-scoped attested window |
| Codex / Hachi native app-server | exact thread/turn/socket endpoint、thread status/raw | usage は返さない | native rollout との exact mapping と live sampler は未実装 |
| Claude / native cross-session | exact provider session/agent ref binding | worker status 面に guard 用 usage はない | live sampler、window、runtime model readback |

根拠:

- bridge `running_stats` shape は contract にあるが、transcript からは telemetry として除外される
  (`docs/contract.md:576-599`, `packages/adapters/src/session.ts:437-459`)。
- Claude native collector は parent の直近 context/model を返すが window を推測しない
  (`packages/adapters/src/native-usage.ts:351-401`)。
- Codex native collector は累積 counter の差分、同じ `turn_context` の model、provider report の
  `model_context_window` を返す。counter 減少は reset/compaction として baseline を切る
  (`packages/adapters/src/native-usage.ts:747-863`)。
- direct adapter は `.exit` 後だけ collector を呼ぶ
  (`packages/adapters/src/direct-codex.ts:212-221`,
  `packages/adapters/src/direct-claude.ts:229-238`)。
- `RunUsage` は terminal aggregate であり、main session context/model/window を保存しない
  (`packages/core/src/types.ts:1373-1401`)。

### 3.2 既存 orchestrator usage をそのまま worker guard に使わない

既存 orchestrator self-measurement は有用な collector/pure function を持つが、worker の自動 cancel
authority にはそのまま使えない。

- current CLI は `usage.contextWindowTokens ?? config.orchestrator.sessionBudget.contextWindowTokens` を
  provider/model 共通の単一 override として使う
  (`packages/cli/src/commands/orchestrator-usage.ts:148-183`,
  `packages/core/src/config-schema.ts:247-266`)。
- `usage.contextModel` と session/launch の exact runtime model を照合してから window を選ぶ処理がない。
- Claude へ単一 config window を入れて saturation を測る test も現契約である
  (`packages/cli/src/commands/orchestrator-usage.test.ts:465-490`)。

worker guard では、過去 review の再発防止として次を必須にする。

```text
usage.contextModel === binding.runtimeModelId
AND windowAttestation.modelId === binding.runtimeModelId
AND windowAttestation.provider/transport が binding と exact match
```

Codex の provider-observed window も、**同じ sample の contextModel と binding.runtimeModelId が一致した時だけ**
使う。missing/mismatch は `unmeasured:model-mismatch|window-unknown` とし、別 model の window を適用しない。

### 3.3 sample contract

terminal `RunUsage` と分離し、open run ごとに latest + previous の bounded sample を durable に持つ。

```ts
interface RunContextSampleV1 {
  version: 1;
  taskId: string;
  runId: number;
  sessionId: string;
  role: "worker" | "reviewer";
  provider: "codex" | "claude";
  transport: "bridge" | "direct";
  runtimeGenerationId: string;
  runtimeModelId: string;
  contextModel?: string;
  contextTokens?: number;
  contextWindowTokens?: number;
  cumulativeInputTokens?: number;
  turns?: number;
  observedAt: number;
  counterEpoch: number;
  usageSemantics: "parent-request-context" | "cumulative-input";
  sourceAttestationId?: string;
  source: "native-log" | "bridge-running-stats" | "runtime-status";
}
```

規則:

- sample は exact current open run/session/generation へ CAS で保存する。終了 run、旧 generation、別 role の
  sample は reject する。
- native log はファイル全量を各 tick 再読しない。exact session file の inode/size/cursor と bounded tail を
  readback し、truncate/rotation/parse incomplete は新 `counterEpoch` または unmeasured にする。
- contextTokens は「同じ親 session の直近 request input」。累計 input、advisor/subagent 合計、output を混ぜない。
- rate は同じ `(run,session,generation,runtimeModelId,counterEpoch)` の 2 sample 以上でだけ計算する。
  `deltaContext/deltaTurn` と `deltaContext/deltaTime` は別軸。turn/time が非増加、counter 減少、compaction/reset、
  contextModel mismatch の場合は rate を出さない。
- `running_stats.inputTokens` は semantics を host canary で固定するまで `cumulativeInputTokens` の advisory
  sample にだけ入れ、`contextTokens` や saturation へ昇格しない。
- sample 値を event に無制限追記しない。bounded table/state と閾値 crossing event だけを永続化する。

#### Shared bridge の hard-action 前提

B1 の前段 B0 は shared runtime generation writer から、exact
`run/session/role/provider/transport/generation/runtimeModelId` に bind した versioned usage attestation を
供給する。hard crossing に使える shared sample は、同じ attestation に
`contextModel`、`usageSemantics="parent-request-context"`、その意味での `contextTokens`、exact model の
`contextWindowTokens`、`observedAt/counterEpoch/sourceAttestationId` が揃い、reader が writer PID/start・
generation・schema/TTL を再検証できるものだけである。

B0 が host-finalize されない限り B1 を ready にせず、B1 の shared Codex/Claude acceptance は attested
sample による notice/hard crossing と durable cancel 作成までを含める。source が missing/mismatch/stale の
path は引き続き `unmeasured` だが、**shared path 全体が unmeasured のまま B1 完了とはしない**。
`running_stats` は累積値か current context かが未確定な advisory telemetry のままとし、値の絶対量・growthが
大きくても hard crossing authorityへ昇格しない。cumulative absolute/growth を hard action に使う案は、
counter semantics/reset/model binding/false-positive action を別 contract で採択しない限り不採用とする。

### 3.4 guard action の比較と推奨

| action | current capability | 安全性 | 推奨 |
|---|---|---|---|
| body の context 注意書き | 全 path | comment #3158 で 1.146M 到達を防げなかった | layer 0 として維持。enforcement に数えない |
| soft steer / checkpoint handoff | bridge/native inject は可能、direct は resume 不可 | delivery は ack/stop でない。新しい turn が増える | notice crossing で session ごと1回、best-effort |
| cooperative cancel | durable cancel engine が exact run/session/fence に bind | 正規 state machine。worker が無視する可能性 | hard crossing の唯一の自動介入入口 |
| exact-session stop | direct は group stop、native Codex shared は unsupported | owner evidence 不足時は誤 kill | durable cancel grace 後、C の exact owner/capability 成立時だけ |
| shared app-server stop/restart | current adapter は exact session stop unsupported | 他 run を巻き込む | guard の fallback にしない |
| per-run / bounded-shard app-server isolation | current main にはない | blast radius を小さくできる | host publication task で別実装・canary |

推奨 state machine:

1. strict config は `(role, provider, transport, runtimeModelId)` ごとに notice/hard の absolute
   saturation、growth、minimum samples、grace を持つ。単一 global window は禁止する。数値は本 incident から
   推測せず、採択 task が telemetry/canary と model contract から固定する。
2. sample が exact で notice threshold を初めて越えたら、bridge/native だけへ idempotent soft steer
   `checkpoint + handoff` を送る。accepted を observed/ack と表示しない。direct は warning/event だけ。
3. hard threshold は、model/window exact match かつ同 epoch の連続 sample 条件を満たす場合だけ発火する。
   supervisor が既存 `ensureSupervisorCancelRequest` 相当で reason=`context-budget` の durable request を作る。
4. guard 自身は run close、task block 付替、adapter.stop、process kill、bridge restart を行わない。
   cooperative/force/stop/replacement は contract §57 の cancel stage だけが行う。
5. exact-session stop unsupported の shared path は pending/escalation のまま。B の検知だけで shared process を
   止めない。blast radius は per-run/shard isolation の publication が解決する。

「warning を越えたが usage が次 tick で消えた」「model が変わった」「compaction で context が下がった」は
cancel へ進めず unmeasured を記録する。既に作成済みの durable cancel は sample 回復だけで取消さず、cancel
state machine の fenced 手順に従う。

## 4. C — exact child ownership / reap

### 4.1 current process ownership

| path | 保存 / 観測 | 限界 |
|---|---|---|
| direct | state JSON の PID/task/model/startedAt、detached PID=PGID 前提、`.exit` existence | runId、actual PGID、OS start、child set、exit/reap status がない |
| bridge | `ps` の PID/PPID/PGID/etime/startTime/command。shared app-server→Codex root→descendant を tree/age で選ぶ | session/run/generation owner がない |
| bridge reap | age > maxRun+1800 の subtree を TERM、10秒後 startTime が同じ PIDだけ KILL | 初回 TERM 前に session ownerを証明しない。startTime check は PID reuse 防止であって ownership ではない |
| doctor | bridge descendants/orphans、direct residual group の件数 | correlation count。owner/exit/reap の監査 record はない |
| native app-server | Hachi が auto-start した server child の PIDは adapter memory にだけある | durable generationでなく、provider session child の owner mapもない |

根拠:

- process row と bridge candidate predicate:
  `packages/core/src/process-hygiene.ts:8-29`,
  `packages/core/src/process-hygiene.ts:154-208`。
- direct residual は `exitExists && process.pgid === saved pid` の件数だけ:
  `packages/core/src/process-hygiene.ts:211-217`。
- current reap の startTime recheck と signal sequence:
  `packages/supervisor/src/stages/reap.ts:191-245`,
  `packages/supervisor/src/stages/reap.ts:247-329`。PID reuse の test はあるが session owner test はない
  (`packages/supervisor/src/stages/reap.test.ts:536-663`)。
- doctor は scan failure を skipped/ok にする:
  `packages/cli/src/commands/doctor.ts:1434-1451`。
- current contract §51 は age/tree heuristic を許可する
  (`docs/contract.md:2376-2406`)。新しい exact reap と併存させるなら、この契約差を先に採択する必要がある。

### 4.2 推奨 owner ledger

spawn authority / runtime wrapper が、effect 前に次を durable に記録する。

```ts
interface WorkerProcessOwnerV1 {
  version: 1;
  taskId: string;
  runId: number;
  sessionId: string;
  role: "worker" | "reviewer";
  provider: "codex" | "claude";
  transport: "bridge" | "direct";
  runtimeGenerationId: string;
  spawnNonce: string;
  pid: number;
  pgid: number;
  processStart: string;
  parentPid: number;
  parentProcessStart: string;
  executableIdentityHash: string;
  spawnedAt: number;
  state: "spawned" | "exited" | "reaped" | "unknown";
  exitCode?: number;
  signal?: string;
  exitedAt?: number;
  reapedAt?: number;
}
```

- direct は spawn 後に actual PID/PGID/start/parent を fresh readback できなければ launch を fail-closed にする。
  `startedAt` は OS start identity の代替にしない。
- runId は launch 後にできる現構造なので、launch result と `startRun` を結ぶ transaction/CAS で一度だけ bind
  する。bind 前に crash した process は task ownerではなく host launch-orphan quarantine として扱う。
- shared wrapper が session child の spawn/exit/reap event を exact provider session + nonce 付きで発行できる場合だけ
  ledgerへ入れる。`ps` の command/age/ancestor から owner row を新規生成しない。
- exit は parent `wait` / runtime lifecycle event を authority とし、process 消滅だけで exit code 0 を作らない。

### 4.3 reap predicate

signal 候補は次の conjunction をすべて満たす child だけである。

```text
owner.state in {spawned, exited}
AND exact task/run/session/role/runtimeGeneration が current ledger と一致
AND current run が terminal または exact cancel が forcing/stopped
AND fresh ps(pid).start == owner.processStart
AND fresh ps(pid).pgid == owner.pgid
AND parent/runtime generation lineage が一致
AND kill switch/budget/backoff が許可
```

TERM 前と KILL 前に同じ predicate を再照合する。TERM delivery を exit/reap とみなさず、消滅または parent
wait の exact evidence が出た時だけ `reaped` にする。PID/PGID/start/parent のどれかが欠測・不一致なら
`unknown/quarantined` で signal 0。name/prefix/glob/generic prune/bridge root kill は生成しない。

shared child の exact owner event が未配備の間は、次の correlation metric だけに留める。

- runtime generation ごとの descendant count / oldest age / start-time histogram
- open/terminal session 数との差
- spawn limit error と descendant count の時系列
- exact owner row 無しの candidate 数

この相関を app-server crash の原因とは表示しない。current age/tree auto reap を残すか observe-only へ落とすかは
contract §51 の変更を伴う採択判断であり、本書では勝手に変更しない。

## 5. Shared/direct、Codex/Claude、worker/reviewer の非破壊境界

| 境界 | measurement | allowed intervention | 禁止 |
|---|---|---|---|
| shared Codex bridge/app-server | exact generation binding があれば A。`running_stats` は advisory | soft steer、durable cancel request、host隔離後の exact shard stop | session未特定の shared restart/kill、別run巻き込み |
| shared Claude bridge | 同上。window欠測は unmeasured | soft steer、durable cancel request | global/model推測 window、shared restart |
| direct Codex | native sample は provider session ID出現後。exact owner v1 が必要 | durable cancel→exact group stop | PID単独/adapter startedAt だけの kill |
| direct Claude | UUIDは launch 時 exact、context/model は観測可、window は欠測 | attested model window がある時だけ guard。durable cancel→exact group stop | global window fallback |
| worker role | task/run/session/role 固有の policy | worker用 notice/hard profile | reviewer sample/threshold の流用 |
| reviewer role | workerと同じ classifier、別 role/profile | reviewer用 notice/hard profile、durable cancel | worker run を reviewer evidenceで閉じること |
| usage missing/model mismatch/reset | unmeasured event/metric | 現行 max-runtime/stall を維持 | 新しい steer/cancel/stop |
| runtime generation unknown | correlation only | existing `needs-manual:` recovery | infra確定、auto-ready/replacement |

## 6. Fail-closed 反例表

| 反例 | 誤った判断 | 正しい分岐 |
|---|---|---|
| `codex app-server ws closed` だけがある | infra crash 確定 | diagnostic correlation。generation evidence無しなら既存理由 |
| 561ms で出力無し | runtime crash | CLI/config/provider reject もある。既存 classifierへ |
| 70ms差で2 runが終端 | same process crash | same generation bind/transition無しなら correlationのみ |
| 12秒後に新PIDが見えた | 旧PIDが crash | 旧generationのlastSeen/stopと新identityの両方が必要 |
| socket inodeが変わった | process crash | endpoint replaced は言えるが exit cause は unknown |
| bridgePidとLISTEN PIDが一致 | inner app-server generation exact | bridge listener identityだけ。inner generationは別証拠が必要 |
| valid `success:true` result が zero-token | failure reasonを上書き | valid structured resultを優先する現契約を維持 |
| `running_stats.inputTokens=900k` | current context 900k | semantics固定まで cumulative advisoryだけ |
| binding と transition の PID/start が両方欠測 | exact identity が一致 | 欠測同士は不一致。既存 reason + unconfirmed correlation |
| runtimeModelId が欠測 | generationだけでAを確定 | binding invalid。Aは既存 reason、Bは `unmeasured:model-unknown` |
| usage context model が欠ける | run meta modelを推測適用 | unmeasured:model-unknown |
| context model と launch/runtime model が違う | 別model windowで saturation | unmeasured:model-mismatch |
| Claude windowがない | global 300kを全modelへ適用 | exact model attestationがなければ saturation無し |
| Codex counterが低下 | contextが安全に回復した、または負のgrowth | compaction/reset epochを開始し rateを出さない |
| sampleが1点だけ | 急増率を算出 | absolute軸のみ。rateはunmeasured |
| soft steer accepted | workerがcheckpointした | deliveryだけ。ack/terminalを別観測 |
| hard threshold crossing | runをfailed close | durable cancel request作成まで |
| cancel failed/expired | replacement可 | exact stop/open run 0までgate維持 |
| direct stateのPIDが生存 | owner exact | OS start/PGID/run/generation照合が必要 |
| PIDが再利用された | old childをKILL | start mismatchでsignal 0/quarantine |
| old bridge descendant | leak owner確定 | session owner event無しなら correlationのみ |
| process scan失敗 | child無し | unknown。reap 0、observability warning |
| confirmed infra failure | すぐauto-ready | old generation stop、open run 0、binding/resourceを確認してhuman/orchestrator回収 |

## 7. 後続 task DAG

採択後も 1 task にまとめない。各 depends-on は board の `done` だけで自動解放せず、前 task の
**host-finalize（review、focused verification、commit、main統合）後**に後続を ready にする
(`runbooks/orchestrator-reference.md:503-521`)。

| ID / category | frozen scope | ownership files | depends-on / gate |
|---|---|---|---|
| A0 `分類契約` | 本書 §2 の evidence levels、binding/transition schema、30秒窓、machine reason、unknown、legacy/human queueを contract に採択。方式を変える判断はここだけ | `docs/contract.md`, 必要なら `runbooks/orchestrator-playbook.md` の回収表だけ | none。orchestrator/human decision。docs strict validation |
| A1 `分類契約 implementation` | discriminated runtime identity、runtime owner observer、durable binding/transition、dispatch launch CAS、shared worker/reviewer predicate、event/run meta、legacy fallback、focused tests。新block prefix/auto-retryなし | contract owner=A0。Store/migration owner=`packages/core/src/types.ts`（凍結領域のためorchestrator）、`packages/core/src/db.ts`, new `packages/core/src/runtime-generation.ts` と同居 migration/Store/readback tests。launch writer owner=`packages/supervisor/src/stages/dispatch.ts` と tests、external shared runtime generation writer（exact host-repo pathはready前に固定）。consumer owner=`packages/supervisor/src/fence-extraction.ts`, `packages/supervisor/src/stages/finalize.ts`, `packages/supervisor/src/stages/review.ts` と tests | A0 host-finalized。incident fixture は合成のみ。external writerを含む全fileをA1が排他所有し、P1は後の配備だけを担う |
| B0 `shared usage attestation source` | shared Codex/Claude の runtime generationにbindした exact model/window/parent-request-context semantics sourceとbounded typed readbackを実装する。guard action/DB sample/cancelはまだ作らない。`running_stats` はadvisoryのまま | attestation contract=`docs/contract.md`。producer=external shared runtime generation/usage writer（A1で固定したexact path）と host-side tests。consumer schema/readback=`packages/adapters/src/session.ts` と tests。A1 host-finalize後に同じwriterの所有をB0へ移す | A1 host-finalized。exact writer/readback path、schema、TTL、model/window sourceがtask bodyに固定できなければready禁止 |
| B1 `usage/context guard` | durable bounded sample、exact runtime model/window照合、reset epoch、role別strict config、notice steer、hard→durable cancel request。shared pathのattested hard crossingをacceptanceに含め、stop/restartなし | ledger contract=`docs/contract.md`。migration/Store API=`packages/core/src/types.ts`（orchestrator ownership）、`packages/core/src/db.ts`, `packages/core/src/readview.ts`, new `packages/core/src/run-context-sample.ts` と migration/Store/readback tests。sample writer/readback=`packages/supervisor/src/stages/context-guard.ts`, `packages/supervisor/src/stages/monitor.ts` と tests。collector=`packages/core/src/config-schema.ts`, `packages/core/src/usage.ts`, `packages/adapters/src/native-usage.ts`, `packages/adapters/src/session.ts`, direct/native adapter usage面と tests | B0 host-finalized。A1/B0のfile ownership解放をreadback後に開始。既存orchestrator single-window fallbackとadvisory `running_stats` はhard authorityへ流用禁止 |
| C0 `exact stop/reap契約` | contract §34.2.2・§51・§57を一体で再調停し、`already-exited` と state unknown、direct `idle`、child-tree disappearanceのexact evidence、自然終端cleanupとactive durable cancelの境界、stop evidence→run close→resource release→replacement gateの順序を1契約に凍結する | `docs/contract.md` の §34.2.2 / §51 / §57だけ。orchestrator/human contract owner。コード・signal・migrationなし | B1 host-finalized。採択前は現行§51 heuristicを勝手に変更せず、C1 ready禁止 |
| C1 `exact child ownership/reap` | C0契約どおりのdurable owner ledger、direct actual PGID/start readback、runtime child lifecycle ingest、TERM/KILL前recheck、unknown observe-only、doctor exact/unknown count。generic reapを新規提案しない | contract owner=C0。migration/Store API=`packages/core/src/types.ts`（orchestrator ownership）、`packages/core/src/db.ts`, `packages/core/src/readview.ts`, new `packages/core/src/process-ownership.ts` と migration/Store/readback tests。owner writer=`packages/adapters/src/direct-process.ts`、direct Codex/Claude launch adapters、shared runtime child lifecycle writer（exact pathはC0で固定）と tests。consumer/reap readback=`packages/core/src/process-hygiene.ts`, `packages/supervisor/src/stages/reap.ts`, `packages/cli/src/commands/doctor.ts` と tests | C0 host-finalized。B1のshared files/types/db ownership解放をreadback後に開始し、B1/C1を並行編集しない |
| V1 `full verification` | migration/backward compatibility、worker/reviewer、Codex/Claude、shared/direct、cancel/replacement、PID reuse、missing usage/model mismatch/reset、valid structured result、broad suitesの直列検証。production code変更は前taskへ差し戻す | integration/E2E fixtures と test runner evidence。原則 production ownershipなし | B1+C1 host-finalized。`pnpm typecheck`, focused tests, `pnpm -r --workspace-concurrency=1 test`, `pnpm lint`; test count/commandをtaskへ記録 |
| P1 `host publication + controlled crash/load canary` | dedicated synthetic runtime shardへ observer/guard/isolationを配備。2 synthetic runのexact generation termination、bounded usage threshold crossing、owned/unowned childを試験し、rollback/readbackを記録。production shared runtimeで最初のcrash/loadを行わない | external host wrapper/status writer、launchd/service config、deployment runbook/knowledge、host canary artifacts。`$HACHI_KANBAN_HOME/config.json` mutationはhuman/orchestratorだけ | V1 pass + explicit human approval。canary後 false positive 0、unowned signal 0、別generation/run影響0、rollback成功をpublication gateにする |

### 7.1 Focused verification matrix（後続で実行）

**A1**

- exact generation stop + structured close + time bound → `runtime_generation_interrupted`。
- direct / Hachi-owned native / external shared の各 identity variantで必須 model/PID/start を完全照合する。
- binding/transitionの同じfieldが双方missing、runtimeModelId missing、variant mismatchは exact match 0。
- diagnostic only、duration only、multi-run correlation only、replacement outside window、observer gap →
  既存 `worker_output_missing` / `extraction_failed`。
- valid structured success、stale run/session/role、legacy run meta →非回帰。
- worker/reviewer とも既存 `needs-manual:` lane、Git evidence、run closeが一度だけ。

**B0/B1**

- shared attestation は exact generation/model/window/parent-request-context semantics と writer PID/startをreadback。
- shared Codex/Claudeでattested notice/hard crossing→durable cancelを確認し、source全欠測のままB1をpassさせない。
- Codex exact model + same-sample window、Claude exact model + attested window。
- missing/mismatched model/window、single sample、counter decrease、compaction/truncate、late sample、旧generation。
- `running_stats` のabsolute/growthを context/hard authorityと誤認しない。
- notice steer一度、accepted≠ack、hard crossingは durable cancel row 一件、run close/stop 0。
- cancel disabled/unsupported shared runtime、worker/reviewer profile分離。

**C0/C1**

- actual `gone` だけを `already-exited` とし、state readback失敗、direct `idle`、leader消滅だけでは
  child-tree disappearance/run close/replacement gate解除を許さない。
- 自然終端のbest-effort cleanupとactive durable cancelを分け、exact stop evidence→run close→resource
  release→replacement の順序を§34.2.2/§51/§57で同じ決定表にする。
- exact PID/PGID/start/parent/generation/run match だけ TERM→fresh recheck→KILL。
- PID reuse、PGID drift、parent/generation mismatch、ledger missing、ps failure、unowned shared descendantは signal 0。
- direct leader exit後のexact child、exit code/signal/reap timestamp、二重tick冪等。
- current bridge age/tree heuristicとの契約変更を採択内容どおりに固定。

**V1/P1**

- same shared generation の2 synthetic runを止め、双方だけが A 理由になり、別generationは影響0。
- warning/hard thresholdを合成 usageで越え、soft steer→durable cancel の順と exact fence を確認。
- live loadは dedicated shard、synthetic prompt、human-approved upper bound、kill switch/readback付き。
- exact owned childだけが reapされ、同名・同PID再利用・unowned childは残る。

## 8. 未解決事項と採択判断

1. external even-terminal / shared Codex app-server は本 repo 外であり、task 制約により実装・status writer・
   process lifecycle を読んでいない。A1/B0/C1をreadyにする前に exact host-repo path、writer authority、
   PID/start/model/window sourceをreadbackして各task bodyへ所有fileとして固定する必要がある。
2. `running_stats.inputTokens` が累計か current request か、provider/transport間で同一意味かは current contract
   だけでは固定できない。B0/B1のhard authorityには使わず、P1のdedicated canaryでもadvisory検証に留める。
3. native Codex/Claude の exact provider session と走行中 native logの対応、ログ追記中の bounded parser性能は
   current adapterで未実装・未検証である。
4. shared app-server child は session/run owner lifecycleを現在発行しない。C1 ready前に exact writerを
   ownershipへ固定できなければ shared portionはobserve-onlyの別scopeに留め、C1をshared exact reap完了とは
   扱わない。いずれの場合もchild leakがcrash原因という結論は出せない。
5. current contract §51 の age/tree reapを維持するか exact ownership完成まで observe-onlyへ落とすかは、
   既存資源枯渇防止との trade-offを伴う。C0 で human/orchestratorが決める。
6. 30秒 correlation window、model別 notice/hard threshold、sample interval、cancel graceは採択値が未確定。
   保存 incident の 67万/114万をそのまま閾値にしない。
7. worktree baseline 後に local `origin/main` が進んでいる。A0 起票前に runtime SHAを取り直し、関連 symbolだけを
   semantic recheckする。

以上から、本 phase の推奨は review 対象であり、A0→A1→B0→B1→C0→C1 の各前提が
host-finalize される前に後続を ready にしない。
