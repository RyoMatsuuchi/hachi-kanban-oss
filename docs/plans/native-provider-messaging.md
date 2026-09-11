# Native same-provider messaging

Status: **v0.18 native delivery pilot in implementation; live canary remains gated**（2026-08-18）。
実配線はcontract §68.4–§68.8に従う。live configのcanary/onはまだ有効化済みと主張しない。

## 1. 結論

Hachi の board / SQLite / task-run-session lifecycle を control plane として維持し、
同一 provider の純正機能は optional な delivery plane として使う。

- Claude orchestrator → Claude worker: Claude Code cross-session messaging の pilot 候補
- Codex orchestrator → Codex worker: 同じ live tree の native subagent、または Hachi が所有する
  top-level thread への Codex App Server / SDK transport を用途別に分ける
- Claude ↔ Codex: 既存の provider-neutral Hachi message / bridge 経路を維持

native delivery は task ownership、権限、完了、cancel、replacement、provenance の証拠にはしない。

既存の execution `Transport = bridge | direct` に第3値として混ぜない。execution transport は
worker launch、transcript、model compatibility、stop を決める。一方 native messaging は起動済み
session へ command を届ける communication transport なので、別の capability / adapter とする。

## 2. 公式機能の現在地

### Claude

Claude Code v2.1.224（2026-08-07）は `ListAgents` で独立 session を発見し、
`SendMessage` で session 間の plain-text message を送る cross-session messaging を追加した。
v2.1.225 は Remote Control session への会話開始を拡張し、v2.1.226 は直後の修正版である。

公式資料:

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude Code v2.1.224](https://github.com/anthropics/claude-code/releases/tag/v2.1.224)
- [Claude Code v2.1.225](https://github.com/anthropics/claude-code/releases/tag/v2.1.225)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Costs](https://code.claude.com/docs/en/costs)

これは experimental Agent Teams とは別機能である。`ListAgents` / `SendMessage` は Claude が使う
built-in tool で、Hachi TypeScript process が呼べる公開 HTTP / CLI RPC ではない。内部 Unix socket の
wire protocol も公開契約ではないため、socket へ独自に書き込まない。

local runtime の再監査値は Claude Code 2.1.226 であり、pilot の最低version条件を満たす。
ただしversionだけを到達性やpolicy許可の証拠にせず、導入時は capability とsession bindingも確認する。

### Codex

Codex の multi-agent は native subagent tree を提供する。親は spawn、追加指示、wait、interrupt / close
相当の runtime tool を使えるが、識別子と到達性は同じ root thread tree に属する。

外部 supervisor に対する公式面は別である。

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex MCP server](https://learn.chatgpt.com/docs/mcp-server)

SDK / App Server は top-level Codex thread の開始、再開、turn start / steer / interrupt を扱える。
外部 TypeScript から native child の `spawn_agent` 等を直接操作する同等 RPC ではない。
したがって Hachi-owned durable worker と、live Codex-owned ephemeral child を同じものとして扱わない。

App Server command と WebSocket transport は公式上 experimental / unsupported for production であり、stdioも
production-readyと仮定しない。runtime versionをpinし、そのversionから生成したschema fixture/checksum、upgrade smoke、
capability gateを持つspikeとして評価する。unsupported / schema drift はfail-closedとし、production opt-inは別gateにする。

## 3. token efficiency の仮説

「native だから総 token が必ず減る」は採用条件にしない。

期待できる削減:

- shell command、CLI result、polling、stdout parsing の coordination overhead
- 親 context への raw worker log 混入
- provider session の再発見・resume 失敗

残る、または増えうる cost:

- receiver の新しい model turn と既存 full context
- 各 subagent の独立 context / tool calls
- message loop、過剰 fan-out、全履歴 fork

現行 bridge と native pilot を同じ task class で A/B 計測し、総 input/output/cached token、wall time、
delivery retry、manual recovery、親 context 増分を比較する。

## 4. ID と authority

| ID | 用途 | authority |
|---|---|---|
| Hachi task / run / session / fence / message ID | ownership、状態、cancel、replacement、audit | durable authority |
| Claude session `--name` | human-readable discovery hint | authority ではない |
| Claude `ListAgents` ref | その時点の native destination | transient routing |
| Codex `threadId` | SDK / App Server の resume address | adapter address |
| Codex `turnId` | active turn steer / interrupt fence | transient exact target |
| Codex native agent ID / canonical name | live parent-child routing | root tree 内だけ |

session 名だけで配送しない。Hachi の exact run/session/fence を先に検証し、native runtime が返した ref / ID
との binding は additive な `native_session_bindings` に保存する。run metadata は immutable な launch summary に限定する。
binding row は provider、Hachi task/run/session/fence、source orchestrator session/generation、native thread/ref、
Codex tree-root session ID、active turn ID、observedAt、expiry、capability snapshot hashを持つ。配送ごとにfresh rowを
再検証し、native ID から Hachi ID を推測しない。

## 5. delivery contract

既存 `steer_deliveries` を message 全体の唯一の durable lifecycle とする。ただし provider route の試行は
additive な `communication_delivery_attempts` / relay outboxへ分離し、payload reference、route、exact source/target、
claimant session/generation、lease、attempt nonce、receiptを持たせる。delivery、payload、audit commentは同一transactionで
作り、外部I/O前にgeneration-fenced CAS claimする。claim後はSupervisor bridge consumerとmodel-mediated relayが同じ
deliveryを競合処理しない。

1. Hachi DB に queued delivery を作る
2. exact task/run/session/fence と provider equality を再検証
3. runtime capability を probe
4. native delivery を試行
5. native API / built-in tool の受理は `transport_accepted` まで
6. exact message ID を含む receiver evidence が得られた場合だけ `session_observed`
7. receiver の構造化 ack が exact binding と一致した場合だけ `acknowledged`

timeout、ambiguous result、claim後のrelay消失、tool surface 変更は `uncertain` とし、DBだけで取消済みにしない。
`off/observe`ではnative decisionを監査しながら同じqueued deliveryを既存Hachi transportへ送る。
`canary/on`のsame-providerでnative unavailable / unknown / policy refusedならfail-closedとし、silent fallbackしない。
二重配送の可能性があるaccepted / uncertain deliveryはrollout stateに関わらずfallbackしない。

v0.17ではこのうちobserve用recordまでを実装した。v0.18では同じrecorded attemptをfreshな
source/target binding、config、runtime capabilityに結び付けて昇格し、lease/nonce付きclaimからreceiptまでを実装する。
cross-providerと`off/observe/draining`はHachiを維持し、same-providerの`canary/on`だけがCodex App Serverまたは
Claude orchestrator relayを使う。ただしrepo例とlive configは`off`のままとし、実機canaryは別承認gateとする。

選択入力には source orchestrator の stable identity / active session / generation も必須とする。
現在の一般 `task steer` は source provider / provider session を authority として保存しないため、単なる
「worker provider と同じ」という比較では native route を選べない。fenced orchestrator command、または
既存 command への構造化 source principal 追加を先に実装する。

概念境界:

```text
AgentCommunicationTransport
  capability(exact source + exact target) -> supported | unsupported | unknown
  deliver(exact delivery) -> accepted(receipt) | rejected(reason) | unknown(diagnostic)
```

`communication-capability.v1` は model 起動用 `execution-capability.v1` から分離する。
Claudeのmodel-mediated relayは通常adapterと同列にせず、claim/lease/recoveryを持つ独立work-item state machineとする。

## 6. Claude pilot

導入条件:

- macOS / Linux、first-party provider、Claude Code >= 2.1.226
- worker は `--bare` ではなく、session inbox を維持する long-running process
- `--name hachi-<task>-<run>-<role>` の衝突しない表示名
- 宛先は毎回 `ListAgents` で discovery し、衝突時の ref を使用
- unattended receiver は起動 `--settings` で `crossSessionInbound: accept` を要求
- managed / user policy が hold / refuse なら尊重し、勝手に緩和しない
- privacy 系 feature flag / telemetry disable を勝手に unset しない

初期 prompt / skill は「Hachi delivery を先に記録 → capability probe → discovery → native send →
未受理なら既存経路」を教える。skill 自体は機能を enable せず、socket や undocumented protocol を実装しない。

`SendMessage` を外部 TypeScript から直接呼べる公開 RPC は無いため、Claude pilot は live orchestrator
session が durable outbox を generation-fenced claimし、built-in tool を実行し、bounded receipt を Hachi へ
返す relay 方式にする。skill と session name だけでは safe delivery は完成しない。

最初の rollout は same-Mac の Claude↔Claude だけに限定する。cross-machine / Web は実機 smoke と
delivery semantics を別に検証する。

## 7. Codex rollout

用途を2つに分ける。

### A. live Codex coordinator の ephemeral child

read-only research、独立レビュー、短い bounded task のように、親 Codex が lifetime と result を
その turn 内で所有できる場合だけ native subagent を使う。必要な context だけ fork し、self-contained task は
full history を渡さない。

Hachi の独立 worktree、durable restart、host-owned finalize を必要とする worker をこの path へ移さない。

### B. Hachi-owned durable Codex worker

SDK または App Server stdio を provider adapter として評価する。Hachi が `threadId`、tree-root `sessionId`、
active `turnId`、cwd、
model、sandbox、run/fence binding を保持し、top-level thread を直接管理する。実行中 steer / exact interrupt が
必要なら App Server、単純な start/resume/result 回収なら SDK を第一候補とする。

App Server stdio/WebSocketをproduction-readyとみなさず、内部 multi-agent tool 名の固定 hard-code は避ける。
`turn/interrupt`受理はactive turnの中断証拠までで、thread/session treeやdescendant停止の証拠ではない。
replacement解放はexact turn completion、thread inactive、該当session tree descendant drainを別々に確認する。公式面で
後二者を証明できなければ`unknown`のままexact-session stop gateを閉じる。

## 8. capability model（提案）

provider 固有名を core 状態機械へ漏らさず、adapter が次を広告する。

```text
spawn | resume | queue-message | trigger-followup | observe-message |
ack-message | steer-active-turn | interrupt-active-turn | stop-exact-session | close
```

config の pilot switch は実装時に strict schema と doctor を伴って追加する。rollout stateは
`off | observe | canary | on | draining` とし、provider単位、minimum runtime version、same-host制約を明示する。
`draining/off`は新規native claimを止め、未claim queuedだけをneutral fallback可能にし、accepted/uncertainは既存routeで
observation/recoveryを続ける。設計文書だけを根拠に live config を変更しない。

## 9. v0.18 実装と有効化順

1. 実装PRでv20 state machine、Codex/Claude adapter、Supervisor、CLI/doctor、runbookとfake runtime検証を揃える
2. live configを変更せず独立correctness/security reviewを通し、実装とrollout決定を分離してmergeする
3. 別承認でsame-Mac Codex 1件をcanaryにし、exact ack、uncertain recovery、rollbackを実機確認する
4. Claudeはactive orchestrator relayの`ListAgents`/`SendMessage`操作とreceiptを同じ条件で1件確認する
5. 各providerでdelivery failure、uncertain、manual recovery、token coverageのSLO/error budgetを確定後、次のrolloutを判定する

canary昇格/rollbackにはdelivery failure、uncertain、manual recovery、token coverageのSLOとerror budgetを定める。

native delivery のlive有効化は実装PRとは別のlive smoke taskとする。
