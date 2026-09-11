---
name: hachi-kanban-orchestrator-bootstrap
description: Create a new hachi-kanban orchestrator from a natural-language request, including stable identity registration, a todo mission task, and a primary subtree watch, then print the commands for starting the Claude session in a new pane. Use when the user asks to "新しいオーケストレーターを立てて", "オーケストレーター作って", "別プロジェクト用のオーケストレーターを用意して", or gives an equivalent responsibility/bootstrap request.
---

# Hachi Kanban Orchestrator Bootstrap

自然言語の依頼を、担当範囲が board に残るオーケストレーターの立ち上げへ変換する。現行セッションでは identity、ミッション task、subtree watch までを作り、新しい Claude ペインで実行する session 開始と監視コマンドを、そのまま貼れる形で出力する。

## 依頼から確定する値

次の値を mutation 前に確定する。不明な値がある場合は一度だけ質問し、推測したまま登録を始めない。

- `label`: stable identity の責務名。新規オーケストレーターの意図なら、既存 label を黙って再利用しない。
- `project`: identity に保存するプロジェクト表記。依頼文の表記を保持し、既存 identity の表記を勝手に正規化しない。
- `cwd`: 起動・handover 用の絶対パス。存在する directory を指定する。
- `tenant`: mission task の `--tenant`。依頼または現在の board の運用値から確定する。不明なら確認する。
- mission の title/body: body の1行目は必ず `cwd: <絶対パス>` とし、その後に目的、担当範囲、完了条件を短く書く。

## 実行順序と fail-closed 事前検査

以下の順序を守る。事前検査のどれかに失敗したら `register`、task create、watch add を一つも実行せず、失敗理由と必要な入力だけを返す。

1. `cwd` が `/` で始まる絶対パスで、handover の `cwd-usable` と同じく `stat` で実在する directory であることを確認する。`mkdir` や別の directory の自動作成はしない。
2. `cwd` を read-only の Git probe に渡し、`git -C <cwd> rev-parse --path-format=absolute --git-common-dir` を取得する。Git common-dir を解決できなければ、register が失敗する前に停止する。
3. `hachi orchestrator list --json` を register より先に一度取得し、JSON envelope の
   `orchestrators[].orchestrator` に入っている `label`、`project`、`repoCommonDir` を比較する。
   `orchestrators[]` 直下ではなく、必ず内側の `orchestrator` object を読む。想定した envelope や
   3 フィールドが無い場合は、既存 identity を見落とさないよう fail-closed で停止する。
   - 同じ `(label, project, repoCommonDir)` があれば、register は冪等に既存 identity を返す。新規依頼では「既存 identity があるため作成しない」と明示して停止し、別の label を求める。既存へ黙って task/watch を相乗りさせない。
   - 同じ `repoCommonDir` に別の `project` 表記の identity があれば、表記ゆれの warning を出すだけで停止しない。既存 identity の project は変更しない。

この事前の list 結果を created/reused 判定の根拠にする。`createdAt` と現在時刻の差から判定しない。競合で register の返却 identity が事前 snapshot に存在した場合は、reused と明示して mission 作成前に停止する。

## task create に渡す操作主体の provenance を解決する

構造化 actor provenance を渡せるのは、現行 CLI では `task create` だけである。`orchestrator register`
と `orchestrator watch add` は `--actor-kind`、`--session`、`--generation` などの actor flags を受理しない
ため、これらへ provenance 引数を付けない。CLI を本タスク内で拡張したり、unknown 主体を避けるために
別の引数を捏造したりしない。

これから立てる identity を操作主体として使ってはいけない。`--bind-orchestrator` は mission の担当先を
指し、下記の `--orchestrator` は `task create` を呼び出している主体を指す。

1. 呼び出し元の Claude session id を得る。まず `$CLAUDE_CODE_SESSION_ID` を使う。空または未設定なら、
   呼び出し元自身の transcript パス `~/.claude/projects/<proj>/<uuid>.jsonl` の basename から `.jsonl` を
   除いた `<uuid>` を使う。現在の transcript パスを一意に特定できない、形式が違う、または session id を
   得られない場合は、human へ黙って fallback せず、ここで停止する。
2. `hachi orchestrator list --json` を読み、JSON envelope として `orchestrators[]` が配列であることを
   検証する。各要素の内側の `.orchestrator` と `.liveSession` を読み、**直下の label/project/id や別の
   表示文字列を代用しない**。`liveSession.providerSessionId` が呼び出し元の session id と一致する
   identity を探す。
3. 一致する identity が1件見つかった場合、内側の値から次の actor args を作る。`id`、`liveSession.id`、
   `liveSession.generation` のいずれかが欠落・不正、または複数 identity が一致した場合は判定不能として
   停止する。

   ```text
   ACTOR_ARGS=(--actor-kind orchestrator --orchestrator <caller_orchestrator.id> \
     --session <caller_liveSession.id> --generation <caller_liveSession.generation>)
   ```

4. 有効な list 結果で一致する identity が0件なら、素の Claude session からの呼び出しと判断し、次だけを
   actor args とする。

   ```text
   ACTOR_ARGS=(--actor-kind human)
   ```

   `--author` だけでは provenance にならない。`--actor-kind human` に orchestrator/session/generation を
   併記してはいけない。list の失敗、JSON envelope/必須フィールドの欠落、session id の判定不能は「一致0件」
   ではないため、human fallback せず fail-closed で停止する。

`ACTOR_ARGS` は `task create` **だけ**へ展開する。`task create` の help に必要な principal flags が無い場合は、
unknown 主体の event を残す代替を選ばず、mutation 前に CLI gap として停止する。`register` と `watch add` に
principal flags が無いことは現行 CLI の仕様であり、この skill ではそれを理由に停止しない。

## 現行セッションで行う mutation

事前検査をすべて通過した後だけ、次の順で実行する。各 JSON 出力から ID を取り出し、次のコマンドへ渡す。

1. identity を登録する。

   ```bash
   hachi orchestrator register \
     --label "<label>" --project "<project>" --cwd "<絶対パス>" \
     --json
   ```

   事前 list に同一キーが無かった場合は「新規作成」、あった場合は「既存を再利用」と必ず報告する。既存を再利用する分岐は、ユーザーが明示的に再利用を選んだ場合だけに限る。

   現行 CLI の `register` は新規 identity に provider-less の active placeholder session と worktree watch を同時に作る。新規 register の JSON に返った `session.id`、`session.generation`、`session.provider`、`session.providerSessionId` を確認し、provider と provider session id が空の、その register が作った placeholder だけを次で閉じる。

   ```bash
   hachi orchestrator session close <bootstrap-session-id> \
     --generation <bootstrap-generation> --json
   ```

   既存 session、provider が設定された session、generation が一致しない session は閉じない。placeholder だと安全に確認できない場合は停止して報告する。この補助をしないと、後で新ペインから `session start` を実行したときに active session 衝突になる。

2. mission task を `todo` で作る。`ready` にはしない。worker を誤起動させないため、execution profile/provider/model の指定もここでは加えない。

   ```bash
   hachi task create \
     --title "<mission title>" \
     --body $'cwd: <絶対パス>\n\n目的: <目的>\n担当範囲: <範囲>\n完了条件: <条件>' \
     --tenant "<tenant>" --status todo \
     --bind-orchestrator <new_orchestrator_id> \
     "${ACTOR_ARGS[@]}" --json
   ```

   body の先頭行は handover の起動 cwd の正本である。`--bind-orchestrator` は担当 identity を固定する指定であり、
   操作主体を表す `ACTOR_ARGS` 内の `--orchestrator <caller_orchestrator.id>` と混同しない。返った task id を
   `mission_task_id` として記録する。

3. mission の担当範囲を subtree watch で宣言する。

   ```bash
   hachi orchestrator watch add \
     --orchestrator <new_orchestrator_id> --scope subtree \
     --selector <mission_task_id> --role primary --json
   ```

   `watch add` の `--orchestrator <new_orchestrator_id>` は watch の所有者を指定するためのものであり、
   **操作主体の provenance ではない**。現行 CLI が `watch add` に actor flags を受理しないため、呼び出し元
   identity の `--actor-kind`、`--session`、`--generation` は付けない。これが handover の `mission-identity`
   preflight と `--mission` 自動解決の根拠になる。
   identity に既定で作られる worktree watch と、この mission subtree watch は別物として残す。

## 監査証跡の検証と後始末

probe で task を作った直後に、board の event を読み、表示用 `actor` ではなく構造化 provenance を検証する。

```bash
hachi task show <mission_task_id> --events 50 --json
```

`eventType == "task_created"` を1件選び、`provenance.kind` が `orchestrator` または `human` であることを確認する。
`unknown`、task event の欠落、複数候補、または orchestrator の `actorId` / `actorSessionId` /
`actorGeneration` の欠落は検証失敗として扱い、成功と報告しない。actor args を1行外した回帰 probe はこの検査が
実際に失敗することまで確認する。session id の一致が0件の human fallback も1回実行し、`kind=human` と session /
generation が空であることを確認する。session id または list JSON の判定不能 probe は、mutation コマンドを一度も
呼ばずに停止し、before/after の task 件数が変わらないことを確認する。

probe 後は作成した mission task を `archived` へ遷移し、追加した mission watch を提供された削除経路で削除する。
CLI が削除経路や provenance flags を提供しない場合は CLI gap として停止・報告し、inactive 化や raw SQL を削除完了の
代わりに扱わない。identity は残してよい。

## 新しいペインへ出力するもの

現行セッションでは `session start` を実行しない。provider session id はこれから起動する Claude セッション自身の id であり、現行セッションからは知り得ないためである。placeholder session を閉じた後、次の4点セットを値を埋めずに欠落させず、貼れる形で出力する。

```bash
# 新しいペインの Claude セッションで実行する
# 自分の session id は ~/.claude/projects/<proj>/<uuid>.jsonl の <uuid>
hachi orchestrator session start <o_id> --provider claude --provider-session-id <uuid> --json
hachi-orch-enable <uuid>
while true; do hachi orchestrator session heartbeat <os_id> --generation <n> >/dev/null; sleep 30; done &
hachi orchestrator await --session <os_id> --generation <n> --json
```

`session start` の JSON 出力から `os_id = session.id` と `n = session.generation` を読み、heartbeat と await の両方へ同じ値を入れる。heartbeat は専用 background process、await は別プロセス（上の例では foreground）にする。

これは playbook §0.7.3.2 の4点セットである。session start の provider session id 登録、`hachi-orch-enable`、30秒 heartbeat、inbox await のどれか一つでも欠けると、provider session id 未登録による計測 fail-open や 90秒 stale 化、inbox 未監視を見逃す。await を heartbeat の代わりにしない。

新しいセッションの立ち上げ後、引き継ぎは `HHN --orchestrator <o_id> --apply` を使う。必要な判断・preflight・詳細手順は `runbooks/orchestrator-playbook.md` §0.8 と §0.7.3.2 を正本として参照し、内容をこの skill に複製しない。

## host に依頼する install

この repo の `skills/hachi-kanban-orchestrator-bootstrap/SKILL.md` を版管理の実体とし、host が安定した
main checkout から次の symlink を一度だけ設置する。`~/.hachi-kanban/worktrees/` 配下の一時 worktree
をリンク先にしてはいけない。worker は `~/.claude` 配下を書き換えない。

```bash
mkdir -p ~/.claude/skills
ln -s <repo-root>/skills/hachi-kanban-orchestrator-bootstrap ~/.claude/skills/hachi-kanban-orchestrator-bootstrap
```

上の `<repo-root>` は host の安定した main checkout を指す。
配置が異なる host では、同じ repo の安定した checkout に置き換えるが、現在の worktree の絶対パスは使わない。
既存の同名 path がある場合は、リンク先を read-only に確認してから host が判断する。既存 skill を上書きしたり、`.gitignore` を変更したりしない。
