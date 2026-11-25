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

const ok = (text, extra) => ({ kind: 'success', text, ...(extra ?? {}) });
const fail = (text) => ({ kind: 'error', text });

// 资产同步防误删：一次同步删除太多已跟踪文件，通常不是正常业务变更，而是本地 clone
// 不完整/工作区被误删/打开了错误目录。宁可挡住让人确认，也不要自动 commit+push。
const MASS_DELETE_MIN = 10;
const MASS_DELETE_RATIO = 0.05;
const CORE_ASSET_DIRS = ['specs/', 'memory/', 'tasks/', 'codebase-guide/'];

const SUSPICIOUS_RE = /(^|\/)(?:\.env(?:\..*)?|\.DS_Store|id_rsa.*|.*\.(?:log|tmp|draft\.md|key|pem|p12|pfx))$/i;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/** 把 git status 的 -z 输出拆成 已跟踪/未跟踪/删除 三类（preview 与 apply 共用）。 */
export function parseAssetStatus(raw, hd) {
  const tracked = [];
  const untracked = [];
  const deleted = [];
  const parts = String(raw ?? '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    const code = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (!rel) continue;
    if (code[0] === 'R' || code[0] === 'C') i += 1; // 下一段是旧路径
    const item = { path: rel, status: code };
    if (code === '??') {
      item.suspicious = SUSPICIOUS_RE.test(rel);
      try {
        const st = fs.statSync(path.join(hd, rel));
        item.bytes = st.size;
        item.large = st.isFile() && st.size > LARGE_FILE_BYTES;
      } catch { /* ignore */ }
      untracked.push(item);
    } else if (code.includes('D')) deleted.push(item);
    else tracked.push(item);
  }
  return { tracked, untracked, deleted };
}

function safePaths(hd, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return { error: '未选择要提交的文件' };
  const out = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) return { error: '提交路径为空' };
    const rel = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    if (rel.startsWith('/') || rel.split('/').includes('..')) return { error: `非法路径：${raw}` };
    const abs = path.resolve(hd, rel);
    if (abs !== hd && !abs.startsWith(hd + path.sep)) return { error: `路径越界：${raw}` };
    out.push(rel);
  }
  return { paths: [...new Set(out)] };
}

/**
 * 同步前安全检查（导出供测试）。
 * @returns {Promise<{ok:true, tracked:number, deleted:string[]}|{ok:false, text:string}>}
 */
export async function checkSyncSafety(hd, { allowDeletions = false, paths = null } = {}) {
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
  const allDeleted = [...new Set(delOut.flatMap((r) => (r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [])))];
  const deleted = Array.isArray(paths) ? allDeleted.filter((f) => paths.includes(f)) : allDeleted;
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

/** 同步预览：只读 git status，供 UI 让用户勾选要提交的文件。 */
export async function previewSync(ws) {
  const hd = path.join(ws, '.harness');
  if (!fs.existsSync(path.join(hd, '.git'))) {
    return fail('资产目录 `.harness/` 没有独立 git（embedded/本地模式），面板同步不适用。');
  }
  const g = (args) => runGit(args, { cwd: hd, timeoutMs: 30_000 });
  const branch = (await g(['branch', '--show-current'])).stdout.trim() || 'unknown';
  const raw = await g(['status', '--porcelain=v1', '-z']);
  if (raw.code !== 0) return fail(`读取 git status 失败：${raw.stderr || raw.stdout}`);
  const files = parseAssetStatus(raw.stdout, hd);
  return ok(`待提交 ${files.tracked.length + files.untracked.length + files.deleted.length} 个文件`, {
    preview: { branch, ...files },
  });
}

/**
 * 仅拉取远端：不提交、不 push。
 *
 * 工作区常有未提交的资产改动（看板/交付物正在编辑），原先“脏就拒绝”会让面板的
 * 「拉取」按钮必然失败。这里用 `--autostash` 把本地改动暂存，rebase 完再恢复：
 * - 双方改动不重叠（常见：各自改看板不同行）→ 自动合并，工作区仍保持未提交；
 * - 重叠冲突 → 远端更新已落地、原改动保留在 stash，返回可执行的冲突指引。
 */
export async function pullAssets(ws, kit) {
  const hd = path.join(ws, '.harness');
  if (!fs.existsSync(path.join(hd, '.git'))) {
    return fail('资产目录 `.harness/` 没有独立 git，面板拉取不适用；请在根仓库 git pull。');
  }
  const g = (args) => runGit(args, { cwd: hd, timeoutMs: 120_000 });
  const remotes = (await g(['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (remotes.length === 0) return fail('资产仓库尚无远端，无法拉取。');
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const currentBranch = (await g(['branch', '--show-current'])).stdout.trim();
  const branch = kit?.assets?.branch || currentBranch || 'master';
  if (currentBranch && currentBranch !== branch) {
    return fail(`当前分支 ${currentBranch} 与 kit.json 要求的 ${branch} 不一致；请先切换分支再拉取。`);
  }
  const dirty = !!(await g(['status', '--porcelain'])).stdout.trim();
  const fetched = await g(['fetch', remote, branch]);
  if (fetched.code !== 0) {
    const out = fetched.stderr || fetched.stdout;
    if (/couldn't find remote ref|does not appear to be/i.test(out)) return ok(`远端暂无 ${branch} 分支，无需拉取。`);
    return fail(`fetch 失败（未提交任何本地文件）：\n${out}`);
  }
  const pull = await g(['pull', '--rebase', '--autostash', remote, branch]);
  const out = pull.stderr || pull.stdout;
  const conflicts = (await g(['diff', '--name-only', '--diff-filter=U'])).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  if (pull.code !== 0 || conflicts.length > 0) {
    if (/couldn't find remote ref|does not appear to be/i.test(out)) {
      return ok(`远端暂无 ${branch} 分支，无需拉取。`);
    }
    if (conflicts.length > 0) {
      const rebasing = fs.existsSync(path.join(hd, '.git', 'rebase-merge'))
        || fs.existsSync(path.join(hd, '.git', 'rebase-apply'));
      return fail(
        `已拉取远端提交，但本地未提交改动与远端冲突（未覆盖你的任何改动）：\n${conflicts.map((f) => `- \`${f}\``).join('\n')}\n\n` +
          (rebasing
            ? `rebase 仍在进行中。解决冲突后执行 \`git add <文件> && git rebase --continue\`；如需放弃本次 rebase 回到拉取前状态：\`git rebase --abort\`（本地改动仍在 stash）。`
            : '冲突标记已写入上述文件；解决后执行 `git add <文件>`，确认无误再 `git stash drop` 丢弃 autostash 副本。') +
          '\n原改动完整保存在 `git stash` 中（标记 `autostash`），不会丢失。',
      );
    }
    if (/untracked working tree files would be overwritten/i.test(out)) {
      return fail(
        `远端新增的文件与本地未跟踪文件同名，已停止拉取（未覆盖本地文件）。请先移动/改名或提交这些本地文件后重试：\n${out}`,
      );
    }
    return fail(`拉取失败（未提交任何本地文件）：\n${out}`);
  }
  if (/already up[ -]to[ -]date/i.test(pull.stdout + pull.stderr)) {
    return ok('远端无新提交。');
  }
  return ok(dirty
    ? '已拉取并 rebase 远端提交；本地未提交变更已自动暂存并恢复。'
    : '已拉取并 rebase 远端提交。');
}

export async function syncAssets(ws, kit, { allowDeletions = false, paths = null } = {}) {
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

  const safety = await checkSyncSafety(hd, { allowDeletions, paths });
  if (!safety.ok) return fail(safety.text);

  const steps = [];

  // 1. 提交本地变更（显式选择时只提交所选路径；旧调用仍可 commit-all）
  let stageArgs;
  if (Array.isArray(paths)) {
    const safe = safePaths(hd, paths);
    if (safe.error) return fail(safe.error);
    const scoped = await g(['status', '--porcelain', '--', ...safe.paths]);
    if (!scoped.stdout.trim()) return fail('所选文件已无未提交变更，请重新预览。');
    stageArgs = ['add', '-A', '--', ...safe.paths];
  } else {
    stageArgs = ['add', '-A'];
  }
  if ((await g(['status', '--porcelain'])).stdout.trim()) {
    await g(stageArgs);
    const msg = `harness: sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const c = await g(['commit', '-m', msg]);
    if (c.code !== 0) return fail(`自动提交失败：\n${c.stderr || c.stdout}`);
    steps.push(`自动提交本地变更（\`${msg}\`）`);
  }

  // 2. pull --rebase（选中路径提交时可能仍有未选中的脏文件；用 autostash 避免拉取被它阻断）
  const pull = await g(['pull', '--rebase', '--autostash', remote, branch]);
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
      } else if (/untracked working tree files would be overwritten/i.test(out)) {
        return fail(`远端新增文件与本地未跟踪文件同名，已停止同步（未覆盖本地文件）：\n${out}\n请先移动/改名或提交这些文件后重试。`);
      } else {
        return fail(`git pull --rebase 失败（无冲突标记，疑似网络/认证问题）：\n${out}`);
      }
    }
  } else {
    const leftovers = (await g(['diff', '--name-only', '--diff-filter=U'])).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (leftovers.length > 0) {
      return fail(
        `已拉取远端并 rebase 本地提交，但未选中的本地改动与远端冲突：\n${leftovers.map((f) => `- \`${f}\``).join('\n')}\n\n` +
          '原改动已保存在 autostash 中，不会丢失。解决上述文件的冲突并 `git add` 后，执行 `git stash drop` 丢弃 autostash 副本，再重跑 `/hk-sync`。',
      );
    }
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
