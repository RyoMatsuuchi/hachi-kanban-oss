# B0-CX Codex isolated usage canary result

## Verdict

`unmeasured`

停止 phase は **4**。§5.2 Codex acceptance matrix は **pass 1 / fail 14**。phase 2 では generation 2 の
parent thread/turn に対して `turn/completed` 前の `thread/tokenUsage/updated` を3件観測したが、phase 1 で
fresh bind した採用 generation と phase 3 は generation 6 である。別 generation の parent を跨いだ観測は
同一 parent 内の順次実行を立証しないため、running parent request の証拠として採らない。phase 3 の
subagent boundary は generation 6 内で完結しているため pass のままとした。

phase 4 では明示的な `thread/compact/start` により `contextCompaction` item と compaction 専用 turn が完了したが、
usage payload の `counterEpoch`、revision、source sequence は全て absent で、total counter も compaction 前から変化しなかった。
旧 sample を無効化する fresh epoch fence を証明できないため `inconclusive => unmeasured` とし、停止規則に従って
phase 5 以降は実行していない。

## §5.2 Codex acceptance matrix

| dimension | pass/fail | 根拠 |
|---|---|---|
| running parent request | fail | phase 1 で fresh bind した採用 generation と phase 3 は generation 6 だが、parent の barrier 観測を行った phase 2 は generation 2 であり、同一 parent 内での tool/subagent/resume の順次実行を立証しない。さらに numeric semantics は fail で、phase 8 の finalized oracle 比較も未実行のため、current context semantics を oracle と矛盾なく説明できることも立証していない。 |
| numeric semantics | fail | `total` / `last` の各 numeric field は得たが、context に採る field、output 除外、cached の意味を固定できない。compaction sample では `last.totalTokens=5174` に対して他の `last` component が全て0だった。 |
| parent/tool boundary | fail | generation 6 の同一 parent turn で、parent sample order 73、`collabAgentToolCall(wait)` order 79/89、parent sample order 90 の順を観測し、parent total の差分 `20982` が order 90 の `last.totalTokens=20982` と一致した。しかし、この1点の数値一致だけでは tool output token を二重計上していないことを立証できない。 |
| subagent boundary | pass | parent の `subAgentActivity.agentThreadId` hash と child event の thread hash が一致し、`thread/read` で child の `parentThreadId` が parent hash に対応することを照合した。child usage order 85 は child thread、前後の order 73/90 は parent thread に bind された。 |
| compaction | fail | `contextCompaction` item と専用 turn は完了したが、fresh `counterEpoch` が absent で total counter も変化しない。旧 sample 無効化 fence を証明できない。 |
| model reroute | fail | phase 4 で停止したため phase 5 は未実行。旧/new model と usage/window の ordering は未観測。 |
| counter reset | fail | phase 4 で停止したため phase 6 は未実行。epoch 変更、revision/source sequence fence、resync は未観測。 |
| notification ordering/gap | fail | phase 2〜4 の callback local order は記録したが、disconnect/reconnect と gap 検出または authoritative resync は未観測。 |
| independent readback | fail | child identity の `thread/read` は行ったが usage readback ではない。phase 7 の same thread/turn/counter readback は未実行。 |
| context window | fail | positive `modelContextWindow=258400` は観測したが、sample 内に epoch/model binding が無く、same sample/epoch/model 条件を満たさない。 |
| turns | fail | parent/child turn lifecycle は観測したが、source sequence が absent のため parent exact count と duplicate/replay 除外を証明できない。 |
| source identity | fail | 全 usage sample で source sequence、source attestation ID、revision が absent。resume 直後に同一 numeric sample が再通知されても duplicate/replay を識別できない。 |
| generation/model/PID | fail | generation 6 の sample 前後で writer/runtime PID+OS start と effective model は一致したが、usage payload 内に generation/model/PID+OS start の atomic copy が無い。 |
| TTL/replay | fail | phase 4 で停止したため fixture は未実行。resume 直後の同一 sample 再通知にも revision/digest が無く、fresh/replay を分類できない。 |
| notification vs finalized oracle | fail | phase 8 は未実行。running sample と isolated finalized counter の関係、source gap 無しを照合していない。 |

## Phase observations

観測に使用した ID は SHA-256 hash。raw prompt、assistant text、tool output、transcript、credential は保存していない。
usage tuple は `(totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens)` の順で表す。

| phase | generation | acceptance上の扱い |
|---:|---:|---|
| 1 | 6 | fresh bind した採用 generation |
| 2 | 2 | phase 1 の generation 6 とは別 generation の parent 観測であるため、running parent request の証拠として採らない |
| 3 | 6 | subagent boundary は同一 generation 内で完結したため pass。parent/tool boundary は二重計上の不在を立証できず fail |

### Phase 1 — generation 6 fresh bind

採用 generation は generation 6。

| field | value |
|---|---|
| writer PID / OS start | `63849` / `Thu Aug 27 17:17:50 2026` |
| runtime PID / OS start | `63863` / `Thu Aug 27 17:17:51 2026` |
| generation | `6` |
| effective model | `gpt-5.6-sol` |
| parent thread hash | `5c1676187e30c21d25226e3c2a2f7820694d6c2110690d3f7bf9b6282f1a8c72` |
| bind monotonic time | `79010935 ms` |
| manifest/PID-start readback | matched at `79011046 ms` |

manifest 追記の直前/直後で writer/runtime PID+OS start は一致した。最終 fresh readback
`79753565 ms` でも generation 6 の同じ PID/start が生存していた。

再実行中の隔離 generation は次のとおり。いずれも worker は stop/cleanup していない。

| generation | writer PID/start | runtime PID/start | effective model | provider observationへの採否 |
|---:|---|---|---|---|
| 3 | `37240` / `Thu Aug 27 17:03:59 2026` | `37252` / `Thu Aug 27 17:03:59 2026` | absent | pre-bind JSON-RPC framing errorのため不採用 |
| 4 | `51013` / `Thu Aug 27 17:10:34 2026` | `51026` / `Thu Aug 27 17:10:34 2026` | absent | pre-bind request shape errorのため不採用 |
| 5 | `57904` / `Thu Aug 27 17:14:45 2026` | `57946` / `Thu Aug 27 17:14:45 2026` | `gpt-5.6-sol` | controller の child relation 判定不備のため不採用 |
| 6 | `63849` / `Thu Aug 27 17:17:50 2026` | `63863` / `Thu Aug 27 17:17:51 2026` | `gpt-5.6-sol` | 採用 |

### Phase 2 — generation 2 observation（running parent request の証拠として不採用）

前回観測の generation 2 parent thread hash は
`60bf9246e9dbfc7c559a7429d153623f4138544ef3c467cd9e86daaa80dadb74`、turn hash は
`20afbba9bebad6d2fb64f4483cd3c368af5c30d24603038e160bc5c29bb32261`。

| order | monotonic ms | event | observation |
|---:|---:|---|---|
| 2 | 76962231 | `turn/started` | parent turn `inProgress` |
| 4 | 76965234 | `item/tool/call` | barrier 1 |
| 7 | 76965992 | `thread/tokenUsage/updated` | sample A |
| 9 | 76967962 | `item/tool/call` | barrier 2 |
| 12 | 76968720 | `thread/tokenUsage/updated` | sample B |
| 13 | 76973606 | `thread/tokenUsage/updated` | sample C |
| 14 | 76973607 | `turn/completed` | parent turn `completed` |

| sample/order | total tuple | last tuple | window |
|---|---|---|---:|
| A / 7 | `(13971,13925,0,46,15)` | `(13971,13925,0,46,15)` | 258400 |
| B / 12 | `(27997,27922,13056,75,15)` | `(14026,13997,13056,29,0)` | 258400 |
| C / 13 | `(42196,41974,26112,222,150)` | `(14199,14052,13056,147,135)` | 258400 |

3件とも `turn/completed` 前で、同じ parent thread/turn に bind されていた。`counterEpoch`、source sequence、
revision、source attestation ID は absent。ただし phase 1 が fresh bind した generation 6 とは別 generation で行われたため、
generation 6 で実行した phase 3 と同一 parent の順次実行を立証せず、running parent request の証拠として採らない。

### Phase 3 — generation 6 observation

generation 6 の parent thread hash は
`5c1676187e30c21d25226e3c2a2f7820694d6c2110690d3f7bf9b6282f1a8c72`、child thread hash は
`d3f732b486a5a1f46ccf41cd42dc32212518fdcadcd61f93c3f19c84be3b8a29`。

| order | monotonic ms | event | subject |
|---:|---:|---|---|
| 7 | 79011096 | `turn/started` | parent tool turn |
| 28 / 29 | 79015448 | `item/commandExecution` started/completed | parent tool |
| 30 / 38 | 79015453 / 79018114 | `thread/tokenUsage/updated` | parent tool turn |
| 41 | 79018115 | `turn/completed` | parent tool turn |
| 43 | 79018127 | `turn/started` | parent child-control turn |
| 72 | 79022250 | `item/subAgentActivity` completed | parentからchild hashを観測 |
| 73 | 79022265 | `thread/tokenUsage/updated` | parent |
| 76 | 79022280 | `turn/started` | child |
| 79 / 89 | 79024205 / 79028019 | `item/collabAgentToolCall(wait)` started/completed | parent |
| 85 / 88 | 79028015 / 79028019 | `thread/tokenUsage/updated` / `turn/completed` | child |
| 90 / 98 | 79028027 / 79030275 | `thread/tokenUsage/updated` | parent |
| 101 | 79030275 | `turn/completed` | parent child-control turn |
| — | 79030279 | `thread/read` | child `parentThreadId` hashがparentと一致 |
| — | 79030284 | `thread/resume` | parent hash/model一致 |
| 102 | 79030285 | `thread/tokenUsage/updated` | resume直後に直前parent sampleを同値再通知 |
| 105 | 79030297 | `turn/started` | resumed parent turn |
| 110 / 111 | 79033968 | `item/commandExecution` started/completed | resumed parent tool |
| 112 / 122 | 79033974 / 79036721 | `thread/tokenUsage/updated` | resumed parent |
| 125 | 79036721 | `turn/completed` | resumed parent turn |

| subject/order | total tuple | last tuple | window |
|---|---|---|---:|
| parent / 30 | `(20764,20669,9984,95,0)` | `(20764,20669,9984,95,0)` | 258400 |
| parent / 38 | `(41565,41462,30208,103,0)` | `(20801,20793,20224,8,0)` | 258400 |
| parent / 73 | `(62504,62318,50432,186,19)` | `(20939,20856,20224,83,19)` | 258400 |
| child / 85 | `(20667,20660,16128,7,0)` | `(20667,20660,16128,7,0)` | 258400 |
| parent / 90 | `(83486,83279,70656,207,19)` | `(20982,20961,20224,21,0)` | 258400 |
| parent / 98 and duplicate 102 | `(104540,104325,90880,215,19)` | `(21054,21046,20224,8,0)` | 258400 |
| resumed parent / 112 | `(125744,125426,111104,318,43)` | `(21204,21101,20224,103,24)` | 258400 |
| resumed parent / 122 | `(146989,146661,131328,328,43)` | `(21245,21235,20224,10,0)` | 258400 |

child は parent と別 subject でusageを持ち、parent の前後 sample は同一 parent turn に残った。resume 後も parent hash と
effective model は一致した。一方、全 sample で counter/source identity fields は absent。

### Phase 4 — inconclusive => unmeasured

`thread/compact/start` request は `79036722 ms` に開始し、compaction 専用 turn と
`contextCompaction` item は次の順で完了した。

| order | monotonic ms | event |
|---:|---:|---|
| 127 | 79036733 | `turn/started` |
| 128 | 79036735 | `item/contextCompaction` started |
| 129 | 79047236 | `thread/tokenUsage/updated` |
| 131 | 79047236 | `item/contextCompaction` completed |
| 133 | 79047245 | `turn/completed` |

order 129 の total tuple は compaction 前と同じ
`(146989,146661,131328,328,43)`、last tuple は `(5174,0,0,0,0)`、window は `258400`。
`counterEpoch`、revision、source sequence、source attestation ID は absent だった。

deprecated `thread/compacted` notification は8分の bounded wait (`79516727 ms`) まで届かなかった。
ただし `contextCompaction` item 自体は観測しているため、停止理由は compaction 未発生ではなく、fresh epoch と
旧 sample 無効化順序を証明できないこと。

### Phase 5–8 — not executed

phase 4 の inconclusive で verdict が `unmeasured` に確定したため、停止規則に従って model reroute、reconnect/counter reset、
notification 前後の independent usage readback、finalized oracle comparison は実行していない。

## Failure reason and required host work

- 実行中に host 作業は依頼していない。
- authoritative 再判定には、compaction で fresh `counterEpoch` と旧 sample 無効化 ordering を provider-owned event/readback として返す実装、または同等の deterministic isolated fixture が必要。
- host は manifest の exact PID+OS start を照合し、generation 1〜6 の isolated writer/runtime が全て消滅したことを確認済み。§5.3 の host cleanup 対応は完了している。worker は stop/cleanup を実行していない。
- production/shared process、既存 user session、shared DB、TCP port、Docker、browser は使用していない。
