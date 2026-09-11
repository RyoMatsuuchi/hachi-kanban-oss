# 旧系統退役記録（2026-07-07）

対象タスク: `t_a99dd71275d187db`

## 決定

- bridge は当面、自前実装へ取り込まない。`com.legacy-hermes.kanban-shared-app-server`
  （Codex / 3456）と `com.legacy-hermes.kanban-claude-even-server`（Claude / 3457）を
  G2 契約面の外部アプライアンスとして正式維持する。
- bridge 監視は hachi-kanban 側へ寄せる。`webwatch` の bridge identity 監視と
  `hachi doctor` の bridge 本人確認を正とし、旧 legacy-hermes の bridge monitor は退役する。
- legacy-hermes は看板配管・開発オーケストレーションとしては退役済み扱いにする。
  ただし上記 bridge server 2 本が旧 repo の scripts を実行元として参照するため、repo 自体の
  rename / 移動は行わない。
- hermes-agent は蘇生しない。個人秘書としての価値部分（ナレッジ、ブリーフ、session-handover）は
  hachi-kanban 側の lessons / intake 系タスクへ再実装する方針とする。

## 実施内容

- 【最終状態の訂正（オーケストレーター 2026-07-07）】bridge monitor 2 本と note076-tcp-port-watch は
  ユーザー決定 (a)「bridge 外部維持 + ヘルス監視強化」に基づき**維持**（一時 bootout されたが
  enable + bootstrap で復旧済み・稼働確認済み）。webwatch/doctor の identity 検査は
  旧 monitor の代替ではなく**追加レイヤー**として併用する。
  「監視を hachi-kanban 側へ完全に寄せて旧 monitor を退役する」案は将来の検討事項として保留
  （採否はオーケストレーター判断。webwatch は通知のみで bridge の自己修復は担わない点に注意）。
- 旧 pipeline/watch 12 本を `launchctl disable` で disabled state にした。
  - `com.legacy-hermes.finance-kanban-followup-check`
  - `com.legacy-hermes.kanban-auto-launcher`
  - `com.legacy-hermes.kanban-followup-spawner`
  - `com.legacy-hermes.kanban-integration-watcher`
  - `com.legacy-hermes.kanban-review-finalizer`
  - `com.legacy-hermes.kanban-review-rework-finalizer`
  - `com.legacy-hermes.kanban-review-rework-launcher`
  - `com.legacy-hermes.kanban-reviewer-launcher`
  - `com.legacy-hermes.kanban-tmux-reaper`
  - `com.legacy-hermes.kanban-even-shared-monitor`
  - `com.legacy-hermes.kanban-claude-even-monitor`
  - `com.legacy-hermes.note076-tcp-port-watch`

## 検証結果

- `launchctl print gui/501 | rg 'com\\.hachi'` で稼働系統は次だけになった。
  - 新看板: `com.hachi-kanban.supervisor` / `com.hachi-kanban.watchdog` /
    `com.hachi-kanban.web`
  - bridge: `com.legacy-hermes.kanban-shared-app-server` /
    `com.legacy-hermes.kanban-claude-even-server`
- `~/Library/LaunchAgents` 直下の `com.legacy-hermes*.plist` は bridge server 2 本のみ。
- `lsof -nP -iTCP:3456 -sTCP:LISTEN` と `lsof -nP -iTCP:3457 -sTCP:LISTEN` で
  bridge port の listen を確認した。
- `pnpm hachi doctor` は全項目 OK。
- 旧 pipeline 8 本 + phase2-observe + disabled 群 + finance-kanban-followup-check の plist は
  `~/Library/LaunchAgents/retired-20260707/` に明示アーカイブ（可逆）。
- 稼働は「新看板 3 本 + bridge 2 本 + bridge monitor 2 本 + note076-tcp-port-watch」で確定。
- live の `$HACHI_KANBAN_HOME/config.json` は変更していない。
