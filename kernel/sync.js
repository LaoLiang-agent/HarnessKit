// /hk-sync：资产仓库 git 同步 —— 自动提交本地变更 → pull --rebase →
// 纯追加文件三路自动合并 → push。非纯追加冲突中止 rebase 回滚、转人工。
// 说明：git 由插件 handler 直接 spawn（不经 bash 工具审批链），/hk-sync 本身是
// 显式用户命令即授权；归档后自动触发需 kit.json assets.autoSync=true 显式开启，
// 且所有 git 操作与结果都写入命令返回文本。
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './exec.js';

const APPEND_ONLY_FILES = new Set(['memory/index.md', 'specs/_index.md', 'tasks/board.md', 'tasks/claims.json']);
const APPEND_ONLY_RE = /^deliverables\/_archive\/[^/]+\/rounds\.md$/;

export function isAppendOnly(rel) {
  return APPEND_ONLY_FILES.has(rel) || APPEND_ONLY_RE.test(rel);
}

const ok = (text) => ({ kind: 'success', text });
const fail = (text) => ({ kind: 'error', text });

// 资产同步防误删：一次同步删除太多已跟踪文件，通常不是正常业务变更，而是本地 clone
// 不完整/工作区被误删/打开了错误目录。宁可挡住让人确认，也不要自动 commit+push。
const MASS_DELETE_MIN = 10;
const MASS_DELETE_RATIO = 0.05;
const CORE_ASSET_DIRS = ['specs/', 'memory/', 'tasks/', 'codebase-guide/'];

/**
 * 同步前安全检查（导出供测试）。
 * @returns {Promise<{ok:true, tracked:number, deleted:string[]}|{ok:false, text:string}>}
 */
export async function checkSyncSafety(hd, { allowDeletions = false } = {}) {
  const g = (args) => runGit(args, { cwd: hd, timeoutMs: 30_000 });
  const shallow = await g(['rev-parse', '--is-shallow-repository']);
  if (shallow.code === 0 && shallow.stdout.trim() === 'true') {
    return { ok: false, text: '资产仓库是浅克隆（shallow clone），可能缺少历史资产，已阻止同步。请重新完整 clone `.harness` 后再试。' };
  }
  const sparse = await g(['config', '--bool', 'core.sparseCheckout']);
  if (sparse.code === 0 && sparse.stdout.trim() === 'true') {
    return { ok: false, text: '资产仓库启用了 sparse checkout，工作区可能只包含部分资产，已阻止同步。请关闭 sparse checkout 或重新完整 clone。' };
  }
  const trackedOut = await g(['ls-files']);
  const tracked = trackedOut.code === 0 ? trackedOut.stdout.split('\n').filter(Boolean).length : 0;
  const delOut = await Promise.all([
    g(['diff', '--name-only', '--diff-filter=D']),
    g(['diff', '--cached', '--name-only', '--diff-filter=D']),
  ]);
  const deleted = [...new Set(delOut.flatMap((r) => (r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [])))];
  if (allowDeletions || deleted.length === 0) return { ok: true, tracked, deleted };
  // 只对核心资产做“批量删除”硬拦截：deliverables 的任务目录归档删除是正常操作，
  // 不应因为一次移动 10+ 个交付物文件而误伤。clone 不完整通常会同时丢掉 specs/memory/tasks。
  const coreDeletes = deleted.filter((f) => CORE_ASSET_DIRS.some((d) => f.startsWith(d)));
  const ratio = tracked > 0 ? coreDeletes.length / tracked : 0;
  const mass = coreDeletes.length >= MASS_DELETE_MIN || (coreDeletes.length >= 3 && ratio >= MASS_DELETE_RATIO);
  if (!mass) return { ok: true, tracked, deleted };
  const sample = coreDeletes.slice(0, 8).map((f) => `- \`${f}\``).join('\n');
  return {
    ok: false,
    text: `检测到 ${coreDeletes.length} 个核心资产文件被删除（specs/memory/tasks/codebase-guide，占仓库 ${Math.round(ratio * 100)}%），已阻止同步。\n` +
      `deliverables 的归档移动不在此拦截范围；这通常意味着资产仓库 clone 不完整、工作区文件被误删，或打开了错误的目录。\n${sample}${coreDeletes.length > 8 ? '\n- …' : ''}\n\n` +
      `请先检查 \`git status\`；确认是正常批量删除后，运行 \`/hk-sync --allow-deletions\`。`,
  };
}

/**
 * 资产布局探测（.harness 的 git 归属）：
 * - 'repo'     ：.harness 自带 .git（独立资产仓库，/hk-sync 作用对象）
 * - 'embedded' ：.harness 无独立 .git，但被工作区某级父 git 仓库跟踪（随根仓库共享，
 *               同步走根仓库的 commit/push，/hk-sync 不适用）
 * - 'plain'    ：纯本地，无任何 git 管理
 * @returns {Promise<{layout:'repo'|'embedded'|'plain', repoRoot?:string, rel?:string}>}
 *   repoRoot = 跟踪 .harness 的仓库根；rel = .harness 相对该根的路径（多为 '.harness'）
 */
export async function assetsLayout(ws) {
  const hd = path.join(ws, '.harness');
  if (fs.existsSync(path.join(hd, '.git'))) return { layout: 'repo' };
  if (!fs.existsSync(hd)) return { layout: 'plain' };
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: hd, timeoutMs: 15_000 });
  if (top.code !== 0 || !top.stdout.trim()) return { layout: 'plain' };
  // macOS /var→/private/var 等符号链接：git 返回 realpath，两侧统一后再求相对路径
  const repoRoot = fs.realpathSync(top.stdout.trim());
  const rel = path.relative(repoRoot, fs.realpathSync(hd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { layout: 'plain' };
  // 物理嵌套不等于被跟踪：父仓库必须真的管理 .harness 下的文件
  const tracked = await runGit(['ls-files', '--', rel], { cwd: repoRoot, timeoutMs: 15_000 });
  if (tracked.code !== 0 || !tracked.stdout.trim()) return { layout: 'plain' };
  return { layout: 'embedded', repoRoot, rel };
}

export async function syncAssets(ws, kit, { allowDeletions = false } = {}) {
  const hd = path.join(ws, '.harness');
  const g = (args) => runGit(args, { cwd: hd, timeoutMs: 300_000 });

  if (!fs.existsSync(path.join(hd, '.git'))) {
    const lay = await assetsLayout(ws);
    if (lay.layout === 'embedded') {
      return fail(
        `资产目录 \`.harness/\` 无独立 git，已随工作区根仓库（\`${lay.repoRoot}\`）管理：资产变更直接在根仓库 commit/push 即共享，\`/hk-sync\` 不适用。` +
          '如需拆分为独立资产仓库：建空远端后 `cd .harness && git init && git remote add origin <url>`，重跑 `/hk-init` 自动接管首推，再把根仓库里的 `.harness/` 移出跟踪（`git rm -r --cached .harness` + .gitignore）。',
      );
    }
    return fail(
      '资产目录 `.harness/` 未绑定 git（当前为本地模式）。绑定方式：新工作区用 `/hk-init --assets <url|init>`；' +
        '既有目录可手工 `cd .harness && git init && git remote add origin <url>` 后重跑 `/hk-init` 自动回填 kit.json，再执行 `/hk-sync`。',
    );
  }
  const remotes = (await g(['remote'])).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (remotes.length === 0) {
    return fail('资产仓库尚无远端：`cd .harness && git remote add origin <团队资产仓库 URL>` 后重试 `/hk-sync`。');
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const currentBranch = (await g(['branch', '--show-current'])).stdout.trim();
  const branch = kit?.assets?.branch || currentBranch || 'master';
  if (currentBranch && currentBranch !== branch) {
    return fail(
      `资产仓库当前在 \`${currentBranch}\` 分支，但 kit.json 要求同步到 \`${branch}\`；` +
        `为避免把 \`${currentBranch}\` 的提交误推到 \`${branch}\`，已阻止同步。` +
        `请先执行 \`cd .harness && git switch ${branch}\`（或修正 kit.json 的 assets.branch）后重试。`,
    );
  }

  const safety = await checkSyncSafety(hd, { allowDeletions });
  if (!safety.ok) return fail(safety.text);

  const steps = [];

  // 1. 自动提交本地变更（资产仓库为 harness 专有，提交信息显式标注）
  if ((await g(['status', '--porcelain'])).stdout.trim()) {
    await g(['add', '-A']);
    const msg = `harness: sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const c = await g(['commit', '-m', msg]);
    if (c.code !== 0) return fail(`自动提交失败：\n${c.stderr || c.stdout}`);
    steps.push(`自动提交本地变更（\`${msg}\`）`);
  }

  // 2. pull --rebase
  const pull = await g(['pull', '--rebase', remote, branch]);
  if (pull.code !== 0) {
    const out = pull.stderr || pull.stdout;
    if (/couldn't find remote ref|does not appear to be/i.test(out)) {
      steps.push(`远端暂无 \`${branch}\` 分支（首次同步）`);
    } else {
      const conflicts = (await g(['diff', '--name-only', '--diff-filter=U'])).stdout
        .trim()
        .split('\n')
        .filter(Boolean);
      if (conflicts.length > 0 && conflicts.every(isAppendOnly)) {
        // 纯追加自动三路合并：ours = base+A、theirs = base+B ⇒ base+A+B
        const merged = [];
        for (const f of conflicts) {
          const base = (await g(['show', `:1:${f}`])).stdout;
          const ours = (await g(['show', `:2:${f}`])).stdout;
          const theirs = (await g(['show', `:3:${f}`])).stdout;
          if (!ours.startsWith(base) || !theirs.startsWith(base)) {
            await g(['rebase', '--abort']);
            return fail(
              `\`${f}\` 虽在纯追加白名单，但实际改动含改写/删除（非 base 前缀追加），已中止 rebase 回滚到同步前状态，请人工处理：\`cd .harness && git pull --rebase ${remote} ${branch}\``,
            );
          }
          fs.writeFileSync(path.join(hd, f), ours + theirs.slice(base.length), 'utf8');
          await g(['add', f]);
          merged.push(f);
        }
        const cont = await g(['-c', 'core.editor=true', 'rebase', '--continue']);
        if (cont.code !== 0) {
          await g(['rebase', '--abort']);
          return fail(`自动合并后 \`rebase --continue\` 失败，已回滚到同步前状态：\n${cont.stderr || cont.stdout}`);
        }
        steps.push(`纯追加冲突自动三路合并：${merged.map((f) => `\`${f}\``).join('、')}`);
      } else if (conflicts.length > 0) {
        await g(['rebase', '--abort']);
        return fail(
          `以下文件冲突，超出纯追加自动合并范围，已中止 rebase 回滚到同步前状态，转人工处理：\n${conflicts.map((f) => `- \`${f}\``).join('\n')}\n\n手工步骤：\`cd .harness && git pull --rebase ${remote} ${branch}\`，解冲突后 \`git rebase --continue && git push ${remote} ${branch}\`，或修复后重跑 \`/hk-sync\`。`,
        );
      } else {
        return fail(`git pull --rebase 失败（无冲突标记，疑似网络/认证问题）：\n${out}`);
      }
    }
  } else {
    steps.push(/already up[ -]to[ -]date/i.test(pull.stdout + pull.stderr) ? '远端无新提交' : '已 rebase 远端新提交');
  }

  // 3. push
  const push = await g(['push', remote, `HEAD:${branch}`]);
  if (push.code !== 0) {
    return fail(
      `push 失败（本地 rebase 结果已保留，未丢失；请检查权限/远端后重试 \`/hk-sync\`）：\n${push.stderr || push.stdout}`,
    );
  }
  steps.push('已 push 到远端');

  return ok(`资产同步完成（\`${remote}/${branch}\`）：\n${steps.map((s) => `- ${s}`).join('\n')}`);
}
