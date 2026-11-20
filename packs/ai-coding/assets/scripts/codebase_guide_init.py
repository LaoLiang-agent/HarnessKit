#!/usr/bin/env python3
# .harness/scripts/codebase_guide_init.py
# 代码地图完整性检测 + 骨架生成 + 报告。--check-only：仅检测不生成。
import sys
from pathlib import Path
import lib

INSTRUCTION_NAMES = ("AGENTS.md", "CLAUDE.md")


def existing_instruction(path: Path):
    """已有入口文件：AGENTS.md 优先，兼容旧 CLAUDE.md；没有返回 None。"""
    for name in INSTRUCTION_NAMES:
        candidate = path / name
        if candidate.is_file():
            return candidate
    return None


def instruction_target(path: Path) -> Path:
    """新生成时只写 AGENTS.md（不生成 CLAUDE.md）。"""
    return path / "AGENTS.md"

# 模块 / App 级 AGENTS.md 的**机器可读元信息行**：行内加粗键值 `- **键**：值`，**不是** `### 标题`。
# 这是 `.harness/templates/*/{module,app}-CLAUDE.tmpl`（内容按 AGENTS.md 生成）与本检查器之间的**唯一契约**：
# 检查器按这些键做子串匹配，模板必须原样产出对应行 —— 模板若教标题形态，
# 「严格照模板生成」的文档必然报 WARN（历史上前端 41 个 App 全中）。
# `tests/harness/test_codebase_guide_init.py` 把两边钉死，改这里必须同步改模板。
META_KEYS_BACKEND_MODULE = ("路径", "domain")  # 后端模块
META_KEYS_FRONTEND = ("职责", "domain")        # 前端 App / fullstack 前端子项目
META_KEYS_DOMAIN_ONLY = ("domain",)            # .NET 项目 / fullstack 后端项目

FRONTEND_SKELETON = """# AGENTS.md — 前端项目入口

## Build

```bash
npm run dev     # 开发启动
npm run build   # 生产构建
npm run lint    # 代码检查
```

## 项目概述

<!-- TODO: 人工补充 — 技术栈、应用形态（单应用 / 微前端多 App）与架构简述 -->

## 目录结构

<!-- TODO: 人工补充 -->

## 关键框架模式

<!-- TODO: 人工补充 -->

## 关键约定

<!-- TODO: 人工补充 -->

## 参考文档

<!-- TODO: 人工补充 -->
"""

APP_SKELETON = """# {name} — <!-- TODO: 人工补充 displayName -->

- **职责**：<!-- TODO: 人工补充 -->
- **domain**：<!-- TODO: 人工补充业务域标签 -->
- **路由**：<!-- TODO: 人工补充 -->
- **依赖**：<!-- TODO: 人工补充 -->

## 页面/视图清单

<!-- TODO: 人工补充 -->

| 视图名 | 路径 | 说明 | 是否有扩展 |
|--------|------|------|-----------|
"""

COMPONENT_SKELETON = """# component — 共享组件库

## 组件清单

<!-- TODO: 人工补充 -->

| 组件名 | 目录 | 用途 | 被哪些 App 使用 |
|--------|------|------|----------------|
| <!-- TODO --> | | | |

## 使用说明

<!-- TODO: 人工补充 -->
"""

FULLSTACK_SKELETON = """# AGENTS.md — 前后端一体工程入口

## Build

```bash
# TODO: 人工补充 — 后端构建命令（如 dotnet build）与前端子项目构建命令
```

## 项目概述

<!-- TODO: 人工补充 — 后端 API 与前端子项目形态、技术栈概述 -->

## 目录结构

<!-- TODO: 人工补充 -->

## 关键框架模式

<!-- TODO: 人工补充 -->

## 关键约定

<!-- TODO: 人工补充 -->

## 模块发现

<!-- TODO: 人工补充 — 列出所有后端子项目目录名 -->

## 参考文档

<!-- TODO: 人工补充 -->
"""

MODULE_SKELETON = """# {name} — <!-- TODO: 人工补充 -->

- **路径**：<!-- TODO: 人工补充 -->
- **domain**：<!-- TODO: 人工补充业务域标签 -->

## 职责

<!-- TODO: 人工补充 -->
"""


def find_services_by_role(root: Path) -> dict:
    """按角色聚合服务路径：{"backend": [...], "frontend": [...], "mobile": [...], "fullstack": [...]}。

    fullstack 服务同时含后端标记与前端标记（如 .NET 主仓内嵌 SPA/Blazor 前端），
    需对根、后端项目、前端子项目三层检查。角色判定见 lib.detect_service_role。
    frontend = 微前端多 App（apps/ 布局）；mobile = 单应用形态（无 apps/ 布局：
    移动端 H5、uni-app 多端、桌面 SPA），两者文档形态相同（根 + 可选 apps），故共用 check_frontend。
    """
    out = {"backend": [], "frontend": [], "mobile": [], "fullstack": []}
    for name, path in lib.discover_service_dirs(root):
        role = lib.detect_service_role(path)
        if role in out:
            out[role].append(path)
    return out


def backend_module_dirs(backend_path: Path) -> list:
    """后端模块容器目录列表（结构识别：聚合 pom + 无自身 src + 带 src 子目录）；无则返回 []。

    可存在多个容器（如业务模块容器 / 公共模块容器并存），全部返回逐一检查。
    """
    return [d for d in sorted(backend_path.iterdir())
            if d.is_dir() and lib.is_maven_container(d)]


def check_backend(backend: Path, passed: int, failed: int, warned: int):
    """后端根 + 模块入口检查（AGENTS.md 优先，兼容 CLAUDE.md）。返回 (passed, failed, warned)。"""
    bref = existing_instruction(backend)
    if bref is not None:
        t = bref.read_text(encoding="utf-8", errors="ignore")
        for s in ("Build", "项目概述", "关键框架模式", "关键约定", "模块发现", "参考文档"):
            if f"## {s}" in t:
                passed += 1
            else:
                print(f"  ⚠️  段 [{s}] 缺失"); warned += 1
    else:
        print(f"  ❌ {backend/'AGENTS.md'} 或 CLAUDE.md 都不存在！"); failed += 1

    stype = lib.detect_service_type(backend)
    if stype in ("dotnet", "dotnet-multimodule"):
        # .NET 后端：模块 = 项目级 AGENTS.md（module-AGENTS.tmpl 要求 domain 标签）
        for m in lib.list_dotnet_projects(backend):
            cf = existing_instruction(Path(m["path"]))
            if cf is None:
                print(f"  ❌ [{m['name']}] AGENTS.md / CLAUDE.md 都不存在！"); failed += 1
                continue
            t = cf.read_text(encoding="utf-8", errors="ignore")
            ok = all(f"**{k}**" in t for k in META_KEYS_DOMAIN_ONLY)
            passed += ok; warned += (not ok)
            if not ok:
                print(f"  ⚠️  [{m['name']}] 缺必需段")
    else:
        # Maven：后端模块（全部结构识别的容器）
        for mod_dir in backend_module_dirs(backend):
            for d in sorted(mod_dir.iterdir()):
                if not d.is_dir():
                    continue
                cf = existing_instruction(d)
                if cf is None:
                    print(f"  ❌ [{d.name}] AGENTS.md / CLAUDE.md 都不存在！"); failed += 1
                    continue
                t = cf.read_text(encoding="utf-8", errors="ignore")
                ok = all(f"**{k}**" in t for k in META_KEYS_BACKEND_MODULE)
                passed += ok; warned += (not ok)
                if not ok:
                    print(f"  ⚠️  [{d.name}] 缺必需段")
    return passed, failed, warned


def check_frontend(frontend: Path, check_only: bool, passed: int, failed: int, warned: int, generated: int):
    """前端根 + apps + component 入口检查（AGENTS.md 优先，兼容 CLAUDE.md）（无 apps/ 布局则不要求 component）。返回 4 元组。

    微前端多 App（role=frontend）与单应用形态（role=mobile：移动端 H5 / uni-app / 桌面 SPA）
    同用此检查：apps/ 存在才检查 App 级与 component 骨架，不存在则只查根 AGENTS.md。
    """
    fref = existing_instruction(frontend)
    if fref is not None:
        t = fref.read_text(encoding="utf-8", errors="ignore")
        for s in ("Build", "项目概述", "目录结构", "关键框架模式", "关键约定", "参考文档"):
            if f"## {s}" in t:
                passed += 1
            else:
                print(f"  ⚠️  段 [{s}] 缺失"); warned += 1
    else:
        print(f"  ❌ {frontend/'AGENTS.md'} 或 CLAUDE.md 都不存在！"); failed += 1
        if not check_only:
            target = instruction_target(frontend)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(FRONTEND_SKELETON, encoding="utf-8")
            print("  🔧 已生成骨架"); generated += 1

    # 前端 apps（无 apps/ 布局 → 不要求 app/component 骨架）
    apps_dir = frontend / "apps"
    if apps_dir.is_dir():
        for d in sorted(apps_dir.iterdir()):
            if not d.is_dir() or d.name == "component":
                continue
            cf = existing_instruction(d)
            if cf is None:
                print(f"  ❌ [{d.name}] AGENTS.md / CLAUDE.md 都不存在！"); failed += 1
                if not check_only:
                    target = instruction_target(d)
                    target.write_text(APP_SKELETON.format(name=d.name), encoding="utf-8")
                    print("  🔧 已生成骨架"); generated += 1
            else:
                t = cf.read_text(encoding="utf-8", errors="ignore")
                ok = all(f"**{k}**" in t for k in META_KEYS_FRONTEND)
                passed += ok; warned += (not ok)

        # component（共享组件库，仅 apps/ 布局下要求）
        comp = existing_instruction(apps_dir / "component")
        if comp is not None:
            passed += 1
        else:
            failed += 1
            if not check_only:
                target = instruction_target(apps_dir / "component")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(COMPONENT_SKELETON, encoding="utf-8")
                print("  🔧 已生成 component 骨架"); generated += 1
    return passed, failed, warned, generated


FULLSTACK_SECTIONS = ("Build", "项目概述", "目录结构", "关键框架模式", "关键约定", "模块发现", "参考文档")


def check_fullstack(fs: Path, check_only: bool, passed: int, failed: int, warned: int, generated: int):
    """fullstack 服务检查：根 AGENTS.md/CLAUDE.md 覆盖并集章节（后端+前端），后端项目 + 前端子项目文档齐全。返回 4 元组。"""
    ref = existing_instruction(fs)
    if ref is not None:
        t = ref.read_text(encoding="utf-8", errors="ignore")
        for s in FULLSTACK_SECTIONS:
            if f"## {s}" in t:
                passed += 1
            else:
                print(f"  ⚠️  段 [{s}] 缺失"); warned += 1
    else:
        print(f"  ❌ {fs/'AGENTS.md'} 或 CLAUDE.md 都不存在！"); failed += 1
        if not check_only:
            target = instruction_target(fs)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(FULLSTACK_SKELETON, encoding="utf-8")
            print("  🔧 已生成骨架"); generated += 1

    # 后端项目（.NET 后端项目 → 项目级 AGENTS.md）
    for m in lib.list_dotnet_projects(fs):
        cf = existing_instruction(Path(m["path"]))
        if cf is None:
            print(f"  ❌ [{m['name']}] AGENTS.md / CLAUDE.md 都不存在！"); failed += 1
            if not check_only:
                target = instruction_target(Path(m["path"]))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(MODULE_SKELETON.format(name=m["name"]), encoding="utf-8")
                print("  🔧 已生成骨架"); generated += 1
            continue
        t = cf.read_text(encoding="utf-8", errors="ignore")
        ok = all(f"**{k}**" in t for k in META_KEYS_DOMAIN_ONLY)
        passed += ok; warned += (not ok)
        if not ok:
            print(f"  ⚠️  [{m['name']}] 缺必需段")

    # 前端子项目（SPA / Blazor WASM → app 级 AGENTS.md）
    for m in lib.list_frontend_projects(fs):
        cf = existing_instruction(Path(m["path"]))
        if cf is None:
            print(f"  ❌ [{m['name']}] AGENTS.md / CLAUDE.md 都不存在！"); failed += 1
            if not check_only:
                target = instruction_target(Path(m["path"]))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(APP_SKELETON.format(name=m["name"]), encoding="utf-8")
                print("  🔧 已生成骨架"); generated += 1
            continue
        t = cf.read_text(encoding="utf-8", errors="ignore")
        ok = all(f"**{k}**" in t for k in META_KEYS_FRONTEND)
        passed += ok; warned += (not ok)
        if not ok:
            print(f"  ⚠️  [{m['name']}] 缺必需段")
    return passed, failed, warned, generated


def main():
    check_only = "--check-only" in sys.argv[1:]
    root = lib.repo_root()
    passed = failed = warned = generated = 0

    by_role = find_services_by_role(root)
    if not any(by_role.values()):
        print("  ℹ 未检测到后端/前端服务，跳过检查")
    # 后端（role=backend）
    for b in by_role["backend"]:
        passed, failed, warned = check_backend(b, passed, failed, warned)
    # 前端（role=frontend 微前端多 App 与 role=mobile 单应用 SPA 同形，共用一份检查）
    for f in by_role["frontend"] + by_role["mobile"]:
        passed, failed, warned, generated = check_frontend(f, check_only, passed, failed, warned, generated)
    # fullstack（前后端同仓库：根 + 后端项目 + 前端子项目三层）
    for fs in by_role["fullstack"]:
        passed, failed, warned, generated = check_fullstack(fs, check_only, passed, failed, warned, generated)

    print("\n============================================")
    print("代码地图完整性报告")
    print("============================================")
    print(f"PASS:   {passed}")
    print(f"WARN:   {warned}")
    print(f"FAIL:   {failed}")
    if generated and not check_only:
        print(f"GENERATED: {generated} 个骨架文件（含 TODO 标记，需人工补充）")
    if failed:
        print(f"存在 {failed} 个缺失项")
        return 1
    print("代码地图检查完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
