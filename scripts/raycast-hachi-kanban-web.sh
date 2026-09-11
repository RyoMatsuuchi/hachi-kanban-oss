#!/usr/bin/env bash
# @raycast.schemaVersion 1
# @raycast.title Hachi Kanban Web
# @raycast.mode silent
# @raycast.icon 🗂
# @raycast.packageName Hachi Kanban
# @raycast.description Open the Hachi Kanban web board (127.0.0.1:9131), starting it if needed.

# Hachi Kanban の Web 看板ビュー(http://127.0.0.1:9131)を起動し、ブラウザで開く Raycast Script Command。
# 既に起動中(healthz が ok)ならブラウザを開くだけで終了する。未起動ならデタッチ起動してから開く。

set -euo pipefail

if [[ -z "${HOME:-}" || "$HOME" != /* ]]; then
  echo "HOME は絶対パスで設定してください。" >&2
  exit 1
fi

# launchd/Raycast 経由だと PATH が細い場合があるため、一般的な配置を足す。
PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.n/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="${HACHI_KANBAN_REPO_ROOT:-$(cd -- "$script_dir/.." && pwd -P)}"
case "$repo_dir" in
  "~") repo_dir="$HOME" ;;
  "~/"*) repo_dir="$HOME/${repo_dir#\~/}" ;;
esac
host="127.0.0.1"
port="${HACHI_KANBAN_WEB_PORT:-9131}"
if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$port > 65535 )); then
  echo "HACHI_KANBAN_WEB_PORT は 1〜65535 の整数で指定してください: ${port}" >&2
  exit 1
fi
url="http://${host}:${port}"
healthz_url="${url}/healthz"
hachi_home="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}"
case "$hachi_home" in
  "~") hachi_home="$HOME" ;;
  "~/"*) hachi_home="$HOME/${hachi_home#\~/}" ;;
esac
log_dir="${hachi_home}/logs"
log_file="${log_dir}/web.launch.log"

# 既に起動中ならclone/toolchainの状態に依存せずブラウザを開くだけで終了する。
is_healthy() {
  local body
  if ! body="$(curl -s -m 2 "$healthz_url" 2>/dev/null)"; then
    return 1
  fi
  case "$body" in
    *'"ok":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

if is_healthy; then
  open "$url" || true
  exit 0
fi

# 未起動時だけ、startに必要なclone/state/toolchainを検証する。
if [[ "$repo_dir" != /* ]]; then
  echo "HACHI_KANBAN_REPO_ROOT は絶対パスまたは ~/... で指定してください: ${repo_dir}" >&2
  exit 1
fi

repo_dir_input="$repo_dir"
if ! repo_dir="$(cd -- "$repo_dir_input" 2>/dev/null && pwd -P)" || [[ ! -f "$repo_dir/package.json" ]]; then
  echo "Hachi Kanban のリポジトリを特定できません: ${repo_dir_input}" >&2
  echo "HACHI_KANBAN_REPO_ROOT に clone 先の絶対パスを設定してください。" >&2
  exit 1
fi
if [[ "$hachi_home" != /* ]]; then
  echo "HACHI_KANBAN_HOME は絶対パスまたは ~/... で指定してください: ${hachi_home}" >&2
  exit 1
fi

if [[ -n "${HACHI_NODE_BIN:-}" ]]; then
  node_bin="$HACHI_NODE_BIN"
  case "$node_bin" in
    "~/"*) node_bin="$HOME/${node_bin#\~/}" ;;
  esac
  if [[ "$node_bin" != */* ]]; then
    node_bin="$(command -v "$node_bin" || true)"
  fi
  if [[ ! -f "$node_bin" || ! -x "$node_bin" ]]; then
    echo "HACHI_NODE_BIN は実行可能な通常ファイルを指定してください: ${node_bin}" >&2
    exit 1
  fi
  PATH="$(dirname -- "$node_bin"):$PATH"
  export PATH
fi

pnpm_setting="${HACHI_PNPM_BIN:-pnpm}"
case "$pnpm_setting" in
  "~/"*) pnpm_setting="$HOME/${pnpm_setting#\~/}" ;;
esac
if [[ "$pnpm_setting" == */* ]]; then
  pnpm_bin="$pnpm_setting"
else
  pnpm_bin="$(command -v "$pnpm_setting" || true)"
fi
if [[ -z "$pnpm_bin" || ! -f "$pnpm_bin" || ! -x "$pnpm_bin" ]]; then
  echo "実行可能な pnpm が見つかりません。HACHI_PNPM_BIN または PATH を設定してください。" >&2
  exit 1
fi
# 未起動: ログディレクトリを用意してからデタッチ起動する。
mkdir -p "$log_dir"
cd "$repo_dir"

nohup "$pnpm_bin" --filter @hachi/web run start -- >>"$log_file" 2>&1 &
web_pid="$!"
disown "$web_pid" >/dev/null 2>&1 || true

# healthz が ok になるまで最大15秒(1秒間隔 x 15回)ポーリングする。
started=0
for _ in {1..15}; do
  if is_healthy; then
    started=1
    break
  fi
  sleep 1
done

if [[ "$started" -eq 1 ]]; then
  open "$url" || true
  exit 0
fi

echo "Hachi Kanban Web の起動がタイムアウトしました。ログを確認してください: ${log_file}"
exit 1
