# handover successor bootstrap liveness 設計

## 0. 結論とスコープ

- 基準 SHA は <code>2ec2f950745400691d4c782ffeeac9df65ca5489</code>。evidence 更新時点の
  <code>origin/main</code> は <code>0b8009ba09874f1a07c6949260e8aebfb3201460</code> である。
  両 SHA の差分は t_726 の設計文書追加 1 ファイルだけであり、以下の実装事実と推奨 A は変わらない。
- 推奨は **A: Claude delivery handover の起動 prompt 先頭で、exact successor row の解決と
  generation-fenced 4 点セットを完了してから正本を読む**、の 1 案に凍結する。
- A は、親 CLI が durable final で既に作成した successor session を read-only に exact 解決する。
  generic <code>session start</code> は実行しない。初回 heartbeat の成功後に 30 秒 heartbeat loop と
  別プロセスの await を開始する。
- 通常の stale TTL 90 秒、delivery attestation、durable slot、final/rollback transaction は変更しない。
  liveness 対策としての DB/config/migration、新しい shared final 必須 field、初回 grace は導入しない。
- 本文書は調査・設計だけである。CLI/core/contract/playbook/host は変更せず、handover/takeover/canary も
  実行していない。

## 1. current-main fact table

### 1.1 正本・実装

| ID | current-main の事実 | 証拠 |
|---|---|---|
| F1 | 新セッションの正規 4 点は、board session 登録、usage hook opt-in、30 秒の独立 heartbeat loop、別プロセスの await である。1 点でも欠くと監視が止まる。 | <code>runbooks/orchestrator-playbook.md:393-410</code> |
| F2 | stale TTL は 90 秒、heartbeat は 30 秒であり、TTL だけを延長してはいけない。await は claim 後 return するため heartbeat と分離する。 | <code>runbooks/orchestrator-playbook.md:443-451</code>、<code>docs/contract.md:3262-3270</code> |
| F3 | 後継は playbook 全文、reference の必要節、contract の関連節、knowledge、mission task を順に読む。これは初期化後にも相応の時間を要する正規手順である。 | <code>runbooks/orchestrator-playbook.md:471-480</code> |
| F4 | Claude handover は tmux argv の第 1 prompt で起動する provider 固有経路である。Codex はこの経路へ倒さない。 | <code>runbooks/orchestrator-reference.md:106-137</code>、<code>runbooks/orchestrator-playbook.md:464-469</code> |
| F5 | current prompt は mission ID、旧 session ID、provider session ID、launch nonce、親 final の注意、§0.7.4 参照の 6 行だけで、source generation も 4 点セットもない。test も 6 行を exact に固定している。 | <code>packages/cli/src/commands/orchestrator.ts:1909-1926</code>、<code>packages/cli/src/commands/orchestrator-handover.test.ts:801-817</code> |
| F6 | Claude 経路は delivery gate 後に source=<code>claude-delivery</code> で attest し、claim、atomic final、succeeded readback までを親 CLI が行う。 | <code>packages/cli/src/commands/orchestrator-successor-launch.ts:857-940</code> |
| F7 | final は旧 row の authority を移し、successor session 作成と slot succeeded を単一 transaction にする。Claude と Codex は同じ final transaction を共有する。 | <code>docs/contract.md:3923-3947</code>、<code>packages/core/src/orchestrator-successor-launch.test.ts:578-623</code> |
| F8 | session 作成時は <code>heartbeat_at=created_at=now</code>。これは successor process の heartbeat 観測ではない。 | <code>packages/core/src/db.ts:9156-9184</code> |
| F9 | heartbeat は exact session ID、generation、status=active が必要で、不一致は <code>SESSION_SUPERSEDED</code>。 | <code>packages/core/src/db.ts:9255-9269</code> |
| F10 | supervisor は <code>heartbeatAt &lt; now - 90</code> の active row を stale にする。91 秒 gap の回帰 test がある。 | <code>packages/supervisor/src/stages/orchestrator-routing.ts:195-207</code>、<code>packages/supervisor/src/stages/orchestrator-routing.test.ts:85-118</code> |
| F11 | generic start/takeover は provider pair を <code>manual</code> として正規化する。trusted <code>claude-delivery</code> は successor final だけが設定できる。 | <code>packages/core/src/db.ts:3779-3791</code>、<code>docs/contract.md:3842-3845</code>、<code>packages/core/src/db.ts:9536-9575</code> |
| F12 | blocking successor slot は stale 回収から除外されるが、succeeded final 後の active successor row は通常の 90 秒判定へ戻る。 | <code>packages/core/src/db.ts:9578-9599</code> |

### 1.2 board に保存された incident

時刻は board の epoch 秒を Asia/Tokyo へ変換した値である。task logs/transcript 全文は参照していない。
session lifecycle は task event ではなく session row が正本なので、row ID と mission comment ID を分けて示す。

| board evidence ID | 保存値 | 限定照合 |
|---|---|---|
| <code>os_d3f3b2b9eff0c1a1</code> | orchestrator=<code>o_c5b183834be205c4</code>、gen15、provider=<code>claude</code>、source=<code>claude-delivery</code>、created/heartbeat=<code>1787721083</code>（14:11:23）、updated=<code>1787721180</code>（14:13:00）、status=<code>stale</code> | 作成値から stale 更新まで 97 秒。F8/F10 の strict 90 秒判定と整合する。 |
| mission comment <code>#3436</code> on <code>t_168e984f557960d8</code> | 「gen15 作成 14:11:23 → §0.7.4 core 通読中に TTL 超過 → 14:13:00 stale」、late heartbeat/await は superseded、takeover で gen16 復旧 | 保存時刻と人間の観測理由を結ぶ board 証言。transcript による行動順の追加推測はしていない。 |
| <code>os_febf5253c9007fbb</code> | gen16、同じ provider session ID、source=<code>manual</code>、created=<code>1787721277</code>（14:14:37）、status=<code>active</code> | F11 と整合する。takeover は liveness を回復したが delivery authority を再生成しない。 |
| task event <code>#15110</code> / <code>#15117</code> | 本 task の本文更新と current worker launch | incident の task 化と基準 scope の board 記録。session lifecycle event の代用にはしない。 |
| t_726 comment <code>#3447</code> / event <code>#15132</code> | reviewer pass/high 後に host-finalize され、commit/main/origin=<code>0b8009ba09874f1a07c6949260e8aebfb3201460</code>。差分は model authority 設計文書 1 ファイル | 本文書との合成に使う最新境界。旧 block reason や review 完了時点ではなく、host-finalize 後の current state を採用する。 |

## 2. 競合の状態遷移と root cause

### 2.1 タイムライン

~~~text
gen14 active
  |
  | handover arm -> tmux spawn/bind -> prompt delivery
  | 親 CLI が claude-delivery attest -> claim -> atomic final
  v
14:11:23  gen14 superseded + gen15 active + slot succeeded
          gen15.heartbeat_at は process の heartbeat 観測値ではなく作成時刻
          child prompt は「§0.7.4 に従え」だけで 4 点セット/source generation がない
  |
  | child が正規の通読へ進む。親 CLI は child の初回 heartbeat を待たない
  | heartbeat gap が 90 秒を超える
  v
14:13:00  supervisor が 97 秒 gap の gen15 を stale 化
          以後 gen15 の heartbeat/await は SESSION_SUPERSEDED
  |
  | generic stale takeover
  v
14:14:37  gen16 active。providerSessionSource は manual
~~~

### 2.2 root cause と確度

| 判断 | 確度 | 根拠 |
|---|---|---|
| 直接原因は「session authority を作る親」と「最初の liveness 証拠を出す child」の間に bootstrap handshake がなく、作成時刻を heartbeat として 90 秒計測が開始する非対称である。 | 高 | F5〜F10 と gen15 row が機械的に一致する。 |
| §0.7.4 の正規通読が 90 秒 window を消費した。 | 中〜高 | comment #3436 と 97 秒 gap は一致するが、禁止 scope に従い transcript 全文では再検証していない。 |
| delivery attestation/final 自体が弱い、または壊れている。 | 否定 | gen15 は source=<code>claude-delivery</code> で作成され、slot final 後の通常 active liveness で stale になった。delivery と liveness は別の証明である。 |

したがって直す対象は「final の前後」ではなく、**final 済み exact row を child が取得し、通読より先に
自分の heartbeat を記録する順序**である。

## 3. A〜D 比較

| 軸 | A: prompt 先頭で exact 4 点 | B: 親が初回 heartbeat まで代行 | C: child attestation まで final 延期 | D: 初回 grace を保存 |
|---|---|---|---|---|
| liveness 意味論 | child 自身の最初の heartbeat から現行 30/90 契約へ接続する | 親の生存を child の生存として記録し、意味が混ざる | attestation の定義を増やし、delivery と liveness を再結合する | heartbeat 不在の active を特別に生存扱いする |
| delivery attestation 強度 | 不変。succeeded final だけを read-only 解決 | 代行値だけでは child delivery/実行を強めない | 新 ack を authority にすると現行 2 段 delivery の意味を変更 | 不変だが child 不在を長く隠す |
| final/rollback 原子性 | 不変 | final 後に親 proxy lifecycle が追加される | final/rollback boundary 自体を変更し、crash state が増える | final は不変だが stale predicate が複線化 |
| provider 共通性 | Claude delivery handover だけに限定可能 | provider ごとの親 lifetime 差を吸収する必要 | Codex SessionStart と Claude delivery の差を再設計 | shared session schema/policy 全体へ波及 |
| prompt 規律依存 | ある。無視時は通常 90 秒で fail-closed | 小さいが、親が child になりすましている | child ack prompt/hook への依存が別形で残る | 小さい代わりに silent grace に依存 |
| crash/timeout | resolver/初回 heartbeat 失敗は mutation 0、fallback なし | 親 crash と proxy 終了の境界・最大代行時間が新たに必要 | accepting/attesting 中の durable recovery と token fence を再設計 | crash 検出を grace 分遅らせる |
| Codex 非破壊 | strict Claude predicate で非対象にできる | shared final 後へ入れると Codex に波及しやすい | §§70〜73 の Codex/Claude 共通 final を変更する | shared TTL 判定を変えるため最も広い |
| migration | 不要 | heartbeat provenance/lease を正しく持つなら必要になり得る | 新状態/ack/fence の migration が必要 | grace field と policy migration が必要 |
| focused/live test | prompt、resolver、first heartbeat、91/98 秒を局所検証可能 | 親/child crash matrix と実プロセス test が必要 | full state-machine/race/recovery test が必要 | clock/migration/supervisor の広範 test が必要 |
| 判定 | **採用** | 棄却 | 棄却 | 棄却 |

### 棄却理由

- **B**: current schema の heartbeat に producer/provenance がないため、親の代行は child の生存証拠と区別できない。
  bounded にしても親 crash と代行終了の race が増え、child の初回 heartbeat を観測する別の ack が必要になる。
- **C**: delivery 確認済みの provider ID、token fence、旧 authority、slot final の原子境界を全面的に動かす。
  今回の 97 秒 gap を直すための変更量と recovery state が過大で、§§70〜73 を弱める危険が最も高い。
- **D**: active だが heartbeat のない row を意図的に 90 秒超生かす。通常 TTL を恒久延長しないという制約を
  名前だけ変えて迂回し、child 未起動/無視の検知を遅らせる。妥当な grace 長の live evidence もない。

## 4. 凍結する A の exact 契約

### 4.1 build-time prompt injection と runtime resolver の適用 predicate

<code>runHandover</code> の dry-run が返す <code>startupPrompt</code> は、reference §0.7.5 の
Codex Desktop manual <code>create_thread</code> fallback でも骨組みとして流用される。したがって Claude の
bootstrap 命令を組み立てる **build-time predicate** は、durable launch row が存在する実行時 predicate ではなく、
prompt builder の入力だけで次のすべてを満たす場合に限定する。

~~~text
promptBuildKind == "claude-delivery-handover"
&& sourceSession != null
&& sourceSession.provider == "claude"
~~~

<code>promptBuildKind</code> は CLI/JSON から指定できない閉じた内部 discriminator とし、
<code>runHandover</code> が exact source session を読んだ call site だけで決定する。
実装は provider 別 builder に分ける。現行 6 行を byte-level で返す manual-compatible builder と、そこへ
通読前 4 点セットを追加する Claude delivery handover builder を持ち、<code>runHandover</code> call site は
上の predicate が成立する場合だけ後者を選ぶ。<code>options.apply</code>、後置の
<code>provider-launchable</code> preflight、まだ存在しない slot の expected source を builder 選択根拠にしない。
source が Codex、空、不明、partial の dry-run は manual-compatible builder の現行 bytes を維持し、apply 自体は
既存 <code>provider-launchable</code> で fail-closed に止める。

Claude prompt が子で実行された後の **runtime resolver predicate** は別であり、次のすべてを満たす exact
<code>succeeded</code> row だけに適用する。

~~~text
launch.kind == "handoff"
&& launch.targetProvider == "claude"
&& launch.providerSessionSource == "claude-delivery"
&& launch.sourceSessionId == prompt.sourceSessionId
&& launch.sourceGeneration == prompt.sourceGeneration
&& launch.launchNonceHash == sha256(prompt.launchNonce)
&& launch.providerSessionId == prompt.providerSessionId
&& launch.status == "succeeded"
~~~

さらに、launch が指す successor row を exact に再読し、次をすべて要求する。

~~~text
successor.id == launch.successorSessionId
&& successor.orchestratorId == source.orchestratorId
&& successor.generation == sourceGeneration + 1
&& successor.provider == "claude"
&& successor.providerSessionId == prompt.providerSessionId
&& successor.providerSessionSource == "claude-delivery"
&& successor.status == "active"
~~~

0 件、複数件、partial、mismatch、期限内に succeeded へ到達しない場合は non-zero、mutation 0 とする。
「同じ provider session ID の最新 generation」や「唯一の active row」への fallback は禁止する。
runtime 側の <code>targetProvider=claude &amp;&amp; providerSessionSource=claude-delivery &amp;&amp;
launchKind=handoff</code> は resolver の authority 条件であり、上の build-time builder 選択へ逆流させない。

### 4.2 prompt に追加する field

| field | 出所 | 用途 |
|---|---|---|
| <code>sourceSessionId</code> | 現行 prompt の旧 session ID | exact slot/source fence |
| <code>sourceGeneration</code> | runHandover が既に検証した旧 generation | generation fence。今回追加が必要 |
| <code>providerSessionId</code> | Hachi が <code>claude --session-id</code> に固定した UUID | hook opt-in と successor row 照合 |
| <code>launchNonce</code> | 現行 delivery nonce | exact launch row の read-only 解決 |

handoff token、accept/stop fence、raw owner nonce、model secret は prompt に追加しない。

### 4.3 通読前の順序

親 final は child の第 1 assistant row 観測後に完了するため、child は 15 秒を上限に 250 ms 間隔で
exact succeeded row を待てる read-only CLI を使う。名称は実装 phase で
<code>hachi orchestrator successor-bootstrap resolve</code> とし、少なくとも
<code>--source-session</code>、<code>--source-generation</code>、
<code>--provider-session-id</code>、<code>--launch-nonce</code>、<code>--max-wait 15</code>、
<code>--json</code> を受ける。既存 Store の slot/session read 面だけを使い、新しい DB authority は作らない。

prompt の最初の命令は「以下が成功するまで playbook/task/knowledge を読まない」とし、順序を固定する。

1. **session bind**: resolver で親 final が作った exact successor
   <code>(sessionId,generation,orchestratorId)</code> を取得する。delivery handover ではこれが
   playbook の point 1 に相当する。generic <code>session start</code> は実行しない。
2. **usage hook opt-in**: <code>hachi-orch-enable &lt;providerSessionId&gt;</code> を実行する。
3. **liveness**: exact ID/generation へ同期 heartbeat を 1 回打ち、その成功を確認してから、同じ exact pair の
   30 秒 heartbeat loop を独立 process で開始する。loop は別 generation を探索しない。
4. **inbox**: heartbeat loop と別に generation-fenced await を開始する。claim して return したら内容を処理し、
   同じ exact pair で再 arm する。

1〜4 のいずれかが失敗したら正本通読や task mutationへ進まず、generic start/takeover/manual fallback を行わない。
人間へ exact error と再実行可能な read-only command を提示して停止する。初回同期 heartbeat が成功して初めて、
§0.7.4 の通読へ進む。

### 4.4 共有 slot/final に適用してはいけない条件

以下は A の対象外であり、bootstrap field/resolve/ack を attest/final の必須条件にしない。

- Codex <code>codex-session-start</code> handoff/takeover。既存 SessionStart helper、handle、Gate 3/4、
  <code>buildStartupPrompt</code> を変更しない。
- Codex source の <code>runHandover</code> dry-run と、それを骨組みにする reference §0.7.5 manual
  <code>create_thread</code> fallback。現行 6 行の byte-level 互換を維持し、Claude delivery slot resolver、
  source generation、通読前 4 点セットを注入しない。
- Claude takeover、generic manual start/takeover、placeholder/register。
- source が空、manual、unknown の session、migration 前 legacy row。
- <code>kind=takeover</code>、<code>targetProvider=codex</code>、または
  <code>providerSessionSource!=claude-delivery</code> の shared slot。
- arm/runtime_bound/attested/accepting/stop_pending/uncertain row。resolver がこれらを heartbeat 対象にしない。
- shared <code>acceptOrchestratorHandoffWithSuccessorLaunch</code> transaction。初回 heartbeat ack を final 条件へ
  追加せず、parent final の原子性と replay を維持する。

unknown/partial discriminator を Claude 扱いへ fallback してはならない。対象外の既知 Codex/manual/legacy は
現行経路を維持し、unknown/partial だけは resolver の authority 0 とする。

## 5. §§70〜73 と t_726 model authority との合成境界

### 5.1 durable successor 契約

- §§70〜73 の slot は外部 launch authority、provider-generated ID、runtime owner、final/rollback を証明する。
  A は succeeded final の**後**を read-only に参照し、その証明を代替しない。
- source session/generation、launch nonce hash、provider/source、successor pointer は既存 slot の値を使う。
  liveness 専用 persistent field、bootstrap ack、grace deadline を slot/session に追加しない。
- final 後に親が heartbeat を代行しない。child の exact heartbeat だけが liveness 証拠である。

### 5.2 t_726 との provider predicate 共用

t_726 の review 済み model/window authority は次の exact predicate だけに version 1 field と model exact gate を
適用する。

~~~text
targetProvider == "claude"
&& expectedProviderSessionSource == "claude-delivery"
&& launchKind == "handoff"
~~~

A も同じ provider/source/kind の集合に限定するが、責務は分離する。
これは final/usage 時の runtime discriminator の共用であり、<code>runHandover</code> dry-run の
build-time predicate には使わない。build 時点では expected source を持つ durable row がまだ無いためである。

| 面 | t_726 model authority | 本文書の bootstrap liveness |
|---|---|---|
| arm/final 前 | expected model/window、runtime model exact readback、version 1 discriminator | 変更しない |
| final | model predicate を exact 再検証 | bootstrap ack を要求しない |
| final 後 | usage の context model exact gate | succeeded row を exact 解決し child heartbeat を開始 |
| Codex/manual/legacy | Claude-only field/veto/unmeasured を適用しない | prompt/resolver/4 点 inline を適用しない |

両成果物は後続の同一「設計/契約」phase で 1 つの successor 契約へ統合する。t_726 が予定する §75 と
本書の bootstrap 節を別 worker が独立採番しない。current main が進んだ場合は contract の次の空き番号を
再確認して 1 owner が cross-reference を確定する。

## 6. fail-closed 反例

| 反例 | 許可する結果 | 禁止する fallback / 検証 |
|---|---|---|
| 親が spawn/delivery 前に停止 | session/final なし、slot は既存 rollback/recovery 契約へ。child は未起動 | session 作成や stale grace を推測しない |
| 親が delivery 後、final 前に停止 | resolver は 15 秒で 0 件、mutation 0。blocking slot を維持 | generic start、同 token relaunch、別 slot 選択をしない |
| 親が final 後に停止 | child は exact succeeded row を解決して自分で heartbeat を開始可能 | 親 heartbeat 代行を必要条件にしない |
| 後継が未起動 | delivery gate が成立せず final/session を作らない。既存 exact rollback | active row/grace を先に作らない |
| prompt を無視 | final 済み row は現行 90 秒で stale、incident を残す | grace、親 proxy、自動 takeover で隠さない |
| 初回 heartbeat 欠落/失敗 | 通読へ進まず停止。active row は通常 TTL で stale | heartbeat 成功を推測しない |
| heartbeat loop が初回後に死亡 | 最後の heartbeat から通常 90 秒で stale | await や usage hook だけを生存根拠にしない |
| generation 競合 | resolver mismatch または heartbeat の <code>SESSION_SUPERSEDED</code>、mutation 0 | newest generation の再探索・自動 bind をしない |
| takeover が先行 | old prompt は slot が指す gen15/source=<code>claude-delivery</code> 以外を拒否する。gen16 manual を同じ provider ID で選ばない | manual gen16 への付け替え、source 昇格をしない |
| slot 0 件/複数件/partial | resolver non-zero、mutation 0 | provider ID だけで候補選択しない |
| await が request を claim して return | heartbeat loop は独立して継続。await は内容処理後に同 pair で再 arm | await を heartbeat loop と兼用しない |

## 7. 後続 DAG、ownership、verification

~~~mermaid
flowchart LR
  A["A 設計/契約"] --> B["B Core/config/migration"]
  B --> C["C CLI局所実装 + focused tests"]
  C --> D["D 独立review + full verification"]
  D --> E["E host publication + isolated live handover canary"]
  M["t_726 reviewed model authority"] --> A
  L["本 bootstrap-liveness 設計"] --> A
~~~

| phase | depends-on | owner / 所有 file | 完了 gate |
|---|---|---|---|
| A. 設計/契約 | t_726 review pass、本書 review pass | orchestrator + Sol/xhigh の 1 owner。<code>docs/contract.md</code>、<code>runbooks/orchestrator-playbook.md</code>、<code>runbooks/orchestrator-reference.md</code>。必要な <code>packages/core/src/types.ts</code> 変更は t_726 model authority 分だけをこの gate で凍結 | Claude-only model predicateとAの bootstrap順序を同じ節で統合。Codex/manual/legacy非破壊、通常90秒、point 1 の provider差分を正本化 |
| B. Core/config/migration | A | Core/config/DB の 1 owner。t_726 が凍結した <code>packages/core/src/config-schema.ts</code>、<code>packages/core/src/policy.ts</code>、<code>packages/core/src/db.ts</code> と対応 tests | t_726 の v24/model authority を実装。**A liveness 由来の schema/config/migration/grace は追加しない**。既存 v23 final と Codex fixture を維持 |
| C. CLI局所実装 + focused tests | B | CLI の 1 owner。<code>packages/cli/src/commands/orchestrator.ts</code>、<code>packages/cli/src/commands/orchestrator-successor-launch.ts</code>、新規 narrow resolver module、<code>packages/cli/src/deps.ts</code>、対応 tests。model authority と liveness が同じ file に触れるため並列 ownership にしない | 下記 focused tests が green。prompt/JSON に secret を出さず、dry-run/apply argv 同型、Codex path byte-level 非回帰 |
| D. 独立 review/full verification | C | 独立 reviewer。原則 read-only。repository 全体 | focused tests再実行、<code>pnpm typecheck</code>、serialized <code>pnpm test</code>、<code>pnpm lint</code>、<code>git diff --check</code>。authority・crash・Codex非破壊を別視点で判定 |
| E. host publication + isolated live handover canary | D | 権限を持つ human/orchestrator。host config、review済み helper/install、隔離 identity/worktree | t_726 model config publication後、隔離 Claude handover 1 回。exact cleanup、rollback path、Codex fallback を維持。失敗時は restart/takeoverを自動化せず停止 |

各 phase は前 phase の成果を host-finalize してから次を ready にする。実装 task の file ownership は重複させない。

### C の focused tests

1. exact Claude source かつ <code>promptBuildKind=claude-delivery-handover</code> の fixture だけが Claude builder を選び、
   prompt の先頭に bootstrap 命令、source generation と現行 4 field を含む。handoff token/owner capability は含まない。
2. Claude handover の dry-run と apply は同じ builder を通り、dry-run の <code>startupPrompt</code> と apply で捕捉した
   tmux argv 末尾が完全一致し、双方が同じ 4 点セットを含む。
3. Codex source の manual dry-run fixture は deterministic な現行 6 行と byte-level で完全一致し、
   <code>claude-delivery</code> slot resolver、source generation、Claude bootstrap 命令を含まない。
4. reference §0.7.5 の manual <code>create_thread</code> fallback materialization fixture、および
   Codex takeover / generic manual / migration 前 legacy fixtureも同じ非注入を固定する。unknown/partial は
   Claude builder へ fallback せず、既存 authority gate で停止する。
5. resolver は exact succeeded Claude delivery handoff 1 件だけを返す。0件、複数、manual、takeover、legacy、
   reused provider ID、nonce/source/generation mismatch は mutation 0 で拒否する。
6. final と resolver の race は 15 秒/250 ms の fake clock で bounded。deadline 後に別 rowへ fallback しない。
7. first heartbeat を同期確認後、30/60/90 秒の heartbeat で 98 秒超も active。prompt 無視は 91 秒で stale。
8. old generation heartbeat/await は <code>SESSION_SUPERSEDED</code>。takeover 後の old prompt は gen16 manual を取得しない。
9. await return 後も独立 heartbeat が継続し、await を同じ exact pair で再 arm する。
10. 既存 Claude/Codex atomic final test と Codex successor Gate 3/4/startup prompt 成功 fixture を維持し、
   Claude bootstrap/model field を Codexへ要求しない。

### E の isolated live canary

- parent final 時刻、child resolver 成功時刻、first heartbeat 時刻を記録し、final→first heartbeat が 90 秒未満である。
- playbook 全文通読を続けても final から 98 秒超の時点で同じ session/generation が active、
  heartbeat gap が 30 秒 cadence 内である。
- provider session ID は launch UUID と exact 一致し、source は最後まで <code>claude-delivery</code>。
  takeover/manual への退化がない。
- heartbeat loop と await が独立し、request claim/await return 後も heartbeat が更新される。
- 親停止、prompt無視、resolver timeout の fault injection は既存 rollback または通常 stale に倒れ、
  generic kill、別 generation bind、grace が発生しない。
- canary の exact session/pane/PID/PGID を fenced cleanup し、shared identity/host configへ残骸を残さない。

## 8. 残る不確実性

1. comment #3436 の「通読中」という行動理由は board 証言までで、禁止 scope に従い transcript 全文では
   再検証していない。ただし 97 秒 gap と current prompt/stale predicate による構造的競合の確度は高い。
2. Claude 対話 session 内で開始した background heartbeat loop が初回 assistant turn の境界を越えて確実に残るかは、
   current main の unit test だけでは実機証明できない。C で process harness、E で 98 秒超 canary を必須にする。
3. parent final が assistant row 観測後 15 秒以内に succeeded readback へ到達することは current 正常経路から妥当だが、
   host 負荷を含む分布は未計測である。15 秒を暗黙延長せず、focused fake-clock と live latency を review してから
   timeout 定数を最終確定する。
4. t_726 は comment #3447 で <code>0b8009ba09874f1a07c6949260e8aebfb3201460</code> へ
   host-finalize 済みだが、まだ本書と contract へ統合されていない。
   Phase A で current main と両成果物を再読し、section番号・field名・migration版を 1 owner が確定する。
