#!/usr/bin/env bash
# hachi-kanban supervisor watchdog（docs/contract.md §33.2）。
#
# supervisor 自身は heartbeat（$HACHI_KANBAN_HOME/state/supervisor-heartbeat.json、
# 内容 {ts: epoch秒, pid, tickCount, intervalSec}）を起動直後・毎tick完了時に書くが、
# supervisorプロセス自体が死んでいたら誰もそれに気づけない。本スクリプトは supervisor
# の内部状態・DBには一切依存しない独立プロセスとして、外部から heartbeat の鮮度だけを
# 監視し、陳腐化・欠如を検知したら launchctl kickstart で supervisor を強制再起動する
# （「配管を見張る配管」）。
#
# 設計判断: set -e は使わない。
#   watchdog は「supervisorが落ちても気づく」ための最後の砦であり、launchctl kickstart や
#   osascript といった個々のコマンドが一時的に失敗しても、watchdogループ自体は絶対に
#   止まってはならない。set -e を付けるとそれらの失敗でスクリプト全体が終了してしまい、
#   本末転倒（watchdogが落ちてもさらに誰も気づけない）になる。そのため set -u（未定義変数の
#   参照を検知）と pipefail のみを有効にし、失敗しうる個々のコマンドは `|| true` 等で
#   明示的に保護してループの継続を保証する。
set -uo pipefail

# launchd経由だとPATHが細い場合があるため、想定コマンドの場所を明示的に足しておく
# （raycast-hachi-kanban-web.sh と同じ方針）。
PATH="$HOME/.local/bin:$HOME/.n/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH

HACHI_KANBAN_HOME="${HACHI_KANBAN_HOME:-$HOME/.hachi-kanban}"
HACHI_WATCHDOG_STALE_SEC="${HACHI_WATCHDOG_STALE_SEC:-180}"

readonly CHECK_INTERVAL_SEC=60
readonly KICKSTART_COOLDOWN_SEC=600
readonly SUPERVISOR_LABEL="com.hachi-kanban.supervisor"

heartbeat_file="${HACHI_KANBAN_HOME}/state/supervisor-heartbeat.json"
disabled_file="${HACHI_KANBAN_HOME}/watchdog.disabled"
log_dir="${HACHI_KANBAN_HOME}/logs"
log_file="${log_dir}/watchdog.log"

last_kickstart_at=0

# タイムスタンプ付きの1行ログを追記する（jq非依存の制約下、JSONLではなくプレーンテキスト。
# ログ書き込み自体の失敗でループを止めないよう常にベストエフォート）。
log() {
  mkdir -p "$log_dir" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >>"$log_file" 2>/dev/null || true
}

# heartbeat JSON（例: {"ts":1751690328,"pid":1234,"tickCount":5,"intervalSec":30}）から
# "ts" キーの数値のみを取り出す。jqを使わず grep -o + sed で抽出し、キー順やスペースの
# 有無には頑健だが、パース失敗時は空文字を返す（呼び出し側が「欠如」と同様に扱う）。
extract_ts() {
  local file="$1"
  local content
  content="$(cat "$file" 2>/dev/null)" || return 1
  local match
  match="$(printf '%s' "$content" | grep -o '"ts"[[:space:]]*:[[:space:]]*[0-9]*' | head -1)"
  if [ -z "$match" ]; then
    return 1
  fi
  local value
  value="$(printf '%s' "$match" | sed -E 's/.*:[[:space:]]*([0-9]+)/\1/')"
  # "ts" キーは見つかったが値部分が空/破損している（sed が数字を1桁も拾えず元の
  # 文字列をそのまま素通りさせた）場合は非数値文字列が残る。これをそのまま呼び出し側の
  # 算術評価 $((now - ts)) に渡すとエラーになり、その回の陳腐化判定が丸ごと skip
  # されてしまう（=本来「異常」を「異常なし」と誤判定する）ため、ここで弾いて
  # 抽出失敗（heartbeat欠如と同様の扱い）に倒す。
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "$value"
}

# AppleScriptの二重引用符文字列リテラルとして安全な形にエスケープする
# （バックスラッシュを先に、続けてダブルクォートを変換。順序を逆にすると二重エスケープになる。
# packages/supervisor/src/stages/notify.ts の escapeAppleScriptString と同じ考え方）。
escape_applescript_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# macOS通知を出す。失敗してもループを継続する（ベストエフォート）。
notify() {
  local message
  message="$(escape_applescript_string "$1")"
  osascript -e "display notification \"${message}\" with title \"hachi-kanban watchdog\"" >/dev/null 2>&1 || true
}

# supervisor LaunchAgent を kickstart で強制再起動する。失敗してもループを継続する。
kickstart_supervisor() {
  local uid
  uid="$(id -u)"
  if launchctl kickstart -k "gui/${uid}/${SUPERVISOR_LABEL}" >/dev/null 2>&1; then
    log "kickstart executed (gui/${uid}/${SUPERVISOR_LABEL})"
  else
    log "kickstart failed (gui/${uid}/${SUPERVISOR_LABEL})"
  fi
  notify "supervisor heartbeat が陳腐化したため再起動しました"
}

# HACHI_WATCHDOG_STALE_SEC は launchd plist 等の外部設定から注入される値のため、起動直後に
# 検証する。不正値（非数値・空・0・負数）を検知したら安全側の既定値(180)へフォールバックし、
# その旨を記録する（fail-closed。壊れた/未設定の閾値のまま陳腐化判定に使うと、常に発火 or
# 常に発火しないという事故につながる）。extract_ts() と同じ「全桁数字」判定の流儀に揃える。
case "$HACHI_WATCHDOG_STALE_SEC" in
  ''|*[!0-9]*)
    log "HACHI_WATCHDOG_STALE_SEC が不正な値のため既定値(180)にフォールバックしました (受け取った値: '${HACHI_WATCHDOG_STALE_SEC}')"
    HACHI_WATCHDOG_STALE_SEC=180
    ;;
  *)
    if [ "$HACHI_WATCHDOG_STALE_SEC" -le 0 ]; then
      log "HACHI_WATCHDOG_STALE_SEC が0以下のため既定値(180)にフォールバックしました (受け取った値: ${HACHI_WATCHDOG_STALE_SEC})"
      HACHI_WATCHDOG_STALE_SEC=180
    fi
    ;;
esac

log "watchdog started (stale_threshold=${HACHI_WATCHDOG_STALE_SEC}s, home=${HACHI_KANBAN_HOME})"

while true; do
  if [ -e "$disabled_file" ]; then
    # kill-switch 有効中は検査自体をskipする（ループは継続し、次周期で再判定する）。
    sleep "$CHECK_INTERVAL_SEC"
    continue
  fi

  now="$(date +%s)"
  ts=""
  if [ -f "$heartbeat_file" ]; then
    ts="$(extract_ts "$heartbeat_file" || true)"
  fi

  should_kickstart=0
  if [ -z "$ts" ]; then
    log "heartbeat 欠如を検知しました (${heartbeat_file})"
    should_kickstart=1
  else
    elapsed=$((now - ts))
    if [ "$elapsed" -gt "$HACHI_WATCHDOG_STALE_SEC" ]; then
      log "heartbeat 陳腐化を検知しました (elapsed=${elapsed}s > ${HACHI_WATCHDOG_STALE_SEC}s)"
      should_kickstart=1
    fi
  fi

  if [ "$should_kickstart" -eq 1 ]; then
    since_last=$((now - last_kickstart_at))
    if [ "$last_kickstart_at" -ne 0 ] && [ "$since_last" -lt "$KICKSTART_COOLDOWN_SEC" ]; then
      log "kickstart cooldown 中のため抑制しました (残り $((KICKSTART_COOLDOWN_SEC - since_last))s)"
    else
      kickstart_supervisor
      last_kickstart_at="$now"
    fi
  fi

  sleep "$CHECK_INTERVAL_SEC"
done
