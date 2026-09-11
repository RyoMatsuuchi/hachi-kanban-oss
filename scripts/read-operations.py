#!/usr/bin/env python3
"""運用正本の節とknowledgeの索引を、本文の一括表示なしで読む。"""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DOCS = {"core": "runbooks/orchestrator-playbook.md",
        "reference": "runbooks/orchestrator-reference.md", "contract": "docs/contract.md"}


def headings(lines):
    """コードフェンス内のコメントを見出しと誤認しない。"""
    result = []
    fence = None
    for index, line in enumerate(lines):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if fence is None and match:
            result.append((index, len(match.group(1)), match.group(2)))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", choices=[*DOCS, "knowledge"])
    parser.add_argument("section", nargs="?", help="節番号または見出しの完全一致。省略時は索引")
    parser.add_argument("--children", action="store_true", help="子節も含める")
    parser.add_argument("--max-lines", type=int, default=180)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--query", help="文書の見出し、またはknowledgeのtitle/bodyを検索")
    parser.add_argument("--tag", default="spec-change")
    args = parser.parse_args()
    if args.max_lines < 1 or args.limit < 1:
        parser.error("max-lines と limit は1以上")
    if args.source == "knowledge":
        # 既存CLIは重要度順。上限到達時は最新順だと偽って返さない。
        result = subprocess.run([str(ROOT / "bin/hachi"), "knowledge", "list", "--tag", args.tag,
                                 "--limit", "10000", "--json"], capture_output=True, text=True, check=True)
        rows = json.loads(result.stdout)["knowledge"]
        if len(rows) >= 10000:
            parser.error("取得上限に到達。tagを絞って再実行すること")
        if args.query:
            query = args.query.casefold()
            rows = [row for row in rows if query in (row["title"] + "\n" + row["body"]).casefold()]
        rows.sort(key=lambda row: (row.get("updatedAt", row["createdAt"]), row["id"]), reverse=True)
        fields = ("id", "title", "tags", "importance", "createdAt", "updatedAt")
        print(json.dumps({"matched": len(rows), "shown": min(len(rows), args.limit),
                          "knowledge": [{key: row[key] for key in fields if key in row}
                                        for row in rows[:args.limit]]}, ensure_ascii=False, indent=2))
        return
    lines = (ROOT / DOCS[args.source]).read_text().splitlines()
    entries = headings(lines)
    if args.section is None:
        selected = [entry for entry in entries if not args.query or args.query.casefold() in entry[2].casefold()]
        if len(selected) > args.max_lines:
            parser.error(f"索引は{len(selected)}行。--queryで絞るか --max-lines を明示してください（未表示）")
        print("\n".join(f"{index + 1}: {'#' * level} {title}" for index, level, title in selected))
        return
    matches = [entry for entry in entries if args.section == entry[2] or
               re.match(r"^" + re.escape(args.section) + r"(?:\.?\s|$)", entry[2])]
    if len(matches) != 1:
        parser.error("節を一意に特定できません。索引から見出しを完全指定してください")
    start, level, _ = matches[0]
    end = next((index for index, child_level, _ in entries if index > start and
                (not args.children or child_level <= level)), len(lines))
    if end - start > args.max_lines:
        parser.error(f"対象は{end - start}行。子節を指定するか --max-lines を明示してください（未表示）")
    print("\n".join(lines[start:end]))


if __name__ == "__main__":
    main()
