# Portable installation

## 目的と境界

この手順は、別の Mac に hachi-kanban の**独立したローカル環境**を作ります。
同じ Git repository を clone しても、看板 DB、agent session、config、token、artifact は
共有されません。同じ看板を複数端末から同時操作する構成は、現在の SQLite + loopback
architecture の範囲外です。

OS の境界: 本体（CLI / supervisor / Web 看板）は macOS と Linux のどちらでも動きます。
§7 の LaunchAgent による常駐化だけが macOS 専用です（`launchctl` / `plutil` に依存）。
Linux で常駐させる場合は §5 の foreground 実行を systemd user unit などに載せてください
（このリポジトリは unit ファイルを同梱しません）。

## 1. 前提を揃える

```bash
node --version   # >= 22.13
pnpm --version   # 10.17.1
git --version
```

direct transport を使う provider については、その利用者自身が CLI を install・login します。

```bash
codex --version
claude --version
```

構成によって追加で必要になるもの（いずれも素の CLI 利用では不要）。

| 依存 | 必要になる条件 |
|---|---|
| `tmux` | `hachi orchestrator handover` / 後継 orchestrator の起動。稼働中 session がある状態で不在だと `hachi doctor` が失敗する |
| `python3` | `~/.local/bin` の運用ヘルパー 5 本のうち 4 本（`hachi-handover-now` / `hhn` / `cc-cache-ttl` / `hachi-watch-stop`）。残る `hachi-orch-enable` は bash |
| Docker / `lsof` | config に `runtimeResources` を書いて runtime resource profile を使う場合（§8 参照） |

`sqlite` / `sqlite3` コマンドは不要です。DB アクセスは npm の `better-sqlite3` だけを使います。
`git` は supervisor の finalize / review / monitor ステージが直接実行するため、実運用では必須です。

認証情報を repository、chat、setup script の引数へ書かないでください。

## 2. clone と依存関係

```bash
git clone <repository-url>
cd hachi-kanban
pnpm install --frozen-lockfile
```

`package.json` は `private: true` で、npm package や release binary はありません。
clone した source と lockfile が実行物です。

## 3. ローカル状態と transport を初期化する

新規端末は `direct` を推奨します。

```bash
# dry-run
node scripts/setup-local.mjs --transport direct --skip-install

# 明示適用
node scripts/setup-local.mjs --apply --transport direct --skip-install
```

適用内容（`scripts/setup-local.mjs` の `applyPlan`）:

- `$HACHI_KANBAN_HOME`（既定 `~/.hachi-kanban`）を 0700 で作成
- その配下の `logs/` と `credentials/` を 0700 で作成
- state root に config が無い場合だけ `examples/config.<transport>.json` を 0600 で配置
- `~/.local/bin/hachi` が無い場合だけ、clone 内の `bin/hachi` への symlink を作成
- `~/.local/bin` へオーケストレーター運用ヘルパーの exec シムを作成（`--no-link` で抑止）:
  `hachi-handover-now`、`hhn`、`hachi-orch-enable`、`cc-cache-ttl`、`hachi-watch-stop`。
  いずれも `#!/bin/sh` + `exec "<repo>/scripts/..." "$@"` の 1 行シムで、実体は repo 側に置く。
  CLI 本体の利用には不要なので、オーケストレーター運用をしないなら `--no-link` でよい

既存 config と、別 target を指す symlink / 通常ファイルは上書きしません。同じ引数での
再実行は冪等です（2 回目は `config=unchanged, link=unchanged, helpers=all unchanged`）。

option（`--help` と同じ内容）:

| option | 既定 | 説明 |
|---|---|---|
| `--apply` | 無指定は dry-run | 計画を実行する |
| `--transport <kind>` | `direct` | `direct` または `bridge`。config template の選択に使う |
| `--hachi-home <path>` | `HACHI_KANBAN_HOME` または `~/.hachi-kanban` | state root。`/`、`$HOME` そのもの、`/` 直下（`/tmp` 等）は拒否（`scopedStateRoot`） |
| `--bin-dir <path>` | `~/.local/bin` | symlink とヘルパーシムの配置先 |
| `--pnpm-bin <path>` | `HACHI_PNPM_BIN` または `pnpm` | 依存 install に使う pnpm |
| `--skip-install` | 無指定は install する | `pnpm install --frozen-lockfile` を実行しない |
| `--no-link` | 無指定は link する | `hachi` symlink とヘルパーシムを作成しない |

依存 install も setup に任せる場合は `--skip-install` を外します。

bridge を選ぶ場合:

```bash
node scripts/setup-local.mjs --apply --transport bridge --skip-install
```

bridge server と token 発行はこの repository の外部です。URL と token file を用意できない
端末で bridge を選ばないでください。リモートhostを指すbridge URLはHTTPSかつ
`HACHI_BRIDGE_ALLOW_REMOTE=1`が必要です。平文HTTPへのremote bearer token送信は拒否します。

発行済みtokenは、既定では次の端末固有pathへ0400または0600で配置します。

```text
$HACHI_KANBAN_HOME/credentials/codex-bridge-token
$HACHI_KANBAN_HOME/credentials/claude-bridge-token
```

既存の別pathを使う場合だけ、後述のtoken file環境変数で明示してください。

## 4. config を端末の利用権へ合わせる

example の model 名は portable な利用権を保証しません。利用者が使える provider / model と、
installed runtime version に合わせて次を同時に整合させます。

- `profiles.*.{provider,model,transport,effort,speed}`
- `allowlist`
- direct の場合は `modelTransportPolicies`のruntime version、`supportedEfforts`、`supportedSpeeds`
- provider純正session間通信を段階導入する場合だけ`communication.*`（既定/推奨は`off`）
- `defaultProfile`

Hachi は非互換を別 model や bridge へ暗黙 fallback しません。

## 5. doctor と foreground smoke

```bash
hachi doctor --offline
hachi board
pnpm supervisor --once
# 別terminalで:
pnpm web
# service起動後に:
hachi doctor
```

full doctor は config の active profile で使う transport を診断します。未使用 bridge は skip し、
direct profile は provider runtime と model/transport policy を確認します。
`doctor --offline` は network / runtime probe を意図的に skip する構文・local state 向け診断で、
worker readiness の証明ではありません。

full doctor も readiness の証明ではありません。`codex` / `claude` CLI が見つからない場合、
`model transport (<profile>)` 検査は fail ではなく `警告:` 付きの合格（decision=unknown）
になります（`packages/cli/src/model-transport-observability.ts`）。
また `--offline` が効くのは bridge 2 件・`model transport (*)`・`supervisor heartbeat`・
`web healthz`・`native communication readiness` の 5 種だけで、`handover preflight`
（`which tmux` / `tmux list-sessions`）と `passthrough patch status`（`lsof`）は
`--offline` でも実行されます。

`orchestrator helpers` 検査は `~/.local/bin` の運用ヘルパー 5 本の導入状態を見て、
**未導入は警告、導入済みだが壊れている場合は失敗**として報告します。
この 5 本を必要とするのはオーケストレーター運用者だけなので、1 本も無い（`missing`）のは
正常状態として `警告:` 付きの合格（`model transport (*)` の decision=unknown と同じ扱い）に
なります。§3 の `--no-link` を使うとこの 1 項目に警告が出ますが、それが原因で
exit 1 になることはありません。
一方、シムを置いたのに壊れている場合（`not-a-shim` / `unexpected-source` / `outside-repo` /
`shim-not-executable` / `source-missing` / `source-not-executable` 等）は `ok: false` で
doctor 全体が exit 1 になります。この状態にはシム経由の実行が
`exec: Permission denied` 等で失敗する実害があり、良性の読み方がないためです。
どちらの場合も、どのシムがどの状態なのかが detail に内訳として出ます。

foreground smoke が通るまで LaunchAgent を install しないでください。

## 6. 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `HACHI_KANBAN_HOME` | `~/.hachi-kanban` | 端末固有 state root |
| `HACHI_KANBAN_BOARD` | `dev` | board slug |
| `HACHI_NODE_BIN` | 自動探索 | `bin/hachi` が使う Node.js の絶対パス。自動探索は `~/.vite-plus/bin/node` → `~/.n/bin/node` → `~/.volta/bin/node` → `PATH` の順（`bin/hachi`）。別の version manager を使う端末では明示指定が確実 |
| `HACHI_PNPM_BIN` | `pnpm` | setup / LaunchAgent generator が使う pnpm |
| `HACHI_CODEX_BRIDGE_URL` | `http://127.0.0.1:3456` | Codex bridge URL |
| `HACHI_CODEX_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/codex-bridge-token` | Codex bridge token file。既存の別配置を使う場合だけ上書き |
| `HACHI_CLAUDE_BRIDGE_URL` | `http://127.0.0.1:3457` | Claude bridge URL |
| `HACHI_CLAUDE_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/claude-bridge-token` | Claude bridge token file。既存の別配置を使う場合だけ上書き |
| `HACHI_BRIDGE_ALLOW_REMOTE` | core は unset | renderer は `0` を明示。HTTPSのremote bridgeを許可するときだけ `1` |
| `HACHI_KANBAN_WEB_PORT` | `9131` | local Web port |
| `HACHI_KANBAN_REPO_ROOT` | clone root | LaunchAgent generator が plist へ埋める repo root（`--repo-root` と同義） |
| `HACHI_LAUNCHD_PATH` | 解決済み bin dir 群 | plist の `PATH`。未指定時は `dirname(node)`、`dirname(pnpm)`、`~/.local/bin`、`~/.local/share/pnpm`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` |
| `HACHI_WATCHDOG_STALE_SEC` | `180` | watchdog が supervisor heartbeat を陳腐化とみなす秒数（`scripts/hachi-watchdog.sh`） |
| `HERMES_HOME` | `~/.hermes-hachi-dev` | 旧システム（legacy-hermes）由来の外部 appliance 連携用。読み手は 2 つだけ: doctor の `passthrough patch status` 検査（`$HERMES_HOME/even-shared/passthrough-patch-status.json` を読む）と、supervisor の external runtime generation root。新規導入では設定不要 |

`.env` は自動 load しません。interactive shell の export も LaunchAgent へ自動継承されません。
LaunchAgent を生成するときは、必要な non-secret 値と token **path** を generator へ渡します。
token 値自体を plist に埋め込まないでください。

## 7. LaunchAgent（macOS 専用）

この節は macOS だけに当てはまります。Linux では plist を使わず、§5 の foreground 実行を
systemd user unit などへ載せてください。

`runbooks/templates/*.plist` は checked-in path をそのまま install するファイルではなく、
端末固有の absolute path を埋める source template です。生成・検証手順は
`runbooks/supervisor-launchd-setup.md` に従います。

生成後は plist の path、`plutil -lint`、foreground smoke を確認してから明示的に
`launchctl bootstrap` します。generator 自体は既存 LaunchAgent を bootout / overwrite / start しません。

## 8. 秘密情報と端末固有機能

- bridge token file は現在user所有の0400/0600 regular fileとして置く。symlink、group/other permission、8 KiB超を拒否する
- Telegram token file は state root 内外の 0600 regular file に置く
- secret value は config / plist / Git に書かない
- Telegram は token のほか config の `notify.telegram.chatId` が必要
- runtime resource profile は Docker、`lsof`、端末固有の absolute `repoCommonDir` が必要
- G2 / even-terminal は optional external appliance で、fresh clone には含まれない

## 9. GitHub へ機能を届ける gate

別の利用者が pull できる条件は、ローカル branch に存在するだけでは満たしません。

1. reviewed branch を remote へ push
2. CI と clean-clone smoke を通す
3. default branch へ merge
4. remote SHA を新規 clone で再確認

branch protection が無い repository では、この順序を手動 gate として維持します。
