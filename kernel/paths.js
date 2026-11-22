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

export function defaultKit() {
  return { version: 1, pack: DEFAULT_PACK, hosts: ['dsh'], sources: [], models: {}, worktree: { autoClose: true, targetSync: 'safe' } };
}

/** kit.json sources plus the always-protected e2e/ zone. */
export function protectedSourcePaths(kit) {
  const fromKit = (kit?.sources ?? []).map((s) => s.path).filter(Boolean);
  return [...fromKit, 'e2e/'];
}
