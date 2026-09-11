# B0-CC Claude isolated usage canary result

## Verdict

- verdict: `unmeasured`
- stopped phase: `0`
- reason: SDK running eventsは外部親プロセスから観測できたが、resume/session stateは同一parent requestのusage、counter、epoch、windowを独立readbackしなかった。resume後に最初に得られたusageは、別message IDで開始した新規requestの`message_start`だった。
- final `result` usageはrunning authorityにもreadbackの代用にも使用していない。

## Phase 0 observation

観測に使ったfresh sessionは `sessionHash=a7050ad48f2454ef`、generation `3`。host smoke sessionおよび既存sessionは参照していない。

### Runtime identity

| callback order | monotonic ms | event | writer/runtime PID | OS start | generation | model readback |
|---:|---:|---|---:|---|---:|---|
| 1 | 108 | `external.spawn` | 96969 | `Thu Aug 27 16:50:30 2026` | 3 | 未観測 |
| 2 | 759 | `system.init` | 96969 | `Thu Aug 27 16:50:30 2026` | 3 | `claude-opus-5[1m]` |
| 5 | 1,672 | `message_start` | 96969 | `Thu Aug 27 16:50:30 2026` | 3 | `claude-opus-5` |
| 14 | 3,037 | `external.spawn` | 97074 | `Thu Aug 27 16:50:33 2026` | 3 | 未観測 |
| 15 | 3,723 | `system.init` | 97074 | `Thu Aug 27 16:50:33 2026` | 3 | `claude-opus-5` |
| 17 | 4,573 | `message_start` | 97074 | `Thu Aug 27 16:50:33 2026` | 3 | `claude-opus-5` |

### Running event ordering and numeric usage

| callback order | monotonic ms | source | message hash | input | cache create | cache read | output | 判定 |
|---:|---:|---|---|---:|---:|---:|---:|---|
| 5 | 1,672 | `message_start` | `730cf31a970797d3` | 2 | 151 | 2,744 | 1 | `result`前のrunning update |
| 8 | 2,340 | `assistant` | `730cf31a970797d3` | 2 | 151 | 2,744 | 1 | `result`前のrunning update |
| 10 | 2,389 | `message_delta` | 同一stream | 2 | 151 | 2,744 | 3 | `result`前のrunning update |
| 12 | 2,396 | `result.success` | sessionのみ | - | - | - | - | finalized境界。usage値は不使用 |

running sourceの観測自体はpass。2つ以上のbarrierでsource updateを得ており、`message_start`はfinalized responseではない。

### Independent resume/session-state readback

| callback order | monotonic ms | source | usage/counter/window | message hash | 判定 |
|---:|---:|---|---|---|---|
| 15 | 3,723 | resume `system.init` | 無し | - | fail |
| 16 | 3,724 | resume `system.status` | 無し | - | fail |
| 17 | 4,573 | resume `message_start` | input 2 / cache create 2,904 / cache read 0 / output 1 | `5e3b97679a3346a8` | 新規request。readbackではない |

resume開始時のreadback eventにusage候補のnumeric fieldは無かった。callback 17はfresh側のmessage hash `730cf31a970797d3`と異なる新規requestなので、same request/counterの独立readbackとして採用できない。phase 0は`inconclusive => unmeasured`で停止した。

## Phase execution

| phase | 実行可否 | 観測・停止理由 |
|---:|---|---|
| 0 | 実行、停止 | running SDK eventは観測できたがindependent readbackが不成立 |
| 1 | 未実行 | phase 0の停止規則を適用 |
| 2 | 未実行 | phase 0の停止規則を適用 |
| 3 | 未実行 | phase 0の停止規則を適用 |
| 4 | 未実行 | phase 0の停止規則を適用 |
| 5 | 未実行 | phase 0の停止規則を適用 |
| 6 | 未実行 | phase 0の停止規則を適用 |
| 7 | 未実行 | phase 0の停止規則を適用 |
| 8 | 未実行 | phase 0の停止規則を適用。finalized log oracleは読んでいない |

## §5.2 Claude acceptance matrix

| dimension | pass/fail | 根拠 |
|---|---|---|
| running parent request | pass | callback 5、8、10で`result.success`前に2回以上のrunning updateを観測 |
| numeric semantics | fail | input/output usageは観測したが、parent context、counter、epoch、windowの同一sample bindingを固定できない |
| parent/tool boundary | fail | phase 0停止により未観測 |
| subagent boundary | fail | phase 0停止により未観測 |
| compaction | fail | phase 0停止により未観測 |
| model reroute | fail | phase 0停止により未観測 |
| counter reset | fail | phase 0停止により未観測 |
| notification ordering/gap | fail | phase 0停止により未観測 |
| independent readback | fail | resume `system.init`/`system.status`にusage/counter/windowが無く、次のusageは別message IDの新規request |
| context window | fail | same sample/epoch/modelのprovider-observed positive windowが無い |
| turns | fail | running parent turnのreadbackが無い。`result`の`num_turns`は使用していない |
| source identity | fail | same-request readbackとsource sequence/gap identityを観測できない |
| generation/model/PID | fail | PID+OS startとmodelは観測したが、usage/readbackとのatomicなfresh before/after bindingが未成立 |
| TTL/replay | fail | phase 0停止により未観測 |
| notification vs finalized oracle | fail | phase 8未実行。oracle比較なし |

## Fail / inconclusive and required host work

現行Claude CLIの外部出力面では、active sessionのsame parent request/counter/epoch/windowを、新規requestを開始せずに返す独立readbackを確認できなかった。現在のcanaryを続行するために依頼すべきhost操作は無く、後続phaseは実行価値がない。

再canaryの前提として必要なのは、isolated Claude sessionに対してsame request/counter/epoch/model/windowを返す独立したresume/session-state readback surfaceをprovider/SDKまたはhost-owned observerが用意し、そのsource identityとgap/reset fenceを外部親プロセスへ露出することである。その前提が用意された場合のみ、別の隔離generationでphase 0から再実行する。
