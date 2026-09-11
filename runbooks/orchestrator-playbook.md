# オーケストレーター・プレイブック（正本）

hachi-kanban を「worker をとりまとめるオーケストレーター」として運用するための標準手順と判断規律。
CLI 構文は hachi-kanban スキル、分解設計は hachi-kanban-planner を参照。本書は**プロセスと判断**の正本。
（2026-07-06〜07 の実運用 20+ タスク・インシデント3件から抽出）


## この文書の使い方（分割・2026-08-22）

本書は **core**。全providerが下の「段階的な読み方」に従い、全文読取を起動条件にしない。手順書は
`runbooks/orchestrator-reference.md`（reference）にあり、**必要になった時だけ**引く。

### 段階的な読み方（2026-09-09）

- 初回は本書の作業別索引、§0「役割境界」、§0.5（§0.5.1を含む）、§0.7.1、§0.7.3の本文、
  §0.7.4、§2「品質規律」を読む。下記の節読取コマンドで索引を探し、必要な範囲を読む。
  §0.7.3.1以降の下位節は計測・hook設定を扱うときに読む。
  再開時は変更・欠落した範囲だけ取り直す。契約とreferenceは作業に関連する節を読む。
- identity登録・mutation・交代の前は§0.8と契約§55、引き継ぎ判断は§0.7.2と契約§77を読む。
  後継起動はreference §0.7.5の該当providerの経路を確認する。Claude専用HHN/tmux/TTLの実測を
  Codexの起動手順・利用枠計算へ転用しない。live session未登録時は既存担当のheartbeatを操作しない。
- Codexがオーケストレーターを務める場合は、起票・追加修正・PR範囲判断・待機への移行時に
  §0.2「Codex限定の再発防止」を適用する。Claudeへの追加規則としては扱わない。
- 監視の開始・再アーム前は§1.3と契約§50/§55を読む。終端処理前は§1.4の該当行、
  cancel前は「Durable cancel」の節と契約§57を読む。起票・ready・統合は下の索引のgateを守る。
- `task await`と`orchestrator await`の内部待機はモデルを呼ばない。無出力の端末を
  `write_stdin`/`functions.wait`で短周期に確認する外側ループを作らない。
  有限処理の回収では外側execとwaitのyieldを60000msに揃えるが、長寿命監視の代用にしない。
- 実作業が尽きたらworker・既存await・必要なheartbeatを保って待機する。再開理由は担当taskの
  終端、inboxの質問・stall・監視異常、ユーザー入力。無変化・タイムアウト・ゴール継続だけで
  待機確認を反復しない。ホストに休止/イベント再開機能がなければ制約とアプリ側停止の必要性を
  一度報告する。架空の購読機能、虚偽のgoal complete/blocked、定期起動への置換で回避しない。
- 一覧は本文を含まない通常テキストと既存filterを使う。JSONが必要ならモデルへ返す前に
  fieldを投影する。詳細は対象IDだけ取得する。監視・heartbeatの存続は無変化報告で証明しない。

この読み分けは規則の免除ではない。該当操作の前に正本の必要な節を読む。

リポジトリ外からは下のscriptを絶対パスで呼ぶ。引数なしの文書取得は見出しだけ、節取得は
直接の本文だけを返す。子節が必要なら`--children`、180行を超える節は範囲を絞るか
`--max-lines`を明示する。コードブロック内の`#`は索引に混ぜない。

```bash
python3 scripts/read-operations.py core
python3 scripts/read-operations.py core 0.5 --children
python3 scripts/read-operations.py reference 0.6 --children --max-lines 220
python3 scripts/read-operations.py contract --query '50.1'
python3 scripts/read-operations.py contract 55
python3 scripts/read-operations.py knowledge --limit 20
python3 scripts/read-operations.py knowledge --query '対象機能名' --limit 10
hachi knowledge show <選んだID>
```

knowledgeは最初に最新更新順の索引20件を読み、設計前は対象語でも検索する。`matched`が
`shown`を超える場合、必要な期間・対象を覆うまでqueryやlimitを調整する。関連項目の本文に
`correction` / `supersede` があれば置換先まで確認し、正本とlive設定を優先する。
既存`knowledge list`は重要度順であり「最新20件」ではない。`--json`は本文も含むため、
上の補助はCLI出力をローカルで並べ替え・検索・投影し、モデルへ本文を返さない。

記録は、現行規則をcore/reference/contractの一箇所、変更周知をknowledgeの短い要約と
正本への参照、過去の経緯をarchiveに置く。規則追加時は同じ主題の旧記述を置換する。
knowledgeを一括削除しない。訂正先を追うために必要なIDを残し、古い詳細を通常の読取経路から外す。


**§ 番号の読み分け（名前空間は3つある）:**

- 接頭辞の無い `§N` = **`docs/contract.md`**（§21 以上の2桁が多い）
- `core §N` = 本書 / `reference §N` = `orchestrator-reference.md`

reference 側も元の番号のまま持ち越している（両 runbook で § 番号は一意）。
コード・スクリプト・knowledge が § 番号で名指ししているため、**番号は振り直さない**。

**行は「作業」ではなく「規律が拘束する瞬間」で引いてある。** 節に到達できても、
踏んだ後に到達したのでは意味がない（下の ready / クローズの2行はその実例）。

| この瞬間に | 読む |
|---|---|
| 起票する（body を書く） | reference §0.6 モデルrouting決定表 / §1.1 起票（§1.1.3 検証の受渡し表を含む）/ §1.2 worktree |
| **ready にする** | **3つとも必須。** ①**core §0.5.1「ready の絶対条件」** — 完了条件に「やめる条件」が無い body、成果物が2つ以上の body を ready にしない（2026-08-26 実害: 2時間・tool 328回で max-runtime 強制 cancel） ②**reference §1.5「depends-on の解放条件」** — 前提を host-finalize してから ready にする。done は統合済みを意味しない（2026-08-20 実害） ③**reference §1.1.1** ready 直前チェックリスト |
| **盤外で終わった作業を閉じる / タスクを不要化する** | **reference §3「盤外完了タスクのクローズ」** — ready を経由せず todo/triage → archived。ready にすると worker が誤起動する（2026-07-07 実害） |
| 走行中の run を止める | core §1.3「Durable cancel」— `cooperative_sent` は停止の証拠ではない |
| CLIのcommand/optionが不明・失敗した | reference §1.1.4 構文の確認と訂正結果の再利用 |
| worker fail / rework を判断する | reference §0.6.2 fail 分類と replacement の規則 |
| runtime resource / lease / Docker を掃除する | reference §1.2.1 / §1.2.2 — 削除は host のみ。claim token を stdout・argv・board へ平文で出さない |
| host-finalize する | reference §1.5 統合チェックリスト / §4 並行共存 |
| PR を作る / UI 証跡を添付する | reference §1.5 publication gate — 実データはマスキングせず合成 fixture へ置換して撮り直す |
| `docs/contract.md` に § を追記する | reference §4 契約採番 — 追記前に空き番号を grep。衝突したら後着が改番 |
| 後継セッションを起動する | reference §0.7.5 後継起動（provider 別） |
| 引き継ぐ / 世代交代する | **まず `handover --json` の dry-run で `blocked` を見る（副作用ゼロ）。** core §0.8.1 ミッション task の作り方 → core §0.7.2.1 の provider gate → reference §0.7.5。Codex から HHN / `handover --apply` を使わない |
| レビューを回す | reference §2.2 レビュー運用 |
| ブラウザに触る | reference §2.25 ブラウザ操作のコスト規律 |
| bridge / ポートを疑う | reference §6 ポート台帳・bridge 制約 |
| 他リポジトリから使う | reference §7 他リポジトリからの利用 |
| **監視を張る / 張り直す** | **core §1.3.1「検知と伝達は別物である」** — nohup の watcher はログに書くだけで自分を起こさない。Monitor で伝達路を張る（2026-08-28 実害: 終端を1秒で検知しながら1時間放置） |
| 壊れた | reference §3 インシデント runbook |
| ユーザーへエスカレートする | reference §8 連絡経路 |
| 記録をどこへ置くか迷った | reference §1.6 記録の家 |

## 0. 役割境界

| 誰が | 何を |
|---|---|
| orchestrator | 起票・spec・**凍結契約（types.ts / docs/contract.md）の編集**・host-finalize（commit/merge）・デプロイ（kickstart）・kanban 操作・スキル/runbook 整備・インシデント対応 |
| worker | worktree 内の実装のみ（契約変更禁止・commit しない） |
| reviewer | read-only 二審（verdict 提案） |
| 人間 | user-decision の解消・出荷/権限ポリシーの決定・push 承認 |

### 0.1 報告を引き継ぎ、担当作業を重複しない（2026-09-09 ユーザー裁定）

- オーケストレーターはタスク分解・依存管理・報告に基づく採択・判断の振り分け・統合操作を担う。
  実装の詳細調査、diff精査、テスト設計・実行、実ブラウザ検証はworker/reviewerへ割り当てる。
- 受入判断にはworkerのhandoffと独立reviewのverdict・指摘・検証結果を引き継ぐ。
  対象BASE/HEAD、所有ファイル、必須gateの結果・件数、未検証事項、証跡の所在を短く照合する。
  `done`の表示だけを合格根拠にせず、同時に、報告済みの内容を親が再検証することも既定にしない。
- 親が安心するためのraw `git diff`全文読解、詳細ソースの再調査、transcript全文の読み直し、
  同じ候補で成功済みのテスト再実行を禁止する。報告不足・矛盾・失敗は、確認したい点を具体化して
  担当worker/reviewerへ返す。追加の詳細判断も調査報告を依頼し、親はその結果から方針を決める。
- host-finalizeで親が直接確認するのはbranch/SHA、変更ファイル一覧、所有範囲、作業状態、
  必須hook・統合コマンドの終了codeなど、操作に必要な最小情報に限る。競合解消や未実施gateは
  担当へ割り当てる。hostでしか実行できない必須gate/hookは実行できるが、詳細な失敗調査は担当へ戻す。
- 例外はユーザーが親による直接確認を明示指定した場合、または担当環境では再現できないhost固有問題。
  例外を使う前に理由と最小確認範囲をtaskコメントへ記録し、未検証事項をpassへ読み替えない。
  「設計責任」「品質担保」「念のため」だけを例外理由にしない。
- 起票時のverify表に実装・独立review・全体検証の担当を記入し、受入時は既存報告を参照する。
  本節は後段の「確認」「検証」「worktreeの実体を確認」の**担当分担にも適用**する。

### 0.2 Codex限定の再発防止 — PRへ収束させる（2026-09-09 ユーザー裁定）

適用対象は**Codexが親オーケストレーターを務める運用のみ**。tenant-a 通知接続の実運用で観測した
弱点への対策であり、Claudeにも同じ弱点がある、またはモデル一般の能力差が実証されたという意味ではない。
既存の安全・検証・publication gateを緩めず、一般規則の正本は§0.1、冒頭の待機規則、reference §1.1/§1.5とする。

観測した再発パターン: 無出力確認と待機だけのゴール継続、本文を含む大量出力、共有状態追加の
利用側への伝達漏れ、setup不足と型不整合を重いhookで順番に発見、追記で矛盾した再投入body、
review完了と統合完了の混同。報告採択が改善しても、新規発見を次々に同じPRへ足すと提出が遠のく。

- **起票前にPRの境界を固定する。** ユーザーが得る動作、今回含める範囲、含めない範囲、
  残る必須gate、全体検証へ進む条件をmission/taskへ短く記録する。内部タスクの消化数を出荷進捗の代用にしない。
- **追加作業の前に収録要否を判断する。** 発見を「今回の成立に必須の不具合」「必須検証の不足」
  「後続へ分離できる改善」に分け、今回必要な理由または後続先を残す。自動的に今回のscopeを広げない。
  誤既読化・旧tokenの再利用など成立に必須の安全条件を、早く出すために後続へ逃がしてはならない。
  共通機構の採用で通常画面全体へ影響が広がるなら、利用側を増やす前に依存とPR分割の可否を判断する。
- **共有契約変更は接点まで引き渡す。** workerに直接の利用側、状態分岐、fixture、並行成果との
  接点を報告させ、整合確認の担当を決める。親が再調査するのではなく、統合で新たに生じた接点の
  focused検証を担当へ割り当ててから必須hookへ進む。成功済みの無変更suiteは再実行しない。
- **再投入bodyを現在形へ整理する。** BASE/必要commit、所有、禁止事項、今回の検証を一意にする。
  installと正規setupの結果を分けて渡し、古い禁止と新しい許可を末尾追記だけで共存させない。
  実アプリとfixtureの配置差を切り分け、fixture不足を本番workaroundや期待値の弱化で埋めない。
- **後続の再開は統合証拠で決める。** review/doneだけで解放せず、必要commitのhost統合を確認する
  （reference §1.5）。統合待ちの担当へ同じ保留回答を繰り返して再起動しない。完了済みtaskの
  追加修正は許可された状態遷移を確認し、必要なら後続taskへ分ける。推測したCLI遷移で戻さない。
- **PR作成とマージ可否を区別する。** 権限とpublication gateの範囲で、ドラフト作成条件と
  マージ条件を別に記録する。未検証は明記し、全backlogの完了を自動的に1本のPR作成条件へしない。
- **待機は判断の終端にする。** 実作業が尽きたら冒頭のイベント待機規則に従う。
  「待機しています」だけの新ターンを繰り返すことは改善ではない。ホストの休止機能がない場合は
  制約とアプリ側停止の必要性を一度報告し、架空のイベント再開、虚偽の完了、別の確認ループで代用しない。

判断の区切りには「今回のPR残件／新規発見を含める理由または後続先／次のgateと担当」を
1〜3行でboardへ残す。変化がない間は同じ記録や進捗報告を追加しない。

## 0.5 設計権限の階層（2026-07-07 ユーザー方針）

**設計方針・アーキテクチャ判断・要点の確定は、起票より前にオーケストレーターセッションが行う。**
とりわけオーケストレーターが最上位モデル（Fable 等）で動いている場合、難しい設計・方針決定を
下位のプロセス（plan タスク・worker）へ**先送りしない**。

| 層 | 担う判断 |
|---|---|
| **オーケストレーター（Fable 等・本セッション）** | 設計方針・方式選定・トレードオフ決定・契約化（contract §）・分解と依存設計・出荷/権限ポリシー案（最終決定は人間） |
| plan profile（Opus） | **タスク内の詳細実装プラン**のみ（方式が確定した後の手順展開）。方向性の決定には使わない |
| worker（implement/docs） | 確定済み spec の実装。設計判断の余地を残さない body を渡す |
| reviewer | 実装が spec/契約に合っているかの検証 |

運用規則:
- **「方式を検討して実装せよ」という body を書かない。** 方式はオーケストレーターが決め、
  契約（§）に固定してから起票する（曖昧さは worker の縮退・レビュー往復の温床）
- 例外は**調査タスク**: 「調査 → 方式比較 → 推奨案を handoff」までを worker に任せてよいが、
  **採択の決定はオーケストレーター**（+必要ならユーザー）が行い、フェーズ2を別起票する
- ユーザーとの間で決めるべき判断点（出荷条件・権限境界・コスト）は起票前に AskUser で確定し、
  決定内容を契約と body に「ユーザー決定（日付）」として記録する
- 設計の質が結果を支配する。オーケストレーターは自分の推論予算を惜しまず、
  contract 先行コミットの段階で設計を完成させる（実装中の設計変更は最も高くつく）
- **設計粒度とモデルの釣り合い**: model routing は作業量ではなく、残っている判断量と影響範囲で決める。
  現在の model/effort/speed/transport は live config と `hachi admin resolve <task-id> --role all --json`
  を正本とし、本書の例から推測しない。判定に使う複雑度シグナル・閾値・reviewer 指定・fail 分類と
  replacement の規則は **reference §0.6 の決定表を唯一の正本**とする。
  - **2026-09-09 ユーザー裁定: 初回のworker選定は Luna/max と Astra/low の2段階。**
    まず Luna/max で扱える `1 primary concern / bounded file ownership / focused tests` へ分解し、
    仕様・UI・schema・所有権・routing・transaction方針を凍結する。分解後も複雑さが残る部分だけ
    `gpt-6-astra/low/standard` を使う。Sol/high・Sol/xhighは通常routingから外す。
  - 未確定の方式選定はオーケストレーター、またはread-only調査で解消し、実装前に採択・凍結する。
    モデルの引上げで分解や設計を省略しない。対象ファイル、使用API、状態遷移、テスト戦略、禁止事項まで
    書き切ってreadyにする。重大シグナルがあっても初回をAstra/mediumにしない。
  - **Astra/mediumは例外**。高複雑度で、さらに分解できない理由を記録し、同じ課題を
    Astra/lowで実装した少なくとも1回の試行がworker品質の理由で失敗した場合に限り許可する。
    3条件をすべて満たす必要があり、初回指定、Luna/Solの失敗だけによる昇格、環境障害や仕様不足を
    失敗実績に数えることは禁止する。詳細な証拠と再試行のgateはreference §0.6に従う。
  - 複数phaseを含む仕事はready前に、`設計/判断`、`局所実装 + focused tests`、
    `全体検証 + Storybook/browser evidence`、`publication`へ分け、depends-onで順序を固定する。
    設計/判断はorchestratorが所有し、read-only調査を委ねる場合もAstra/lowの提案を採択してspecを凍結してから
    implementationを開始する。Luna系implementationは非fast経路とし、実際のeffort/speedはlive configを
    推測せずready前の`admin resolve`で確認する。
    `resolution.transport`は設定値、`compatibility.expectation.transport`はprobe対象であり、実起動証拠ではない。
    実行中のsteer/停止判断は対象runのmeta/launched eventを確認する。
  - 実装差分に比べて検証面が大きい場合は、worker所有の`実装 + focused tests`と、依存する
    `統合/full verification + Storybook/browser evidence`を別タスクにする。後者が通過してもworkerへ
    commit/push/PR/mergeを委ねず、権限確認後のhost-finalize/publication gateをorchestrator/human所有で分ける。
    rebase、仕様調停、実装、全repo検証、React Doctor、Storybook証跡、commit/push/PRを一枚へ束ねない。
  - 検証を分割した実装taskでは、ready前にbodyへ独立行`verify: <実行可能なfocused test + 型検査コマンド>`を
    明記する（契約§39.1）。文章で「full suiteはhost」と書くだけではtenant既定verifyが実行される。
    `verify: focused`等のモード名や、実装taskの`verify: none`で代用しない。全体検証は統合済み差分に対してhostで行い、
    通過後は差分変更・新しい失敗・未解消の懸念がない限り同じ検証を反復しない。
    runtime probe timeout等でreview起動だけが失敗した場合は、互換性と実HEAD/差分を再照合しreviewから再開する。
    変更不要な実装を再起動して回復させない。
  - 1 worker ≒ 30 turnsを超える見込み、複数package/複数画面、または検証ツールが複数段にまたがる場合は、
    ready 前にphase分割する。長時間という事実だけでstall/model不適合とせず、process・output mtime・
    worktree更新を照合する。
  - 実装は独立したAstra/low reviewerで二審する。worker起因のreworkが反復したら、同じbodyを
    再投入せず、設計曖昧ならspec補強、範囲過大なら分割する。モデル再選定はreference §0.6に従い、
    失敗回数だけでAstra/mediumへ昇格しない。
  - per-task指定は起票時 `task create --model <m> --effort <e> --speed <standard|fast>`、または
    `admin set-execution --role worker ...` を使い、ready前に`admin resolve`で実配信値を確認する。

- 走行中 run への介入は **`hachi task steer <id> <指示>`**（契約 §52.1）で行う。bridge は注入、
  direct は `--restart` で stop → body 先頭へ prepend → re-ready。中断させたい場合は
  中断指示（outcome=failed の handoff 要求）→ terminal 化後に body 差し替え → re-ready とする

  > **⚠ ここでいう steer は `hachi task steer` である。`hachi msg send --intent steer` を直接使わない**
  > （2026-09-04 実測・`k_fe6846d31e8e`）。`task steer` は契約 §52.1 のとおり **transport で分岐する**:
  > bridge は注入、**direct は注入不可（§17.2）なので `--restart`** — run を stop し、body 先頭へ
  > 指示を prepend して ready へ再投入する（**進行は失われる**ので、それを承知で使う）。
  > plumbing の `msg send` には**この分岐が無い**ため、direct でも受理され、配送段で
  > `serverUrl="direct"` を URL 解釈して落ち、`steer_delivery_uncertain` / `Invalid URL` になる。
  > **`uncertain` は「配送されたか不明」の意味なので、恒久的に不可能な配送が一過性の失敗に見える。**
  > per-task の model/effort/speed override は設定解決時にdirectとなるが、dispatch前にbridge候補へ
  > 再選択され得る（契約§49.4）。実際の分岐は対象run meta/launched eventで確認する。
  > **この board では direct 側の分岐に当たる方が多い。**（受理段で拒否させる修正は
  > `t_b3460fd052276aa9`。契約 §52.1 の accept-time 不変条件として規定済み）
  >
  > **worktree の中身は launch 時点で凍る。** 起票後に契約・正本を直しても走行中の worker には
  > 届かないので、直したら「その worktree に何が見えているか」を確認する。

### 0.5.1 ready の絶対条件 — 「やめる条件」と「1 成果物」（2026-08-26 ユーザー指示）

**この 2 つは推奨ではなく絶対条件である。どちらか一方でも欠けた body を ready にしてはならない。**

2026-08-26、tenant-a の UI モックタスク `t_5f01d550d71ccf1b` で両方を欠いた body を ready にし、
**2 時間・tool 呼び出し 328 回**（「1 worker ≒ 30 turns」目安の 11 倍）走った末に
bridge の max-runtime（7200s）で強制 cancel された。exact-session stop 非対応 bridge だったため
停止を確認できず、判断が orchestrator inbox へ上がった。原因は worker ではなく**起票側**である。

#### 絶対条件 1: 完了条件は「揃えるもの」ではなく「やめる条件」を書く

上記 body の完了条件は必要な evidence を列挙していたが、**どうなったら終わりか**を書いていなかった。
worker は確定デザインのアーティファクト（65KB の HTML）と自分の実装を突き合わせ、
差分を潰し続ける自己レビューループに入った。**このループには終端が無い。**

- **evidence の一覧は「終わり」ではない。** それが揃った後に何をして終わるかまで書く
- **「正本と実装を突き合わせる」種類の指示は発散する。** 突き合わせを求めるなら、
  「差分は直さず handoff に列挙する」のように**扱いか回数を固定する**。
  「v9 と一致させる」は完了条件ではなく、際限のない作業指示である
- **モック phase は特に危険**。ユーザーが実物を見る前の作り込みは捨てる確率が高い
  （対象 repo 側にモック運用の規約があればそれに従う。tenant-a では `AGENTS.md` の
  「mock 実装では preview / evidence を出してユーザー確認を待つ」と
  `docs/runbooks/codex-parallel-kanban.md` の `Mock Preview Ready` が該当する）
- 完了条件の末尾に **「上の 1〜N だけで終える。それ以外の実装・修正・リファクタ・テスト追加をしない」**
  に相当する一文を必ず置く

#### 絶対条件 2: 成果物が 2 つ以上なら ready にせず分割する

上記 body は「ダイアログ本体（初期状態 2 種）+ 別画面の入口 + Storybook story + 実ブラウザ evidence」を
1 枚に束ねていた。**分割不足は起票時点で見えていた**が、検査する瞬間が定義されていなかったので素通りした。

**ready の直前に数える。** 次のどれかに当たったら分割する:

- 独立して受入判断できる成果物（機能 / コンポーネント / 画面）が **2 つ以上**。
  同一primary concernの実装と、その不変条件を証明する同居focused testは1成果物として数える。
  ファイル数だけで分割せず、別画面・検証基盤の構築・evidence取得は下の別phase規則に従う
- **「実装」と「検証手段の構築」**（Storybook・fixture・seed）が同居している
- **「実装」と「evidence 取得」**（ブラウザ実測・スクリーンショット）が同居している

**分割の判断を「turn 数の見込み」に頼らない。** 見込みは外れる（本件は 30 turns 想定が 328 になった）。
**数えられるもの（成果物・phase）で切る。**「1 worker ≒ 30 turns 目安」は事後の診断値であって、
事前のゲートとしては機能しない。

#### 前提: worker には実行時上限があり、超えると強制 cancel される

bridge の既定は 7200s で、`cancel-status` の reason に
`max-runtime exceeded (7207s > 7200s)` として現れる。**7200 は固定値ではない** —
`resourceGuard.maxRunSeconds` は設定可能で、direct runtime は provider 固有の上限を持つ。
**ready 前に解決済み transport と live config で実効上限を確認する**（reference §1.1.1）。
いずれにせよこれは**分割不足の最終防波堤であって、そこまで走らせてよい予算ではない**。
超過すると cooperative cancel が飛び、exact-session stop 非対応 bridge では停止を確認できないため、
`worker_question`（`cancel-failure:*`）として orchestrator inbox へ上がる。
**body の作業量はこの実効上限から逆算して書く。**

## 0.7 セッションの長さとトークン効率

起動時の読み込みと、無変化の往復を減らす。判断はboardへ記録し、必要な節だけを読む。
現在のモデル・利用枠・単価を過去の実測から推定しない。セッションの交代判断は§0.7.2を参照。
ブラウザ取得はreference §2.25、起動時の読取範囲は本書冒頭を参照する。

### 0.7.0 何を読むかを絞る

一覧 → 該当する節・ID → 必要な場合だけ履歴、の順に取得する。全文読取を既定にしない。
過去の12.5倍ルール・文字数換算・費用表は[履歴資料](archive/orchestrator-cost-observations-2026-08.md)へ移した。

### 0.7.0.1 過去の起動費用観測

cache prefix再作成と費用訂正の経緯は[履歴資料](archive/orchestrator-cost-observations-2026-08.md)に保存する。
通常の起動では読まない。現在の起動費用を診断する場合だけ、現行の計測値と照合する。

### 0.7.1 board が引き継ぎ資料である

**別途ハンドオーバー文書を書かない。** オーケストレーターの状態は既に board にある。

| 引き継ぐ内容 | 置き場所 |
|---|---|
| タスクの状態・優先度・依存 | `task list` / `task deps` |
| 何をなぜ判断したか | task コメント |
| 何が起きたか | task events |
| 仕様・運用の変更 | knowledge（`--tag spec-change`） |
| 担当 | binding / watch |
| 未応答の質問 | `orchestrator inbox` |

したがって**判断と操作の結果は、その場で board のコメントへ書く**。
「後でまとめて引き継ぐ」ためではなく、**会話をいつ捨ててもよくするため**に書く。
長文の handover は出力トークンを消費するうえ、board と二重管理になる。

### 0.7.2 切りどきは固定値ではなく「残作業量の関数」

`hachi orchestrator usage --check` の `recommendation.action` に従って判断する。`R` と `N` の比較は
CLI が行うため、旧式の閾値や手作業の見積もりを決定根拠にしない。`R` は契約 §77.5 の定義どおり、
identity に scoped された ready / in-progress / review タスク数 × `turnsPerTask` ＋ 未処理 inbox request 数 × 2
（`kind=session_budget` 自身は除く）である。
`handoff-at-boundary` は次の区切りで、`handoff-now` は直ちに引き継ぎ、`continue` は継続する。
`effortAdvisory` は情報のみであり、引き継ぎ判断や effort の自動変更には使わない。

**推奨 (c) `recommendation.idle`（契約 §77.10）は別枠で読む。** (a) は「働き続ける場合」の判断だが、(c) は
「これから TTL（既定 1h）を超える待ちに入る場合」の判断で、`rewriteUsd`（失効後の 1 turn で文脈全体を書き直す額）と
`savingsUsd`（引き継げば S で済む差額）を出す。`handoff-before-idle` が出ていて、ユーザー判断・手動 push・長い run の
終端などで TTL 超の待ちに入るなら、**待ちに入る前に別ペインから `HHN`** で引き継ぐ（§0.7.2.1 の「寝る前に切る」の
定量版）。supervisor の stage も idle が TTL の半分を超えた時点で `kind=session_budget` の request で知らせる。

**参考値（旧定数）**: 以下の閾値表は旧実装の定数に基づく記録であり、現行の引き継ぎ判断には使わない。

| 現在の文脈 C | 損益分岐 N | | 段階 | 閾値 | 意味 |
|---:|---:|---|---|---:|---|
| 150K | 80 ターン | | notice | **231,231** | あと30ターン働くなら切る価値がある |
| 200K | 39 ターン | | recommend | **296,231** | あと20ターン働くなら切る価値がある |
| 300K | 20 ターン | | urgent | **491,231** | あと10ターンでも切る価値がある |
| 500K | 10 ターン | | | | |

- **C₀ と S を閾値コードへ焼き込まない。** 現行は契約 §77.5 のとおり `session_boot_samples` から導出する
  （境界規則は「main-chain 15 ターン目の `contextTokens`」に固定。`hachi orchestrator usage-profile refresh` が
  標本を更新する）。旧版の「世代ごとに測り直す」「境界規則を決めてから測る」は、この固定で解消した
- **閾値は鳴っていても決定トリガーになっていなかった（実測）。** 引き継ぎ実績6件はすべて「切って正解」
  （実利益 +$24〜96）だったが、損益分岐が 6〜18ターンなのに実際は 172〜328ターン働いてから切っていた。
  **`recommendation.action` はこの「鳴っているのに切らない」を潰すために R と N を CLI 側で比較する。**
  `notice` / `recommend` の段階だけを見て切らないこと、逆に `continue` が出ているのに段階の色だけで切らないこと
- 旧版の「目安30〜80ターン」は文脈サイズを見ておらず使えない。**ターン数ではなく文脈サイズで判断する**
- **`turns` 軸は総合判定に入らない（2026-08-23 ユーザー承認。実装 `8963f63` で統合済み）。**
  総合段階は集約対象3軸（`contextSaturation` / `handoffValue` / `effectiveCostUsd`）の**最悪値**で決まり、
  `turns` は値と閾値を表示するだけの informational 軸である（1往復あたりの伸びを読む診断値としては有用）。
  固定の往復回数は作業の性質で桁が変わる文脈増加に合わず、「**常に赤なので誰も見なくなる**」形になる。
  **この変更を提案するのは、いま自分に「引き継げ」と言っている軸を自分で外す行為**である。
  利害が絡む変更なので、閾値の緩和は必ずユーザー承認を取る
- **飽和度（窓に対する比率）とコストは別物である。** `claude-opus-5[1m]` では 30万トークンでも
  窓の 30% にすぎず品質上は余裕だが、経済的にはとうに切りどきを過ぎている。
  200K モデル向けの旧閾値 120K/180K/220K は 1M モデルでは実測85%のターンが urgent を超え、
  **常に赤なので誰も見なくなる**

切る場所は、複数タスクが並列で進むため task 単位では決まらない。**自分の判断が一区切りした時**に切る。

- 統合して push し終えた時
- ユーザー判断を仰いで回答を board へ反映し終えた時
- 監視を張り直して待機状態に入った時

### 0.7.2.1 引き継ぎは「旧セッションにプロンプトを打たずに」行う

**アイドルが TTL を超えるとキャッシュは死ぬ。その状態で旧セッションへ1ターンでも打つと、
文脈全体が write 単価で書き直される。** 引き継ぎ指示も1ターンなので、
**「朝いちばんに引き継いで、と打つ」は最も高い引き継ぎ方**になる。

| 文脈50万で就寝・朝に残り30ターン | 初期費用 | 以降/ターン | 30ターン総額 |
|---|---:|---:|---:|
| 朝そのまま続行 | $5.00 | $0.25 | $12.50 |
| 朝に「引き継いで」と打つ | $7.95 | $0.05 | $9.47 |
| **アイドル中に外部から引き継ぐ** | **$2.96** | $0.05 | **$4.48** |

`hachi orchestrator handover` は **CLI であって旧セッションへのプロンプトではない**。
別ペインから叩けば旧 Claude セッションは1ターンも動かず、書き直しが発生しない。
必要な ID の解決は CLI に委譲し、repo 管理下の薄いシム
`scripts/hachi-handover-now` を使う。シム自身は `orchestrator list` や watch の走査を行わず、
`hachi orchestrator handover --json` の `resolution` と `provider-launchable` preflight だけを読む。

**この HHN / `handover --apply` は Claude の tmux 起動経路だけである。Codex セッションからは使わず、
reference §0.7.5 の Codex Desktop 経路（`handoff-prepare` → `create_thread` → `handoff-accept`）を使う。**
CLI は旧 session の provider が `claude` でない、または不明なら `provider-launchable` preflight で
dry-run から fail-closed に止める。

```bash
# Claude/tmux 経路だけ。--apply が既定で、接続コマンドまで表示する
hachi-handover-now
hachi-handover-now --apply      # 明示しても同じ
hachi-handover-now -n           # dry-run

HHN                             # = hachi-handover-now（--apply が既定）
HHN -n                          # = hachi-handover-now -n（dry-run）
```

`hachi-handover-now` / `hhn` / `hachi-orch-enable` / `cc-cache-ttl` / `hachi-watch-stop`
（§0.7.3.2/§0.8 で使う）は host が `~/.local/bin` に置く薄い `exec` シムで、実体はそれぞれ checkout 内の
`scripts/hachi-handover-now`・`scripts/orchestrator/hachi-orch-enable`・
`scripts/orchestrator/cc-cache-ttl`・`scripts/orchestrator/hachi-watch-stop` とする。
worker は `~/.local/bin` を変更しない。**導入/修復は `scripts/setup-local.mjs` の1経路に
統一されている**（手組みの `mkdir`/`printf` は使わない — install 経路が2つあること自体が
過去の失敗モードだった。t_eac0371a7a1a368e）。host で次を実行する
（`HHN_REPO` は実際の checkout へ置き換える。冪等なので事故時の再実行も安全）。

```bash
HHN_REPO=/absolute/path/to/hachi-kanban
node "$HHN_REPO/scripts/setup-local.mjs" --apply --skip-install
```

導入状態は `hachi doctor` の `orchestrator helpers` 検査で確認できる
（5本の存在と、解決先が checkout 内であることを見る。`hachi-watch-stop` は 2026-09-02 に追加）。

`--mission` / `--orchestrator` はそのまま handover CLI へ素通しする。

候補が返った場合の挙動は次のとおり。

- `resolution.status=resolved`: そのまま handover を実行する。`--apply` 成功後は、tmux の外なら
  `tmux attach -t <name>`、中なら `tmux switch-client -t <name>` を表示する。
- `ambiguous`: stdout が TTY でない場合、各 `candidates[].command` を全文そのまま1行ずつ出力して
  非0終了する。TTY では番号付きで選択でき、選んだ候補の argv で1回だけ実行する。
  EOF・Ctrl-C・不正入力・30秒のタイムアウト、または `--no-input` 指定時は何も実行せず、
  非対話時と同じ候補 command を出して非0終了する。
- `none`: `candidates[].command`（通常は `takeover` コマンド）を全文そのまま出して非0終了する。
  対話選択は行わない。

- **Claude 経路では `--apply` が既定**。夜間・離席中に「打つだけで引き継がれる」ことを優先した設計であり、
  安全側に倒したい時だけ `-n` を付ける。Codex 経路は HHN 自体を使わない
- 旧 Claude セッション自身の中から叩くと**警告する**（`CLAUDE_CODE_SESSION_ID` が board の
  `providerSessionId` と一致するかで判定する。素の端末では環境変数が無いので board へ
  問い合わせず、コストはゼロ）。止めはしない — その時点で既に支払いは発生しており、
  ここで中断しても戻らないため。警告の目的は次回から別ペインを使わせること
- 前提: preflight の「旧 session が active」を満たすため、**heartbeat ループが生きていること**
  （§0.8 の立ち上げ4点セット）
- **就寝時の文脈サイズが翌朝の書き直し額をそのまま決める**（50万→$5.00 / 10万→$1.01）。
  だから「寝る前に切る」が効く
- 詳細と訂正の経緯は knowledge `k_d39726261023`

### 0.7.2.2 確認待ちに入る瞬間が、board を引き継ぎ可能にするチェックポイント

§0.7.2.1 の安い引き継ぎは、**board がその時点で引き継ぎ可能であることに依存する**。
外部から世代交代すると、旧セッションは「次の一手」を書く機会を持たない。

失敗モードは一般論ではなく具体的に1つ。**夜間に長いタスクを走らせ、やり切って
ユーザー確認待ちで止まり、その間にキャッシュが死ぬ**。この形が最も起きる。

したがって **`user-decision` / `user-question` で止まる時、および「これ以上進められない」と
判断した時は、その場で board を引き継ぎ可能な状態にしてから待機に入る**。
これはハードゲートにしない（重すぎる）。規律として守る。書くのは次の3つだけ:

1. **どこまでやったか** — 完了した判断・統合・push を1〜3行
2. **次の一手** — 自分が次に何をするつもりだったか（board に無い唯一の情報。§0.7.3）
3. **いま何を待っているか** — ユーザー判断なら問いの要点、run 終端待ちなら task ID

**長時間・夜間の依頼を受けた時点で、「終わったら確認待ちに入る前に board を更新する」ことを
自分のタスクへ含める。** 後から思い出すのではなく、依頼を受けた時に組み込む。

### 0.7.3 セッションを切る前に「次の一手」を残す

board に無い唯一の情報は「**自分が次に何をするつもりだったか**」である。
切る前に、担当 identity 宛のメモとして1〜3行だけ残す。長文にしない。

```bash
hachi task comment <代表task> --body "次の一手: <1〜3行>" \
  --actor-kind orchestrator --orchestrator <id> --session <id> --generation <n>
```

### 0.7.3.1 自己計測を有効にする（登録し忘れると黙って ok になる）

`hachi orchestrator usage` は **session に provider session id が登録されていないと測れない**。
未登録だと `stage: null` / `reason: provider-session-id-unregistered` を返し、`--check` は
**exit 0**（fail-open。計測できないことでオーケストレーターを止めない設計）になる。
2026-08-21 にこれを踏み、登録しないまま長時間セッションを回した。

**session を作るときは必ず provider session id を渡す。**

```bash
# Claude Code の session id は transcript のパス（~/.claude/projects/<proj>/<uuid>.jsonl）から取れる
hachi orchestrator session start <orchestrator-id> \
  --provider claude --provider-session-id <uuid> --json
```

- live session がある状態で `session start` を呼ぶとエラーになる。先に
  `orchestrator list --json` の `liveSession` を見て、必要なら `session close <id> --generation <n>` する
- 登録済みかは `hachi orchestrator usage --session <id> --json` の `reason` で分かる。
  `null` 以外が出ていたら測れていない
- `--check` は判定不能でも理由を stderr に出す（2026-08-21〜）。**stdout が無出力 + exit 0 が
  「ok」を意味する。判定不能の理由は stdout ではなく stderr に出る**
- **stderr に理由が出ていても ok のことがある（2026-08-22〜。旧版の「理由が出ていたら ok ではない」は
  この時点で偽になった）。** 個々の軸が測れないことと、総合判定が ok であることは別である。
  軸単位の欠測は「総合判定にこの軸は入っていません」と明示して stderr へ1行出る。
  読み分けは**行の形**で行う: 軸の欠測行は `[hachi] 軸 <名前> を判定できません:` で始まる
- **`contextSaturation` を claude で有効にするには窓サイズを config へ入れる**（claude は
  観測手段が無い。codex は `model_context_window` を観測でき、観測値が config より優先される）:

  ```jsonc
  // ~/.hachi-kanban/config.json
  "orchestrator": { "sessionBudget": { "contextWindowTokens": 1000000 } }  // 正の整数のみ
  ```

  **この値は config 全体で1つであり、モデルごとではない。** `claude-opus-5[1m]` なら
  1000000 が正しいが、同じ config で 200K のモデルを使うセッションは飽和度を実際の 1/5 に
  読む。**黙って過小に出るのは、いま塞いだ「黙って欠測する」より悪い**ので、
  常用モデルを変えたらこの値も変える

### 0.7.3.2 消費段階をフックで自動検知する（2026-08-21〜）

`~/.claude/hooks/hachi-orchestrator-usage-check.sh` を `UserPromptSubmit` へ登録済み
（`~/.claude/settings.json`、timeout 30 秒）。ユーザー入力ごとに自セッションの段階を判定し、
閾値を超えていれば `additionalContext` で知らせる。
フックの出力には `[provider/model/effort]` と `recommendation`（R と N の比較に基づく action）が付く。

#### セッション開始時にやること（6つ。1つでも忘れると監視が黙って止まる）

**正本は core §0.8 の6項目リスト**（step 0「旧世代の watcher を止める」を含む）。
ここはその実行例であって、増減があれば §0.8 に従う。

```bash
# 前提) 自分の Claude Code session id を知る（transcript のパスから取れる。番号付きの手順ではない）
#    ~/.claude/projects/<proj>/<uuid>.jsonl の <uuid> がそれ

# 0) 旧世代の watcher を止める（自分の watcher を張る前に。手順と確認方法は §0.8 step 0 が正本）
#    wrapper → 子孫の順で止め、引数全文で孤児が残っていないことを確認する

# 1) board の orchestrator session に provider session id を登録する（計測の前提）
hachi orchestrator session start <orchestrator-id> \
  --provider claude --provider-session-id <uuid> --json

# 2) このセッションでフックを有効化する（既定は無効）
hachi-orch-enable <uuid>

# 3) heartbeat を回す（background・inbox を消費しない純 heartbeat）
while true; do hachi orchestrator session heartbeat <session-id> --generation <n> >/dev/null; sleep 30; done &

# 4) inbox の着信待ちを張る（heartbeat とは別プロセス。claim して return したら再アーム）
hachi orchestrator await --session <session-id> --generation <n> --json

# 5) 伝達路を張る（§1.3.1）。3 と 4 はログへ書くだけで自分を起こさない
```

`hachi-orch-enable` の実体は checkout 内 `scripts/orchestrator/hachi-orch-enable`。
`~/.local/bin` への導入は §0.7.2.1 と同じ `scripts/setup-local.mjs` を使う（手動配置しない）。

無効化は `rm ~/.hachi-kanban/state/usage-hook/enabled/<uuid>`。

#### なぜ opt-in なのか（既定で無効にしている理由）

このフックはグローバル登録されており、**worker セッションでも走る**。even-terminal は
Agent SDK へ `settingSources: ["user", "project"]` を渡すため `~/.claude/settings.json` の
hooks が読まれる。当初は「オーケストレーターかどうかを board へ問い合わせて、違えば抜ける」
方式だったが、**その判断のために CLI を 3 回呼んでいた**。CLI 1 回は pnpm→tsx の起動で
約 3 秒かかるため、全 worker の 1 プロンプト目を毎回遅らせていた。

実測（worker 相当の無関係セッション 1 回あたり）:

| 方式 | 所要 |
|---|---|
| 照合して判断（当初） | 12.6〜14.0 秒 → **hook timeout に当たり通知が消失した** |
| 負のキャッシュ | 0.12〜0.19 秒 |
| **opt-in ゲート（現行）** | **0.034 秒**（何もしない bash と同値＝下限） |

判断そのものを不要にし、opt-in ファイルが無ければ `stat` 1 回で抜ける。`session_id` の
取り出しも純 bash で行い、ゲートより前に `jq` を起動しない。

#### 動作の約束

- **セッションを壊さない**。判定不能でもコマンドが失敗しても exit 0 で抜ける
- **黙って ok にしない**。判定不能の理由も `additionalContext` へ載せる。
  **stdout** 無出力 = 総合判定は ok、という対応を保つ（§0.7.3.1）。
  軸単位の欠測は stderr に出るので、`2>&1` で拾うフックでは ok でも文面が出る
- **heartbeat は `hachi orchestrator session heartbeat` の専用ループで回す（2026-08-22 改訂）。**
  30 秒間隔で打つ。stale 閾値 90 秒は「30 秒間隔が 2 回落ちたら死」という組み合わせで意味を持つので、
  **閾値だけを延ばすのは筋が悪い**（閾値は死の検知用であって生存の維持用ではない）。
  回っていないと計測の鎖は既定で死ぬ（2026-08-21、実際に死んでいて誰も気付かなかった）
- **`orchestrator await` を生存維持に使わない。** `await` は request を **claim して return する**
  実装（`runAwait` → `claimOrchestratorRequest`）なので、生存維持を await に依存させると
  **「着信＝heartbeat 停止」**になる。gen45 はこれで stale 化し `takeover` を要した（mission #2485）。
  ループで再アームしても、着信から再アームまでの間は heartbeat が止まる。
  **生存維持（heartbeat ループ）と inbox 消費（await）は別プロセスに分ける**
- **`await` の return を握り潰さない。** claim した request の内容は return 時の stdout にしか出ない。
  ログへ追記するだけのループにすると着信に気付けない。inboxはdurableでも処理済みの証拠にはならない。
  回答・解決はrequest kindに対応する操作と、現行session/generation/claim tokenが必須（契約§55.2）。
  claimを見失った場合は正規の再取得手順に従い、tokenなし回答で代用しない。
  **誰も見ないなら監視ではない**。
- **フックの heartbeat は保険**。ユーザー入力ごとに走る＝セッションが現に生きている証拠なので
  そこでも打つが、入力間隔が 90 秒を超えれば失効する。`await` の代わりにはならない
- **失効を黙って見逃さない**。過去の対応付けを
  `~/.hachi-kanban/state/usage-hook/bound/<claudeSessionId>` に持ち、失効時は再開手順ごと通知する
- **毎ターン同じことを言わない**。段階が変わるか 15 分経つまで再通知しない。
  抑制キーから数値は外すので、段階が変われば必ず再通知される
- **有効なセッションでの所要は約 0.5 秒**。対応付けを 5 分キャッシュし、通常は CLI 1 回で済ませる

#### 通知するだけで起動はしない

後継セッションの起動は provider 別に reference §0.7.5 の正規経路を使う。Claude は
`hachi orchestrator handover --apply`（§0.8）、Codex Desktop は `create_thread` であり、
Codex から Claude 専用 `--apply` へ倒さない。自動起動まで繋ぐかは各 provider 経路の
実機検証と堅牢化が済んでから決める。

### 0.7.4 新セッションの立ち上げを軽くする

- **0. 何よりも先に heartbeat を回す（`k_b248e07d575b` / `k_1679e0d7bb8f`）。**
  **本節を読み始める前**に、§0.7.3.2 の純 heartbeat ループを background で起動すること。
  規則の読み込みは 90 秒の stale TTL を超えうるので、**先に読むと
  自分の session が失効し、takeover が必要になる**。実際に gen45 とタコ側 gen8（`os_7fb6db04311f7251`）で起きている。
  `handover --apply` で起きた後継は起動プロンプト冒頭にこの指示が入っている
  （`orchestrator.ts` が埋める）ので自動的に守られるが、**手動ブートストラップでは自分で守る**
- `runbooks/orchestrator-playbook.md`（**core**）は冒頭の段階的な読み方に従う。
- **`runbooks/orchestrator-reference.md` は全文を読まない。** core 冒頭の trigger index で、
  これから入る作業に対応する節だけを引く
- **`docs/contract.md` は関連節だけ読む。全文を読まない**
- `python3 scripts/read-operations.py knowledge --limit 20` で更新順の索引を読み、対象語で検索して関連IDだけ`knowledge show`する
- **ミッション task は `hachi task show <id> --comments 2` で読む**（既定は5件）。
  足りなければ増やす。最新の引き継ぎコメントだけで現在地が分かるように書くのが書き手側の責務（下記）
- `hachi board` / `orchestrator inbox` / `task await --all --follow-new` で現況を把握する

#### 引き継ぎコメントの書き方（床 C₀ を押し上げない）

`task show` は既定で最新5件しか出さない（`DEFAULT_SHOW_COMMENTS = 5`）ので**件数は頭打ち**だが、
**1件あたりの長さは野放し**である。床が世代ごとに増える原因はここ（レポートは「5世代ぶん
積み上がる」と書いたが、実際は5件で頭打ちになった状態を観測していた）。

- **1件 800 字以内**。2026-08-22 の gen47 は 2,261 字の引き継ぎコメントを書いて自分で床を上げた
- **前世代の経緯を再掲しない。** board に既にある（§0.7.1）。書くのは §0.7.2.2 の3つだけ —
  どこまでやったか / 次の一手 / いま何を待っているか
- **最新1件で現在地が分かる形にする。** 前世代のコメントを参照させない（`--comments 2` で
  足りるのはこれが守られている時だけ）
- 判断の詳細・検証記録は**当該 task 側のコメント**へ書く。ミッション task には要約と ID だけ置く

## 0.8 オーケストレーター identity / session の開始と交代（contract §55）

オーケストレーターは Mac 単位の singleton ではない。**責務ごとに stable identity** を作り、各会話は
その identity の ephemeral session として generation を更新する。同一 project の分業は同じ identity の
同時 session ではなく、別 identity + primary/collaborator/observer の watch/binding で表す。

```bash
# 初回（cwd/repo common-dir は canonical 化される）
hachi orchestrator register --label "<責務名>" --project <project> --cwd <worktree> --json

# 通常の質問 inbox（sessionId/generation は register/status の出力を使う）
hachi orchestrator list --json
hachi orchestrator await --session <sessionId> --generation <n> --json

# provider 別 manual fallback（Codex Desktop など）: 旧セッションで prepare、新セッションで accept
hachi orchestrator session handoff-prepare <oldSessionId> --generation <n> --json
hachi orchestrator session handoff-accept <oldSessionId> --token <token> \
  --provider <claude|codex> --provider-session-id <後継自身の session id> --json
  # provider 2つは省かない（§0.7.3.1）。渡すのは板側の os_* ではなく
  # **後継のネイティブログを引ける provider 固有 id**。
  #   claude: `--session-id` で渡した uuid（検証済み）
  #   codex : **どの id を渡すべきか未確定**（`CODEX_THREAD_ID` / App Server の `thread.id` /
  #           `thread.sessionId` / `session_meta.payload.id` / rollout ファイル名の suffix の
  #           対応が未検証）。reference §0.7.5 の警告を読んでから使う（`t_0898fd0005b3eb56`）
hachi orchestrator session handoff-cancel <oldSessionId> --generation <n> \
  --token-hash <handoffTokenHash> --confirm-successor-stopped --json

# 旧セッションが突然死し heartbeat が90秒以上古い場合だけ
hachi orchestrator session takeover <orchestratorId> --stale-sec 90 --json

# 後継 tmux セッションを自動起動する別フロー（prepare→accept の手動2コマンドとは異なる。既定 dry-run）
hachi orchestrator handover --session <oldSessionId> --generation <n> --mission <taskId> --json
hachi orchestrator handover --session <oldSessionId> --generation <n> --mission <taskId> --apply --json
```

- `orchestrator handover` は Claude の後継 tmux 起動と durable handoff final を親 CLI が一貫して行う
  provider 固有経路。上記 manual fallback の `handoff-accept` を後継に実行させる経路ではない。
  既定は dry-run で副作用ゼロ（token を含まない起動プロンプト全文・tmux コマンドライン・事前検査・
  transfer プレビュー・ミッション配下タスク集計を返すだけ）
- `--apply` は事前検査が全て通ったときだけ実行する。正常入力では事前検査は実装順に次の9件
  （`cwd-trusted` は `cwd-usable` 成功時のみ追加。`handover --json` の
  `preflight` 配列と同じ順）:
  1. `tmux-available` — tmux が PATH にあるか
  2. `session-name-unique` — 後継 tmux セッション名が既存セッションと衝突しないか
  3. `mission-valid` — ミッション task が存在し archived でないか
  4. `session-generation-match` — 旧 session が active で generation が一致するか
  5. `cwd-usable` — 起動 cwd が絶対パスの実在 directory か
  6. `cwd-trusted` — `.claude.json` 上で起動 cwd の trust dialog が承諾済みか
  7. `mission-identity` — ミッション task が当該 orchestrator の担当範囲か（§55.1/§69.3）
  8. `tmux-command-size` — executable と argv 全体が UTF-8 15,000 bytes 以下か
  9. `provider-launchable` — 旧 session の provider が Claude と確認できるか
- 事前検査を通過すると、親 CLI は raw handoff token を自身の process 内だけに保持し、その hash で durable slot を
  arm する。raw token は起動プロンプト、tmux argv、apply 後の JSON/log のいずれにも配送・再掲しない。起動は
  **tmux new-session の argv に token を含まない起動プロンプトを直接載せる**方式で行う
  （2026-08-21 実機検証: claude 2.1.228 / tmux 3.6a / macOS）。
  `claude [options] [prompt]` の位置引数プロンプトは対話モードのまま第1ターンとして自動送信される
  ことが判明したため、旧来の paste-buffer 経由の貼り付け・pane readiness 確認・`send-keys` 経路は
  不要になった:

  ```
  tmux new-session -d -s <name> -c <cwd> claude --session-id <uuid> -- "<startupPrompt>"
  ```

  `--` は必ず挟む。`--add-dir` 等の variadic option が後から追加されると位置引数プロンプトを
  食ってしまう既知の危険があるため。dry-run と `--apply` の実 argv は末尾要素も含めて完全一致する
  （`buildTmuxArgs` を dry-run/apply の両方で共通利用しているため、食い違いは構造的に起きない）
- **`--apply` が成功したら、接続コマンドをユーザーへ必ず渡す。** 後継は detached で起きるため
  ユーザーの端末は旧セッションに繋がったままで、自動では移動しない。戻り値の `tmuxSessionName` を
  埋めた `tmux switch-client -t <name>`（tmux 内に居る場合）または `tmux attach -t <name>`
  （外に居る場合）を引き継ぎ報告に載せる。判断基準と詳細は reference §0.7.5 の
  「起動したら接続コマンドをユーザーへ必ず渡す」を参照
- 起動プロンプトには owner-only token と独立した `launch nonce` を含める。起動確認後、親 CLI が後継の
  transcript jsonl を
  bounded polling し、(1) `type:"user"` 行の本文に同じ nonce がある、(2) その後に
  `type:"assistant"` 行がある、の2段階が揃った場合だけ `delivery.status=confirmed` とする。
  jsonl ファイルの存在だけでは成功にしない。未信頼 cwd は transcript が生成されず trust dialog で止まるため、
  自動応答せず `cwd-trusted` preflight で弾く。一度その cwd で Claude を手動起動し、trust を承諾してから再実行する
- delivery 確認後は親 CLI が `claude-delivery` attestation を作成し、同じ durable slot の claim と handoff final を
  完了する。final transaction は slot/handle/fence/token hash、source session/generation、row 固定 runtime identity を
  再検証し、旧 session の supersede、後継 session 作成、claim 移管、slot の `succeeded` 化を原子的に行う。
  後継自身は generic `handoff-accept` を実行しない。Codex Desktop/manual fallback の token 配送と accept は上記の
  provider 別手順に限る
- 送達確認が timeout / probe error / session 消滅になった場合は、未送達ではなく
  `delivery.status=unknown`・`tokenDisposition=possibly-consumed`・`retryPolicy=new-token-required` と表す。
  **同じ token で再 launch しない。** 既存の停止・cancel 補償へ流し、active へ戻った後の再実行で
  新しい token を発行する
- 起動・所有権確認・起動確認・送達確認のいずれかが失敗した場合は fail-closed で補償する:
  - kill は「launch 直後に設定した所有権 nonce（tmux セッションのユーザーオプション）が現在も自分の
    ものであると確認できたときだけ」試みる。確認できない場合（TOCTOU で別プロセスが同名セッションを
    先に作成した可能性がある場合）は kill を一切行わず、DB も戻さず手動対応を促す
  - kill を試みた場合／何も所有していなかった場合のいずれも、「tmux セッションの消滅」「pane PID の
    消滅」「pane が属していた process group の消滅」の3点が揃うまで bounded polling で確認する
    （`kill-session` 後も子プロセスが残ることがあるため、セッション消滅だけでは停止したと判断しない）
  - 3点の停止を確認できたときだけ `handoff_pending → active` に戻す（旧セッションは継続可能）。停止を
    確認できない場合は DB を戻さず、旧セッションとの二重稼働を避けるため手動対応を促すメッセージを返す
- `handover --apply` の `handoff_pending` 回復は、同じ `--session` / `--generation` で
  `hachi orchestrator handover ... --apply` を再実行する。CLI は migration v23 の durable slot を一意に再読込し、
  row に固定済みの exact tmux session・pane PID・process group と owner-only stop fence だけで rollback を再開する。
  prefix / glob 検索、generic kill、`session handoff-cancel` への並行 state machine は使わない
- crash / SIGINT で失敗出力が無い場合も同じ再実行経路を使う。slot が deadline 内なら mutation せず待機を返す。
  deadline 後または `stop_pending` なら exact owner readback 後に停止し、三点を観測する。`uncertain` なら保存済みの
  owner一致・kill成功・owner readback hash を変更せず、row 固定 target の三点だけを fresh 観測する。保存済み証拠が
  完全で三点も消滅した場合だけ `stopped` と source の `active` 復旧を同一 transaction で確定し、それ以外は
  `uncertain` のまま replacement gate を閉じる
- 事前検査にはミッション task が当該 orchestrator の担当範囲かの確認を含む（§55.1/§69.3 の配送先解決を
  そのまま再利用。binding 優先・observer 除外）
- セッション開始時は `hachi orchestrator list --json`、
  `hachi orchestrator session status --orchestrator <id> --json` と
  `hachi orchestrator inbox --orchestrator <id> --json` を必ず確認する
- **あわせて消費監視を立ち上げる（§0.7.3.2）**。6 つとも要る。1 つでも欠けると監視は
  黙って止まり、「見ているつもり」になる

> **⚠ 掃除の前に読む — argv の罠（2026-08-29 実害・`k_111dff228d96` / epic `t_0a451eefae041c11`）。**
> **後継の argv には起動プロンプトが丸ごと乗る。**
> `tmux new-session -d ... claude --session-id <uuid> -- "<起動プロンプト>"` の位置引数は
> そのまま argv になり、そのプロンプト本文には **「旧 session id: `os_xxx`」と
> heartbeat 起動コマンド（`hachi orchestrator session heartbeat ...`）の両方**が書かれている。
> したがって **`os_xxx` で grep しても `session heartbeat` で grep しても後継本体に当たる。**
> これは `pkill -f` 固有の問題ではない — **`ps | grep` でも同じ事故が起きる。**
> 2026-08-29 に tenant-a で旧世代が自分の heartbeat を掃除しようとして後継の claude 本体を kill し、
> **11分間オーケストレーターが1人もいない状態**になった。
>
> **安全な掃除手順（この順で行う）:**
>
> 1. 候補を列挙する（まだ kill しない）
> 2. **argv に `claude --session-id` を含むものを除外する** — それはオーケストレーター本体である
> 3. **PID ごとに `ps -p <pid> -o args=` で引数全文を確認してから** kill する。
>    切った ps 出力や grep の結果を直接 kill へ渡さない
> 4. heartbeat loop は argv の `--provider-session-id <uuid>` で世代を一意に識別できる。
>    **`os_*` ではなく provider session id で見分ける**
>
> **K1（`t_35ba1bad5d2d91a5`）は統合済み（2026-08-31 / main=16555e5）。だが罠はまだ消えていない。**
> K1 が変えたのは**これから起動する世代の argv だけ**である。gen31 の実測では、起動プロンプトは
> `hachi orchestrator session bootstrap-heartbeat --provider-session-id <uuid>` の1行になり、
> **`os_*` も `session heartbeat` も `while true` も argv から消えた**（`t_35ba1bad5d2d91a5` #4362）。
>
> **しかし K1 前に起動された claude プロセスは生き続ける。** gen31 の時点で **pre-K1 の
> オーケストレーター本体が 8 本稼働**しており（最長 etime 2日18時間）、その argv には
> 旧形式の `旧 session id: os_xxx` と `hachi orchestrator session heartbeat ...` が丸ごと乗っている。
> **したがって `os_*` / `session heartbeat` で grep すると、いまも他世代の本体に当たる。**
>
> **罠が消えるのは「K1 統合時点」ではなく「pre-K1 プロセスが全滅した時点」である。**
> それまで上の安全な掃除手順（`claude --session-id` を含む argv を除外し、PID ごとに
> `ps -p <pid> -o args=` で確認してから kill する）を**そのまま守ること**。
> 全滅を確認したうえでこの注記を削れる。

  0. **旧世代の watcher を止める（自分の watcher を張る前に）。** 2026-08-31 追記
     （`t_9510b71d32800fbd`）。checkpoint が安定名になった（契約 §50.1.1）ので、
     **旧終端 watcher が sidecar lock を握ったままだと後継は fail-closed で起動できない**。
     **止める理由は終端 watcher の lock であって、inbox の横取りではない**
     （§1.3.1 の訂正を読むこと。横取りは実測で否定された）。inbox 側の孤児は
     空回りするだけなので急がないが、世代ごとに1本ずつ積むので同時に落とす。
     **これは旧セッションへプロンプトを打たずに後継が自分で行う**
     （§0.7.2.1 の「旧セッションを動かさない」を壊さないため）。
     **止める対象は watcher script の絶対パスで指定する。session id で `pkill` しない**
     — 起動プロンプトに session id が含まれるため、後継オーケストレーター自身に一致して自殺する。

     **⚠ shell だけ殺しても止まらない（2026-08-31 gen30 が自分で踏んだ）。**
     watcher の shell は `hachi task await` / `orchestrator await` を**前景の子プロセスとして**
     持ち、**lock と inbox claim を握っているのは子の方**である。shell の PID だけ kill すると
     子は `ppid=1` の孤児として生き残り、**同じ session/generation を待ち続ける**。
     gen30 は watcher を2回張り替えた結果、**自分の inbox を3プロセスが待つ状態**を作った
     （`orchestrator await --session <自分> --generation 30` が孤児として2本）。
     着信すれば孤児が claim し、その stdout は誰も読んでいない。

     **⚠ 順序は「wrapper → 子孫」。逆にすると孤児が増える。**
     子を先に殺すと、**ループしている wrapper が次の子を起動してから** wrapper が死ぬので、
     生まれたばかりの子が孤児になる。確実に止めるなら **wrapper を先に `SIGSTOP`** して
     ループを凍らせ、子孫を終了させ、最後に wrapper を回収する。

     ```bash
     # 1) 候補を出す。**自分の責務の watcher だけに絞る**（他責務・他 board を止めない）
     ps -eo pid,ppid,etime,command | grep -a 'orch-watch/hk-gen' | grep -av grep
     # 2) wrapper を先に凍らせる → 子孫を終了 → wrapper を回収（PID は1つずつ指定する）
     kill -STOP <wrapper-pid>; kill <child-pid>...; kill <wrapper-pid>; kill -CONT <wrapper-pid>
     # 3) 引数全文で孤児が残っていないか確認する（--session まで見る）
     #    **-e は必須**。付けないと制御端末を持つプロセスしか出ず、nohup で切り離された
     #    ppid=1 の孤児（tty=??）＝いま探しているものが、ちょうどこの検査から漏れる。
     #    ただし -e と -p <pid> は併用しない（-e が勝って全プロセスが出る）
     ps -eww -o pid=,ppid=,command= | grep -a 'orchestrator await\|task await' | grep -av grep
     ```

     **止まったことの確認に checkpoint の mtime を使わない。**
     `--cursor-file` は targetIds に変化が無ければ**書かない**ので、
     lock を正常に取得できていても mtime は進まない。**mtime の停滞は失敗の証拠ではない。**
     確認するのは次の2つ:

     1. 上の手順3で**該当 PID が1つも残っていない**こと
     2. 新しい watcher のログに **lock 由来の error 行が出ていない**こと
        （sidecar lock が握られたままなら `await` は非0で戻り、§1.3.1 の error 行が出る）

  1. `session start` に `--provider claude --provider-session-id <自分の session id>` を付ける
     （付けないと計測できず、`--check` は fail-open で ok を返す）
  2. `hachi-orch-enable <自分の session id>`（フックは既定で無効。worker を遅らせないため。
     実体は checkout 内 `scripts/orchestrator/hachi-orch-enable`、`~/.local/bin` への導入は
     §0.7.2.1 の `scripts/setup-local.mjs` 経由）
  3. `hachi orchestrator session heartbeat <id> --generation <n>` を 30 秒間隔で background で回す
     （回さないと 90 秒で session が失効する）
  4. `hachi orchestrator await --session <id> --generation <n> --json` を background で張る
     （inbox の着信待ち。**3 とは別プロセスにする** — await は claim して return するため、
     これを生存維持に使うと「着信＝heartbeat 停止」になる。gen45 の stale 化の原因）
  5. **伝達路を張る（§1.3.1）。3 と 4 はログへ書くだけで、自分を起こさない。**
     これを忘れると、終端を1秒以内に検知していても誰も次の手を打たない（2026-08-28 実害）
- 同じ label/project/Git common-dir の `register` は既存 identity/live session を返す（冪等）。
  分業 identity は責務が分かる別 label にする
- planned handoff は未解決 claim を新 generation へ移管する。stale takeover は旧 claim を queued へ戻して再 claim する
- 旧 session は `SESSION_SUPERSEDED` で mutation を拒否される。回避のため task answer/msg send を使わない
- `orchestrator await` は**待機中に限り**、自身のsession/generationを30秒間隔でfenced heartbeatする
  （stale TTL 90秒と同じcore policyが正本）。`--interval` はinbox poll周期であり生存間隔ではない。
  **claim して return した後は打たない**ので、単独では生存維持にならない（上記 3 / 4 の分離）。
  複数のawaitは同一generationへの冪等更新として共存できるが、handoff/takeover後の旧awaitは
  `SESSION_SUPERSEDED` で停止するため、新session/generationで再アームする
- Codex thread heartbeat automationを使うidentityは、handoff accept/takeover後に新thread側からautomationの
  target threadとprompt内session/generationを更新し、ACTIVEのreadbackを確認する。旧threadを閉じるのは
  更新成功後。automationはidentityごとに分け、他project/他orchestratorの責務を混ぜない
### 0.8.1 ミッション task は「常設の指し先」として別に立てる（2026-08-28 実害）

#### board の `active` は生存の証拠にならない（2026-08-29 実害）

**生存 signal（heartbeat）は、それが代表するはずの実体（claude プロセス）と切り離されている。**
孤児 heartbeat loop は、対応するセッションが死んでいても打ち続けるので、
`orchestrator list` は `status=active / heartbeat 23 秒前` を返し**続ける**。
2026-08-29 の事故では、後継が死んだ後も board はずっと active に見えていた。
**誰も異常を検知せず、ユーザーがスマホで気付くまで 11 分かかった。**

**したがって引き継ぎ後は、board の表示ではなく5点で生存を確認する（必須手順）:**

**プロセスが生きているか（3点）**

1. **tmux セッションが存在する**（`tmux has-session -t <tmuxSessionName>`）
2. **`claude --session-id <successorSessionId>` のプロセスが存在する**

   > **⚠ `pgrep` / `pkill -f` で判定しない（2026-09-01 gen34 実測）。**
   > macOS の `pgrep` は **既定で自分自身と祖先チェーンを除外する**（man pgrep:
   > 「By default, the current pgrep or pkill process and all of its ancestors are
   > excluded」。`-a` を付ければ含められることは実測済み）。後継が §0.8.1 の5点を
   > **自己検査**する場合、自分の claude 本体は祖先なので `pgrep -f "claude --session-id <uuid>"`
   > は `rc=1`（不在）を返す — **健全な自分を「プロセス不在」と誤判定する**。
   > 実測では祖先3本（zsh / claude / tmux）が全て pgrep から不可視で、非祖先の claude は可視だった。
   > argv 長（761 bytes）や権限の問題ではない。
   > **`ps -eww -o pid=,args=` で引く**（`sysctl kern.procargs2` でも可）。
   > `pgrep -a` でも引けるが、**既定と挙動が変わるフラグに依存させない**。
   > 掃除側でも同じ — **`-a` の無い「pgrep で確認したら居なかった」は不在の証拠にならない。**

3. **後継の transcript の `type:"assistant"` 行が増えている**
   （`~/.claude/projects/<proj>/<successorSessionId>.jsonl`。**存在ではなく増加**を見る）

**board 上で仕事ができるか（2点。ここを落とすと「生きているが何もできない後継」を healthy と誤判定する）**

4. **後継の active な board session 行がある**

   ```bash
   hachi orchestrator session resolve --provider-session-id <successorSessionId>
   # SID= / GEN= が返れば OK。live session が無ければ matches=0 で **exit 1**（2026-08-31 実測）
   ```

5. **その session の heartbeat が前進している**（`orchestrator list --json` の `liveSession` を
   2回引いて `heartbeatAt` が進むこと。**1回の観測では孤児 heartbeat と区別できない**）

**1〜3 が green でも 4 が落ちる状態が実在する。** 後継のプロセスは生きていて transcript も伸びるが、
**durable handoff final が完了しておらず board session が無い**ため、`task` / `orchestrator` 系の
mutation がすべて拒否される。**動いているのに何も board へ反映できない後継**であり、
過去に 21 分間気付かれなかった。1〜3 だけの検査ではこれを healthy と判定してしまう。

**4 が落ちた時の経路（生きているが未登録）:**

- **後継を先に殺さない。** 旧 session がまだ `active` なら、`handover --apply` の再実行
  （新しい token が出る）で正規経路をやり直せる
- 旧 session が既に superseded / stale なら `session takeover <orchestratorId> --stale-sec 90` で
  後継が自分の session を取り直す
- **どちらとも言えない場合は escalate する。** 二重稼働を作るより、止まっている方が安い

`handover --apply` の `delivery: confirmed` は「後継が assistant ターンを1回出した」ことしか
見ていない（**一点観測**）。**生き残ったかも、board に登録できたかも見ていない。**
K2（`t_681e04d1b8ff9397`）がこの5点を CLI 側の生存ゲートとして入れるまで、**確認は人手で行う**。

#### 後継を失った時の復旧は「孤児を殺す前」に回す

後継が死んだ場合、**孤児 heartbeat が生きているうちに**
`hachi orchestrator handover --session <死んだ世代の session> --generation <n> --apply` を回す。

**順序が本質的である。** 孤児を先に殺すと board の session が stale になり、
`session-generation-match` preflight（旧 session が active であること）が落ちて
**handover が使えなくなる**。そうなると `session takeover` からやり直す羽目になる。
**掃除は復旧の後。**


**後継セッションの起動 cwd は、ミッション task の body の `cwd:` 行から解決される**
（`packages/cli/src/commands/orchestrator.ts` の `parseCwdFromBody` → `resolvedCwd`）。
このためミッション task の作り方がそのまま引き継ぎ可能性を決める。

2026-08-28、**ミッションを宣言している3 identity のうち2件が引き継ぎ不能**になっていた。
どちらも「引き継ごうとするまで誰も気付かなかった」。原因は次の2つで、
**いずれもコードのバグではなく、時間が経つだけで起きる**。

- **ミッションが `steward auto-archive` で archived になる** → `mission-valid` preflight が落ちる。
  ミッションは常設の指し先なのに、通常 task と同じ寿命規則で処理されていた
- **ミッションの `cwd:` が worktree を指している** → `cwd-usable` preflight が落ちる。
  worktree は host-finalize 後に remove する（reference §1.5 step 10）ので、**必ず消える**

規則:

- **ミッション task は worker タスクを流用しない。** `[mission]` を冠した専用 task を
  `todo` で1本立てる（`ready` にしない = worker は起動しない）
- **`cwd:` には本チェックアウトを書く。worktree を書かない**
- body に「この task を `ready` にしない」「`archived` にしない」を明記する
- 責務が終わるまで archive しない。終わったら**先に後継ミッションを立ててから** watch を張り替える

#### dry-run の `blocked=false` は「送達成功」を意味しない（2026-08-28）

**preflight 9件が全部 OK でも `--apply` は失敗しうる。** 送達確認は `--apply` でしか走らないため、
dry-run が示すのは「対象を解決でき、起動条件が揃っている」ことだけである。
2026-08-28、tenant-a の gen6 は dry-run green を根拠に「準備完了」とユーザーへ報告し、
`--apply` が `delivery.status=unknown` で落ちた（通算3回目）。**dry-run を送達の保証として引用しない。**

`--apply` 後の失敗はこう出る。

```
"delivery": {"status": "unknown", "reason": "後継 transcript に nonce 一致 user 行と
             後続 assistant 行が 15000ms 以内に揃いませんでした"},
"tokenDisposition": "possibly-consumed", "retryPolicy": "new-token-required",
"applied": false, "rolledBack": true
```

**同じ token で再 launch しない**（§0.8 の補償規定）。補償が効いていれば旧 session は active へ戻る。

#### `delivery=unknown` は断続故障である。1回で諦めない（2026-08-28 実測）

**1回の delivery 失敗を「構造的に壊れている」と読まない。新しい token で再試行する。**
board の `orchestrator_successor_launches` 全8件を時系列で見ると、成功と失敗が混在している。

```
08-26 14:11 succeeded  9s | 08-26 15:55 stopped 17s | 08-26 15:57 succeeded 4s
08-26 22:39 succeeded 11s | 08-26 22:44 uncertain（pane 衝突・3932d5d で修正済み）
08-27 10:42 stopped 17s   | 08-27 14:26 stopped 17s | 08-28 12:31 stopped 20s
08-28 13:58 succeeded 13s ← 12:31 の失敗後、初めての再試行。1回目で通った
```

**08-26 15:55 に落ちた2分後、同じ条件の 15:57 が成功している。**決定論的な故障ではない。
にもかかわらず 08-27 以降は誰も再試行せず、「引き継ぎ機能が壊れている」という判断だけが残った。
**「ずっと引き継げない」の実体は、1回落ちて止めたことだった。**

- 同じ token では再 launch しない（契約）。`handover --apply` を回せば新しい token が出る
- 落ちても補償は働く。旧 session は active へ戻り、二重稼働は起きない。**再試行の代償は小さい**
- **`retryPolicy: "new-token-required"` を「止めろ」と読まない。**「同じ token を使うな」であって
  「もう一度やるな」ではない。2026-08-28、この文言を停止指示と読んだ結果、
  ユーザーは丸1日以上「引き継げない」状態を抱えた。**再試行は正規手順である**
- **watch を disable しても `--mission` 単独では解決しないことがある。**
  旧 identity の durable slot（`uncertain` のまま残ったもの）が先に引かれるため、
  `--mission` だけの HHN が `後継 session id: None` を返す。
  この場合は `--session` / `--orchestrator` で対象を明示する。
  slot 自体の解消は `handoff-cancel`（後継の停止確認が前提）
- 落ち続けるなら手動ブートストラップ（旧 session close → 新セッションから `session start`）へ倒す。
  durable slot を通らないのでこの故障モードが構造的に存在しない

#### `delivery=unknown` を「窓が短い」で片付けない（実測）

窓は `DEFAULT_DELIVERY_POLL = { intervalMs: 300, timeoutMs: 15_000 }`
（`packages/cli/src/commands/orchestrator.ts`。`SUCCESSOR_DEADLINE_MS` も同値）で、
**config でも CLI フラグでも上書きできない**（DI seam のみ）。
そのため「Claude Code の起動が重くて15秒に間に合わない」という説明が出やすいが、
**transcript の実測はこれを支持しない**。

| 実測（first user 行 → first assistant 行） | |
|---|---|
| 正常に立ち上がった後継 | **2.6 秒** |
| 別の正常セッション（本 repo） | **2.1 秒** |
| 失敗した後継 | **assistant 行が1行も無い** |

失敗した後継の transcript は、user 行・deferred tools・skill listing・auto_mode まで
**200ms 以内に揃っていた**。起動は遅くない。さらに `ai-title` は生成されている
＝ API 自体には到達できていた。落ちたのは「遅かった」のではなく
**本turn が発生しなかった**ことである。窓を広げても直らない可能性が高い。

**切り分けは transcript を見る。** `~/.claude/projects/<proj>/<providerSessionId>.jsonl` で
`type:"assistant"` の有無を数える。

後継の session id は `--apply` の戻り値 `successorSessionId` に出る。取り損ねても
`tmuxSessionName`（`hachi-orch-<orchPrefix>-<successorSessionId>` の形）から復元できる。
**rollback は後継 pane を kill するが transcript ファイルは残る**（2026-08-28、
rollback 後に両オーケストレーターが独立に同じファイルを読めた）。
したがって失敗直後に慌てて保全しなくてよい。**`--apply` の出力を捨てないことだけ守る。**

**assistant 行の有無だけで分岐しない。在った場合は必ず時刻まで見る**
（2026-08-31 gen33 実測・`k_fa851d915c60`。旧版は2分岐しか持たず、第3の枝を
「窓の問題」へ誤誘導していた）。`type:"assistant"` の最初の timestamp と、
slot の `created_at` / deadline を突き合わせて3つに分ける。

- assistant 行が**在って** 15秒を**超えている** → 窓の問題。時間差を実測して報告する
- assistant 行が**在って** 15秒の**内側** → **probe の問題。窓を広げる提案をしない**。
  在るデータを probe が見落としている（`t_552241be2373b74f`）。
  2026-08-31 の実測2件は user 行（nonce 有）から assistant 行まで **2.5秒 / 5.8秒**で、
  deadline まで6秒余っていたのに `delivery=unknown` になった。
  transcript の位置も cwd 由来の project dir と一致していた（経路取り違えではない）
- assistant 行が**無い** → 窓の問題ではない。窓を広げる提案をしない

**成功例でも delivery 確認は arm+10〜15秒かかっている。** 上に記録した
user→assistant 2.1〜2.6秒との差（8〜12秒）がどこで消えているかは未解明で、
**窓が 15秒しかない以上、成功例も薄氷である**。この差を「正常」と読まない。

**引き継ぎ可能かどうかは、引き継ぐ前に確かめる。** dry-run は副作用ゼロである。

```bash
hachi orchestrator handover --session <id> --generation <n> --mission <taskId> --json
# blocked と preflight を見る。tmux は起動しない・token も発行しない
```

`cwd-trusted` だけは自動で直せない（`~/.claude.json` の `hasTrustDialogAccepted`）。
**そのディレクトリで現に Claude が動いていても false のことがある。**
一度そこで手動起動して trust を承諾してもらう以外に経路は無いので、
新しい cwd を使い始めた時点で確かめておく。

- 起票時は `task create ... --orchestrator <identityId>`、既存タスクは
  `orchestrator bind <taskId> --orchestrator <identityId> --role primary` で責務を固定する。
  enqueue 子タスクは binding を継承する
- fenced `orchestrator answer` の受理後に対象 task が done/archived へ先行しても、手動で ready へ戻したり
  DB を修正したりしない。messages stage は終端 task を不変のまま answer を consume し、exact `answer_key` の
  request を resolved へ収束させる。外側判定後に終端化した競合も answer fallback Tx 内で同じconsumeへ切り替わる。
  旧版で `answering` に残った request も、同一 task/key の
  `message_processed` + `message_target_terminal(intent=answer)` が揃えば次 tick で自動回収されるため、
  `orchestrator_request_terminal_answer_resolved` と request read model を確認する

## 1. 標準サイクル

### 1.3 監視（§50 で一元化・2026-07-08〜）

#### 1.3.1 検知と伝達は別物である（2026-08-28 実害・knowledge k_8194abadc094）

**ログに書けている＝監視できている、ではない。読む主体を起こす経路まで含めて監視である。**

**Codex Desktop**のCLIイベント待機・通知専用Luna・親task再開の限定手順は
[Codexイベント待機runbook](codex-event-wait.md)（skill: `hachi-codex-event-wait`）を参照する。
10分の単一pending待機は実測済みだが、実taskの将来の変化から無人で親を再開する全経路は受入未了。
以下のClaude Code専用Monitorの挙動をCodexへ転用しない。

ユーザー報告: 複数プロジェクトで、worker が終了しているのにオーケストレーターが気づかず、
ユーザーが1時間以上あとに確認するまで次の手を打たない事象が多発していた。

gen20 の実測で原因が確定した。**検知は成っていた。伝達が無かった。**
nohup で張った `task await --all` ループは当日の終端6件をすべて1秒以内にログへ記録していたのに、
オーケストレーターは「走行中です」と誤って報告し続け、ユーザーの問いかけで初めて気づいた。

**Claude Code のモデルが再起動されるのは4つだけである。**

| 起床する | 起床しない |
|---|---|
| ユーザー入力 / `run_in_background` の Bash ジョブ完了 / Monitor の stdout 行 / サブエージェント完了 | **ログファイルへの追記**（nohup した watcher はこれ） |

nohup へ寄せたのは `run_in_background` が黙って killed になる事例があったためで、
耐久性と引き換えに起床を失っていた。**二律背反ではない。分ければ両立する。**

- **検知（durable）**: nohup の `task await --all --follow-new` ループ。ログへ終端 JSON を追記する
- **伝達（in-session）**: そのログを `Monitor`（`persistent: true`）で tail する。
  stdout 1行ごとにセッションへ通知が届き、**再アームが要らない**

```
Monitor(persistent=true, timeout_ms=3600000,
  command="tail -n 0 -F <watcher.log> | grep --line-buffered -E '"id":"t_|idle-nonzero'")
```

`inbox`（`orchestrator await` のログ）にも同じ形でもう1本張る。
`run_in_background` の until ループでも起床はするが、**発火のたびに自分で張り直す必要があり、
張り忘れが即座に穴になる**（張り忘れたこと自体は観測できない）。Monitor を既定とする。

**watcher 側は「異常終了を Monitor に見える行として吐く」こと（2026-08-29 gen26 で追加）。**
再アームループは `await` が非0で戻っても黙って回り続けられる。**この時ログに出るのが
再アーム行だけだと、それは Monitor のフィルタに掛からないので、検知が死んだことを
「何も起きていない」と区別できない** — §1.3.1 が塞ごうとしている失敗が、検知側で再発する。

```bash
# CURSOR は $HACHI_KANBAN_HOME/state/task-await/ からの相対パス。論理 watcher ごとに別名にする
CURSOR=orchestrator-main.json
hachi task await --all --follow-new --json --cursor-file "$CURSOR" >> "$LOG" 2>&1
rc=$?
[ $rc -ne 0 ] && echo "{\"watcher\":\"term\",\"error\":\"await-nonzero\",\"rc\":$rc,\"ts\":$(date +%s)}" >> "$LOG"
```

`error` の語は既存の Monitor フィルタ（`'"id":"t_|idle-nonzero|error|Error'`）に掛かるので、
Monitor 側は変えなくてよい。**連続失敗時はバックオフする**（`database is locked` のような
一過性の失敗でスピンさせない。gen26 で実際に1回起きて、この形で検知できた）。
**inbox 側の watcher は session/generation を決め打ちにせず、毎回 provider session id から
解決する** — 世代交代で generation がずれた時に、決め打ちだと無言で回り続ける。
**世代交代したとき、この watcher は「後継を横取りする」のではなく「無限に空回りする」
（2026-08-31 gen30 実測・`t_9510b71d32800fbd`）。**

> **訂正: `t_9510b71d32800fbd` が挙げていた「旧プロセスが新 session を解決して後継の
> inbox request を claim し続ける」は偽である。** gen30 が実測した:
>
> ```
> $ hachi orchestrator session resolve --provider-session-id <旧 PSID>
> エラー: live orchestrator session を一意に解決できません: providerSessionId=... matches=0
> $ echo $?
> 1
> ```
>
> **解決は provider session id 単位**なので、旧 watcher は**自分の PSID しか引けない**。
> 世代交代で旧 session が superseded になると `matches=0` / rc=1 になり、
> **後継の SID/GEN は原理的に得られない。横取りは起こらない。**
> 起票時の推論は「毎回再解決するなら新しい方を掴むはずだ」だったが、
> 引数がそもそも別物だった。**（gen29 は横取りを観測しておらず、予防しただけである。）**

したがって放置された inbox watcher の実害は**空回り**である —
`resolve-failed` の error 行を 30 秒ごとに、**誰も tail していない旧世代のログへ**
書き続ける孤児プロセスが、世代ごとに1本ずつ積み上がる。

**規定: `matches=0` の resolve 失敗が連続したら、自分の世代は終わっている。exit する。**
一過性の DB ロックと区別するため、**連続回数で判定し、`matches=0` を含む失敗だけを数える**。

```bash
gone=0
# ... ループ内、resolve に失敗した枝で ...
case "$R" in (*matches=0*) gone=$((gone + 1)) ;; (*) gone=0 ;; esac
if [ "$gone" -ge 10 ]; then   # 30秒 × 10 = 5分。一過性の失敗では届かない
  echo "{\"watcher\":\"inbox\",\"error\":\"session-gone\",\"psid\":\"$PSID\",\"ts\":$(date +%s)}" >> "$L"
  exit 0
fi
```

**終端 watcher の方が実害は重い。こちらは後継を実際に止める。** checkpoint 名を
`<board>-<責務>.json` の安定名にした（契約 §50.1.1）帰結として、
**旧 watcher が sidecar lock を握ったままだと後継の watcher が fail-closed で arm できない**。
終端 watcher は session を持たないので自分では気付けない。**後継が落とすしかない**
（core §0.8 の step 0）。

**ただし伝達には下限遅延がある（2026-08-29 gen22 実測。`t_2050b7815baf5879` コメント #4015）。**
Monitor の通知は、**イベント発火の時点で実行中だったツール呼び出しが終わるまで届かない。**
境界は assistant のテキスト応答ではなく**ツール結果**である（上の「stdout 1行ごとに届く」は
ツール境界の粒度で読むこと）。

| 発火時の状況 | 到達までの遅延 |
|---|---:|
| 短いツール（1秒）自身が追記 | 1秒 |
| 6秒のツールを**連続実行している最中**に外部プロセスが追記 | 2秒 |
| 90秒のツールの冒頭で追記 | 90秒 |
| 100秒のツールの実行中に外部プロセスが追記 | 80秒 |

**危険なのは「ツールを回していること」ではなく、1本で数分かかるツールを回すことである。**
短いツールの連鎖なら数秒で届く。`pnpm test` / `pnpm install` / ビルド / 長い git 操作の最中に
worker が終端すると、そのツールが終わるまで気づけない。**host-finalize の最中に別 worker が
終端する形**が実害になる。

- **規律: 数分かかるツールを1本回した直後は、watcher ログを直読して取りこぼしを確認する。**
  通知が来ていないことを「何も起きていない」と読まない
- **2026-08-28 gen21 が観測した「6分」は、2026-08-29 に「どの区間で起きているか」まで特定できた**
  （方式比較 `t_2050b7815baf5879` #4100。「未検証」だった記述をここで置き換える。
  **機序そのものは下記のとおり未解明のままである**）。**遅延は2つの区間に
  分かれており、上の表が説明するのは後半だけである。**

  | 条件 | ログ追記 → enqueue | enqueue → モデル到達 |
  |---|---:|---:|
  | gen22 短いツール | 約1秒 | 約2秒 |
  | gen22 90秒ツール | 約1秒 | 約90秒 |
  | gen22 100秒ツール中に外部プロセスが追記 | 約1秒 | 約80秒 |
  | **gen21 アイドル時の本番終端** | **約116秒** | 約8秒 |
  | **gen21 合成プローブ** | **約351秒**（約5分51秒） | enqueue 直後 |

  **gen22 の遅延はすべて「enqueue → モデル到達」に出ており、上のツール結果境界の機構で説明できる。
  gen21 の遅延は「ログ追記 → enqueue」に出ている** — つまり**ツール境界機構では説明できない**という
  当時の判断は正しかった。候補として挙げていた「実際には長い単一ツールが実行中だった」は否定された。
  除外できたものは3つ: **`tail -F | grep --line-buffered` の通常バッファ**（完全同形の単独プローブは
  約1.4ms で通過）、**固定の配送間隔**（Monitor は stdout を 200ms 単位でまとめるだけで、
  2分・6分の固定間隔は存在しない）、**レート制限**（10件バースト・2秒ごとに1件補充。gen21 は
  grep 通過が2行だけで抑制通知も無い）。
  **残った機序は未解明である** — 保存済みの証跡からは `tail` の追従ループと Claude 側 stdout pump の
  どちらかまでしか絞れていない。**「アイドルだから遅い」とも確定していない**
  （116秒はアイドル時の本番終端だが、351秒は合成プローブであり同条件ではない）。
- **gen21 の「6分」は正確には約5分51秒である**（transcript 上の実到達は 20:41:55。
  20:42:10 は到達時刻を確認したツール結果の時刻だった）。
- **規律は現行のまま維持する**（persistent Monitor + 長時間ツール直後のログ直読）。
  上の実測はこの2本立てを支持する: 後半区間はツール境界で説明でき直読で補える一方、
  **前半区間は低頻度ながら2分〜6分に達しうるので、「通知が来ていない＝何も起きていない」と
  読んではならない**という結論は変わらない

**この節が挙げていた穴3つの現状（2026-08-31）。穴1・穴2 は解消。穴3 は自動停止の床だけが残る:**

- 穴1（再アーム窓）: **解消**。`--cursor-file` の P1 1件 + P2 2件を 2026-08-30 中に全部修正・統合し、
  **運用禁止は解除済み**（`k_3cc257fe8604`。下の「切り替えの規律」が現行の正本）
- 穴2（stall の即時通知）: **解消**（main=755cebe）
- 穴3（stall 検知の遅さ）: **検知は解消**（main=cd8fdf1）。**手で狙って止める手段も解消**
  （fenced cancel。2026-08-31 / main=`16555e5`）。**残るのは自動停止の床** — 共有 guard の
  実効120分は下げていない

**この見出しは 2026-08-30 に2度、2026-08-31 にもう1度誤った。**
一度は「3つとも残っている」（穴2/3 の解消を取り込み損ねた陳腐化）、次は「3つとも解消」
（穴1の P1 と穴3の停止側を無視した逆向きの陳腐化）。3度目は 2026-08-31 の gen31 で、
**項目を3つとも書き換えたのに見出しの「3つとも完全には塞がっていない」を残した**
（レビューで検出。この節が禁じている形そのものを、この節を直しながら作った）。
穴1 に至っては、20行下の本文が「運用可」と書いているのに見出しだけ
「採用を撤回」のまま数日置き去りにされていた。
**節の見出しを書き換えるときは、その節の全項目を読み直してから書くこと。**
20行下の項目が見出しを否定している状態を作らない。

- ~~`task await --all` のスナップショット問題~~ → **2026-08-30 に解消（main=93ccd7f）。**
  `--all --follow-new` が arm 後に ready 化したタスクを拾い（2026-08-29 / main=cd1582c）、
  残っていた**再アーム窓**（`task await` は最初の終端で exit するため、exit から次の arm までに
  終端した別タスクが永久に報告されない）を **契約 §50.1.1 の `--cursor-file`** が塞いだ。
  **2026-08-30 のセルフレビューで出た P1 1件 + P2 2件は同日中に全部修正・統合した**ので、
  **`--cursor-file` は運用可**である（経緯と各欠陥の内容は契約 §50.1.1）。標準コマンド:

  ```bash
  hachi task await --all --follow-new --json --cursor-file orchestrator-main.json
  ```

  - **P1** `t_45be262b11a8e7d8`（main=`53af796`）— 再開時 merge が非終端遷移を終端報告していた。
    未修正 main / 修正 branch / 統合後 main の3系統で A/B して解消を実測
  - **P2-a** `t_22df8d2caf3eebe7`（main=`da66f56`）— 2本目 open の**失敗**で1本目の POSIX lock が落ち、
    別プロセスが取得できていた。fd を開く前に拒否する形に変え、独立プローブで排他維持を実測
  - **P2-b** `t_6ac7c0c684dc73ea`（main=`30e0771`）— 解釈不能イベントが再生経路だけ fail-open だった

  **切り替えの規律**: `--cursor-file` を**付けても付けなくても検知は動く**（付けないと再アーム窓が
  残るだけ）。したがって**走行中の watcher を慌てて張り替えない**。次にセッションが
  張り直すときに新形へ寄せる。渡すのは `$HACHI_KANBAN_HOME/state/task-await/` からの相対パスで、
  **論理 watcher ごとに別ファイル**にすること（同一ファイルの同時利用は sidecar lock で fail-closed）。
  出力の `dedupeKey` は **at-least-once なので重複しうる。受け手が落とす**。

  仕様の要点（正本は契約 §50.1.1）:

  - `--cursor-file` は **`--follow-new` とだけ併用でき、`--json` を必須**とする
  - 渡すのは `$HACHI_KANBAN_HOME/state/task-await/` からの**相対パス**（絶対パス・`..` は拒否）。
    **論理 watcher ごとに別ファイル**にする（同一ファイルの同時利用は sidecar lock で fail-closed）
  - **名前は `<board>-<責務>.json`（例 `dev-orchestrator-main.json`）にする。**
    `gen29-terminal.json` のような世代入りは、**世代交代のたびに初回扱いで arm し直す**ので
    引き継ぎのたびに再アーム窓が開く。分ける単位は論理 watcher であって世代ではない。
    **board 名を落とさない** — `state/task-await/` は board 間で共有なので、board 非依存の名前は
    衝突して一方の board が無監視になる
  - **中間 directory は作られない。** `sub/w.json` は ENOENT で失敗する。
    入れ子名を使うなら 0700 で事前作成する（自動作成しないのは契約。打ち間違えた名前が
    黙って新しい checkpoint になるのを防ぐため）
  - 出力に `dedupeKey` が載る。**at-least-once なので重複しうる。受け手が dedupeKey で落とす**
  - 壊れた checkpoint / board 識別子の不一致 / cursor の逆行は**暗黙 reset せず失敗する**。
    watcher が非0で戻ったら §1.3.1 の error 行を吐かせて Monitor に見せること
  `--follow-new` 無しの `--all` は従来どおり arm 時点固定なので、後発タスクを取りこぼす。
  なお個別タスクを待つ `hachi task await <id>` は**終端後に即座に返る**ため、
  **再アームするループにしてはならない**（同じ終端 JSON を数秒ごとに再発火し続ける。2026-08-29 実害）。
  単発で待つなら one-shot にする
- ~~stall の即時通知が inbox へ届かない~~ → **2026-08-29 に解消（main=755cebe）。**
  `run_stalled` は event・運用通知・§57.4 cancel request に加えて **`kind=run_stalled` の
  orchestrator request** を同一 transaction で作る。**`orchestrator await` で claim できる。**
  対応は `orchestrator answer` ではなく **`orchestrator resolve`**（下の §1.4 表を参照）
- ~~そもそも stall の検知自体が遅い（生きたまま止まった run は 120分経つまで手が入らない）~~ →
  **2026-08-29 に検知だけ解消（main=cd8fdf1）。停止は解消していない。**
  生存中の停滞は `run_stall_suspected` として **codex 15分 / claude 45分**で
  inbox request になる（`t_a37e99b4f9eb716c` #4055 の二段階方式を採択）。
  **ただしこれは警告専用で run を止めない** — 自動停止の床は従来どおり実効120分の共有 guard であり、
  **そこを下げていない**。「気づくのが遅い」は直り、「自動で止まるのが遅い」は残っている。
  **手で狙って止める側は解決した**（2026-08-31 / main=`16555e5`）— `hachi task cancel` に
  `--expect-run` / `--expect-session` を付ければ Store の同一 transaction 内で照合され、
  replacement を誤って止めることはない。**expected を省いた素の cancel は従来どおり危険**
  （`getLatestOpenRun()` を対象にする）なので、停滞警告の回収では必ず付ける（§1.4 の該当行を読む）。
  検知の詳細は下の「stall 検知」の項と契約 §50.2、旧数値の経緯は knowledge
  `k_c9093cb48658`（数値の訂正は `k_6e15c0df4d69`）

- Codex Desktopでは `task await` の終了だけで終了済みthreadがwakeされるとは限らない。
  **thread heartbeat automationは終了済みthreadの回復補助**であり、無変化時にもモデルを起こす
  通常監視の代用にはしない（契約§50.4）。イベントだけで再開できる経路が未成立ならその制約を
  明示する。既存automationを使う場合は担当identityのsession status/inbox、binding/watch、
  recovery queue、watched/in-progress taskだけを確認し、回収後に2本のawaitを再アームする。
  transcriptの定期読込には使わず、交代時はautomation ID/targetをreadbackする
- thread heartbeat automationはorchestrator sessionの生存維持手段ではない。
  generation-fenced `orchestrator await`は待機中だけheartbeatし、return後は止まる。
  §0.8の純heartbeatを別に維持する。無変化のモデル呼び出しで生存を保とうとしない
- 担当tenantを限定する場合は下記標準コマンドへ`--tenant <name>`を追加し、複数tenantは反復指定する。
  対象外tenantの終端は通知せずcursorを進める（契約§50.1.2）。購読条件ごとに別cursor-fileを使い、
  条件不一致時に既存checkpointを削除/resetしない。tenant選択をbinding/claim権限の代わりにしない。
- **標準は `hachi task await --all --follow-new --json --cursor-file <name>.json` を background に1本**
  （発火 → 終端処理 → 再度 await）。`--follow-new` を落とすと arm 後に ready 化したタスクが
  監視対象から漏れる。
  手組みの until ループ watcher は**廃止**（無言故障・検知遅延・per-lane 運用の重さが理由。
  ユーザー指摘 2026-07-08）。特定レーンだけ待つ場合は `task await <id>...`、時限は `--max-wait`（超過 exit 2）
- worker 質問は別系統の durable inbox なので、担当 identity の
  `hachi orchestrator await --session <id> --generation <n> --json` も1本待機する。Telegram の
  「オーケストレーターへ質問」は FYI（返信不要）であり、処理の正本は inbox/claim
- await の終了コードをパイプ越しに拾わない（`| tail` は tail の exit を返す — 実測でハマった）
- **stall 検知は supervisor 内蔵。2026-08-29（main=cd8fdf1）から「警告」と「破壊的 cancel」が分かれた。**
  実装（`packages/supervisor/src/stages/monitor.ts` の `monitorDirectStalls`）は**三経路**である。
  正本は契約 §50.2。
  - **confirmed crash**: `.out` 無成長 **かつ プロセス不在** → `run_stalled` → cancel request。
    **`confirmed crash` は実装上の呼称にすぎない。** `.exit` も終了ステータスも見ていないので、
    **正常終了したのに finalize されず open のまま残った run もここに落ちる**。
    正確には **process absent / unclassified termination の検知**であって、crash の確定ではない。
    いずれにせよ**そのプロセスはもう走っていない**ので cancel してよい（生きた run は止めない）
  - **suspected live stall（2026-08-29 新設）**: **プロセス生存中**の provider 別 progress 無成長 →
    `run_stall_suspected` → **inbox request のみ。cancel は作らない**。
    進捗ソースは codex が `max(.out, native rollout log)`、claude が **native transcript log**
    （`claude -p` の `.out` は完了まで育たないので使わない）
  - **max runtime**: 生存していても `maxRuntimeSeconds` 超過 → `run_stalled` → cancel request
  - session state（`state/direct-sessions/<sessionId>.json`）が読めない run は
    **三経路とも skip し、`direct-session-state-unreadable` を1回だけ警告する**
    （旧「出力無成長のみで判定」の互換フォールバックは**廃止**）。
    **残るのは共有 guard だけだが、それも無条件ではない** — 共有 guard の対象は
    `listInProgress()` かつ session ref を再構成できる task に限られる。
    **state が読めず、かつ in-progress 集合から外れた open run には、この guard も適用されない**

    > **訂正（2026-08-30 gen27 実測 / gen28 で現物確認）: 旧版の「何も適用されず無期限に残りうる」は
    > 機序が違う。** reap ステージは `listInProgress()` ではなく **`store.listOpenRuns()`** を回し、
    > task が done/archived や current でない run を **orphan として release する**
    > （`reap.ts:404-412`）ので、in-progress 集合から外れただけの open run は残らない。
    >
    > **本当に無期限に残るのは「cancel request が付いていて、停止の証拠が得られない run」**である。
    > reap は cancel request のある run を
    > **「cancel stop 証拠待ち」として skip する**（`reap.ts:342`）ため、
    > **exact-session stop 非対応 bridge の run は、reap も monitor も触らないまま open で残り続ける**。
    > **status で絞って探さないこと** — capability が無い場合、cancel stage は request を
    > 終端させず **`pending`（通常は `cooperative_sent`）のまま維持して escalate する**
    > （`cancel.ts:655-657`）。`failed` / `expired` だけを探すと、
    > **いちばん起きやすいケースを取り逃がす**。
    > **§50.2.3 と同じ構図である** — cancel request は finalize（`finalize.ts:1618`）だけでなく
    > **reap も閉じる**。「cancel request は非破壊」という読み方はここでも成り立たない。
    > **運用結論は変えない**（監視を「120分で必ず手が入る」前提で打ち切らない）が、
    > 疑う先は「in-progress から外れたか」ではなく **「cancel request が付いていないか」**である
  - 閾値は provider 別: codex 15分/120分、claude 45分/180分。
    **同じ `outputStallSeconds` が confirmed crash と警告の両方の時計を兼ねる。**
    **ただし同じ tick が全 in-progress run へ共有の `resourceGuard.maxRunSeconds`（未設定時 120分）も
    適用する**ため、**cancel の実効上限は min(provider 値, 120分) = 既定では両 provider とも 120分**である。
    claude は max runtime の 180分に届く前に共有 guard が cancel request を作る。**その cancel が実際に
    run を閉じた場合にだけ `run_stalled` が出ない**（閉じられなければ 180分で出る）
  - **したがって時間の読み分けはこうなる（ここが 2026-08-29 で変わった）**:

    | | codex | claude |
    |---|---:|---:|
    | 停滞を**知る**まで（inbox request の**判定閾値**） | **15分** | **45分** |
    | 停滞に**自動 cancel request が作られる**まで | 120分 | 120分 |

    **上段は判定閾値であって、通知が届く時刻の上限ではない。** 実通知は閾値到達後の
    **最初の monitor tick** で、supervisor が止まっていれば無期限に遅れる。
    加えて (a) session state が読める / (b) 進捗ソースを1つ以上継続観測できている /
    (c) monitor state（`state/monitor-direct.json`）が維持されている、が揃わない run では
    警告が出ないか大きく遅れる。**(c) は永続ファイルなので通常の再起動ではリセットされない** —
    リセットされるのは**ファイル全体が欠落・破損した場合に加え、その run の entry だけが
    欠落・不正な場合**で、そのとき停滞の実開始ではなく再観測時刻から計り直す。
    条件が欠けた run は**共有 guard の 120分まで何も通知されないことがある**。
    **下段も「止まる」ではなく「cancel request が作られる」である**（停止は §57.4/§57.5 の経路）。
    **さらに下段は無条件ではない** — 共有 guard の対象は `listInProgress()` かつ
    session ref を再構成できる task だけなので、**in-progress 集合から外れた open run には
    その 120分すら来ない**。「120分で必ず手が入る」を前提に監視を打ち切らないこと

  - `run_stalled` / `run_stall_suspected` はいずれも event・orchestrator request を
    **同一 transaction** で作る（`run_stalled` は §57.4 cancel request も同じ transaction。
    crash window は解消済み）。**停滞は inbox へ届く。** 停止に成功して task が終端すれば
    `task await` も発火する。**警告の発生と resolve それ自体では `task await` は発火しない**
    （警告は run を止めないため）が、**その後 task が終端すれば通常どおり発火する** —
    警告を受けても終端 watcher は張ったままにすること
  - **警告と cancel を分けた理由は実測である。** 正常終了した codex 429 run の最大無成長時間は
    最大 512秒 / p95 201秒 / 15分超 0件で、**15分閾値は観測最大の 1.76倍しかない**。
    誤検知しないことは示せても、**worker を殺す条件としては余裕が足りない**（`t_a37e99b4f9eb716c` #4055）。
    加えて `claude -p` は完了まで stdout へ何も書かないため、無成長だけで
    判定すると正常な run を誤って止める。**壊さないこと**（codex は `.out` が育つので事情が違う）
  - **したがって「supervisor が見ているから大丈夫」とは言えない。** ただし常時ポーリングはしない
    （§1.3「進捗確認のために繰り返し覗く行為は禁止」）。**トリガを決めた単発の診断**として行う:
    「実効上限の半分を超えて走っている」「ユーザーから照会があった」等。
    - direct: `state/direct-sessions/<sessionId>.out` の mtime とサイズ
    - provider / transport 非依存: worktree の `git status`（worker のトークンを消費しない）。
      **ただしこれは進捗の証拠ではない。** launch 時点のベースラインが無ければ、その dirty が
      worker 由来かどうか判別できない。逆に調査・テスト実行・設計中は tracked file が動かない。
      **使えるのは「触っているファイルが body の指定と合っているか」の確認まで**で、
      無変更を停滞の根拠にしない
    - bridge には `.out` が無いが、**bridge の stall 方針の正本は契約 §50.2**（`/api/messages` と
      §34 max-runtime に委ねる）である。playbook 側に独自の検知規律を作らない
- **direct レーン（§49 override）の注意**: G2 に映らない・worker は commit 不可 — 完走後は worktree の
  未コミット実装をオーケストレーターが検証の上、host-finalize で代行コミットする（reference §1.5 に合流）
- **bridge には max-runtime より前に発火する停滞検知が無い**（契約 §50.2 の正本方針）。
  `/api/messages` は診断材料であって検知機構ではない。旧版にあった「150秒間隔で観測し
  10分無増加で警告」という独自規律はここに置かない（契約と競合する）。
  必要になったら契約側を改訂してから playbook を合わせる
- 誤発火の自己検証: watcher が「想定より早く」戻ったら、まず単発クエリで実状態を確認（無言≠成功、即断≠真）
- **行動する自動化にはゲート必須**（2026-07-07 実害）: 「terminal を待って再投入」型のスクリプトで、
  ループ上限到達時に**そのまま行動へフォールスルーさせない**。行動直前に終端条件を単発再検証し、
  不成立なら何もせず終了する。上限フォールスルーで rework 走行中に再 ready → 同一 worktree に
  二重 run が併走し worktree が汚染された
- **steer 中断は best-effort**: worker が中断指示を「outcome=review で提出」と解釈することがある。
  中断後は finalize→review fail→**auto-rework の自動連鎖**まで想定し、body 差し替え・再投入の前に
  `task_runs` の open run が 0 件であることを確認する

#### セッション内容の参照は reactive 専用

- `hachi task logs` / `task show` / transcript を参照してよいのは、(1) worker-question を
  `orchestrator await` で claim した時、(2) `task await` が `needs-manual:` / `review-required:` で
  返った時の初回原因確認、(3) ユーザーから明示的な状況照会があった時、の3ケースだけとする
- 進捗確認のために繰り返し覗く行為は禁止する。worker が消費した出力を orchestrator が再読込する
  二重トークン消費となる。監視の正本は `task await --all --follow-new` と `orchestrator await`、stall 検知は
  supervisor 内蔵機構であり、セッション内容のポーリングで代替しない
- `--follow` は原則使わない。例外時はイベント起点・診断目的・終了条件を明記して時限実行する。
  `--tail 0` は既定40行で足りない原因調査だけに限定し、通常は必要最小の head/tail を読む

#### Durable cancel の観測とエスカレーション（contract §57.5）

- cancel は current open run に対して、担当 primary identity の active generation から
  `hachi task cancel <id> --reason <理由> --actor-kind orchestrator --orchestrator <id> --session <id>
  --generation <n>` で要求する。既定は60秒の cooperative grace。即時 force を明示する場合は
  `--force-if-supported`（grace後なら `--grace <sec>` と併用）を使い、exact-session stop capability が
  無ければ停止を推測しない
- 観測は `hachi task cancel-status <id> [--all]` を正とし、`task show` / `task logs` / `task await`
  にも同じ tri-state が出る。`cooperative_sent` は intent-before-effect のため delivered/observed/acknowledged
  の確証ではない。exact nonce ack がある時だけ acknowledged=yes、exact-session stop evidence がある時だけ
  stopped=yes と判断する
- failed/expired は run・worktree・resource・replacement gate を解除する証拠ではない。in-progressのままなら
  `task await` は待機を継続し、要対応wakeの正本は担当orchestrator inboxとする。Telegram は FYI であり、inboxで
  解決できない場合だけ fenced `orchestrator escalate` から人間へ上げる。taskが終端へ移った時の`task await`には
  latest cancel summaryが添付される
- exact-session stop未対応bridgeで、例外的にhostがbridge process generation全体を停止した場合は、先に同一serverUrlの
  他open runが0件であることと外部停止証拠を確認する。その後`hachi task cancel-host-stop ...`をまずdry-runし、表示された
  task/request/run/session/fence/process generationが停止対象と完全一致する時だけ`--confirm`で収束する。このコマンドは
  process停止機能ではなく証拠反映専用であり、通常のcancel失敗をbridge restartへ自動fallbackしてはならない
- Web の Durable cancel カードは読み取り専用。generic process kill、bridge restart、cancel mutation control は置かない

### 1.4 終端対応の分岐表

Web ボードの人間確認キューは対応主体別の2レーンに分かれる（core `humanQueueLaneOfReason`）:
**「あなたの判断待ち」** = `user-decision:` / `user-feedback:`（人間のみが解消できる）、
**「オーケストレーター回収待ち」** = `review-required:` / `needs-manual:` / `auto-launch-failed:` +
未知 prefix（fail-closed でこちらへ倒れる）。**回収待ちレーンは本表の該当行で必ずオーケストレーターが
捌く**（自分が起票したレーンの watcher に映らない流入 — import・他セッション起票 — があるため、
セッション開始時と定期健全性チェック時にこのレーンを一巡する）。

| 終端状態 | 標準対応 |
|---|---|
| **done** | **信用しない。**§2.1 の照合後に統合へ |
| user-decision（pass/medium） | 良性パターン確認（issues=0 かつ理由が「検証未再実行」のみ）→ orchestrator の独立検証で代替 → クローズコメント + `unblock --to done` → 統合 |
| review-required | 指摘**全文**を読む → 残件だけのピンポイント指示（「他は触らない」明記）を body 先頭に prepend → `unblock --to ready` |
| needs-manual（handoff 欠落） | transcript 末尾を確認。`Reached maximum number of turns` なら「⚠ 継続作業（ゼロから書き直さない・handoff 最優先）」を prepend → re-ready |
| auto-launch-failed | bridge 健全性（/api/sessions 応答・実セッション数）確認 → 一時飽和なら re-ready。再発は容量課題として起票 |
| **kind=session_budget** | `orchestrator await` で claim → request の `context` にある `recommendation` を読む。`handoff-at-boundary` なら次の区切りで、`handoff-now` なら直ちに引き継ぐ。`continue` なら継続する。対応後は `hachi orchestrator resolve <request-id> handled <理由> --session <id> --generation <n> --claim <token>` で閉じる（重複・期限切れなど判断対象でなければ `false_positive`）。`orchestrator answer` は受理されない。 |
| **needs-manual: launch-indeterminate**（2026-08-31〜） | **`auto-launch-failed` と読み分ける。「起動に失敗した」ではなく「起動したか分からない」である**（契約 §13.1/§34.1）。`POST /api/prompt` は 202 の非同期受理なので、client timeout はサーバ側の session 生成を止めない。<br>**⚠ 現時点で、この block を自分の判断で解除する手段は無い。escalate が標準手順である。** 理由は2つ:<br>**(a) run が無い。** dispatch は `launch()` が成功して初めて run を作る（reviewer / rework も同型）ので、timeout で block された task には open run が存在しない。**`task await` はこの件で二度と発火せず、外部 session が idle へ落ちても board 側には何も起きない。****`open run が0件` は当然であって、証拠にならない。**<br>**(b) 対象 session を同定できない。** C-1-b（`t_06c2376eef13ba4f`。2026-08-31 統合済み / main=`16555e5`）で **event に観測値が載るようになった** — `attemptedAt` / `probeCwd`（canonical）/ `probeProvider` / `candidateSessions[]`（`id` / `status` / `timestamp` / `startedAfterAttempt`）/ `probedAt` / `probeError`（契約 §34.1 の表が正本。**bridge endpoint だけは未記録**）。**⚠ event 名は3つある** — worker は `launch_indeterminate`、reviewer は `reviewer_launch_indeterminate`、rework は `rework_launch_indeterminate`。**1つの名前で探すと2経路を取り逃がす。**<br>**だが観測できることと同定できることは別である。** `candidateSessions` は**候補**であって当該 launch の session ではなく、`startedAfterAttempt: true` でも同一 cwd + provider へ別経路から起動された session を拾いうる。誤認した session の `idle` を根拠に re-ready すると、C-1-a が消したはずの重複起動が別経路で戻る。<br>**したがって: ① 状況（task / 上記いずれかの event の payload / worktree の `git status`）を task コメントへ記録する ② 人間へ上げる（下記）③ re-ready しない。cleanup（runtime resource の解放）も走らせない** — 生きている session が握っている可能性がある。<br>**⚠ `hachi orchestrator escalate` はこの block には使えない**（2026-08-31 実測）。`escalate` は `<request-id>` と `--claim <token>` を要求するが、**3つの catch site はどれも block と event を作るだけで orchestrator request を作らない**。使うのは reference §8 の階梯: **①セッション内でユーザーへ提示 → ②応答なし/離席なら `tg-notify`**。**`user-decision:` block への付け替えもしない** — それには `ready` を経由する必要があり、worker が誤起動する（§1.4 補足）。<br>**残っているのは確定判定の手段である。** launch idempotency key（`t_f5df7e728dda5d30`）が**未実装**なので、**この行を「`candidateSessions` を見て自分で re-ready を判断する」手順へ書き換えないこと。**`startedAfterAttempt` は三値で、**不明は `null`**（`false` へ丸めない） |
| worker-question | `orchestrator await` で claim → `task logs`/session を確認 → 自分で判断できれば fenced `orchestrator answer`。人間判断だけ `orchestrator escalate` |
| **run_stalled**（2026-08-29〜） | `orchestrator await` で claim → 停滞の実体を確認（direct なら `state/direct-sessions/<sessionId>.out` の mtime とサイズ、provider 非依存なら worktree の `git status`）→ **`orchestrator answer` / `escalate` は拒否される。`hachi orchestrator resolve <request-id> <handled\|false_positive> <reason> --session <id> --generation <n> --claim <token>` で閉じる**。`handled` = 実際に手を打った（cancel した・待つと決めた等）、`false_positive` = 停滞していなかった。**resolve は task 本文も worker session も変更しない** |
| **run_stall_suspected**（2026-08-29〜・警告専用） | **警告が出た時点では run は生きて走っていた。cancel request は作られていない。ただし claim 時点の状態は保証されない**（request は durable なので、その間に run が終端し replacement が起動していることがある）。`orchestrator await` で claim → request の `context`（警告 event payload の JSON 全体）に進捗ソース・無成長秒数・worktree 補助証拠が入っているので**まずそれを読む**。**context は発火時点のスナップショットであって現在状態ではない**（読んだうえで、進捗確認のための繰り返しの覗き見はしない）→ 判断を3つから選ぶ: ①**待つ**（`handled`。**ただし下の「1回きり」を読んでから**） ②**止める**（下の警告を読んでから。既定の手ではない） ③**誤検知**（`false_positive`。**警告時点でも停滞していなかった証拠がある場合だけ**。claim 後に進捗が再開した／自然終了したのは誤検知ではなく `handled`）。閉じ方は `run_stalled` と同じ `orchestrator resolve`。**resolve 自体は run を止めない**。<br>**⚠ 警告は同一 run につき1回きり。resolve は不可逆。** monitor は `stallSuspected` と既存 event で以後の警告を抑止するので、**止まったままでも二度と警告は来ない**。「様子を見る」を `handled` で閉じることは、**その run の唯一の durable な伝達路を自分で閉じる**ことである。**「待つ」を選ぶなら、いつ・何を見て・どうなっていたらどうするかを resolve の理由文に書き、その再確認の経路を張ってから閉じる**。<br>**⚠ 止めるなら fenced cancel だけを使う（2026-08-31 / main=`16555e5`）。** 素の `hachi task cancel <taskId>` は worker の run/session を取らず `getLatestOpenRun()` を対象にする（`--session` は**操作主体の orchestrator session** であって worker session ではない）ので、**replacement を誤って止める**。**必ず `--expect-run <runId>` / `--expect-session <workerSessionId>` を付ける**（少なくとも一方が必須）。Store の同一 transaction 内で current open run と照合され、不一致・open run 不在なら **mutation を一切行わず** `targetMatched: "no"` / exit 1 で終わる。**TOCTOU はこの経路では消えている。** 識別子は `runId` が `questionId` の `run-stall-suspected:<runId>:<sessionId>`、`sessionId` が request の `context`、現況は `task show` の `currentRun` から取れる。**ただし「狙って止められる」は「止まった」ではない** — 停止の確証は §57.4/§57.5 の経路であり、exact-session stop 非対応 bridge では `cooperative_sent` のまま確認できない。<br>**警告対象の run が既に終了・置換されていたら `handled`**（理由に `target run already ended or replaced; cancel skipped` 相当を残す）。**`false_positive` にしない** — それは「停滞していなかった」の意味で、閾値評価と監査を歪める |
| user-question | 人間回答待ち。Telegram 等の回答は worker へ直送されず request inbox に戻るため、再 claim して解釈後 `orchestrator answer` |

補足: 手動で user-decision block を作る場合、**block は ready からのみ**（triage/todo→blocked は state machine が拒否）。
`task move --to ready` → `task block --reason "user-decision: ..."` の順。

回収待ちから再ready化する直前は、所有identity/bindingを確認したうえでopen runが0件であることを
正規CLI/read viewから再確認する。bridge sessionがactive、またはstatus確認不能ならreplacementを起動しない。
`session_ended`や`worker_output_missing`の通知だけを、同一worktreeへ次runを起動してよい証拠にしない。

## 2. 品質規律

### 2.1 done 照合（必須）
done を見たら統合前に必ず:
```sql
SELECT json_extract(meta,'$.verify.status'), substr(json_extract(meta,'$.lastResult.durationMs'),1,8)
FROM task_runs WHERE task_id='t_xxx' ORDER BY id DESC LIMIT 1;
```
- verify が必要 tenant なのに evidence が無い / handoff summary がテンプレ文字列（`<作業内容の要約>` 等）/
  実行時間が不自然に短い → **偽 done を疑い、担当worker/reviewerへworktreeの実体確認を依頼する**。
  親による詳細再調査へ切り替えない（§0.1。2026-07-07 に偽doneが3件発生した実績）
- 「done の山」が急にできたら特に疑う（依存ゲートの誤解放が連鎖する）

### 2.3 検証の代替不可原則
- reviewer の pass/medium が検証不足による場合は、同一候補の既存実測を照合する。不足する必須検証は
  検証担当へ割り当て、結果とテスト数を記録する。親の再レビュー・成功済みテストの再実行で代替しない（§0.1）。
- UI は jsdom テストでは担保できない — 実ブラウザ実測（worker）+ スクショ判定（orchestrator）の二重

## 5. 定期健全性チェック（再起動後・長時間セッション開始時）

```bash
launchctl list | grep -E "hachi-kanban|even"   # supervisor/watchdog/web/bridge の PID
for p in 9131 3456 3457; do lsof -nP -iTCP:$p -sTCP:LISTEN -t >/dev/null && echo "$p OK"; done
curl -s -o /dev/null -w "9443:%{http_code}\n" https://<your-host>.<your-tailnet>.ts.net:9443/api/board
python3 -c "import json,time; d=json.load(open('$HOME/.hachi-kanban/state/supervisor-heartbeat.json')); print('heartbeat', round(time.time()-d['ts']), '秒前')"
hachi orchestrator usage-profile refresh  # 月次相当で係数を更新
git -C ~/develop/private/hachi-kanban worktree list   # prunable が無いか
git -C ~/develop/private/hachi-kanban status --short  # 見覚えのない dirty が無いか
```
