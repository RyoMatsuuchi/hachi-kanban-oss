# hachi-kanban — セッション入口

このリポジトリ（または他リポジトリから本ボード）でオーケストレーターとして働く場合、

**0. 読み始める前に heartbeat を回す（playbook §0.7.4 / knowledge `k_b248e07d575b`）。**
下の読み込みは session の stale TTL（90秒）を容易に超えるため、**先に読むと自分の session が
失効して takeover が要る**。`handover --apply` で起きた後継は起動プロンプト冒頭に
この指示が入っているので自動的に守られるが、**手動で立ち上げる場合は自分で守ること**。

```bash
# provider session id は Claude Code の transcript パス ~/.claude/projects/<proj>/<uuid>.jsonl の <uuid>
SID=; GEN=; eval "$(hachi orchestrator session resolve --provider-session-id <uuid>)"
while true; do hachi orchestrator session heartbeat "$SID" --generation "$GEN" >/dev/null; sleep 30; done &
```

そのうえで **次の2つを読むこと**:

1. **運用の正本（core）**: `runbooks/orchestrator-playbook.md`（判断規律・切りどき・立ち上げ・
   監視・終端対応の分岐・done 照合）。**冒頭「段階的な読み方」の必読節と作業別索引だけを読む**
2. **仕様の正本**: `docs/contract.md`（唯一の契約。編集はオーケストレーターのみ）。**関連節だけ読む**

手順書は `runbooks/orchestrator-reference.md`（**reference**）にある。
**全文を読まない** — core 冒頭の trigger index で、これから入る作業の節だけを引く。
§ 番号は両書で一意（reference 側も元の番号のまま）。

スキル: `hachi-kanban-orchestrator`（運用入口）/ `hachi-kanban`（CLI 構文）/
`hachi-kanban-planner`（分解設計）。CLI はどの cwd からでも `hachi <cmd>`（~/.local/bin シム → repo `bin/hachi` に委譲）。
非対話環境（pnpm が PATH に無い）では repo の `bin/hachi <cmd>` を直接使う。

## 最近の仕様変更を知る方法

- `python3 scripts/read-operations.py knowledge --limit 20` — 更新順の本文なし索引。設計前は`--query`で対象を検索し、関連IDだけ`hachi knowledge show`する。 仕様・運用の変更は knowledge 面（§47）に
  spec-change タグで記録される。**セッション開始時と設計前に必ず引く**
- 詳細は契約の該当 § と playbook の該当節（knowledge エントリに § 番号が書いてある）
