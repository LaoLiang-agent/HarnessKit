// 本地文件（git-ignored 配置）在 worktree slot 间的发现/确认/复制。
//
// 设计（2026-11-20 与人定稿）：
//   - 不从插件硬编码文件名；候选由主工作树的 ignored/untracked 文件推断；
//   - 首次确认后写入本机 manifest（.harness/local/local-files.json，不入资产 git）；
//   - 新 slot 只复制已确认项；新候选只提示，不自动复制；
//   - 支持 copy / symlink 两种模式，目标已存在时不覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir, localStatePath } from './paths.js';
import { runGit } from './exec.js';

const MANIFEST = 'local-files.json';
const CONFIG_EXT = new Set(['.properties', '.yml', '.yaml', '.conf', '.ini', '.toml', '.json', '.xml', '.env']);
const EXCLUDE_DIRS = new Set([
  '.git', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'node_modules', '.idea', '.vscode',
  '.gradle', '.mvn', '.next', 'coverage', 'logs', '.cache', 'tmp', '.tmp', '.DS_Store',
]);
const EXCLUDE_EXT = new Set([
  '.class', '.jar', '.war', '.zip', '.gz', '.tar', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.pdf', '.log', '.lock', '.map', '.min.js', '.min.css', '.woff', '.woff2', '.ttf', '.eot',
]);

export const localFilesPath = (ws) => localStatePath(ws, MANIFEST, 'tasks/local-files.json');

export function readLocalFiles(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(localFilesPath(ws), 'utf8'));
    return {
      version: 1,
      sources: data && typeof data.sources === 'object' && data.sources ? data.sources : {},
    };
  } catch {
    return { version: 1, sources: {} };
  }
}

export function writeLocalFiles(ws, data) {
  const file = localFilesPath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, sources: data.sources ?? {} }, null, 2)}\n`, 'utf8');
}

function sourceEntry(manifest, name) {
  const entry = manifest.sources?.[name];
  return entry && typeof entry === 'object' ? entry : {};
}

function approvedOf(manifest, source) {
  const entry = sourceEntry(manifest, source.name);
  const baseline = Array.isArray(source.localFiles) ? source.localFiles : [];
  const extra = Array.isArray(entry.approved) ? entry.approved : [];
  return [...new Set([...baseline, ...extra])];
}

function skippedOf(manifest, source) {
  return new Set(Array.isArray(sourceEntry(manifest, source.name).skipped) ? sourceEntry(manifest, source.name).skipped : []);
}

function excluded(rel) {
  const lower = rel.toLowerCase();
  const parts = lower.split('/');
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (EXCLUDE_EXT.has(path.extname(lower))) return true;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock)$/.test(lower)) return true;
  return false;
}

function candidateReason(rel) {
  const base = path.basename(rel).toLowerCase();
  if (base.startsWith('.env') || /(local|secret|credential|application-|dbcp)/.test(base)) return 'high';
  if (CONFIG_EXT.has(path.extname(base))) return 'config';
  return null;
}

async function gitList(repo, args) {
  const r = await runGit(['ls-files', ...args], { cwd: repo });
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}

/** 从主工作树推断候选；只读。 */
export async function discoverSource(ws, source) {
  const repo = path.resolve(ws, source.path);
  if (!fs.existsSync(repo)) return [];
  const check = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (check.code !== 0 || check.stdout.trim() !== 'true') return [];
  const untracked = await gitList(repo, ['--others', '--exclude-standard', '-z']);
  const ignored = await gitList(repo, ['--others', '--ignored', '--exclude-standard', '-z']);
  const status = new Map();
  for (const p of untracked) status.set(p, 'untracked');
  for (const p of ignored) status.set(p, 'ignored');
  const rows = [];
  for (const [rel, kind] of status) {
    if (!rel || excluded(rel)) continue;
    const reason = candidateReason(rel);
    if (!reason) continue;
    const abs = path.join(repo, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > 256 * 1024) continue;
    rows.push({ path: rel.replaceAll('\\', '/'), source: source.name, kind, reason, size: stat.size });
  }
  rows.sort((a, b) => (a.reason === b.reason ? a.path.localeCompare(b.path) : a.reason === 'high' ? -1 : 1));
  return rows;
}

export async function discoverAll(ws, sources) {
  const out = [];
  for (const source of sources ?? []) {
    for (const row of await discoverSource(ws, source)) out.push(row);
  }
  return out;
}

function provisionOne(srcRoot, dstRoot, rel, mode, notes) {
  const from = path.resolve(srcRoot, rel);
  const to = path.resolve(dstRoot, rel);
  const srcRel = path.relative(srcRoot, from);
  const dstRel = path.relative(dstRoot, to);
  if (srcRel.startsWith('..') || dstRel.startsWith('..') || path.isAbsolute(srcRel) || path.isAbsolute(dstRel)) {
    notes.push(`本地配置路径越界，已跳过：${rel}`);
    return;
  }
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
    notes.push(`本地配置不存在，未复制：${rel}`);
    return;
  }
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (mode === 'symlink') {
    try {
      fs.symlinkSync(path.relative(path.dirname(to), from), to);
      notes.push(`已软链本地配置：${rel}`);
      return;
    } catch {
      // Windows/受限文件系统回退 copy
    }
  }
  fs.copyFileSync(from, to);
  notes.push(`已复制本地配置：${rel}`);
}

/** 为某个 slot 补齐已确认的本地配置；不覆盖已有文件。 */
export async function provisionLocalFiles(ws, source, slotDir) {
  const manifest = readLocalFiles(ws);
  const approved = approvedOf(manifest, source);
  const mode = sourceEntry(manifest, source.name).mode === 'symlink' ? 'symlink' : 'copy';
  const notes = [];
  for (const rel of approved) provisionOne(path.resolve(ws, source.path), slotDir, rel, mode, notes);
  const candidates = await discoverSource(ws, source);
  const skipped = skippedOf(manifest, source);
  const pending = candidates.filter((c) => !approved.includes(c.path) && !skipped.has(c.path));
  if (pending.length > 0) {
    notes.push(`发现 ${pending.length} 个本机配置文件：打开 Harness Kit 面板 →「工作区」→「本机开发配置」确认一次，新工作区会自动带上；高级用户也可运行 \`/hk-local scan\``);
  }
  return notes;
}

/** 把已确认配置补到所有已绑定 slot（/hk-local apply）。 */
export async function provisionAllSlots(ws, sources) {
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(localStatePath(ws, 'worktrees.json', 'tasks/worktrees.json'), 'utf8')); } catch { /* no ledger */ }
  const notes = [];
  for (const source of sources ?? []) {
    const slots = ledger.slots?.[source.name] ?? {};
    for (const [placement, info] of Object.entries(slots)) {
      if (!info || info.state !== 'bound') continue;
      const dir = path.join(ws, '.worktrees', source.name, placement);
      if (!fs.existsSync(dir)) continue;
      notes.push(...(await provisionLocalFiles(ws, source, dir)));
    }
  }
  return notes;
}
