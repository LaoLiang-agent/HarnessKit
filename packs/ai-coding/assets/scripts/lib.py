#!/usr/bin/env python3
# .harness/scripts/lib.py
# Harness 共享函数库（跨平台，仅标准库）。用法: import lib
import json, os, re, shlex, shutil, signal, subprocess, sys, time
from pathlib import Path

SERVICES_DIR = "services"
ROOT = Path(__file__).resolve().parent.parent.parent  # .harness/scripts/ → 仓库根


def _ensure_utf8_stdio():
    """重配 stdout/stderr 为 UTF-8 输出（errors=replace），防 Windows emoji 崩溃。

    Windows 控制台默认编码是本地代码页（cp936/cp1252），编不出 ✅❌⚠️ 等 emoji，
    脚本一 print 就抛 UnicodeEncodeError。所有脚本都在打印前 import lib，
    在此统一重配一次，即可让 emoji 输出在任何平台不崩溃（UTF-8 全平台可用，
    errors=replace 保证极端情况下降级为 ? 而非异常）。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            reconfigure = getattr(stream, "reconfigure", None)
            if reconfigure:
                reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


_ensure_utf8_stdio()


def repo_root() -> Path:
    return ROOT


def is_ci() -> bool:
    return any(os.environ.get(k) for k in ("CI", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL"))


def _resolve_exe(cmd):
    """把 argv[0] 解析为绝对路径。

    Windows 下 npm/codegraph 等是 .cmd/.bat 垫片，靠 PATHEXT 展开是 shell 的行为，
    CreateProcess 不认裸名 → 直接传裸名会 FileNotFoundError [WinError 2]。
    shutil.which 按 PATHEXT 解析，拿到 .cmd 全路径后 CreateProcess 才能执行。
    """
    exe = shutil.which(cmd[0]) if cmd else None
    return [exe, *cmd[1:]] if exe else cmd


def run(cmd, cwd=None, env=None, check=False):
    """执行外部命令，返回 CompletedProcess。cmd 为 list。

    统一按 UTF-8 解码（errors=replace），不依赖平台 locale：Windows 默认 GBK 时，
    git 输出中的中文（提交信息 / diff）会抛 UnicodeDecodeError 打断调用方。
    """
    return subprocess.run(_resolve_exe(cmd), cwd=str(cwd) if cwd else None,
                          env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", check=check)


def git(args, cwd=None, check=False):
    return run(["git", *args], cwd=cwd, check=check)


def read_json(path: Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


MODULE_DIR_EXCLUDES = ("node_modules", "target", "dist", "build", "docs", "src")


def is_maven_container(d: Path) -> bool:
    """Maven 模块扁平容器：有聚合 pom.xml、自身无 src、且存在带 src 的模块子目录。

    纯结构识别（容器目录名下钻），不依赖任何配置——真实工程只要把模块按
    <容器>/<模块>/src 扁平布局，即自动被发现，无需在 config.json 登记容器目录名。
    """
    if not (d / "pom.xml").is_file() or (d / "src").is_dir():
        return False
    return any(
        (c / "src").is_dir()
        for c in d.iterdir()
        if c.is_dir() and not c.name.startswith(".") and c.name not in MODULE_DIR_EXCLUDES
    )


def discover_services(root: Path = ROOT) -> list:
    svc = root / SERVICES_DIR
    if not svc.is_dir():
        return []
    out = []
    for d in sorted(svc.iterdir()):
        if not d.is_dir():
            continue
        n = d.name
        if n.startswith(".") or n in ("node_modules", "target", "dist", "build"):
            continue
        out.append(n)
    return out


def discover_service_dirs(root: Path = ROOT) -> list:
    svc = root / SERVICES_DIR
    if not svc.is_dir():
        return []
    out = []
    for d in sorted(svc.iterdir()):
        if not d.is_dir():
            continue
        n = d.name
        if n.startswith(".") or n in ("node_modules", "target", "dist", "build"):
            continue
        out.append((n, d))
    return out


def resolve_service_dir(arg):
    """子工程参数解析：既接受 `backend`，也接受 `services/backend` 或绝对路径。找不到 → None。

    只认全路径会让 `run-field backend start` 报「子工程不存在」——而框架自己打印的停止指引
    （`run-field <短名> stop`）、`/harness-init` Step 7 的环境诊断（`env-auto <子工程> --check`）
    用的都是短名，照抄必然失败。故这里统一收口，`run_field` 与 `env_auto` 共用同一套解析。

    顺序：原样（相对 cwd，兼容在子工程目录内直接执行）→ <root>/<arg> → <root>/services/<arg>。
    """
    if not arg:
        return None
    p = Path(arg)
    if p.is_absolute():
        return p if p.is_dir() else None
    for cand in (Path.cwd() / p, ROOT / p, ROOT / SERVICES_DIR / p):
        if cand.is_dir():
            return cand
    return None


def _gradle_files(p: Path) -> bool:
    return any((p / f).is_file() for f in ("settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"))


def _has_gradle_include(p: Path) -> bool:
    for f in ("settings.gradle", "settings.gradle.kts"):
        path = p / f
        if path.is_file() and re.search(r"(?m)^\s*include\b", path.read_text(encoding="utf-8", errors="ignore")):
            return True
    return False


def _node_package(p: Path) -> dict:
    try:
        data = json.loads((p / "package.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _node_dep_names(p: Path) -> set:
    pkg = _node_package(p)
    deps = pkg.get("dependencies") if isinstance(pkg.get("dependencies"), dict) else {}
    dev = pkg.get("devDependencies") if isinstance(pkg.get("devDependencies"), dict) else {}
    return set(deps) | set(dev)


def _has_node_backend(p: Path) -> bool:
    """只认生产依赖：express 常作为前端 mock/server 出现在 devDependencies。"""
    pkg = _node_package(p)
    deps = pkg.get("dependencies") if isinstance(pkg.get("dependencies"), dict) else {}
    return bool(set(deps) & {"@nestjs/core", "express", "fastify", "koa", "hono"})


def _apps_dep_names(p: Path) -> set:
    """根是 workspace 壳时，从 apps/<name>/package.json 汇总依赖。"""
    apps = p / "apps"
    if not apps.is_dir():
        return set()
    out = set()
    for d in sorted(apps.iterdir()):
        if d.is_dir() and not d.name.startswith(".") and (d / "package.json").is_file():
            out |= _node_dep_names(d)
    return out


def _has_dotnet_project(p: Path) -> bool:
    """根目录或浅层子目录（常见 src/<Project>）是否有 .sln/.csproj。"""
    if list(p.glob("*.sln")) or list(p.glob("*.csproj")):
        return True
    for base, dirs, files in os.walk(p):
        depth = len(Path(base).relative_to(p).parts)
        dirs[:] = [d for d in dirs if d not in ("bin", "obj", "node_modules", ".git", ".harness")
                   and depth < 3 and not d.startswith(".")]
        if any(f.endswith(".csproj") for f in files):
            return True
    return False


def detect_service_type(service_path) -> str:
    """检测服务类型，返回：
    vue-multimodule|mobile-app|uniapp|node-spa|node-ssr|node-backend|node-generic|
    maven-multimodule|maven|gradle-multimodule|gradle|dotnet|go|python|rust|unknown

    Vue 前端按**结构**细分：带 apps/ 子应用容器的是微前端工程（vue-multimodule），
    不带的是单应用 SPA（mobile-app，移动端 H5 / 桌面 SPA 同构）。
    uni-app 工程单列（uniapp）：它的多端编译、rpx 单位、pages.json 路由与 Web H5 差异大，
    合并进 mobile-app 会让生成的规范指错方向。
    判定只看依赖与布局，不看具体 UI 库（Vant/Element 等）——技术选型属工程层，不进框架。
    """
    p = Path(service_path)
    if (p / "pom.xml").is_file():
        pom = (p / "pom.xml").read_text(encoding="utf-8", errors="ignore")
        if "<modules>" in pom:
            return "maven-multimodule"
        return "maven"
    if _gradle_files(p):
        return "gradle-multimodule" if _has_gradle_include(p) else "gradle"
    if _has_dotnet_project(p):
        return "dotnet"
    # uni-app 必须先于 package.json 的 vue 分支判定：CLI 形态同样含 vue 依赖，
    # 先判 vue 会把 uni-app 工程当成普通 H5 SPA（HBuilderX 形态更无 package.json 可判）。
    if is_uniapp(p):
        return "uniapp"
    if (p / "package.json").is_file() or (p / "apps").is_dir():
        deps = _node_dep_names(p) | _apps_dep_names(p)
        if "vue" in deps:
            return "vue-multimodule" if (p / "apps").is_dir() else "mobile-app"
        if deps & {"next", "nuxt", "@remix-run/react"}:
            return "node-ssr"
        if deps & {"react", "react-dom", "@angular/core", "svelte", "solid-js"}:
            return "node-spa"
        if deps & {"@nestjs/core", "express", "fastify", "koa", "hono"}:
            return "node-backend"
        return "node-generic" if (p / "package.json").is_file() else "unknown"
    if (p / "go.mod").is_file() or (p / "go.work").is_file():
        return "go"
    if any((p / f).is_file() for f in ("pyproject.toml", "requirements.txt", "setup.py", "Pipfile")):
        return "python"
    if (p / "Cargo.toml").is_file():
        return "rust"
    return "unknown"


FRONTEND_SPA_DEPS = ("vue", "react", "@angular/core", "angular")


def _is_spa_package(pkg: Path) -> bool:
    """package.json 是否含 SPA 框架依赖（vue/react/angular）。"""
    try:
        d = json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
    except (json.JSONDecodeError, OSError):
        return False
    deps = json.dumps({**d.get("dependencies", {}), **d.get("devDependencies", {})})
    return any(f'"{k}"' in deps for k in FRONTEND_SPA_DEPS)


def _has_blazor_wasm(csproj: Path) -> bool:
    """.csproj 是否 Blazor WebAssembly（纯前端 .NET 项目）。"""
    try:
        return "BlazorWebAssembly" in csproj.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


FRONTEND_PROBE_EXCLUDES = MODULE_DIR_EXCLUDES + ("bin", "obj", "wwwroot")
MAX_FRONTEND_PROBE_DEPTH = 6


def _has_uniapp_dep(p: Path) -> bool:
    """package.json 是否含 uni-app 工具链依赖。

    只认 `@dcloudio/` 作用域——该 scope 全部是 DCloud/uni-app 工具链
    （uni-app / uni-h5 / uni-mp-weixin / vite-plugin-uni / vue-cli-plugin-uni…），
    不会误命中其它框架。不要求工程直接声明 `vue`：只装平台子包的形态可以没有它。
    """
    pkg = p / "package.json"
    if not pkg.is_file():
        return False
    try:
        d = json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
    except (json.JSONDecodeError, OSError):
        return False
    deps = {**d.get("dependencies", {}), **d.get("devDependencies", {})}
    return any(k.startswith("@dcloudio/") for k in deps)


def is_uniapp(p: Path) -> bool:
    """目录自身是否 uni-app 工程。两种工程形态都识别：

    - **HBuilderX 工程**：根 `manifest.json` + `pages.json`（无 `package.json`，靠 IDE 编译发行）
    - **CLI 工程**：`package.json` 依赖含 `@dcloudio/*`（vite / vue-cli 模板把 manifest/pages 放在 `src/` 下）

    故 manifest+pages 同时检查根与 `src/`，兼容两种模板布局；二者都认不出即不是 uni-app。
    """
    for base in (p, p / "src"):
        if (base / "manifest.json").is_file() and (base / "pages.json").is_file():
            return True
    return _has_uniapp_dep(p)


def _is_frontend_project(d: Path) -> bool:
    """目录自身是否即一个前端项目：uni-app 工程、SPA package.json 或 Blazor WebAssembly .csproj。"""
    if is_uniapp(d):
        return True
    if (d / "package.json").is_file() and _is_spa_package(d / "package.json"):
        return True
    return any(_has_blazor_wasm(c) for c in d.glob("*.csproj"))


def _frontend_kind(d: Path) -> str:
    """前端项目类型：'uniapp' / 'spa'（SPA package.json）/ 'blazor'（WebAssembly）。"""
    if is_uniapp(d):
        return "uniapp"
    if (d / "package.json").is_file() and _is_spa_package(d / "package.json"):
        return "spa"
    return "blazor"


def _collect_frontend_projects(d: Path, prefix: str, out: list, depth: int = 0):
    """递归收集前端项目：目录是前端项目 → 收录并停止下钻；否则下钻子目录（聚合容器，如 UI/<子前端>/）。

    - 明确的后端 .NET 项目（含 .csproj 但非 Blazor WASM）内部不再可能嵌套前端子项目，直接跳过。
    - 排除 node_modules/bin/obj/wwwroot 等，避免遍历依赖树/产物树。
    """
    if depth > MAX_FRONTEND_PROBE_DEPTH:
        return
    if _is_frontend_project(d):
        out.append({"name": prefix, "parent": str(d.parent), "path": str(d), "kind": _frontend_kind(d)})
        return
    if list(d.glob("*.csproj")):
        return  # 后端 .NET 项目，内部无前端子项目
    for c in sorted(d.iterdir()):
        if not c.is_dir() or c.name.startswith(".") or c.name in FRONTEND_PROBE_EXCLUDES:
            continue
        _collect_frontend_projects(c, f"{prefix}/{c.name}", out, depth + 1)


def _has_frontend_marker(p: Path) -> bool:
    """结构探测前端标记：根 package.json 含 SPA 依赖，或子目录树（支持聚合容器，如 UI/<子前端>/）含前端项目。"""
    if (p / "package.json").is_file() and _is_spa_package(p / "package.json"):
        return True
    return bool(list_frontend_projects(p))


def is_mobile_project(p: Path) -> bool:
    """目录自身是否移动端 / 单应用工程：uni-app 工程，或单应用 SPA（含 SPA 依赖的 package.json）。

    apps/ 是微前端（多 App 宿主）的布局标记——只要它存在就按微前端处理，不归 mobile；
    没有它即视为一个独立应用工程（移动端 H5、uni-app、桌面 SPA）。
    与 detect_service_type 的 vue / uni-app 分支判定同源。
    """
    if (p / "apps").is_dir():
        return False
    if is_uniapp(p):
        return True
    return (p / "package.json").is_file() and _is_spa_package(p / "package.json")


def detect_service_role(service_path) -> str:
    """检测服务角色：backend | frontend | mobile | fullstack | unknown。

    fullstack = 后端标记（pom/.sln/.csproj/go.mod/pyproject）与前端标记（SPA package.json / uni-app / Blazor WASM）并存，
    覆盖「前后端同仓库」场景（如 .NET 主仓内嵌 Blazor/SPA 前端）。
    frontend = 微前端多 App 工程（apps/ 布局）；mobile = 单应用形态（无 apps/ 布局：移动端 H5、uni-app、桌面 SPA）。
    角色是**文档形态**的分类（决定查哪些章节），故 uni-app 与单应用 SPA 同归 mobile；
    技术栈细分（uniapp / mobile-app / vue-multimodule）由 detect_service_type 承担。

    角色由**结构**推断，与子工程目录名无关——目录叫 backend/frontend/app 还是别的都不影响判定。
    """
    p = Path(service_path)
    has_backend = (p / "pom.xml").is_file() or _gradle_files(p) \
        or _has_dotnet_project(p) \
        or (p / "go.mod").is_file() or (p / "go.work").is_file() \
        or any((p / f).is_file() for f in ("pyproject.toml", "requirements.txt", "setup.py", "Pipfile")) \
        or (p / "Cargo.toml").is_file() or _has_node_backend(p)
    has_frontend = _has_frontend_marker(p)
    if has_backend and has_frontend:
        return "fullstack"
    if has_backend:
        return "backend"
    if is_mobile_project(p):
        return "mobile"
    if has_frontend:
        return "frontend"
    return "unknown"


def list_dotnet_projects(path: Path):
    """枚举 .NET 后端项目：一级子目录含 *.csproj（排除 bin/obj/docs 与 Blazor WASM 前端项目）。"""
    out = []
    for d in sorted(path.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in ("bin", "obj", "docs"):
            continue
        csprojs = [c for c in d.glob("*.csproj")]
        if not csprojs:
            continue
        if any(_has_blazor_wasm(c) for c in csprojs):
            continue  # 前端（Blazor WebAssembly）项目，归 list_frontend_projects
        out.append({"name": d.name, "parent": str(path), "path": str(d)})
    return out


def list_frontend_projects(path: Path):
    """枚举 fullstack 服务内的前端子项目：一级子目录或嵌套聚合容器（如 UI/<子前端>/）下的 SPA / Blazor WASM 项目。

    name 为相对服务根的路径段（如 UI/login、ClientApp），path 为完整路径，供下游拼文档路径与标识。
    """
    out = []
    for d in sorted(path.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in FRONTEND_PROBE_EXCLUDES:
            continue
        _collect_frontend_projects(d, d.name, out)
    return out


# ─── 统一项目枚举 / 探测（初始化计划与完整性校验共用）────────────
# 为什么放在 lib：harness_init.py 生成计划、codebase_guide_init.py 校验文档，
# 过去各写一套分类，导致「计划里被跳过、校验时又报缺」的自相矛盾。
INSTRUCTION_NAMES = ("AGENTS.md", "CLAUDE.md")
TEMPLATES_DIR = ROOT / ".harness" / "templates"
TIERS = ("minimal", "standard", "full")
GENERIC_SECTIONS = ("Build", "项目概述", "目录结构", "关键约定", "参考文档")
BACKEND_SECTIONS = ("Build", "项目概述", "关键框架模式", "关键约定", "模块发现", "参考文档")
FRONTEND_SECTIONS = ("Build", "项目概述", "目录结构", "关键框架模式", "关键约定", "参考文档")
FULLSTACK_SECTIONS = ("Build", "项目概述", "目录结构", "关键框架模式", "关键约定", "模块发现", "参考文档")

# 专用模板只在目录真实存在时生效；未来新增模板无需改探测主流程。
PREFERRED_TEMPLATE = {
    "maven-multimodule": "java/maven-multimodule",
    "maven": "java/maven",
    "gradle-multimodule": "java/gradle",
    "gradle": "java/gradle",
    "vue-multimodule": "javascript/vue-multimodule",
    "mobile-app": "javascript/mobile-app",
    "uniapp": "javascript/uniapp",
    "dotnet": "dotnet/dotnet-multimodule",
    "node-spa": "javascript/node-app",
    "node-ssr": "javascript/node-app",
    "node-backend": "javascript/node-app",
    "node-generic": "javascript/node-app",
    "go": "go/service",
    "python": "python/service",
    "rust": "rust/service",
}
GENERIC_TEMPLATE = "generic"


def instruction_file(path):
    """已有入口文件：AGENTS.md 优先，兼容旧 CLAUDE.md。"""
    base = Path(path)
    for name in INSTRUCTION_NAMES:
        candidate = base / name
        if candidate.is_file():
            return candidate
    return None


def _template_instruction(tdir: str, stem: str) -> str:
    for name in (f"{stem}-AGENTS.tmpl", f"{stem}-CLAUDE.tmpl"):
        if (TEMPLATES_DIR / tdir / name).is_file():
            return f"{tdir}/{name}"
    return f"{tdir}/{stem}-AGENTS.tmpl"


def resolve_template(template_override: str, service_type: str) -> tuple:
    """返回 (template_dir, kind, warnings)。kind ∈ dedicated|generic|override。

    override 只接受 .harness/templates 下的相对目录；目录不存在或越界都回落 generic，
    绝不让计划指向一个不存在的模板。
    """
    warnings = []
    override = (template_override or "").strip().replace("\\", "/")
    if override:
        candidate = (TEMPLATES_DIR / override).resolve()
        try:
            inside = candidate.is_relative_to(TEMPLATES_DIR.resolve())
        except AttributeError:  # Python < 3.9
            inside = str(candidate).startswith(str(TEMPLATES_DIR.resolve()) + os.sep)
        if inside and candidate.is_dir() and any((candidate / f).is_file() for f in ("root-AGENTS.tmpl", "root-CLAUDE.tmpl")):
            return override, "override", warnings
        warnings.append(f"模板覆盖 {override!r} 不存在或非法，已回落 generic")
    preferred = PREFERRED_TEMPLATE.get(service_type, "")
    preferred_dir = TEMPLATES_DIR / preferred if preferred else None
    if preferred_dir and preferred_dir.is_dir() and any((preferred_dir / f).is_file() for f in ("root-AGENTS.tmpl", "root-CLAUDE.tmpl")):
        return preferred, "dedicated", warnings
    return GENERIC_TEMPLATE, "generic", warnings


def doc_sections(service_type: str, role: str, template_kind: str) -> tuple:
    """根文档必需章节。generic/override 先按通用章节表，不能拿专用模板标准要求它。"""
    if template_kind in ("generic", "override"):
        return GENERIC_SECTIONS
    if role == "backend":
        return BACKEND_SECTIONS
    if role in ("frontend", "mobile"):
        return FRONTEND_SECTIONS
    if role == "fullstack":
        return FULLSTACK_SECTIONS
    return GENERIC_SECTIONS


def _within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def enumerate_projects(root: Path = ROOT) -> tuple:
    """枚举子工程：kit.sources 优先，services/* 补扫，realpath 去重。

    返回 (projects, warnings)。projects: [{name, path, path_abs, source, source_kind}]。
    不在 services 下递归找 git 仓库——嵌套仓库必须显式登记，避免把模块误当子工程。
    """
    root = Path(root)
    projects, warnings, seen = [], [], set()

    def add(name, rel, abs_path, source, source_kind):
        key = os.path.normcase(os.path.realpath(abs_path))
        if key in seen:
            return
        seen.add(key)
        projects.append({
            "name": name,
            "path": rel,
            "path_abs": str(abs_path),
            "source": source,
            "source_kind": source_kind,
        })

    kit = read_json(root / ".harness" / "kit.json")
    for raw in kit.get("sources") or []:
        if not isinstance(raw, dict):
            continue
        rel = str(raw.get("path") or "").strip().replace("\\", "/")
        if not rel:
            warnings.append({"code": "source_path_missing", "path": rel, "message": "sources 项缺少 path，已跳过"})
            continue
        candidate = (root / rel).resolve()
        if not _within(candidate, root.resolve()):
            warnings.append({"code": "source_path_escape", "path": rel, "message": "sources.path 越出工作区，已跳过"})
            continue
        if not candidate.is_dir():
            warnings.append({"code": "missing_source", "path": rel,
                             "message": f"kit.sources 登记但目录不存在：{rel}"})
            continue
        add(raw.get("name") or candidate.name, rel.rstrip("/"), candidate, raw, "kit")

    svc = root / SERVICES_DIR
    if svc.is_dir():
        for d in sorted(svc.iterdir()):
            if not d.is_dir() or d.name.startswith(".") or d.name in ("node_modules", "target", "dist", "build"):
                continue
            rel = f"{SERVICES_DIR}/{d.name}"
            add(d.name, rel, d, {}, "scan")

    return projects, warnings


def _rel_posix(path, base) -> str:
    return Path(path).resolve().relative_to(Path(base).resolve()).as_posix()


def _module_record(path: Path, base: Path, name: str, kind: str, template: str, meta_keys: tuple) -> dict:
    existing = instruction_file(path)
    return {
        "name": name or path.name,
        "path": _rel_posix(path, base),
        "kind": kind,
        "template": template,
        "status": "EXISTS" if existing is not None else "MISSING",
        "meta_keys": list(meta_keys),
    }


def list_maven_modules(path: Path):
    """枚举 Maven 模块：顶层 pom+src 目录 + 扁平容器（聚合 pom、自身无 src）下的模块子目录。"""
    out, seen, containers = [], set(), []
    for d in sorted(path.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        if (d / "pom.xml").is_file() and (d / "src").is_dir():
            if d.name not in MODULE_DIR_EXCLUDES:
                out.append({"name": d.name, "parent": str(path), "path": str(d)})
                seen.add(d.name)
        elif is_maven_container(d):
            containers.append(d)
    for child in containers:
        for d in sorted(child.iterdir()):
            if not (d.is_dir() and (d / "src").is_dir()):
                continue
            if d.name.startswith(".") or d.name in MODULE_DIR_EXCLUDES or d.name in seen:
                continue
            out.append({"name": d.name, "parent": str(child), "path": str(d)})
    return out


def _maven_modules(path: Path, tdir: str) -> list:
    out, seen = [], set()

    def add(rel_dir: Path):
        rel = _rel_posix(rel_dir, path)
        if rel in seen:
            return
        seen.add(rel)
        out.append(_module_record(rel_dir, path, Path(rel).name, "backend",
                                  _template_instruction(tdir, "module"), ("路径", "domain")))

    pom = path / "pom.xml"
    if pom.is_file():
        text = pom.read_text(encoding="utf-8", errors="ignore")
        for rel in re.findall(r"<module>\s*([^<]+?)\s*</module>", text):
            candidate = (path / rel.strip()).resolve()
            if candidate.is_dir() and _within(candidate, path.resolve()):
                add(candidate)
    if not out:
        for m in list_maven_modules(path):
            add(Path(m["path"]))
    return out


def _dotnet_modules(path: Path, tdir: str) -> list:
    """递归收集 .NET 项目（支持 src/<Project> 布局），排除测试项目与产物目录。"""
    out, seen = [], set()
    for base, dirs, files in os.walk(path):
        base_p = Path(base)
        depth = len(base_p.relative_to(path).parts)
        dirs[:] = [d for d in dirs if d not in ("bin", "obj", "node_modules", ".git", ".harness")
                   and depth < 4 and not d.startswith(".")]
        for f in files:
            if not f.endswith(".csproj"):
                continue
            stem = Path(f).stem
            if stem.endswith((".Tests", ".Test", ".Spec")):
                continue
            csproj = base_p / f
            if base_p == path:
                continue  # 根项目由 L1 AGENTS.md 覆盖，不重复生成模块文档
            rel = _rel_posix(base_p, path)
            if rel in seen:
                continue
            seen.add(rel)
            front = _has_blazor_wasm(csproj)
            stem_tpl = "app" if front else "module"
            out.append(_module_record(base_p, path, stem, "frontend" if front else "backend",
                                      _template_instruction(tdir, stem_tpl),
                                      ("职责", "domain") if front else ("domain",)))
    return out


def _vue_modules(path: Path, tdir: str) -> list:
    apps = path / "apps"
    if not apps.is_dir():
        return []
    out = []
    for d in sorted(apps.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in ("node_modules", "target", "dist", "build"):
            continue
        if not (list(d.glob("*.vue")) or (d / "store").is_dir() or (d / "views").is_dir() or (d / "router").is_dir()):
            continue
        out.append(_module_record(d, path, d.name, "frontend", _template_instruction(tdir, "app"), ("职责", "domain")))
    comp = apps / "component"
    if comp.is_dir() and not any(m["path"] == "apps/component" for m in out):
        out.append(_module_record(comp, path, "component", "frontend", _template_instruction(tdir, "app"), ()))
    return out


def _gradle_modules(path: Path, tdir: str) -> list:
    out, seen = [], set()
    for f in ("settings.gradle", "settings.gradle.kts"):
        settings = path / f
        if not settings.is_file():
            continue
        text = settings.read_text(encoding="utf-8", errors="ignore")
        for raw in re.findall(r"['\"]:?([A-Za-z0-9_./:-]+)['\"]", text):
            rel = raw.replace(":", "/").strip("/")
            if not rel or rel in seen:
                continue
            candidate = (path / rel).resolve()
            if not candidate.is_dir() or not _within(candidate, path.resolve()):
                continue
            seen.add(rel)
            out.append(_module_record(candidate, path, Path(rel).name, "backend",
                                      _template_instruction(tdir, "module"), ("路径", "domain")))
    return out


def detect_modules(path: Path, service_type: str, tdir: str) -> list:
    if service_type in ("maven", "maven-multimodule"):
        return _maven_modules(path, tdir)
    if service_type == "gradle-multimodule":
        return _gradle_modules(path, tdir)
    if service_type == "dotnet":
        return _dotnet_modules(path, tdir)
    if service_type == "vue-multimodule":
        return _vue_modules(path, tdir)
    return []


def _node_pm(p: Path) -> str:
    pkg = _node_package(p)
    declared = str(pkg.get("packageManager") or "").split("@", 1)[0].strip().lower()
    if declared in ("npm", "pnpm", "yarn", "bun"):
        return declared
    for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"),
                     ("bun.lockb", "bun"), ("bun.lock", "bun"), ("package-lock.json", "npm")):
        if (p / lock).is_file():
            return pm
    return "npm"


def _node_script(p: Path, name: str) -> str:
    scripts = _node_package(p).get("scripts") or {}
    value = scripts.get(name) if isinstance(scripts, dict) else ""
    return str(value or "")


def _suggest(value, source, confidence="high"):
    return {"value": value, "source": source, "confidence": confidence} if value else None


def infer_build(project: dict) -> dict:
    """按工程事实推导构建命令。只给建议，不写盘、不执行。"""
    p = Path(project["path_abs"])
    st = project.get("service_type")
    out = {}

    def put(key, item):
        if item:
            out[key] = item

    if st in ("maven", "maven-multimodule"):
        mvn = "./mvnw" if (p / "mvnw").is_file() else "mvn"
        put("compile", _suggest(f"{mvn} compile", f"{mvn} wrapper" if mvn == "./mvnw" else "pom.xml"))
        put("test", _suggest(f"{mvn} test", "pom.xml"))
    elif st in ("gradle", "gradle-multimodule"):
        gradle = "./gradlew" if (p / "gradlew").is_file() else "gradle"
        put("compile", _suggest(f"{gradle} build -x test", f"{gradle} wrapper" if gradle == "./gradlew" else "gradle"))
        put("test", _suggest(f"{gradle} test", "gradle"))
    elif st == "dotnet":
        put("compile", _suggest("dotnet build", ".sln/.csproj"))
        put("test", _suggest("dotnet test", ".sln/.csproj"))
        runnable = []
        for base, dirs, files in os.walk(p):
            dirs[:] = [d for d in dirs if d not in ("bin", "obj", "node_modules", ".git", ".harness")]
            for f in files:
                if not f.endswith(".csproj"):
                    continue
                csproj = Path(base) / f
                text = csproj.read_text(encoding="utf-8", errors="ignore")
                if "Microsoft.NET.Sdk.Web" in text or "OutputType>Exe" in text:
                    runnable.append(csproj)
        if len(runnable) == 1:
            rel = _rel_posix(runnable[0].parent, p)
            put("start", _suggest(f'dotnet run --project "{rel}"', str(runnable[0].relative_to(p)), "medium"))
    elif st and st.startswith("node") or st in ("mobile-app", "uniapp"):
        pm = _node_pm(p)
        lock = {"npm": "package-lock.json", "pnpm": "pnpm-lock.yaml",
                "yarn": "yarn.lock", "bun": "bun.lockb"}.get(pm, "")
        install = {
            "npm": "npm ci" if (p / "package-lock.json").is_file() else "npm install",
            "pnpm": "pnpm install --frozen-lockfile",
            "yarn": "yarn install --frozen-lockfile",
            "bun": "bun install --frozen-lockfile",
        }.get(pm, f"{pm} install")
        put("install", _suggest(install, f"{pm} lock" if lock else "package.json"))
        build = _node_script(p, "build")
        if build:
            put("compile", _suggest(f"{pm} run build", "package.json#scripts.build"))
        elif (p / "tsconfig.json").is_file():
            put("compile", _suggest(f"{pm} exec tsc --noEmit", "tsconfig.json", "medium"))
        if _node_script(p, "test"):
            put("test", _suggest(f"{pm} test", "package.json#scripts.test"))
        if _node_script(p, "lint"):
            put("lint", _suggest(f"{pm} run lint", "package.json#scripts.lint"))
        for name in ("dev", "start", "serve"):
            if _node_script(p, name):
                put("start", _suggest(f"{pm} run {name}", f"package.json#scripts.{name}", "medium"))
                break
    elif st == "go":
        put("compile", _suggest("go build ./...", "go.mod"))
        put("test", _suggest("go test ./...", "go.mod"))
        put("lint", _suggest("go vet ./...", "go.mod", "medium"))
        cmds = sorted((p / "cmd").glob("*/main.go")) if (p / "cmd").is_dir() else []
        if len(cmds) == 1:
            put("start", _suggest(f"go run ./cmd/{cmds[0].parent.name}", "cmd/*/main.go", "medium"))
    elif st == "python":
        venv_py = p / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        py = f'"{venv_py}"' if venv_py.is_file() else "python"
        if (p / "poetry.lock").is_file():
            put("install", _suggest("poetry install", "poetry.lock"))
        elif (p / "uv.lock").is_file():
            put("install", _suggest("uv sync", "uv.lock"))
        elif (p / "Pipfile").is_file():
            put("install", _suggest("pipenv install", "Pipfile"))
        elif (p / "requirements.txt").is_file():
            put("install", _suggest("pip install -r requirements.txt", "requirements.txt"))
        put("compile", _suggest(
            f"{py} -m compileall -q . -x '(^|/)(\\.venv|venv|node_modules|build|dist)/'",
            "pyproject.toml", "medium"))
        if (p / "pytest.ini").is_file() or (p / "tests").is_dir() or (p / "pyproject.toml").is_file():
            put("test", _suggest("pytest", "pytest config/tests", "medium"))
        if (p / "manage.py").is_file():
            put("start", _suggest(f"{py} manage.py runserver", "manage.py", "medium"))
    elif st == "rust":
        put("compile", _suggest("cargo build", "Cargo.toml"))
        put("test", _suggest("cargo test", "Cargo.toml"))
        put("lint", _suggest("cargo clippy", "Cargo.toml", "medium"))
        if (p / "src" / "main.rs").is_file():
            put("start", _suggest("cargo run", "src/main.rs", "medium"))
    return out


def _detect_framework(p: Path, st: str) -> str:
    if st in ("vue-multimodule", "mobile-app"):
        return "vue"
    if st == "uniapp":
        return "uni-app"
    if st == "node-ssr":
        deps = _node_dep_names(p)
        return "next" if "next" in deps else "nuxt" if "nuxt" in deps else "remix"
    if st == "node-spa":
        deps = _node_dep_names(p)
        for name in ("react", "@angular/core", "svelte", "solid-js"):
            if name in deps:
                return name
    if st == "node-backend":
        deps = _node_dep_names(p)
        for name in ("@nestjs/core", "express", "fastify", "koa", "hono"):
            if name in deps:
                return name
    if st == "dotnet":
        return "dotnet"
    if st in ("maven", "maven-multimodule"):
        return "spring-boot" if "<artifactId>spring-boot" in (p / "pom.xml").read_text(encoding="utf-8", errors="ignore") else "java"
    if st in ("gradle", "gradle-multimodule"):
        return "gradle"
    if st == "go":
        return "go"
    if st == "python":
        text = ""
        for f in ("pyproject.toml", "requirements.txt"):
            if (p / f).is_file():
                text = (p / f).read_text(encoding="utf-8", errors="ignore").lower()
                break
        for name in ("fastapi", "django", "flask"):
            if name in text:
                return name
        return "python"
    if st == "rust":
        return "rust"
    return ""


def detect_project(service_path, name: str = "", source=None) -> dict:
    """探测一个子工程。计划与校验的唯一入口。"""
    p = Path(service_path)
    source = source or {}
    warnings = []
    stype = str(source.get("type") or detect_service_type(p))
    # 自动扫描时 runInit 写入的 role 只是按目录名猜的，不能覆盖结构探测；
    # 只有 addSource 显式传入（roleSource=explicit）才作为覆盖。
    role = str(source.get("role") or "") if source.get("roleSource") == "explicit" else ""
    role = role or detect_service_role(p)
    tdir, tkind, twarn = resolve_template(str(source.get("template") or ""), stype)
    warnings.extend(twarn)
    tier = str(source.get("tier") or ("minimal" if tkind == "generic" else "standard"))
    if tier not in TIERS:
        warnings.append(f"非法 tier {tier!r}，已回落 standard")
        tier = "standard"
    language = {
        "maven": "java", "maven-multimodule": "java",
        "gradle": "kotlin" if list(p.glob("*.kts")) else "java",
        "gradle-multimodule": "kotlin" if list(p.glob("*.kts")) else "java",
        "dotnet": "csharp", "go": "go", "python": "python", "rust": "rust",
    }.get(stype)
    if not language:
        if stype in ("vue-multimodule", "mobile-app", "uniapp", "node-spa", "node-ssr",
                     "node-backend", "node-generic"):
            language = "typescript" if (p / "tsconfig.json").is_file() else "javascript"
        else:
            language = "unknown"
    build_tool = {
        "maven": "maven", "maven-multimodule": "maven",
        "gradle": "gradle", "gradle-multimodule": "gradle",
        "dotnet": "dotnet", "go": "go", "python": "pip", "rust": "cargo",
    }.get(stype, "")
    if stype.startswith("node") or stype in ("mobile-app", "uniapp"):
        build_tool = _node_pm(p)
    if stype == "python":
        build_tool = "poetry" if (p / "poetry.lock").is_file() else \
            "uv" if (p / "uv.lock").is_file() else \
            "pipenv" if (p / "Pipfile").is_file() else "pip"
    descriptor = {
        "name": name or p.name,
        "path": _rel_posix(p, ROOT),
        "path_abs": str(p.resolve()),
        "source": source.get("name") or "scan",
        "service_type": stype,
        "language": language,
        "build_tool": build_tool,
        "framework": _detect_framework(p, stype),
        "role": role,
        "template_dir": tdir,
        "template_kind": tkind,
        "supported": tkind == "dedicated",
        "needs_manual": tkind != "dedicated",
        "tier": tier,
        "modules": detect_modules(p, stype, tdir),
        "codegraph": "EXISTS" if (p / ".codegraph").is_dir() else "MISSING",
        "warnings": warnings,
    }
    descriptor["build_suggestion"] = infer_build(descriptor)
    return descriptor


def get_build_field(service_path, field: str) -> str:
    """从子工程 .harness/build.json 读字段，无则返回 ''"""
    cfg = Path(service_path) / ".harness" / "build.json"
    if not cfg.is_file():
        return ""
    return str(read_json(cfg).get(field, "") or "")


# ─── 构建/启动的唯一执行入口 ──────────────────────────────────────
# 背景：各子工程对运行时版本的要求不同（有的锁 JDK 8、有的要 Node 18…），
# 而用户机器上往往装了多个版本，默认 PATH 上的那个大概率不是对的。
# 解析逻辑在 env_auto.py；**执行入口只有这里一个** —— 脚本/hook/Skill 都调它，
# 才能保证「不同用户、不同工程、不同电脑」跑的是同一套环境判定。


class BuildEnvError(Exception):
    """子工程声明的运行时在本机找不到。**不可静默降级**为默认运行时。"""

    def __init__(self, msg, missing):
        super().__init__(msg)
        self.missing = list(missing or [])


def build_env(service_path, strict=True):
    """解析该子工程的构建/启动环境，返回 (env_dict, resolution)。

    env_dict 是 os.environ 的副本，已注入 JAVA_HOME / PATH 等。
    strict=True：声明的运行时缺失 → 抛 BuildEnvError（宁可停下报安装指引，
    也不要用错版本跑出「莫名其妙」的失败——那会浪费一整轮排查）。
    未识别工程类型的子工程永远只是放行（框架不认识新端，不该拦人）。
    """
    import env_auto  # 延迟导入：env_auto 顶部 `import lib`，模块级导入会成环
    res = env_auto.resolve_env_cached(service_path)
    env = res.apply_to(os.environ)
    if res.identified and res.missing and strict:
        sp = Path(service_path)
        raise BuildEnvError(f"{sp.name}: 声明的运行时未就绪（{'、'.join(res.detected)}）", res.missing)
    return env, res


def run_build_field(service_path, field, command=None, capture=True, timeout=None, strict_env=True):
    """执行子工程 `.harness/build.json` 的某个字段，带**解析好的运行时环境**。

    返回 CompletedProcess；字段未声明/为空 → 返回 None（调用方自行决定降级）。
    环境缺失 → 不执行命令，直接返回 returncode=1 的 CompletedProcess 并打印安装指引。
    capture=False 用于长驻命令（start），输出直接透传到当前终端。
    command 供调用方传入自行推断的命令（子工程无 build.json 时的类型兜底），仍走同一套环境解析。
    """
    cmd = command if command is not None else get_build_field(service_path, field)
    if not cmd or not cmd.strip():
        return None
    sp = Path(service_path)
    # 同 run()：Windows 下 mvn/npm 等是 .cmd/.bat 垫片，CreateProcess 不认裸名
    # （PATHEXT 展开是 shell 行为）⇒ 必须先经 _resolve_exe 解析为 .cmd 全路径。
    # 否则抛 FileNotFoundError [WinError 2]，被 build_baseline.py 的
    # `except FileNotFoundError: ok = False` 吞成「基线构建失败」，真因不可见。
    argv = _resolve_exe(shlex.split(cmd))
    try:
        env, res = build_env(sp, strict=strict_env)
    except BuildEnvError as e:
        c_fail(str(e))
        for m in e.missing:
            print(f"     → {m}")
        return subprocess.CompletedProcess(argv, 1, "", str(e))
    if not res.cached:
        # 仅在「刚探测过」（首次 / 环境变了）时播报，避免每次编译都刷屏
        for ok, text in res.notes:
            (c_pass if ok else c_fail)(text)
        if res.identified:
            print(f"  ℹ️  {sp.name}: 已按 {'、'.join(res.detected)} 解析运行时（缓存 -> .harness/.env-cache）")
    kw = dict(cwd=str(sp), env=env, text=True)
    if capture:
        kw["capture_output"] = True
    if timeout:
        kw["timeout"] = timeout
    return subprocess.run(argv, **kw)


def spawn_build_field(service_path, field, log_path=None, strict_env=True):
    """起一个**长驻**命令（build.json 的 start 类字段），带解析好的运行时环境。

    与 run_build_field 的区别：那个「跑完就退」，这个「起了不等人」。
    子进程放**独立会话/进程组**：父进程退出不带它走，停止时也能按组精确清理（stop_process）。

    返回 (Popen, resolution)；字段未声明 → (None, None)；环境缺失 → 抛 BuildEnvError。
    log_path 给了则 stdout/stderr 全部落该文件（父进程退出不关管道 —— 这是关键，
    否则父进程一退，子进程写 stdout 就吃 SIGPIPE）；不给则继承当前终端。
    """
    cmd = get_build_field(service_path, field)
    if not cmd or not cmd.strip():
        return None, None
    sp = Path(service_path)
    env, res = build_env(sp, strict=strict_env)
    if not res.cached:
        for ok, text in res.notes:
            (c_pass if ok else c_fail)(text)
    fh = None
    if log_path:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
        fh = open(log_path, "w", encoding="utf-8", errors="replace")
        out, err = fh, subprocess.STDOUT
    else:
        out = err = None
    kw = dict(cwd=str(sp), env=env, text=True, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    # 同 run_build_field：Windows 下 start 命令多为 .cmd/.bat 垫片
    # （如 mvn / npm run），CreateProcess 不认裸名，须先经 _resolve_exe 解析。
    p = subprocess.Popen(_resolve_exe(shlex.split(cmd)), **kw)
    if fh:
        fh.close()  # 子进程已持有自己的 fd，父进程不必再拿着
    return p, res


def process_alive(pid) -> bool:
    """进程是否**真的还活着**（跨平台）。

    注意不能用 `os.kill(pid, 0)` 判活：已终止但尚未被父进程回收的**僵尸**进程
    对它同样不抛异常。这会让「自己起、自己停」的场景（stop 的调用方就是 spawn 的父进程）
    永远等不到退出，白等满超时后误报「停止失败」——而进程其实早没了。
    """
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                           capture_output=True, text=True)
        return str(pid) in (r.stdout or "")
    r = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                       capture_output=True, text=True)
    state = (r.stdout or "").strip()
    if not state:
        return False                    # 已消失（或已被回收）
    return not state.upper().startswith("Z")   # Z = 僵尸：已终止，只剩待回收的条目


def stop_process(pid, timeout=10) -> bool:
    """停止进程**及其子进程**，返回是否已停止。

    跨平台：POSIX 杀整个进程组（spawn_build_field 用 start_new_session 建的，pgid == pid），
    Windows 用 `taskkill /T`（连带子进程树，否则 maven/node 包装进程会残留）。
    先 SIGTERM 给优雅退出机会，超时才 SIGKILL。

    ⚠️ **只应在人工确认后调用** —— 框架不自动停止长驻服务。
    """
    if os.name == "nt":
        r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True)
        return r.returncode == 0
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            os.waitpid(pid, os.WNOHANG)   # 若我们是父进程，顺手回收，别留僵尸
        except (ChildProcessError, OSError):
            pass
        if not process_alive(pid):
            return True
        time.sleep(0.2)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    time.sleep(0.5)
    return not process_alive(pid)


# ─── 子模块脏检放行（fix/feat 分支流程用）─────────────────────────
# 背景：某些子工程长期带着**非本任务**的既存改动（历轮一致登记为「提交时排除」，如本地配置类
# 文件）。脏检「porcelain 非空即拒绝」会让每次 fix/apply 的分支处理都被拦，人只能
# stash → 跑 → pop 绕行（实测连续多个任务被迫如此）。
# 放行必须是**显式列举**的：只有清单内的路径被忽略，其余任何改动照旧拦截（真·脏工作区不放宽）。

def dirty_entries(sp: Path, tracked_only: bool = False) -> list:
    """`git status --porcelain` → [(XY, 子模块相对路径)]（重命名取新路径）。

    tracked_only=True 时不列未跟踪文件（= `diff-files` ∪ `diff-index` 的等价视图）。
    调用方要按各自**原有的**拦截范围选择：旧行为只看跟踪文件的，不要顺手扩大。
    """
    # `-c core.quotepath=false` 不可省：git 默认（quotepath=true）把非 ASCII 路径输出成八进制转义
    # （`"jmeter/jmeter\347\273\223\346\236\234.txt"`），而 `normalize_allow_entry` 拿到的
    # `--allow-dirty` 值是 UTF-8 原文 ⇒ 两者永不相等 ⇒ **`--allow-dirty` 对含中文的路径静默失效**。
    # 英文路径照常放行，所以这个坑只在中文文件名上暴露，极难自查（实测：jmeter 目录 4 条全未豁免）。
    args = ["-c", "core.quotepath=false", "status", "--porcelain"] + (
        ["--untracked-files=no"] if tracked_only else [])
    out = []
    for line in (git(args, cwd=sp).stdout or "").splitlines():
        if len(line) < 4:
            continue
        p = line[3:]
        if " -> " in p:
            p = p.split(" -> ", 1)[1]
        out.append((line[:2], p.strip().strip('"')))
    return out


def normalize_allow_entry(raw: str, sp: Path) -> str:
    """放行条目归一化为**子模块相对路径**。

    接受三种写法（前两种最常用）：`apps/apps.json`（子模块相对）、
    `services/<本子工程>/apps/apps.json`（仓库相对）、绝对路径。
    条目指向别的子工程时返回 ''（该子模块不豁免它）。
    """
    if not raw:
        return ""
    p = Path(str(raw).strip().replace("\\", "/"))
    if p.is_absolute():
        try:
            return p.relative_to(sp).as_posix()
        except ValueError:
            return ""
    s = p.as_posix().lstrip("./")
    prefix = f"{SERVICES_DIR}/{sp.name}/"
    if s.startswith(prefix):
        return s[len(prefix):]
    if s.startswith(f"{SERVICES_DIR}/"):
        return ""           # 指向别的子工程，本子模块不认
    return s


def allowed_dirty(sp: Path, extra=()) -> set:
    """放行清单（子模块相对路径集合）；`extra` = CLI `--allow-dirty` 的各个值。

    默认（不传 extra）为**空集** ⇒ 行为与改动前完全一致（不回归）。
    """
    out = set()
    for raw in extra or ():
        n = normalize_allow_entry(raw, sp)
        if n:
            out.add(n)
    return out


def blocking_dirty(sp: Path, allowed=None, tracked_only: bool = False) -> list:
    """未放行的脏条目（「XY 路径」形式）；空 = 可继续。

    比较时**两侧都去掉尾部斜杠**：`git status --porcelain` 给未跟踪**目录**的路径
    带尾斜杠（`jmeter/`），而 `normalize_allow_entry` 走 `Path(...).as_posix()`
    会把尾斜杠吃掉（`jmeter`）⇒ 原样比较永不相等，`--allow-dirty` 对目录条目静默失效。
    """
    allowed = allowed or set()
    allowed_norm = {a.rstrip("/") for a in allowed}

    def _allowed(path: str) -> bool:
        p = path.rstrip("/")
        if p in allowed_norm:
            return True
        # 目录级豁免：显式列了某个目录 ⇒ 覆盖其**全部后代**。
        # 依据（2026-09-28 实测）：历轮遗留的未跟踪产物常是一整目录（如 `jmeter/` 下 15 个
        # `.bak-*`/结果文件），逐个列举既冗长又易漏；列举目录本身仍是「显式列举」，
        # 不放宽对**未列举**路径的拦截。
        return any(p.startswith(a + "/") for a in allowed_norm)

    return [f"{xy} {p}" for xy, p in dirty_entries(sp, tracked_only=tracked_only)
            if not _allowed(p)]


def _kit_source_branch(service_path) -> str:
    """kit.json sources 里该子工程登记的基线分支（2026-11-18：mainlineBranch 字段已废弃，
    主线 = 每仓 sources[].branch，与开发分支基点/合入目标同源）。"""
    try:
        sources = read_json(ROOT / ".harness" / "kit.json").get("sources") or []
    except Exception:
        return ""
    sp = Path(service_path)
    try:
        rel = sp.resolve().relative_to(ROOT.resolve()).as_posix()
    except Exception:
        rel = sp.as_posix().lstrip("./")
    for s in sources:
        if not isinstance(s, dict):
            continue
        if not s.get("branch"):
            continue
        if s.get("path") == rel or Path(s.get("path", "")).name == Path(rel).name:
            return str(s["branch"]).strip()
    return ""


def get_mainline_branch(service_path) -> str:
    """子工程主线分支（集成/同步目标分支）。
    优先级：子工程 .harness/build.json 的 mainline-branch > kit.json sources[该仓].branch
    > 旧 .harness/config.json 的 mainline-branch（兼容旧工作区）> 默认 dev。
    """
    b = get_build_field(service_path, "mainline-branch")
    if b:
        return b
    b = _kit_source_branch(service_path)
    if b:
        return b
    b = read_json(ROOT / ".harness" / "config.json").get("mainline-branch")
    if b:
        return b
    return "dev"


def is_pristine_on_mainline(sp, mainline: str) -> bool:
    """子模块是否「停在主线、工作区干净、且与 origin/<主线> 完全同步」。

    这是「本轮未参与」的判据：一个本轮不改的子工程，本来就该停在主线最新处——把这种状态报成
    「禁止在集成分支上开发」是**误报**，会逼着 PM 给不参与的子工程也建分支（噪音分支随之而来）。
    只认 `origin/<主线>`：本地 `refs/heads/<主线>` 在「正停在主线上」时恒等于 HEAD，认它等于恒真。
    无远端 / 未 fetch（解析不到该 ref）→ 返回 False，失败方向仍落在「forbidden」（只放宽、不收紧）。

    **不自己 fetch**：本函数在 pre_edit 这类 hook 路径上被频繁调用，每次联网不可接受。调用方
    （check_branch / verify）都在 `sync` 之后跑，origin 引用是新的；引用陈旧时只会把「落后但未知」
    看成「已同步」，而落后的子工程随后仍会被 `sync` 拉齐。
    """
    if git(["status", "--porcelain"], cwd=sp).stdout.strip():
        return False
    head = git(["rev-parse", "HEAD"], cwd=sp).stdout.strip()
    if not head:
        return False
    r = git(["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{mainline}"], cwd=sp)
    return r.returncode == 0 and r.stdout.strip() == head


def submodule_pointer(root, rel_path: str) -> str:
    """主仓库索引里记录的该子模块指针（gitlink SHA）。非子模块 / 未在索引中 → 空串。

    读 `ls-files -s` 而不是 `submodule status`：后者的 `+` 前缀只表达「不一致」这一个比特，
    拿不到「记录的是哪个 SHA」，提示里就没法同时给出「记录 → 实际」两个端点——而人需要的
    恰恰是「它跑到哪去了」。
    """
    r = git(["ls-files", "-s", "--", rel_path], cwd=root)
    if r.returncode != 0:
        return ""
    for line in r.stdout.splitlines():
        meta, _, _ = line.partition("\t")
        fields = meta.split()
        if len(fields) >= 2 and fields[0] == "160000":
            return fields[1]
    return ""


def submodule_local_work(svc_dir) -> str:
    """子模块里「一旦被切走就会出事」的本地工作，返回人类可读原因（多条以 `；` 连接）；干净则空串。

    三个来源，对应 `git submodule update` / `git pull --recurse-submodules` 的三种破坏方式：
    ① 未提交改动 → 命令报错中止（fail-loud，尚可）；② 停在旁支 → 工作区被换成指针那一版，
    人的文件从视野里消失；③ 有未合入主线的本地提交 → 同上，提交虽仍在分支上可寻回，但当事人
    的第一反应是「活白干了」。

    判据认「位置」不认「名字」，与 `sync.should_preserve_branch` 同源：fix 直通纪律明文允许
    采纳**不含 harness 标记**的自有分支，按名字判对那类分支恒失效。
    """
    reasons = []
    if git(["status", "--porcelain"], cwd=svc_dir).stdout.strip():
        reasons.append("有未提交改动")
    mainline = get_mainline_branch(svc_dir)
    cur = git(["branch", "--show-current"], cwd=svc_dir).stdout.strip()
    if cur and cur != mainline:
        reasons.append(f"停在旁支 {cur}（非主线 {mainline}）")
    ref = f"origin/{mainline}"
    if git(["rev-parse", "--verify", "--quiet", f"refs/remotes/{ref}"], cwd=svc_dir).returncode != 0:
        ref = mainline
    r = git(["rev-list", "--count", f"{ref}..HEAD"], cwd=svc_dir)
    if r.returncode == 0 and r.stdout.strip() not in ("", "0"):
        reasons.append(f"有 {r.stdout.strip()} 个未合入 {mainline} 的本地提交")
    return "；".join(reasons)


# ─── 输出 ────────────────────────────────────────────────────────
def _color():
    if not sys.stdout.isatty():
        return {"red": "", "green": "", "yellow": "", "blue": "", "nc": ""}
    return {"red": "\033[0;31m", "green": "\033[0;32m",
            "yellow": "\033[0;33m", "blue": "\033[0;34m", "nc": "\033[0m"}


def c_pass(msg): print(f"  {_color()['green']}✅{_color()['nc']} {msg}")
def c_fail(msg): print(f"  {_color()['red']}❌{_color()['nc']} {msg}")
def c_warn(msg): print(f"  {_color()['yellow']}⚠️ {_color()['nc']} {msg}")
def c_info(msg): print(f"  ℹ️  {msg}")


# ─── 位置参数守卫 ──────────────────────────────────────────────────
# 背景（2026-09-18 实录）：`create_fix_branch.py --help` 把 `--help` 当成任务名，
# 在 backend/frontend 两个子模块里各建了一个 `fix/harness---help` 分支；
# `create_feat_branch.py` 同构，且默认还会把该分支 push 到远端。
# 凡接收「位置任务名」的脚本，必须在产生任何 git/文件副作用**之前**调用下方守卫：
# 先 want_help，再 reject_flag_like，都不通过就直接 return，不进主流程。

def want_help(argv, usage) -> bool:
    """argv 含 -h/--help → 打印用法并返回 True（调用方据此提前 return，禁止先做副作用）。"""
    if any(a in ("-h", "--help") for a in argv):
        print(usage)
        return True
    return False


def reject_flag_like(label, value, usage) -> bool:
    """位置参数形如选项（以 `-` 开头）→ 报错并打印用法，返回 True 表示应中止。"""
    if value.startswith("-"):
        c_fail(f"{label} 不能是选项形式：'{value}'（疑似把 --help / --base 等选项误当参数）")
        print(usage)
        return True
    return False


# ─── 子工程范围参数（--services）────────────────────────────────────
# create_feat_branch / create_fix_branch 共用：本轮只改一端时，别让另一端凭空多出一个
# （还可能被 push 出去的）分支。三个消费方（两条建分支路径、以及测试）同源，避免解析各异。

def split_services_flag(argv: list):
    """摘出 `--services <a,b>` / `--services=<a,b>` → `(取值或 None, 剩余参数)`。

    取值缺失时返回空串（而非 None）——调用方据此报错，而不是把它当成「没写 --services」而全量处理。
    """
    spec, rest, i = None, [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--services":
            spec = argv[i + 1] if i + 1 < len(argv) else ""
            i += 2
            continue
        if a.startswith("--services="):
            spec = a.split("=", 1)[1]
            i += 1
            continue
        rest.append(a)
        i += 1
    return spec, rest


def pick_services(all_names: list, spec):
    """按 `--services` 取值筛选子工程名 → `(选中名列表, 未知名列表)`。

    `spec` 为 None ⇒ 全选（**向后兼容**：不写 `--services` 行为与从前完全一致）。
    未知名由调用方报错，而不是静默忽略——名字写错一个字母就等于少动一个仓库，
    而失败会推迟到后续阶段（编辑被 hook 拦下 / 看板记录对不上）才暴露，远不如当场说破。
    """
    if spec is None:
        return list(all_names), []
    wanted = [s.strip() for s in spec.split(",") if s.strip()]
    unknown = [s for s in wanted if s not in all_names]
    return [n for n in all_names if n in wanted], unknown


# ─── CodeGraph ────────────────────────────────────────────────────
# CodeGraph 是可选增强：默认不自动全局安装，只有调用方显式 allow_install=True 才装。
# 安装固定 major 版本，避免未来 CLI 破坏命令；钩子场景可传 respect_cooldown。
CODEGRAPH_PKG = "@colbymchenry/codegraph"
CODEGRAPH_PIN_DEFAULT = "^1.4.0"
_INSTALL_COOLDOWN = 10 * 60  # 冷却秒数
CODEGRAPH_COOLDOWN_FILE = ROOT / ".harness" / ".logs" / ".codegraph-install-cooldown"


def codegraph_path() -> str:
    """codegraph 可执行文件路径；未安装返回空串。"""
    return shutil.which("codegraph") or ""


def codegraph_version() -> str:
    exe = codegraph_path()
    if not exe:
        return ""
    r = run([exe, "--version"])
    return (r.stdout or r.stderr or "").strip().splitlines()[0] if r.returncode == 0 else ""


def codegraph_install_spec(pin=None) -> str:
    pin = (pin or os.environ.get("HK_CODEGRAPH_PIN") or CODEGRAPH_PIN_DEFAULT).strip()
    return f"{CODEGRAPH_PKG}@{pin}" if pin else CODEGRAPH_PKG


def ensure_codegraph(verbose=True, respect_cooldown=False, allow_install=False, pin=None) -> tuple:
    """确保 codegraph 已安装；**默认不自动全局安装**。

    2026-11 多语言适配：Java/.NET 机器可能没有 npm，自动 `npm install -g` 会让初始化
    卡在可选能力上。只有调用方（人确认后）显式传 allow_install=True 才安装，并固定
    major 版本（默认 ^1.4.0），避免未来 CLI 破坏命令。

    :return: (ok: bool, msg: str)。ok=False 时 msg 含手动安装指引。
    """
    if codegraph_path():
        return True, ""
    spec = codegraph_install_spec(pin)
    if not allow_install:
        return False, (f"codegraph 未安装（不自动全局安装）。安装: npm install -g {spec}；"
                       f"或在初始化中确认后重试")
    if respect_cooldown:
        try:
            if CODEGRAPH_COOLDOWN_FILE.is_file() and \
                    time.time() - CODEGRAPH_COOLDOWN_FILE.stat().st_mtime < _INSTALL_COOLDOWN:
                return False, (f"codegraph 未安装（自动安装失败后冷却期内，稍后会自动重试）；"
                               f"手动安装: npm install -g {spec}")
        except OSError:
            pass
    if verbose:
        print(f"  📦 codegraph 未安装，安装: npm install -g {spec}")
    try:
        r = subprocess.run(_resolve_exe(["npm", "install", "-g", spec]),
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return False, f"未找到 npm 命令；请先安装 Node.js/npm，再执行: npm install -g {spec}"
    if r.returncode == 0 and codegraph_path():
        if verbose:
            print(f"  ✅ codegraph 已安装: {codegraph_path()}")
        return True, ""
    try:
        CODEGRAPH_COOLDOWN_FILE.parent.mkdir(parents=True, exist_ok=True)
        CODEGRAPH_COOLDOWN_FILE.write_text(time.strftime("%Y-%m-%dT%H:%M:%S"), encoding="utf-8")
    except OSError:
        pass
    detail = (r.stderr or r.stdout or "").strip().splitlines()
    tail = "；".join(detail[-2:]) if detail else f"npm exit {r.returncode}"
    return False, f"codegraph 自动安装失败（{tail}）。手动安装: npm install -g {spec}"

# ─── 看板「分支」列 helper（fix 流程用）──────────────────────────
def _board_rows(root: Path) -> list:
    """读看板，返回去掉表头/分隔线的行 cell 列表。

    列序契约：任务名|状态|Profile|Apply进度|分支|上次活动|续接提示。
    调用方硬编码下标（[1]状态 [2]Profile [4]分支），改看板表头须同步。

    **表头/分隔线的判据只看首格，不做全行子串匹配**：数据行的第一个 cell 才是任务名，
    它等于「任务名」即表头、全由 `-`/`:` 构成即分隔线。
    曾用 `"任务名" in line` 判表头 —— 那是**全行子串匹配**，会命中任何在备注里写下这三个字的
    数据行并把整行滤掉。备注是自由书写区（轮次说明、分支命名纪律等都可能自然地提到该词），
    于是该行对**全部**消费方同时不可见：`get_board_branch` 拿到空串 ⇒ `archive.py submodule`
    回退猜 `feat/harness-<任务>` ⇒ 猜出的名字若恰好是他轮已合入的同名分支，本子模块就被判
    「未参与本轮」而**不合并、不推送、不 bump 指针**，且**退出码 0**。
    静默幅度与「状态零命中」同级，故此处必须精确判据（不阻塞、不猜测，只把可见性还回去）。
    """
    board = root / ".harness" / "tasks" / "board.md"
    if not board.is_file():
        return []
    out = []
    for line in board.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        head = cells[0] if cells else ""
        if head == "任务名" or (head and not head.strip("-: ")):
            continue
        # 容错与内核 parseBoardRow 同源：超列（自由文本混入 |）溢出并入末列「续接提示」，
        # 保证 [1]状态 [2]Profile [4]分支 下标永不因坏行错位。
        if len(cells) > 7:
            cells = cells[:6] + [" / ".join(cells[6:])]
        while len(cells) < 7:
            cells.append("—")
        out.append(cells)
    return out


# ── 看板「分支」列解析（`分支名 (子工程)` 标注）──────────────────
# 约定：单元格逗号分隔多个分支，每个 token 可带**子工程标注**——
#   `fix/xxx`            → 对本仓任一子工程都适用
#   `fix/xxx (backend)`  → 只对 `backend` 适用
# 标注是框架自身的写法，不是笔误：看板只有**一列**「分支」，而一个任务可跨多个子工程、各建各的
# 分支，只能靠标注区分归属（看板既有行即在用此形态，采纳开发者自有分支时由人写入）。
# 教训：三个消费方（archive 合并、check_branch 预检、pre_edit hook 放行）**各自**把 token 原样
#   当分支名用，而带标注的名字**永远**匹配不上任何真分支：
#     archive  → 判「无候选分支 ⇒ 未参与本轮」而**静默跳过**，分支永不合并、指针永不 bump，归档照报成功；
#     check_branch / pre_edit → 采纳分支既不被放行也不被识别 → **开发中被 hook 全面拦住**。
#   两处方向都不可接受（一为假成功，一为硬阻塞），故解析收口到 lib，三处同源。
_BOARD_BRANCH_TOKEN_RE = re.compile(r"^(?P<branch>[^\s(]+)\s*(?:\(\s*(?P<svc>[^)]*?)\s*\))?$")


def parse_board_branch_token(token: str):
    """分支 token → `(分支名, 子工程名或 None)`；空 / 占位符 `—` 返回 None（属正常，不是错误）。"""
    t = (token or "").strip()
    if not t or t == "—":
        return None
    m = _BOARD_BRANCH_TOKEN_RE.match(t)
    return (m.group("branch"), m.group("svc") or None) if m else None


def _split_board_tokens(cell: str) -> list:
    """按**括号外**的逗号切分单元格：`a (backend, frontend), b` → `['a (backend, frontend)', 'b']`。

    不能用 `cell.split(",")`：子工程标注本身就是用逗号列举多端（`(backend, frontend)`），
    裸切会把**一个** token 碎成 `feat/x (backend` 与 `frontend)` 两段。后者尤其危险——
    `parse_board_branch_token` 认不出它是残片（无空白、无括号 ⇒ 整串当分支名），于是它被
    当成一个**名为 `frontend)` 的合法分支**混进候选，既不进 `bad` 触发告警、也永远匹配不上
    任何真分支，最终表现为「看板明明记了分支，却被判成本子模块未参与本轮」的静默跳过。
    """
    out, depth, cur = [], 0, []
    for ch in cell or "":
        if ch == "(":
            depth += 1
        elif ch == ")" and depth > 0:
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def board_branch_candidates(cell: str, service: str = None):
    """看板「分支」列 → `(候选分支名, 无法解析的 token)`，候选名去重保序。

    `service` 给定则只收「无标注」与「标注**含**本子工程」的 token（标注可逗号列举多端，
    如 `feat/x (backend, frontend)`，与单元格分隔符同形但语义不同——切分靠
    `_split_board_tokens` 的括号深度，不靠裸 split）；为 None 表示调用方没有子工程
    上下文（如只看名字决定放行与否），此时忽略标注、全收。
    第二个返回值非空即代表**有 token 被丢掉**，调用方应按各自场景决定是否告警——
    静默丢弃正是本函数要修的病。
    """
    mine, bad, seen = [], [], set()
    for tok in _split_board_tokens(cell):
        if not tok.strip() or tok.strip() == "—":
            continue
        parsed = parse_board_branch_token(tok)
        if parsed is None:
            bad.append(tok.strip())
            continue
        branch, svc = parsed
        if svc is not None and service is not None:
            if service not in [s.strip() for s in svc.split(",") if s.strip()]:
                continue
        if branch not in seen:
            seen.add(branch)
            mine.append(branch)
    return mine, bad


def get_board_branch(root: Path, task: str) -> str:
    """看板某任务「分支」列值；无匹配返回 ''。"""
    for cells in _board_rows(root):
        if len(cells) >= 5 and cells[0] == task:
            return cells[4]
    return ""


def set_board_branch(root: Path, task: str, branch: str) -> None:
    """写看板某任务「分支」列；行不存在则不动。列不足补 '—'。"""
    board = root / ".harness" / "tasks" / "board.md"
    if not board.is_file():
        return
    lines = board.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells and cells[0] == task:
            while len(cells) < 5:
                cells.append("—")
            cells[4] = branch
            lines[i] = "| " + " | ".join(cells) + " |"
            break
    board.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _is_done_status(status: str) -> bool:
    """看板状态格是否 DONE。

    不能用 `== "DONE"` 严格相等：状态格常带**注释**——既有行里就有
    `DONE（并入 message-trace R4）`、`IN_PROGRESS（CR BLOCK，Critical×3，待人工裁决）`。
    严格相等会把已收尾的行当成在办，其「分支」列于是被继续当作「本轮分支」消费。
    """
    return (status or "").strip().startswith("DONE")


def board_claims_branch(root: Path = ROOT, service: str = None) -> list:
    """看板中**未 DONE** 的任务为 `service` 记录的分支名，去重保序，**只认显式标注本子工程的 token**。

    与 `collect_fix_branches` 回答的是**两个不同问题**，故不复用：
      - `collect_fix_branches` =「哪些分支可凭记录放行」→ 只认 `profile == "fix"`，
        且接受无标注 token（apply 轮分支自带 harness 标记，不需靠看板放行）；
      - 本函数 =「看板是否**指名道姓**说这个子工程本轮有分支」→ 不限 profile。

    用途是**记录↔执行一致性反查**：子工程停在主线（看似「本轮未参与」），而看板却为它记着本轮
    分支 ⇒ 两者必有一错——要么它真没参与、该看板行早该收尾，要么它参与了却没停在自己分支上
    （`sync` 搬家、或忘了切回来）。这是**可判定**的矛盾，不该当「未参与」放行。

    **无标注的 token 一律不计**（`feat/x` 只说「某个子工程有分支」，没说「是这一个」）：拿它判
    本子工程构成矛盾，会把最常见的「只改前端」轮次误判成后端违规。`service` 为 None 时无子工程
    上下文，同理返回空——判不了的事不假装判得了。
    """
    if not service:
        return []
    out, seen = [], set()
    for cells in _board_rows(root):
        if len(cells) < 5 or _is_done_status(cells[1]):
            continue
        for tok in (cells[4] or "").split(","):
            parsed = parse_board_branch_token(tok)
            if parsed is None:
                continue
            branch, svc = parsed
            if svc != service:
                continue
            if branch not in seen:
                seen.add(branch)
                out.append(branch)
    return out


def collect_fix_branches(root: Path = ROOT, service: str = None) -> set:
    """看板中 Profile=fix 且状态非 DONE 的任务「分支」列集合（已按 `board_branch_candidates` 剥离
    `(子工程)` 标注）。

    只剥标注、不改判据：这些分支是「开发者自有、未经 create_feat_branch 建」，靠看板记录放行，
    名字对不上就等于没记录。`service` 给定则只收标注为本子工程的（精确）；不给则全收。
    """
    out = set()
    for cells in _board_rows(root):
        if len(cells) < 5:
            continue
        status, profile, branch = cells[1], cells[2], cells[4]
        if profile == "fix" and not _is_done_status(status) and branch and branch != "—":
            out.update(board_branch_candidates(branch, service)[0])
    return out
