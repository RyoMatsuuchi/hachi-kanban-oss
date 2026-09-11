# Native communication current-main residual contract

Status: **review-ready design freeze; implementation and live rollout are not authorized**

Task: `t_325c6b0a2e699265`

Audit date: 2026-08-26

Declared baseline: `0b8009ba09874f1a07c6949260e8aebfb3201460`

Worktree HEAD: `c942bffc93a9cbe078a2ad0466a6b6498e196efa`

Audited current `origin/main`: `c942bffc93a9cbe078a2ad0466a6b6498e196efa`

## 0. Scope and decision

This document re-audits the old `efd2a33a / migration v20` assumptions against current main. It does not authorize a contract, schema, Core, CLI, adapter, Supervisor, host, process, configuration, or live-provider change.

The declared baseline has moved three times. The worktree began at `323d9e0…`; local/remote main then advanced to `3a87d7b…` with `docs/plans/worker-runtime-crash-and-context-guard.md`, and finally to `c942bff…` with contract §75 runtime-generation interruption classification. No Core, CLI, adapter, or Supervisor native communication implementation changed in that delta, so the production file:line evidence below remains stable. Current-main contract §§57 and 75 are now explicit prerequisites: §57 owns durable cancel, exact-session stop, run close, resource/replacement gating; §75 classifies exact generation interruption but does not itself authorize stop, reap, release, or replacement. The native residual references those authorities rather than duplicating them.

### Frozen recommendation

1. Keep the v20 durable native **steer** lifecycle. Do not rebuild bindings, attempts, receipts, Codex `turn/steer`, Claude relay, or the existing Hachi fallback path.
2. Keep `steer` as the only v0.18 native communication intent in this phase. `answer` remains under the existing fenced board question/answer authority; a native-lane answer performs no provider I/O, but it must close the bound native lane and exact owner through the durable §57/§75-safe sequence before the existing body-prepend + ready fallback may consume the answer. `wakeup` remains a best-effort notification for a durable board inbox item and never becomes delivery authority or acknowledgement.
3. Treat the current Codex Desktop/App orchestrator as having **no proven official external, machine-readable message ingress**. Official App Server APIs are usable for a Hachi-owned App Server process/thread, but the official surface inspected here does not document attaching an external Hachi process to the already-running Desktop/App orchestrator's embedded root session. Hooks are lifecycle callbacks, not an arbitrary inbound message endpoint. This is an inference from the documented official surfaces, not a claim about private implementation details.
4. Replace percentage authority for `rollout=canary` with one durable, one-shot **exact run lane selector**. The selector is armed for one task/provider/`worker` role, claimed once before external I/O, bound once to the resulting run/session/cancel fence, and cannot select reviewer, rework, retry, or a second run.
5. Do not create a second native-only process owner ledger. The selector must reference the current-main runtime generation/process owner design and DAG in `docs/plans/worker-runtime-crash-and-context-guard.md:149-297,436-528`, after that plan's C0/C1/V1 chain has turned it into a host-finalized contract/implementation and released its ownership files. Native work adds only the App Server-specific barrier/producer and the lane-to-owner reference. Current `turn/interrupt` and `stop(): unsupported` are not sufficient rollback evidence.
6. Keep successor authority domain-separated. A successor-finalized active session may satisfy the existing narrow source-eligibility predicate, but a successor slot, attestation handle, hook callback, or provider session ID alone must never create a communication source, message ingress, target binding, canary lane, or delivery acknowledgement.
7. Keep repo and live config `off`. Host publication and the exactly-one live canary remain separate human gates after offline full verification and review.

This is the single recommended residual contract. The options that were rejected remain documented so later implementation does not reopen the choice implicitly.

## 1. Evidence method

### 1.1 Strength labels

| Strength | Meaning |
|---|---|
| S1 | Contract plus production implementation plus a focused test exercising the stated invariant. |
| S2 | Production implementation plus focused test, or official provider documentation plus matching local implementation. |
| S3 | Production implementation or a bounded negative search, without an end-to-end test for the complete claim. |
| S4 | Absence boundary inferred from the documented official surface. It is fail-closed evidence for planning, not proof that no private capability exists. |

### 1.2 Normative and official sources

- Board authority, route, lifecycle, rollout, and verification: `docs/contract.md:3591-3705`.
- Successor-only authority, replay, stop, and provider compatibility: `docs/contract.md:3799-4020`.
- Official Codex App Server surface: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- Official lifecycle hook surface: [Codex hooks](https://learn.chatgpt.com/docs/hooks).
- Official Workspace Agent trigger surface: [Trigger Workspace Agent runs](https://learn.chatgpt.com/workspace-agents/trigger-runs).
- Current-main cancel and interruption boundaries: `docs/contract.md` §§57 and 75; runtime generation/owner/stop prerequisite: `origin/main:docs/plans/worker-runtime-crash-and-context-guard.md:149-297,436-528,571-619`.
- Recent operational corrections considered: `k_c3269f27b6f4`, `k_812c4dcf7cd2`, `k_0966b7646c95`, `k_f9ece0fb1aa1`.

The official App Server documentation exposes a JSON-RPC server that a client launches and owns, including `thread/start`, `thread/resume`, `thread/read`, `turn/start`, and exact `turn/steer`. The hooks documentation defines `SessionStart` sources `startup|resume|clear|compact` and a separate `SubagentStart`. The Workspace Agent API starts a new Workspace Agent run. None of those documents a supported external attachment/write path into an already-running Codex Desktop/App orchestrator root thread. Until an official surface says otherwise, the status is `公式入口なし`.

## 2. Current-main v0.18 fact table

The classification applies to the complete capability named in the first column, not to every supporting primitive.

| Capability | Status | Current-main evidence | Focused evidence | Strength | Residual decision |
|---|---|---|---|---|---|
| v19 binding and attempt schema | 実装済み | `packages/core/src/db.ts:1866-1942` creates source/target bindings and attempt rows. Migration application and repair are at `packages/core/src/db.ts:3016-3044`. | Migration self-heal/fail-closed coverage is in `packages/core/src/communication.test.ts:1153-1336`. | S1 | Preserve. A later migration may add the exact-run lane, but must not reinterpret v19 rows. |
| v20 attempt snapshot/lifecycle schema | 実装済み | `packages/core/src/db.ts:1944-1995` adds payload, config/capability/binding hashes, lease, nonce, dispatching, receipt, and timestamps. | `packages/core/src/communication.test.ts:1338-1400`. | S1 | Preserve existing state meanings and additive migration behavior. |
| v21/v22 relation to native communication | 実装済み（非該当） | v21 is steward proposal storage and v22 is liveness incidents at `packages/core/src/db.ts:1997-2065`. | Their presence in migration order is at `packages/core/src/db.ts:3046-3067`. | S1 | Do not assign native residuals to these migrations. |
| v23 successor slot | 実装済み（別domain） | `packages/core/src/db.ts:2067-2151` creates provider-discriminated successor rows and owner-only capability storage. | Contract provider/replay/stop matrix is `docs/contract.md:3819-3992`; CLI source fixture only becomes eligible after successor finalization at `packages/cli/src/commands/communication.test.ts:12-85`. | S1 | Use only the finalized active session's narrow eligibility field. Do not reuse slot/handle/CAS as generic communication authority. |
| Source binding authority | 実装済み（狭い範囲） | `createOrGetNativeSourceBinding` requires the task primary, exact active orchestrator/session/generation, exact provider session, and a provider-matched finalized source at `packages/core/src/db.ts:5506-5533`; refresh is fenced against live attempts at `packages/core/src/db.ts:5536-5588`. | CLI rejects caller-supplied provider/host and derives the active session at `packages/cli/src/commands/communication.test.ts:120-160`. | S1 | Keep. Do not add a generic `register-source --provider-session-id`, slot handle, hook payload, or caller source-kind input. Add readiness that distinguishes an eligible source from any active binding. |
| Target binding | 実装済み | Fixed Supervisor service provenance, exact open run/session/provider, role, and cancel fence are checked at `packages/core/src/db.ts:5696-5744`. | Mismatch, stale generation, and binding/fence tests begin at `packages/core/src/communication.test.ts:639-701`; rebind tests are `packages/core/src/communication.test.ts:1468-1596`. | S1 | Preserve. Add exact run-lane ID/revision to the claim predicates rather than weakening these checks. |
| Neutral route record and native promotion | 実装済み（steer） | Only `intent="steer"` is accepted; initial records remain Hachi/recorded until a fresh service probe promotes the same row at `packages/core/src/db.ts:5828-5905` and `packages/core/src/db.ts:6189-6335`. | Redacted payload/promotion and canary cross-check are `packages/core/src/communication.test.ts:514-624`. | S1 | Preserve `steer`. Do not synthesize steer rows for answer/wakeup. |
| Claim/begin/receipt | 実装済み（steer） | Stored snapshot equality is checked at `packages/core/src/db.ts:6383-6458`; begin atomically moves attempt and steer to dispatching; receipt separates accepted/observed/ack/uncertain. The public narrow interface is `packages/core/src/communication.ts:319-423`. | Full state order and nonce removal are `packages/core/src/communication.test.ts:1338-1400`; pre-I/O reject is `packages/core/src/communication.test.ts:1598-1620`. | S1 | Preserve. Add exact lane ID/revision/hash to promotion and claim for canary only. |
| Claim lease recovery | 実装済み in Core / 部分実装 in Supervisor | Core requeues expired `claimed` and makes expired `dispatching` uncertain at `packages/core/src/db.ts:6794-6854`. Supervisor recovery treats the capability as optional and may skip or fall back to a broader list at `packages/supervisor/src/stages/native-recovery.ts:17-39`. | Core recovery is `packages/core/src/communication.test.ts:1402-1465`; Supervisor redrive is `packages/supervisor/src/native-delivery.test.ts:545-620`. | S1/S2 | Make the narrow recovery/list APIs mandatory before active native rollout. Missing capability must fail readiness/startup, not return a successful tick with a note. |
| Immutable attempt snapshot | 実装済み | Promotion stores config/capability/source/target hashes and exact bindings at `packages/core/src/db.ts:6193-6345`; claim reasserts the stored values at `packages/core/src/db.ts:6422-6440`. Rebind is allowed only while recorded. | Config/capability mismatch and post-dispatch rebind refusal are `packages/core/src/communication.test.ts:1516-1596`. | S1 | Preserve. The residual is the missing immutable **run lane**, not the attempt snapshot. |
| Immutable run/native lane | 部分実装 | Dispatch snapshots the launch config and native evidence into run meta at `packages/supervisor/src/stages/dispatch.ts:370-399`, checks config drift before and after launch at `packages/supervisor/src/stages/dispatch.ts:1530-1547` and `1901-1933`, then creates the run and target binding at `packages/supervisor/src/stages/dispatch.ts:1994-2018`. Native selection itself is recomputed from live config/task ID at `packages/supervisor/src/native-delivery.ts:217-230`. | Current canary test only proves launch/steer use the same percentage cohort at `packages/supervisor/src/native-delivery.test.ts:687-732`. | S2 | Add a durable exact-run lane row with a one-shot launch claim. Run meta is an evidence copy, not the authority. |
| Percentage canary | 実装済み but unsuitable for exact pilot | The pure policy hashes `taskId:provider cohort` at `packages/core/src/policy.ts:54-79`; Supervisor uses it for launch at `packages/supervisor/src/native-delivery.ts:217-230`; Core recomputes it at promotion at `packages/core/src/db.ts:6316-6327`. | Core/Supervisor parity is `packages/core/src/communication.test.ts:570-624` and `packages/supervisor/src/native-delivery.test.ts:716-732`. | S1 | Keep only as legacy/historical compatibility until contract migration. It must not authorize the exactly-one live canary. |
| Codex App Server worker route | 実装済み（Hachi-owned worker） | The adapter is explicitly Hachi-owned at `packages/adapters/src/codex-app-server.ts:373-419`; probe binds exact thread/session/active turn at `packages/adapters/src/codex-app-server.ts:761-797`; delivery sends one `turn/steer` with expected turn and distinguishes accepted/observed/uncertain at `packages/adapters/src/codex-app-server.ts:800-868`. | Fake JSON-RPC lifecycle begins at `packages/adapters/src/codex-app-server.test.ts:350-430`; timeout/version/reconnect/schema fixtures are covered in the same file at `193-345` and `590-684`. | S1/S2 | Preserve worker start/read/steer. Do not reinterpret it as a way to attach to the current Desktop/App orchestrator. |
| Exact Codex worker process/tree stop | 未実装 | `turn/interrupt` is explicitly not thread/process stop, `stop()` returns `stopped:false, reason:"unsupported"`, and capabilities say `exactSession:false, childProcessTree:false` at `packages/adapters/src/codex-app-server.ts:719-749`. Contract §57 forbids run close, ready, resource release, and replacement before exact-session stop confirmation; §75.5 says interruption classification cannot bypass child reap, resource release, or replacement gates. Current main separately freezes runtime-generation and exact child-owner requirements at `origin/main:docs/plans/worker-runtime-crash-and-context-guard.md:149-297,436-528`. | Existing adapter tests validate provider calls but do not establish PID/PGID/tree disappearance. The current-main prerequisite assigns C0/C1 focused coverage at `origin/main:docs/plans/worker-runtime-crash-and-context-guard.md:583-619`. | S2 | Required before exact live canary and before a native-lane answer can fall back to re-ready. Depend on the generic C0/C1 owner/stop contract; add only an App Server-specific barrier/producer and lane reference, not a competing owner ledger. |
| Claude cross-session delivery | 実装済み for the contracted relay | Contracted public built-in boundary and one-shot relay are `docs/contract.md:3662-3680`; CLI claim/begin/receipt enforces exact orchestrator provenance and target ref at `packages/cli/src/commands/communication.ts:507-620`. | Adapter and CLI focused tests cover exact refs, preflight, hook evidence, and receipt parsing. | S1 | Preserve. The current residual is not a second relay implementation. Claude live publication remains separately gated. |
| Supervisor route and receipt | 実装済み（steer） | `prepareNativeSteer` performs fresh source/target/probe checks and promotion at `packages/supervisor/src/native-delivery.ts:677-940`; message delivery rechecks exact run/session/fence before I/O at `packages/supervisor/src/stages/messages.ts:377-464`. | Observe keeps Hachi and active missing native fails closed at `packages/supervisor/src/stages/messages.test.ts:324-411`; adapter outcomes are durable at `packages/supervisor/src/native-delivery.test.ts:296-369`. | S1 | Preserve. Replace percentage selection and remove optional Core capability paths before active rollout. |
| `answer` delivery | 部分実装 / native contract未実装 | The board path has exact answering request and lease checks at `packages/supervisor/src/stages/messages.ts:717-795`, but live injection calls the generic adapter directly and has no v20 dispatching/uncertain receipt row. Codex App Server `inject` calls `turn/steer` without `clientUserMessageId` at `packages/adapters/src/codex-app-server.ts:703-717`. The generic body-prepend + ready fallback does not close an exact native lane or its owner. | Board answer/fallback behavior is tested at `packages/supervisor/src/stages/messages.test.ts:469-625` and end-to-end bridge continuation at `packages/supervisor/src/stages/question-live.integration.test.ts:101-155`; neither freezes the native `bound -> closing -> stop/reap -> run close -> closed` order. | S1/S3 | Keep board authority and forbid provider I/O. For a bound native lane, persist closure intent and finish exact stop/reap, run close, resource readback, and lane close before consuming the answer or executing the body-prepend + non-native ready fallback. Uncertain evidence stays blocked/quarantined. A future native-answer contract still needs its own durable subject/attempt schema and review. |
| Worker question to current Codex App orchestrator | 公式入口なし | Board creates an orchestrator request from exact task/question/worktree at `packages/supervisor/src/stages/orchestrator-routing.ts:57-76`; `hachi orchestrator await` heartbeats the exact board session/generation and claims the queued request at `packages/cli/src/commands/orchestrator.ts:649-695`. The only in-repo `app-wakeup` delivery mode inspected is for cleanup requests and deliberately remains pending without a receipt at `packages/supervisor/src/cleanup-delivery.ts:183-188,291-317`; it is not proof of question ingress. | Board question/answer integration exists; no official Desktop/App attachment test can exist without a supported ingress. | S3/S4 | Keep board inbox as authority and best-effort wakeup only. Do not use transcript, hooks, or caller session ID as message ingress. |
| Doctor/readiness | 部分実装 | The check can represent `config=unset`, but the caller omits the check entirely when communication config is absent at `packages/cli/src/commands/doctor.ts:1460-1465,1738-1742`. It counts all active bindings together and does not prove an eligible source, exact selector, owner wrapper, or same-host pair at `packages/cli/src/commands/doctor.ts:1468-1506`. | Only the configured/off case is tested at `packages/cli/src/commands/doctor.test.ts:97-124`; the legacy unset expected list begins at `126`. | S2 | Always emit an explicit off/unset result. In canary readiness require eligible source, exact armed selector, published owner wrapper/hash, mandatory Core capability, adapter version/schema, and same current host. |
| Fake end-to-end | 部分実装 | Core, CLI, adapter, and Supervisor each have focused fakes/unit tests, but the bounded search found no single clean-DB test that crosses selector claim → owner bind → run bind → source/target → native attempt → provider observation/ack → restart/recovery/stop. | Existing pieces are cited above. | S3 | E must add a no-provider, no-browser clean-DB integration matrix before full verification. |

## 3. Trusted ingress and trust-root boundary

### 3.1 Surface comparison

| Surface | Startup / resume / compact / clear | Root versus subagent | Identity and environment binding | TTL / replay / consume | Can external Hachi write into the current Codex App orchestrator? | Decision |
|---|---|---|---|---|---|---|
| Successor `SessionStart` attestation | `startup` creates once; `resume` returns the same handle without extending TTL; `compact|clear` create nothing (`docs/contract.md:3914-3921`). | `SubagentStart` and `agent_id` input are rejected. | Exact stable orchestrator, source generation, cwd, host, tmux pane/PID/PGID, owner and static hook/helper hashes (`docs/contract.md:3888-3912`). | One slot, bounded handle, one final consume; consume/replay rules are successor-only. | No. It proves a successor launch callback and enables one successor final transaction. It is not an arbitrary later-message endpoint. | Keep as successor authority only. After finalization, `provider_session_source` is one narrow eligibility predicate for source binding, never sufficient on its own. |
| Caller-supplied/manual provider session | No provider-generated callback proof. | Cannot prove root; a displayed session ID/name is ambiguous. | Caller pair may be accepted only by the manual successor compatibility path; source is `manual` (`docs/contract.md:3982-3992`). | No trusted one-time consume. | No. | Native source eligibility is false. Never promote it with a generic register command. |
| Codex App Server launched and owned by Hachi | `thread/start` or `thread/resume`, then `turn/start`; exact reads and steers are official. | App Server `thread.sessionId` identifies the root tree; child/fork identity is not board authority. | Hachi owns the Unix socket and pins runtime/schema. Local code stores socket snapshot, thread, session, active turn, host and TTL. | Binding TTL and message attempt nonce are Hachi-owned. `expectedTurnId` fences a steer, not a process. | Yes, for the Hachi-owned App Server thread only. | This is the trusted target ingress for native worker steer. It does not establish ingress to the Desktop/App orchestrator. |
| Codex lifecycle hooks outside successor slot | Hooks run on lifecycle events; they are not an RPC listener. `SessionStart` has `startup|resume|clear|compact`. | `SubagentStart` is a separate event with agent identity. | Hook payload fields are event context, not durable board authority unless consumed through the successor contract. | Hook repetition follows lifecycle events; no general message nonce/receipt contract. | No documented arbitrary write path. | Do not add a generic hook that reads a queue/transcript or injects Hachi messages. |
| Workspace Agent trigger API | Starts a new Workspace Agent run. It does not resume the already-running local Codex App root. | New run, not current root/subagent targeting. | Workspace Agent ID and API authorization, not local Hachi task/run/session/fence. | API request semantics do not supply the local board consume/ack contract. | No. | Out of scope; do not use it as a wakeup or current-session ingress. |
| Board inbox plus best-effort app wakeup | Board request is created independent of provider lifecycle. Poll remains available. | Stable orchestrator watches and board session/generation select the owner; no provider child identity is trusted. | Exact request/task/question/worktree/project and orchestrator claim token/generation. | Durable pending/claim/answer states; wakeup receipt absence leaves the item pending. | It can notify the app if a supported wakeup exists, but it does not inject the question as a provider-native message. | Recommended current worker→orchestrator path. |

### 3.2 Non-composition rule for successor authority

The following composition is allowed:

```text
successor slot final transaction
  -> active orchestrator session with provider_session_source
  -> task-primary + exact active session/generation/provider recheck
  -> finite-TTL native source binding
```

Every arrow is a new domain check. The first row alone grants none of the later rights.

The following compositions are forbidden:

- slot ID or attestation handle directly creates `native_session_bindings`;
- `SessionStart.session_id` is supplied to `communication binding register-source` by a caller;
- a generic session start/handoff/takeover API accepts `codex-session-start|claude-delivery` from the caller;
- a successor source session authorizes a target run, selector row, native route, or receipt without the task-primary/run/fence/binding checks;
- a hook callback doubles as a Hachi queue consumer or wakeup acknowledgement;
- successor stop/rollback rows are reused as native worker process ownership rows.

The current Store enforcement at `packages/core/src/db.ts:5506-5533` is therefore retained as a narrow downstream check, not promoted into a generic trust-root API. The exact-run lane is a communication-domain table and capability separate from successor authority. After X is finalized, process identity and stop evidence come by exact reference to that separately reviewed runtime-generation/process-owner ledger; the lane never copies or redefines successor slots or runtime owner truth.

## 4. Delivery intent contract

| Intent / direction | Durable authority | Exact target | Provider operation and evidence | Uncertain rule | Fallback rule | Frozen result |
|---|---|---|---|---|---|---|
| `steer`: orchestrator → running worker | `agent.message.v1`, `steer_deliveries`, exact active task-primary orchestrator provenance, v20 attempt, and for canary an exact bound run lane. | Task + open run + Hachi session + provider + role + cancel fence + fresh target binding + exact thread/turn or Claude agent ref. | Codex: one `turn/steer` after claim/begin. JSON-RPC success=`transport_accepted`; exact message-key observation=`session_observed`; worker's exact board receipt=`acknowledged`. Claude retains its one-shot relay. | Timeout/disconnect after begin is `uncertain`; no Hachi or second-native retry. | `off|observe|draining`, cross-provider, legacy provenance, or canary without selector use Hachi before native claim. Active native selected but unavailable is fail-closed. | **Native v0.18 supported and retained.** |
| `answer`: orchestrator/human → worker question | Existing `orchestrator_requests` claim/answering/answer-key and question answer lease remain the sole answer authority. The exact native lane and generic owner ledger are the shutdown authority; this is not a `steer_delivery` or native-answer attempt. | Exact request/question/task, answering session/generation/claim token, bound lane/revision, open run/session/cancel fence, and exact generic owner reference/revision/stop fence. | Existing non-native/bridge path may inject under the established answer contract. For a run carrying an exact native lane, no provider answer I/O is authorized. Supervisor first persists `bound -> closing`, then uses only the generic exact-owner stop/reap path; §75 interruption evidence is correlation only and cannot substitute for §57/C0/C1 stop and reap confirmation. | Stop uncertainty, owner mismatch, an open run after stop, or unreleased session/resource guard records a durable recovery checkpoint, leaves the answer unconsumed, and keeps the task blocked plus lane `closing|quarantined`. It never waits only on an ephemeral answer lease or lane predicate. | Only after exact stop/reap, run close, session/resource release readback, and `closing -> closed` may one fenced transaction mark the exact answer processed, resolve the request, prepend the body, and re-ready as non-native. The one-shot selector is never reused; a later native run requires a new human gate. | **Board-only with close-before-fallback.** Native answer is a separate future contract, not hidden inside A–E. |
| `wakeup`: worker question/inbox → current orchestrator | `orchestrator_requests` pending/claim state and watch/controller selection. | Stable orchestrator ID + active board session/generation + exact request. Provider session ID is notification metadata only. | Poll is canonical. A supported app wakeup may emit a notification; absence of a receipt leaves pending. No transcript/hook scan. | Wakeup timeout, missing capability, or app closed leaves the request pending. Never mark delivered/claimed/answered. | Poll/`hachi orchestrator await` remains available. Human escalation follows the existing liveness policy. | **Board inbox + best-effort wakeup retained; no native message ingress.** |

Why `answer` is not generalized now: reusing `steer_deliveries` would forge the subject and authority; calling `CodexAppServerAdapter.inject` directly can time out after side effect and has no message ID; rebuilding `communication_delivery_attempts` into a generic subject table materially widens migration and review scope. The safe bounded choice is a pre-I/O guard followed by durable native-lane shutdown and only then the existing board fallback. This is not a wait on lane state: the handler persists a closure checkpoint before side effects, advances it by bounded reconciliation, and escalates an unresolved checkpoint to orchestrator recovery. A future native answer proposal must compare a separate answer-attempt table against a properly generalized delivery table and must preserve current question leases and terminal reconciliation.

## 5. Immutable lane and exact canary

### 5.1 What is already immutable

- A promoted attempt freezes route, exact source/target binding IDs and hashes, config snapshot/hash, capability hash, delivery/run/session/fence, and redacted payload.
- Claim revalidates the stored snapshot and fresh authority. Only a `recorded` attempt can rebind a fresh target; dispatching and later states cannot.
- Dispatch snapshots the full config file and execution policy around launch and stores native evidence in run meta.

Those protections are attempt- and launch-observation-level. They do not answer “which exact run was the one approved live canary?” Percentage selection is recalculated from task/provider and intentionally selects worker, reviewer, rework, and later runs together (`docs/contract.md:3691-3693`). That property prevented lane mismatch in the old cohort design but violates exactly-one canary scope.

### 5.2 Option comparison

| Option | Exactly one task | Exactly one run | Restart/replay safe | Reviewer/rework excluded | Crash after spawn handled | Decision |
|---|---:|---:|---:|---:|---:|---|
| Percentage cohort (`canaryPercent`) | No | No | Deterministic but broad | No | No owner record | Reject as live-canary authority. |
| Config task-ID allowlist | Yes while config is exact | No; retry/rework of the same task remains selected | Config drift/removal races with launch | Not without more selectors | No | Reject. It is mutable configuration, not a one-shot claim. |
| Durable selector row bound only after `startRun` | Yes | Yes after bind | Partly | Yes | No; process/thread may already exist before row bind | Reject. It leaves the launch-to-bind orphan window. |
| Durable one-shot run lane referencing the generic owner ledger, plus an App Server pre-exec barrier | Yes | Yes | Yes, by CAS/revision/fence | Yes | Yes, by a quarantined lane and blocking runtime owner state | **Recommend.** |

### 5.3 Frozen exact-run lane

Use a new communication-domain narrow capability and table, tentatively named `native_communication_run_lanes`. The migration number is **the next free number at implementation time**; this document does not reserve `v24` because main and other migration work may advance first. The row selects and binds a communication canary run. It references, but does not replace, the runtime-generation/process-owner records to be finalized by current-main A1/C0/C1.

Minimum durable fields:

- stable lane ID and constant board scope key `native-live-canary.v1`;
- exact task ID, target provider, fixed role=`worker`, route, human approval/audit reference, arm expiry;
- state, revision, created/updated/terminal timestamps;
- one-time launch claim token hash/fence and claimant fixed Supervisor service provenance;
- expected canonical cwd and host;
- exact `runtimeGenerationId` and `processOwnerId` references plus the expected owner revision/stop fence from the generic ledger;
- planned App Server socket and barrier/helper publication hashes needed to bind the producer to that owner row;
- run ID, Hachi session ID, provider session/thread ID evidence, expected cancel fence;
- immutable communication config hash, adapter runtime/schema/capability hash, target binding ID/hash;
- close/recovery reason and the referenced owner terminal state/revision;
- optional native-lane answer recovery checkpoint: exact `answerKey`/request ID, task/run/session/cancel fence, lane and owner revisions, phase, bounded retry/deadline, last redacted evidence code, and deduplicated orchestrator recovery request ID. It contains no answer text, claim token, raw capability, or provider payload;
- error/reason. PID/PGID/process-start/parent/exit/reap and raw stop capabilities remain solely in the generic owner ledger and its owner-only capability boundary; the lane never duplicates them into JSON, comments, artifacts, or logs.

State machine:

```text
armed -> claimed -> bound -> closing -> closed
  |         |         |          |
  +-> revoked|expired +----------+-> quarantined
                                      |
                                      +-- exact fenced recovery --> closing
```

Rules:

1. A partial unique index permits exactly one board-wide blocking lane in `armed|claimed|bound|closing|quarantined`. `quarantined` never expires or self-clears into a reusable state. Its only outgoing edge is an explicit, fenced orchestrator/host recovery that revalidates the exact task/run/session/fence, lane revision, generic owner identity/revision, and canonical readback before returning to `closing`; it never returns to `armed|claimed|bound`.
2. Arm is a host/human mutation after publication and offline verification. It requires an exact ready task, provider, role=`worker`, bounded expiry, review reference, live config still unchanged, and zero blocking lane.
3. Before any external process I/O, Supervisor atomically performs `armed -> claimed`, binding the task claim, config hash, host, cwd, wrapper/helper hashes, planned socket, and one-time launch fence. A percentage result or caller-provided lane ID is never authority.
4. In the same launch protocol, the generic runtime-generation/owner API creates the exact owner record. The adapter launches a dedicated per-lane App Server through a reviewed one-shot barrier and emits the App Server-specific owner evidence required by A1/C0/C1. The barrier is released only after the generic owner row is durably bound. Missing or mismatched generic owner evidence sends the lane to `quarantined`; native code must not create an alternative PID/PGID ledger.
5. After `thread/start` and `turn/start`, one transaction creates the task run, binds runtime resources, creates the target binding, and performs `claimed -> bound` with exact owner reference/revision, run/session/fence/provider/thread/config/capability. Failure moves the lane to `closing` or `quarantined` according to the generic owner state; it never re-arms.
6. Every canary native attempt must reference the bound lane ID/revision/hash. Promotion and claim recheck the row is `bound`, exact run/session/provider/role/fence match, the task remains the selected task, and cancel fence is zero.
7. Multiple `steer` attempts are allowed only within that one bound run. The selector is one-shot per run, not one-shot per message.
8. Reviewer, rework, auto-launch retry, legacy run, second worker run, different provider, different host, or a run without the exact bound lane is not canary-selected. `rollout=canary` uses Hachi before native claim in those cases; explicit native is refused.
9. Normal completion, cancel, config/capability drift requiring shutdown, bind failure, host rollback, or a native-lane answer moves `claimed|bound -> closing` and delegates stop/reap to the exact C0/C1 predicate. The required durable order for a bound lane is `bound -> closing -> exact stop/reap -> run close -> closed`. The final `closed` CAS additionally requires canonical readback that the exact run is closed, the worker/session binding is releasable, every bound §56 resource guard/member is released (or that no resource was bound), and the native socket is absent. §75 `stopped|replaced` transition or `runtime_generation_interrupted` classification alone cannot satisfy these §57/C0/C1 gates.
10. A native-lane answer handler must atomically persist the exact answer recovery checkpoint while moving `bound -> closing`, before releasing its ephemeral `question_answering` lease or attempting stop. Only after rule 9 reaches `closed` may one exact-answer-key transaction mark the message processed, resolve the request, prepend the answer to the body, and move the task from blocked to `ready` as non-native. A crash between `closed` and that transaction is reconciled idempotently from the checkpoint; it cannot relaunch or redeliver native work.
11. Stop `unknown|unsupported|rejected`, owner mismatch, missing readback, an open run after stop, unreaped child/tree/socket residue, or an unreleased session/resource guard keeps the task blocked and moves the generic owner and lane to their blocking unknown/`quarantined` state. The answer stays unconsumed; body and task status remain unchanged. Ready, replacement, reviewer/rework/retry, and native resend are forbidden.
12. `closing` reconciliation has a finite durable deadline and bounded backoff. It never waits indefinitely on only a lane predicate or ephemeral answer lease. Exhaustion or any non-retryable mismatch writes redacted uncertain evidence, moves to `quarantined`, and creates/deduplicates an existing §55 orchestrator recovery request keyed by lane revision and answer key. Recovery may resume `quarantined -> closing` only after canonical read views prove the exact owner terminal/reaped, child tree and socket absent, exact run open/closed state, and §56 release eligibility under the same fences; otherwise it remains blocked and may be escalated to the human/host path without process or resource mutation by the answer handler.
13. Run meta keeps a secret-free copy of lane ID/revision/config hash for diagnosis. The row is authority.
14. `rollout=on` remains a later publication decision. The exact selector is mandatory for `canary`; the old percentage helper may remain only for backward-compatible read/observe until a reviewed contract migration removes it.

### 5.4 Config drift, cancel, reviewer, and legacy boundaries

| Situation | Required behavior |
|---|---|
| Config changes before lane claim | Claim CAS fails; no process starts. Lane may remain armed only if its original hash still matches, otherwise revoke/expire by explicit mutation. |
| Config changes after claim but before spawn | Revoke only if the generic runtime-generation pre-spawn predicate proves no runtime was created; otherwise `quarantined`. Do not launch. |
| Config changes after spawn/runtime bind | Move lane to `closing`; use C0/C1 exact owner stop. `quarantined` on incomplete evidence. Do not change the lane snapshot or fall back. |
| Config changes after attempt promotion | Stored attempt snapshot wins; claim mismatch fails. After begin, result is uncertain/no fallback. |
| Cancel begins | Reject new promotion/claim, stale-cancel queued steers, transition lane to `closing`, and keep replacement closed until the referenced owner is exact-terminal/reaped. |
| Native-lane answer is accepted | Perform no provider I/O. Persist the answer recovery checkpoint and `bound -> closing`; complete exact stop/reap, run close, resource readback, and `closing -> closed` before exact-key consume/body prepend/non-native ready. |
| Native-lane answer close is uncertain | Keep answer unconsumed and task blocked; move the lane/owner to blocking `quarantined`, create the deduplicated orchestrator recovery request, and forbid ready/replacement/native resend until exact fenced readback permits recovery. |
| Replacement/retry | No selector reuse. A claimed/bound/closing/quarantined lane or blocking generic owner row stops it. |
| Reviewer/rework | Fixed role mismatch means non-native. A new live canary requires a new human-approved lane after the previous lane is `closed` and its owner is exact-terminal. |
| Legacy launch without lane | It may use the established Hachi route. It must never receive a native steer because current config later changed to canary. |

## 6. Fail-closed counterexamples

| Counterexample | Required refusal / terminal state | Evidence that may not be substituted |
|---|---|---|
| Caller forges provider session ID or `provider_session_source` | Source registration mutation 0. | Display name, CLI flag, env, transcript, task body. |
| Stale orchestrator generation or non-primary task owner | Source registration/promotion/claim mutation 0. | Stable orchestrator ID without active exact generation. |
| Replayed successor handle after consume | Successor mutation 0; no new source binding. | Previously accepted session ID or hook output. |
| `SubagentStart`, `agent_id`, child/fork session | No root source attestation and no current-orchestrator ingress. | Root session ID inferred from child metadata. |
| `resume` after successor consume | Existing board session remains; no new handle/binding/lane. | A repeated hook callback. |
| `compact|clear` hook | Record no successor/source/message authority. | Transcript path or continuation text. |
| Provider mismatch | Hachi cross-provider route before claim, or refuse explicit native. | Same host or similar provider session names. |
| Host mismatch / multiple possible hosts | Readiness and native claim fail. | A single hostname from caller payload. |
| Socket inode/owner/runtime/schema drift | Refuse before I/O when possible; after begin record uncertain. | Canonical path string alone. |
| Active turn/thread/session changed after probe | Rebind only while recorded; otherwise reject/uncertain. | Previous run meta or stale binding TTL. |
| Binding expired | No native promotion/claim. | Recent task heartbeat or process existence. |
| Percentage selects several tasks | No authority. Only exact armed lane can select canary. | Low `canaryPercent`. |
| Task allowlist remains during retry/rework | Retry/rework is non-native. | Same task ID. |
| Selector claim replay | CAS mutation 0; same raw capability is never returned twice. | Matching task/config without revision/fence. |
| Crash before process spawn | Only the generic runtime-generation exact pre-spawn predicate may revoke; otherwise `claimed -> quarantined`. | Absence of a run row alone. |
| Crash after spawn before generic owner bind | Generic runtime owner unknown/quarantine plus lane `quarantined`; block replacement. | `turn/interrupt`, timeout, next Supervisor tick. |
| Crash after owner bind before run bind | Lane `closing|quarantined` until C0/C1 exact terminal/reap evidence. | Socket disappearance alone. |
| Run/target bind transaction fails | Lane `closing`; no second launch. `quarantined` if the referenced owner cannot be exactly stopped. | Task claim still being present. |
| Config drift during launch | Isolate spawned session and close lane through exact stop. | Reloaded config matching the new value. |
| Cancel fence changes during probe or delivery | Reject before begin; after begin uncertain/no fallback. | Task still showing in-progress. |
| JSON-RPC timeout after `turn/steer` | `uncertain`; do not resend through Hachi/native. | Missing response, missing thread observation. |
| Provider returns success without receipt | `uncertain`, never accepted/acknowledged. | RPC success boolean. |
| Message visible in provider thread but no board ack | At most `session_observed`. | Provider UI or transcript text. |
| Native-lane `answer` would call generic inject or direct fallback | Do not perform provider I/O or consume the answer. Persist `bound -> closing` and the recovery checkpoint; board fallback is not eligible until exact close succeeds. | Existing `question_answering` lease, pre-I/O guard, or answer text already stored. |
| Native-lane answer stop is `unknown|unsupported|rejected` | Task stays blocked, answer unconsumed, lane/owner `quarantined`; ready/replacement/native resend mutation 0. | Timeout, cooperative ack, `turn/interrupt`, or elapsed lane deadline. |
| Native-lane answer stop owner mismatches | Do not signal. Persist mismatch evidence, quarantine, and route exact recovery to the orchestrator. | PID/PGID/name similarity, cached nonce, current task ownership, or caller assertion. |
| Exact stop is confirmed but the run remains open | Do not close the lane, consume/prepend the answer, or ready the task; reconcile the exact run close under the same fence or quarantine. | Stop result, §75 interruption classification, or absence of provider output. |
| Run is closed but child/socket/session/resource release readback is incomplete | Keep lane/task blocked or quarantined; no ready/replacement/native resend. | `run.status=failed|released`, socket disappearance alone, lease expiry, or cleanup eligibility inferred from age. |
| Wakeup missing/fails | Board request remains pending/pollable. | Notification attempt, heartbeat automation, app window activity. |
| Recovery API absent from Store | Active readiness/startup failure. | A successful Supervisor tick with a “skip” note. |
| Redrive list falls back to all attempts | Refuse active startup; require exact redrive API. | Filtering after a broader compatibility read. |
| Owner mismatch at stop | Do not signal; mark uncertain. | PID/PGID name match, prefix/glob, stale cached nonce. |
| Only thread interrupted | Keep stop unproven. | `turn/interrupt` RPC success. |
| PID gone but PGID/socket remains | Keep uncertain. | Any one of the three absence checks. |
| Manual successor/current Desktop session | Native source eligibility false and no external ingress. | Caller-provided provider/session pair. |

## 7. Readiness contract

The Doctor check must always be present, including when communication config is omitted:

```text
config=unset rollout=off native-io=forbidden
```

For `off|observe|draining`, missing adapter/binding/selector is informational and native I/O count must remain zero. For `canary`, online readiness is `ok=true` only if all of the following are independently reported:

- exact eligible source binding: kind=`source`, active, finite TTL, provider-matched finalized active orchestrator session, exact primary task, same current host;
- exactly one armed lane for the requested task/provider/role, bounded approval reference and expiry, no other blocking lane;
- required Core lane, promotion, claim, begin, receipt, recovery, exact redrive-list, and stop/recovery capabilities present through a narrow intersection (not `Partial`);
- reviewed owner wrapper/helper is installed at the canonical path and its definition/executable hashes match;
- adapter runtime/schema checksum and socket/owner readback support match the frozen contract;
- `minimumRuntimeVersion`, `sameHostOnly=true`, and immutable config hash are valid;
- no unresolved native attempt, no `claimed|bound|closing|quarantined` lane, no pending native-answer recovery checkpoint, and no blocking referenced runtime owner/run/session/resource guard;
- live config change and selector arm are still shown as separate host/human actions.

Offline Doctor may mark runtime probes `skipped:offline`, but must still validate config shape, Store capability presence, migration/table/index shape, selector cardinality, static publication hashes, and unresolved blocking rows. It may not return `ok=true` for canary merely because a target binding exists; current code's aggregate `activeBindings` count is insufficient.

## 8. A–E disposition

No child task should run from its old body. Each implementation task first receives the frozen residual scope and current `origin/main` SHA; old v20 work is explicitly out of ownership.

| Task | Disposition | Retained residual | Removed as already complete / unsupported | Dependencies |
|---|---|---|---|---|
| A `t_0191e77056b6a8be` — Core authority/CAS | **残差specへ縮小** | Implement only the exact-run communication lane schema and narrow Store CAS, referencing the generic runtime generation/owner IDs and revisions once X has finalized them; include the redacted answer-close checkpoint and fenced `quarantined -> closing` recovery edge without creating a native-answer attempt lifecycle; add lane ID/revision/hash to canary attempt promotion/claim; preserve migration repair and v20 rows; retire percentage as canary authority without touching frozen `types.ts`. | Existing source/target binding, steer attempt, nonce/lease, receipt, and rebind/recovery lifecycle. No `answer|wakeup` delivery generalization and no duplicate PID/PGID/stop schema. | Current-main runtime C0/C1/V1 host-finalized and ownership released; then new Gate 0. |
| B `t_659808565415d915` — trusted source/off-readiness | **残差specへ縮小** | Always-visible unset/off Doctor result; distinguish source/target and successor-eligible source; exact selector/generic-owner/static-hash readiness; exact lane arm/list/show/revoke CLI with human/host provenance and redacted output. | Existing source registration and read models. No hook, transcript, caller provider/session, generic source kind, Desktop/App ingress implementation, or competing owner diagnostic. | Runtime prerequisite, Gate 0 and A; C publication schema for hash checks. |
| C `t_d5eae605a30b7580` — exact App Server protocol | **残差specへ縮小** | Dedicated per-lane App Server runtime, reviewed pre-exec barrier/wrapper, and the App Server-specific producer/readback that binds socket/process evidence into the frozen generic owner ledger before thread start; fake crash tests and exact consumption of C0/C1 stop/reap results. | Existing `initialize`, `thread/start/read`, `turn/start`, exact `turn/steer`, receipt parsing, reconnect, schema/runtime drift. No current Desktop/App attach, no native answer/wakeup, and no new owner/stop state machine. | Runtime prerequisite, Gate 0 and A's lane CAS. |
| D `t_a94728b36d2fdea2` — Supervisor lane/route/recovery | **残差specへ縮小** | Claim exact lane before external I/O; bind the frozen generic runtime owner then run/target atomically; use bound lane for steer; make Core native capability/recovery exact and mandatory; remove broad redrive fallback; reflect cancel/finalize/reap through the generic owner terminal predicate; for native-lane answer, forbid provider I/O and enforce durable `bound -> closing -> exact stop/reap -> run close -> closed` plus resource readback before exact-key board consume/body prepend/non-native ready, with quarantined orchestrator recovery on uncertainty. | Existing fresh probe, route/promotion, claim/begin/receipt, post-begin no-fallback, Claude relay, current focused tests, and generic stop/reap logic. | Runtime prerequisite, A, B, C. |
| E `t_74ec5d6c51c1695d` — fake E2E/read model/runbook | **依存更新後に実行** | Clean-DB fake E2E for one selector/run, adjacent non-selected task, restart/recovery, cancel/uncertain/stop, native-answer close-before-fallback success and fail-closed counterexamples, source replay, unset/off zero I/O; update safe read model and runbook; full verification evidence. | Do not duplicate component unit tests or claim live evidence. Existing runbook percentage instructions are not publication authority. | D complete and reviewed. |

None is safe to promote in its current old scope. “盤外完了archive” applies to the removed subscopes, not to a whole child task, because each child still has a bounded residual. If the board cannot atomically replace task bodies, archive the old child and create the correspondingly named residual task rather than appending contradictory instructions.

## 9. Implementation DAG and ownership

```text
X current-main runtime prerequisite
  A0/A1 -> B0/B1 -> C0/C1 -> V1 host-finalized + ownership released
    -> G0 native contract / frozen narrow types
      -> A Core lane / migration / CAS
          -> B CLI / readiness ------------------+
          -> C App Server barrier / owner producer+-> D Supervisor immutable lane
                                                    -> E fake E2E / read model / runbook
                                                      -> V native full verification + independent review
                                                        -> H host publication (config still off)
                                                          -> L human-approved exactly-one live canary
```

`X` is not reimplemented by A–E. It is the current-main DAG in `origin/main:docs/plans/worker-runtime-crash-and-context-guard.md:571-619`. In particular, C0 reconciles contract §§34.2.2/51/57 and C1 owns the generic process ledger, reap predicate, and Doctor counts. Its `db.ts`, `dispatch.ts`, adapter, Doctor, cancel/finalize/reap, and contract ownership must be host-finalized and released before native residual work becomes ready. If the orchestrator wants a different order, it must first amend that current-main DAG; native tasks must not silently create parallel schema or signal logic.

### G0 — contract and frozen narrow types

Purpose: land the communication lane state machine, intent boundary, selector fields, capability inputs/outputs, migration compatibility, and exact references to the then-finalized runtime owner/stop evidence before implementation.

Owned files:

- `docs/contract.md` §68 and only directly necessary cross-references to §§70–73;
- new `packages/core/src/native-communication-lane-contract.ts` for the reviewed narrow row/input/result/capability interfaces;
- `packages/core/src/index.ts` only to export the frozen narrow contract.

Must not edit `packages/core/src/types.ts`. The contract must state that the next migration number is resolved from current main at execution time. It must import/reference the finalized runtime-generation/process-owner contract rather than restating PID/PGID/stop rows. Review must reject any API accepting caller provider session source, lane owner values, runtime proof, receipt, or stop evidence without an exact stored fence/revision.

### A — Core / migration / CAS

Depends on X host-finalize/file release and G0.

Owned files:

- `packages/core/src/db.ts`;
- `packages/core/src/communication.ts`;
- `packages/core/src/policy.ts`;
- `packages/core/src/db.test.ts`;
- `packages/core/src/communication.test.ts`;
- `packages/core/src/policy.test.ts`.

Acceptance:

- additive/self-healing migration preserving v19/v20/v23 data and status meaning;
- partial unique blocking-lane constraint and unique run binding;
- lane arm/claim/run-bind/closing/closed/quarantine CAS with service/human provenance and exact generic owner ID/revision predicates;
- answer-close checkpoint and recovery CAS store only exact identifiers/redacted phase evidence, require the same lane/owner/run/session/cancel/resource fences, and cannot mark the answer consumed, mutate task body/status, or synthesize native delivery authority;
- no PID/PGID/process-start/parent/stop capability columns or competing raw owner capabilities in the lane table;
- canary promotion/claim requires exact bound lane; percentage alone cannot pass;
- forged/stale/replay/provider/host/cwd/config/cancel/role/run/owner-reference mismatches mutation 0;
- `quarantined` and any blocking referenced owner state stop replacement and cannot expire automatically;
- existing v20 steer lifecycle tests remain green.

### B — CLI and readiness

Depends on X host-finalize/file release, G0, and A.

Owned files:

- `packages/cli/src/commands/communication.ts`;
- `packages/cli/src/commands/communication.test.ts`;
- `packages/cli/src/commands/doctor.ts`;
- `packages/cli/src/commands/doctor.test.ts`;
- command registration/help files only if required by the new subcommands.

Acceptance:

- `communication canary arm|list|show|revoke` uses structured human/host provenance, exact task/provider/worker role, approval reference and bounded expiry;
- no caller input for provider session source, generic owner identity/PID/PGID/socket observation, raw nonce/fence, or stop evidence;
- read output is secret-free and shows lane state/revision/run/fence/config/static hashes and unresolved reason;
- Doctor always emits unset/off; active readiness distinguishes exact source, target, selector, owner wrapper, capabilities and blocking rows;
- offline mode validates static/schema/cardinality without performing provider/network/process I/O.

### C — Codex App Server barrier and generic-owner producer

Depends on X host-finalize/file release, G0, and A.

Owned files:

- `packages/adapters/src/codex-app-server.ts`;
- `packages/adapters/src/codex-app-server-rpc.ts` only if split lifecycle support requires it;
- a new bounded barrier/owner-evidence producer under `packages/adapters/src/` and its static template/assets;
- `packages/adapters/src/codex-app-server.test.ts` and new owner/barrier focused tests;
- generated schema files only if an official method/schema actually changes.

Acceptance:

- per-lane dedicated process/socket; no shared App Server can satisfy exact canary ownership;
- barrier prevents provider thread/turn creation until the generic runtime owner CAS succeeds;
- App Server-specific canonical cwd/host/socket and child lifecycle evidence satisfies the frozen generic generation/owner writer interface;
- stop/reap calls only the C0/C1 capability and consumes its exact result; this task does not define a second signal predicate or terminal proof;
- spawn/bind/barrier/thread/bind crash points are deterministic in fake tests;
- `turn/interrupt` remains cooperative only and never returns exact stop;
- no API for attaching to the current Desktop/App orchestrator.

### D — Supervisor immutable lane

Depends on X host-finalize/file release, A, B, and C.

Owned files:

- `packages/supervisor/src/native-delivery.ts`;
- `packages/supervisor/src/stages/dispatch.ts`;
- `packages/supervisor/src/stages/native-recovery.ts`;
- `packages/supervisor/src/stages/messages.ts`;
- the minimum cancel/finalize integration files required to reference the frozen generic owner terminal result; generic reap implementation remains X/C1-owned;
- their colocated focused tests.

Acceptance:

- active native Store capability is a required narrow intersection, not `Partial`;
- no successful tick that silently skips native recovery and no `listCommunicationAttempts` compatibility fallback;
- selector claim occurs before external launch; generic runtime-owner bind precedes barrier release; run/target/lane bind is one transaction;
- launch, steer, cancel, finish, reviewer/rework, config drift, and replacement all read the same immutable lane row;
- native-lane answer performs zero provider I/O and atomically records the exact answer/lane/owner recovery checkpoint with `bound -> closing` before stop/reap begins;
- the success-focused test proves the durable order `bound -> closing -> exact owner stop -> child/socket reap -> run close -> resource/session release readback -> closed -> exact answer consume/body prepend/non-native ready`, including crash recovery between `closed` and the final exact-key transaction with no duplicate prepend;
- focused fail-closed tests cover stop `unknown|unsupported|rejected`, owner mismatch with no signal, stop-confirmed but open run, and closed run with unreaped child/socket or unreleased resource/session guard. Each leaves the answer unconsumed and task/lane blocked or `quarantined`, emits one orchestrator recovery request, and produces zero ready/replacement/native-resend mutations;
- `closing` uses bounded durable reconciliation; deadline exhaustion quarantines and escalates instead of waiting forever on a lane gate or `question_answering` lease. Exact fenced readback is required for orchestrator recovery back to `closing`;
- any post-spawn ambiguity makes the generic owner blocking/unknown and the lane `closing|quarantined`, blocking replacement/canary reuse;
- off/observe/draining/cross-provider/legacy behavior remains unchanged.

### E — fake E2E, read model, and runbook

Depends on D.

Owned files:

- new `packages/supervisor/src/native-communication.integration.test.ts` or an equivalently isolated integration file;
- `runbooks/native-provider-messaging-pilot.md`;
- `docs/plans/native-provider-messaging.md` only for supersession pointers and removal of percentage-as-exact-canary wording;
- read-model tests that do not overlap B's CLI implementation files.

Required clean-DB fake scenarios:

1. unset/off/observe/draining and cross-provider perform zero native owner/adapter I/O;
2. exactly one armed task creates exactly one dedicated runtime, one generic owner record, and one bound worker run;
3. adjacent task, second worker run, reviewer, rework and auto-retry are not selected;
4. trusted successor-finalized source succeeds; manual, forged, stale, replay and subagent-like inputs fail;
5. accepted, observed, acknowledged, explicit pre-I/O reject and post-begin uncertain remain distinct;
6. Supervisor restart with the same DB resumes only recorded/claimed-safe work and never resends dispatching;
7. crash at lane claim, spawn, generic owner bind, barrier release, thread start and run bind reaches the specified closing/quarantined plus generic owner state;
8. cancel/config/host/socket/schema/turn drift prevents new I/O and closes through exact stop;
9. wakeup failure leaves the board request pending; native-lane answer success proves `bound -> closing -> exact stop/reap -> run close -> resource/session readback -> closed` before one exact-key consume/body prepend/non-native ready, with no provider I/O and no selector reuse;
10. stop uncertainty, owner mismatch, open-run residue, and child/socket/session/resource residue each keep the exact answer pending and the task/lane blocked or `quarantined`, create one durable orchestrator recovery request, survive Supervisor restart without native resend, and recover only after the canonical exact readback matrix passes;
11. Doctor/read model contain no raw capability, nonce, payload, transcript, provider error secret, owner token, answer text, or recovery claim token.

### V — full verification and independent review

No implementation ownership. Run after the focused matrix is green:

```bash
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Use serialized reruns if the full recursive suite flakes. Review must separately cover migration compatibility, authority/source-sink paths, crash windows, exact integration with X/C0/C1 and contract §§57/75, native-answer close-before-fallback ordering and uncertain recovery, replacement, successor non-composition, frozen `types.ts`, and host publication instructions. A component-green result is not sufficient without the clean-DB fake E2E.

### H — host publication

Human/orchestrator host gate only. The applicable X/P1 generic runtime owner writer/observer must already be published and read back, or be included as an explicitly ordered prerequisite publication. H may then install only the reviewed App Server barrier/producer and native static assets and verify exact hashes/canonical paths. It must leave communication rollout `off`, perform no provider canary, and publish no successor hook as a communication ingress. Publication failure rolls back the exact installed artifact; it does not restart unrelated processes or use generic kill.

### L — human-approved live canary

Human gate only, after V and H:

1. reconfirm current `origin/main`, installed hashes, Doctor, zero blocking lane/attempt, active exact source, and the intended task/provider/worker role;
2. approve and arm exactly one bounded selector row;
3. change only the approved provider rollout to the reviewed canary mode through the host-owned config path;
4. observe exactly one run, one dedicated generic owner record referenced by one lane, exact target binding, one or more steer attempts, and at least one exact board acknowledgement;
5. exercise a bounded stop/rollback and verify the C0/C1 exact terminal/reap evidence plus native socket absence and lane `closed`;
6. return rollout to `off`, re-run Doctor, and confirm the adjacent task/reviewer/rework never entered native;
7. if any state is uncertain, stop: keep rollout off, lane blocking, and request human recovery. Do not run a second canary.

`on` is a later human publication decision with separate SLO/error-budget evidence. Successful offline tests or one exact canary do not authorize it.

## 10. Review checklist

- [ ] The reviewer agrees that official current Codex Desktop/App external ingress is not established and board inbox+wakeup remains authoritative.
- [ ] The reviewer agrees to keep v0.18 native scope at `steer`; native-lane `answer` performs no provider I/O and may use body-prepend + non-native ready only after the exact bound lane/owner/run/resource close sequence is confirmed.
- [ ] The exact-run lane row, App Server barrier/producer, exact reference to the X/C0/C1 owner evidence, and blocking `quarantined` state are accepted as one inseparable canary contract without a duplicate owner ledger.
- [ ] Percentage and task allowlist are rejected as live-canary authority.
- [ ] Successor session eligibility is narrow and no slot/handle/hook API is reused.
- [ ] A–D are rewritten to residual-only ownership before promotion; E waits for all dependencies.
- [ ] `packages/core/src/types.ts`, live config, hooks, host runtime, and provider processes remain unchanged by this phase.
- [ ] Host publication and live canary remain two separate human gates.
