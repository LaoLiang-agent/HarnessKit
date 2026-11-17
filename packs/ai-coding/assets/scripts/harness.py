#!/usr/bin/env python3
# .harness/scripts/harness.py
# Harness 统一命令入口。用法: python3 .harness/scripts/harness.py <command> [args...]
# 可用命令 = 下表 ∩ 本目录实际存在的脚本（未物化的旧流程脚本自动隐藏，避免调用即崩溃）。
import importlib, importlib.util, sys
from pathlib import Path

SCRIPTS = {
    "verify": "verify", "sync": "sync", "check-branch": "check_branch",
    "create-feat-branch": "create_feat_branch", "build-baseline": "build_baseline",
    "check-harness": "check_harness", "check-codegraph": "check_codegraph",
    "env-auto": "env_auto", "run-field": "run_field", "harness-init": "harness_init",
    "stage-doc": "stage_doc", "init-task": "init_task",
    "spec-merge": "spec_merge", "archive": "archive", "spec-lint": "spec_lint",
}

def available():
    d = Path(__file__).resolve().parent
    return {cmd: mod for cmd, mod in SCRIPTS.items() if (d / f"{mod}.py").is_file()}

def main():
    cmds = available()
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print("用法: python3 harness.py <command> [args...]")
        print("命令: " + " | ".join(cmds))
        if len(sys.argv) >= 2 and sys.argv[1] in SCRIPTS:
            print(f"（{sys.argv[1]} 对应脚本未物化，本工程不可用）")
        return 2
    module_name = cmds[sys.argv[1]]
    script_path = Path(__file__).resolve().parent / f"{module_name}.py"
    sys.argv = [str(script_path)] + sys.argv[2:]
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main()

if __name__ == "__main__":
    sys.exit(main())
