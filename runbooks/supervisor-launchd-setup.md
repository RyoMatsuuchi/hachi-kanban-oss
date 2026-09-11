# Supervisor launchd セットアップ

> **前提: macOS 専用。** この手順書は launchd（`launchctl` / LaunchAgent / `plutil`）に
> 依存します。Linux では使えません。Linux で常駐させる場合は plist を使わず、
> `pnpm --filter @hachi/supervisor run start -- --interval 30 --apply` を systemd user unit
> などの各 OS の常駐機構に載せてください（このリポジトリはその unit を同梱しません）。
> 常駐化の前に、`docs/portable-install.md` §5 の foreground smoke を通してください。

## 概要

`packages/supervisor` は 2 つの起動モードを持つ（`docs/contract.md` §10）。

- `--once --apply`: 1 tick（dispatch → monitor → finalize → messages → reap
  の順で全ステージ実行）して終了する短命プロセス。
- `--interval <sec> --apply`（`--once` なし）: 常駐プロセス。setTimeout ベー
  スの async ループで tick を逐次実行し、tick の重なりを防止する
  （`packages/supervisor/src/supervisor.ts` の `startLoop` / `runGuarded`、
  `docs/contract.md` §12.9-2）。SIGTERM / SIGINT を受けると進行中の tick を
  完了させてから graceful に終了する（`stop()`）。

### 常駐方式: KeepAlive + 内部ループ（現行）

実機 e2e で `StartInterval` によるポーリング起動が **自然発火しない**不具合
が確定した。`launchctl print` は `pended nondemand spawn = interval` のまま
tick が進まず、`launchctl kickstart` で明示的に起動しない限り実行されなかっ
た。

原因調査の結果、これは supervisor 固有の設定不備ではなく、**launchd の GUI
セッションドメイン（`gui/<uid>`）が「on-demand-only mode」に入っている間は
StartInterval・RunAtLoad・KeepAlive による自動再起動など、あらゆる
non-demand（受動的）トリガーが一切スポーンされない**という、その端末の
セッション状態に起因する挙動であることが判明した（作者の macOS 環境で観測。
再現条件は OS バージョンやセッション状態に依存するため、全環境で起きるとは限らない。
詳細は本ファイル末尾の
「既知の制約: on-demand-only mode」参照）。`launchctl kickstart` のような
明示的（on-demand）トリガーだけがこのゲートを通過できる。

この制約下では「tick のたびに launchd が新規プロセスをスポーンする」設計
（StartInterval 方式）は毎回ゲートに阻まれるリスクがある。そこで常駐方式を
**KeepAlive + supervisor 内部の逐次ループ**に変更した。

- 起動コマンド: `pnpm --filter @hachi/supervisor run start -- --interval 30 --apply`
  （`--once` を付けない）
- plist: `KeepAlive=true` / `RunAtLoad=true`。`ProcessType` は指定しない
  （既定 Interactive/Standard 相当。旧テンプレートの `Background` 指定は
  タイマー抑制の疑いがあったため外した）。
- 一度プロセスがスポーンしてしまえば、以降の tick は Node.js の
  `setTimeout` による**プロセス内部の**タイマーで駆動される。launchd の
  non-demand トリガーには一切依存しないため、on-demand-only mode の影響を
  受けない（実機で 30 秒間隔・7 tick・3 分超の自然継続を確認済み。後述）。
- KeepAlive はプロセスが予期せず落ちた場合の自動再起動用。ただし
  re-spawn 自体も non-demand トリガーなので、落ちたタイミングでドメインが
  on-demand-only mode だと再起動が遅延する可能性がある（「既知の制約」参照）。

- 状態ディレクトリ: `$HACHI_KANBAN_HOME`（既定 `~/.hachi-kanban`）
  - DB: `$HACHI_KANBAN_HOME/boards/<board>/kanban.db`
  - kill-switch: `$HACHI_KANBAN_HOME/supervisor.disabled`（全ステージ停止）、
    または `$HACHI_KANBAN_HOME/<stage>.disabled`（`dispatch` / `monitor` /
    `finalize` / `messages` / `reap` の個別停止）。**プロセス再起動不要**
    で次 tick から即座に反映される（実機確認済み、後述）。
  - アプリログ（JSONL）: `$HACHI_KANBAN_HOME/logs/supervisor.jsonl`
    - 常駐ループでは tick ごとに `stage completed` / `stage skipped
      (kill-switch)` がステージ数分（5 件）出力される。`--once` 時にだけ
      出る `single tick完了` サマリ行は常駐ループには出ない。
    - ループ開始時に `supervisor start`（`intervalSec` 付き）、SIGTERM /
      SIGINT 受信時に `supervisor shutdown`（`signal` 付き）が出る。
    - size-based rotation: 現行ファイルが閾値（既定 50MB）を超えると、次の
      書き込み前に `supervisor.jsonl.1`（さらに古い世代は `.2`, `.3`...）へ
      退避される。現行ファイル名は変わらないため、既存の `tail`/`grep` 手順
      はそのまま使える。より古い事象を探す場合だけ `.1`/`.2`... も対象に
      含める。閾値・保持世代数は `config.json` の任意 `logging` セクション
      （`maxSizeBytes` / `maxGenerations`）で上書きできる（既定は core の
      `DEFAULT_LOG_ROTATION_CONFIG`）。`hachi doctor` の `log rotation` 項目
      で現在のサイズ・世代数と閾値超過の有無を確認できる。`logging` セクションは
      supervisor 起動時に一度だけ読み込まれるため、変更を反映するには
      `supervisor` の再起動（launchd 経由なら `launchctl kickstart -k`）が必要
      （tick 単位のホットリロードは対象外）。
- launchd ログ（stdout/stderr）: `$HACHI_KANBAN_HOME/logs/supervisor.launchd.log`
  / `$HACHI_KANBAN_HOME/logs/supervisor.launchd.err`

## ProgramArguments の方式について

生成済み plist は renderer が検証した `pnpm` の絶対パスを
`ProgramArguments` に直接指定し、`/bin/zsh -lc '...'` のようなログインシェル
経由の起動はしない。checked-in template には端末固有 path を置かない。

理由:

- `pnpm` は `pnpm.cjs` を `#!/usr/bin/env node` shebang で起動するコマンドだ
  が、`EnvironmentVariables` に最小 `PATH` を渡すだけで shebang 経由の
  `node` 解決・`pnpm --filter ... run start` の実行まで問題なく動くことを、
  launchd 相当の最小環境
  （`env -i PATH=... HOME=... <resolved-pnpm> --filter @hachi/supervisor
  run start -- --interval 30 --apply`）で実機確認済み。
- `zsh -lc` はログインシェルで `.zshrc` / `.zprofile` を読み込むため、対話
  シェル側の設定変更（alias、PATH 追加等）が launchd 実行結果に意図せず影
  響する余地がある。絶対パス直接指定の方が再現性が高く、
  `runbooks/templates/` 配下の 4 テンプレート（supervisor / web / backup /
  watchdog）で流儀が揃う。

pnpm や node が通常の `PATH` に無い場合は `HACHI_PNPM_BIN` / `HACHI_NODE_BIN`
に executable の絶対パスを渡して renderer を実行する。template や生成済み
plist を手編集して clone path を合わせる運用には戻さない。

## template の生成（全 LaunchAgent 共通・必須）

`runbooks/templates/*.plist` は source template であり、そのままでは plist ではない。
repository root で次を実行し、端末固有 path を XML escape した生成物を state root に置く。

```bash
render_dir="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/generated-launchd"
mkdir -p "$render_dir"

# まず dry-run。resolved path と4ファイルのhashだけを表示する
node scripts/render-launchd.mjs

# 生成先を明示したときだけ書く。live LaunchAgents への直接出力は拒否される
node scripts/render-launchd.mjs --output-dir "$render_dir" --force

for plist in "$render_dir"/*.plist; do
  plutil -lint "$plist"
done
```

renderer は clone root、user home、state root、Node/pnpm、launchd `PATH` を解決し、
未解決 placeholder、未知 placeholder、非実行可能 toolchain を fail-closed で拒否する。
`--launchd-path` / `HACHI_LAUNCHD_PATH` を渡さない場合、plist へ埋まる `PATH` は
`dirname(node)`、`dirname(pnpm)`、`~/.local/bin`、`~/.local/share/pnpm`、
`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` を重複排除した並び
（`scripts/render-launchd.mjs` の `resolveRenderConfig`）。version manager 配下の
Node/pnpm を使う端末では、その bin directory が先頭に入るため追加指定は不要。
`HACHI_KANBAN_BOARD`、`HACHI_KANBAN_WEB_PORT`、bridge URL / token file path などの
端末固有値は shell environment から生成物へ渡す。secret **value** は渡さない。
remote bridgeはHTTPSと`HACHI_BRIDGE_ALLOW_REMOTE=1`を両方要求する。token fileは現在user所有の
0400/0600 regular fileにし、symlinkやgroup/other permissionを残さない。

## インストール手順

```bash
render_dir="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/generated-launchd"
mkdir -p "$HOME/Library/LaunchAgents"
plutil -lint "$render_dir/com.hachi-kanban.supervisor.plist"
/usr/bin/install -m 0644 "$render_dir/com.hachi-kanban.supervisor.plist" \
  "$HOME/Library/LaunchAgents/com.hachi-kanban.supervisor.plist"
plutil -lint ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist

launchctl bootout "gui/$(id -u)/com.hachi-kanban.supervisor" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist
launchctl print "gui/$(id -u)/com.hachi-kanban.supervisor"
```

`RunAtLoad=true` なので、GUI ドメインが interactive な状態であれば
`bootstrap` 直後に自動スポーンする。ただし後述の on-demand-only mode に
ドメインが入っている場合は自動スポーンされないため、`launchctl print` の
`state` が `running` になっているか必ず確認すること。`not running` の
ままなら次項の kickstart で初回起動する。

## 即時起動・動作確認（初回 / on-demand-only mode 時）

```bash
launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl print "gui/$(id -u)/com.hachi-kanban.supervisor" | grep -E "state|pid|runs"
tail -20 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.launchd.log"
tail -5 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.launchd.err"
tail -20 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.jsonl"
```

`state = running` かつ `pid` が付いていれば起動成功。`supervisor.jsonl` に
`supervisor start`（`intervalSec: 30`）が出て、以降 30 秒ごとに 5 件の
`stage completed`（各ステージ）が並ぶ。ボードが空の間は各ステージ
`actions: 0` の no-op になる（apply 経路自体は通っており、`skipped` は
false）。

**重要**: 一度 `state = running` になれば、以降の tick は launchd の再スポー
ンに依存しない（プロセス内部の `setTimeout` ループで駆動される）。
`kickstart` が必要なのは「プロセスがまだ 1 つも起動していない」瞬間
（初回 bootstrap 直後、または後述の緊急停止からの復帰直後）に限られる。
tick ごとに `kickstart` を打つ必要は一切ない。

### 実機検証結果（自然発火の実証, 2026-07-02）

KeepAlive 化後、初回スポーンのみ `kickstart` で起動し、以降は
**追加の `kickstart` を一切行わずに** `supervisor.jsonl` の tick ログを
3 分超・7 tick 連続で観測し、30 秒間隔が厳密に維持されることを確認した
（プロセス内部ループが launchd の non-demand トリガーに依存せず自律的に
動作することの実証）。

```
10:48:07.944Z  supervisor start (intervalSec=30)
10:48:37.968Z  tick 1  stage completed x5
10:49:08.003Z  tick 2  stage completed x5   (+30.035s)
10:49:38.008Z  tick 3  stage completed x5   (+30.005s)
10:50:08.012Z  tick 4  stage completed x5   (+30.004s)
10:50:38.015Z  tick 5  stage completed x5   (+30.003s)
10:51:08.019Z  tick 6  stage completed x5   (+30.004s)
10:51:38.022Z  tick 7  stage completed x5   (+30.003s)
```

（上記は UTC。JST は +9h: 19:48:07 〜 19:51:38）。`launchctl list` は
この間 PID 付き（例: `4754  0  com.hachi-kanban.supervisor`）で常駐状態
を維持していた。

## kill-switch の動作確認

```bash
touch "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/supervisor.disabled"
tail -6 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.jsonl"
# -> 次 tick（最大 interval 秒後）で 5 ステージ全て
#    "stage skipped (kill-switch)" になっていること（プロセス再起動不要）

/bin/rm -f "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/supervisor.disabled"
tail -6 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.jsonl"
# -> 次 tick で "stage completed" に戻ること（こちらもプロセス再起動不要）
```

KeepAlive 化前（`--once` + StartInterval）はプロセスが tick ごとに起動・
終了するため kill-switch 確認に `kickstart` が必要だったが、常駐化後は
ファイルの有無を毎 tick 内部でチェックする（`isDisabled()`）だけなので、
`kickstart` も再起動も不要になった。実機確認済み（`touch` から次 tick
まで 30 秒以内に 5 ステージ skip、`rm` から次 tick までに 5 ステージ
completed に復帰、PID は一貫して同一）。

`rm` を alias（`rm -i` 等）で上書きしている shell profile では、対話プロン
プトが出て削除がスキップされることがある。スクリプトや自動化からは
`/bin/rm -f` を使うこと。

個別ステージのみ止めたい場合は `$HACHI_KANBAN_HOME/<stage>.disabled`
（`dispatch` / `monitor` / `finalize` / `messages` / `reap`）を使う。

## graceful stop の確認

```bash
launchctl bootout "gui/$(id -u)/com.hachi-kanban.supervisor"
tail -3 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.jsonl"
# -> "supervisor shutdown" (signal=SIGTERM) が出て、プロセスが終了している
#    こと（ps / launchctl list で確認）。KeepAlive による無限再起動ループ
#    は発生しない（bootout はジョブ登録自体を解除するため）。
```

`bootout` は launchd がジョブに SIGTERM を送り、supervisor 側の
`process.on("SIGTERM", ...)` が進行中の tick を待ってから `stop()` →
`store.close()` → `process.exit(0)` する（`packages/supervisor/src/main.ts`）。
実機確認では bootout から 1 秒未満で `supervisor shutdown` ログが出てプロ
セスが消えることを確認した（tick が進行中でなかったため）。tick 実行中に
bootout した場合は、その tick の完了を待ってから終了するため、数秒〜長い
ステージ処理中はやや時間がかかる想定（`exit timeout` は plist の既定
5 秒だが、実装側は tick 完了を待ってから自発的に `exit(0)` するため通常は
それより早く終わる）。

再開する場合は「インストール手順」の bootout/enable/bootstrap を再実行し、
`state = running` になっているか確認する。on-demand-only mode 中は
`RunAtLoad` が効かず `not running` のままになるため、その場合は
「即時起動・動作確認」の `kickstart` を 1 回実行して常駐状態に戻す。

## 緊急停止

```bash
touch "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/supervisor.disabled"
launchctl disable "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl bootout "gui/$(id -u)/com.hachi-kanban.supervisor" 2>/dev/null || true
```

再開:

```bash
/bin/rm -f "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/supervisor.disabled"
launchctl enable "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist
launchctl print "gui/$(id -u)/com.hachi-kanban.supervisor" | grep -E "state|pid"
# not running のままなら:
launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.supervisor"
```

## 完全停止（アンインストール）

```bash
launchctl disable "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl bootout "gui/$(id -u)/com.hachi-kanban.supervisor" 2>/dev/null || true
/bin/rm -f ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist
```

## plist 修正後の reload

```bash
plutil -lint ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist
launchctl bootout "gui/$(id -u)/com.hachi-kanban.supervisor" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.hachi-kanban.supervisor"
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hachi-kanban.supervisor.plist
launchctl print "gui/$(id -u)/com.hachi-kanban.supervisor" | grep -E "state|pid"
# not running のままなら kickstart -k で初回起動（上記参照）
```

## 状況確認

```bash
launchctl list | grep com.hachi-kanban.supervisor
launchctl print "gui/$(id -u)/com.hachi-kanban.supervisor"
tail -50 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.launchd.log"
tail -50 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.launchd.err"
tail -50 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/supervisor.jsonl"
```

`launchctl list` の出力は `PID  status  label` の順。常駐化後は
**`PID` が数値で入っているのが正常状態**（KeepAlive 常駐プロセス）。
`-` になっている場合はプロセスが落ちている（クラッシュ後の再スポーン待ち、
または on-demand-only mode でスポーンが保留されている）ので、
`supervisor.jsonl` / `supervisor.launchd.err` を確認し、必要なら
`launchctl kickstart -k` で復帰させる。`status` 列は直近終了時の exit
code（`0` が正常終了、プロセスが稼働中は前回値のまま）。

## 既知の制約: on-demand-only mode

一部の macOS 環境では、`gui/<uid>` launchd ドメインが断続的に
「on-demand-only mode」という状態に入る（`log show` で
`launchd: [gui/<uid> [...]:] pending spawn, domain in on-demand-only mode: <label>`
として観測できる。`<uid>` は `id -u` の値）。この間
は launchd の non-demand（受動的）トリガー——`StartInterval`、
`RunAtLoad`、KeepAlive によるクラッシュ後の自動再起動——が一切実行され
ない。`launchctl kickstart` のような on-demand（明示的）トリガーだけが
このゲートを通過してプロセスをスポーンできる。

macOS 標準の Apple 製 LaunchAgent（`com.apple.FolderActionsDispatcher`、
`com.apple.Siri.agent` 等）も同じログで on-demand-only mode の影響を受け
ているのが確認できるため、supervisor 固有の設定不備ではなく、その端末
のセッション状態（スクリーンロック / 非対話セッションの継続時間等が有力）
に起因する OS レベルの挙動と考えられる。自分の端末で起きているかどうかは、
上記の `log show` の行が出るかで判別する。

**この制約下での運用上の意味**:

- 常駐プロセスが一度スポーンしてしまえば、それ以降の tick は
  プロセス内部の `setTimeout` ループで駆動されるため on-demand-only mode
  の影響を受けない（本ファイル「実機検証結果」参照）。KeepAlive + 内部
  ループ方式が StartInterval 方式より本質的に堅牢なのはこのため。
- ただし以下のタイミングでは on-demand-only mode の影響を受けうる:
  - 初回 `bootstrap` 直後の `RunAtLoad` によるスポーン
  - プロセスがクラッシュした場合の KeepAlive による自動再起動
  - `bootout` → `bootstrap` による明示的な再起動
- 上記のいずれでも `state` が `not running` のまま変わらない場合は、
  `launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.supervisor"`
  を 1 回実行すれば即座にスポーンする（on-demand トリガーのため
  on-demand-only mode でも通る）。「状況確認」の手順で定期的に
  `state` / `pid` を確認し、`not running` に気づいたら kickstart で
  復帰させる運用とする。
- 恒久対処（要検討・未実施）: LaunchDaemon 化（システムコンテキストで
  GUI セッションドメインのゲートを受けない）、あるいは端末の
  スクリーンロック・省電力設定の見直し等が候補だが、いずれも本タスクの
  スコープ外（`hachi-kanban` の src 変更なし、他システムへの影響なし、
  の制約下）のため見送り、運用上の回避策として上記の kickstart 復帰手順
  を採用する。

## Web LaunchAgent セットアップ

foreground の `pnpm web` と `hachi doctor` が通った後、同じ生成 directory の
Web plist を明示 install する。

```bash
render_dir="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/generated-launchd"
mkdir -p "$HOME/Library/LaunchAgents"
plutil -lint "$render_dir/com.hachi-kanban.web.plist"
/usr/bin/install -m 0644 "$render_dir/com.hachi-kanban.web.plist" \
  "$HOME/Library/LaunchAgents/com.hachi-kanban.web.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.hachi-kanban.web.plist"

launchctl bootout "gui/$(id -u)/com.hachi-kanban.web" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.hachi-kanban.web"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.hachi-kanban.web.plist"
launchctl print "gui/$(id -u)/com.hachi-kanban.web"
```

生成時の `HACHI_KANBAN_WEB_PORT` が plist に固定される。変更時は renderer を
再実行して plist を reload する。`not running` の場合は supervisor と同様に
`launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.web"` で初回起動する。

## バックアップ launchd セットアップ

`hachi admin backup [--keep <n>]`（既定 keep=14、`docs/contract.md` §19）は
better-sqlite3 の backup API で `$HACHI_KANBAN_HOME/backups/` 配下に世代
バックアップを作成し、古い世代を keep 件まで削除する CLI コマンド。
`com.hachi-kanban.backup.plist`（`runbooks/templates/` 配下）は、このコマ
ンドを毎日 04:00 に 1 回だけ実行する launchd テンプレート。

supervisor.plist と異なり常駐プロセスではないため、`KeepAlive` /
`RunAtLoad` は付けず `StartCalendarInterval`（`Hour=4, Minute=0`）のみを
指定する。実行後プロセスは終了し、次回は翌日の起動時刻まで待機する。

### 既知の制約: on-demand-only mode（backup ジョブへの適用）

`StartCalendarInterval` は上記「既知の制約: on-demand-only mode」で説明
した `StartInterval` と同じく launchd の non-demand（受動的）トリガーで
あるため、`gui/<uid>` ドメインが on-demand-only mode に入っている間は
**自然発火しない可能性がある**。supervisor は常駐プロセス化してこの制約
を回避したが、backup ジョブは 1 日 1 回の短命プロセスという性質上、同様
の回避（内部ループ化）は適用できない。

そのため、以下のいずれかを運用上の代替手段とすること:

- 発火を逃した疑いがある場合は `pnpm hachi admin backup` を手動実行する
  （root package.json の `"hachi"` スクリプト経由。`--keep <n>` で世代数
  を上書き可能）。
- 即時起動を確認したい場合は
  `launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.backup"` で
  on-demand トリガーとして起動する（on-demand-only mode でも通る）。

### インストール手順

```bash
render_dir="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/generated-launchd"
mkdir -p "$HOME/Library/LaunchAgents"
plutil -lint "$render_dir/com.hachi-kanban.backup.plist"
/usr/bin/install -m 0644 "$render_dir/com.hachi-kanban.backup.plist" \
  "$HOME/Library/LaunchAgents/com.hachi-kanban.backup.plist"
plutil -lint ~/Library/LaunchAgents/com.hachi-kanban.backup.plist

launchctl bootout "gui/$(id -u)/com.hachi-kanban.backup" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.hachi-kanban.backup"
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hachi-kanban.backup.plist
launchctl print "gui/$(id -u)/com.hachi-kanban.backup"
```

`RunAtLoad` を付けていないため、`bootstrap` 直後に自動スポーンすること
はない（次の 04:00 まで待機、または上記 `kickstart` で即時確認）。

### 動作確認

```bash
launchctl kickstart -k "gui/$(id -u)/com.hachi-kanban.backup"
tail -20 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/backup.launchd.log"
tail -5 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/backup.launchd.err"
ls -lt "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/backups/"
```

`backups/` 配下に `kanban-<board>-<YYYYMMDD-HHmmss>.db` 形式のファイルが
作成されていれば成功。タイムスタンプは実装が JST（UTC+9）固定で組み立てるため
（`packages/cli/src/backup.ts` の `toJstTimestamp`）、他タイムゾーンの端末では
ローカル時刻と一致しない。世代数が keep（既定 14）を超えている場合は古いもの
から削除されているはずなので、件数も併せて確認する。

### アンインストール

```bash
launchctl disable "gui/$(id -u)/com.hachi-kanban.backup"
launchctl bootout "gui/$(id -u)/com.hachi-kanban.backup" 2>/dev/null || true
/bin/rm -f ~/Library/LaunchAgents/com.hachi-kanban.backup.plist
```

## Supervisor watchdog セットアップ（契約 §33.2）

supervisor 自身が停止しても気づく手段が無いという問題に対応する。supervisor は
起動直後・毎tick完了時に heartbeat（`$HACHI_KANBAN_HOME/state/supervisor-heartbeat.json`、
内容 `{ts: epoch秒, pid, tickCount, intervalSec}`、契約 §33.1）を書くが、それを
外部から監視する仕組みが無ければ heartbeat自体も「自己申告」に過ぎない。
`scripts/hachi-watchdog.sh` は supervisor の内部状態・DBには一切依存しない独立
プロセスとして heartbeat の鮮度だけを監視し、陳腐化・欠如を検知したら
`launchctl kickstart` で supervisor を強制再起動する（「配管を見張る配管」）。
jq 等の外部依存は無く、grep/sed のみで heartbeat JSON から `ts` を抽出する。

- 検査周期: 60秒毎（スクリプト内部の while ループ、KeepAlive/RunAtLoad で常駐化
  する点は supervisor.plist / web.plist と同じ流儀）
- 鮮度閾値: env `HACHI_WATCHDOG_STALE_SEC`（既定180秒）。heartbeat ファイルが
  存在しない場合も同様に「陳腐化」扱いとする
- kickstart 実行後は600秒のクールダウン（連続 kickstart ループの防止）
- kill-switch: `$HACHI_KANBAN_HOME/watchdog.disabled` が存在する間は検査自体を
  skip する（ループは継続し、次周期でファイルが消えていれば検査を再開する。
  プロセス再起動不要）
- 通知: 検知・kickstart 実行時に `osascript` で macOS 通知を出す（ベストエフォート、
  失敗してもループは継続する）
- ログ: `$HACHI_KANBAN_HOME/logs/watchdog.log`（プレーンテキスト、jq非依存の制約下
  ではJSONL化していない）に加え、launchd 側の stdout/stderr は下記の
  `watchdog.launchd.log` / `.err`

### インストール手順

```bash
render_dir="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/generated-launchd"
mkdir -p "$HOME/Library/LaunchAgents"
chmod +x scripts/hachi-watchdog.sh
plutil -lint "$render_dir/com.hachi-kanban.watchdog.plist"
/usr/bin/install -m 0644 "$render_dir/com.hachi-kanban.watchdog.plist" \
  "$HOME/Library/LaunchAgents/com.hachi-kanban.watchdog.plist"
plutil -lint ~/Library/LaunchAgents/com.hachi-kanban.watchdog.plist

launchctl bootout "gui/$(id -u)/com.hachi-kanban.watchdog" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.hachi-kanban.watchdog"
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hachi-kanban.watchdog.plist
launchctl print "gui/$(id -u)/com.hachi-kanban.watchdog"
```

### 動作確認

```bash
launchctl print "gui/$(id -u)/com.hachi-kanban.watchdog" | grep -E "state|pid|runs"
tail -20 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/watchdog.log"
tail -20 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/watchdog.launchd.log"
tail -5 "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/logs/watchdog.launchd.err"

# kill-switch の確認（検査 skip → 再開）
touch "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/watchdog.disabled"
# -> 次周期（最大60秒後）以降、watchdog.log に陳腐化/欠如の検知ログが出ないこと
/bin/rm -f "${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}/watchdog.disabled"
# -> 次周期から検査が再開されること
```

heartbeat を意図的に陳腐化させて kickstart が実際に発火することを確認したい場合は、
supervisor を止めた状態（`launchctl bootout` 等）で `HACHI_WATCHDOG_STALE_SEC` を
小さい値（例: 5）に設定して watchdog を起動し、`watchdog.log` に「陳腐化を検知」
「kickstart executed」が記録されることを確認する。

### アンインストール

```bash
launchctl disable "gui/$(id -u)/com.hachi-kanban.watchdog"
launchctl bootout "gui/$(id -u)/com.hachi-kanban.watchdog" 2>/dev/null || true
/bin/rm -f ~/Library/LaunchAgents/com.hachi-kanban.watchdog.plist
```

## 関連

- `docs/contract.md` §10 / §12.9-2 — supervisor tick / kill-switch 仕様
- `docs/contract.md` §19 — バックアップ（`hachi admin backup`）仕様
- `docs/contract.md` §33.1 / §33.2 — supervisor heartbeat / watchdog 仕様
- `packages/supervisor/src/supervisor.ts` — tick ループ本体（`startLoop` /
  `runGuarded` / `stop`）、kill-switch 判定（`isDisabled`）、heartbeat 書き込み
- `packages/supervisor/src/main.ts` — CLI エントリポイント（`--once` /
  `--apply` / `--interval` / `--board`、SIGTERM/SIGINT ハンドラ）
- `runbooks/templates/com.hachi-kanban.supervisor.plist` — supervisor
  launchd テンプレート
- `runbooks/templates/com.hachi-kanban.web.plist` — Web launchd テンプレート
- `runbooks/templates/com.hachi-kanban.backup.plist` — backup launchd
  テンプレート
- `scripts/hachi-watchdog.sh` — watchdog 本体（heartbeat 鮮度監視 + kickstart）
- `runbooks/templates/com.hachi-kanban.watchdog.plist` — watchdog launchd
  テンプレート
- `scripts/render-launchd.mjs` — 端末固有 path / non-secret environment を
  XML escape して4つの plist を生成する dry-run-first renderer
