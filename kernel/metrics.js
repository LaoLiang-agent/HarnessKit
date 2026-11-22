// 任务运行统计：从 DSH sessionQuery / sessions 读取会话树，汇总模型、token、耗时与失败。
// 只收元数据，不落 prompt / 消息正文 / 工具参数 / 原始 session id。
// 两个消费面共用同一采集函数：面板实时查看、归档时写 metrics/<R>.json。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir } from './paths.js';
import { readTaskSessions } from './bindings.js';

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return false;
  let found = false;
  for (const key of USAGE_KEYS) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) { target[key] += value; found = true; }
  }
  return found;
}

function sessionLabel(id, primaryId, catalog) {
  if (id === primaryId) return 'PM';
  return catalog.get(id) || '子会话';
}

function flattenTree(nodes, out) {
  for (const node of nodes ?? []) {
    if (node?.session?.header?.id) out.push(node.session.header.id);
    flattenTree(node?.descendants, out);
  }
}

function snapshotFromLive(session) {
  if (!session) return null;
  try {
    const events = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (typeof session.ownEvents === 'function' ? session.ownEvents() : []);
    return { header: session.header ?? {}, events, inherited: Number(session.inheritedEventCount ?? 0) };
  } catch { return null; }
}

/**
 * 采集一个任务的运行统计。
 * services: { sessionQuery?, tokenMeter?, sessions?, currentSession? }
 * 返回 { schemaVersion, generatedAt, coverage, agents, totals, notes }。
 */
export async function collectTaskMetrics(ws, kit, task, services = {}) {
  const generatedAt = new Date().toISOString();
  const notes = [];
  const binding = readTaskSessions(ws)[task] ?? {};
  const primaryId = typeof binding.sessionId === 'string' ? binding.sessionId : null;
  const boundIds = [...new Set([
    primaryId,
    ...(Array.isArray(binding.sessions) ? binding.sessions.map((x) => x?.id) : []),
  ].filter((x) => typeof x === 'string' && x))];

  const ids = new Set(boundIds);
  const { sessionQuery, tokenMeter, sessions, currentSession } = services;
  const canTrace = !!sessionQuery && typeof sessionQuery.traceSession === 'function';
  const canRead = !!sessionQuery && typeof sessionQuery.readSession === 'function';

  if (canTrace) {
    for (const id of boundIds) {
      try {
        const trace = await sessionQuery.traceSession(id);
        const found = [];
        if (trace?.target?.header?.id) found.push(trace.target.header.id);
        flattenTree(trace?.descendants, found);
        for (const x of found) ids.add(x);
      } catch {
        notes.push(`会话 ${id.slice(0, 8)} 的会话树不可读`);
      }
    }
  }
  let currentSnapshot = null;
  if (ids.size === 0 && currentSession) {
    currentSnapshot = snapshotFromLive(currentSession);
    if (currentSnapshot) ids.add('__current__');
  }

  // currentSession 不在绑定表时的兜底：只统计当前会话，标记 partial。
  const idList = [...ids];
  if (idList.length === 0) {
    return {
      schemaVersion: 1, generatedAt, coverage: 'unavailable',
      agents: [], totals: totalOf([]), notes: ['任务没有可读的会话绑定'],
    };
  }

  const snapshots = new Map();
  const liveSessions = new Map();
  for (const id of idList) {
    if (id === '__current__') { snapshots.set(id, currentSnapshot); continue; }
    let snap = null;
    if (canRead) {
      try {
        const s = await sessionQuery.readSession(id);
        if (s?.events) snap = { header: s.session ?? s.header ?? {}, events: s.events, inherited: Number(s.inheritedEventCount ?? 0) };
      } catch { notes.push(`会话 ${String(id).slice(0, 8)} 读取失败`); }
    }
    if (!snap && sessions && typeof sessions.get === 'function') {
      const live = sessions.get(id);
      if (live) { liveSessions.set(id, live); snap = snapshotFromLive(live); }
    }
    if (!snap && currentSession && primaryId && id === primaryId) snap = snapshotFromLive(currentSession);
    if (snap) snapshots.set(id, snap);
  }

  // 子代理标签：subagent/catalog 事件（data.childId + label/name，兼容 children 数组）
  const catalog = new Map();
  for (const snap of snapshots.values()) {
    for (const e of snap.events ?? []) {
      if (e?.type !== 'subagent/catalog') continue;
      const d = e.data ?? {};
      const entries = Array.isArray(d.children) ? d.children : [d];
      for (const c of entries) {
        if (typeof c?.childId === 'string' && c.childId) {
          const label = c.label || c.name || c.role;
          if (typeof label === 'string' && label) catalog.set(c.childId, label);
        }
      }
    }
  }

  const agents = [];
  for (const [id, snap] of snapshots.entries()) {
    // 子会话可能继承父会话事件；只统计自身的 seq，避免 token 重复计算。
    const inherited = Number.isFinite(snap.inherited) ? snap.inherited : 0;
    const events = (snap.events ?? []).filter((e) => !Number.isFinite(Number(e?.seq)) || Number(e.seq) >= inherited);
    const usage = emptyUsage();
    let hasUsage = false;
    let provider = null;
    let model = null;
    let effort = null;
    let turns = 0;
    let steps = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    const turnStart = new Map();
    let activeDurationMs = 0;
    let firstTime = null;
    let lastTime = null;
    let contextPressure = null;

    for (const e of events) {
      const type = e?.type;
      const time = Number(e?.time);
      if (Number.isFinite(time)) {
        if (firstTime == null || time < firstTime) firstTime = time;
        if (lastTime == null || time > lastTime) lastTime = time;
      }
      if (type === 'request/header') {
        const cfg = e?.data?.header?.config;
        if (cfg?.provider) provider = cfg.provider;
        if (cfg?.model) model = cfg.model;
        if (cfg?.reasoningEffort) effort = cfg.reasoningEffort;
      } else if (type === 'assistant/message') {
        steps += 1;
        const src = e?.data?.message?.source;
        if (!provider && src?.provider) provider = src.provider;
        if (!model && src?.model) model = src.model;
        if (addUsage(usage, e?.data?.usage)) hasUsage = true;
      } else if (type === 'turn/start') {
        const turn = e?.data?.turn;
        if (Number.isFinite(Number(turn)) && Number.isFinite(time)) turnStart.set(Number(turn), time);
      } else if (type === 'turn/end') {
        turns += 1;
        const turn = Number(e?.data?.turn);
        const start = turnStart.get(turn);
        if (Number.isFinite(start) && Number.isFinite(time) && time >= start) activeDurationMs += time - start;
      } else if (type === 'tool/call') {
        toolCalls += 1;
      } else if (type === 'tool/result') {
        if (e?.data?.error || e?.data?.message?.isError) toolFailures += 1;
      }
    }
    if (turns === 0 && steps > 0) turns = steps;
    if (!hasUsage) notes.push(`${sessionLabel(id, primaryId, catalog)} 未返回 usage`);

    const live = liveSessions.get(id);
    if (tokenMeter && typeof tokenMeter.contextPressure === 'function') {
      try {
        const cp = live
          ? tokenMeter.contextPressure(live)
          : (sessionQuery && typeof sessionQuery.inspectSession === 'function'
            ? await sessionQuery.inspectSession(id, (s) => tokenMeter.contextPressure(s))
            : null);
        const pressure = Number(cp?.pressureTokens);
        const window = Number(cp?.contextWindow);
        contextPressure = Number.isFinite(pressure) && Number.isFinite(window) && window > 0 ? pressure / window : null;
      } catch { /* 上下文压力是可选项 */ }
    }

    agents.push({
      label: sessionLabel(id, primaryId, catalog),
      provider: provider || null,
      model: model || null,
      reasoningEffort: effort || null,
      turns,
      steps,
      inputTokens: hasUsage ? usage.inputTokens : null,
      outputTokens: hasUsage ? usage.outputTokens : null,
      cacheReadTokens: hasUsage ? usage.cacheReadTokens : null,
      cacheWriteTokens: hasUsage ? usage.cacheWriteTokens : null,
      reasoningTokens: hasUsage ? usage.reasoningTokens : null,
      totalTokens: hasUsage ? usage.inputTokens + usage.outputTokens : null,
      toolCalls,
      toolFailures,
      activeDurationMs,
      wallClockMs: firstTime != null && lastTime != null ? Math.max(0, lastTime - firstTime) : null,
      contextPressure: typeof contextPressure === 'number' ? contextPressure : null,
    });
  }

  agents.sort((a, b) => (a.label === 'PM' ? -1 : b.label === 'PM' ? 1 : a.label.localeCompare(b.label)));
  const anyUsage = agents.some((a) => a.inputTokens != null);
  const missing = idList.length - snapshots.size;
  const coverage = snapshots.size === 0 ? 'unavailable' : (missing > 0 || notes.length > 0 || !anyUsage ? 'partial' : 'complete');
  return {
    schemaVersion: 1,
    generatedAt,
    coverage,
    agents,
    totals: totalOf(agents),
    notes: [...new Set(notes)].slice(0, 12),
  };
}

function totalOf(agents) {
  const sum = (key) => agents.reduce((n, a) => n + (typeof a[key] === 'number' ? a[key] : 0), 0);
  return {
    agents: agents.length,
    turns: sum('turns'),
    steps: sum('steps'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    toolCalls: sum('toolCalls'),
    toolFailures: sum('toolFailures'),
    activeDurationMs: sum('activeDurationMs'),
    wallClockMs: sum('wallClockMs'),
  };
}

/** 读取任务最新一轮归档统计（历史任务在会话不可读时的兜底）。 */
export function readLatestTaskMetrics(ws, task) {
  const dir = path.join(harnessDir(ws), 'deliverables', '_archive', task, 'metrics');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^R\d+\.json$/.test(f))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  for (const name of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch { /* 跳过坏快照 */ }
  }
  return null;
}

/** 归档时写 metrics/<R>.json；已存在则保留（同一轮只写一次）。 */
export function writeTaskMetrics(ws, task, tag, metrics) {
  const dir = path.join(harnessDir(ws), 'deliverables', '_archive', task, 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tag}.json`);
  if (fs.existsSync(file)) return { file, skipped: true };
  const payload = { ...metrics, task, round: tag };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { file, skipped: false };
}
