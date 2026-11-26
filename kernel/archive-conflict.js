// 归档冲突：把“合并失败”变成可恢复的人机裁决点。
//
// 设计约束（2026-11-26 与用户定稿）：
//   - 只在本机保留冲突现场（.harness/local/archive-conflict.json），不进共享看板；
//   - 不自动替用户选源码版本；只有双方新增内容完全一致时才给出高置信建议；
//   - 用户只需在“保留目标版本 / 保留任务版本 / 手动处理 / 暂不归档”里选；
//   - 恢复后必须校验：无未合并文件、无冲突标记，再提交合并并继续归档。
import fs from 'node:fs';
import path from 'node:path';
import { localStatePath } from './paths.js';
import { runGit } from './exec.js';

const statePath = (ws) => localStatePath(ws, 'archive-conflict.json', 'tasks/archive-conflict.json');

/** 本机全部归档冲突：{ version, tasks: { <task>: record } }。 */
export function readArchiveConflicts(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(ws), 'utf8'));
    if (data?.version !== 1 || typeof data.tasks !== 'object' || data.tasks === null) return { version: 1, tasks: {} };
    return data;
  } catch {
    return { version: 1, tasks: {} };
  }
}

export function readTaskArchiveConflict(ws, task) {
  return readArchiveConflicts(ws).tasks?.[task] ?? null;
}

function writeArchiveConflicts(ws, data) {
  const file = statePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, tasks: data.tasks ?? {} }, null, 2)}\n`, 'utf8');
}

export function setTaskArchiveConflict(ws, task, record) {
  const data = readArchiveConflicts(ws);
  data.tasks[task] = { ...record, task, updatedAt: new Date().toISOString() };
  writeArchiveConflicts(ws, data);
  return data.tasks[task];
}

export function clearTaskArchiveConflict(ws, task) {
  const data = readArchiveConflicts(ws);
  if (!(task in data.tasks)) return;
  delete data.tasks[task];
  writeArchiveConflicts(ws, data);
}


// --------------------------------------------------------------- 现场采集

async function lastCommit(repoDir, ref, file) {
  const r = await runGit(
    ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%ad%x1f%B', '--date=short', ref, '--', file],
    { cwd: repoDir, timeoutMs: 15_000 },
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const parts = r.stdout.split('\x1f');
  return {
    hash: parts[0] ?? '',
    subject: (parts[1] ?? '').trim(),
    author: (parts[2] ?? '').trim(),
    date: (parts[3] ?? '').trim(),
    body: parts.slice(4).join('\x1f').trim(),
  };
}

async function blobText(repoDir, stage, file) {
  const r = await runGit(['show', `:${stage}:${file}`], { cwd: repoDir, timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  if (r.stdout.includes('\0')) return null; // 二进制文件不参与行级判断
  return r.stdout;
}

function lineSet(text) {
  return new Set(String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
}

function baselineHint(commit) {
  const text = `${commit?.subject ?? ''}\n${commit?.body ?? ''}`;
  return /(?:基线.*(?:编译|缺失)|补齐.*基线|缺失文件|missing\s+file|baseline.*(?:compile|fix)|compile.*(?:fix|error))/i.test(text);
}

function sideLabel(side) {
  return side === 'task' ? '任务版本' : '目标版本';
}

const STATUS_LABEL = {
  AA: '双方都新增',
  UU: '双方都修改',
  DU: '目标删除 / 任务修改',
  UD: '目标修改 / 任务删除',
  AU: '目标新增 / 任务修改',
  UA: '目标修改 / 任务新增',
  DD: '双方都删除',
};

/**
 * 采集冲突文件的双方提交、差异规模与建议。
 * 必须在 merge --abort 之前调用（需要 :2:/:3: 阶段内容）。
 */
export async function inspectConflict(repoDir, target, branch) {
  const names = (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: repoDir }))
    .stdout.trim().split('\n').filter(Boolean);
  if (names.length === 0) return [];

  const statuses = new Map();
  const status = await runGit(['status', '--porcelain=v1', '-z'], { cwd: repoDir });
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.includes('U') || code === 'AA' || code === 'DD') statuses.set(file, code);
  }

  const files = [];
  for (const file of names) {
    const code = statuses.get(file) ?? 'UU';
    const ours = await lastCommit(repoDir, target, file);
    const theirs = await lastCommit(repoDir, branch, file);
    const oursText = await blobText(repoDir, 2, file);
    const theirsText = await blobText(repoDir, 3, file);
    const oursLines = lineSet(oursText);
    const theirsLines = lineSet(theirsText);
    const uniqueTargetLines = [...oursLines].filter((l) => !theirsLines.has(l)).length;
    const uniqueTaskLines = [...theirsLines].filter((l) => !oursLines.has(l)).length;
    const sameBlob = oursText !== null && theirsText !== null && oursText === theirsText;

    let recommendation = null;
    if (sameBlob) {
      recommendation = { side: 'target', reason: '双方新增/修改后的内容完全一致，保留任意一份即可', confidence: 'high' };
    } else if (code === 'AA') {
      // 只把“任务侧是基线补丁”当作保留目标的信号；目标分支本来就可能包含
      // 缺失文件补丁，不能反过来据此推断任务侧才是业务版本。
      if (baselineHint(theirs)) {
        recommendation = { side: 'target', reason: '任务侧提交说明这是基线缺失/编译补丁，目标分支已有该文件', confidence: 'medium' };
      } else if (oursText !== null && theirsText !== null && uniqueTaskLines === 0) {
        recommendation = { side: 'target', reason: '任务版本没有目标版本之外的独有内容', confidence: 'medium' };
      } else if (oursText !== null && theirsText !== null && uniqueTargetLines === 0) {
        recommendation = { side: 'task', reason: '目标版本没有任务版本之外的独有内容', confidence: 'medium' };
      }
    }

    const slim = (c) => c ? { hash: c.hash, subject: c.subject, author: c.author, date: c.date } : null;
    files.push({
      path: file,
      status: code,
      statusLabel: STATUS_LABEL[code] ?? '冲突',
      target: slim(ours),
      task: slim(theirs),
      sameBlob,
      uniqueTargetLines,
      uniqueTaskLines,
      recommendation,
    });
  }
  return files;
}

// --------------------------------------------------------------- 展示与决策

function shortCommit(commit) {
  if (!commit) return '（无提交记录）';
  return `${commit.hash} ${commit.subject}`.trim();
}

export function conflictSummaryLines(record) {
  const lines = [];
  for (const repo of record?.repos ?? []) {
    lines.push(`⛔ ${repo.repo} → ${repo.target}：${repo.files.length} 个文件冲突`);
    for (const file of repo.files) {
      lines.push(`- ${file.path}（${file.statusLabel}${file.status ? `/${file.status}` : ''}）`);
      lines.push(`  目标：${shortCommit(file.target)}`);
      lines.push(`  任务：${shortCommit(file.task)}`);
      if (file.uniqueTaskLines > 0) lines.push(`  任务侧独有内容：${file.uniqueTaskLines} 行`);
      if (file.recommendation) lines.push(`  建议：保留${sideLabel(file.recommendation.side)}——${file.recommendation.reason}`);
    }
  }
  return lines;
}

function totalFiles(record) {
  return (record?.repos ?? []).reduce((n, r) => n + r.files.length, 0);
}

function firstFile(record) {
  const repo = record?.repos?.find((r) => r.files.length > 0);
  return repo?.files?.[0] ?? null;
}

/** 生成面板决策点：文本 + 可点选项。 */
export function buildConflictDecision(task, record) {
  const count = totalFiles(record);
  const first = firstFile(record);
  const recommendation = count === 1 ? first?.recommendation ?? null : null;
  const repos = (record?.repos ?? []).map((r) => r.repo).join('、') || '工作区';
  const lines = [
    `归档被 ${count} 个文件挡住：${repos}`,
    ...conflictSummaryLines(record),
  ];
  if (count > 1) {
    lines.push('多个文件需要逐个判断；自动“全部保留某一边”可能丢代码，因此只提供手动处理。');
  }

  const options = [];
  if (count === 1) {
    if (recommendation) {
      options.push({
        label: `按建议保留${sideLabel(recommendation.side)}并继续`,
        line: `/hk-archive ${task} --resolve recommended`,
        primary: true,
      });
      options.push({
        label: `保留${sideLabel(recommendation.side === 'task' ? 'target' : 'task')}并继续`,
        line: `/hk-archive ${task} --resolve ${recommendation.side === 'task' ? 'ours' : 'theirs'}`,
      });
      options.push({ label: '手动处理（保留冲突现场）', line: `/hk-archive ${task} --resolve manual` });
    } else {
      options.push({ label: '手动处理（保留冲突现场）', line: `/hk-archive ${task} --resolve manual`, primary: true });
      options.push({ label: '保留目标版本并继续', line: `/hk-archive ${task} --resolve ours` });
      options.push({ label: '保留任务版本并继续', line: `/hk-archive ${task} --resolve theirs` });
    }
  } else {
    options.push({ label: '手动处理（保留冲突现场）', line: `/hk-archive ${task} --resolve manual`, primary: true });
  }
  options.push({ label: '暂不归档', line: `/hk-archive ${task} --abort` });

  return {
    kind: 'archive-conflict',
    code: 'archive-conflict',
    text: `${lines.join('\n')}\n\n选择后只会改动本地目标分支，不会 push。`,
    options,
  };
}

/** 已进入手动处理：只给“继续/中止”，不再重复展示选边按钮。 */
export function buildManualDecision(task, record) {
  const dirs = (record?.repos ?? []).map((r) => r.worktree).filter(Boolean);
  return {
    kind: 'archive-conflict',
    code: 'archive-conflict',
    text: [
      `冲突现场已保留：${dirs.join('、') || '(未记录工作树)'}`,
      '请在该工作树里编辑冲突文件，去掉冲突标记并保存；然后点“继续归档”。',
      '继续时内核会校验未合并文件、冲突标记，再提交本地合并；不会 push。',
    ].join('\n'),
    options: [
      { label: '我已完成，继续归档', line: `/hk-archive ${task} --continue`, primary: true },
      { label: '暂不归档（清理现场）', line: `/hk-archive ${task} --abort` },
    ],
  };
}

// --------------------------------------------------------------- 恢复动作

function markerFound(text) {
  return /^(?:<<<<<<<|=======|>>>>>>>)/m.test(text);
}

async function removeTempWorktree(repoDir, worktree) {
  if (!repoDir || !worktree) return;
  await runGit(['worktree', 'remove', '--force', worktree], { cwd: repoDir, timeoutMs: 20_000 });
  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* 目录残留不影响主流程 */ }
  await runGit(['worktree', 'prune'], { cwd: repoDir, timeoutMs: 20_000 });
}

/** 把 detached 临时工作树里的合并提交落到目标分支（目标被 checkout 时快进持有工作树）。 */
export async function updateTargetAfterDetached(repoDir, target, targetWorktree, baseCommit, commit) {
  const cur = (await runGit(['rev-parse', `refs/heads/${target}`], { cwd: repoDir, timeoutMs: 15_000 })).stdout.trim();
  if (baseCommit && cur !== baseCommit) {
    return { ok: false, error: `目标分支 ${target} 已前进（${baseCommit.slice(0, 8)} → ${cur.slice(0, 8)}），请重新归档以基于最新目标解决冲突。` };
  }
  if (targetWorktree) {
    const curBranch = (await runGit(['branch', '--show-current'], { cwd: targetWorktree, timeoutMs: 15_000 })).stdout.trim();
    if (curBranch !== target) {
      return { ok: false, error: `目标分支 ${target} 原先所在的 ${targetWorktree} 已切到 ${curBranch || '(detached)'}，请重新归档。` };
    }
    const r = await runGit(['merge', '--ff-only', commit], { cwd: targetWorktree, timeoutMs: 60_000 });
    if (r.code !== 0) {
      return { ok: false, error: `目标分支 ${target} 快进失败：${(r.stderr || r.stdout || '').trim().split('\n')[0]}` };
    }
  } else {
    const r = await runGit(['update-ref', `refs/heads/${target}`, commit, baseCommit || cur], { cwd: repoDir, timeoutMs: 15_000 });
    if (r.code !== 0) {
      return { ok: false, error: `目标分支 ${target} 更新失败：${(r.stderr || '').trim().split('\n')[0]}` };
    }
  }
  return { ok: true };
}

/** 中止冲突现场：回滚 merge、删除临时工作树、清状态。 */
export async function abortArchiveConflict(ws, task) {
  const record = readTaskArchiveConflict(ws, task);
  if (!record) return { ok: true, text: `任务 ${task} 没有待处理的归档冲突。` };
  for (const repo of record.repos ?? []) {
    if (!repo.worktree || !fs.existsSync(repo.worktree)) continue;
    await runGit(['merge', '--abort'], { cwd: repo.worktree, timeoutMs: 30_000 });
    if (repo.temp) await removeTempWorktree(repo.repoDir, repo.worktree);
  }
  clearTaskArchiveConflict(ws, task);
  return { ok: true, text: `已中止任务 ${task} 的归档冲突并清理临时工作树；目标分支未被改动。` };
}

/** 把冲突文件按选择 checkout 到一侧并暂存。 */
export async function applyConflictChoice(ws, task, mode) {
  const record = readTaskArchiveConflict(ws, task);
  if (!record) return { ok: false, error: `任务 ${task} 没有待处理的归档冲突。` };
  if (mode === 'recommended') {
    const missing = (record.repos ?? []).flatMap((r) => r.files.filter((f) => !f.recommendation?.side).map((f) => f.path));
    if (missing.length > 0) {
      return { ok: false, error: `${missing.slice(0, 6).join('、')} 没有高置信建议，请选择手动处理。` };
    }
  }
  for (const repo of record.repos ?? []) {
    if (!repo.worktree || !fs.existsSync(repo.worktree)) {
      return { ok: false, error: `冲突工作树不存在：${repo.worktree ?? '(未记录)'}` };
    }
    for (const file of repo.files) {
      let side;
      if (mode === 'recommended') {
        side = file.recommendation?.side;
        if (!side) return { ok: false, error: `${file.path} 没有高置信建议，请选择手动处理。` };
      } else if (mode === 'ours') side = 'target';
      else if (mode === 'theirs') side = 'task';
      else return { ok: false, error: `未知的解决方式：${mode}` };
      const flag = side === 'target' ? '--ours' : '--theirs';
      const co = await runGit(['checkout', flag, '--', file.path], { cwd: repo.worktree, timeoutMs: 20_000 });
      if (co.code !== 0) return { ok: false, error: `保留${sideLabel(side)}失败：${(co.stderr || '').trim().split('\n')[0] || file.path}` };
      await runGit(['add', '--', file.path], { cwd: repo.worktree, timeoutMs: 20_000 });
    }
  }
  return { ok: true };
}

/** 校验冲突文件已解决并提交合并；成功后清理状态与临时工作树。 */
export async function commitArchiveConflict(ws, task) {
  const record = readTaskArchiveConflict(ws, task);
  if (!record) return { ok: false, error: `任务 ${task} 没有待处理的归档冲突。` };
  const commits = [];
  const warnings = [];
  for (const repo of record.repos ?? []) {
    if (!repo.worktree || !fs.existsSync(repo.worktree)) {
      return { ok: false, error: `冲突工作树不存在：${repo.worktree ?? '(未记录)'}` };
    }
    for (const file of repo.files) {
      let text = '';
      try { text = fs.readFileSync(path.join(repo.worktree, file.path), 'utf8'); } catch { /* 删除文件跳过 */ }
      if (text && markerFound(text)) {
        return { ok: false, error: `${file.path} 仍含冲突标记，请先编辑解决。` };
      }
    }
    // 手动编辑后用户通常不会自己 git add；内核代替暂存，再校验是否还有未合并文件。
    const added = await runGit(['add', '--', ...repo.files.map((f) => f.path)], { cwd: repo.worktree, timeoutMs: 20_000 });
    if (added.code !== 0) {
      return { ok: false, error: `暂存冲突文件失败：${(added.stderr || '').trim().split('\n')[0]}` };
    }
    const unmerged = (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: repo.worktree }))
      .stdout.trim().split('\n').filter(Boolean);
    if (unmerged.length > 0) {
      return { ok: false, error: `仍有未解决文件：${unmerged.slice(0, 6).join('、')}` };
    }
    const check = await runGit(['diff', '--check', '--cached'], { cwd: repo.worktree, timeoutMs: 20_000 });
    if (check.code !== 0) warnings.push(`${repo.repo}：${(check.stdout || '').trim().split('\n')[0] || '存在空白错误'}`);
    const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo.worktree });
    if (mergeHead.code !== 0) {
      // 可能已由用户手工提交；不重复提交，但仍需把 detached 合并提交落到目标分支。
      warnings.push(`${repo.repo}：未发现 MERGE_HEAD，按已提交处理`);
      if (repo.detached) {
        const fullHash = (await runGit(['rev-parse', 'HEAD'], { cwd: repo.worktree })).stdout.trim();
        const updated = await updateTargetAfterDetached(repo.repoDir, repo.target, repo.targetWorktree ?? null, repo.baseCommit, fullHash);
        if (!updated.ok) return { ok: false, error: updated.error };
      }
      if (repo.temp) await removeTempWorktree(repo.repoDir, repo.worktree);
      continue;
    }
    const commit = await runGit(['commit', '--no-edit'], { cwd: repo.worktree, timeoutMs: 60_000 });
    if (commit.code !== 0) {
      return { ok: false, error: `提交合并失败：${(commit.stderr || commit.stdout || '').trim().split('\n')[0]}` };
    }
    const fullHash = (await runGit(['rev-parse', 'HEAD'], { cwd: repo.worktree })).stdout.trim();
    if (repo.detached) {
      const updated = await updateTargetAfterDetached(repo.repoDir, repo.target, repo.targetWorktree ?? null, repo.baseCommit, fullHash);
      if (!updated.ok) return { ok: false, error: updated.error };
    }
    const hash = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: repo.worktree })).stdout.trim();
    commits.push({ repo: repo.repo, target: repo.target, commit: hash });
    if (repo.temp) await removeTempWorktree(repo.repoDir, repo.worktree);
  }
  clearTaskArchiveConflict(ws, task);
  return { ok: true, commits, warnings };
}

