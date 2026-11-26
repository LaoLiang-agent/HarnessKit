// 任务级并行开发：池化 git worktree 工作区管理（v2）。
//
// 设计（2026-11-14 与人定稿）：
//   - 单任务场景：保持原模式——直接在主工作树（services/<仓>）上开发，零迁移成本；
//   - 多任务场景：主工作树被占用（checkout 着别的任务的开发分支）时，分配池化 slot
//     `.worktrees/<仓>/slot-N/`（长期复用的通用工作区，不带任务名）；
//   - N 只有在第 N+1 个任务并发时才创建（2 并发 → slot-1，3 并发 → slot-2，依此）；
//   - 任务结束（归档）不删 worktree：slot 停在基线提交即「释放」，构建/依赖缓存保持热态；
//   - 台账是本机状态不进资产 git（.gitignore 排除 + 摘除追踪）：分配落点属于本机资源，
//     别人的任务占的是他自己机器的主工作树，不应出现在我的台账里挡我的路（2026-11-14 定）；
//   - 主树脏基线不是静默拒绝而是决策点：提示处理改动，或用户明确选 --slot 隔离开发。
//   - 分配粒度是「每仓」：backend 忙只影响 backend，frontend 空闲的新任务直接用主工作树；
//   - 卫生纪律：分配给新任务前 slot 必须干净（git status 空），脏 slot 拒绝分配并给清理指引
//     （不自动 stash——残留可能是有价值的工作，由人裁决）。
//
// 台账 .harness/local/worktrees.json（v2）：
//   {
//     "version": 2,
//     "slots":  { "<repo>": { "slot-1": { "task": "…", "branch": "…", "since": "ISO", "state": "bound" | "stale-unmerged" } } },
//     "tasks":  { "<task>": { "assignedAt": "ISO", "repos": { "<repo>": { "placement": "main" | "slot-N", "branch": "…", "base": "…" } } } }
//   }
// v1（per-task worktree）台账无 version 字段，读取时自然落入容错分支视为空——
// M1 刚上线即改为池化，野外无 v1 数据需要迁移。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir, localStatePath } from './paths.js';
import { runGit } from './exec.js';
import { provisionLocalFiles } from './local-files.js';
import { inspectConflict, updateTargetAfterDetached } from './archive-conflict.js';

const ledgerPath = (ws) => localStatePath(ws, 'worktrees.json', 'tasks/worktrees.json');
const worktreeRoot = (ws, repo) => path.join(ws, '.worktrees', repo);

// --------------------------------------------------------------- 台账读写

/** 读台账（v2；坏文件/v1 一律容错为空）。 */
export function readWorkspaces(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(ws), 'utf8'));
    if (data?.version !== 2 || typeof data !== 'object') return { slots: {}, tasks: {} };
    return { slots: data.slots ?? {}, tasks: data.tasks ?? {} };
  } catch { return { slots: {}, tasks: {} }; }
}

function writeWorkspaces(ws, { slots, tasks }) {
  fs.mkdirSync(path.dirname(ledgerPath(ws)), { recursive: true });
  fs.writeFileSync(ledgerPath(ws), `${JSON.stringify({ version: 2, slots, tasks }, null, 2)}\n`, 'utf8');
  keepLedgerLocal(ws);
}

/** 本机状态本地化：.gitignore 排除整个 .harness/local/；旧 tasks/*.json 行保留不影响。 */
export function keepLedgerLocal(ws, _entry = null) {
  try {
    const hd = harnessDir(ws);
    const gi = path.join(hd, '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === 'local/')) {
      fs.appendFileSync(gi, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}# 本机状态（机器本地，不共享、勿提交）\nlocal/\n`, 'utf8');
    }
    if (fs.existsSync(path.join(hd, '.git'))) {
      runGit(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', 'local'], { cwd: hd });
    }
  } catch { /* 容忍：最坏结果是本机状态被同步 */ }
}

// 兼容旧测试与外部引用
export const readWorktrees = readWorkspaces;

// --------------------------------------------------------------- git 小工具

/** 根仓本地排除 .worktrees/（不动共享 .gitignore，不进提交）。幂等。 */
function excludeFromRootRepo(ws) {
  const exclude = path.join(ws, '.git', 'info', 'exclude');
  try {
    if (!fs.existsSync(path.join(ws, '.git'))) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === '.worktrees/')) {
      fs.appendFileSync(exclude, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}.worktrees/\n`, 'utf8');
    }
  } catch { /* 排除失败不阻断主流程，仅表现为根仓 untracked 噪音 */ }
}

/** 某仓是否为可用 git 仓（submodule/普通仓均可）。 */
async function isGitRepo(repoDir) {
  return (await runGit(['rev-parse', '--git-dir'], { cwd: repoDir })).code === 0;
}

/** 解析基线分支：kit.json source.branch → 本地 dev → 远端同名分支 → 当前 HEAD。
 *  A local clone may not have checked out/synced the registered branch yet; using
 *  origin/<branch> keeps the ledger target mergeable instead of recording HEAD. */
async function resolveBase(repoDir, source) {
  const wanted = source.branch ?? 'dev';
  if ((await runGit(['rev-parse', '--verify', `refs/heads/${wanted}`], { cwd: repoDir })).code === 0) return wanted;
  if ((await runGit(['rev-parse', '--verify', 'refs/heads/dev'], { cwd: repoDir })).code === 0) return 'dev';
  for (const ref of [`refs/remotes/origin/${wanted}`, 'refs/remotes/origin/dev']) {
    if ((await runGit(['rev-parse', '--verify', ref], { cwd: repoDir })).code === 0) return ref.slice('refs/remotes/'.length);
  }
  if ((await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: repoDir })).code === 0) return 'HEAD';
  return null;
}

/**
 * 解析任务创建时指定的基线（--base，analysis-base.json 落盘）：
 * 该值同时是开发分支基点与归档合入目标（2026-11-17 定：目标基线=创建时指定，不是默认基线）。
 * 返回可用的 ref 名（本地分支或 origin/<分支>），不可用返回 null。
 */
async function resolveTaskBase(repoDir, branch) {
  if (!branch) return null;
  if ((await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoDir })).code === 0) return branch;
  if ((await runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd: repoDir })).code === 0) return `origin/${branch}`;
  return null;
}

/** 读任务创建时指定的分析/开发基线（.harness/deliverables/<任务>/analysis-base.json）。 */
export function readTaskBaseSpec(ws, task) {
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(harnessDir(ws), 'deliverables', task, 'analysis-base.json'), 'utf8'));
    return spec && typeof spec === 'object' ? spec : {};
  } catch { return {}; }
}

async function currentBranch(repoDir) {
  const r = await runGit(['branch', '--show-current'], { cwd: repoDir });
  return r.code === 0 ? r.stdout.trim() : '';
}

/** 归档释放时切回基线：远端基线优先落成本地同名分支，避免 detached HEAD。 */
async function checkoutBaseBranch(repoDir, base) {
  const fallback = base ?? 'dev';
  const local = fallback.startsWith('origin/') ? fallback.slice('origin/'.length) : fallback;
  const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], { cwd: repoDir });
  if (exists.code === 0) return runGit(['checkout', local], { cwd: repoDir });
  return runGit(['checkout', '--no-track', '-B', local, fallback], { cwd: repoDir });
}

/** 把主工作树切到任务分支：已存在则 checkout，否则从基点新建。 */
async function checkoutTaskBranch(repoDir, branch, base) {
  const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir });
  // 从远端基线拉任务分支时不能自动跟踪基线，否则 git push 可能误推到基线分支
  const args = exists.code === 0 ? ['checkout', branch] : ['checkout', '--no-track', '-b', branch, base];
  const r = await runGit(args, { cwd: repoDir });
  if (r.code !== 0) {
    const line = (r.stderr || r.stdout).trim().split('\n')[0];
    return { error: `主工作树切到任务分支 ${branch} 失败：${line}` };
  }
  return {};
}

/**
 * 为任务分支准备基点：选了任务基线时先 fetch，能用远端最新就用 origin/<base>，
 * 但本地基线领先/分叉时保留本地提交，不强制同步。
 * 返回 { ref, note? } 或 { error }；只读远端 + 建任务分支，不改写本地基线。
 */
async function prepareTaskBase(repoDir, base) {
  if (!base || base === 'HEAD') return { ref: base || 'HEAD' };
  const local = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  const hasLocal = await localBranchExists(repoDir, local);
  const hasOrigin = (await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir })).code === 0;
  if (!hasOrigin) return hasLocal ? { ref: local } : { ref: base };
  const fetched = await runGit(['fetch', 'origin', local], { cwd: repoDir, timeoutMs: 30_000 });
  const remote = `origin/${local}`;
  if (fetched.code !== 0) {
    return hasLocal
      ? { ref: local, note: `拉取 ${remote} 失败，按本地基点 ${local} 创建任务分支` }
      : { ref: base, note: `拉取 ${remote} 失败，按现有基点 ${base} 创建任务分支` };
  }
  if (!(await refExists(repoDir, remote))) return hasLocal ? { ref: local } : { ref: base };
  if (!hasLocal) return { ref: remote, note: `已使用远端最新基点 ${remote}` };
  const localRev = (await runGit(['rev-parse', local], { cwd: repoDir })).stdout.trim();
  const remoteRev = (await runGit(['rev-parse', remote], { cwd: repoDir })).stdout.trim();
  if (localRev === remoteRev) return { ref: local };
  if (await isAncestor(repoDir, local, remote)) {
    return { ref: remote, note: `已使用远端最新基点 ${remote}` };
  }
  return { ref: local, note: `本地 ${local} 领先/分叉于 ${remote}，按本地基点创建任务分支（未强制同步）` };
}

async function isDirty(dir) {
  const r = await runGit(['status', '--porcelain'], { cwd: dir });
  return r.code !== 0 || r.stdout.trim() !== '';
}

/** 本地合入判定。 */
async function mergedLocally(repoDir, branch, base) {
  const r = await runGit(['branch', '--merged', base, '--list', branch], { cwd: repoDir });
  if (r.code !== 0) return false;
  return r.stdout
    .split('\n')
    .map((line) => line.replace(/^[*+ ]+/, '').trim())
    .filter(Boolean)
    .includes(branch);
}

/** 本地分支是否存在（不 fetch）。 */
async function localBranchExists(repoDir, branch) {
  return (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir })).code === 0;
}

/** 任意 ref 是否存在（本地分支或 origin/<branch>）。 */
async function refExists(repoDir, ref) {
  return (await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoDir })).code === 0;
}

/** How many commits the task branch has on top of base. 0 = repo untouched.
 *  Returns null when the base ref cannot be resolved, so callers can refuse
 *  instead of silently dropping real changes. */
async function branchAheadCount(repoDir, branch, base) {
  if (!(await localBranchExists(repoDir, branch))) return 0;
  const ref = base === 'HEAD' ? 'HEAD' : base;
  if (!ref || !(await refExists(repoDir, ref))) return null;
  const r = await runGit(['rev-list', '--count', `${ref}..${branch}`], { cwd: repoDir });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/** 归档对账的候选基线：任务创建时基线、当前注册基线、当前分支和常见主线。 */
function candidateBases(info, source, current) {
  const seen = new Set();
  for (const base of [info?.base, source?.branch, current, 'dev', 'test', 'main', 'master']) {
    if (typeof base === 'string' && base.trim() && base !== 'HEAD') seen.add(base.trim());
  }
  return [...seen];
}

/**
 * 任务分支是否已合入任一候选基线。先查本地（快），再对真正可能是远端的
 * 基线做一次 fetch 复查（合入常发生在 GitLab MR，本地主线可能滞后）。
 * 返回命中的基线名，未合入返回 null。
 */
async function mergedIntoAny(repoDir, branch, bases) {
  for (const base of bases) {
    if (await mergedLocally(repoDir, branch, base)) return base;
  }
  // 本地主线可能滞后：一次 fetch 后复查 origin/<base>，避免每个候选基线各 fetch 一次。
  await runGit(['fetch', 'origin'], { cwd: repoDir, timeoutMs: 30_000 });
  for (const base of bases) {
    const target = base.startsWith('origin/') ? base : `origin/${base}`;
    if (await refExists(repoDir, target) && await mergedLocally(repoDir, branch, target)) return base;
  }
  return null;
}

/**
 * 合入判定（归档释放用）：先看本地基线；未合入则 fetch 远端基线再判一次
 * （iot-harness 的合入发生在 GitLab MR，本地 dev 常滞后——不 fetch 会把
 * 几乎所有归档都判成"未合入"，主工作树/slot 永远无法释放）。
 * fetch 失败按未合入处理（不报错）。
 */
async function mergedStatus(repoDir, branch, base) {
  if (await mergedLocally(repoDir, branch, base)) return true;
  if (base === 'HEAD') return false;
  // base 可能是远端 ref（--base 指定的分支只有远端时 resolveTaskBase 返回 origin/<x>）
  const remoteBase = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  await runGit(['fetch', 'origin', remoteBase], { cwd: repoDir, timeoutMs: 30_000 });
  const target = base.startsWith('origin/') ? base : `origin/${remoteBase}`;
  return mergedLocally(repoDir, branch, target);
}

// --------------------------------------------------------------- 决策点（需人裁决的结构性阻塞）

const decisionsPath = (ws) => localStatePath(ws, 'decisions.json', 'tasks/decisions.json');

/** 待裁决决策点（本机状态）：{ <task>: { code, text, options, at } }。 */
export function readDecisions(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(decisionsPath(ws), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeDecisions(ws, decisions) {
  fs.mkdirSync(path.dirname(decisionsPath(ws)), { recursive: true });
  fs.writeFileSync(decisionsPath(ws), `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
  keepLedgerLocal(ws);
}

/** 记录决策点（工作区分配拒绝等）；重复记录覆盖（保持最新文本）。 */
export function recordDecision(ws, task, entry) {
  const decisions = readDecisions(ws);
  decisions[task] = { ...entry, at: new Date().toISOString() };
  writeDecisions(ws, decisions);
}

/** 清除决策点（用户已裁决重跑成功 / 任务归档 / 同名重建）。 */
export function clearDecision(ws, task) {
  const decisions = readDecisions(ws);
  if (!(task in decisions)) return;
  delete decisions[task];
  writeDecisions(ws, decisions);
}

/** 主工作树现场详情（决策点报错的信息增强：分支 + git status，帮助人裁决）。 */
export async function describeMainWorktree(ws, source, { maxLines = 10 } = {}) {
  const repoDir = path.join(ws, source.path);
  if (!fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) return `${source.name}：仓不可用`;
  const branch = await currentBranch(repoDir);
  const st = await runGit(['status', '--short'], { cwd: repoDir });
  const lines = st.code === 0 ? st.stdout.trim().split('\n').filter(Boolean) : [];
  return [
    `${source.name}（\`${repoDir}\`）`,
    `　当前分支：\`${branch || '(detached)'}\``,
    lines.length === 0 ? '　工作区干净' : `　未提交改动（前 ${Math.min(lines.length, maxLines)} 行/共 ${lines.length}）：\n${lines.slice(0, maxLines).map((l) => `　　${l}`).join('\n')}`,
  ].join('\n');
}

/** 判断 ancestor 是否为 descendant 的祖先（git 退出码 0 = 是）。 */
async function isAncestor(repoDir, ancestor, descendant) {
  return (await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoDir })).code === 0;
}

/** 把目标本地分支的上游设为 origin/<target>（远端分支存在时；失败不阻断）。 */
async function setTargetUpstream(repoDir, target) {
  const remote = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`], { cwd: repoDir });
  if (remote.code !== 0) return;
  await runGit(['branch', '--set-upstream-to', `origin/${target}`, target], { cwd: repoDir });
}

/** 把 origin/<target> 干净地并入本地目标（仅本地，不推送）；冲突中止回滚。 */
async function mergeRemoteIntoTarget(ws, repoDir, name, target, remoteRev, out) {
  const localRev = (await runGit(['rev-parse', 'refs/heads/' + target], { cwd: repoDir })).stdout.trim();
  const holder = await worktreeOnBranch(repoDir, target);
  let cwd = holder;
  let tempDir = null;
  if (!cwd) {
    tempDir = path.join(worktreeRoot(ws, name), '_sync');
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(tempDir), { recursive: true });
    const add = await runGit(['worktree', 'add', tempDir, target], { cwd: repoDir });
    if (add.code !== 0) {
      out.refused.push({ repo: name, reason: `目标 ${target} 同步工作树创建失败：${(add.stderr || '').trim().split('\n')[0]}` });
      return false;
    }
    cwd = tempDir;
  }
  if (await isDirty(cwd)) {
    if (tempDir) await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir });
    out.refused.push({ repo: name, reason: `目标分支 ${target} 所在工作树有未提交改动，无法并入远端：${cwd}` });
    return false;
  }
  const mg = await runGit(['merge', '--no-edit', `origin/${target}`], { cwd });
  if (mg.code !== 0) {
    const files = (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd })).stdout.trim().split('\n').filter(Boolean);
    await runGit(['merge', '--abort'], { cwd });
    if (tempDir) { await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir }); fs.rmSync(tempDir, { recursive: true, force: true }); }
    out.refused.push({ repo: name, reason: `目标 ${target} 与 origin/${target} 分叉且自动并入冲突（已回滚）：${files.slice(0, 6).join('、') || '见 git status'}` });
    return false;
  }
  if (tempDir) { await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir }); fs.rmSync(tempDir, { recursive: true, force: true }); }
  await setTargetUpstream(repoDir, target);
  out.synced.push({ repo: name, target, from: localRev.slice(0, 12), to: remoteRev.slice(0, 12), merged: true });
  return true;
}

/**
 * 合并前把本地目标与 origin/<target> 对齐。
 * - safe（默认）：落后 → 快进；领先 → 保留；分叉 → 干净地并入 origin（冲突回滚）。
 * - ff-only：落后 → 快进；领先/分叉 → 停止。
 * - off：不同步。
 * 返回 true = 可以继续；false = 已写入 out.refused。
 * 不做 rebase、不强制更新、不推送。
 */
async function syncTargetBranch(ws, repoDir, name, target, out, mode = 'safe') {
  const hasOrigin = (await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir })).code === 0;
  if (!hasOrigin) return true;
  const remoteRef = `refs/remotes/origin/${target}`;
  const hadRemoteRef = (await runGit(['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoDir })).code === 0;
  // fetch 是只读远端操作；失败时若有已知远端分支则停止，避免在旧目标上合入。
  const fetched = await runGit(['fetch', 'origin', target], { cwd: repoDir, timeoutMs: 30_000 });
  if (fetched.code !== 0) {
    if (hadRemoteRef) {
      out.refused.push({
        repo: name,
        reason: `目标 ${target} 远端拉取失败（${(fetched.stderr || '').trim().split('\n')[0] || '网络/权限'}）；修复后重试，或加 --no-merge 仅归档`,
      });
      return false;
    }
    // 远端还没有同名分支：按纯本地目标处理。
    return true;
  }
  const remoteRev = (await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`], { cwd: repoDir })).stdout.trim();
  if (!remoteRev) return true;
  const localRev = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], { cwd: repoDir })).stdout.trim();
  if (!localRev) return true;
  if (localRev === remoteRev) {
    await setTargetUpstream(repoDir, target);
    return true;
  }
  if (await isAncestor(repoDir, localRev, remoteRev)) {
    // 本地目标落后远端：优先在 checkout 它的干净工作树里快进；否则直接更新 ref。
    const holder = await worktreeOnBranch(repoDir, target);
    if (holder) {
      if (await isDirty(holder)) {
        out.refused.push({ repo: name, reason: `目标分支 ${target} 所在工作树有未提交改动，无法快进：${holder}` });
        return false;
      }
      const ff = await runGit(['merge', '--ff-only', `origin/${target}`], { cwd: holder });
      if (ff.code !== 0) {
        out.refused.push({ repo: name, reason: `目标 ${target} 快进失败：${(ff.stderr || '').trim().split('\n')[0]}` });
        return false;
      }
    } else {
      const ur = await runGit(['update-ref', `refs/heads/${target}`, remoteRev], { cwd: repoDir });
      if (ur.code !== 0) {
        out.refused.push({ repo: name, reason: `目标 ${target} 本地 ref 快进失败` });
        return false;
      }
    }
    await setTargetUpstream(repoDir, target);
    out.synced.push({ repo: name, target, from: localRev.slice(0, 12), to: remoteRev.slice(0, 12) });
    return true;
  }
  if (await isAncestor(repoDir, remoteRev, localRev)) {
    // 本地目标领先远端：这是 autoClose 未推送合并提交后的常态，safe 模式不应阻止下一次收尾。
    if (mode === 'ff-only') {
      out.refused.push({ repo: name, reason: `目标 ${target} 有未推送的本地提交（领先 origin/${target}）；ff-only 模式停止，改用 safe 或先推送` });
      return false;
    }
    await setTargetUpstream(repoDir, target);
    return true;
  }
  if (mode !== 'safe') {
    out.refused.push({ repo: name, reason: `目标 ${target} 与 origin/${target} 已分叉；ff-only 模式停止，改用 safe 或先人工合并` });
    return false;
  }
  return mergeRemoteIntoTarget(ws, repoDir, name, target, remoteRev, out);
}

/**
 * 本地合入任务分支到目标基线（B 方案，2026-11-17 定）：不推送，推送仍归人。
 *
 * 2026-11-22（0.2.0）：合并前先把本地目标快进到 origin/<target>（只 ff），
 * 已合入（本地或远端）不再重复 merge；冲突/目标脏/目标分叉全部在归档前停止。
 * 合并位置：目标分支若被某工作树 checkout 且干净 → 就地合并；否则建临时工作树
 * （.worktrees/<仓>/_merge）合并后删除。主工作树脏 → 拒绝该仓。
 *
 * 返回 { merged, conflicts, refused, alreadyMerged, unchanged, synced, planned, dryRun }。
 *
 * onConflict = 'hold' 时，把冲突现场保留在 detached 临时工作树里，并把结构化
 * 冲突详情返回给调用方（归档命令据此生成“需要你”决策）。目标分支即使正被主
 * 工作树 checkout，也先回滚再在 detached 工作树复现，解决后快进目标分支。
 */
export async function mergeTaskBranches(ws, kit, task, overrides = {}, { syncTarget = 'safe', dryRun = false, onConflict = 'abort' } = {}) {
  const out = { merged: [], conflicts: [], refused: [], alreadyMerged: [], unchanged: [], synced: [], planned: [], dryRun: dryRun === true };
  const ledger = readWorkspaces(ws);
  const entry = ledger.tasks?.[task];
  // 无台账 = 本任务没有分配过代码工作区（纯文档任务），不是错误；直接跳过合入。
  if (!entry) { out.noWorkspace = true; return out; }

  for (const [name, info] of Object.entries(entry.repos ?? {})) {
    if (!info || !info.branch) continue; // 无分支记录（非 git 仓）跳过；main/slot 两种放置都可合入
    const source = (kit?.sources ?? []).find((s) => s.name === name);
    const repoDir = source ? path.join(ws, source.path) : null;
    if (!repoDir || !fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) {
      out.refused.push({ repo: name, reason: '仓不可用' });
      continue;
    }
    // 目标分支：人显式覆盖优先，否则台账记录的创建时基线
    let target = (overrides?.[name] ?? info.base ?? '').trim();
    if (!target) { out.refused.push({ repo: name, reason: '无目标基线记录' }); continue; }
    const branch = info.branch;
    // Backend-only tasks also get ledger entries for every registered source.
    // A source the task never touched must not block archive on its target
    // branch (notably a repo whose default branch could not be resolved and
    // was recorded as HEAD). Missing branch = no commits = nothing to merge.
    const ahead = await branchAheadCount(repoDir, branch, target);
    if (ahead === 0) {
      out.unchanged.push({ repo: name, reason: `任务分支 ${branch} 相对 ${target} 无改动` });
      continue;
    }
    if (ahead === null && !(await localBranchExists(repoDir, branch))) {
      out.unchanged.push({ repo: name, reason: `任务分支 ${branch} 不存在（按未改动跳过）` });
      continue;
    }
    // HEAD is a valid commit but not a mergeable branch. If the task branch
    // really has changes, merge into the branch that HEAD currently points at.
    if (target === 'HEAD') {
      const cur = await currentBranch(repoDir);
      if (!cur || cur === branch) {
        out.refused.push({ repo: name, reason: `目标基线未解析（HEAD）；请配置 ${name} 的基线分支或先 fetch 远端分支` });
        continue;
      }
      target = cur;
    }
    // 远端 ref → 先落成本地分支（合并必须发生在本地分支上）
    if (target.startsWith('origin/')) {
      const local = target.slice('origin/'.length);
      if ((await runGit(['rev-parse', '--verify', `refs/heads/${local}`], { cwd: repoDir })).code !== 0) {
        const cb = await runGit(['branch', local, target], { cwd: repoDir });
        if (cb.code !== 0) { out.refused.push({ repo: name, reason: `目标 ${target} 无法建立本地分支` }); continue; }
      }
      await setTargetUpstream(repoDir, local);
      target = local;
    }
    if (!(await localBranchExists(repoDir, target))) {
      out.refused.push({ repo: name, reason: `目标分支 ${target} 不存在` });
      continue;
    }

    // 已合入本地目标：无需同步/合并，直接释放。远端 MR 合入的情况在 sync 后再判一次。
    if (await mergedLocally(repoDir, branch, target)) {
      out.alreadyMerged.push({ repo: name, target });
      continue;
    }
    if (dryRun) {
      out.planned.push({ repo: name, target, branch });
      continue;
    }
    if (syncTarget !== 'off' && !(await syncTargetBranch(ws, repoDir, name, target, out, syncTarget))) continue;
    if (await mergedLocally(repoDir, branch, target)) {
      out.alreadyMerged.push({ repo: name, target });
      continue;
    }

    // 目标分支被哪个工作树 checkout？
    const holder = await worktreeOnBranch(repoDir, target);
    let mergeCwd = null;
    let tempDir = null;
    if (holder) {
      if (await isDirty(holder)) { out.refused.push({ repo: name, reason: `目标分支 ${target} 所在工作树有未提交改动，请先处理：${holder}` }); continue; }
      mergeCwd = holder;
    } else {
      tempDir = path.join(worktreeRoot(ws, name), '_merge');
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(tempDir), { recursive: true });
      const add = await runGit(['worktree', 'add', tempDir, target], { cwd: repoDir });
      if (add.code !== 0) { out.refused.push({ repo: name, reason: `临时工作树创建失败：${(add.stderr || '').trim().split('\n')[0]}` }); continue; }
      mergeCwd = tempDir;
    }

    // --no-ff 合并：即使可快进也留合并提交，记录"某任务合入"
    const mergeMessage = `harness: 合入 ${branch}（${task}）`;
    const mg = await runGit(['merge', '--no-ff', '-m', mergeMessage, branch], { cwd: mergeCwd });
    if (mg.code !== 0) {
      const files = (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: mergeCwd })).stdout.trim().split('\n').filter(Boolean);
      const initialDetails = await inspectConflict(mergeCwd, target, branch);
      if (onConflict === 'hold') {
        // 冲突现场不能在目标分支持有的工作树里保留（会把主树变成 merge 中途）。
        // 先回滚当前 merge，再在 detached 临时工作树里复现冲突；解决后把提交
        // 快进/更新到目标分支。这样目标分支被主工作树 checkout 时也能安全恢复。
        await runGit(['merge', '--abort'], { cwd: mergeCwd });
        if (tempDir) {
          await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir });
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        const targetCommit = (await runGit(['rev-parse', `refs/heads/${target}`], { cwd: repoDir })).stdout.trim();
        const holdDir = path.join(worktreeRoot(ws, name), '_merge-conflict');
        await runGit(['worktree', 'remove', '--force', holdDir], { cwd: repoDir });
        fs.rmSync(holdDir, { recursive: true, force: true });
        await runGit(['worktree', 'prune'], { cwd: repoDir });
        const add = await runGit(['worktree', 'add', '--detach', holdDir, target], { cwd: repoDir });
        if (add.code !== 0) {
          out.conflicts.push({
            repo: name, target, branch, files, details: initialDetails, held: false,
            reason: `无法创建冲突处理工作树：${(add.stderr || '').trim().split('\n')[0]}`,
          });
          continue;
        }
        const hm = await runGit(['merge', '--no-ff', '-m', mergeMessage, branch], { cwd: holdDir });
        if (hm.code !== 0) {
          const details = await inspectConflict(holdDir, target, branch);
          out.conflicts.push({
            repo: name, target, branch, repoDir, worktree: holdDir, temp: true,
            detached: true, targetWorktree: holder ?? null, baseCommit: targetCommit,
            files: details.map((f) => f.path), details, held: true,
          });
          continue;
        }
        // 极端情况：复现时冲突消失（例如外部已解决），直接落提交。
        const fullHash = (await runGit(['rev-parse', 'HEAD'], { cwd: holdDir })).stdout.trim();
        const updated = await updateTargetAfterDetached(repoDir, target, holder ?? null, targetCommit, fullHash);
        await runGit(['worktree', 'remove', '--force', holdDir], { cwd: repoDir });
        fs.rmSync(holdDir, { recursive: true, force: true });
        if (!updated.ok) { out.refused.push({ repo: name, reason: updated.error }); continue; }
        out.merged.push({ repo: name, target, commit: fullHash.slice(0, 12) });
        continue;
      }
      await runGit(['merge', '--abort'], { cwd: mergeCwd });
      if (tempDir) { await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir }); fs.rmSync(tempDir, { recursive: true, force: true }); }
      out.conflicts.push({
        repo: name, target, branch, files, details: initialDetails, held: false,
        reason: null,
      });
      continue;
    }
    const commit = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: mergeCwd })).stdout.trim();
    if (tempDir) {
      await runGit(['worktree', 'remove', '--force', tempDir], { cwd: repoDir });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    out.merged.push({ repo: name, target, commit });
  }
  return out;
}

/** 哪个工作树 checkout 着某分支（返回路径；无则 null）。 */
async function worktreeOnBranch(repoDir, branch) {
  const r = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoDir });
  if (r.code !== 0) return null;
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${branch}`) return cur;
  }
  return null;
}

/**
 * 主工作树状态：occupied = 不能再分配新任务。
 * 占用判定（唯一标准，2026-11-14 定）：checkout 着非基线分支（正在分支开发中），
 * 或基线上有未提交改动（保守——防止新任务在脏基线上开工）。
 */
async function mainWorktreeState(repoDir, base) {  const branch = await currentBranch(repoDir);
  const dirty = await isDirty(repoDir);
  const occupied = branch !== base || dirty;
  let reason = '';
  if (branch !== base) reason = `主工作树正在分支 \`${branch}\` 上开发`;
  else if (dirty) reason = '主工作树基线上有未提交改动';
  return { branch, dirty, occupied, reason };
}

// --------------------------------------------------------------- 冲突前置检测

/** 极简看板行扫描（任务名+状态）：供占用者回填核对用，不做全量契约校验（parseBoard 在 panel.js，避免环依赖）。 */
function boardRowsFor(ws) {
  try {
    const text = fs.readFileSync(path.join(harnessDir(ws), 'tasks', 'board.md'), 'utf8');
    return text.split('\n')
      .filter((l) => l.startsWith('|'))
      .map((l) => {
        const c = l.split('|').map((x) => x.trim());
        return { task: c[1] ?? '', status: c[2] ?? '' };
      })
      .filter((r) => r.task && r.task !== '任务名' && !/^[-: ]+$/.test(r.task));
  } catch { return []; }
}

/** 与在途任务（台账内其他任务）的分支改动文件集重叠。 */
async function overlapWithInflight(ws, kit, task) {
  const { tasks } = readWorkspaces(ws);
  const out = [];
  for (const [other, entry] of Object.entries(tasks)) {
    if (other === task || !entry?.repos) continue;
    for (const source of kit.sources ?? []) {
      const info = entry.repos[source.name];
      if (!info?.branch || !info?.base) continue;
      const repoDir = path.join(ws, source.path);
      if (!fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) continue;
      const r = await runGit(['diff', '--name-only', `${info.base}...${info.branch}`], { cwd: repoDir });
      if (r.code === 0 && r.stdout.trim()) {
        out.push({ task: other, source: source.name, files: r.stdout.trim().split('\n') });
      }
    }
  }
  return out;
}

// --------------------------------------------------------------- slot 分配与释放

/**
 * 在仓上找空闲 slot 或新建一个，并切到任务分支。
 * 返回 { placement, path }；不可用时返回 { error }。
 */
async function acquireSlot(ws, repoDir, repoName, task, branch, base, slots) {
  const root = worktreeRoot(ws, repoName);
  const repoSlots = slots[repoName] ?? {};
  const notes = [];
  const boundToOther = (s) => {
    const b = repoSlots[s];
    return b && b.task !== task && b.state !== 'stale-unmerged' ? b : null;
  };
  const stale = (s) => repoSlots[s]?.state === 'stale-unmerged';

  // 已绑定本任务的 slot → 复用（幂等）
  for (const [name, binding] of Object.entries(repoSlots)) {
    if (binding.task === task && fs.existsSync(path.join(root, name))) {
      if (await currentBranch(path.join(root, name)) !== binding.branch) {
        await runGit(['checkout', binding.branch], { cwd: path.join(root, name) });
      }
      return { placement: name, path: path.join(root, name), notes };
    }
  }

  // 找现成 slot 目录：无绑定或绑定的任务已不在台账 → 候选
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^slot-\d+$/.test(d) && fs.statSync(path.join(root, d)).isDirectory()) : [];
  dirs.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const name of dirs) {
    if (boundToOther(name) || stale(name)) continue;
    const dir = path.join(root, name);
    if (await isDirty(dir)) {
      // 卫生纪律：脏 slot 跳过并提示人工清理（不自动 stash——残留可能是有价值的工作）；
      // 后面还有干净 slot 就用，没有就新建，脏 slot 不阻塞任务
      const bindingHint = repoSlots[name]?.task ? `（上一任任务 ${repoSlots[name].task} 的残留）` : '';
      notes.push(`slot ${name} 有未提交改动${bindingHint}，已跳过：请人工处理（提交/丢弃/移走）后它才能再被使用`);
      continue;
    }
    // 干净 slot：切到任务分支（已存在则直接切，否则从基线拉）
    const branchExists = (await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoDir })).code === 0;
    const r = branchExists
      ? await runGit(['checkout', branch], { cwd: dir })
      : await runGit(['checkout', '--no-track', '-b', branch, base], { cwd: dir });
    if (r.code !== 0) return { error: `slot ${name} 切分支失败：${(r.stderr || '').trim().split('\n')[0]}` };
    return { placement: name, path: dir, notes };
  }

  // 没有可用 slot → 新建下一个序号（池化：只有并发数超出现有 slot 数才新建）
  const nums = [...dirs, ...Object.keys(repoSlots)];
  const next = nums.reduce((m, n) => Math.max(m, Number(String(n).replace(/\D/g, '')) || 0), 0) + 1;
  const name = `slot-${next}`;
  const dir = path.join(root, name);
  fs.mkdirSync(root, { recursive: true });
  const r = await runGit(['worktree', 'add', '-b', branch, dir, base], { cwd: repoDir });
  if (r.code !== 0) return { error: `新建 slot ${name} 失败：${(r.stderr || '').trim().split('\n')[0]}` };
  return { placement: name, path: dir, notes };
}

/** 释放 slot：分支已合入 → 切回基线、删分支、解绑（目录保留）；未合入 → 标 stale。 */
async function releaseSlot(repoDir, dir, binding, base, slots, repoName, candidates = null) {
  const branch = binding.branch;
  if (!fs.existsSync(dir)) { delete slots[repoName][binding.slot]; return { released: true }; }
  // 未改动仓：任务分支没有独立提交，无需合入；直接切回基线/当前提交并解绑，
  // 避免“后端任务被前端空分支卡住归档”。有改动时仍走下面的合入判定。
  const ahead = await branchAheadCount(repoDir, branch, base);
  if (ahead === 0) {
    if (await isDirty(dir)) {
      return { released: false, reason: `slot ${binding.slot} 有未提交改动，请人工处理后再释放` };
    }
    const parked = base === 'HEAD' ? 'HEAD' : base;
    const co = await runGit(['checkout', '--detach', parked], { cwd: dir });
    if (co.code !== 0) return { released: false, reason: `slot ${binding.slot} 切回 ${parked} 失败：${(co.stderr || '').trim().split('\n')[0]}` };
    await runGit(['branch', '-d', branch], { cwd: repoDir });
    delete slots[repoName][binding.slot];
    return { released: true, matchedBase: base, noChanges: true };
  }
  // 合入判定：台账基线（任务创建时指定）与当前 kit 基线任一命中都算已合入——
  // 人可能在开发期间改基线（如 phm 合入 feat_phm_261022，2026-11-17 真实事故）
  const targets = [...new Set((candidates && candidates.length ? candidates : [base]).filter(Boolean))];
  let hit = null;
  for (const t of targets) {
    if (await mergedStatus(repoDir, branch, t)) { hit = t; break; }
  }
  if (hit) {
    if (await isDirty(dir)) {
      return { released: false, reason: `slot ${binding.slot} 有未提交改动，请人工处理后再释放` };
    }
    // 注意：基线分支在主工作树 checkout 着，git 不允许第二个 worktree 再 checkout 它——
    // 释放用 detached HEAD 停在基线提交上（复用时从 detached 直接拉新分支，零冲突）
    const co = await runGit(['checkout', '--detach', hit], { cwd: dir });
    if (co.code !== 0) return { released: false, reason: `slot ${binding.slot} 切回基线失败：${(co.stderr || '').trim().split('\n')[0]}` };
    await runGit(['branch', '-d', branch], { cwd: repoDir });
    delete slots[repoName][binding.slot];
    return { released: true, matchedBase: hit };
  }
  slots[repoName][binding.slot] = { ...binding, state: 'stale-unmerged' };
  return { released: false, reason: `分支 ${branch} 未合入 ${targets.join(' / ')}：slot ${binding.slot} 保留并标记 stale（后续任务不会使用）；人确认合入后重跑 /hk-archive 释放` };
}

// --------------------------------------------------------------- 主入口

/**
 * 为任务分配各仓工作区（幂等）。
 * 返回 { assigned: [{source, placement, path?, branch, base, reused}], refused: [{source, reason}], overlaps }。
 * placement: 'main' = 主工作树；'slot-N' = 池化 worktree。
 */
export async function ensureTaskWorkspaces(ws, kit, task, { branchPrefix = 'feat', forceSlot = false } = {}) {
  const result = { assigned: [], refused: [], notes: [], overlaps: [] };
  const sources = kit?.sources ?? [];
  if (sources.length === 0) return result;
  excludeFromRootRepo(ws);
  const ledger = readWorkspaces(ws);
  const tEntry = ledger.tasks[task] ?? { assignedAt: new Date().toISOString(), repos: {} };

  for (const source of sources) {
    const repoDir = path.join(ws, source.path);
    if (!fs.existsSync(repoDir)) continue; // 仓目录缺失：与本任务无关，跳过
    if (!(await isGitRepo(repoDir))) {
      // 非 git 仓（或伪 .git）：退回原模式，不做任何 git 管理
      const prev = tEntry.repos[source.name];
      if (!prev) {
        tEntry.repos[source.name] = { placement: 'main', branch: null, base: null };
        result.assigned.push({ source: source.name, placement: 'main', path: repoDir, branch: null, base: null, reused: false });
      } else {
        result.assigned.push({ source: source.name, placement: 'main', path: repoDir, branch: prev.branch, base: prev.base, reused: true });
      }
      continue;
    }
    // 开发分支基点：任务创建时指定的基线（--base）优先，否则 kit.json 基线（2026-11-17 定）
    const taskSpec = readTaskBaseSpec(ws, task);
    const baseline = await resolveBase(repoDir, source) ?? 'HEAD';
    let base = baseline;
    let selectedBase = false;
    if (taskSpec[source.name]) {
      const resolved = await resolveTaskBase(repoDir, taskSpec[source.name]);
      if (resolved) {
        base = resolved;
        selectedBase = true;
      } else {
        result.notes.push(`${source.name}：创建时指定的基线 ${taskSpec[source.name]} 不存在（本地/远端均无），已回退默认基线 ${baseline}`);
      }
    }
    const branch = `${branchPrefix}/harness-${task}`;

    // 幂等：本任务已有有效分配 → 复用
    const existing = tEntry.repos[source.name];
    if (existing) {
      if (existing.placement === 'main') {
        const current = await currentBranch(repoDir);
        // 选了开发基线但主树还停在别的分支（常见是 dev）：删掉旧分配，让下面的
        // selectedBase 规则决定是否从基线切到任务分支；否则保持原有复用行为。
        if (!selectedBase || current === branch) {
          result.assigned.push({ source: source.name, placement: 'main', path: repoDir, branch, base, reused: true, ready: current === branch });
        } else {
          delete tEntry.repos[source.name];
        }
      } else {
        const dir = path.join(worktreeRoot(ws, source.name), existing.placement);
        if (fs.existsSync(dir)) {
          result.assigned.push({ source: source.name, placement: existing.placement, path: dir, branch, base, reused: true });
        } else {
          delete tEntry.repos[source.name]; // slot 目录没了，重新分配
        }
      }
      if (tEntry.repos[source.name]) continue;
    }

    // 主工作树空闲？→ 原模式。
    // 注意：判定「占用」以台账为准而非仅 git 状态——分配给主工作树只写台账、
    // 分支由 agent 稍后创建；若只看 git 状态，两个任务在分支创建前会同时抢到主工作树。
    // 台账已本地化（keepLedgerLocal），里面的占用者必然是本机自己的任务。
    const main = forceSlot ? { occupied: true, branch, dirty: false, reason: '--slot 强制隔离' } : await mainWorktreeState(repoDir, base);
    const owner = Object.entries(ledger.tasks).find(([t, e]) => t !== task && e?.repos?.[source.name]?.placement === 'main');
    // 选了开发基线时，干净的主工作树只要停在「注册基线 / 所选基线 / 本任务分支」上，
    // 就允许在分配时切到任务分支（否则主树停在 dev 会被当成外来分支，apply 卡在裁决点）。
    const mainOnAcceptedBranch = !forceSlot && !main.dirty
      && (main.branch === baseline || main.branch === base || main.branch === branch);
    // 任务显式指定了开发基线（--base），且主树干净、无其他台账任务占用：
    // 即使当前停在 test/其他普通分支，也允许自动切到任务基线并创建任务分支。
    // 只排除 harness 任务分支（那是别的任务的主树占用，继续走自动 slot/裁决）。
    const canAdoptSelectedBase = !forceSlot && !owner && selectedBase && !main.dirty
      && !!main.branch && main.branch !== branch
      && !/^(?:feat|fix)\/harness-/.test(main.branch);
    if (canAdoptSelectedBase && !mainOnAcceptedBranch) {
      const prep = await prepareTaskBase(repoDir, base);
      if (prep.error) {
        result.refused.push({ source: source.name, reason: prep.error });
        continue;
      }
      if (prep.note) result.notes.push(`${source.name}：${prep.note}`);
      const co = await checkoutTaskBranch(repoDir, branch, prep.ref);
      if (co.error) {
        result.refused.push({ source: source.name, reason: co.error });
        continue;
      }
      result.notes.push(`${source.name}：主工作树已从 \`${main.branch}\` 切到任务分支 \`${branch}\`（基点 \`${prep.ref}\`）`);
      tEntry.repos[source.name] = { placement: 'main', branch, base };
      ledger.slots[source.name] ??= {};
      result.assigned.push({ source: source.name, placement: 'main', path: repoDir, branch, base, reused: false, ready: true, switched: true });
      continue;
    }
    if ((!main.occupied || mainOnAcceptedBranch) && !owner) {
      let switched = false;
      if (selectedBase && main.branch !== branch) {
        const prep = await prepareTaskBase(repoDir, base);
        if (prep.error) {
          result.refused.push({ source: source.name, reason: prep.error });
          continue;
        }
        if (prep.note) result.notes.push(`${source.name}：${prep.note}`);
        const co = await checkoutTaskBranch(repoDir, branch, prep.ref);
        if (co.error) {
          result.refused.push({ source: source.name, reason: co.error });
          continue;
        }
        switched = true;
        result.notes.push(`${source.name}：主工作树已从 \`${main.branch}\` 切到任务分支 \`${branch}\`（基点 \`${prep.ref}\`）`);
      }
      tEntry.repos[source.name] = { placement: 'main', branch, base };
      ledger.slots[source.name] ??= {};
      result.assigned.push({ source: source.name, placement: 'main', path: repoDir, branch, base, reused: false, ready: main.branch === branch || switched, switched });
      continue;
    }
    if (!owner && !forceSlot) {
      // 占用分支是 harness 任务分支（feat/harness-* / fix/harness-*）但台账无记录：
      // 典型是台账机制之前的在途任务——分支语义明确，无需人裁决，自动落 slot；
      // 且回填台账，让该任务归档时主树能被正确释放（2026-11-16 iot-harness 真实场景）。
      const hm = main.branch.match(/^(?:feat|fix)\/harness-(.+)$/);
      if (hm) {
        const rows = boardRowsFor(ws);
        const row = rows.find((r) => r.task === hm[1]) ?? rows.find((r) => r.task === hm[1].replace(/-r\d+$/, ''));
        if (row) {
          ledger.tasks[row.task] ??= { assignedAt: new Date().toISOString(), repos: {} };
          if (!ledger.tasks[row.task].repos[source.name]) {
            ledger.tasks[row.task].repos[source.name] = { placement: 'main', branch: main.branch, base };
            result.notes.push(`主工作树被 harness 任务 ${row.task} 占用（台账无记录，已回填）；本任务自动分配 slot`);
          }
        } else {
          result.notes.push(`主工作树被 harness 分支 ${main.branch} 占用（对应任务不在看板，未回填台账）；本任务自动分配 slot`);
        }
        // 落入下方 slot 分配
      } else {
        // 真正的外来分支/脏基线 → 决策点：不静默选 slot，提示用户处理或明确加 --slot（用户裁决后再执行）
        const dirtyOnBase = main.branch === base;
        result.refused.push({
          source: source.name,
          reason: dirtyOnBase
            ? '主工作树基线上有未提交改动（可能是手工修改）：请先提交/暂存/丢弃后重跑（主工作树模式）；或确认要在隔离 slot 开发：重跑时加 `--slot`'
            : `${main.reason}，且非本工作区台账任务（可能是手工操作残留）：请先人工处理；或确认要在隔离 slot 开发：重跑时加 \`--slot\``,
        });
        continue;
      }
    }
    // 主工作树被本机其他台账任务占用（或其分配已落台账）→ slot
    ledger.slots[source.name] ??= {};
    const acq = await acquireSlot(ws, repoDir, source.name, task, branch, base, ledger.slots);
    if (acq.error) {
      result.refused.push({ source: source.name, reason: acq.error });
      continue;
    }
    result.notes.push(...(acq.notes ?? []));
    result.notes.push(...(await provisionLocalFiles(ws, source, acq.path)));
    ledger.slots[source.name][acq.placement] = { task, branch, since: new Date().toISOString(), state: 'bound' };
    tEntry.repos[source.name] = { placement: acq.placement, branch, base };
    result.assigned.push({ source: source.name, placement: acq.placement, path: acq.path, branch, base, reused: false });
  }

  ledger.tasks[task] = tEntry;
  writeWorkspaces(ws, ledger);
  result.overlaps = await overlapWithInflight(ws, kit, task);
  return result;
}

/**
 * 释放一个任务台账条目（不写盘，由调用方统一写）。
 * 关键：主工作树不在任务分支时，也要检查任务分支是否已合入候选基线——
 * 人合并后切到 dev/test 是常态，不能因此把台账永久留在“占用”状态。
 */
async function releaseEntry(ws, kit, task, entry, ledger) {
  const out = { released: [], stale: [] };
  const remaining = {};
  for (const [name, info] of Object.entries(entry.repos ?? {})) {
    const source = (kit?.sources ?? []).find((s) => s.name === name);
    const repoDir = source ? path.join(ws, source.path) : null;
    if (info.placement === 'main') {
      if (!info.branch) {
        out.released.push({ source: name, placement: 'main', note: '无 git 分支记录，释放台账' });
        continue;
      }
      if (!repoDir || !fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) {
        out.released.push({ source: name, placement: 'main', note: '仓不可用，释放台账' });
        continue;
      }
      const cur = await currentBranch(repoDir);
      if (!(await localBranchExists(repoDir, info.branch))) {
        out.released.push({ source: name, placement: 'main', note: `任务分支 ${info.branch} 已不存在，释放台账` });
        continue;
      }
      const bases = candidateBases(info, source, cur).filter((b) => b !== info.branch);
      const mergedBase = await mergedIntoAny(repoDir, info.branch, bases);
      if (!mergedBase) {
        out.stale.push({
          source: name,
          reason: cur === info.branch
            ? `分支 ${info.branch} 未合入 ${info.base ?? '候选基线'}：主工作树保持占用（保护性），人确认合入后重跑 /hk-archive 释放`
            : `主工作树当前在 ${cur || '(detached)'}，任务分支 ${info.branch} 未合入候选基线：台账保留，合入后重跑 /hk-archive 释放`,
        });
        remaining[name] = info;
        continue;
      }
      if (cur === info.branch) {
        if (await isDirty(repoDir)) {
          out.stale.push({ source: name, reason: `主工作树分支 ${info.branch} 已合入但有未提交改动，未切回基线（请人工处理）` });
          remaining[name] = info;
          continue;
        }
        const co = await checkoutBaseBranch(repoDir, mergedBase);
        if (co.code !== 0) {
          out.stale.push({ source: name, reason: `主工作树切回基线失败：${(co.stderr || '').trim().split('\n')[0]}` });
          remaining[name] = info;
          continue;
        }
        await runGit(['branch', '-d', info.branch], { cwd: repoDir });
        out.released.push({ source: name, placement: 'main', note: `主工作树已切回 ${mergedBase} 并删已合入分支` });
      } else {
        // 当前在别的分支：不改用户当前分支，但已确认合入的任务分支可以安全删除（-d 会拒绝未合入）。
        const del = await runGit(['branch', '-d', info.branch], { cwd: repoDir });
        out.released.push({
          source: name,
          placement: 'main',
          note: del.code === 0
            ? `主工作树当前在 ${cur || '(detached)'}；任务分支已合入 ${mergedBase}，已删除任务分支`
            : `主工作树当前在 ${cur || '(detached)'}；任务分支已合入 ${mergedBase}，但分支仍被其他工作树使用，保留`,
        });
      }
      continue;
    }

    const dir = path.join(worktreeRoot(ws, name), info.placement);
    ledger.slots[name] ??= {};
    if (!repoDir || !fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) {
      ledger.slots[name][info.placement] = { task, branch: info.branch, since: entry.assignedAt, state: 'stale-unmerged', slot: info.placement };
      out.stale.push({ source: name, reason: '仓不可用，slot 标记 stale' });
      remaining[name] = info;
      continue;
    }
    // 候选基线：台账记录的创建时基线 + 当前 kit 基线 + 当前 checkout 分支
    // （base=HEAD 时合入目标可能回退到当前分支；人可能中途改基线，见 2026-11-17 phm 事故）
    const kitBase = source?.branch ?? null;
    const cur = await currentBranch(repoDir);
    const candidates = candidateBases(info, source, cur).filter((b) => b !== info.branch);
    const r = await releaseSlot(repoDir, dir, { slot: info.placement, task, branch: info.branch }, info.base, ledger.slots, name, candidates.length ? candidates : [info.base, kitBase].filter(Boolean));
    if (r.released) {
      const via = r.matchedBase && r.matchedBase !== info.base ? `（按当前基线 ${r.matchedBase} 判定已合入）` : '';
      out.released.push({ source: name, placement: info.placement, note: `slot 已切回基线并释放（目录保留复用）${via}` });
    } else {
      out.stale.push({ source: name, reason: r.reason });
      remaining[name] = info;
    }
  }
  return { ...out, remaining };
}

/**
 * 归档释放：main 不在任务分支时也检查合入；slot 已合入 → 切回基线释放；
 * 未合入 → stale 标记保留。返回 { released, stale: [{source, reason}], missing }。
 */
export async function releaseTaskWorkspaces(ws, kit, task) {
  const ledger = readWorkspaces(ws);
  const entry = ledger.tasks[task];
  if (!entry) return { released: [], stale: [], missing: true };
  const { released, stale, remaining } = await releaseEntry(ws, kit, task, entry, ledger);
  if (Object.keys(remaining).length === 0) delete ledger.tasks[task];
  else ledger.tasks[task] = { ...entry, repos: remaining };
  writeWorkspaces(ws, ledger);
  return { released, stale, missing: false };
}

/**
 * 已归档任务的工作区台账对账（幂等，可反复执行）。
 *
 * 台账是缓存、git 是事实源：任务文档已进入 `_archive` 且活目录不存在时，
 * 若任务分支已合入（本地或 origin）或分支已删除，就释放台账；未合入则保留
 * 并标记 stale，等下一次命令/归档再对账。这样合并在归档之后发生也不会留下
 * 永久占用。
 *
 * 返回 { tasks, released, stale }。只改本机 worktrees.json：不合并代码、不推送；
 * 当前不在任务分支时不切换分支、不删分支；任务分支被检出时按既有释放逻辑切回基线。
 */
export async function reconcileArchivedWorktrees(ws, kit) {
  const ledger = readWorkspaces(ws);
  const deliverables = path.join(harnessDir(ws), 'deliverables');
  const archiveRoot = path.join(deliverables, '_archive');
  const out = { tasks: [], released: [], stale: [] };
  let changed = false;
  for (const [task, entry] of Object.entries(ledger.tasks ?? {})) {
    // 活目录还在：任务可能已重开，不能按“已归档”清理。
    if (fs.existsSync(path.join(deliverables, task))) continue;
    // 没有归档记录：可能是手工删除，保留台账让人判断，不静默清理。
    if (!fs.existsSync(path.join(archiveRoot, task))) continue;
    const r = await releaseEntry(ws, kit, task, entry, ledger);
    out.tasks.push(task);
    out.released.push(...r.released.map((x) => ({ ...x, task })));
    out.stale.push(...r.stale.map((x) => ({ ...x, task })));
    if (Object.keys(r.remaining).length === 0) delete ledger.tasks[task];
    else ledger.tasks[task] = { ...entry, repos: r.remaining };
    changed = true;
  }
  if (changed) writeWorkspaces(ws, ledger);
  return out;
}

/**
 * 清任务残留（/hk-new、/hk-fix 重建同名任务前调用）。
 * 不问合入状态：干净 slot → 切回基线、解绑、已合入的分支顺手删；脏 slot → 保持绑定并提示。
 */
export async function clearTaskWorkspaces(ws, kit, task) {
  const ledger = readWorkspaces(ws);
  const entry = ledger.tasks[task];
  if (!entry) return { cleared: 0, notes: [] };
  const notes = [];
  let cleared = 0;
  for (const [name, info] of Object.entries(entry.repos ?? {})) {
    if (info.placement === 'main') continue; // 主工作树不做任何动作
    const dir = path.join(worktreeRoot(ws, name), info.placement);
    const source = (kit?.sources ?? []).find((s) => s.name === name);
    const repoDir = source ? path.join(ws, source.path) : null;
    ledger.slots[name] ??= {};
    if (!fs.existsSync(dir) || !repoDir || !(await isGitRepo(repoDir))) {
      delete ledger.slots[name]?.[info.placement];
      cleared += 1;
      continue;
    }
    if (await isDirty(dir)) {
      notes.push(`slot ${info.placement}（${name}）有未提交改动，保持绑定请人工处理`);
      ledger.slots[name][info.placement] = { task, branch: info.branch, since: entry.assignedAt, state: 'bound', slot: info.placement };
      continue;
    }
    await runGit(['checkout', '--detach', info.base], { cwd: dir });
    if (await mergedStatus(repoDir, info.branch, info.base)) {
      await runGit(['branch', '-d', info.branch], { cwd: repoDir });
    }
    delete ledger.slots[name][info.placement];
    cleared += 1;
  }
  delete ledger.tasks[task];
  writeWorkspaces(ws, ledger);
  return { cleared, notes };
}

/**
 * 基线分析镜像（设计期源码阅读，2026-11-16 真实场景驱动）：
 * BA/SA/RR 与 fix 质量门需要基于基线分支读源码，但主工作树常被在途任务占用、
 * slot 是任务开发资源——分析是只读且基于确定性基线分支的，不值得占 slot。
 * 为每仓维护常驻镜像 `.worktrees/<repo>/_baseline`（detached 停在基线分支 HEAD，
 * 固定名不参与 slot-N 轮换），多任务分析共享同一镜像，零分配逻辑。
 *
 * 返回 { created, reused, updated, notes, mirrors: [{source, path, base, sha}] }。
 */
export async function ensureBaselineMirrors(ws, kit) {
  const result = { created: [], reused: [], updated: [], notes: [], mirrors: [] };
  for (const source of kit?.sources ?? []) {
    const repoDir = path.join(ws, source.path);
    if (!fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) {
      result.notes.push(`${source.name}：仓不可用，无分析镜像（设计期源码分析受限）`);
      continue;
    }
    const base = await resolveBase(repoDir, source) ?? 'HEAD';
    const baseSha = (await runGit(['rev-parse', '--short', base], { cwd: repoDir })).stdout.trim();
    const dir = path.join(worktreeRoot(ws, source.name), '_baseline');
    if (!fs.existsSync(dir)) {
      excludeFromRootRepo(ws);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const r = await runGit(['worktree', 'add', '--detach', dir, base], { cwd: repoDir });
      if (r.code !== 0) {
        result.notes.push(`${source.name}：分析镜像创建失败：${(r.stderr || '').trim().split('\n')[0]}`);
        continue;
      }
      result.created.push({ source: source.name, path: dir });
    } else if (await isDirty(dir)) {
      // 镜像被弄脏：不切换不更新，提示人工恢复（分析镜像是共享只读资源）
      result.notes.push(`${source.name}：分析镜像有未提交改动（共享只读资源被污染），请人工处理：${dir}`);
    } else {
      const head = (await runGit(['rev-parse', base], { cwd: repoDir })).stdout.trim();
      const cur = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
      if (head !== cur) {
        // 基线前进（主树 pull 过）→ 镜像跟随到最新基线提交
        const co = await runGit(['checkout', '--detach', base], { cwd: dir });
        if (co.code === 0) result.updated.push({ source: source.name, path: dir });
        else result.notes.push(`${source.name}：分析镜像跟随基线失败：${(co.stderr || '').trim().split('\n')[0]}`);
      } else {
        result.reused.push({ source: source.name, path: dir });
      }
    }
    const sha = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim();
    result.mirrors.push({ source: source.name, path: dir, base, sha: sha || baseSha });
  }
  return result;
}

/** 「源码分析基线（只读镜像）」剧本节（注入 propose/fix 剧本；无镜像时返回空串不打扰）。 */
/**
 * 任务专属分析基点（--base 按仓指定分支，2026-11-16 真实需求）：
 * "这个任务基于 backend 的 release/1.2、frontend 的 dev 分析"。
 * 不切换共享镜像（镜像多任务共享，切换需长期锁定会把分析管线串行化）——
 * 改为给该任务建专属只读工作区 `.worktrees/<仓>/_task-<任务>/`（detached 停在指定分支），
 * 任务独占无锁、随任务归档回收。spec 落盘 .harness/deliverables/<任务>/analysis-base.json，
 * 重跑 propose 不传 --base 时按已落盘 spec 幂等重建。
 */
const taskAnalysisDir = (ws, repo, task) => path.join(worktreeRoot(ws, repo), `_task-${task}`);
const taskAnalysisSpecPath = (ws, task) => path.join(harnessDir(ws), 'deliverables', task, 'analysis-base.json');

/** 列某仓可选分支（面板新建任务的分析基点下拉）：本地 + origin 远端（去重、去 HEAD、上限 100）。 */
export async function listGitBranches(ws, source, { timeoutMs = 5000 } = {}) {
  const repoDir = path.join(ws, source.path);
  if (!fs.existsSync(repoDir)) return [];
  // Don't run a separate isGitRepo probe: these two reads already fail fast on
  // a non-repo, and on Windows each git spawn is the expensive part.
  const [local, remote] = await Promise.all([
    runGit(['branch', '--format=%(refname:short)'], { cwd: repoDir, timeoutMs }),
    runGit(['branch', '-r', '--format=%(refname:short)'], { cwd: repoDir, timeoutMs }),
  ]);
  const out = new Set();
  if (local.code === 0) for (const b of local.stdout.split('\n')) if (b.trim()) out.add(b.trim());
  if (remote.code === 0) {
    for (const b of remote.stdout.split('\n')) {
      const name = b.trim();
      if (!name || name.endsWith('/HEAD')) continue;
      out.add(name.replace(/^origin\//, ''));
    }
  }
  return [...out].slice(0, 100);
}

/** 列全部 source 仓的分支清单：{ <repo>: [branch…] }（面板新建任务模态框用）。 */
export async function listAllGitBranches(ws, kit) {
  const entries = await Promise.all((kit?.sources ?? []).map(async (source) => {
    try { return [source.name, await listGitBranches(ws, source)]; } catch { return [source.name, []]; }
  }));
  return Object.fromEntries(entries);
}

/** 解析 --base 旗标值："backend:release/1.2,frontend:dev" → {backend:'release/1.2',...}；坏段忽略。 */
export function parseBaseSpec(raw) {
  const out = {};
  if (typeof raw !== 'string') return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const branch = pair.slice(idx + 1).trim();
    if (name && branch) out[name] = branch;
  }
  return out;
}

/** 建/切任务专属分析工作区。overrides 为空时读已落盘 spec。返回 {created,reused,switched,notes,worktrees}。 */
export async function ensureTaskAnalysisWorktrees(ws, kit, task, overrides = null) {
  const result = { created: [], reused: [], switched: [], notes: [], worktrees: [] };
  let spec = overrides && Object.keys(overrides).length > 0 ? overrides : null;
  if (!spec) {
    try { spec = JSON.parse(fs.readFileSync(taskAnalysisSpecPath(ws, task), 'utf8')); }
    catch { return result; }
    if (!spec || typeof spec !== 'object') return result;
  }
  // 落盘 spec（重跑 propose 不传 --base 也能幂等重建；任务归档时随活目录一起清掉）
  fs.mkdirSync(path.dirname(taskAnalysisSpecPath(ws, task)), { recursive: true });
  fs.writeFileSync(taskAnalysisSpecPath(ws, task), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  for (const [repoName, branch] of Object.entries(spec)) {
    const source = (kit?.sources ?? []).find((s) => s.name === repoName);
    const repoDir = source ? path.join(ws, source.path) : null;
    if (!repoDir || !fs.existsSync(repoDir) || !(await isGitRepo(repoDir))) {
      result.notes.push(`${repoName}：仓不可用，--base 分析工作区未建`);
      continue;
    }
    // 分支解析：本地分支 → 远端 origin/<分支>；都没有 → 提示
    let target = branch;
    if ((await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoDir })).code !== 0) {
      if ((await runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd: repoDir })).code === 0) {
        target = `origin/${branch}`;
      } else {
        result.notes.push(`${repoName}：--base 分支 ${branch} 不存在（本地与 origin 均无）`);
        continue;
      }
    }
    const dir = taskAnalysisDir(ws, repoName, task);
    if (fs.existsSync(dir)) {
      if (await isDirty(dir)) {
        result.notes.push(`${repoName}：本任务分析工作区有未提交改动，请人工处理：${dir}`);
      } else if ((await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
        === (await runGit(['rev-parse', target], { cwd: repoDir })).stdout.trim()) {
        result.reused.push({ source: repoName, path: dir });
      } else {
        const co = await runGit(['checkout', '--detach', target], { cwd: dir });
        if (co.code === 0) result.switched.push({ source: repoName, path: dir, branch });
        else result.notes.push(`${repoName}：分析工作区切分支失败：${(co.stderr || '').trim().split('\n')[0]}`);
      }
    } else {
      excludeFromRootRepo(ws);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const r = await runGit(['worktree', 'add', '--detach', dir, target], { cwd: repoDir });
      if (r.code !== 0) {
        result.notes.push(`${repoName}：分析工作区创建失败：${(r.stderr || '').trim().split('\n')[0]}`);
        continue;
      }
      result.created.push({ source: repoName, path: dir, branch });
    }
    result.worktrees.push({
      source: repoName, path: dir, branch,
      sha: (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim(),
    });
  }
  return result;
}

/** 回收任务专属分析工作区（归档/重建清理；任务独占无合入问题，干净即删，脏则留给人）。 */
export async function removeTaskAnalysisWorktrees(ws, kit, task) {
  const out = { removed: 0, notes: [] };
  for (const source of kit?.sources ?? []) {
    const dir = taskAnalysisDir(ws, source.name, task);
    const repoDir = path.join(ws, source.path);
    if (!fs.existsSync(dir)) continue;
    if (!(await isGitRepo(repoDir))) { fs.rmSync(dir, { recursive: true, force: true }); out.removed += 1; continue; }
    if (await isDirty(dir)) {
      out.notes.push(`${source.name}：任务分析工作区有未提交改动，保留待人工处理：${dir}`);
      continue;
    }
    await runGit(['worktree', 'remove', '--force', dir], { cwd: repoDir });
    out.removed += 1;
  }
  return out;
}

export function renderAnalysisNotice(res, taskRes = null) {
  if ((!res || (res.mirrors?.length ?? 0) === 0) && (taskRes?.worktrees?.length ?? 0) === 0) return '';
  const lines = ['### 源码分析基线（只读，设计期专用）'];
  if (res && (res.mirrors?.length ?? 0) > 0) {
    lines.push('- BA/SA/RR 与质量门评估**只读**以下镜像（常驻检出基线分支，多任务共享）：',
      ...res.mirrors.map((m) => `  - ${m.source} → \`${m.path}\`（基线 \`${m.base}\` @ ${m.sha}）`));
  }
  if ((taskRes?.worktrees?.length ?? 0) > 0) {
    lines.push('- 本任务**专属**分析工作区（--base 指定，任务独占，勿改勿切分支）：',
      ...taskRes.worktrees.map((w) => `  - ${w.source} → \`${w.path}\`（\`${w.branch}\` @ ${w.sha}）`));
  }
  lines.push('- 禁止修改/切换上述目录；也不要读 \`services/\` 主工作树与其他任务 slot 的未提交改动——那些不属于本任务的分析上下文。',
    '- 若需调整共享镜像的分析基点：让人在面板设置页调整该仓基线分支后重跑 /hk-propose（镜像自动跟随新基线）。');
  for (const n of [...(res?.notes ?? []), ...(taskRes?.notes ?? [])]) lines.push(`- ⚠️ ${n}`);
  return lines.join('\n');
}

/**
 * 生成「并行工作区」剧本节（纯函数）：告知 PM/Worker 各仓工作区在哪、红线是什么。
 * 无分配（无 sources）时返回空串。
 */
export function renderWorkspaceNotice(res, task) {
  const lines = [];
  const assigned = res?.assigned ?? [];
  if (assigned.length === 0 && (res?.refused ?? []).length === 0) return '';
  lines.push('### 并行工作区（源码红线）');
  lines.push('- 各仓工作区分配：**developer 写源码只进分配给自己的目录，其余目录（主工作树/其他 slot/其他仓）一律只读**：');
  for (const w of assigned) {
    const where = w.placement === 'main'
      ? (w.branch
          ? `主工作树 \`${w.path}\`（分支 \`${w.branch}\`，基点 \`${w.base}\`${w.ready ? '；内核已切好' : '；开工前从该基点新建分支'}）`
          : `主工作树 \`${w.path}\`（非 git 仓，直接工作）`)
      : `池化 worktree \`${w.path}\`（分支 \`${w.branch}\`，内核已切好；slot 常驻复用，不要删目录）`;
    lines.push(`  - ${w.source} → ${where}`);
  }
  lines.push('- worktree slot 由内核在归档时切回基线释放（不删目录，依赖/构建缓存保持热态）；不要手工删 slot 目录、不要在里面放与工作无关的私货。');
  for (const o of res?.overlaps ?? []) {
    lines.push(`- ⚠️ 与在途任务 **${o.task}** 在 ${o.source} 上已改文件重叠（${o.files.slice(0, 5).join('、')}${o.files.length > 5 ? ' 等' : ''}）：两任务同文件并发修改必冲突，开工前先向人确认裁决顺序。`);
  }
  for (const n of res?.notes ?? []) {
    lines.push(`- ⚠️ ${n}`);
  }
  for (const f of res?.refused ?? []) {
    lines.push(`- ⛔ ${f.source}：${f.reason}`);
  }
  return lines.join('\n');
}
