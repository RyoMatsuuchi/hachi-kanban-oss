#!/bin/bash
# オーケストレーター → ユーザーへの Telegram 直接連絡（エスカレーション用フォールバック）
# 位置付け: セッション内で応答が得られない・離席中のときの連絡手段（runbooks/orchestrator-reference.md §8）。
# タスク形の判断は task block（user-decision）→ §38 通知（ボタン付き）を第一選択とし、本スクリプトは
# セッションレベルの質問・中断・完了報告など「タスクに紐づかない連絡」に使う。
set -euo pipefail

TOKEN_FILE="${HACHI_TELEGRAM_TOKEN_FILE:-$HOME/.hachi-kanban/telegram-token}"
CONFIG_FILE="${HACHI_KANBAN_CONFIG:-$HOME/.hachi-kanban/config.json}"

title="" body="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) title="$2"; shift 2;;
    --body)  body="$2";  shift 2;;
    --url)   url="$2";   shift 2;;
    -h|--help)
      echo "usage: $(basename "$0") --body <text> [--title <text>] [--url <link>]"
      echo "  token: \$HACHI_TELEGRAM_TOKEN_FILE (既定 ~/.hachi-kanban/telegram-token)"
      echo "  宛先 : config.json notify.telegram.chatId"
      exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$body" ] || { echo "--body は必須" >&2; exit 2; }

[ -r "$TOKEN_FILE" ] || { echo "token ファイルが読めません: $TOKEN_FILE" >&2; exit 1; }
token=$(tr -d '[:space:]' < "$TOKEN_FILE")
chat_id=$(python3 -c "import json;print(json.load(open('$CONFIG_FILE'))['notify']['telegram']['chatId'])")

text="🤖 orchestrator"
[ -n "$title" ] && text="$text — $title"
text="$text
$body"
[ -n "$url" ] && text="$text
$url"

# 注意: -S を付けない（curl のエラーメッセージに token 入り URL が出るのを防ぐ）
resp=$(curl -s -m 15 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat_id}" \
  --data-urlencode "text=${text}" \
  -d "disable_web_page_preview=true" || true)
ok=$(printf '%s' "$resp" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('ok'))
except Exception: print('False')")
if [ "$ok" != "True" ]; then
  # resp に token は含まれない（description のみ表示）
  desc=$(printf '%s' "$resp" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('description','(no response)'))
except Exception: print('(unparseable response)')")
  echo "送信失敗: $desc" >&2
  exit 1
fi
mid=$(printf '%s' "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['message_id'])")
echo "送信OK (message_id=$mid)"
