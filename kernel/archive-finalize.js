// 归档收尾状态：文档已归档 ≠ 资产收尾完成。
//
// 本地状态只记录“尚未确认”的任务；面板据此提示先 /hk-sync、后 /hk-archive --finalize。
// 是否完成 Spec/Memory Merge 由人确认，内核只校验资产干净、同步到位、spec/memory 门禁。
import fs from 'node:fs';
import path from 'node:path';
import { localStatePath } from './paths.js';

const statePath = (ws) => localStatePath(ws, 'archive-finalize.json', 'tasks/archive-finalize.json');

export function readArchiveFinalizes(ws) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(ws), 'utf8'));
    if (data?.version !== 1 || typeof data.tasks !== 'object' || data.tasks === null) return { version: 1, tasks: {} };
    return data;
  } catch {
    return { version: 1, tasks: {} };
  }
}

export function readTaskArchiveFinalize(ws, task) {
  return readArchiveFinalizes(ws).tasks?.[task] ?? null;
}

function writeArchiveFinalizes(ws, data) {
  const file = statePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, tasks: data.tasks ?? {} }, null, 2)}\n`, 'utf8');
}

export function setTaskArchiveFinalize(ws, task, record) {
  const data = readArchiveFinalizes(ws);
  data.tasks[task] = { ...data.tasks[task], ...record, task, updatedAt: new Date().toISOString() };
  writeArchiveFinalizes(ws, data);
  return data.tasks[task];
}

export function updateTaskArchiveFinalize(ws, task, patch) {
  const data = readArchiveFinalizes(ws);
  if (!(task in data.tasks)) return null;
  data.tasks[task] = { ...data.tasks[task], ...patch, updatedAt: new Date().toISOString() };
  writeArchiveFinalizes(ws, data);
  return data.tasks[task];
}

export function clearTaskArchiveFinalize(ws, task) {
  const data = readArchiveFinalizes(ws);
  if (!(task in data.tasks)) return;
  delete data.tasks[task];
  writeArchiveFinalizes(ws, data);
}
