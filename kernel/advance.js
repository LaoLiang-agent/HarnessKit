// 自动续接引擎（纯函数部分）：人裁决已经在会话里发生后，确定性闸门自动接力，
// 不再要求人手动敲下一条斜杠命令。
// 目前两条接力边（都与 flows/*.yml 的硬闸门一一对应）：
//   定稿（proposal.md 状态行 approved）+ 看板 PENDING   → /hk-propose <task>
//   审批 1 通过 + 看板 IN_PROGRESS                     → /hk-apply <task>
// 触发守卫：
//   - 看板状态行是第一道闸（hk-propose 成功会置 IN_PROGRESS，天然阻断重复触发）；
//   - 一次性标记落盘 .harness/local/auto-advance.json（host 重载后仍然幂等；
//     /hk-new、/hk-fix、/hk-archive 会清理对应任务标记，重建/归档后可重新接力）；
//   - 审批/归档本身仍是人裁决：本引擎只在人写下 approved / 审批 1：通过 之后接力。
// 修复直通（fix profile）没有这两个闸门，不参与自动续接。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir, localStatePath } from './paths.js';

// 与 kernel/commands.js 的闸门正则同源（那边用于命令准入，这边用于触发扫描）。
const APPROVAL1 = /审批\s*1[^0-9\n]{0,20}(通过|PASS)/i;
// 审批 2 在看板 Apply 链上以「审批2✅」落标记（update_board.py 的链 token），
// PM 只有在人裁决通过后才写——引擎据此接力 /hk-archive（2026-11-17 定，与 审批1→apply 同构）。
const APPROVAL2 = /审批\s*2\s*(✅|通过|PASS)/i;
const STATUS_APPROVED = /状态[*＊]*[:：][ \t]*`?approved(?![\w-])/im;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const marksPath = (ws) => localStatePath(ws, 'auto-advance.json', 'tasks/auto-advance.json');

/** 读一次性触发标记（坏文件容忍为 {}）。 */
export function readAdvanceMarks(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(marksPath(ws), 'utf8'));
    return data && typeof data === 'object' && data.fired && typeof data.fired === 'object' ? data.fired : {};
  } catch { return {}; }
}

/** 落盘一条触发标记（task:hop → ISO 时间）。 */
export function markAdvanceFired(ws, task, hop) {
  const fired = readAdvanceMarks(ws);
  fired[`${task}:${hop}`] = new Date().toISOString();
  fs.mkdirSync(path.dirname(marksPath(ws)), { recursive: true });
  fs.writeFileSync(marksPath(ws), `${JSON.stringify({ fired }, null, 2)}\n`, 'utf8');
}

/** 清理某任务的全部触发标记（/hk-new、/hk-fix 重建任务、/hk-archive 归档时调用）。 */
export function clearAdvanceMarks(ws, task) {
  const fired = readAdvanceMarks(ws);
  let changed = false;
  for (const key of Object.keys(fired)) {
    if (key.startsWith(`${task}:`)) { delete fired[key]; changed = true; }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(marksPath(ws)), { recursive: true });
    fs.writeFileSync(marksPath(ws), `${JSON.stringify({ fired }, null, 2)}\n`, 'utf8');
  }
}

/** 解析看板 markdown 表行（与 panel.js parseBoard 的列契约一致，只取需要的列）。 */
function boardRows(text) {
  const table = text.split('\n').filter((l) => l.startsWith('|'));
  if (table.length < 3) return [];
  return table.slice(2).map((line) => {
    const c = line.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    return { task: c[0] ?? '', status: (c[1] ?? '').toUpperCase(), profile: (c[2] ?? '').toLowerCase(), apply: c[3] ?? '' };
  });
}

/**
 * 扫描一个工作区，返回当前应自动接力的动作列表。
 * 三条接力边（与 flows 的硬闸门一一对应）：
 *   定稿 approved + PENDING            → /hk-propose
 *   审批 1 通过 + IN_PROGRESS          → /hk-apply
 *   审批 2 ✅ + AWAITING_ARCHIVE       → /hk-archive（人已裁决归档，机器执行）
 * @returns {{task: string, hop: 'propose'|'apply'|'archive', line: string}[]}
 */
export function scanAutoAdvance(ws) {
  const boardFile = path.join(harnessDir(ws), 'tasks', 'board.md');
  if (!fs.existsSync(boardFile)) return [];
  let rows;
  try { rows = boardRows(fs.readFileSync(boardFile, 'utf8')); } catch { return []; }
  const marks = readAdvanceMarks(ws);
  const out = [];
  for (const row of rows) {
    if (!TASK_RE.test(row.task)) continue;
    // 只看全流程任务（有 proposal.md）；fix 直通/bugfix 无此文档，天然跳过
    const proposalPath = path.join(harnessDir(ws), 'deliverables', row.task, 'proposal.md');
    if (!fs.existsSync(proposalPath)) continue;
    let proposal;
    try { proposal = fs.readFileSync(proposalPath, 'utf8'); } catch { continue; }
    if (row.status === 'PENDING' && STATUS_APPROVED.test(proposal) && !marks[`${row.task}:propose`]) {
      out.push({ task: row.task, hop: 'propose', line: `/hk-propose ${row.task}` });
    } else if (row.status === 'IN_PROGRESS' && APPROVAL1.test(proposal) && !marks[`${row.task}:apply`]) {
      out.push({ task: row.task, hop: 'apply', line: `/hk-apply ${row.task}` });
    } else if (row.status === 'AWAITING_ARCHIVE' && APPROVAL2.test(row.apply) && !marks[`${row.task}:archive`]) {
      out.push({ task: row.task, hop: 'archive', line: `/hk-archive ${row.task}` });
    }
  }
  return out;
}
