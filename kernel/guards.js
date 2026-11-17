// ToolGuard set. M1 scope:
//  - unconditional: destructive git operations (reset --hard / clean -f / push --force)
//  - phase-conditional (Bootstrap red line): writes to kit.json sources paths
//    and e2e/ while any active task lacks a recorded human quality-gate verdict
//    (see kernel/state.js — the verdict recorded in bugfix.md unlocks Dev).
import path from 'node:path';
import { wsRoot, readKit } from './paths.js';
import { lockedSourcePaths } from './state.js';

const DESTRUCTIVE = /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f|\bgit\s+push\b[^|&;]*--force|\bgit\s+push\s+-f\b/;
const BASH_WRITE = />>?|\bsed\s+-i\b|\btee\b|\b(mv|cp|rm|touch|mkdir|install|rsync|patch)\b|\bgit\s+(apply|restore|checkout\s+--|commit|add)\b/;

function normalizeTarget(ws, filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ws, filePath);
  return abs;
}

function pathHits(abs, ws, relPaths) {
  return relPaths.find((rel) => {
    const base = path.resolve(ws, rel);
    return abs === base || abs.startsWith(base + path.sep);
  });
}

function bashHitsProtected(command, locked) {
  if (!BASH_WRITE.test(command)) return null;
  // cheap token scan: any protected relative path appearing as a token
  return locked.find((rel) => {
    const token = rel.replace(/\/$/, '');
    return new RegExp(`(^|[\\s'"|;&>])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\s|'|"|:|$)`).test(command);
  });
}

export function installGuards(ctx, logger) {
  const dispose = ctx.tools.guard((execution) => {
    const name = execution.name;
    const args = execution.arguments ?? {};

    if (name === 'bash' && typeof args.command === 'string' && DESTRUCTIVE.test(args.command)) {
      return 'Harness Kit 红线：禁止破坏性 git 操作（reset --hard / clean -f / push --force）。';
    }

    const agent = execution.agent;
    if (!agent) return undefined;
    let ws;
    try {
      ws = wsRoot(agent);
    } catch {
      return undefined; // no workspace context → not our call
    }
    let kit;
    try {
      kit = readKit(ws);
    } catch (cause) {
      logger?.warn?.('harness-kit guard: kit.json 读取失败，跳过红线检查: %o', cause);
      return undefined;
    }
    if (!kit) return undefined;
    const locked = lockedSourcePaths(ws, kit);
    if (locked.length === 0) return undefined;

    if ((name === 'edit' || name === 'write') && typeof args.file_path === 'string') {
      const abs = normalizeTarget(ws, args.file_path);
      const hit = abs && pathHits(abs, ws, locked);
      if (hit) {
        return `Harness Bootstrap 红线：规划阶段（质量门未裁决）禁止修改源码区 ${hit}。请先完成 bugfix.md 并交人裁决质量门。`;
      }
    }
    if (name === 'bash' && typeof args.command === 'string') {
      const hit = bashHitsProtected(args.command, locked);
      if (hit) {
        return `Harness Bootstrap 红线：规划阶段（质量门未裁决）禁止通过 shell 写源码区 ${hit}。请先完成规划文档并交人裁决质量门。`;
      }
    }
    return undefined;
  });
  return dispose;
}
