#!/usr/bin/env python3
# .harness/scripts/codebase_guide_init.py
# 代码地图完整性检测 + 骨架生成 + 报告。--check-only：仅检测不生成。
#
# 2026-11 多语言适配：与 harness_init.py 共用 lib.enumerate_projects / lib.detect_project，
# 不再按 role 维护第二套目录探测；generic 项目也不会被静默跳过。
import sys
from pathlib import Path
import lib

FRONTEND_SKELETON = """# AGENTS.md — 前端项目入口

## Build

```bash
npm run dev     # 开发启动
npm run build   # 生产构建
npm run lint    # 代码检查
```

## 项目概述

<!-- TODO: 人工补充 — 技术栈、应用形态与架构简述 -->

## 目录结构

<!-- TODO: 人工补充 -->

## 关键框架模式

<!-- TODO: 人工补充 -->

## 关键约定

<!-- TODO: 人工补充 -->

## 参考文档

<!-- TODO: 人工补充 -->
"""

GENERIC_SKELETON = """# AGENTS.md — 项目入口

## Build

<!-- TODO: 人工补充 — 安装/编译/测试/启动命令 -->

## 项目概述

<!-- TODO: 人工补充 — 用途、语言/框架、入口 -->

## 目录结构

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

| 视图名 | 路径 | 说明 | 是否有扩展 |
|--------|------|------|-----------|
"""

COMPONENT_SKELETON = """# component — 共享组件库

## 组件清单

| 组件名 | 目录 | 用途 | 被哪些 App 使用 |
|--------|------|------|----------------|
"""

FULLSTACK_SKELETON = """# AGENTS.md — 前后端一体工程入口

## Build

<!-- TODO: 人工补充 — 后端与前端子项目构建命令 -->

## 项目概述

<!-- TODO: 人工补充 -->

## 目录结构

<!-- TODO: 人工补充 -->

## 关键框架模式

<!-- TODO: 人工补充 -->

## 关键约定

<!-- TODO: 人工补充 -->

## 模块发现

<!-- TODO: 人工补充 -->

## 参考文档

<!-- TODO: 人工补充 -->
"""

MODULE_SKELETON = """# {name} — <!-- TODO: 人工补充 -->

- **路径**：<!-- TODO: 人工补充 -->
- **domain**：<!-- TODO: 人工补充业务域标签 -->

## 职责

<!-- TODO: 人工补充 -->
"""


def _skeleton_for(project: dict) -> str:
    if project["template_kind"] == "generic":
        return GENERIC_SKELETON
    if project["role"] == "frontend":
        return FRONTEND_SKELETON
    if project["role"] == "mobile":
        return FRONTEND_SKELETON
    if project["role"] == "fullstack":
        return FULLSTACK_SKELETON
    return GENERIC_SKELETON


def _check_file_sections(path: Path, sections, label: str, check_only: bool,
                         generate, passed: int, failed: int, warned: int, generated: int):
    ref = lib.instruction_file(path)
    if ref is None:
        print(f"  ❌ {label}: AGENTS.md / CLAUDE.md 都不存在")
        failed += 1
        if not check_only and generate:
            target = path / "AGENTS.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(generate, encoding="utf-8")
            print("  🔧 已生成骨架")
            generated += 1
        return passed, failed, warned, generated
    text = ref.read_text(encoding="utf-8", errors="ignore")
    for section in sections:
        if f"## {section}" in text:
            passed += 1
        else:
            print(f"  ⚠️  {label}: 缺章节 [{section}]")
            warned += 1
    return passed, failed, warned, generated


def check_project(project: dict, check_only: bool, passed: int, failed: int,
                  warned: int, generated: int):
    path = Path(project["path_abs"])
    print(f"━━━ {project['name']} ({project['service_type']}, {project['tier']}) ━━━")
    sections = lib.doc_sections(project["service_type"], project["role"], project["template_kind"])
    passed, failed, warned, generated = _check_file_sections(
        path, sections, "根文档", check_only, _skeleton_for(project), passed, failed, warned, generated)

    if project["tier"] != "minimal":
        standards = path / "docs" / "CODE_STANDARDS.md"
        if standards.is_file():
            passed += 1
        else:
            print("  ❌ docs/CODE_STANDARDS.md 不存在（standard/full 档应生成）")
            failed += 1

    # 模块文档只在 full 档生成；standard/minimal 不检查，避免“计划没生成、校验却报缺”。
    if project["tier"] == "full":
        for module in project.get("modules") or []:
            mp = path / module["path"]
            template_meta = module.get("meta_keys") or []
            skeleton = APP_SKELETON.format(name=module["name"]) if module.get("kind") == "frontend" else MODULE_SKELETON.format(name=module["name"])
            passed, failed, warned, generated = _check_file_sections(
                mp, (), f"模块 {module['path']}", check_only,
                skeleton, passed, failed, warned, generated)
            ref = lib.instruction_file(mp)
            if ref is None:
                continue
            text = ref.read_text(encoding="utf-8", errors="ignore")
            ok = all(f"**{k}**" in text for k in template_meta)
            if ok:
                passed += 1
            else:
                print(f"  ⚠️  模块 {module['path']}: 缺元信息 {', '.join(template_meta)}")
                warned += 1
    return passed, failed, warned, generated


def main():
    check_only = "--check-only" in sys.argv[1:]
    root = lib.ROOT
    refs, warnings = lib.enumerate_projects(root)
    passed = failed = warned = generated = 0

    if not refs:
        print("  ℹ 未发现子工程（services/ 为空且 kit.sources 无有效路径）")
    for w in warnings:
        print(f"  ⚠ {w['message']}")

    for ref in refs:
        project = lib.detect_project(ref["path_abs"], name=ref["name"], source=ref["source"])
        project["path"] = ref["path"]
        project["path_abs"] = ref["path_abs"]
        passed, failed, warned, generated = check_project(
            project, check_only, passed, failed, warned, generated)

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
