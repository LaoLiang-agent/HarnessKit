#!/usr/bin/env python3
# .harness/scripts/env_auto.py
# 自动环境识别：探测工程类型 → 提取版本要求 → 找到匹配运行时 → 输出 shell 环境语句
# 用法：
#   macOS/Linux（POSIX）: eval "$(python3 .harness/scripts/env_auto.py services/backend)"
#   Windows cmd:         for /f "delims=" %i in ('python .harness\scripts\env_auto.py services\backend') do @set %i
#   Windows PowerShell:  python .harness\scripts\env_auto.py services\backend --format powershell | ForEach-Object { Invoke-Expression $_ }
#   显式指定格式:        --format posix|cmd|powershell（默认：非 Windows = posix，Windows = cmd）
#   --check:             只做诊断（不输出 export 语句），供 /harness-init 使用
#
#   子工程参数三种写法等价：短名 `backend`、`services/backend`、绝对路径（见 lib.resolve_service_dir）。
#
# 输出一行一个变量；缓存到 <service>/.harness/.env-cache。
#
# 两种用法，同一套解析逻辑：
#   1) 手动（本文件 CLI）：输出 shell 语句，由用户 eval 进自己的 shell。
#   2) 程序内（lib.build_env / lib.run_build_field）：调用 resolve_env() 拿数据，
#      直接注入子进程 env —— 不经过 shell 文本，跨平台无需解析三种语法。
#
# 缓存格式（key=value 数据行，**不是** shell 语句——别让缓存承担跨平台语法）：
#   fingerprint=sha256:...      解析所依据输入的指纹，变了即作废重算
#   set NAME=VALUE              直接设置
#   prepend NAME=VALUE          前置到（POSIX 用 os.pathsep 分隔的）该变量
# 人工覆盖：在文件里加一行 `# manual-override` → 自动扫描不再覆盖它，执行器永远信任它。
import hashlib, os, re, shutil, sys, time
from pathlib import Path
import lib

CACHE_VERSION = "v1"
CACHE_TTL = 3600
MANUAL_MARK = "# manual-override"


def xml_val(path, tag):
    """从 XML 取第一个 <tag>...</tag> 值（tag 可含转义点）。"""
    try:
        m = re.search(rf"<{tag}>([^<]*)</{tag}>", Path(path).read_text(encoding="utf-8", errors="ignore"))
        return m.group(1) if m else ""
    except OSError:
        return ""


def extract_major(v: str) -> str:
    # 对齐原 env-auto.sh 的 Java 主版本号语义："1.8" → "8", "17.0.5" → "17"
    v = re.sub(r"^1\.", "", v or "")
    m = re.search(r"[0-9]+", v)
    return m.group(0) if m else ""


def detect_java_version(service_dir) -> str:
    pom = Path(service_dir) / "pom.xml"
    if not pom.is_file():
        return ""
    for tag in (r"java\.version", r"maven\.compiler\.source", r"maven\.compiler\.target", "source"):
        v = xml_val(pom, tag)
        if v:
            return v
    return ""


def _java_exe(jh: Path):
    """JDK 根目录下的 java 可执行文件（Windows 为 java.exe）。"""
    for cand in ("java", "java.exe"):
        p = jh / "bin" / cand
        if p.is_file():
            return p
    return None


def _javac_exe(jh: Path):
    """JDK 根目录下的 javac 可执行文件（Windows 为 javac.exe）。"""
    for cand in ("javac", "javac.exe"):
        p = jh / "bin" / cand
        if p.is_file():
            return p
    return None


def _is_jdk_root(jh: Path) -> bool:
    """JDK 根目录的判据：根下必须有 `release` 文件。

    用于挡掉 macOS 的 `/usr`：`/usr/bin/java` 与 `/usr/bin/javac` 都是**启动器 stub**
    （不是 JDK），从 PATH 上的 `java` 回溯会得到根 = `/usr`，而 `_javac_exe` 也拦不住它
    （`/usr/bin/javac` 同样是 stub）。更致命的是该 stub **跟随调用方的 JAVA_HOME 自报版本**
    ——调用方把 JAVA_HOME 设成 JDK8，`/usr/bin/java -version` 就报 `1.8.0_361`，
    于是 `/usr` 恰好「版本匹配」通过全部校验被当成 JDK 根，最终发出 `JAVA_HOME=/usr`，
    使 maven 卡在自己的 java 探测上（本机实测挂起数分钟不返回）。

    真 JDK 根恒有 `release`（含 Windows 的 `<jdk>\\release`），`/usr` 没有。
    """
    try:
        return (Path(jh) / "release").is_file()
    except OSError:
        return False


def _java_check(jh: Path, want_ver: str):
    # 先确认是**真的 JDK 根**：`/usr` 这类系统 bin 目录会被其 stub 伪装成 JDK（见上）。
    if not _is_jdk_root(jh):
        return False
    java = _java_exe(jh)
    if not java:
        return False
    # JDK 身份校验：只有 java 没有 javac 的是 JRE（如 macOS 的 JavaAppletPlugin、
    # 各发行版的 jre 目录）。把它当候选会让 maven 报「No compiler is provided in this
    # environment」，即 env-auto 报「环境就绪」却发一个编译必失败的 JAVA_HOME。
    if not _javac_exe(jh):
        return False
    r = lib.run([str(java), "-version"])
    m = re.search(r'"([^"]*)"', r.stderr or "")
    if not m:
        return False
    actual = m.group(1).replace("1.", "").split(".")[0]  # 1.8→8, 17.0.5→17
    want = want_ver.replace("1.", "").split(".")[0]
    return actual == want


def resolve_java_home(want_ver: str) -> str:
    # 1) PATH 上的 java（跨平台最可靠；符号链接 resolve 后回溯到 JDK 根）
    jb = shutil.which("java")
    if jb:
        jh = Path(jb).resolve().parent.parent
        if _java_check(jh, want_ver):
            return str(jh)
    # 2) 当前 JAVA_HOME
    jh = os.environ.get("JAVA_HOME", "")
    if jh and _java_check(Path(jh), want_ver):
        return jh
    # 3) macOS /usr/libexec/java_home（仅 macOS 存在，探测失败自动跳过）
    jhx = Path("/usr/libexec/java_home")
    if jhx.is_file():
        for arg in (f"1.{extract_major(want_ver)}", extract_major(want_ver)):
            r = lib.run([str(jhx), "-v", arg])
            if r.returncode == 0 and r.stdout.strip():
                cand = r.stdout.strip()
                if _java_check(Path(cand), want_ver):
                    return cand
    # 4) SDKMAN（POSIX 目录；Windows 下 .sdkman 不存在自动跳过）
    sdk = Path.home() / ".sdkman" / "candidates" / "java"
    if sdk.is_dir():
        for d in sdk.iterdir():
            if extract_major(want_ver) in d.name and _java_check(d, want_ver):
                return str(d)
    # 5) 常见安装根（macOS/Linux + Windows，逐级 is_dir 守卫，探测失败走后续 fallback）
    major = extract_major(want_ver)
    bases = ["/Library/Java/JavaVirtualMachines", "/usr/lib/jvm", "/usr/local/opt"]
    if os.name == "nt":
        bases += [r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium",
                  r"C:\Program Files\Microsoft", str(Path.home() / ".jdks")]
    tokens = (f"jdk1.{major}", f"jdk-{major}", f"jdk{major}",
              f"openjdk-{major}", f"openjdk{major}", f"zulu{major}")
    for base in bases:
        bp = Path(base)
        if not bp.is_dir():
            continue
        for d in bp.iterdir():
            if not d.is_dir() or not any(t in d.name for t in tokens):
                continue
            home = d / "Contents" / "Home"
            if not home.is_dir():
                home = d
            if _java_check(home, want_ver):
                return str(home)
    return ""


def detect_node_version(service_dir) -> str:
    """有 package.json 才算 Node 工程（返回 engines.node 主版本，未声明则 14）；
    没有则返回 "" —— Java/Go 工程不该因为机器上没有 Node 而被判为环境缺失。"""
    pkg = Path(service_dir) / "package.json"
    if not pkg.is_file():
        return ""
    try:
        import json
        d = json.loads(pkg.read_text(encoding="utf-8"))
        e = str(d.get("engines", {}).get("node", ""))
        m = re.search(r"(\d+)", e)
        if m:
            return m.group(1)
    except (json.JSONDecodeError, OSError):
        pass
    return "14"


def _node_check(bin_path: Path, want: str) -> bool:
    if not bin_path.is_file():
        return False
    r = lib.run([str(bin_path), "--version"])
    m = re.search(r"v?(\d+)", r.stdout or "")
    return bool(m) and int(m.group(1)) >= int(want)


def resolve_node(want: str) -> str:
    # nvm（macOS/Linux 与 Windows nvm-windows 均提供 `nvm which` 子命令，无需 bash）
    nvm = shutil.which("nvm")
    if nvm:
        r = lib.run([nvm, "which", "default"])
        if r.returncode == 0 and r.stdout.strip():
            p = Path(r.stdout.strip())
            if _node_check(p, want):
                return str(p.parent)
    for tool in ("volta", "fnm", "node"):
        b = shutil.which(tool)
        if not b:
            continue
        if tool == "node":
            if _node_check(Path(b), want):
                return str(Path(b).parent)
            continue
        r = lib.run([b, "which", "node"])
        if r.returncode == 0 and r.stdout.strip():
            p = Path(r.stdout.strip())
            if _node_check(p, want):
                return str(p.parent)
    return ""


def detect_python_version(service_dir) -> str:
    p = Path(service_dir)
    for f in ("pyproject.toml", "setup.py", "Pipfile", "requirements.txt"):
        if (p / f).is_file():
            return "3.8"
    return ""


def _python_check(bin_path) -> bool:
    r = lib.run([str(bin_path), "--version"])
    m = re.search(r"Python (\d+)\.(\d+)", r.stderr or "")
    if not m:
        return False
    return int(m.group(1)) >= 3 and int(m.group(2)) >= 8


def resolve_python() -> str:
    for b in ("pyenv", "python3", "python"):
        p = shutil.which(b)
        if not p:
            continue
        binp = Path(p)
        if b == "pyenv":
            for name in ("python3", "python"):
                r = lib.run([p, "which", name])
                if r.returncode == 0 and r.stdout.strip():
                    binp = Path(r.stdout.strip())
                    break
        if _python_check(binp):
            return str(binp.parent)
    return ""


def detect_jmeter(service_dir) -> str:
    p = Path(service_dir)
    if list(p.glob("*.jmx")) or (p / ".jmeter-root").is_file():
        return "any"
    return ""


def _jmeter_exe(jm: Path):
    """JMeter 根目录下的启动脚本（Windows 为 jmeter.bat / jmeter.exe）。"""
    for cand in ("jmeter", "jmeter.bat", "jmeter.exe"):
        p = jm / "bin" / cand
        if p.is_file():
            return p
    return None


def resolve_jmeter() -> str:
    jm = os.environ.get("JMETER_HOME", "")
    if jm and _jmeter_exe(Path(jm)):
        return jm
    b = shutil.which("jmeter")
    if b:
        return str(Path(b).resolve().parent.parent)
    bases = ["/usr/local/jmeter", "/opt/jmeter", "/usr/local/opt/jmeter", str(Path.home() / "apache-jmeter")]
    if os.name == "nt":
        bases += [r"C:\Program Files\apache-jmeter", r"C:\jmeter", r"C:\Program Files\Apache\jmeter"]
    for base in bases:
        p = Path(base)
        if _jmeter_exe(p):
            return base
    return ""


# ── 解析结果（纯数据，不打印） ───────────────────────────────────────────────

class EnvResolution:
    """一次环境解析的产物。CLI 打印它，lib.run_build_field 注入它。"""

    def __init__(self, service_dir):
        self.service_dir = Path(service_dir)
        self.exports = []       # [(name, value, kind)]，kind='env'|'path'
        self.detected = []      # 人类可读的工程类型清单，如 ["Java 1.8"]
        self.notes = []         # [(ok, text)] CLI 逐行诊断
        self.missing = []       # 缺失项 + 安装提示（非空 = 不可用）
        self.identified = False  # 是否识别出工程类型
        self.cached = False

    @property
    def ok(self) -> bool:
        return self.identified and not self.missing

    def apply_to(self, base_env: dict) -> dict:
        """把解析结果应用到一份环境变量副本上（不修改入参）。"""
        env = dict(base_env)
        for name, value, kind in self.exports:
            if kind == "path":
                cur = env.get(name, "")
                parts = [p for p in cur.split(os.pathsep) if p]
                if value in parts:          # 已在 PATH 里，不重复前置
                    continue
                env[name] = os.pathsep.join([value] + parts)
            else:
                env[name] = value
        return env


def resolve_env(service_dir) -> EnvResolution:
    """探测 → 解析 → 返回结果。**不打印、不落盘、不退出**，可被任意脚本调用。"""
    sp = Path(service_dir)
    if not sp.is_absolute():
        sp = Path.cwd() / sp
    res = EnvResolution(sp)

    # Java
    jv = detect_java_version(sp)
    if jv:
        res.identified = True
        res.detected.append(f"Java {jv}")
        rj = resolve_java_home(jv)
        if rj:
            res.exports.append(("JAVA_HOME", rj, "env"))
            res.exports.append(("PATH", f"{rj}{os.sep}bin", "path"))
            res.notes.append((True, f"Java {jv} → {rj}"))
        else:
            res.notes.append((False, f"Java {jv} required, no JDK found"))
            res.missing.append("Java %s：未找到匹配的 JDK。安装：sdk install java %s  或  brew install openjdk@%s，"
                               "或设置 JAVA_HOME 指向 JDK %s" % (jv, jv, extract_major(jv), extract_major(jv)))
    # Node
    nv = detect_node_version(sp)
    if nv:
        res.identified = True
        res.detected.append(f"Node >={nv}")
        rn = resolve_node(nv)
        if rn:
            res.exports.append(("PATH", rn, "path"))
            res.notes.append((True, f"Node >={nv} → {rn}"))
        else:
            res.notes.append((False, f"Node >={nv} required, no matching Node found"))
            res.missing.append(f"Node >= {nv}：未找到。安装：nvm install {nv}  或  brew install node@{nv}")
    # Go
    gom = sp / "go.mod"
    if gom.is_file():
        m = re.search(r"^go (\d+(?:\.\d+)?)", gom.read_text(encoding="utf-8", errors="ignore"), re.M)
        if m:
            res.identified = True
            res.detected.append(f"Go {m.group(1)}")
            gb = shutil.which("go")
            if gb:
                res.exports.append(("PATH", str(Path(gb).parent), "path"))
                res.notes.append((True, f"Go {m.group(1)} → {Path(gb).parent}"))
            else:
                res.notes.append((False, "Go required, no go found"))
                res.missing.append("Go：未找到。安装：https://go.dev/dl/ 或 brew install go")
    # Python
    pv = detect_python_version(sp)
    if pv:
        res.identified = True
        res.detected.append(f"Python >={pv}")
        rp = resolve_python()
        if rp:
            res.notes.append((True, f"Python >={pv} → {rp}"))
        else:
            res.notes.append((False, f"Python >={pv} required, no matching Python found"))
            res.missing.append(f"Python >= {pv}：未找到。安装：pyenv install {pv}  或  brew install python@3")
    # JMeter
    if detect_jmeter(sp):
        res.identified = True
        res.detected.append("JMeter")
        rj = resolve_jmeter()
        if rj:
            res.exports.append(("JMETER_HOME", rj, "env"))
            res.exports.append(("PATH", f"{rj}{os.sep}bin", "path"))
            res.notes.append((True, f"JMeter → {rj}"))
        else:
            res.notes.append((False, "JMeter required, no installation found"))
            res.missing.append("JMeter：未找到。安装：brew install jmeter 或设置 JMETER_HOME")

    return res


# ── 缓存（<service>/.harness/.env-cache） ────────────────────────────────────

def cache_path(service_dir) -> Path:
    sp = Path(service_dir)
    if not sp.is_absolute():
        sp = Path.cwd() / sp
    return sp / ".harness" / ".env-cache"


def env_fingerprint(service_dir) -> str:
    """解析所依据的输入指纹。任一变化 → 缓存作废重算。

    覆盖三类输入：工程声明的版本要求、当前平台、以及相关工具在 PATH 上的落点
    （用户切了 nvm/JAVA_HOME、换了 JDK 安装，指纹即变）。
    """
    sp = Path(service_dir)
    if not sp.is_absolute():
        sp = Path.cwd() / sp
    parts = [
        CACHE_VERSION, os.name, sys.platform, str(sp),
        # 调用方的 JAVA_HOME 是 resolve_java_home 第 2 步的输入（且 macOS 的 java stub 会
        # 跟随它自报版本），必须进指纹——否则换了 JDK 仍命中旧缓存。
        "java_home=" + os.environ.get("JAVA_HOME", ""),
        "java_req=" + detect_java_version(sp),
        "node_req=" + detect_node_version(sp),
        "py_req=" + detect_python_version(sp),
        "jmeter_req=" + detect_jmeter(sp),
        "go_mod=" + ("1" if (sp / "go.mod").is_file() else "0"),
    ]
    for tool in ("java", "node", "npm", "go", "python3", "jmeter"):
        parts.append(f"{tool}={shutil.which(tool) or ''}")
    return "sha256:" + hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:32]


def render_cache(res: EnvResolution, fingerprint: str) -> str:
    lines = [
        f"# harness env cache {CACHE_VERSION} — 由 .harness/scripts/env_auto.py 生成，通常无需手改",
        f"# 人工覆盖：在本文件加一行 `{MANUAL_MARK}`，自动扫描将不再覆盖它，执行器永远信任它",
        f"fingerprint={fingerprint}",
    ]
    for name, value, kind in res.exports:
        lines.append(f"{'prepend' if kind == 'path' else 'set'} {name}={value}")
    return "\n".join(lines) + "\n"


def parse_cache(service_dir):
    """→ (exports, fingerprint, manual)；文件不存在/不可读 → None。"""
    try:
        text = cache_path(service_dir).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    exports, fingerprint, manual = [], "", False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            if line == MANUAL_MARK:
                manual = True
            continue
        if line.startswith("fingerprint="):
            fingerprint = line.split("=", 1)[1]
            continue
        for kw, kind in (("set ", "env"), ("prepend ", "path")):
            if line.startswith(kw):
                kv = line[len(kw):]
                if "=" not in kv:
                    break
                name, value = kv.split("=", 1)
                name = name.strip()
                if name:
                    exports.append((name, value, kind))
                break
    return exports, fingerprint, manual


def cache_is_fresh(service_dir, exports, fingerprint, manual, now=None) -> bool:
    """人工覆盖 → 永远新鲜；否则 指纹一致 + TTL 内 + 每个导出路径仍在。"""
    if manual:
        return True
    if fingerprint != env_fingerprint(service_dir):
        return False
    try:
        mtime = cache_path(service_dir).stat().st_mtime
    except OSError:
        return False
    if (now if now is not None else time.time()) - mtime > CACHE_TTL:
        return False
    return all(Path(v).exists() for _, v, _ in exports if v)


def has_manual_override(service_dir) -> bool:
    c = parse_cache(service_dir)
    return bool(c and c[2])


def manual_override_lost_msg(service_dir):
    """缓存声明了人工覆盖、却解析不出任何导出 → 返回警告文案；无问题 → None。

    这是「静默失效」的检测点：老版本缓存存的是 shell 语句（`export NAME=VALUE`），
    现在存的是数据行（`set NAME=VALUE`）。老文件里对人工覆盖的解析结果为 0 条导出，
    于是 `resolve_env_cached` 判它不可用而重探（覆盖内容被无视），`write_cache` 又因
    读到 `# manual-override` 而拒绝重写（文件也不被迁移）——两头都不出声，用户以为
    自己改的 JDK 路径还在生效。契约承诺「执行器永远信任它」，这里就是契约被违反处。
    """
    c = parse_cache(service_dir)
    if not (c and c[2] and not c[0]):
        return None
    return (
        f"{Path(service_dir).name}: .env-cache 声明了 `{MANUAL_MARK}`，却没有任何可解析的导出行"
        "—— 覆盖内容不会生效。\n"
        f"     缓存存的是**数据行**而非 shell 语句：`set NAME=VALUE` / `prepend NAME=VALUE`。\n"
        f"     请按数据行改写 {cache_path(service_dir)}，或删掉该文件让框架重新生成。"
    )


def write_cache(service_dir, res: EnvResolution, fingerprint: str) -> bool:
    """写缓存；人工覆盖或解析失败时不写。返回是否写入。"""
    if not res.ok or has_manual_override(service_dir):
        return False
    try:
        p = cache_path(service_dir)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(render_cache(res, fingerprint), encoding="utf-8")
        return True
    except OSError:
        return False


def resolve_env_cached(service_dir) -> EnvResolution:
    """执行器入口：命中新鲜缓存则免探测，否则重算并回写。"""
    sp = Path(service_dir)
    if not sp.is_absolute():
        sp = Path.cwd() / sp
    warn = manual_override_lost_msg(sp)
    if warn:
        lib.c_warn(warn)
    cached = parse_cache(sp)
    if cached:
        exports, fp, manual = cached
        if exports and cache_is_fresh(sp, exports, fp, manual):
            res = EnvResolution(sp)
            res.exports = exports
            res.identified = True
            res.cached = True
            res.detected = ["(cache)"]
            return res
    res = resolve_env(sp)
    write_cache(sp, res, env_fingerprint(sp))
    return res


def detect_format(forced=None) -> str:
    """输出格式：posix(export) | cmd(set) | powershell($env:)。默认按平台。"""
    if forced in ("posix", "cmd", "powershell"):
        return forced
    return "cmd" if os.name == "nt" else "posix"


def fmt_exports(exports, fmt: str):
    """exports: [(name, value, kind)]；kind='path' 表示前置到现有 PATH。返回 shell 语句行。"""
    sep = ":" if fmt == "posix" else ";"
    old_path = {"posix": "$PATH", "cmd": "%PATH%", "powershell": "$env:PATH"}[fmt]
    out = []
    for name, value, kind in exports:
        if kind == "path":
            value = f"{value}{sep}{old_path}"
        if fmt == "posix":
            out.append(f"export {name}='{value}'")
        elif fmt == "cmd":
            out.append(f"set {name}={value}")
        else:
            out.append(f'$env:{name} = "{value}"')
    return out


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    positional = [a for a in argv if not a.startswith("--")]
    fmt_arg = None
    if "--format" in argv:
        i = argv.index("--format")
        if i + 1 < len(argv):
            fmt_arg = argv[i + 1]
    check_only = "--check" in argv
    arg = positional[0] if positional else "."
    fmt = detect_format(fmt_arg)

    service_dir = lib.resolve_service_dir(arg)
    if service_dir is None:
        # 光报「无法识别工程类型」会让人以为工程类型没探测对；其实参数压根没落到子工程上
        lib.c_fail(f"子工程不存在: {arg}（可写短名 `backend`、路径 `services/backend`，或绝对路径）")
        return 1

    warn = manual_override_lost_msg(service_dir)
    if warn:
        # stdout 会被用户 `eval` 进 shell，只能走 stderr —— 掺一句中文进去就是 shell 语法错误
        print("  ⚠️  " + warn, file=sys.stderr)

    res = resolve_env(service_dir)
    for ok, text in res.notes:
        print(("  ✅ " if ok else "  ❌ ") + text, file=sys.stderr)
    if not res.identified:
        print(f"  ❌ {res.service_dir.name}: 无法识别工程类型", file=sys.stderr)
        return 1
    if res.missing:
        for h in res.missing:
            print("    " + h, file=sys.stderr)
        return 1

    if not check_only:
        for line in fmt_exports(res.exports, fmt):
            print(line)
    # 缓存与输出格式无关：存的是数据行，三种 shell 语法由 --format 在输出层渲染
    wrote = write_cache(res.service_dir, res, env_fingerprint(res.service_dir))
    note = "（已写缓存）" if wrote else ("（人工覆盖，未覆盖缓存）" if has_manual_override(res.service_dir) else "")
    print(f"{res.service_dir.name}: {'、'.join(res.detected)} — ✅ 环境就绪 [format={fmt}]{note}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
