#!/usr/bin/env python3
# .harness/scripts/harness_init.py
# Harness 脚手架：探测子工程结构，生成初始化计划 JSON。
# 用法:
#   python3 harness_init.py --detect    # 探测并把计划写入 .harness/.logs/workflow/harness-init-plan.json（AI 读文件）
#   python3 harness_init.py --json      # 计划打到 stdout，不落盘
#   python3 harness_init.py             # 交互展示
import json, sys
from pathlib import Path
import lib

TEMPLATES_DIR = lib.repo_root() / ".harness" / "templates"
PLAN_PATH = Path(".harness") / ".logs" / "workflow" / "harness-init-plan.json"


def get_template_dir(sp_type: str) -> str:
    return {
        "maven-multimodule": "java/maven-multimodule",
        "maven": "java/maven",
        "vue-multimodule": "javascript/vue-multimodule",
        "mobile-app": "javascript/mobile-app",
        "uniapp": "javascript/uniapp",
        "dotnet": "dotnet/dotnet-multimodule",
        "dotnet-multimodule": "dotnet/dotnet-multimodule",
    }.get(sp_type, "")


def list_frontend_apps(path: Path):
    apps_dir = path / "apps"
    if not apps_dir.is_dir():
        return []
    out = []
    for d in sorted(apps_dir.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in ("node_modules", "target", "dist", "build"):
            continue
        if list(d.glob("*.vue")) or (d / "store").is_dir() or (d / "views").is_dir() or (d / "router").is_dir():
            out.append({"name": d.name, "parent": str(apps_dir), "path": str(d)})
    return out


def list_maven_modules(path: Path):
    """枚举 Maven 模块：顶层 pom+src 目录 + 结构识别的扁平容器目录下的模块子目录（含去重）。

    容器识别为结构探测（lib.is_maven_container）：有聚合 pom.xml、自身无 src、存在带 src 的子目录。
    顶层模块先枚举（同名优先），随后容器内的扁平子目录补入，path 保留嵌套段。
    """
    out, seen = [], set()
    containers = []
    for d in sorted(path.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        if (d / "pom.xml").is_file() and (d / "src").is_dir():
            if d.name not in lib.MODULE_DIR_EXCLUDES:
                out.append({"name": d.name, "parent": str(path), "path": str(d)})
                seen.add(d.name)
        elif lib.is_maven_container(d):
            containers.append(d)
    for child in containers:
        for d in sorted(child.iterdir()):
            if not (d.is_dir() and (d / "src").is_dir()):
                continue
            if d.name.startswith(".") or d.name in lib.MODULE_DIR_EXCLUDES or d.name in seen:
                continue
            out.append({"name": d.name, "parent": str(child), "path": str(d)})
    return out


def check_file(root: Path, rel: str) -> str:
    return "EXISTS" if (root / rel).is_file() else "MISSING"


def build_json_missing_keys(root: Path, rel: str, template: str) -> list:
    """已存在的 build.json 相对模板缺哪些键。

    **只比键、不比 value**：值是工程事实（`start-ok` 要 Step 7b 靠真实运行补齐，
    各工程的命令也各不相同），按值比对会把正常的差异报成「待修」。

    没有这个函数时，已存在的 build.json 一律只判 EXISTS 就跳过——模板加了新字段
    也传不到存量工程（build.json 是模板纯拷贝，没有 AI 分析环节可以「顺带想到」）。
    """
    try:
        tmpl = json.loads((root / ".harness" / "templates" / template).read_text(encoding="utf-8"))
        cur = json.loads((root / rel / ".harness" / "build.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 读不了 / 非法 JSON 不在这里报——交由 check_harness.py 的「存量 build.json 体检」响亮报错
        return []
    if not isinstance(tmpl, dict) or not isinstance(cur, dict):
        return []
    return [k for k in tmpl if k not in cur]


def generate_plan(root: Path) -> dict:
    subprojects = []
    for name, path in lib.discover_service_dirs(root):
        stype = lib.detect_service_type(path)
        tdir = get_template_dir(stype)
        if not tdir:
            continue
        rel = f"services/{name}"
        sp = {
            "name": name, "path": rel, "path_abs": str(path), "type": stype,
            "role": lib.detect_service_role(path),
            "template_dir": tdir,
            # 键序 = 生成顺序（有依赖，勿打乱）：先落盘 build.json 与 docs/CODE_STANDARDS.md，
            # 最后才生成 CLAUDE.md —— 它是唯一要引用同批产物的文件（「参考文档」段列 CODE_STANDARDS.md），
            # 先落盘会让子 Agent 读盘时看不到 docs/，据实写出「工程没有 docs 目录」。
            "root_files": {
                # missing_keys 让存量工程能被「补齐」而非只判 EXISTS 跳过（模板加字段的唯一传播路径）
                ".harness/build.json": {
                    "status": check_file(root, f"{rel}/.harness/build.json"),
                    "template": f"{tdir}/build.tmpl",
                    "missing_keys": build_json_missing_keys(root, rel, f"{tdir}/build.tmpl"),
                },
                "docs/CODE_STANDARDS.md": {"status": check_file(root, f"{rel}/docs/CODE_STANDARDS.md"), "template": f"{tdir}/CODE_STANDARDS.tmpl"},
                "CLAUDE.md": {"status": check_file(root, f"{rel}/CLAUDE.md"), "template": f"{tdir}/root-CLAUDE.tmpl"},
            },
            "codegraph": "EXISTS" if (path / ".codegraph").is_dir() else "MISSING",
            "modules": [],
        }
        # mobile-app（单应用 SPA）与 uniapp（uni-app 多端）都无 apps/ 子应用容器：
        # 只生成根级 L1/L1.5/L2，modules 保持为空 —— 故此处不设分支。
        if stype == "vue-multimodule":
            sp["modules"] = [{"name": m["name"], "path": f"services/{name}/apps/{m['name']}",
                              "template": f"{tdir}/app-CLAUDE.tmpl",
                              "status": "EXISTS" if (Path(m["path"]) / "CLAUDE.md").is_file() else "MISSING"}
                             for m in list_frontend_apps(path)]
        elif stype == "maven-multimodule":
            sp["modules"] = [{"name": m["name"],
                              "path": f"services/{name}/{Path(m['parent']).relative_to(path) / m['name']}",
                              "template": f"{tdir}/module-CLAUDE.tmpl",
                              "status": "EXISTS" if (Path(m["path"]) / "CLAUDE.md").is_file() else "MISSING"}
                             for m in list_maven_modules(path)]
        elif stype in ("dotnet", "dotnet-multimodule"):
            # 后端项目 → module-CLAUDE.tmpl；前端子项目（SPA/Blazor WASM）→ app-CLAUDE.tmpl
            sp["modules"] = [
                {"name": m["name"], "path": f"services/{name}/{m['name']}",
                 "template": f"{tdir}/module-CLAUDE.tmpl",
                 "status": "EXISTS" if (Path(m["path"]) / "CLAUDE.md").is_file() else "MISSING"}
                for m in lib.list_dotnet_projects(path)
            ] + [
                {"name": m["name"], "path": f"services/{name}/{m['name']}",
                 "template": f"{tdir}/app-CLAUDE.tmpl",
                 "status": "EXISTS" if (Path(m["path"]) / "CLAUDE.md").is_file() else "MISSING"}
                for m in lib.list_frontend_projects(path)
            ]
        subprojects.append(sp)
    return {"subprojects": subprojects}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    root = lib.repo_root()
    plan = generate_plan(root)
    if mode in ("--detect", "--json"):
        payload = json.dumps(plan, ensure_ascii=False, indent=2)
        if mode == "--detect":
            # 计划落盘供 AI 读取（大工程模块多，stdout 输出不便复核）；stdout 只留一行摘要。
            out = root / PLAN_PATH
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(payload + "\n", encoding="utf-8")
            n_sp = len(plan["subprojects"])
            n_mod = sum(len(sp["modules"]) for sp in plan["subprojects"])
            print(f"探测完成：{n_sp} 个子工程 / {n_mod} 个模块 → {PLAN_PATH.as_posix()}")
        else:
            print(payload)
        return 0
    if not (root / "services").is_dir():
        print("⚠ 未检测到 services/ 目录，工程可能还未接入子工程。")
        return 1
    stale = 0
    for sp in plan["subprojects"]:
        print(f"━━━ {sp['name']} ({sp['type']}) ━━━")
        print(f"  模板: .harness/templates/{sp['template_dir']}/")
        for fk, fi in sp["root_files"].items():
            mk = fi.get("missing_keys") or []
            if mk:
                # 只印 EXISTS 会让人以为「没事可做」——真实情况是老字段没跟上模板
                print(f"  ♻️  {fk}: EXISTS → 补 {len(mk)} 个缺失字段 ({', '.join(mk)})")
                stale += 1
            else:
                print(f"  {'✅' if fi['status']=='EXISTS' else '⬜'} {fk}: {fi['status']}")
        print(f"  {'✅' if sp['codegraph']=='EXISTS' else '⬜'} codegraph: {sp['codegraph']}")
        print(f"  📦 模块 ({len(sp['modules'])})")
    if stale:
        print(f"\n♻️ {stale} 个文件需**补齐**（只加缺失的键，不覆盖已有值）。")
    print("请确认以上计划，确认后在 Claude Code 中执行 /harness-init 开始生成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
