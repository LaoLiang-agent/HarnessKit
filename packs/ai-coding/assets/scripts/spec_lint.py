#!/usr/bin/env python3
"""
spec_lint.py — Spec 编号体系门禁

用法:
  python3 .harness/scripts/spec_lint.py          # 人读报告
  python3 .harness/scripts/spec_lint.py --json   # 机读 JSON
  python3 .harness/scripts/spec_lint.py --specs-dir <dir> [--json]   # 指定 specs 目录（spec_merge 门禁用）

退出码: 有 ERROR → 1，否则 0
"""

import sys, os, re, json, glob
from pathlib import Path
from collections import defaultdict

SCRIPT_DIR = Path(__file__).resolve().parent
SPECS_DIR = (SCRIPT_DIR / ".." / "specs").resolve()

# ── 解析 frontmatter ──────────────────────────────────────────────
RE_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# ── 码模式 ────────────────────────────────────────────────────────
RE_REQ   = re.compile(r"^###\s+Requirement:\s+.+\s+\(([A-Z]{2,6})-R-(\d+)\)", re.MULTILINE)
RE_SCEN  = re.compile(r"^####\s+Scenario:\s+.+\s+\(([A-Z]{2,6})-S-(\d+)\)", re.MULTILINE)
RE_TBD   = re.compile(r"TBD|TODO", re.IGNORECASE)

# ── 残留原始行（spec_merge 变换失配的指纹）──────────────────────────
# 背景：spec_merge 的块变换一旦失配，整行会**原样**落进 spec.md —— 没有 `#### Scenario:` / `### Requirement:`
# 头，本脚本既不计入 reqs/scens、id_max 也不重算，该条**静默消失**（实例：`thing/spec.md` 的 TH-S-084，
# 归档时被吞，直到本门禁上线才被看见）。spec.md 只允许规范形态，原始块形态一律 ERROR。
RE_RAW_SCEN = re.compile(r"^\s*\*{0,3}Scenario[:：]", re.MULTILINE)
RE_RAW_REQ  = re.compile(r"^\s*####\s+REQ-[A-Z]{2,6}-\d+", re.MULTILINE)

# ── 发现 spec 文件 ────────────────────────────────────────────────
def discover_specs(specs_dir=None):
    """发现 specs 目录下所有非 _ 前缀的 .md 文件，排除 _index.md _flows.md README.md。

    兼容两种布局：扁平 `specs/<domain>.md`（harness-kit 默认）与目录 `specs/<domain>/spec.md`（旧工程）。
    """
    if specs_dir is None:
        specs_dir = SPECS_DIR
    return [p for p in Path(specs_dir).glob("**/*.md")
            if not p.name.startswith("_") and p.name not in ("README.md", "spec-template.md")]

# ── 解析 single spec ──────────────────────────────────────────────
def parse_spec(filepath: Path, specs_dir=None):
    if specs_dir is None:
        specs_dir = SPECS_DIR
    text = filepath.read_text(encoding="utf-8")
    try:
        rel = str(filepath.resolve().relative_to(Path.cwd()))
    except ValueError:
        rel = str(filepath)

    fm = {}
    fm_match = RE_FRONTMATTER.match(text)
    if fm_match:
        try:
            import yaml
            fm = yaml.safe_load(fm_match.group(1)) or {}
        except (ImportError, Exception):
            # ImportError: yaml 未安装; 其他 Exception: YAML 数据格式错误
            # 均降级为空 frontmatter，由后续 prefix 检查报告具体问题
            fm = {}
    else:
        return {
            "path": rel,
            "name": filepath.stem,
            "domain": filepath.stem,
            "prefix": "",
            "frontmatter": fm,
            "reqs": [],
            "scens": [],
            "errors": [f"{rel}: 缺少 YAML frontmatter"],
            "warnings": [],
        }

    prefix     = fm.get("prefix", "")
    id_max_r   = fm.get("id_max_r", 0)
    id_max_s   = fm.get("id_max_s", 0)
    retired    = set(fm.get("retired") or [])
    domain     = fm.get("domain", filepath.stem)

    errors   = []
    warnings = []
    reqs     = []
    scens    = []

    # ── 扫描 Requirement ──────────────────────────────────────────
    for m in RE_REQ.finditer(text):
        r_prefix = m.group(1)
        r_num    = int(m.group(2))
        title    = m.group(0).strip()
        full_code = f"{r_prefix}-R-{r_num}"
        reqs.append({"code": full_code, "prefix": r_prefix, "num": r_num, "line": title})

        if prefix and r_prefix != prefix:
            errors.append(f"{rel}: {full_code} 前缀不符（码为 {r_prefix}，frontmatter prefix={prefix}）")
        if id_max_r and r_num > id_max_r:
            errors.append(f"{rel}: {full_code} 编号 {r_num} 超过 id_max_r={id_max_r}")
        if full_code in retired:
            errors.append(f"{rel}: {full_code} 为退役码，禁止复用")

        # 检查 SHALL
        body_start = m.end()
        next_section = re.search(r"\n###", text[body_start:])
        body = text[body_start: body_start + next_section.start()] if next_section else text[body_start:]
        if "SHALL" not in body:
            warnings.append(f"{rel}: {full_code} 缺少 SHALL 关键字")

    # ── 扫描 Scenario ─────────────────────────────────────────────
    for m in RE_SCEN.finditer(text):
        s_prefix = m.group(1)
        s_num    = int(m.group(2))
        title    = m.group(0).strip()
        full_code = f"{s_prefix}-S-{s_num}"
        scens.append({"code": full_code, "prefix": s_prefix, "num": s_num, "line": title})

        if prefix and s_prefix != prefix:
            errors.append(f"{rel}: {full_code} 前缀不符（码为 {s_prefix}，frontmatter prefix={prefix}）")
        if id_max_s and s_num > id_max_s:
            errors.append(f"{rel}: {full_code} 编号 {s_num} 超过 id_max_s={id_max_s}")
        if full_code in retired:
            errors.append(f"{rel}: {full_code} 为退役码，禁止复用")

    # ── 残留原始行检查（未被 spec_merge 变换掉的 §1 块形态）──────────
    for pat, want in ((RE_RAW_SCEN, "`#### Scenario: 标题 (PREFIX-S-n)`"),
                      (RE_RAW_REQ,  "`### Requirement: 标题 (PREFIX-R-n)`")):
        for m in pat.finditer(text):
            ln = text[:m.start()].count("\n") + 1
            errors.append(f"{rel}:{ln} 残留未转换的原始块头 `{m.group(0).strip()}`"
                          f" —— 本条不会被计入/编号，等于静默丢失；应写成 {want}")

    # ── TBD 检查 ──────────────────────────────────────────────────
    for m in RE_TBD.finditer(text):
        line = text[:m.start()].count("\n") + 1
        warnings.append(f"{rel}:{line} 包含 TBD/TODO 占位符")

    return {
        "path": rel,
        "name": filepath.stem,
        "domain": domain,
        "prefix": prefix,
        "frontmatter": fm,
        "reqs": reqs,
        "scens": scens,
        "errors": errors,
        "warnings": warnings,
    }

# ── 跨文件校验 ────────────────────────────────────────────────────
def cross_file_checks(specs, specs_dir=None):
    if specs_dir is None:
        specs_dir = SPECS_DIR
    errors = []
    warnings = []
    infos = []

    # 全局码去重
    all_codes = defaultdict(list)
    for s in specs:
        for r in s["reqs"]:
            all_codes[r["code"]].append(s["path"])
        for sc in s["scens"]:
            all_codes[sc["code"]].append(s["path"])

    for code, paths in all_codes.items():
        if len(paths) > 1:
            errors.append(f"重号: {code} 出现在 {' / '.join(paths)}")

    # _index.md 基本检查
    index_path = Path(specs_dir) / "_index.md"
    if index_path.exists():
        index_text = index_path.read_text(encoding="utf-8")
        # 检查每个有 prefix 的 spec 是否在 _index 中有对应行
        for s in specs:
            if s["prefix"] and s["prefix"] not in index_text:
                warnings.append(f"_index.md: 缺少 prefix={s['prefix']} ({s['name']}) 的索引行")

    return errors, warnings, infos

# ── 主入口 ────────────────────────────────────────────────────────
def lint(use_json=False, specs_dir=None):
    if specs_dir is None:
        specs_dir = SPECS_DIR
    spec_files = discover_specs(specs_dir)
    if not spec_files:
        result = {"errors": ["specs/ 下无 spec 文件"], "warnings": [], "infos": [], "files": 0}
        if use_json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print("● ERROR: specs/ 下无 spec 文件")
        return 1

    specs = [parse_spec(f, specs_dir) for f in spec_files]

    cross_errors, cross_warnings, cross_infos = cross_file_checks(specs, specs_dir)

    # 汇总
    all_errors   = []
    all_warnings = []
    all_infos    = list(cross_infos)

    for s in specs:
        all_errors.extend(s["errors"])
        all_warnings.extend(s["warnings"])
    all_errors.extend(cross_errors)
    all_warnings.extend(cross_warnings)

    if use_json:
        result = {
            "errors":   all_errors,
            "warnings": all_warnings,
            "infos":    all_infos,
            "files":    len(spec_files),
            "reqs":     sum(len(s["reqs"]) for s in specs),
            "scens":    sum(len(s["scens"]) for s in specs),
        }
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        file_count = len(spec_files)
        req_count  = sum(len(s["reqs"]) for s in specs)
        scen_count = sum(len(s["scens"]) for s in specs)
        print(f"spec_lint — {file_count} 文件, {req_count} Requirement, {scen_count} Scenario\n")

        for e in all_errors:
            print(f"● ERROR: {e}")
        for w in all_warnings:
            print(f"○ WARN:  {w}")
        for i in all_infos:
            print(f"○ INFO:  {i}")

        if not all_errors and not all_warnings and not all_infos:
            print("✓ 全部通过")

    return 1 if all_errors else 0


if __name__ == "__main__":
    json_flag = "--json" in sys.argv
    specs_dir = None
    if "--specs-dir" in sys.argv:
        i = sys.argv.index("--specs-dir")
        if i + 1 < len(sys.argv):
            specs_dir = sys.argv[i + 1]
    sys.exit(lint(use_json=json_flag, specs_dir=specs_dir))
