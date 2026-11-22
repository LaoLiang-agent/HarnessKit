// Workspace/kit.json path resolution and manifest IO.
// The workspace root is read per command from the receiving agent's session
// header (`agent.session.header.cwd`), never from process.cwd().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACK = 'ai-coding';

export function packDir(kit) {
  return path.join(PACK_ROOT, 'packs', kit?.pack ?? DEFAULT_PACK);
}

export function wsRoot(agent) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '') throw new Error('无法确定会话工作区路径（session cwd 缺失）');
  return cwd;
}

export function harnessDir(ws) {
  return path.join(ws, '.harness');
}

export function kitPath(ws) {
  return path.join(harnessDir(ws), 'kit.json');
}

export function readKit(ws) {
  const p = kitPath(ws);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (cause) {
    throw new Error(`kit.json 解析失败：${cause.message}`);
  }
}

export function writeKit(ws, kit) {
  const p = kitPath(ws);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(kit, null, 2) + '\n', 'utf8');
}

/** 本机状态目录：.harness/local/（会话绑定/工作区台账/决策点/租约/本机配置）。 */
export function localDir(ws) {
  return path.join(harnessDir(ws), 'local');
}

/** 旧本机状态 → .harness/local/ 的迁移表（只迁移，不删除非空新文件）。 */
const LEGACY_LOCAL = [
  ['tasks/sessions.json', 'sessions.json'],
  ['tasks/auto-advance.json', 'auto-advance.json'],
  ['tasks/worktrees.json', 'worktrees.json'],
  ['tasks/decisions.json', 'decisions.json'],
  ['tasks/test-env.json', 'test-env.json'],
  ['tasks/local-files.json', 'local-files.json'],
];

/** 确保 .gitignore 排除 local/（旧工作区迁移时也必须补上，否则本机状态会被提交）。 */
function ensureLocalIgnored(ws) {
  try {
    const gi = path.join(harnessDir(ws), '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === 'local/')) {
      fs.appendFileSync(gi, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}# 本机状态（机器本地，不共享、勿提交）\nlocal/\n`, 'utf8');
    }
  } catch { /* 忽略失败不阻断 */ }
}

/** 把旧位置的本机状态搬到 .harness/local/；幂等，失败不阻断。 */
export function migrateLegacyLocalState(ws) {
  const dir = localDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  ensureLocalIgnored(ws);
  for (const [oldRel, name] of LEGACY_LOCAL) {
    const oldPath = path.join(harnessDir(ws), oldRel);
    const newPath = path.join(dir, name);
    if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
    try { fs.renameSync(oldPath, newPath); } catch {
      try { fs.copyFileSync(oldPath, newPath); fs.rmSync(oldPath, { force: true }); } catch { /* 下一次读取再试 */ }
    }
  }
}

/**
 * 本机状态文件路径：默认 .harness/local/<name>；旧路径存在且新路径不存在时先迁移。
 * legacyRel 用于兼容 0.2.0 以前的 tasks/*.json 布局。
 */
export function localStatePath(ws, name, legacyRel = null) {
  const dir = localDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  ensureLocalIgnored(ws);
  const file = path.join(dir, name);
  if (legacyRel && !fs.existsSync(file)) {
    const oldPath = path.join(harnessDir(ws), legacyRel);
    if (fs.existsSync(oldPath)) {
      try { fs.renameSync(oldPath, file); } catch {
        try { fs.copyFileSync(oldPath, file); fs.rmSync(oldPath, { force: true }); } catch { /* 继续读旧路径 */ }
      }
    }
  }
  return file;
}

export function defaultKit() {
  return { version: 1, pack: DEFAULT_PACK, hosts: ['dsh'], sources: [], models: {}, worktree: { autoClose: true, targetSync: 'safe' } };
}

/** kit.json sources plus the always-protected e2e/ zone. */
export function protectedSourcePaths(kit) {
  const fromKit = (kit?.sources ?? []).map((s) => s.path).filter(Boolean);
  return [...fromKit, 'e2e/'];
}
