#!/usr/bin/env python3
"""Print the actual provider/model/reasoning effort used by a session and its subagents.

Reads DSH's local session logs (read-only). Usage:
  python3 tools/session-models.py <session-id>
  python3 tools/session-models.py <session-id> --json
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def read_events(path: Path):
    zstd = shutil.which('zstd')
    if not zstd:
        raise SystemExit('zstd not found in PATH')
    raw = subprocess.check_output([zstd, '-q', '-d', '-c', str(path)], stderr=subprocess.DEVNULL)
    for line in raw.decode('utf-8', errors='replace').splitlines():
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def find_session(session_id: str) -> Path:
    root = Path.home() / '.dsh' / 'sessions'
    for path in root.glob(f'*/{session_id}/session.v4.jsonl.zstd'):
        return path
    raise SystemExit(f'session log not found: {session_id}')


def model_of(path: Path):
    provider = model = effort = None
    for event in read_events(path):
        if event.get('type') == 'request/header':
            cfg = event.get('data', {}).get('header', {}).get('config', {})
            provider = cfg.get('provider') or provider
            model = cfg.get('model') or model
            effort = cfg.get('reasoningEffort') or effort
    return provider, model, effort


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    parent = find_session(args.session)
    workspace = parent.parent.parent
    title = None
    children = []
    for event in read_events(parent):
        if event.get('type') == 'session/title':
            title = event.get('data', {}).get('title') or title
        if event.get('type') == 'subagent/catalog':
            d = event.get('data', {})
            children.append((d.get('childId'), d.get('label') or d.get('name') or '?'))
    p = model_of(parent)
    rows = [{'agent': 'PM (parent)', 'child': args.session, 'provider': p[0], 'model': p[1], 'effort': p[2]}]
    for child_id, label in children:
        child = workspace / child_id / 'session.v4.jsonl.zstd'
        if not child.exists():
            rows.append({'agent': label, 'child': child_id, 'provider': None, 'model': None, 'effort': None})
            continue
        m = model_of(child)
        rows.append({'agent': label, 'child': child_id, 'provider': m[0], 'model': m[1], 'effort': m[2]})
    if args.json:
        print(json.dumps({'session': args.session, 'title': title, 'agents': rows}, ensure_ascii=False, indent=2))
        return 0
    print(f"{title or args.session}  ({args.session})")
    print(f"{'agent':38} {'provider':18} {'model':18} effort")
    print('-' * 90)
    for r in rows:
        print(f"{r['agent'][:37]:38} {str(r['provider'] or '-'):18} {str(r['model'] or '-'):18} {r['effort'] or '-'}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
