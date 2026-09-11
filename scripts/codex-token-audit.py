#!/usr/bin/env python3
"""codex rollout ログからトークン消費を監査する。

使い方:
    python3 scripts/codex-token-audit.py 2026-08-19 [2026-08-20 ...]

日付を省略すると当日を対象にする。ルール適用の前後比較に使う
（reference §2.25 / ~/.codex/AGENTS.md「ブラウザ操作とトークン効率」）。

読むだけで何も書き換えない。
"""
import collections
import datetime
import glob
import json
import os
import sys

ROOT = os.path.expanduser("~/.codex/sessions")


def session_rows(days):
    """対象日の rollout を1本ずつ読み、集計に必要な値だけ返す。"""
    for path in sorted(glob.glob(ROOT + "/**/rollout-*.jsonl", recursive=True)):
        name = os.path.basename(path)
        if not any(d in name for d in days):
            continue
        originator = cwd = None
        turns = []
        kinds = collections.Counter()
        mcp = collections.Counter()
        try:
            handle = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                payload = entry.get("payload", entry)
                if not isinstance(payload, dict):
                    continue
                if originator is None and "originator" in payload:
                    originator = payload.get("originator")
                    cwd = payload.get("cwd")
                kind = payload.get("type")
                kinds[kind] += len(line)
                if kind == "token_count":
                    usage = (payload.get("info") or {}).get("last_token_usage")
                    if usage:
                        turns.append(usage)
                elif kind == "mcp_tool_call_end":
                    invocation = payload.get("invocation") or {}
                    tool = f"{invocation.get('server', '?')}.{invocation.get('tool', '?')}"
                    result = payload.get("result")
                    mcp[tool] += len(json.dumps(result, ensure_ascii=False)) if result else 0
        if turns:
            yield originator or "?", cwd or "?", turns, kinds, mcp


def main():
    days = sys.argv[1:] or [datetime.date.today().isoformat()]
    by_origin = collections.defaultdict(lambda: collections.Counter())
    kinds_total = collections.Counter()
    mcp_total = collections.Counter()
    turn_buckets = collections.Counter()
    bucket_input = collections.Counter()

    for originator, cwd, turns, kinds, mcp in session_rows(days):
        acc = by_origin[originator]
        acc["sessions"] += 1
        acc["turns"] += len(turns)
        for usage in turns:
            acc["input"] += usage.get("input_tokens", 0)
            acc["cached"] += usage.get("cached_input_tokens", 0)
            acc["output"] += usage.get("output_tokens", 0)
        kinds_total.update(kinds)
        mcp_total.update(mcp)
        # ターン数の帯ごとに input を寄せる（分解不足の検知に使う）
        n = len(turns)
        label = next(b for lo, b in [(500, "500+"), (200, "200-499"), (100, "100-199"),
                                     (50, "50-99"), (30, "30-49"), (0, "0-29")] if n >= lo)
        turn_buckets[label] += 1
        bucket_input[label] += sum(u.get("input_tokens", 0) for u in turns)

    print(f"対象日: {', '.join(days)}\n")
    grand = sum(v["input"] for v in by_origin.values())
    print(f"{'originator':16s} {'sess':>5} {'turns':>7} {'input':>15} {'割合':>7} {'cache率':>8} {'in/out':>8}")
    for origin, v in sorted(by_origin.items(), key=lambda x: -x[1]["input"]):
        cache = v["cached"] / v["input"] * 100 if v["input"] else 0
        ratio = v["input"] / v["output"] if v["output"] else 0
        share = v["input"] / grand * 100 if grand else 0
        print(f"{origin[:16]:16s} {v['sessions']:>5} {v['turns']:>7} {v['input']:>15,} "
              f"{share:>6.1f}% {cache:>7.1f}% {ratio:>8.0f}")

    print("\n=== ターン数帯ごとの input（50以上が支配的なら分解不足）===")
    total_bucket = sum(bucket_input.values())
    for label in ("0-29", "30-49", "50-99", "100-199", "200-499", "500+"):
        if not turn_buckets[label]:
            continue
        share = bucket_input[label] / total_bucket * 100 if total_bucket else 0
        print(f"  {label:>8} {turn_buckets[label]:>5}本 {bucket_input[label]:>15,} {share:>6.1f}%")

    print("\n=== セッション内容の内訳（ツール出力が過半なら B1/B2 違反を疑う）===")
    body = sum(kinds_total.values())
    tool_kinds = ("mcp_tool_call_end", "custom_tool_call_output", "function_call_output")
    tool_bytes = sum(kinds_total[k] for k in tool_kinds)
    for kind, size in kinds_total.most_common(8):
        mark = " ←ツール出力" if kind in tool_kinds else ""
        print(f"  {str(kind)[:32]:32s} {size:>14,} {size / body * 100:>6.1f}%{mark}")
    print(f"  → ツール出力合計 {tool_bytes:,} ({tool_bytes / body * 100:.1f}%)")

    print("\n=== MCP 応答の内訳（node_repl.js が上位ならブラウザ由来）===")
    mcp_sum = sum(mcp_total.values())
    for tool, size in mcp_total.most_common(6):
        print(f"  {tool[:40]:40s} {size:>14,} {size / mcp_sum * 100:>6.1f}%")


if __name__ == "__main__":
    main()
