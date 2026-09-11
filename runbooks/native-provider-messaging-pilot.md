# Native provider messaging pilot

Codex App ServerとClaude Code cross-session relayを使うv0.18 pilotの運用手順。
状態機械と安全境界は`docs/contract.md` §68が正本である。

## 初期状態

- repo例とlive configは`rollout: "off"`のままとする。PRのmergeだけでnative配送は有効化しない。
- `observe`はroute/capabilityを監査するが、実配送は従来のHachi経路を使う。
- `canary/on`のsame-providerだけがnative配送候補になる。証拠不足はHachiへsilent fallbackせずfail-closed。
- cross-providerはrolloutにかかわらずHachi経路。

## 事前確認

live有効化はユーザーの別承認後に1 provider、1 deliveryずつ行う。

```bash
hachi doctor --json
hachi orchestrator session status --orchestrator <orchestrator-id> --json
hachi communication binding list --task <task-id> --json
hachi communication relay list --task <task-id> --json
```

doctorで対象providerのruntime version、adapter readiness、minimum version、same-host条件を確認する。
`unknown`を対応済みとみなさない。

`off`から`canary/on`へ変更するときは、config保存後にSupervisorを再起動する。native adapterは
Supervisor起動時に構築されるため、tickごとのconfig hot reloadだけでは有効にならない。再起動後に
もう一度`hachi doctor --json`を実行し、対象providerのadapter readinessを確認してからsource bindingを登録する。

## source binding

native intentを送る前に、担当taskのprimaryであるactive exact orchestrator sessionからsource bindingを登録する。
provider、provider session、hostname、runtime capabilityはCLIがtrusted local state/probeから導出し、callerには指定させない。

```bash
hachi communication binding register-source --task <task-id> \
  --actor-kind orchestrator --orchestrator <orchestrator-id> \
  --session <orchestrator-session-id> --generation <generation> --json
```

## steer

```bash
hachi task steer <task-id> "<message>" --communication auto \
  --actor-kind orchestrator --orchestrator <orchestrator-id> \
  --session <orchestrator-session-id> --generation <generation> --json
```

Codex routeはSupervisorがfresh bindingを確認し、App Serverへclaim/begin/steer/receiptを進める。
Claude routeはactive exact Claude orchestratorがrelay attemptをclaimし、claim後にbeginしてから
Claude Codeの`ListAgents`/`SendMessage`を一度だけ実行する。CLI自体はこれbuilt-inを呼び出さない。

```bash
hachi communication relay claim --attempt <attempt-id> \
  --actor-kind orchestrator --orchestrator <orchestrator-id> \
  --session <orchestrator-session-id> --generation <generation> --json

hachi communication relay begin --attempt <attempt-id> --attempt-nonce <one-time-nonce> \
  --actor-kind orchestrator --orchestrator <orchestrator-id> \
  --session <orchestrator-session-id> --generation <generation> --json

hachi communication relay receipt --attempt <attempt-id> --attempt-nonce <one-time-nonce> \
  --outcome <transport_accepted|session_observed|acknowledged|rejected|uncertain> \
  --receipt-id <receipt-id> \
  --actor-kind orchestrator --orchestrator <orchestrator-id> \
  --session <orchestrator-session-id> --generation <generation> --json
```

nonceはclaimの即時応答でだけ1回取得し、ログ、コメント、コミットへ残さない。

## 判定とrollback

- `transport_accepted`はprovider受理であり、worker観測や適用の証明ではない。
- `session_observed`はexact message keyのreceiver観測、`acknowledged`はexact ackのみ。
- `dispatching`以降のtimeout/crashは`uncertain`。二重配送を避けるためHachiへfallbackしない。
- rollbackは対象providerを`draining`、新規native claim停止確認後に`off`へ戻す。
  accepted/uncertain attemptを手動でqueuedへ戻さない。
- exact session停止、cancel fence、replacementは従来のdurable cancel契約に従い、native受理を停止証拠に使わない。
