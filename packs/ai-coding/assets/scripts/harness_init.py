#!/usr/bin/env python3
# .harness/scripts/harness_init.py
# Harness 脚手架：探测子工程结构，生成初始化计划 JSON。
#
# 用法:
#   python3 harness_init.py --detect [--tier minimal|standard|full]
#       探测并写 .harness/.logs/workflow/harness-init-plan.json（AI 读文件）
#   python3 harness_init.py --json [--tier ...]
#       计划打到 stdout，不落盘
#   python3 harness_init.py --write-overview [--tier minimal|standard|full] [--dry-run]
#       把确定性子工程地图写入 .harness/codebase-guide/overview.md（只改标记块）
#   python3 harness_init.py --write-build <子工程|路径> [--dry-run]
#       [--keys install,compile,test,lint] [--keep-template-defaults]
#       把推断出的构建命令写入 <子工程>/.harness/build.json；不覆盖人工定制的非默认值
#   python3 harness_init.py
#       交互展示
#
# 设计约束（2026-11 多语言适配）：
# - 绝不静默跳过：无专用模板 → generic；未知语言也进计划。
# - 三档生成：minimal（AGENTS+build）/ standard（+CODE_STANDARDS）/
#   full（+模块文档）；默认专用模板 standard、通用模板 minimal。
# - 计划与 codebase_guide_init.py 共用 lib.enumerate_projects / lib.detect_project。
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import lib

PLAN_PATH = Path(".harness") / ".logs" / "workflow" / "harness-init-plan.json"
OVERVIEW_PATH = Path(".harness") / "codebase-guide" / "overview.md"
OVERVIEW_BEGIN = "<!-- hk:overview:begin -->"
OVERVIEW_END = "<!-- hk:overview:end -->"
TIER_ORDER = {"minimal": 0, "standard": 1, "full": 2}
BUILD_KEYS = ("install", "compile", "test", "lint")


def _templates_root(root: Path) -> Path:
    return root / ".harness" / "templates"


def _template_file(root: Path, tdir: str, name: str) -> Path:
    return _templates_root(root) / tdir / name


def build_json_missing_keys(root: Path, project: dict, template: str) -> list:
    """已存在的 build.json 相对模板缺哪些键（只比键，不比 value）。"""
    try:
        tmpl = json.loads((root / ".harness" / "templates" / template).read_text(encoding="utf-8"))
        cur = json.loads((Path(project["path_abs"]) / ".harness" / "build.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(tmpl, dict) or not isinstance(cur, dict):
        return []
    return [k for k in tmpl if k not in cur]


def _build_template(project: dict) -> str:
    return f"{project['template_dir']}/build.tmpl"


def _code_template(root: Path, project: dict) -> str:
    tdir = project["template_dir"]
    if _template_file(root, tdir, "CODE_STANDARDS.tmpl").is_file():
        return f"{tdir}/CODE_STANDARDS.tmpl"
    return "generic/CODE_STANDARDS.tmpl"


def _root_template(root: Path, project: dict) -> str:
    tdir = project["template_dir"]
    if _template_file(root, tdir, "root-AGENTS.tmpl").is_file():
        return f"{tdir}/root-AGENTS.tmpl"
    if _template_file(root, tdir, "root-CLAUDE.tmpl").is_file():
        return f"{tdir}/root-CLAUDE.tmpl"
    return "generic/root-AGENTS.tmpl"


def _file_status(path: Path, rel: str) -> str:
    return "EXISTS" if (path / rel).is_file() else "MISSING"


def _codegraph_config(root: Path) -> dict:
    kit = lib.read_json(root / ".harness" / "kit.json")
    cfg = kit.get("codegraph") if isinstance(kit.get("codegraph"), dict) else {}
    return {
        "enabled": cfg.get("enabled", True) is not False,
        "pin": cfg.get("pin") or "^1.4.0",
    }


def generate_plan(root: Path, tier_override: str = "") -> dict:
    root = Path(root)
    if tier_override and tier_override not in TIER_ORDER:
        raise ValueError(f"非法 tier：{tier_override}（可选 minimal/standard/full）")
    refs, warnings = lib.enumerate_projects(root)
    cg_cfg = _codegraph_config(root)
    subprojects = []

    for ref in refs:
        project = lib.detect_project(ref["path_abs"], name=ref["name"], source=ref["source"])
        # path 统一用枚举结果（支持自定义/嵌套 path，而不是硬编码 services/<name>）
        project["path"] = ref["path"]
        project["path_abs"] = ref["path_abs"]
        project["source"] = ref["source_kind"]
        tier = tier_override or project.get("tier") or ("minimal" if project["template_kind"] == "generic" else "standard")
        if tier not in TIER_ORDER:
            project["warnings"].append(f"非法 tier {tier!r}，已回落 standard")
            tier = "standard"
        project["tier"] = tier
        project["tier_source"] = "cli" if tier_override else ("source" if ref["source"].get("tier") else "default")
        project["modules_enabled"] = tier == "full"
        project["codegraph_enabled"] = cg_cfg["enabled"] and ref["source"].get("codegraph", True) is not False

        root_files = {
            ".harness/build.json": {
                "status": _file_status(Path(ref["path_abs"]), ".harness/build.json"),
                "template": _build_template(project),
                "missing_keys": build_json_missing_keys(root, {
                    "path_abs": ref["path_abs"],
                }, _build_template(project)),
            },
            "AGENTS.md": {
                "status": "EXISTS" if lib.instruction_file(Path(ref["path_abs"])) else "MISSING",
                "template": _root_template(root, project),
            },
        }
        if TIER_ORDER[tier] >= TIER_ORDER["standard"]:
            root_files["docs/CODE_STANDARDS.md"] = {
                "status": _file_status(Path(ref["path_abs"]), "docs/CODE_STANDARDS.md"),
                "template": _code_template(root, project),
            }
        project["root_files"] = root_files
        subprojects.append(project)

    summary = {
        "total": len(subprojects),
        "dedicated": sum(1 for p in subprojects if p["template_kind"] == "dedicated"),
        "generic": sum(1 for p in subprojects if p["template_kind"] == "generic"),
        "override": sum(1 for p in subprojects if p["template_kind"] == "override"),
        "minimal": sum(1 for p in subprojects if p["tier"] == "minimal"),
        "standard": sum(1 for p in subprojects if p["tier"] == "standard"),
        "full": sum(1 for p in subprojects if p["tier"] == "full"),
        "modules": sum(len(p["modules"]) for p in subprojects),
        "modules_enabled": sum(len(p["modules"]) for p in subprojects if p["modules_enabled"]),
        "skipped": 0,
    }
    missing = [w for w in warnings if w.get("code") == "missing_source"]
    return {
        "schema": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root": str(root),
        "codegraph": cg_cfg,
        "summary": summary,
        "warnings": warnings + [w for p in subprojects for w in p.get("warnings", [])],
        "missing_sources": missing,
        "subprojects": subprojects,
    }


def _print_interactive(root: Path, plan: dict) -> int:
    if not (root / "services").is_dir() and not plan["subprojects"]:
        print("⚠ 未检测到 services/ 目录，工程可能还未接入子工程。")
        return 1
    s = plan["summary"]
    print(f"探测完成：{s['total']} 个子工程 / {s['modules']} 个模块"
          f"（专用模板 {s['dedicated']}，通用模板 {s['generic']}；"
          f"minimal {s['minimal']} / standard {s['standard']} / full {s['full']}）")
    for w in plan["missing_sources"]:
        print(f"  ⚠ {w['message']}")
    for sp in plan["subprojects"]:
        flags = []
        if sp["template_kind"] == "generic":
            flags.append("通用模板，命令需人工确认")
        if sp["modules"] and not sp["modules_enabled"]:
            flags.append(f"{len(sp['modules'])} 个模块需 full 档才生成")
        print(f"━━━ {sp['name']} ({sp['service_type']}, {sp['tier']}) ━━━")
        print(f"  路径: {sp['path']}  角色: {sp['role']}  模板: {sp['template_dir']}"
              f"（{'专用' if sp['template_kind'] == 'dedicated' else '通用'}）")
        for fk, fi in sp["root_files"].items():
            mk = fi.get("missing_keys") or []
            suffix = f" → 补 {len(mk)} 个缺失字段 ({', '.join(mk)})" if mk else ""
            print(f"  {'✅' if fi['status'] == 'EXISTS' else '⬜'} {fk}: {fi['status']}{suffix}")
        print(f"  {'✅' if sp['codegraph'] == 'EXISTS' else '⬜'} codegraph: {sp['codegraph']}"
              f"{'' if sp['codegraph_enabled'] else '（已禁用）'}")
        if sp["modules"]:
            print(f"  📦 模块 ({len(sp['modules'])}，{'full 档生成' if sp['modules_enabled'] else '当前档不生成'})")
        if flags:
            print(f"  ⚠ {'；'.join(flags)}")
    print("\n请确认以上计划；未内置技术栈会使用 generic 模板，构建命令需逐项确认。")
    return 0


def _write_plan(root: Path, plan: dict) -> Path:
    out = root / PLAN_PATH
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def _cell(value) -> str:
    return str(value if value is not None else "").replace("|", "\\|").replace("\n", " ")


def _overview_block(plan: dict) -> str:
    """只写机器事实：子工程、技术栈、构建工具、角色、档位、路径。"""
    rows = []
    for p in plan.get("subprojects") or []:
        stack = p.get("service_type") or p.get("type") or "unknown"
        fw = p.get("framework") or ""
        if fw and fw != stack and fw not in ("java", "python", "go", "rust", "dotnet", "gradle"):
            stack = f"{stack} ({fw})"
        rows.append("| {name} | {stack} | {tool} | {role} | {tier} | `{path}` |".format(
            name=_cell(p.get("name")),
            stack=_cell(stack),
            tool=_cell(p.get("build_tool") or "—"),
            role=_cell(p.get("role") or "unknown"),
            tier=_cell(p.get("tier") or "—"),
            path=_cell(p.get("path")),
        ))
    if not rows:
        rows.append("| （未发现子工程） | — | — | — | — | — |")
    lines = [
        OVERVIEW_BEGIN,
        "| 子工程 | 技术栈 | 构建工具 | 角色 | 档位 | 路径 |",
        "|---|---|---|---|---|---|",
        *rows,
    ]
    missing = plan.get("missing_sources") or []
    if missing:
        lines += ["", "> 未找到的登记来源：" + "、".join(f"`{_cell(m.get('path'))}`" for m in missing)]
    lines.append(OVERVIEW_END)
    return "\n".join(lines)


def _load_overview_plan(root: Path, tier_override: str) -> dict:
    if not tier_override:
        try:
            plan = json.loads((root / PLAN_PATH).read_text(encoding="utf-8"))
            if isinstance(plan, dict) and plan.get("schema") == 2 and isinstance(plan.get("subprojects"), list):
                return plan
        except (OSError, json.JSONDecodeError):
            pass
    return generate_plan(root, tier_override)


def write_overview(root: Path, tier_override: str = "", dry_run: bool = False) -> int:
    """把确定性子工程地图写入 .harness/codebase-guide/overview.md 的标记块。

    - 有标记 → 只替换块内；块外散文/人工内容保留；
    - 无标记 → 追加一个独立章节（首次接管），不覆盖原文；
    - 文件不存在 → 创建最小骨架 + 地图。
    """
    plan = _load_overview_plan(root, tier_override)
    block = _overview_block(plan)
    target = root / OVERVIEW_PATH
    old = target.read_text(encoding="utf-8") if target.is_file() else ""
    if not old:
        new = ("# 项目架构总览\n\n"
               "> 由 Harness Kit 维护：子工程地图自动更新，架构描述由人/AI 补全。\n\n"
               "## 子工程地图（Harness Kit 自动维护）\n\n" + block + "\n")
    elif OVERVIEW_BEGIN in old and OVERVIEW_END in old and old.index(OVERVIEW_BEGIN) < old.index(OVERVIEW_END):
        b = old.index(OVERVIEW_BEGIN)
        e = old.index(OVERVIEW_END) + len(OVERVIEW_END)
        new = old[:b] + block + old[e:]
    else:
        new = old.rstrip() + "\n\n## 子工程地图（Harness Kit 自动维护）\n\n" + block + "\n"
    if dry_run:
        print(block)
        return 0
    if new == old:
        print(f"未变化：{OVERVIEW_PATH.as_posix()}（{len(plan.get('subprojects') or [])} 个子工程）")
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".md.tmp")
    tmp.write_text(new, encoding="utf-8")
    os.replace(tmp, target)
    print(f"✅ {OVERVIEW_PATH.as_posix()}: 已写入 {len(plan.get('subprojects') or [])} 个子工程的地图")
    return 0


def _resolve_target(root: Path, target: str):
    refs, _ = lib.enumerate_projects(root)
    norm = target.replace("\\", "/").strip().strip("/")
    for ref in refs:
        if norm in (ref["name"], ref["path"], ref["path_abs"]) or norm == Path(ref["path_abs"]).name:
            project = lib.detect_project(ref["path_abs"], name=ref["name"], source=ref["source"])
            project["path"] = ref["path"]
            return project
    return None


def _parse_args(argv: list) -> dict:
    opts = {"mode": "", "target": "", "tier": "", "dry_run": False,
            "keys": list(BUILD_KEYS), "keep_template_defaults": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--detect", "--json", "--write-build", "write-build", "--write-overview"):
            if a == "--json":
                opts["mode"] = "--json"
            elif a == "--write-overview":
                opts["mode"] = "--write-overview"
            else:
                opts["mode"] = "--write-build" if "write" in a else "--detect"
        elif a == "--tier" and i + 1 < len(argv):
            opts["tier"] = argv[i + 1]
            i += 1
        elif a.startswith("--tier="):
            opts["tier"] = a.split("=", 1)[1]
        elif a == "--dry-run":
            opts["dry_run"] = True
        elif a == "--keep-template-defaults":
            opts["keep_template_defaults"] = True
        elif a == "--keys" and i + 1 < len(argv):
            opts["keys"] = [k.strip() for k in argv[i + 1].split(",") if k.strip()]
            i += 1
        elif a.startswith("--keys="):
            opts["keys"] = [k.strip() for k in a.split("=", 1)[1].split(",") if k.strip()]
        elif not a.startswith("-") and not opts["target"]:
            opts["target"] = a
        i += 1
    if not opts["mode"]:
        opts["mode"] = "interactive"
    return opts


def write_build(root: Path, target: str, keys: list, dry_run: bool,
                keep_template_defaults: bool) -> int:
    project = _resolve_target(root, target)
    if project is None:
        refs, _ = lib.enumerate_projects(root)
        names = ", ".join(r["name"] for r in refs) or "（无）"
        print(f"错误：找不到子工程 {target!r}。可用：{names}")
        return 2
    p = Path(project["path_abs"])
    tmpl_rel = _build_template(project)
    tmpl_path = _template_file(root, project["template_dir"], "build.tmpl")
    if not tmpl_path.is_file():
        tmpl_rel = "generic/build.tmpl"
        tmpl_path = _template_file(root, "generic", "build.tmpl")
    try:
        template = json.loads(tmpl_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"错误：读取模板失败 {tmpl_path}: {e}")
        return 3
    cfg_path = p / ".harness" / "build.json"
    current = {}
    if cfg_path.is_file():
        try:
            current = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"错误：{cfg_path} 不是合法 JSON：{e}；未写入")
            return 3
        if not isinstance(current, dict):
            print(f"错误：{cfg_path} 顶层不是对象；未写入")
            return 3

    merged = dict(template)
    merged.update(current)
    suggestions = project.get("build_suggestion") or {}
    rows, changed = [], []
    for key in keys:
        suggestion = suggestions.get(key) or {}
        value = str(suggestion.get("value") or "")
        source = suggestion.get("source") or ""
        cur = merged.get(key, "")
        cur_s = "" if cur is None else str(cur)
        action = "保持"
        if not value:
            action = "跳过（无建议）"
        elif not cur_s:
            merged[key] = value
            action = "写入"
            changed.append(key)
        elif cur_s == value:
            action = "已一致"
        elif cur_s == str(template.get(key, "")) and not keep_template_defaults:
            merged[key] = value
            action = "替换模板占位"
            changed.append(key)
        rows.append((key, cur_s or "—", value or "—", source or "—", action))

    print(f"子工程: {project['name']} ({project['path']})")
    print(f"模板:   .harness/templates/{tmpl_rel}")
    print(f"{'键':<8}{'当前':<24}{'建议':<44}{'来源':<24}动作")
    for key, cur, sug, src, action in rows:
        print(f"{key:<8}{cur[:23]:<24}{sug[:43]:<44}{src[:23]:<24}{action}")
    if dry_run:
        print("\n（--dry-run：未写入）")
        return 0
    if not changed:
        print("\n没有需要写入的键。")
        return 0
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, cfg_path)
    print(f"\n✅ {cfg_path}: 已写入 {', '.join(changed)}（{len(changed)} 项）")
    return 0


def main():
    opts = _parse_args(sys.argv[1:])
    root = lib.ROOT
    if opts["mode"] == "--write-overview":
        return write_overview(root, opts["tier"], opts["dry_run"])
    if opts["mode"] == "--write-build":
        if not opts["target"]:
            print("用法: python3 .harness/scripts/harness_init.py --write-build <子工程|路径> [--dry-run]")
            return 2
        return write_build(root, opts["target"], opts["keys"], opts["dry_run"], opts["keep_template_defaults"])
    try:
        plan = generate_plan(root, opts["tier"])
    except ValueError as e:
        print(f"错误：{e}")
        return 2
    if opts["mode"] == "--json":
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    if opts["mode"] == "--detect":
        out = _write_plan(root, plan)
        s = plan["summary"]
        print(f"探测完成：{s['total']} 个子工程 / {s['modules']} 个模块"
              f"（专用模板 {s['dedicated']}，通用模板 {s['generic']}；"
              f"minimal {s['minimal']} / standard {s['standard']} / full {s['full']}）→ {out.relative_to(root).as_posix()}")
        for w in plan["missing_sources"]:
            print(f"⚠ {w['message']}")
        generic = [p["name"] for p in plan["subprojects"] if p["template_kind"] == "generic"]
        if generic:
            print(f"⚠ 以下子工程无内置模板，将使用 generic（命令需人工确认）：{', '.join(generic)}")
        return 0
    return _print_interactive(root, plan)


if __name__ == "__main__":
    sys.exit(main())
