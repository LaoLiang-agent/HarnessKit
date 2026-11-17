#!/usr/bin/env python3
# .harness/scripts/check_codegraph.py
# 检查子工程 CodeGraph 索引是否存在且最新。
# 用法: check_codegraph.py <子工程路径> | --all | --sync <路径> | --sync --all
# 退出码: 0=OK, 1=STALE, 2=MISSING, 3=ERROR（--sync 时为**同步后**的状态）
# codegraph 未安装时自动 npm 安装（lib.ensure_codegraph），失败则干净报错而非 traceback。
import json
import sys
from pathlib import Path
import lib

ROOT = lib.repo_root()


def _pending_from_status(sp: Path):
    """`codegraph status --json` → (pending 总数, mismatch, 明细) ；取不到返回 None。

    **这是权威判据**：codegraph 的 `sync` 就是照 `pendingChanges` 决定要不要干活。
    实测口径（scratch 工程）：改一个源文件 → `modified:1`；新增 → `added:1`；
    只改 `.gitignore`/`.harness/build.json` 这类**非索引文件** → 全 0。
    旧判据（最后一次提交时间 vs 索引 mtime）不看**文件内容**，于是「只改了 build.json 的提交」
    会把索引判成过时 —— 而 `codegraph sync` 回「Already up to date」，人反复做无用同步。
    """
    exe = lib.codegraph_path()
    if not exe:
        return None
    r = lib.run([exe, "status", str(sp), "--json"])
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    pend = data.get("pendingChanges")
    if not isinstance(pend, dict):
        return None   # 该版本不自评新鲜度 → 交给降级分支
    counts = {k: int(pend.get(k) or 0) for k in ("added", "modified", "removed")}
    return sum(counts.values()), data.get("worktreeMismatch"), counts


def freshness(sp: Path):
    """**全仓唯一**的 CodeGraph 新鲜度判据。返回 (state, detail)。

    state ∈ {"missing"（无 .codegraph/）/ "broken"（有目录无索引文件）/
             "stale"（索引落后于工作区）/ "fresh" / "unknown"（取不到自评，不判定）}

    detail 为人读说明（stale 时含新增/修改/删除计数），fresh 时为空串。

    **已知盲区（实测）**：`pendingChanges` 不覆盖**删除 / 重命名** —— 删掉一个源文件后
    它仍报 `{added:0, modified:0, removed:0}`，幽灵符号留在索引里（`fileCount` 不回落），
    只有真跑一次 `codegraph sync` 才输出 `Removed: 1` 清掉。故本函数只可用于**提示与
    入口判据**，不可用来决定「要不要同步」—— 同步一律无条件执行
    （`check_codegraph.py --sync` / `dev_gate.sync_codegraph`）。

    调用方一律走这里，不得自行发明判据 —— 历史教训：`pre_edit.py` 曾用「最后一次提交
    时间 vs 索引 mtime」判过时并**硬拦编辑**，而该判据已在 `_pending_from_status` 的
    注释里被明文废弃：它不看文件内容，于是**双向都错** ——
      · 漏报：改了文件但没提交 ⇒ 提交时间未变 ⇒ 判「新鲜」，而查询会返回过期结果；
      · 误报：一提交 ⇒ 提交时间跳到索引之后 ⇒ 判「过时」并拦死编辑，
        而 Dev 的正常节奏恰恰是「commit 后接着改」。
    """
    cg = sp / ".codegraph"
    if not cg.is_dir():
        return "missing", ""
    # 索引文件名随 codegraph 版本演变：db.sqlite（旧）/ index.sqlite / codegraph.db（v1.x 现行）
    db = None
    for name in ("codegraph.db", "db.sqlite", "index.sqlite"):
        candidate = cg / name
        if candidate.is_file():
            db = candidate
            break
    if db is None:
        return "broken", ""

    st = _pending_from_status(sp)
    if st is None:
        # 拿不到 codegraph 的自评新鲜度：索引损坏（实测 `codegraph status` 会 exit 1
        # "no such table: unresolved_refs"）或 codegraph 版本过旧（无 --json / 无 pendingChanges）。
        # 退回「提交时间 vs 索引 mtime」是已知误报源（实测：只改 .gitignore/build.json
        # 的提交被判过时，而 `codegraph sync` 报 Already up to date），故不据此下任何结论。
        # **但这不等于 OK**：读不出状态就无法保证索引可用，查询可能命中失效符号。
        # 调用方（check_one / preflight）一律按失败处置。
        return "unknown", "无法取得 codegraph 自评状态（索引损坏或 codegraph 版本过旧）"
    pending, mismatch, counts = st
    if pending:
        detail = (f"待同步：新增 {counts['added']} / 修改 {counts['modified']} / 删除 {counts['removed']}"
                  + (f"；worktree 不一致 {mismatch}" if mismatch else ""))
        return "stale", detail
    return "fresh", ""


def check_services(root: Path = None) -> list:
    """对 services/ 下全部子工程做权威新鲜度检查。返回 [(name, sp, state, detail)]。"""
    root = root or ROOT
    return [(name, sp) + freshness(sp) for name, sp in lib.discover_service_dirs(root)]


def check_one(sp: Path):
    """返回 (exit_code, msg)。exit_code: 0=OK / 1=STALE / 2=MISSING / 3=ERROR"""
    state, detail = freshness(sp)
    if state == "missing":
        return 2, f"{sp.name}: .codegraph/ 不存在（remediate: codegraph init {sp}）"
    if state == "broken":
        return 3, f"{sp.name}: .codegraph/ 存在但未找到索引文件"
    if state == "stale":
        return 1, f"{sp.name}: .codegraph/ 索引过时（{detail}；remediate: codegraph sync {sp}）"
    if state == "fresh":
        return 0, f"{sp.name}: .codegraph/ 已是最新"
    # unknown：**不是 OK**（旧实现返回 0「按存在处理」，等于把损坏的索引判成通过）。
    # 修复手段也不是 --sync —— 实测：`codegraph sync` 对损坏索引 exit 1（Failed to sync），
    # `codegraph init` 见到 .codegraph/ 已存在就直接跳过、同样修不好；只有**删掉重建**才行。
    # 故修复指示必须指向删除重建，指向 --sync 会让流程在「FAIL → sync → 仍 FAIL」间空转。
    return 3, (f"{sp.name}: 索引无法判定（{detail}）"
               f"—— remediate: 删除 {sp}/.codegraph 后 codegraph init {sp}")


def ensure_gitignore(sp: Path):
    gi = sp / ".gitignore"
    content = gi.read_text(encoding="utf-8") if gi.is_file() else ""
    if ".codegraph/" not in content:
        gi.write_text(content.rstrip() + "\n.codegraph/\n", encoding="utf-8")
        print(f"  ➕ {gi} 已添加 .codegraph/")


def sync_one(sp: Path):
    ensure_gitignore(sp)
    # 「→ 需执行」前缀不能省：此前直接打印命令本体，与真正的执行输出并排，
    # 读起来像「已经跑过了」。加前缀后一眼可分「待执行」与「已执行」。
    if not (sp / ".codegraph").is_dir():
        print(f"  → 需执行: codegraph init {sp}")
        lib.run(["codegraph", "init", str(sp)])
    else:
        print(f"  → 需执行: codegraph sync {sp}")
        lib.run(["codegraph", "sync", str(sp)])


def main():
    argv = sys.argv[1:]
    sync_mode = False
    if argv and argv[0] == "--sync":
        sync_mode = True
        argv = argv[1:]

    ok_cg, cg_msg = lib.ensure_codegraph()
    if not ok_cg:
        print(cg_msg)
        return 3

    if not argv or argv[0] == "--all":
        exit_code, stale, missing = 0, [], []
        all_dirs = lib.discover_service_dirs(ROOT)
        for _, sp in all_dirs:
            code, msg = check_one(sp)
            print(msg)
            if code == 1:
                stale.append(sp)
            elif code == 2:
                missing.append(sp)
            elif code == 3:
                exit_code = 3
        if sync_mode:
            # **无条件** sync 全部子工程，而不是只 sync missing+stale：
            # freshness() 的判据 pendingChanges **不覆盖删除/重命名** —— 实测删掉一个源文件后
            # 它仍报 {added:0, modified:0, removed:0}，幽灵符号留在索引里，只有真跑 sync 才会
            # 输出 `Removed: 1` 清掉。只 sync「判为过时」的那些 ⇒ 删除永远追不平。
            # 代价可忽略（实测空改动下 backend 0.69s / frontend 0.44s）。
            targets = [sp for _, sp in all_dirs]
            for sp in targets:
                sync_one(sp)
            # 同步后必须重新取证：退出码要反映**同步后**的状态。沿用同步前的 missing/stale
            # 会让「索引已成功建好」仍返回 2，调用方（/harness-init、/harness-apply）把一个
            # 已完成的步骤判成失败。
            missing, stale = [], []
            for sp in targets:
                code, _ = check_one(sp)
                if code == 1:
                    stale.append(sp)
                elif code == 2:
                    missing.append(sp)
                elif code == 3:
                    exit_code = 3
            if missing or stale:
                print(f"\n⚠ 同步后仍有 {len(missing)} 个子工程缺失 / {len(stale)} 个过时")
            elif exit_code == 3:
                # 不能报「全部已同步」：这些子工程的索引读都读不出来，sync 也修不了
                print("\n⚠ 部分子工程的索引无法判定（损坏或版本不兼容）—— `codegraph sync` 修不了；"
                      "需删除该子工程的 .codegraph/ 后重跑 codegraph init")
            else:
                print(f"{lib._color()['green']}✅{lib._color()['nc']} CodeGraph 全部已同步")
        else:
            if missing or stale:
                print("\n提示: 运行 check_codegraph.py --sync --all 自动更新")
        if missing:
            return 2
        if stale:
            return 1
        return exit_code

    # 单个
    sp = ROOT / "services" / argv[0].rstrip("/") if not Path(argv[0]).is_dir() else Path(argv[0])
    if not sp.is_dir():
        print(f"错误: 子工程路径不存在: {argv[0]}")
        return 3
    code, msg = check_one(sp)
    print(msg)
    if sync_mode:
        # 同样无条件：见上面 --all 分支，pendingChanges 不覆盖删除
        sync_one(sp)
        code, msg = check_one(sp)   # 同步后重新取证，退出码反映同步后的真实状态
        print(msg)
    return code


if __name__ == "__main__":
    sys.exit(main())
