#!/usr/bin/env python3
# .harness/scripts/run_field.py
# 执行子工程 .harness/build.json 声明的构建/启动字段（统一执行入口的 CLI 外壳）。
#
# 为什么要有这个脚本：Agent / Skill / 人**手敲** `mvn ...`、`npm ...` 时，
# 继承的是当前 shell 的 PATH —— 机器上装了多个 JDK 时大概率选中错的那个，
# 于是报出与被改代码无关的怪错。走这里 = 强制先按子工程声明的版本解析运行时。
#
# 用法:
#   python3 .harness/scripts/run_field.py <子工程> <字段>            # install / compile / test / lint / package / package-incr
#   python3 .harness/scripts/run_field.py <子工程> start             # 启动并按判据判定，**不自动停止**
#   python3 .harness/scripts/run_field.py <子工程> stop              # 停止（人工显式执行）
#   python3 .harness/scripts/run_field.py <子工程> compile --timeout 600
#   python3 .harness/scripts/run_field.py --all compile              # 所有子工程
#
# start 的判定依据全部由**子工程自己声明**（框架层不硬编码任何工程的启动日志串）：
#   build.json: { "start": "...", "start-ok": "<成功判据正则>", "start-timeout": 180, "start-port": 9778 }
#   - 有 start-ok     → 等日志命中该正则 = 启动成功
#   - 无 start-ok     → 只起不判，明确报「未验证」并非零退出（不制造凭空 PASS）
#
# ⚠️ start **不会自动停止服务**：判定完成后若为交互终端会询问「是否停止」，
#    非交互（Agent/hook）一律保持运行并打印停止指引，由人显式执行 stop。
import json, os, re, subprocess, sys, time
from pathlib import Path
import lib

FIELDS = ("install", "compile", "test", "package", "package-incr", "lint", "start", "stop")
START_OK = "start-ok"
START_TIMEOUT = "start-timeout"
START_PORT = "start-port"
DEFAULT_START_TIMEOUT = 180
# 构建命令里的 `clean` 目标（作为独立 token 匹配，不误伤 -Dmaven.clean.skip 之类的参数值）
CLEAN_TOKEN = re.compile(r"(?:^|\s)clean(?:\s|$)")


def _usage():
    print("用法: python3 .harness/scripts/run_field.py [--all] <子工程> <字段> [--timeout 秒]")
    print("字段: " + " | ".join(FIELDS) + "（以子工程 build.json 实际声明为准）")
    print("  start 的判据由 build.json 的 start-ok / start-timeout / start-port 声明")
    return 2


def _logs_dir(name: str) -> Path:
    """start 的日志与 pidfile 落在**仓库根**的 .harness/.logs/run/<子工程>/。

    刻意不写进 <子工程>/.harness/.logs/：子模块工作区只认**它自己的** .gitignore
    （超项目的规则管不到子模块内部），日志会被当成未跟踪文件冒出来——还会污染
    dev_gate 的「有改动才编译」判定。而进程生命周期本来就由 harness 拥有，不属子工程。
    """
    d = lib.repo_root() / ".harness" / ".logs" / "run" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pidfile(name: str) -> Path:
    return _logs_dir(name) / "start.pid"


def _read_pidfile(name: str) -> dict:
    try:
        return json.loads(_pidfile(name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _say_run(name, pid, port, logfile):
    print(f"   PID      : {pid}")
    if port:
        print(f"   端口     : {port}")
    if logfile:
        print(f"   日志     : {logfile}")
    print(f"   停止     : python3 .harness/scripts/harness.py run-field {name} stop")


def _drain(logfile: Path, pos: int):
    """读日志新增部分（返回 内容, 新偏移）。"""
    try:
        with open(logfile, "r", encoding="utf-8", errors="replace") as f:
            f.seek(pos)
            chunk = f.read()
            return chunk, f.tell()
    except OSError:
        return "", pos


def _tail_until_match(logfile: Path, proc, ok_re, timeout):
    """轮询日志：实时透传到终端 + 匹配成功判据。返回 (status, elapsed)。

    status ∈ ok | exit | timeout。输出已实时透传，失败路径不必再重复打印尾行。
    """
    t0, pos = time.time(), 0
    while True:
        elapsed = time.time() - t0
        chunk, pos = _drain(logfile, pos)
        if chunk:
            print(chunk, end="", flush=True)
            if ok_re.search(chunk):
                return "ok", elapsed
        if proc.poll() is not None:
            time.sleep(0.3)  # 收尾：把剩余输出读干净
            rest, pos = _drain(logfile, pos)
            if rest:
                print(rest, end="", flush=True)
            return "exit", elapsed
        if elapsed > timeout:
            return "timeout", elapsed
        time.sleep(0.2)


def _start(name, sp: Path, timeout):
    cmd = lib.get_build_field(sp, "start")
    if not cmd:
        lib.c_warn(f"{name}: build.json 未声明 start，跳过")
        return True
    print(f"→ {name}: [start] $ {cmd}")
    ok_re_src = lib.get_build_field(sp, START_OK)
    port = lib.get_build_field(sp, START_PORT)
    if timeout is None:
        try:
            timeout = int(lib.get_build_field(sp, START_TIMEOUT) or DEFAULT_START_TIMEOUT)
        except ValueError:
            timeout = DEFAULT_START_TIMEOUT
    try:
        ok_re = re.compile(ok_re_src) if ok_re_src else None
    except re.error as e:
        lib.c_fail(f"{name}: build.json 的 {START_OK} 不是合法正则: {e}")
        return False

    logfile = _logs_dir(name) / f"start-{time.strftime('%Y%m%d-%H%M%S')}.log"
    try:
        proc, _ = lib.spawn_build_field(sp, "start", log_path=logfile)
    except lib.BuildEnvError as e:
        lib.c_fail(str(e))
        for m in e.missing:
            print(f"     → {m}")
        return False
    if proc is None:
        lib.c_warn(f"{name}: start 命令为空，跳过")
        return True
    _pidfile(name).write_text(
        json.dumps({"pid": proc.pid, "port": port, "log": str(logfile), "cmd": cmd},
                   ensure_ascii=False), encoding="utf-8")

    if not ok_re:
        # 无判据：只起不判。等一小会儿让启动输出落盘，再如实报「未验证」。
        time.sleep(min(timeout, 20))
        alive = proc.poll() is None
        print(("\n".join(_drain(logfile, 0)[0].splitlines()[-15:])))
        lib.c_fail(f"{name}: 未声明 {START_OK}，**无法判定启动成功**"
                   f"（进程{'仍在运行' if alive else '已退出'}，退出码 {proc.poll()}）")
        print(f"     这不是「启动失败」，是「未验证」——请在 <子工程>/.harness/build.json 声明 "
              f'"{START_OK}": "<启动成功的日志判据>"')
        _say_run(name, proc.pid, port, logfile)
        return False

    status, elapsed = _tail_until_match(logfile, proc, ok_re, timeout)
    if status == "ok":
        lib.c_pass(f"{name}: 启动成功（{elapsed:.1f}s 命中判据 /{ok_re_src}/）")
    elif status == "exit":
        lib.c_fail(f"{name}: 进程提前退出（{elapsed:.1f}s，未命中判据 /{ok_re_src}/）")
        return False
    else:
        lib.c_fail(f"{name}: {timeout}s 内未命中判据 /{ok_re_src}/（进程仍在运行）")
        _say_run(name, proc.pid, port, logfile)
        return False

    _say_run(name, proc.pid, port, logfile)

    # ⚠️ 停止**永不自动**：交互终端里问一句，非交互一律留着。
    if sys.stdin.isatty():
        try:
            ans = input("   服务仍在运行 —— 现在停止吗？[y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = ""
        if ans in ("y", "yes"):
            if lib.stop_process(proc.pid):
                lib.c_pass(f"{name}: 已停止（PID {proc.pid}）")
                _pidfile(name).unlink(missing_ok=True)
            else:
                lib.c_fail(f"{name}: 停止失败，请手动处理 PID {proc.pid}")
                return False
        else:
            print("   保持运行。需要时用上面的停止命令。")
    else:
        print("   ⚠️  非交互环境：未停止服务（停止需人工确认）。")
    return True


def _stop(name, sp: Path):
    info = _read_pidfile(name)
    pid = info.get("pid")
    if not pid:
        lib.c_warn(f"{name}: 无启动记录（{_pidfile(name)}），无需停止")
        return True
    if not lib.process_alive(pid):
        lib.c_warn(f"{name}: PID {pid} 已不在运行，清理记录")
        _pidfile(name).unlink(missing_ok=True)
        return True
    print(f"→ {name}: 停止 PID {pid}（{info.get('cmd', '')[:60]}）")
    if lib.stop_process(pid):
        _pidfile(name).unlink(missing_ok=True)
        lib.c_pass(f"{name}: 已停止")
        return True
    lib.c_fail(f"{name}: 停止失败，请手动处理 PID {pid}")
    return False


def _warn_build_env(name, field, cmd):
    """构建字段开跑前的**环境陷阱告警**（只提示，不阻断）。

    两类陷阱的共同点：**都不报错**，却让构建之后的一切验证结论失真——
    退出码 0 也说明不了「产物完整」或「跑的是新代码」。
    只告警不 FAIL 是刻意的：两者都属「合法但危险」的用法，框架判不了使用者的真实意图。
    """
    if CLEAN_TOKEN.search(cmd or ""):
        lib.c_warn(f"{name}: [{field}] 命令含 `clean` —— 会先删掉子工程已产出的模块 jar"
                   f"（如 apps/modules/*.jar）；增量场景请改用 package-incr，"
                   f"否则「构建成功」与「产物完整」是两回事")
    info = _read_pidfile(name)
    pid = info.get("pid")
    if pid and lib.process_alive(pid):
        lib.c_warn(f"{name}: [{field}] 该子工程的服务正在运行（PID {pid}）—— 原地覆盖 jar 会使"
                   f"运行进程的类加载器视图失效（同一 inode 被重写），之后可能报 NoClassDefFoundError"
                   f" 或跑出旧代码，**PASS 与 FAIL 均不可采信**；请先 run-field {name} stop")


def _run_one(name, sp, field, timeout):
    if field == "start":
        return _start(name, sp, timeout)
    if field == "stop":
        return _stop(name, sp)
    cmd = lib.get_build_field(sp, field)
    if not cmd:
        print(f"  ⚠️  {name}: build.json 未声明 {field}，跳过")
        return True
    _warn_build_env(name, field, cmd)
    print(f"→ {name}: [{field}] $ {cmd}")
    try:
        r = lib.run_build_field(sp, field, timeout=timeout)
    except FileNotFoundError as e:
        lib.c_fail(f"{name}: 命令不可用: {e}")
        return False
    except Exception as e:  # 含 subprocess.TimeoutExpired
        lib.c_fail(f"{name}: {field} 异常: {e}")
        return False
    if r is None or r.returncode != 0:
        if r is not None:
            print(r.stdout[-2000:] if r.stdout else "")
            print(r.stderr[-2000:] if r.stderr else "")
        lib.c_fail(f"{name}: {field} 失败 (exit={None if r is None else r.returncode})")
        return False
    lib.c_pass(f"{name}: {field} 通过")
    return True


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    timeout = None
    if "--timeout" in argv:
        i = argv.index("--timeout")
        try:
            timeout = int(argv[i + 1])
        except (IndexError, ValueError):
            return _usage()
        del argv[i:i + 2]
    run_all = "--all" in argv
    argv = [a for a in argv if a != "--all"]
    if not argv:
        return _usage()
    field = argv[-1]
    if field not in FIELDS:
        lib.c_fail(f"未知字段: {field}")
        return _usage()
    if run_all:
        if argv[:-1]:
            return _usage()
        targets = lib.discover_service_dirs(lib.repo_root())
    else:
        if len(argv) != 2:
            return _usage()
        sp = lib.resolve_service_dir(argv[0])
        if sp is None:
            lib.c_fail(f"子工程不存在: {argv[0]}（可写短名 `backend` 或路径 `services/backend`）")
            return 1
        targets = [(sp.name, sp)]
    if not targets:
        lib.c_fail("未发现任何子工程")
        return 1
    # 不用 all(...) 短路：所有子工程都要跑完，不能因为第一个失败就跳过其余
    results = [_run_one(n, p, field, timeout) for n, p in targets]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
