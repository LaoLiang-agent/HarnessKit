#!/usr/bin/env python3
"""update_board.py — 看板（.harness/tasks/board.md）唯一写入门禁。

纪律：PM/Worker **禁止直接编辑 board.md**，一律经本脚本更新（内核 updateBoard 只机械
更新「状态/上次活动」两列，且本脚本提供的校验它不做）。漂移教训见 DESIGN.md：
自由手写导致单元格混入 `|` 破列（15/16 列）、续接提示膨胀到 11 万字符。

列格式契约（7 列，顺序固定）：
  任务名      目录名同源，禁止含 `|`/空格
  状态        枚举：PENDING | IN_PROGRESS | CR_REVIEW_PENDING | AWAITING_ARCHIVE | DONE
  Profile     standard | quick | fix | refactor | 待裁决… | —
              （看板用短名 fix，对应 proposal 里的 bugfix；内核四档 standard/quick/bugfix/refactor）
  Profile     standard | quick | bugfix | fix | fix-full | fix-light | refactor | 待裁决… | —
              （fix 三态：bugfix=全流程（有 proposal.md）；fix-full/fix-light=直通（质量门起步），
               full 走 CR→TE，light 跳过 CR/TE；fix=直通裁决未定的过渡态，质量门裁决后必须
               改写为 fix-full 或 fix-light）
  Apply进度   — | 已归档 | R<n>：<阶段链>（v4：链必须**完整等于**该 profile 的固定流程，
              不许省略阶段；跳过用 — 标记表达）
              固定流程模板（每阶段必须有标记）：
                standard/quick/bugfix：propose 审批1 Dev CR TE 审批2 验证
                refactor：            影响面 propose 审批1 Dev CR TE 审批2 验证
                fix/fix-full/fix-light（直通）：质量门 Dev CR TE 验证
              每阶段后缀：✅完成 ▶当前(至多一个) …待做 ⛔阻塞(即当前卡点) —跳过
              顺序约束：▶/⛔ 之前不许有 …（前序阶段须先标 ✅ 或 —）
              ✅ 须连续在链首；— 仅 fix-light 的 CR/TE 允许；
              例：R2：propose✅ 审批1✅ Dev▶ CR… TE… 审批2… 验证…
                  R1：质量门✅ Dev✅ CR— TE— 验证▶（fix-light）
  分支        分支名（可带 `(子工程)` 标注，逗号分隔多个）或 —
  上次活动    YYYY-MM-DD HH:mm（本脚本自动写当前时间，勿手填）
  续接提示    ≤300 字符一句话：「卡在X，下一步Y」；依赖前缀 [等 <任务>]；禁 `|`/换行

用法：
  update_board.py <task> [--status S] [--profile P] [--apply A] [--branch B] [--hint H]
  update_board.py --check                 校验整个看板（doctor 用），违规非零退出
  update_board.py --repair [--write]      规范化存量行（默认 dry-run 打印 diff）
"""
import argparse
import re
import sys
import time
from pathlib import Path

STATUSES = ["PENDING", "IN_PROGRESS", "CR_REVIEW_PENDING", "AWAITING_ARCHIVE", "DONE"]
# 每 profile 的固定流程模板（v4.1，2026-11-12）：已定档任务的 Apply 链必须完整等于模板
# （不许省略阶段，跳过用 — 标记）。profile 自描述三态：bugfix=全流程（同 standard 模板）；
# fix-full/fix-light=直通模板 FIX_DIRECT（light 的 CR/TE 标 —）；fix=直通裁决未定过渡态。
PROFILE_STAGES = {
    "standard": ["propose", "审批1", "Dev", "CR", "TE", "审批2", "验证"],
    "quick": ["propose", "审批1", "Dev", "CR", "TE", "审批2", "验证"],
    "bugfix": ["propose", "审批1", "Dev", "CR", "TE", "审批2", "验证"],
    "refactor": ["影响面", "propose", "审批1", "Dev", "CR", "TE", "审批2", "验证"],
}
FIX_DIRECT = ["质量门", "Dev", "CR", "TE", "验证"]  # fix 直通模板；仅 fix-light 允许 CR/TE 标 —
# 未定档（—/待裁决…）时的并集顺序
STAGE_ORDER = ["影响面", "propose", "审批1", "质量门", "Dev", "CR", "TE", "审批2", "验证"]
STAGES = STAGE_ORDER  # 兼容旧引用
MARKS = ["✅", "▶", "…", "⛔", "—"]  # ✅完成 ▶当前(至多一个) …待做 ⛔阻塞(即当前卡点) —不适用/跳过
APPLY_RE = re.compile(
    r"^(—|已归档|R\d+[:：](" + "|".join(STAGE_ORDER) + r")[" + "".join(MARKS) + r"]"
    r"( (" + "|".join(STAGE_ORDER) + r")[" + "".join(MARKS) + r"])*)$"
)
PROFILE_RE = re.compile(r"^(standard|quick|bugfix|fix|fix-full|fix-light|refactor|—|待裁决.*)$")


def profile_template(profile: str, root: Path = None, task: str = None):
    """该 profile 的固定看板链模板（完整序列，不许省略；跳过用 — 标记表达）。

    profile 自描述：bugfix 同 standard 模板；fix/fix-full/fix-light 均直通模板
    （fix 为裁决未定过渡态）。未定档（—/待裁决）→ None（调用方走宽松子序列校验）。
    root/task 参数保留仅为签名兼容。
    """
    if profile in ("standard", "quick", "bugfix"):
        return PROFILE_STAGES["standard"]
    if profile == "refactor":
        return PROFILE_STAGES["refactor"]
    if profile in ("fix", "fix-full", "fix-light"):
        return FIX_DIRECT
    return None


def infer_fix_profile(root: Path, task: str) -> str:
    """遗留 fix 看板值三态消解（repair 用）：有 proposal.md → bugfix；
    bugfix.md 质量门裁决含 --full → fix-full、含 轻量 → fix-light；否则保持 fix（待裁决）。"""
    base = Path(root) / ".harness" / "deliverables"
    for d in (base / task, base / "_archive" / task):
        if (d / "proposal.md").is_file():
            return "bugfix"
    for d in (base / task, base / "_archive" / task):
        bf = d / "bugfix.md"
        if bf.is_file():
            text = bf.read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(r"裁决[^\n]*", text):
                seg = m.group(0)
                if "--full" in seg:
                    return "fix-full"
                if "轻量" in seg:
                    return "fix-light"
    return "fix"


def parse_chain(apply: str):
    """解析 Apply进度 → (round, [(stage, mark), ...])；非链式返回 None。"""
    m = re.match(r"^R(\d+)[:：](.+)$", apply)
    if not m:
        return None
    tokens = m.group(2).split()
    chain = []
    for tok in tokens:
        if len(tok) < 2 or tok[-1] not in MARKS:
            return None
        chain.append((tok[:-1], tok[-1]))
    return int(m.group(1)), chain


def chain_problems(chain, profile: str, root: Path = None, task: str = None):
    """链语义校验 v4：已定档 profile 的链必须**完整等于固定流程模板**（省略阶段即违规，
    跳过用 — 标记）；— 仅 fix 直通模板的 CR/TE 允许（轻量裁决）。
    通用约束：✅ 单调在链首、▶/⛔ 至多一个、▶/⛔ 之前不许有 …（前序须先 ✅ 或 —）。
    未定档（—/待裁决）保持子序列宽松校验。"""
    template = profile_template(profile, root, task)
    seen_current, seen_gap, seen_todo = False, False, False
    for stage, mark in chain:
        if mark in ("▶", "⛔"):
            if seen_current:
                return ["▶/⛔ 当前标记至多一个"]
            if seen_todo:
                return ["▶/⛔ 不能出现在 … 待做阶段之后（前序阶段须先标 ✅ 或 —）"]
            seen_current = True
        if mark == "…":
            seen_todo = True
        if mark in ("…", "▶", "⛔"):
            seen_gap = True
        elif mark == "✅" and seen_gap:
            return ["✅ 只能出现在未开始阶段之前（已完成阶段应连续在链首，— 跳过不限位置）"]
    if template is None:
        # 未定档/无法消解：宽松子序列校验（阶段属于并集、顺序递增不重复）
        order = {s: i for i, s in enumerate(STAGE_ORDER)}
        idxs = []
        for stage, _ in chain:
            if stage not in order:
                return [f"阶段 {stage!r} 非法（可选 {'/'.join(STAGE_ORDER)}）"]
            idxs.append(order[stage])
        if idxs != sorted(idxs) or len(set(idxs)) != len(idxs):
            return ["阶段顺序不符合流程先后（" + "→".join(STAGE_ORDER) + "）"]
        return []
    stages = [s for s, _ in chain]
    if stages != template:
        return [
            f"链必须完整覆盖 {profile} 固定流程（{' → '.join(template)}）；"
            f"当前为 {' → '.join(stages) or '（空）'}，缺省阶段不许省略，跳过请标 —"
        ]
    skippable = {"CR", "TE"} if profile == "fix-light" else set()
    for stage, mark in chain:
        if mark == "—" and stage not in skippable:
            return [f"{stage} 不允许标 —（仅 fix-light 轻量裁决可跳过 CR/TE）"]
    return []
HINT_MAX = 300

TEMPLATE = """# 任务看板

> **状态机**：PENDING → IN_PROGRESS → CR_REVIEW_PENDING → IN_PROGRESS → AWAITING_ARCHIVE → DONE →（重开轮次）→ PENDING
> **Apply 子步骤**：按 profile 的完整流程记录于「Apply进度」列（▶=当前阶段；格式契约见脚本 docstring）
> **续接机制**：任何人读看板 + deliverables 即可接手继续

| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |
|--------|------|---------|-----------|------|---------|----------|

> **写入纪律**：禁止直接编辑本文件，一律 `python3 .harness/scripts/update_board.py <任务> [--status …] [--apply …] [--branch …] [--hint …]`（格式契约见脚本 docstring；续接提示 ≤300 字符一句话「卡在X，下一步Y」，依赖前缀 [等 任务名]）。
"""


def board_path(root: Path) -> Path:
    return root / ".harness" / "tasks" / "board.md"


def now_stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


def sanitize_cell(text: str) -> str:
    """单元格消毒：去 `**`、`|`→`/`、换行→空格、折叠空白。"""
    t = (text or "").replace("**", "").replace("|", "/")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def parse_row(line: str):
    """解析数据行为 7 格：超列时溢出并入「续接提示」（管道符只可能从自由文本混入）。"""
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) > 7:
        cells = cells[:6] + [" / ".join(cells[6:])]
    while len(cells) < 7:
        cells.append("—")
    return cells


def render_row(cells) -> str:
    return "| " + " | ".join(cells) + " |"


def read_rows(text: str):
    """返回 (lines, rows)：rows 为 (行号, cells) 列表，跳过表头/分隔线。"""
    lines = text.splitlines()
    rows = []
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        head = cells[0] if cells else ""
        if head == "任务名" or (head and not head.strip("-: ")):
            continue
        rows.append((i, parse_row(line)))
    return lines, rows


def validate(cells, root: Path = None):
    """校验一行 7 格，返回违规信息列表（空 = 合规）。root 用于 fix 模板二义消解。"""
    problems = []
    name, status, profile, apply, branch, date, hint = cells
    if "|" in name or not name or " " in name:
        problems.append(f"任务名非法：{name!r}")
    if status not in STATUSES:
        problems.append(f"状态非枚举：{status!r}（可选 {'/'.join(STATUSES)}）")
    if not PROFILE_RE.match(profile):
        problems.append(f"Profile 非法：{profile!r}（可选 standard/quick/bugfix/fix/fix-full/fix-light/refactor/待裁决…/—）")
    if not APPLY_RE.match(apply):
        problems.append(f"Apply进度 不合语法：{apply!r}（应为 —｜已归档｜R<n>：阶段链，阶段 {'/'.join(STAGE_ORDER)} + 标记 {'/'.join(MARKS)}）")
    else:
        parsed = parse_chain(apply)
        if parsed:
            _, chain = parsed
            problems.extend(chain_problems(chain, profile, root, name))
    if not re.match(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$", date):
        problems.append(f"上次活动格式非法：{date!r}（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）")
    if len(hint) > HINT_MAX:
        problems.append(f"续接提示超长：{len(hint)} 字符（上限 {HINT_MAX}）")
    return problems


def normalize_chain(root: Path, task: str, profile: str, status: str, apply: str):
    """把 Apply 链规范化为该 profile 固定流程模板（repair 用），返回 (round, [(stage, mark)]) 或 None。

    标记推导：旧链已有的阶段沿用标记；缺失阶段按位置补齐——在最早有进展（✅/▶/⛔）阶段
    之前 → ✅（已过），之后 → …（未做）；AWAITING_ARCHIVE 视为全程完成，缺失一律 ✅。
    非法 —（非 fix-light 的 CR/TE）按同规则重推导。apply=—（未开始）→ 全 … 链 R1。
    """
    template = profile_template(profile, root, task)
    if template is None or status == "DONE" or apply == "已归档":
        return None
    parsed = parse_chain(apply)
    if apply != "—" and not parsed:
        return None  # 非法格式不猜，留给人工
    old = dict(parsed[1]) if parsed else {}
    rn = parsed[0] if parsed else 1
    tpos = {s: i for i, s in enumerate(template)}
    first_prog = None
    for s, mk in (parsed[1] if parsed else []):
        if s in tpos and mk in ("✅", "▶", "⛔") and (first_prog is None or tpos[s] < first_prog):
            first_prog = tpos[s]
    out = []
    for idx, stage in enumerate(template):
        mk = old.get(stage)
        skip_ok = profile == "fix-light" and stage in ("CR", "TE")
        if mk is None or (mk == "—" and not skip_ok):
            if status == "AWAITING_ARCHIVE":
                mk = "✅"
            else:
                mk = "✅" if (first_prog is not None and idx < first_prog) else "…"
        out.append((stage, mk))
    return rn, out


def cmd_update(root: Path, args) -> int:
    task = args.task
    if not task or "|" in task or " " in task:
        print(f"❌ 任务名非法：{task!r}")
        return 2
    board = board_path(root)
    if not board.is_file():
        board.parent.mkdir(parents=True, exist_ok=True)
        board.write_text(TEMPLATE, encoding="utf-8")
    lines, rows = read_rows(board.read_text(encoding="utf-8"))

    updates = {}
    if args.status is not None:
        if args.status not in STATUSES:
            print(f"❌ --status 非枚举：{args.status!r}（可选 {'/'.join(STATUSES)}）")
            return 2
        updates[1] = args.status
    if args.profile is not None:
        if not PROFILE_RE.match(args.profile):
            print(f"❌ --profile 非法：{args.profile!r}")
            return 2
        updates[2] = args.profile
    if args.apply is not None:
        # 半角冒号归一为全角（契约展示形）
        m = re.match(r"^(R\d+):", args.apply)
        normalized = ("R" + args.apply[1:].replace(":", "：", 1)) if m else args.apply
        if not APPLY_RE.match(normalized):
            print(f"❌ --apply 不合语法：{args.apply!r}")
            print(f"   应为 —｜已归档｜R<n>：阶段链（阶段 {'/'.join(STAGE_ORDER)}，标记 {'/'.join(MARKS)}）")
            print("   例：R2:propose✅ 审批1✅ Dev▶ CR… ；fix 直通：R1:质量门✅ Dev✅ CR— TE— 验证▶")
            return 2
        # 语义校验需结合行内 profile：先取现值（待写入时再用行值复核）
        updates[3] = normalized
    if args.branch is not None:
        updates[4] = sanitize_cell(args.branch) or "—"
    if args.hint is not None:
        h = sanitize_cell(args.hint) or "—"
        if len(h) > HINT_MAX:
            print(f"⚠️ 续接提示 {len(h)} 字符，超限截断至 {HINT_MAX}：详情请放 deliverables，看板只写「卡在X，下一步Y」")
            h = h[:HINT_MAX]
        updates[6] = h

    # 时间戳：默认现在；--at 回填（仅日期补 00:00，契约分钟级精度）
    stamp = now_stamp()
    if args.at is not None:
        a = args.at.strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", a):
            a += " 00:00"
        if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", a):
            print(f"❌ --at 非法：{args.at!r}（应为 YYYY-MM-DD[ HH:mm]）")
            return 2
        stamp = a

    hit = None
    dup = 0
    for i, cells in rows:
        if cells[0] == task:
            if hit is None:
                hit = (i, cells)
            else:
                dup += 1
    if dup:
        print(f"❌ 任务 {task!r} 在看板中有 {dup + 1} 行（契约：一任务一行）。")
        print("   先运行 --repair --write 合并重复行，再重试")
        return 2
    if hit:
        i, cells = hit
        for idx, val in updates.items():
            cells[idx] = val
    else:
        cells = [task, "—", "—", "—", "—", stamp, "—"]
        for idx, val in updates.items():
            cells[idx] = val
    # Apply 链语义复核（结合行内 profile 与 fix 二义消解；新行/老行都校验）
    parsed = parse_chain(cells[3])
    if parsed:
        probs = chain_problems(parsed[1], cells[2], root, task)
        if probs:
            print(f"❌ Apply 链语义违规：{probs[0]}")
            return 2
    if hit:
        cells[5] = stamp
        lines[i] = render_row(cells)
    else:
        # 新行插到表格末尾（最后一个表格行之后），不能盲 append——
        # 文件尾部有「写入纪律」引用块，追加会把行落到表格外。
        new_row = render_row(cells)
        last_row = max((i for i, ln in enumerate(lines) if ln.startswith("|")), default=-1)
        if last_row >= 0:
            lines.insert(last_row + 1, new_row)
        else:
            lines.append(new_row)
    board.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"✅ 看板已更新：{task}（{', '.join(f'列{idx}' for idx in sorted(updates)) or '仅活动时间'}）")
    return 0


def cmd_check(root: Path) -> int:
    board = board_path(root)
    if not board.is_file():
        print("ℹ️ 无 board.md，跳过")
        return 0
    _, rows = read_rows(board.read_text(encoding="utf-8"))
    bad = 0
    seen = {}
    for i, cells in rows:
        if cells[0] in seen:
            print(f"❌ 行{i + 1} [{cells[0]}] 任务名重复（首见于行{seen[cells[0]] + 1}，契约：一任务一行）")
            bad += 1
        else:
            seen[cells[0]] = i
        problems = validate(cells, root)
        for p in problems:
            print(f"❌ 行{i + 1} [{cells[0]}] {p}")
            bad += 1
    if bad:
        print(f"看板体检 FAIL：{bad} 处违规。修复：python3 .harness/scripts/update_board.py --repair --write")
        return 1
    print(f"✅ 看板体检 PASS（{len(rows)} 行全合规）")
    return 0


def cmd_repair(root: Path, write: bool) -> int:
    """规范化存量行：破列合并、状态提纯、Profile 映射、超长截断、DONE→已归档。"""
    board = board_path(root)
    if not board.is_file():
        print("ℹ️ 无 board.md，跳过")
        return 0
    lines, rows = read_rows(board.read_text(encoding="utf-8"))
    changed = 0
    # 旧 4 列看板迁移（任务|状态|负责|更新）：先换成 7 列表头，再把旧列映射到新列。
    # 负责人没有对应列，保留到「续接提示」里，避免修复时丢信息。
    CANON_HEADER = "| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |"
    CANON_SEP = "|--------|------|---------|-----------|------|---------|----------|"
    legacy = False
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            legacy = False
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells:
            continue
        if not legacy and cells[0] in ("任务", "任务名") and len(cells) == 4:
            legacy = True
            lines[i] = CANON_HEADER
            changed += 1
            continue
        if legacy:
            if cells and not cells[0].strip("-: "):
                lines[i] = CANON_SEP
                changed += 1
                continue
            if len(cells) >= 4:
                task, status, owner, updated = cells[0], cells[1], cells[2], cells[3]
                hint = f"旧负责人：{owner}" if owner and owner != "—" else "—"
                lines[i] = render_row([task, status, "—", "—", "—", updated, hint])
                changed += 1
    if changed:
        # 让后续 repair 读取迁移后的行
        lines, rows = read_rows("\n".join(lines))
    # 表头/分隔线规范化（曾有 Agent 用空格把单元格撑到 3.8 万字符）
    CANON = {
        "header": "| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |",
        "sep": "|--------|------|---------|-----------|------|---------|----------|",
    }
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        head = cells[0] if cells else ""
        canon = CANON["header"] if head == "任务名" else (CANON["sep"] if head and not head.strip("-: ") else None)
        if canon and line != canon:
            print(f"── 行{i + 1} 表头/分隔线规范化（{len(line)} → {len(canon)} 字符）")
            if write:
                lines[i] = canon
            changed += 1
    # 重复任务行合并：契约一任务一行。DONE 是终态快照 → 优先保留最后一个非 DONE 行；全 DONE 则保留最后一行
    by_name = {}
    for i, cells in rows:
        by_name.setdefault(cells[0], []).append(i)
    drop = set()
    row_map = dict(rows)
    for name, idxs in by_name.items():
        if len(idxs) < 2:
            continue
        keep = next((i for i in reversed(idxs) if row_map[i][1] != "DONE"), idxs[-1])
        for i in idxs:
            if i != keep:
                drop.add(i)
                print(f"── 行{i + 1} [{name}] 重复行删除（保留行{keep + 1}）")
                changed += 1
    if drop:
        rows = [(i, c) for i, c in rows if i not in drop]
    for i, cells in rows:
        before = list(cells)
        # 状态提纯：提取前缀枚举，括注信息并入续接提示（若提示为占位符）
        m = re.match(r"^(PENDING|IN_PROGRESS|CR_REVIEW_PENDING|AWAITING_ARCHIVE|DONE)\s*[（(]?(.*?)[）)]?$", cells[1])
        if m:
            cells[1] = m.group(1)
            extra = sanitize_cell(m.group(2))
            if extra and cells[6] in ("—", ""):
                cells[6] = extra
        # Profile 归一：大小写归一，非法值→—；遗留 fix 短名三态消解（proposal.md/质量门裁决）
        low = cells[2].lower()
        if low in ("standard", "quick", "bugfix", "fix", "fix-full", "fix-light", "refactor"):
            cells[2] = low
        elif not PROFILE_RE.match(cells[2]):
            cells[2] = "—"
        if cells[2] == "fix":
            cells[2] = infer_fix_profile(root, cells[0])
        # DONE 行 Apply进度规范形
        if cells[1] == "DONE" and not APPLY_RE.match(cells[3]):
            cells[3] = "已归档"
        # 链规范化 v4：已定档 profile 的链必须完整等于固定流程模板（缺省补齐、非法 — 重推导）
        norm = normalize_chain(root, cells[0], cells[2], cells[1], cells[3])
        if norm:
            rn, nchain = norm
            new_apply = f"R{rn}：" + " ".join(s + mk for s, mk in nchain)
            if new_apply != cells[3]:
                cells[3] = new_apply
        # ▶ 当前标记推导：实施中任务且链上无 ▶/⛔ 时，首个待做(…)阶段即当前
        if cells[1] in ("IN_PROGRESS", "CR_REVIEW_PENDING"):
            parsed = parse_chain(cells[3])
            if parsed and not any(mk in ("▶", "⛔") for _, mk in parsed[1]):
                rn, marked, new_chain = parsed[0], False, []
                for s, mk in parsed[1]:
                    if not marked and mk == "…":
                        mk, marked = "▶", True
                    new_chain.append((s, mk))
                if marked:
                    cells[3] = f"R{rn}：" + " ".join(s + mk for s, mk in new_chain)
        # 自由文本列消毒 + 截断
        for idx in (3, 4, 6):
            cells[idx] = sanitize_cell(cells[idx]) or "—"
        if len(cells[6]) > HINT_MAX:
            cells[6] = cells[6][:HINT_MAX]
        if not re.match(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$", cells[5]):
            cells[5] = cells[5][:16] if re.match(r"^\d{4}-\d{2}-\d{2}", cells[5]) else "—"
        if cells != before:
            changed += 1
            print(f"── 行{i + 1} [{cells[0]}]")
            for idx, (a, b) in enumerate(zip(before, cells)):
                if a != b:
                    show_a = a[:60] + ("…" if len(a) > 60 else "")
                    print(f"   列{idx}: {show_a}  →  {b}")
        # 内容合规但行文本带冗余填充（空格撑宽）时也重渲染
        if write and lines[i] != render_row(cells):
            lines[i] = render_row(cells)
    print(f"{'已修复' if write else 'dry-run：将修复'} {changed}/{len(rows)} 行" + ("" if write else "（加 --write 落盘）"))
    if write and changed:
        if drop:
            lines = [line for i, line in enumerate(lines) if i not in drop]
        board.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="看板唯一写入门禁（格式契约见模块 docstring）")
    ap.add_argument("task", nargs="?", help="任务名")
    ap.add_argument("--status")
    ap.add_argument("--profile")
    ap.add_argument("--apply")
    ap.add_argument("--branch")
    ap.add_argument("--hint")
    ap.add_argument("--at", help="覆盖上次活动时间戳（YYYY-MM-DD[ HH:mm]，仅日期补 00:00）；默认当前时间")
    ap.add_argument("--check", action="store_true", help="校验整个看板")
    ap.add_argument("--repair", action="store_true", help="规范化存量行（默认 dry-run）")
    ap.add_argument("--write", action="store_true", help="配合 --repair 落盘")
    args = ap.parse_args()
    root = Path.cwd()

    if args.check:
        return cmd_check(root)
    if args.repair:
        return cmd_repair(root, args.write)
    if not args.task:
        ap.error("缺少任务名（或用 --check / --repair）")
    return cmd_update(root, args)


if __name__ == "__main__":
    sys.exit(main())
