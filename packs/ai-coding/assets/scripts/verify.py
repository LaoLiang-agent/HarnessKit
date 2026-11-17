#!/usr/bin/env python3
# .harness/scripts/verify.py
# 硬门禁检查脚本：
#   阶段1 同步子模块（存在 sync.py 时；非子模块布局跳过）
#   阶段2 集成分支检查（仅警告；存在 .gitmodules 时）
#   阶段3 CLAUDE.md 行数 → 阶段3.5 裸 NUL 字节 → 阶段4 构建
import sys
from pathlib import Path
import lib

MAX_WARN, MAX_ERROR = 200, 300


def claude_lines_verdict(lines: int) -> str:
    if lines > MAX_ERROR:
        return "error"
    if lines > MAX_WARN:
        return "warn"
    return "ok"


def build_command(service_path) -> str:
    cfg = Path(service_path) / ".harness" / "build.json"
    if cfg.is_file():
        data = lib.read_json(cfg)
        if isinstance(data, dict) and "compile" in data:
            # 显式声明（含空串占位）：空串表示该子工程本地开发无需编译（如前端热更新），跳过
            return data.get("compile") or ""
    if (Path(service_path) / "pom.xml").is_file():
        return "mvn compile -q"
    if (Path(service_path) / "go.mod").is_file():
        return "go build ./..."
    if list(Path(service_path).glob("*.sln")) or list(Path(service_path).glob("*.csproj")):
        return "dotnet build"
    if (Path(service_path) / "package.json").is_file():
        return "npm run build --if-present"
    return ""


def run_build(service_path, name: str):
    print(f"→ 构建 {name} ({service_path})...")
    cmd = build_command(service_path)
    if not cmd:
        print("  ⚠️  跳过构建（compile 为空占位或未识别构建工具）")
        return True
    print(f"  $ {cmd}")
    # 统一执行入口：按子工程声明的运行时（JDK/Node…）解析环境后执行，禁止裸 subprocess
    declared = lib.get_build_field(service_path, "compile")
    try:
        r = lib.run_build_field(service_path, "compile",
                                command=None if declared else cmd)
    except FileNotFoundError as e:
        print(f"  ❌ {name}: 命令不可用: {e}")
        return False
    if r.returncode != 0:
        print(r.stdout[-2000:] if r.stdout else "")
        print(r.stderr[-2000:] if r.stderr else "")
        return False
    return True


def check_claude_lines(path: Path):
    f = path / "CLAUDE.md"
    if not f.is_file():
        print(f"  ⚠️  未找到 {f}，建议各子工程维护自己的技术规范。")
        return
    lines = len(f.read_text(encoding="utf-8", errors="ignore").splitlines())
    v = claude_lines_verdict(lines)
    if v == "error":
        print(f"  ❌ [硬门禁] {f} 行数 {lines} 超过硬上限 {MAX_ERROR} 行！")
        sys.exit(1)
    elif v == "warn":
        print(f"  ⚠️  [警告] {f} 行数 {lines} 超过建议值 {MAX_WARN} 行。")
    else:
        print(f"  ✅ {f} 行数检查通过 ({lines} 行)")


def check_integration_branch(root: Path):
    r = lib.git(["submodule", "--quiet", "foreach", "--recursive",
                 "echo \"$path:$name\""], cwd=root)
    for line in r.stdout.splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        path, name = line.rsplit(":", 1)
        p = Path(path)
        if not p.is_dir():
            continue
        cur = lib.git(["branch", "--show-current"], cwd=p).stdout.strip() or "detached"
        mainline = lib.get_mainline_branch(p)
        # 阶段1 的 sync 会把**非 feature 分支**的子模块切到主线，于是每次跑 verify，「本轮未参与」
        # 的子工程都会被这一行报成警告 —— 与 check_branch 的 idle 口径同源，此处一并静音。
        if cur == mainline and lib.is_pristine_on_mainline(p, mainline):
            print(f"  ℹ️  子模块 {name} 停在 {mainline} 且与 origin/{mainline} 同步 —— 本轮未参与，跳过")
        elif cur in ("master", "main", "dev", "develop", "test", "release") or cur == mainline:
            print(f"  ⚠️  子模块 {name} 当前在集成分支 '{cur}' 上")
            print("   建议切换到特性分支再进行开发")
        elif cur == "detached":
            print(f"  ⚠️  子模块 {name} 处于 detached HEAD 状态")
        else:
            print(f"  ✅ 子模块 {name} 分支检查通过 ({cur})")



# ── 裸 NUL 字节检查（2026-09-28 新增）────────────────────────────
# 背景：一个 `.java` 测试文件里用了字面的 0x00 当分隔符（`key + "\x00" + field`），
# 语法合法、测试全绿，但 git 判定该文件为**二进制**（`diff --numstat` 显示 `-  -`、`show --stat` 显示 `Bin`）
# ⇒ 该文件此后的所有 diff / CR 审查 / 人工审阅 / 合并**全部不可读**，而任何门禁都不会报错。
# 判据只看**改动过的文本文件**（相对主线），保持廉价；含 NUL 一律 ERROR。
TEXT_EXTS = {".java", ".md", ".json", ".properties", ".js", ".jsx", ".ts", ".tsx", ".vue",
             ".xml", ".yml", ".yaml", ".py", ".sql", ".sh", ".txt", ".html", ".css", ".go", ".cs"}


def check_nul_bytes(service_path, name: str) -> bool:
    """改动文件含裸 NUL 字节 → 打印 ERROR 并返回 False。取不到 diff 时静默跳过（不误报）。"""
    mainline = lib.get_mainline_branch(service_path)
    ref = f"origin/{mainline}"
    if lib.git(["rev-parse", "--verify", "--quiet", f"refs/remotes/{ref}"],
               cwd=service_path).returncode != 0:
        ref = mainline
    r = lib.git(["diff", "--name-only", f"{ref}...HEAD"], cwd=service_path)
    if r.returncode != 0:
        return True
    bad = []
    for rel in (r.stdout or "").splitlines():
        f = Path(service_path) / rel.strip()
        if not rel.strip() or f.suffix.lower() not in TEXT_EXTS or not f.is_file():
            continue
        try:
            if b"\x00" in f.read_bytes():
                bad.append(rel.strip())
        except OSError:
            continue
    if bad:
        print(f"  ❌ [ERROR] {name}: 改动文件中含裸 NUL 字节（会被 git 判为二进制、diff 不可读）："
              f"{', '.join(bad)} —— 请改用转义写法（如 Java 的 \"\\u0000\"）")
        return False
    print(f"  ✅ {name} 改动文件无裸 NUL 字节")
    return True


def main():
    root = lib.repo_root()
    print("🔍 Harness 硬门禁检查")
    print("====================")
    print("\n📥 [阶段1] 同步子模块（存在 sync.py 时）...")
    sync = root / ".harness" / "scripts" / "sync.py"
    if sync.is_file():
        lib.run([sys.executable, str(sync)], cwd=root)
    else:
        print("  ℹ️  无 sync.py（非子模块布局），跳过")

    print("\n🔧 [阶段2] 集成分支检查（仅警告，存在子模块时）...")
    if (root / ".gitmodules").is_file():
        check_integration_branch(root)
    else:
        print("  ℹ️  无子模块，跳过")

    ok_nul = True

    print("\n📏 [阶段3] 检查子工程规范行数...")
    dirs = lib.discover_service_dirs(root)
    for name, path in dirs:
        check_claude_lines(path)

    print("\n🪲 [阶段3.5] 检查改动文件是否含裸 NUL 字节...")
    for name, path in dirs:
        if not check_nul_bytes(path, name):
            ok_nul = False

    print("\n🔨 [阶段4] 技术硬门禁 (构建/Lint)...")
    ok = ok_nul
    for name, path in dirs:
        if not run_build(path, name):
            ok = False
    if not ok:
        print(f"{lib._color()['red']}❌{lib._color()['nc']} 构建存在失败")
        return 1
    print(f"\n{lib._color()['green']}🎉{lib._color()['nc']} 所有检查通过！")
    return 0


if __name__ == "__main__":
    sys.exit(main())
