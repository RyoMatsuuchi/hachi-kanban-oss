cwd: <repo-root>

verify: none

## 目的（ユーザー要望 2026-09-04）

現在 G2（メガネ）から見えるのは bridge が自動起動した worker のコープロセスだけ。
**オーケストレーター（人が対話しているセッション）とも、メガネ越しに双方向で会話したい。**
手動コマンドでの有効化でよい。立ち上げ／引き継ぎの段階で「配信モード」を有効にする形。

調査結果の正本は knowledge **k_06e676c065f0**。**再調査は不要。**

## 調査の結論（確定事項。設計判断はここで凍結済み）

- **両者とも「起動時にしか有効化できない」。** 走行中セッションへの後付けは Claude / Codex とも不可
- **Codex は既存実装で可能**、**Claude は新規 2 部品が要る**

## この epic を構成する phase（それぞれ別 task に割ってから ready にする）

### P1. Codex オーケストレーターの G2 配信（最小・新規コードなし）
`env CODEX_APP_SERVER_PORT=8765 even-terminal codex` で起動すると、
`codex --remote ws://127.0.0.1:<port>` の TUI が共有 app-server にぶら下がり、
even-terminal の auto-discover が拾う。
実績は legacy-hermes/scripts/codex-launch.sh:1332-1336 の mode `even`。
- **表示（Codex→G2）は高確度。入力（G2→Codex）が未検証**なので、そこを実測するのが P1 の主眼
- 成果物: 起動手順と、入力方向が通ることの実測記録

### P2. 同一 thread への 2 購読者可否の実測（P1 と独立に効く前提条件）
バイナリ内の文字列が肯定（`composing running thread resume response`）と
否定（`expected exactly one client subscribed to the thread`）で矛盾している。
- **本番の 8765 で試さない。** `codex app-server --listen unix:///tmp/probe.sock` で
  別インスタンスを起こして先に確かめる
- 成果物: 可否の実測結果 1 件

### P3. Claude オーケストレーターの G2 配信（双方向。5 タスクに割る）

**ユーザー決定 2026-09-04: 「メガネから回答できてこその UX」。双方向が本体であり、
片方向で止めない。** 下の P3-1 は途中の検証点であって代替案ではない。

**⚠ 設計は 2 度改訂している。**
1. 出力を channel の reply に寄せた初版は誤り。メガネがチャット端点になり実況が見えない
   （公式文書: channel の返信本文はターミナルに出ず相手側に出る）。**出力は hooks にする**
2. 「新しい provider 名を足す」案は却下。Even アプリはアクセスログ実測で
   `?provider=codex` と `?provider=claude` しか送っておらず、**第 3 の値を送れるか不明**
   （アプリは閉じている）。**既存の `claude` provider に相乗りする**

#### 差し替え点はここ 1 箇所（設計の要）

Even アプリは今後も `POST /api/prompt {sessionId, provider:"claude", text}` を送ってくる。
even-terminal はそれを `getProvider("claude").prompt(sessionId, text, …)` に渡し、
**その中で `query({resume: sessionId})` を呼ぶのが二重起動の正体**。
したがって `prompt()` の冒頭に **sessionId による分岐**を 1 つ入れる:

- 配信モードで relay に登録済みの sessionId → **channel へ転送（resume しない）**
- 生きているが未登録 → **拒否**（= t_eabaccdfd82ccdaf の危険もここで塞がる）
- それ以外 → 従来どおり `query({resume})`

**アプリ側は一切変えない。**

#### タスク分割（§0.5.1: 1 タスク 1 成果物）

- **P3-1a 出力（セッション → relay）**: hook セット + relay デーモン。even-terminal は触らない。
  `MessageDisplay` → text_delta ／ `Stop`(last_assistant_message) → text・result ／
  `PreToolUse` → tool_start ／ `PostToolUse`(+tool_result) / `PostToolUseFailure` → tool_end ／
  `Notification`(permission_prompt) → permission_request ／ `SessionStart`/`Stop` → status ／
  `StopFailure` → error。emitter は `async: true`。
  **opt-in ゲートは playbook §0.7.3.2 の `hachi-orch-enable` 方式を再利用**（無効時 stat 1 回で抜ける）。
  成果物: relay が受け取ったイベント列
- **P3-1b 表示（relay → G2）**: even-terminal の relay provider。プロセスを持たず relay から表示を受ける。
  ツールの 1 行ラベルは既存の `summarizeClaudeToolCall` を再利用。
  成果物: メガネ（または `/api/messages`）で実況が見えること
- **P3-2 送信の差し替え**: 上記の `prompt()` 分岐。3 分岐すべてに焦点テストを付ける。
  成果物: 配信モードのセッションへ送っても resume が起きないこと + 未登録の生存セッションが拒否されること
- **P3-3 入力（relay → セッション）**: channel プラグイン（MCP）。**走行中の同一セッションへ push**。
  成果物: メガネから送った文がこのセッションのターンとして届くこと
- **P3-4 承認**: `PermissionRequest` hook が `hookSpecificOutput.decision`（allow/deny/review）を返す。
  hook は同期・timeout 600 秒なのでメガネの応答を待てる。
  成果物: メガネから承認・拒否ができること

順序: P3-1a → P3-1b → P3-2 → P3-3 → P3-4。**P3-2 は P3-3 より先**
（送信経路を安全にしてから入力を通す）。

#### ローカル完結の範囲（実装前に握っておく）

このマシンで完結: even-terminal の provider パッチ / hooks / relay デーモン / channel プラグイン。
**完結しないもの 2 つ**:
- **Even アプリと G2 は触れない。**既に送っている形に合わせるしかない（上の相乗り判断の根拠）
- **channels 機能自体が Anthropic 側に依存**。claude.ai か Console API key の認証が必要で、
  Bedrock / GCP / Foundry では使えない。自作プラグインは許可リスト外なので
  開発用チャネルの読み込みフラグが要る（argv に載る危険なフラグ）

**hachi 側の改修**: `buildTmuxArgs`（packages/cli/src/commands/orchestrator.ts）に `--channels` を
通す経路。dry-run と --apply で argv 完全一致の設計なので片側だけ足せない。

**`dist/` へのパッチは npm 更新で消える。**ただし hachi には escrow + sha256 pin の枠組みが既にある
（patches/even-terminal-model-passthrough/、8 ファイル置換中）ので、新枠は不要で 1 ファイル追加で済む。

**未検証**: `MessageDisplay` の payload 形（本文が取れるか、粒度）。一覧で存在を確認しただけ。
空振りなら text_delta 相当が出せず `Stop` のターン単位に落ちる（ツールの開始・終了は影響なし）。
P3-1a の最初に確かめること。

## 依存関係

- P1 と P2 は独立。P3 は P1/P2 の結果に依存しない（Claude 経路は app-server を通らない）
- **t_eabaccdfd82ccdaf（G2 一覧にオーケストレーターが出る危険）を先に片付けること。**
  P3 で Claude を正式に配信対象にする前に、事故経路を塞いでおく必要がある

## この task 自体の扱い

epic として triage に置く。**ready にしない。** 上の P1〜P3 へ割ってから個別に ready にする。

