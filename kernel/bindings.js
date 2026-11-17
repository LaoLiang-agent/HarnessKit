// 任务 ↔ 会话绑定表（.harness/tasks/sessions.json）。
// 记录点：面板 /harness-kit/command 成功执行、kernel 命令 handler（hk-new/hk-fix 内直接登记，
// 覆盖「在会话里手敲命令」的场景）、客户端新开会话后 POST /harness-kit/bind-session。
// 用途：面板「重开/继续实施/转到会话」跳转；自动续接引擎据此找到任务所属会话。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir } from './paths.js';

/** 读任务→会话绑定表（坏文件容忍为 {}）。 */
export function readTaskSessions(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(harnessDir(ws), 'tasks', 'sessions.json'), 'utf8'));
    return data && typeof data === 'object' && data.tasks && typeof data.tasks === 'object' ? data.tasks : {};
  } catch { return {}; }
}

/** 登记/覆盖任务→会话绑定。 */
export function recordTaskSession(ws, task, sessionId) {
  const file = path.join(harnessDir(ws), 'tasks', 'sessions.json');
  const tasks = readTaskSessions(ws);
  tasks[task] = { sessionId, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf8');
}
