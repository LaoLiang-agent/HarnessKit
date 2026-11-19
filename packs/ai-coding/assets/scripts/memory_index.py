#!/usr/bin/env python3
"""Maintain the hot/cold memory indexes.

The entries are the source of truth; index.md (hot) and cold.md are generated
routing tables. Cooling never deletes an entry: it moves the entry out of the
default hot index while keeping the full document searchable.

Usage:
  memory_index.py sync [--root PATH]
  memory_index.py cool --days 60 --max-hot 30 [--apply] [--root PATH]
  memory_index.py promote <id> [--root PATH]
  memory_index.py touch <id> [--root PATH]
  memory_index.py check [--root PATH]
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
from pathlib import Path

SCOPES = ("backend", "frontend", "mobile", "tooling", "infra", "shared")


def memory_root(args) -> Path:
    if getattr(args, "root", None):
        return Path(args.root).resolve()
    return Path(__file__).resolve().parents[1] / "memory"


def split_frontmatter(text: str):
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        return {}, text
    fm_text = m.group(1)
    fm = {}
    for line in fm_text.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, val = line.split(":", 1)
        fm[key.strip()] = val.strip()
    return fm, text[m.end():]


def parse_list(value: str):
    value = (value or "").strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [x.strip().strip("'\"") for x in value.split(",") if x.strip()]


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "y")


def parse_date(value: str):
    value = (value or "").strip().strip("'\"")
    try:
        return _dt.date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        return None


def set_frontmatter(path: Path, updates: dict) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        text = "---\n---\n" + text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        raise SystemExit(f"bad frontmatter: {path}")
    body = text[m.end():]
    lines = m.group(1).splitlines()
    rendered = {}
    for key, value in updates.items():
        if isinstance(value, bool):
            rendered[key] = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            rendered[key] = "[" + ", ".join(str(x) for x in value) + "]"
        else:
            rendered[key] = str(value)
    seen = set()
    out = []
    for line in lines:
        key = line.split(":", 1)[0].strip() if ":" in line else ""
        if key in rendered:
            out.append(f"{key}: {rendered[key]}")
            seen.add(key)
        else:
            out.append(line)
    for key, value in rendered.items():
        if key not in seen:
            out.append(f"{key}: {value}")
    path.write_text("---\n" + "\n".join(out) + "\n---\n" + body, encoding="utf-8")


def load_entries(root: Path):
    entries = []
    for path in sorted((root / "entries").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        fm, body = split_frontmatter(text)
        title = ""
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        status = (fm.get("status") or "hot").strip().lower()
        if status not in ("hot", "cold", "retired"):
            status = "hot"
        entries.append({
            "path": path,
            "file": path.name,
            "id": (fm.get("id") or path.stem).strip(),
            "scope": (fm.get("scope") or "shared").strip().lower(),
            "date": (fm.get("date") or "").strip(),
            "tags": parse_list(fm.get("tags", "")),
            "areas": parse_list(fm.get("areas", "")),
            "symptoms": parse_list(fm.get("symptoms", "")),
            "pinned": parse_bool(fm.get("pinned", "")),
            "last_used": (fm.get("last_used") or "").strip(),
            "use_count": int(fm.get("use_count") or 0),
            "status": status,
            "title": title or (fm.get("id") or path.stem),
        })
    return entries


def cell(value: str, limit: int = 220) -> str:
    value = re.sub(r"\s+", " ", value or "").strip().replace("|", "\\|")
    return value if len(value) <= limit else value[: limit - 1] + "…"


def render_table(entries):
    lines = ["| scope | tags | 症状 / 触发 | entry |", "|---|---|---|---|"]
    for e in entries:
        tags = ", ".join(e["tags"][:5]) or "—"
        extra = []
        if e["areas"]:
            extra.append("area: " + ", ".join(e["areas"][:3]))
        if e["symptoms"]:
            extra.append("symptom: " + ", ".join(e["symptoms"][:3]))
        symptom = cell(e["title"])
        if extra:
            symptom += "（" + cell("; ".join(extra), 120) + "）"
        lines.append(f"| {cell(e['scope'], 20)} | {cell(tags, 100)} | {symptom} | [link](entries/{e['file']}) |")
    return lines


def write_indexes(root: Path):
    entries = load_entries(root)
    hot = [e for e in entries if e["status"] == "hot"]
    cold = [e for e in entries if e["status"] == "cold"]
    retired = [e for e in entries if e["status"] == "retired"]

    def order(items):
        return sorted(items, key=lambda e: (not e["pinned"], e["scope"], e["date"]), reverse=False)

    hot.sort(key=lambda e: (e["scope"], not e["pinned"], e["date"], e["title"]))
    cold.sort(key=lambda e: (e["scope"], e["date"], e["title"]))

    hot_lines = [
        "# 工程记忆索引（hot）",
        "",
        "> 默认只读本文件；cold 索引见 `cold.md`，仅在 hot 无匹配时按需搜索。规则与阈值见 `README.md`。",
        f"> hot {len(hot)} 条 · cold {len(cold)} 条 · retired {len(retired)} 条 · 更新 { _dt.date.today().isoformat() }",
        "",
        "## hot 条目",
        "",
    ] + render_table(hot) + [""]
    cold_lines = [
        "# 工程记忆冷索引（cold）",
        "",
        "> 默认不读。hot 无匹配时，按 scope/tags/symptom 搜索本文件，再读命中的 entry。",
        f"> cold {len(cold)} 条 · 条目文件仍在 `entries/`，不删除。",
        "",
        "## cold 条目",
        "",
    ] + render_table(cold) + [""]
    (root / "index.md").write_text("\n".join(hot_lines), encoding="utf-8")
    (root / "cold.md").write_text("\n".join(cold_lines), encoding="utf-8")
    return hot, cold, retired


def find_entry(entries, ident: str):
    ident = ident.strip()
    for e in entries:
        if e["id"] == ident or e["file"] == ident or e["file"].startswith(ident):
            return e
    raise SystemExit(f"memory entry not found: {ident}")


def cmd_sync(args):
    root = memory_root(args)
    hot, cold, retired = write_indexes(root)
    print(f"memory indexes synced: hot={len(hot)} cold={len(cold)} retired={len(retired)}")
    return 0


def cmd_cool(args):
    root = memory_root(args)
    cutoff = _dt.date.today() - _dt.timedelta(days=max(1, args.days))
    entries = load_entries(root)
    candidates = []
    for e in entries:
        if e["status"] != "hot" or e["pinned"]:
            continue
        ref = parse_date(e["last_used"]) or parse_date(e["date"])
        if ref is not None and ref <= cutoff:
            candidates.append(e)
    # Age is the primary signal. If hot is still over budget, cool the oldest
    # non-pinned entries until it fits; pinned entries are never auto-cooled.
    hot = [e for e in entries if e["status"] == "hot"]
    if len(hot) - len(candidates) > args.max_hot:
        rest = [e for e in hot if e not in candidates and not e["pinned"]]
        rest.sort(key=lambda e: (e["date"] or "9999-99-99", e["file"]))
        need = len(hot) - len(candidates) - args.max_hot
        for e in rest[:need]:
            candidates.append(e)
    for e in candidates:
        print(f"COOL {e['scope']:8} {e['date'] or '?':10} {e['file']}")
    if not candidates:
        print(f"no hot entries older than {args.days} days (cutoff {cutoff.isoformat()})")
        return 0
    if args.apply:
        for e in candidates:
            set_frontmatter(e["path"], {"status": "cold"})
        write_indexes(root)
        print(f"applied: moved {len(candidates)} entries to cold")
    else:
        print("dry-run: pass --apply to move them to cold")
    return 0


def cmd_promote(args):
    root = memory_root(args)
    entries = load_entries(root)
    e = find_entry(entries, args.id)
    set_frontmatter(e["path"], {"status": "hot", "last_used": _dt.date.today().isoformat()})
    write_indexes(root)
    print(f"promoted: {e['id']}")
    return 0


def cmd_touch(args):
    root = memory_root(args)
    entries = load_entries(root)
    e = find_entry(entries, args.id)
    set_frontmatter(e["path"], {
        "status": "hot",
        "last_used": _dt.date.today().isoformat(),
        "use_count": e["use_count"] + 1,
    })
    write_indexes(root)
    print(f"touched: {e['id']} (use_count={e['use_count'] + 1})")
    return 0


def cmd_check(args):
    root = memory_root(args)
    entries = load_entries(root)
    errors = []
    ids = {}
    for e in entries:
        if e["id"] in ids:
            errors.append(f"duplicate id: {e['id']} ({ids[e['id']]} / {e['file']})")
        ids[e["id"]] = e["file"]
    indexed = {}
    for name in ("index.md", "cold.md"):
        path = root / name
        if not path.exists():
            errors.append(f"missing index: {name}")
            continue
        text = path.read_text(encoding="utf-8")
        for rel in re.findall(r"\(entries/([^)]+\.md)\)", text):
            if not (root / "entries" / rel).is_file():
                errors.append(f"broken link in {name}: {rel}")
            if rel in indexed:
                errors.append(f"entry appears in both indexes: {rel}")
            indexed[rel] = name
    for e in entries:
        if e["status"] != "retired" and e["file"] not in indexed:
            errors.append(f"entry missing from indexes: {e['file']}")
    hot = [e for e in entries if e["status"] == "hot"]
    if len(hot) > args.max_hot:
        errors.append(f"hot index has {len(hot)} entries (max {args.max_hot})")
    if errors:
        print("memory index check FAILED")
        for item in errors:
            print(" -", item)
        return 1
    print(f"memory index check PASS (hot={len(hot)} cold={len([e for e in entries if e['status'] == 'cold'])} entries={len(entries)})")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="memory directory (default: .harness/memory next to this script)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("sync", help="regenerate index.md/cold.md from frontmatter")
    p.set_defaults(func=cmd_sync)
    p = sub.add_parser("cool", help="move old unused hot entries to cold")
    p.add_argument("--days", type=int, default=60)
    p.add_argument("--max-hot", type=int, default=30)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_cool)
    p = sub.add_parser("promote", help="move an entry back to hot")
    p.add_argument("id")
    p.set_defaults(func=cmd_promote)
    p = sub.add_parser("touch", help="record use and keep an entry hot")
    p.add_argument("id")
    p.set_defaults(func=cmd_touch)
    p = sub.add_parser("check", help="validate entries and indexes")
    p.add_argument("--max-hot", type=int, default=30)
    p.set_defaults(func=cmd_check)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
