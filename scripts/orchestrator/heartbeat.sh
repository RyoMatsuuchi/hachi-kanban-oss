#!/bin/bash
# provider session UUID から自分の active orchestrator session/generation を解決し、
# inbox を消費しない heartbeat だけを送る。session の再登録は行わない。
set -u

usage() {
  echo "使い方: $0 <provider-session-uuid>" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

provider_session_id="$1"
if ! [[ "$provider_session_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
  echo "provider session id は UUID 形式が必須です: $provider_session_id" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

if command -v hachi >/dev/null 2>&1; then
  hachi_bin="$(command -v hachi)"
elif [ -x "$repo_root/bin/hachi" ]; then
  hachi_bin="$repo_root/bin/hachi"
else
  echo "hachi CLI が見つかりません（PATH または $repo_root/bin/hachi）" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "orchestrator list の JSON 解決に必要な node が見つかりません" >&2
  exit 2
fi
node_bin="$(command -v node)"

if ! list_json=$("$hachi_bin" orchestrator list --json); then
  echo "orchestrator list の取得に失敗しました" >&2
  exit 3
fi

resolver='const fs=require("node:fs");
const providerSessionId=process.argv[1];
const input=JSON.parse(fs.readFileSync(0,"utf8"));
if(!input||!Array.isArray(input.orchestrators)) throw new Error("orchestrator list JSON が不正です");
const matches=input.orchestrators
  .map((row)=>row&&row.liveSession)
  .filter((session)=>session&&session.status==="active"&&session.providerSessionId===providerSessionId);
if(matches.length!==1) throw new Error(`provider session id に一致する active liveSession は1件必須です: count=${matches.length}`);
const session=matches[0];
if(typeof session.id!=="string"||!Number.isInteger(session.generation)||session.generation<=0||
   typeof session.orchestratorId!=="string"||typeof session.provider!=="string") {
  throw new Error("一致した liveSession の schema が不正です");
}
process.stdout.write([session.id,String(session.generation),session.orchestratorId,session.provider].join("\t"));'

if ! resolved=$(printf '%s' "$list_json" | "$node_bin" -e "$resolver" "$provider_session_id"); then
  echo "自分の provider session id に一致する live session を解決できないため heartbeat しません" >&2
  exit 3
fi

IFS=$'\t' read -r session_id generation orchestrator_id provider <<EOF
$resolved
EOF
if [ -z "$session_id" ] || [ -z "$generation" ] || [ -z "$orchestrator_id" ] || [ -z "$provider" ]; then
  echo "live session の解決結果が不完全なため heartbeat しません" >&2
  exit 3
fi

tmp_root="${TMPDIR:-/tmp}"
if [ ! -d "$tmp_root" ]; then
  echo "一時ディレクトリが存在しません: $tmp_root" >&2
  exit 2
fi
log_path="$tmp_root/hachi-orch-heartbeat-$provider_session_id.log"
dead_path="$tmp_root/hachi-orch-heartbeat-$provider_session_id.DEAD"
max_failures=3
interval_seconds=30
failures=0
rm -f "$dead_path"

while true; do
  if output=$("$hachi_bin" orchestrator session heartbeat "$session_id" --generation "$generation" 2>&1); then
    failures=0
  else
    failures=$((failures + 1))
    echo "$(date -u +%FT%TZ) heartbeat failed ($failures/$max_failures): $output" >> "$log_path"
    if [ "$failures" -ge "$max_failures" ]; then
      {
        echo "$(date -u +%FT%TZ) HEARTBEAT DEAD after $failures consecutive failures"
        echo "last error: $output"
        echo "復旧（status=stale かつ後継不在を確認して手動実行）:"
        echo "hachi orchestrator session takeover $orchestrator_id --stale-sec 90 --provider $provider --provider-session-id $provider_session_id --json"
      } | tee -a "$log_path" > "$dead_path"
      exit 1
    fi
  fi
  sleep "$interval_seconds"
done
