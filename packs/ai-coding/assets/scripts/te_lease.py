#!/usr/bin/env python3
"""TE environment lease helper for PM/scripts.

The slash command `/hk-te` is user-only. This script exposes the same serial
lease to a PM running bash, so a TE gate does not require a human just to take
the lock. It is a resource lock, not an approval.

Usage:
  te_lease.py acquire <task>
  te_lease.py release <task>
  te_lease.py status
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def env_path() -> Path:
    return Path.cwd() / ".harness" / "tasks" / "test-env.json"


def read_env():
    try:
        data = json.loads(env_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    return {
        "holder": data.get("holder") if isinstance(data.get("holder"), str) else None,
        "since": data.get("since"),
        "queue": data.get("queue") if isinstance(data.get("queue"), list) else [],
    }


def write_env(env):
    path = env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(env, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def acquire(task: str):
    env = read_env()
    if env["holder"] == task:
        return f"TE 环境已由本任务持有（{task}），继续 TE 阶段"
    if env["holder"]:
        if task not in env["queue"]:
            env["queue"].append(task)
            write_env(env)
        return f"TE 环境被 **{env['holder']}** 占用：本任务已排队（第 {env['queue'].index(task) + 1} 位）。暂停 TE 阶段、不要派发 TE Worker、不要起服务/连测试库"
    env["holder"] = task
    env["since"] = __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds")
    write_env(env)
    return f"TE 环境已授权给 **{task}**（TE 标 ✅ 后自动释放）"


def release(task: str):
    env = read_env()
    if env["holder"] == task:
        env["holder"] = None
        env["since"] = None
        write_env(env)
        return "TE 环境已释放" + (f"（排队：{'、'.join(env['queue'])}，轮询器将自动晋升队首）" if env["queue"] else "")
    before = len(env["queue"])
    env["queue"] = [t for t in env["queue"] if t != task]
    write_env(env)
    return "已退出 TE 排队" if len(env["queue"]) < before else "本任务未持有 TE 环境也不在排队中"


def status():
    env = read_env()
    if not env["holder"] and not env["queue"]:
        return "TE 环境空闲"
    text = f"TE 环境持有：{env['holder'] or '（无）'}"
    if env["since"]:
        text += f"（{env['since'][:19].replace('T', ' ')} 起）"
    if env["queue"]:
        text += f"；排队：{' → '.join(env['queue'])}"
    return text


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    action = argv[1]
    if action == "status":
        print(status())
        return 0
    if action in ("acquire", "release"):
        if len(argv) < 3:
            print(f"usage: te_lease.py {action} <task>", file=sys.stderr)
            return 2
        print(acquire(argv[2]) if action == "acquire" else release(argv[2]))
        return 0
    print(f"unknown action: {action}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
