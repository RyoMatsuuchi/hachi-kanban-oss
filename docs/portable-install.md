# Portable installation

## 目的と境界

この手順は、別の Mac に hachi-kanban の**独立したローカル環境**を作ります。
同じ Git repository を clone しても、看板 DB、agent session、config、token、artifact は
共有されません。同じ看板を複数端末から同時操作する構成は、現在の SQLite + loopback
architecture の範囲外です。

repository は private です。利用者には clone 前に GitHub の明示的な access grant が必要です。

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

適用内容:

- `$HACHI_KANBAN_HOME`（既定 `~/.hachi-kanban`）を 0700 で作成
- `logs/` と `credentials/` を 0700 で作成
- state root に config が無い場合だけ `examples/config.direct.json` を 0600 で配置
- `~/.local/bin/hachi` が無い場合だけ、clone 内の `bin/hachi` への symlink を作成

既存 config と、別 target を指す symlink / 通常ファイルは上書きしません。依存 install も
setup に任せる場合は `--skip-install` を外します。

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

foreground smoke が通るまで LaunchAgent を install しないでください。

## 6. 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `HACHI_KANBAN_HOME` | `~/.hachi-kanban` | 端末固有 state root |
| `HACHI_KANBAN_BOARD` | `dev` | board slug |
| `HACHI_NODE_BIN` | 自動探索 | `bin/hachi` が使う Node.js の絶対パス |
| `HACHI_PNPM_BIN` | `pnpm` | setup / LaunchAgent generator が使う pnpm |
| `HACHI_CODEX_BRIDGE_URL` | `http://127.0.0.1:3456` | Codex bridge URL |
| `HACHI_CODEX_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/codex-bridge-token` | Codex bridge token file。既存の別配置を使う場合だけ上書き |
| `HACHI_CLAUDE_BRIDGE_URL` | `http://127.0.0.1:3457` | Claude bridge URL |
| `HACHI_CLAUDE_BRIDGE_TOKEN_FILE` | `$HACHI_KANBAN_HOME/credentials/claude-bridge-token` | Claude bridge token file。既存の別配置を使う場合だけ上書き |
| `HACHI_BRIDGE_ALLOW_REMOTE` | core は unset | renderer は `0` を明示。HTTPSのremote bridgeを許可するときだけ `1` |
| `HACHI_KANBAN_WEB_PORT` | `9131` | local Web port |

`.env` は自動 load しません。interactive shell の export も LaunchAgent へ自動継承されません。
LaunchAgent を生成するときは、必要な non-secret 値と token **path** を generator へ渡します。
token 値自体を plist に埋め込まないでください。

## 7. LaunchAgent

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
5. 対象利用者へ repository access を付与

branch protection が無い repository では、この順序を手動 gate として維持します。
