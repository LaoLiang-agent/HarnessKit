// TE 环境串行排队（M3 一期，2026-11-15 定）：测试环境全局只有一个
// （起服务/连 TDengine/jmeter 不可多任务并发），TE 阶段按租约串行：
//
//   - 租约台账 .harness/tasks/test-env.json（本机状态，不进资产 git）：
//       { "holder": "task-x", "since": "ISO", "queue": ["task-y"] }
//   - PM 派发 TE Worker 前必须先 `/hk-te acquire <任务>`：
//       空闲 → 授权；自己持有 → 已持有；别人持有 → 排队并暂停 TE 阶段（内核不可抢占运行中的 Worker，门在派发前）
//   - 释放：holder 的看板链 TE 标 ✅/—（或任务归档/消失）→ 轮询器自动释放并晋升队列头部，
//     向该任务绑定的会话注入「轮到你了」；排队任务自己越过 TE 阶段 → 自动出队
//   - grace：holder 已授权但看板链还没标 TE▶（PM 先 acquire 后写板的时序窗口）不释放
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir } from './paths.js';
import { keepLedgerLocal } from './worktree.js';

const envPath = (ws) => path.join(harnessDir(ws), 'tasks', 'test-env.json');

export function readTestEnv(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(envPath(ws), 'utf8'));
    return {
      holder: typeof data?.holder === 'string' ? data.holder : null,
      since: data?.since ?? null,
      queue: Array.isArray(data?.queue) ? data.queue.filter((t) => typeof t === 'string') : [],
    };
  } catch { return { holder: null, since: null, queue: [] }; }
}

function writeTestEnv(ws, env) {
  fs.mkdirSync(path.dirname(envPath(ws)), { recursive: true });
  fs.writeFileSync(envPath(ws), `${JSON.stringify(env, null, 2)}\n`, 'utf8');
  keepLedgerLocal(ws, 'tasks/test-env.json');
}

/** 看板链中 TE 阶段的标记（✅ 完成 / — 跳过 → 不再需要环境；▶/…/⛔/缺 → 仍可能需要）。 */
function teMark(applyText) {
  if (!applyText) return null;
  const m = applyText.match(/TE\s*(✅|▶|…|⛔|—)/);
  return m ? m[1] : null;
}

/** 任务是否需要 TE 环境（链上 TE 未✅/未— 即视为需要，含 PM 先 acquire 后写板的宽限）。 */
function needsTe(applyText) {
  const mark = teMark(applyText);
  return mark !== '✅' && mark !== '—';
}

/**
 * 对账（轮询器每 7s 调用，也可命令内调用）：
 * - holder 的任务已越过 TE（✅/—）、已归档/不在看板 → 释放
 * - queue 里已越过 TE 或已不在看板的任务 → 出队
 * - 空闲且有排队 → 晋升队首
 * 返回 { released, promoted, env }。
 */
export function reconcileTestEnv(ws, boardRows) {
  const env = readTestEnv(ws);
  const released = [];
  const rowOf = (t) => (boardRows ?? []).find((r) => r.task === t);
  const active = (t) => {
    const row = rowOf(t);
    return !!row && row.status !== 'DONE' && row.status !== 'AWAITING_ARCHIVE' && needsTe(row.apply);
  };
  if (env.holder && !active(env.holder)) {
    released.push(env.holder);
    env.holder = null;
    env.since = null;
  }
  env.queue = env.queue.filter((t) => t !== env.holder && active(t));
  let promoted = null;
  if (!env.holder && env.queue.length > 0) {
    promoted = env.queue.shift();
    env.holder = promoted;
    env.since = new Date().toISOString();
  }
  writeTestEnv(ws, env);
  return { released, promoted, env };
}

/**
 * 获取租约：空闲 → 授权；自持 → 提示已持有；他持 → 入队（去重）并返回排队位次。
 * 返回 { granted, queued, position, holder, text }。
 */
export function acquireTestEnv(ws, task) {
  const env = readTestEnv(ws);
  if (env.holder === task) {
    return { granted: true, queued: false, position: 0, holder: task, text: `TE 环境已由本任务持有（${task}），继续 TE 阶段` };
  }
  if (env.holder) {
    if (!env.queue.includes(task)) env.queue.push(task);
    writeTestEnv(ws, env);
    return {
      granted: false, queued: true, position: env.queue.length, holder: env.holder,
      text: `TE 环境被 **${env.holder}** 占用：本任务已排队（第 ${env.queue.length} 位）。暂停 TE 阶段、不要派发 TE Worker、不要起服务/连测试库； holder 完成 TE 后内核自动释放并通知你`,
    };
  }
  writeTestEnv(ws, { holder: task, since: new Date().toISOString(), queue: env.queue });
  return { granted: true, queued: false, position: 0, holder: task, text: `TE 环境已授权给 **${task}**（TE 标 ✅ 后自动释放）` };
}

/** 手工释放（holder 或排队任务都可调用；排队任务调用=退出排队）。 */
export function releaseTestEnv(ws, task) {
  const env = readTestEnv(ws);
  if (env.holder === task) {
    env.holder = null;
    env.since = null;
    writeTestEnv(ws, env);
    return { released: true, text: `TE 环境已释放${env.queue.length > 0 ? `（排队：${env.queue.join('、')}，轮询器将自动晋升队首）` : ''}` };
  }
  const before = env.queue.length;
  env.queue = env.queue.filter((t) => t !== task);
  writeTestEnv(ws, env);
  return env.queue.length < before
    ? { released: false, text: `已退出 TE 排队` }
    : { released: false, text: `本任务未持有 TE 环境也不在排队中` };
}

/** 状态文本（/hk-te status 与面板用）。 */
export function describeTestEnv(ws) {
  const env = readTestEnv(ws);
  if (!env.holder && env.queue.length === 0) return 'TE 环境空闲';
  return `TE 环境持有：${env.holder ?? '（无）'}${env.since ? `（${env.since.slice(0, 19).replace('T', ' ')} 起）` : ''}${env.queue.length > 0 ? `；排队：${env.queue.join(' → ')}` : ''}`;
}
