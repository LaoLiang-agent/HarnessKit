// M4/M4b 面板数据通道：webServer 路由向 Client 面板暴露状态、配置与命令转发。
// - GET  /harness-kit/state     工作区看板 + 流程进度 + 认领 + 同步健康 + 注意力项
// - GET  /harness-kit/config    kit.json 配置视图（?workspace=）
// - POST /harness-kit/config    {workspace, patch} 更新 kit.json（基线分支/autoSync/models）
// - GET  /harness-kit/activity  资产仓库团队动态（git log，?workspace=）
// - POST /harness-kit/sync      {workspace} 立即同步（Host 直跑，不占会话）
// - POST /harness-kit/command   {workspace, line} 把 /hk-* 命令转发给该工作区的活动会话（成功自动登记任务↔会话）
// - POST /harness-kit/bind-session {workspace, task, sessionId} 登记任务↔会话绑定（客户端新开会话后回调）
// - POST /harness-kit/workspace/inspect {path}   目录预检（新建/打开向导共用）
// - POST /harness-kit/workspace/create  {path, title?} 注册任意已存在目录为 DSH 工作区
// - POST /harness-kit/workspace/open    {path, title?} 打开已有 Harness 工作区（须含 .harness/kit.json）
// - POST /harness-kit/workspace/init    {workspace, assets?, sources?} 面板初始化向导（/hk-init + /hk-setup --add 等价，幂等）
// - GET  /harness-kit/env       向导环境预检（git / Python 3 + 对应平台安装指引，不自动安装）
// 纯函数（parseBoard / taskProgress / nextAction / laneOf / parseClaims /
// attentionItems / parseGitLog / updateKit）与 HTTP 接线分离，供 sim 测试。
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir, readKit, writeKit, defaultKit } from './paths.js';
import { loadFlow } from './flows.js';
import { runGit } from './exec.js';
import { checkEnvironment } from './env.js';
import { assetsLayout, syncAssets } from './sync.js';
import { runInit, formatInitReport, inspectDir } from './setup.js';
import { readTaskSessions, recordTaskSession } from './bindings.js';
import { scanAutoAdvance, markAdvanceFired } from './advance.js';
import { listRoles } from './roles.js';
import { readWorkspaces } from './worktree.js';
import { listAllGitBranches } from './worktree.js';
import { reconcileTestEnv, readTestEnv } from './te.js';
import { readDecisions } from './worktree.js';

/** 解析看板 markdown 表（7 列契约，见 commands.js boardTemplate）。
 *  容错与 commands.js parseBoardRow 同源：超列溢出并入「续接提示」，不足补 —。 */
export function parseBoard(text) {
  const table = text.split('\n').filter((l) => l.startsWith('|'));
  if (table.length < 2) return { headers: [], rows: [] };
  const cells = (line) => {
    const c = line.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    if (c.length > 7) return [...c.slice(0, 6), c.slice(6).join(' / ')];
    while (c.length < 7) c.push('—');
    return c;
  };
  const headers = cells(table[0]);
  const rows = table.slice(2).map((line) => {
    const c = cells(line);
    return { task: c[0], status: c[1], profile: c[2], apply: c[3], branch: c[4], updated: c[5], hint: c[6] };
  });
  return { headers, rows };
}

/** 从 stage.do 行提取产物文件名（「产出 xxx.md」）。 */
function evidenceFiles(stage) {
  const out = [];
  for (const item of stage.do ?? []) {
    const re = /产出\s*`?([\w.-]+\.md)/g;
    let m;
    while ((m = re.exec(item)) !== null) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** 审批标记：proposal.md / bugfix.md 中出现「<阶段名>：通过」。 */
function approvalPassed(dir, name) {
  for (const doc of ['proposal.md', 'bugfix.md']) {
    const file = path.join(dir, doc);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:]\\s*通过`).test(text)) return true;
  }
  return false;
}

/** 解析看板 Apply进度 链：`R<n>：Dev✅ 验证▶` → { round, chain: [{name, mark}] }；不合规/—/已归档返回 null。 */
export function parseApplyChain(text) {
  const m = /^R(\d+)[：:]\s*(.+)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const chain = [];
  for (const tok of m[2].trim().split(/\s+/)) {
    const sm = /^(.+?)(✅|▶|…|⛔|—)$/.exec(tok);
    if (!sm) return null; // 任一 token 不合规 → 放弃链驱动，回退证据驱动
    chain.push({ name: sm[1], mark: sm[2] });
  }
  return chain.length ? { round: Number(m[1]), chain } : null;
}

/** 看板链阶段 → 面板阶段对象（与 flow yml 派生的结构同构）。 */
function chainStages(chain) {
  return chain.map(({ name, mark }) => ({
    name,
    kind: /^审批/.test(name) ? 'approval' : 'worker',
    phase: ['影响面', 'propose', '审批1'].includes(name) ? 'propose' : 'apply',
    done: mark === '✅',
    skipped: mark === '—',
    blocked: mark === '⛔',
    evidence: [],
  }));
}

/**
 * 推导单任务流程进度。
 * 返回 { flow, stages: [{name, phase, kind, done, evidence}], pendingApproval, current }
 * kind: worker|approval|plain；current = 首个未完成阶段下标（-1 表示全部完成）。
 */
export function taskProgress(ws, kit, task, profile, status, applyText = null) {
  const dir = path.join(harnessDir(ws), 'deliverables', task);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    : [];
  let flowName = profile && profile !== '—' ? profile : null;
  // v4.1 三态：bugfix=全流程；fix-full/fix-light=直通；裸 fix=直通裁决未定（兼容旧板：
  // 旧短名 fix 曾覆盖 bugfix 全流程，无链回退时仍按 proposal.md 消解）
  if (flowName === 'fix-full' || flowName === 'fix-light') flowName = 'fix';
  else if (flowName === 'fix') flowName = files.includes('proposal.md') ? 'bugfix' : 'fix';
  if (!flowName) flowName = files.includes('bugfix.md') ? 'fix' : 'standard';

  // 看板 Apply进度 链是 PM 维护的权威进度（v3 语法）：有链则以链驱动圆点，与看板文本严格一致；
  // 无链（—）才回退证据文件推导（老数据/新立项未写链）。
  const parsed = parseApplyChain(applyText);
  if (parsed) {
    const stages = chainStages(parsed.chain);
    if (status === 'DONE') for (const s of stages) { s.done = true; s.blocked = false; }
    let current = parsed.chain.findIndex((c) => c.mark === '▶');
    if (current < 0) current = stages.findIndex((s) => !s.done && !s.skipped);
    const pending = stages.find((s, i) => s.kind === 'approval' && !s.done && !s.skipped
      && stages.slice(0, i).every((p) => p.done || p.skipped));
    // 越序检测：▶ 之前存在未完成（非 ✅/—）阶段 = 写板不规范，面板应浮出水面
    const outOfOrder = current > 0 && parsed.chain.slice(0, current).some((c) => c.mark !== '✅' && c.mark !== '—');
    return { flow: flowName, stages, pendingApproval: pending?.name ?? null, current, deliverables: files, round: parsed.round, outOfOrder };
  }

  const loaded = loadFlow(ws, kit ?? defaultKit(), flowName);
  if (!loaded) return { flow: flowName, stages: [], pendingApproval: null, current: -1, deliverables: files };
  const stages = (loaded.flow.stages ?? []).map((s) => {
    const kind = s.approval ? 'approval' : s.worker ? 'worker' : 'plain';
    let done;
    let evidence = [];
    if (kind === 'approval') {
      done = approvalPassed(dir, s.name);
    } else {
      evidence = evidenceFiles(s);
      done = evidence.length > 0 && evidence.every((f) => files.includes(f));
    }
    return { name: s.name, phase: s.phase ?? null, kind, done, evidence };
  });
  let current = stages.findIndex((s) => !s.done);
  if (status === 'DONE') {
    // 已归档任务活目录已清空，证据文件不在——按状态视作全程完成
    for (const s of stages) s.done = true;
    current = -1;
  }
  const pending = stages.find((s, i) => s.kind === 'approval' && !s.done && stages.slice(0, i).every((p) => p.done));
  return { flow: flowName, stages, pendingApproval: pending?.name ?? null, current, deliverables: files };
}

/** 单任务面板动作：{kind: reopen|archive|wait|apply|propose, line?, approval?}。 */
export function nextAction(row, progress) {
  const { task, status } = row;
  if (status === 'DONE') return { kind: 'reopen', line: `/hk-apply ${task}` };
  if (status === 'AWAITING_ARCHIVE') return { kind: 'archive', line: `/hk-archive ${task}` };
  if (progress.pendingApproval) return { kind: 'wait', approval: progress.pendingApproval };
  const cur = progress.current >= 0 ? progress.stages[progress.current] : null;
  if (cur && cur.phase === 'apply') return { kind: 'apply', line: `/hk-apply ${task}` };
  return { kind: 'propose', line: `/hk-propose ${task}` };
}

/** 泳道分派：plan=规划中 / build=实施中 / archive=待归档 / done=已归档（M4b）。 */
export function laneOf(row, progress) {
  if (row.status === 'DONE') return 'done';
  if (row.status === 'AWAITING_ARCHIVE') return 'archive';
  // 未启动（PENDING）一律归「规划中」，不看链阶段——否则全 … 的 fix 任务会因
  // 质量门 phase=apply 落进「实施中」
  if (row.status === 'PENDING') return 'plan';
  const cur = progress.current >= 0 ? progress.stages[progress.current] : null;
  return cur?.phase === 'apply' ? 'build' : 'plan';
}

/** 解析 claims.json（追加式 JSONL，每行 {task, by, ts}；by=null 表示释放，后者覆盖前者）。 */
export function parseClaims(text) {
  const claims = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      if (typeof j.task !== 'string' || !j.task) continue;
      if (j.by == null) delete claims[j.task];
      else claims[j.task] = { by: String(j.by), ts: typeof j.ts === 'string' ? j.ts : null };
    } catch { /* 容忍坏行 */ }
  }
  return claims;
}

/** 追加一条认领记录（由 /hk-propose 自动调用；文件纳入 sync 纯追加白名单）。 */
export function claimTask(ws, task, by) {
  const file = path.join(harnessDir(ws), 'tasks', 'claims.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ task, by, ts: new Date().toISOString() })}\n`, 'utf8');
}

// ---------------------------------------------------------- 任务 ↔ 会话绑定
// .harness/tasks/sessions.json：{ tasks: { <任务名>: { sessionId, at } } }
// 实现已下沉 kernel/bindings.js（kernel 命令 handler 与自动续接引擎共用），此处转出口径不变。
export { readTaskSessions, recordTaskSession } from './bindings.js';

/**
 * 初始化完整性缺口：根 AGENTS.md 与各子工程的 build.json / CLAUDE.md。
 * 确定性物化（面板「重跑初始化」）只铺骨架与脚本，子工程文档由初始化编排
 * （PM 流程）生成 —— 有缺口时面板给出「运行初始化编排」入口而不是让用户
 * 对着「初始化成功」却缺文件的工程发懵。
 */
export function initGaps(ws, kit) {
  const gaps = [];
  if (!fs.existsSync(path.join(ws, 'AGENTS.md'))) gaps.push('根 AGENTS.md');
  for (const s of kit?.sources ?? []) {
    if (!s?.path) continue;
    const sp = path.join(ws, s.path);
    if (!fs.existsSync(sp)) continue;
    if (!fs.existsSync(path.join(sp, '.harness', 'build.json'))) gaps.push(`${s.name} 的 build.json`);
    if (!fs.existsSync(path.join(sp, 'CLAUDE.md'))) gaps.push(`${s.name} 的 CLAUDE.md`);
  }
  return gaps;
}

/**
 * 「需要你」注意力项（M4b）：审批/待归档/同步阻塞·落后/初始化缺口。
 * 返回 [{level: block|warn, kind, task?, text, line?, jump?}]，block 在前。
 */
export function attentionItems(tasks, sync, gaps = [], staleSlots = [], teEnv = null, decisions = {}) {
  const items = [];
  for (const t of tasks) {
    if (t.status === 'DONE') continue;
    if (t.progress?.pendingApproval) {
      items.push({ level: 'block', kind: 'approval', task: t.task, text: `${t.task} · ${t.progress.pendingApproval} 等待人工审批`, jump: true });
    }
    const blocked = t.progress?.stages?.find((s) => s.blocked);
    if (blocked) {
      items.push({ level: 'block', kind: 'stage-blocked', task: t.task, text: `${t.task} · ${blocked.name} 阻塞，待人工裁决`, jump: true });
    }
  }
  if (sync?.state === 'blocked') {
    // embedded：rebase 中途发生在工作区根仓库，面板不能替用户动代码仓库，只指路不挂动作
    items.push(sync.layout === 'embedded'
      ? { level: 'block', kind: 'sync-blocked', text: `根仓库 rebase 中途（上次冲突未处理完），需人工在 ${sync.repoRoot ?? '根仓库'} 解冲突后 git rebase --continue` }
      : { level: 'block', kind: 'sync-blocked', text: '资产同步冲突已中止回滚，需要人工合并（.harness 仓库）', sync: true });
  }
  for (const t of tasks) {
    if (t.status === 'AWAITING_ARCHIVE') {
      items.push({ level: 'warn', kind: 'archive', task: t.task, text: `${t.task} · 已完成待归档`, line: `/hk-archive ${t.task}` });
    }
  }
  for (const t of tasks) {
    if (t.status !== 'DONE' && t.progress?.outOfOrder) {
      items.push({ level: 'warn', kind: 'chain-out-of-order', task: t.task, text: `${t.task} · 看板链越序：当前阶段之前还有未完成阶段（应补 ✅ 或 —）`, jump: true });
    }
  }
  if (gaps.length > 0) {
    items.push({ level: 'warn', kind: 'init-incomplete', text: `初始化不完整：缺 ${gaps.join('、')}（由初始化编排生成，重跑骨架物化不产生这些文件）`, init: true });
  }
  if (sync?.state === 'behind' || sync?.state === 'diverged') {
    // embedded：落后的是工作区根仓库，资产随根仓库 commit/push 共享，/hk-sync 不适用——
    // 只提示不挂「立即同步」动作（挂了只会得到"不适用"报错，2026-11-13 用户踩中）
    items.push(sync.layout === 'embedded'
      ? { level: 'warn', kind: 'sync-behind', text: `工作区根仓库落后远端 ${sync.behind} 个提交${sync.dirty ? '，.harness 有未提交变更' : ''}（资产随根仓库管理，在根仓库 git pull/push 即共享）` }
      : { level: 'warn', kind: 'sync-behind', text: `资产仓库落后远端 ${sync.behind} 个提交${sync.dirty ? '，且有未提交变更' : ''}`, sync: true });
  }
  // M2：stale slot（任务已归档但分支未合入，槽位被保留占用）→ 提醒人确认合入后重跑归档释放
  for (const s of staleSlots) {
    items.push({ level: 'warn', kind: 'workspace-stale', task: s.task, text: `${s.repo} 的 ${s.slot} 保留未释放：任务 ${s.task} 分支 ${s.branch} 未合入基线（远端 MR 合入后重跑 /hk-archive ${s.task} 释放槽位）`, jump: true });
  }
  // TE 串行：有人在排队时提示当前持有者与等待者
  if (teEnv?.holder && (teEnv.queue?.length ?? 0) > 0) {
    items.push({ level: 'warn', kind: 'te-queued', task: teEnv.holder, text: `TE 环境被 ${teEnv.holder} 占用，排队等待：${teEnv.queue.join(' → ')}（TE 完成后自动释放，无需人工）` });
  }
  // 待裁决决策点（外来分支占用等）：block 级常驻，options 由面板渲染为可点按钮
  for (const [task, d] of Object.entries(decisions ?? {})) {
    items.push({
      level: 'block', kind: 'workspace-decision', task,
      text: d.text || `任务 ${task} 有待裁决决策点（${d.code}）`,
      options: Array.isArray(d.options) ? d.options : [], jump: true,
    });
  }
  return items;
}

/** 解析 git log 行（%h%x1f%an%x1f%ad%x1f%s）。 */
export function parseGitLog(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, author, at, ...rest] = line.split('\x1f');
      return { hash, author, at, subject: rest.join('\x1f') };
    })
    .filter((e) => e.hash && e.subject);
}

/**
 * 受控更新 kit.json（M4b 配置视图第 2 层）。
 * patch: { sources?: [{name, branch}], autoSync?: boolean, models?: {logical: {provider?, model}} }
 * 返回 { ok: true, kit } 或 { error }。
 */
export function updateKit(ws, patch) {
  const kit = readKit(ws);
  if (!kit) return { error: '尚未初始化：请先运行 /hk-init' };
  if (patch == null || typeof patch !== 'object') return { error: 'patch 必须是对象' };

  if (patch.sources !== undefined) {
    if (!Array.isArray(patch.sources)) return { error: 'sources 必须是数组' };
    for (const s of patch.sources) {
      if (typeof s?.name !== 'string' || typeof s?.branch !== 'string' || !s.branch.trim()) {
        return { error: 'sources 每项需含 name 与非空 branch' };
      }
      const target = kit.sources.find((k) => k.name === s.name);
      if (!target) return { error: `未知子工程：${s.name}` };
      target.branch = s.branch.trim();
    }
  }
  if (patch.autoSync !== undefined) {
    if (typeof patch.autoSync !== 'boolean') return { error: 'autoSync 必须是布尔值' };
    kit.assets = kit.assets ?? { mode: 'local' };
    kit.assets.autoSync = patch.autoSync;
  }
  // 流程配置（2026-11-18 从 .harness/config.json 迁入 kit.json，面板设置页可改）
  if (patch.applyMode !== undefined) {
    if (!['auto', 'review'].includes(patch.applyMode)) return { error: "applyMode 必须是 'auto' 或 'review'" };
    kit.applyMode = patch.applyMode;
  }
  if (patch.models !== undefined) {
    if (typeof patch.models !== 'object' || patch.models === null || Array.isArray(patch.models)) {
      return { error: 'models 必须是对象' };
    }
    for (const [k, v] of Object.entries(patch.models)) {
      if (v == null) continue; // null = 删除映射
      if (typeof v !== 'object' || typeof v.model !== 'string' || !v.model.trim()) {
        return { error: `models.${k} 需为 {provider?, model}` };
      }
    }
    kit.models = kit.models ?? {};
    for (const [k, v] of Object.entries(patch.models)) {
      if (v == null) delete kit.models[k];
      else kit.models[k] = { ...(v.provider ? { provider: v.provider } : {}), model: v.model.trim() };
    }
  }
  writeKit(ws, kit);
  return { ok: true, kit };
}

/** 汇总一个工作区的面板状态；无 .harness 返回 null。 */
export function workspaceState(ws, { sync = null } = {}) {
  if (!fs.existsSync(harnessDir(ws))) return null;
  const boardFile = path.join(harnessDir(ws), 'tasks', 'board.md');
  const board = fs.existsSync(boardFile) ? parseBoard(fs.readFileSync(boardFile, 'utf8')) : { headers: [], rows: [] };
  let kit = null;
  try { kit = readKit(ws) ?? defaultKit(); } catch { kit = defaultKit(); }
  const claimsFile = path.join(harnessDir(ws), 'tasks', 'claims.json');
  const claims = fs.existsSync(claimsFile) ? parseClaims(fs.readFileSync(claimsFile, 'utf8')) : {};
  const taskSessions = readTaskSessions(ws);
  const ledger = readWorkspaces(ws);
  const ledgerTe = readTestEnv(ws);
  const tasks = board.rows.map((row) => {
    const progress = taskProgress(ws, kit, row.task, row.profile, row.status, row.apply);
    return {
      ...row,
      progress,
      action: nextAction(row, progress),
      lane: laneOf(row, progress),
      claimer: claims[row.task]?.by ?? null,
      sessionId: taskSessions[row.task]?.sessionId ?? null,
      // M2 工作区分配（本机台账）：{ <repo>: { placement: 'main'|'slot-N', branch, base } } | null
      workspace: ledger.tasks[row.task]?.repos ?? null,
      // TE 环境持有者标记（串行租约）
      teHolder: ledgerTe.holder === row.task,
    };
  });
  // M2 slot 池概览 + stale 清单（未合入保留的槽位，需人确认后重跑归档释放）
  const slots = Object.fromEntries(Object.entries(ledger.slots).map(([repo, m]) => [repo,
    Object.entries(m).map(([slot, b]) => ({ slot, task: b.task, branch: b.branch, state: b.state ?? 'bound' }))]));
  const staleSlots = Object.entries(slots).flatMap(([repo, arr]) => arr.filter((s) => s.state === 'stale-unmerged').map((s) => ({ repo, ...s })));
  return {
    path: ws,
    board,
    tasks,
    claims,
    sync,
    slots,
    te: ledgerTe,
    attention: (() => {
      const items = attentionItems(tasks, sync, initGaps(ws, kit), staleSlots, ledgerTe, readDecisions(ws));
      // 初始化失败 → block 级常驻提示（页面重开仍可见；成功后自动消失）
      const initJob = initProgress.get(ws);
      if (initJob?.done && initJob.error) {
        items.push({ level: 'block', kind: 'init-failed', text: `初始化失败：${String(initJob.error).replace(/\s+/g, ' ').slice(0, 240)}（到「配置」页重跑初始化）`, init: true });
      }
      return items;
    })(),
    assets: kit.assets
      ? { mode: kit.assets.mode ?? 'local', url: kit.assets.url ?? null, branch: kit.assets.branch ?? null, autoSync: kit.assets.autoSync === true }
      : { mode: 'local', url: null, branch: null, autoSync: false },
  };
}

/** 旧版 .harness/config.json（仅用于设置页提示迁移；新配置一律写 kit.json）。 */
function readLegacyConfig(ws) {
  try {
    const p = path.join(harnessDir(ws), 'config.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { applyMode: raw['apply-mode'] ?? null, mainlineBranch: raw['mainline-branch'] ?? null };
  } catch { return null; }
}

// ---------------------------------------------------------- 初始化进度（向导动态提示）
// wsPath → { stage, detail, startedAt, done, error }；仅内存态，进程重启即清空
const initProgress = new Map();

// ---------------------------------------------------------- 同步健康（缓存）
const SYNC_TTL_MS = 5 * 60 * 1000;
const syncCache = new Map(); // ws → { at, data, inflight }

/** 拉取宿主 LLM 注册的 provider/模型清单，供设置页模型映射下拉。失败容忍为 []。 */
export async function listModelCatalog(llm) {
  try {
    if (!llm || typeof llm.listProviders !== 'function') return [];
    const providers = llm.listProviders();
    const out = [];
    for (const p of providers) {
      let models = [];
      try { models = (await llm.listModels?.(p.id)) ?? []; } catch { /* 单 provider 失败不拖垮整体 */ }
      out.push({ provider: p.id, name: p.name ?? p.id, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) });
    }
    return out;
  } catch { return []; }
}

/** 模型下拉建议：kit.json models 已映射的逻辑名 + catalog 里的全部模型 id（provider 过滤）。 */
export function modelSuggest(models, provider) {
  return (models ?? []).filter((mo) => !provider || mo.provider === provider).flatMap((mo) => mo.models ?? []).map((m) => m.id);
}

/** 设置页角色名下拉数据源：kit.json models 已映射的逻辑名（角色名的既有用法）。 */
function logicalModelNames(kit) {
  try { return Object.keys(kit?.models ?? {}).map((name) => ({ name })); } catch { return []; }
}

async function computeSyncHealth(ws) {
  const hd = harnessDir(ws);
  const g = (args, timeoutMs = 30_000) => runGit(args, { cwd: hd, timeoutMs });
  const at = new Date().toISOString();
  if (!fs.existsSync(path.join(hd, '.git'))) {
    // .harness 无独立 git：可能随工作区根仓库管理（embedded）——健康从父仓库取，
    // dirty 只看 .harness 路径范围，ahead/behind 随根仓库分支（push 会一并携带资产）。
    const lay = await assetsLayout(ws);
    if (lay.layout !== 'embedded') {
      return { state: 'local', ahead: 0, behind: 0, dirty: false, checkedAt: at };
    }
    try {
      const root = lay.repoRoot;
      const g2 = (args, timeoutMs = 30_000) => runGit(args, { cwd: root, timeoutMs });
      const gitDirOut = (await g2(['rev-parse', '--git-dir'])).stdout.trim();
      const gd = path.isAbsolute(gitDirOut) ? gitDirOut : path.join(root, gitDirOut || '.git');
      if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) {
        return { state: 'blocked', layout: 'embedded', repoRoot: root, ahead: 0, behind: 0, dirty: true, checkedAt: at };
      }
      const dirty = !!(await g2(['status', '--porcelain', '--', lay.rel])).stdout.trim();
      const remotes = (await g2(['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      if (remotes.length === 0) {
        return { state: 'embedded', layout: 'embedded', repoRoot: root, ahead: 0, behind: 0, dirty, checkedAt: at };
      }
      const remote = remotes.includes('origin') ? 'origin' : remotes[0];
      const branch = (await g2(['branch', '--show-current'])).stdout.trim() || 'master';
      const fetch = await g2(['fetch', remote, branch], 60_000);
      if (fetch.code !== 0) {
        return { state: 'offline', layout: 'embedded', repoRoot: root, ahead: 0, behind: 0, dirty, checkedAt: at, error: (fetch.stderr || fetch.stdout).trim().slice(0, 300) };
      }
      const counts = (await g2(['rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`])).stdout.trim().split(/\s+/);
      const ahead = Number(counts[0]) || 0;
      const behind = Number(counts[1]) || 0;
      const state = ahead > 0 && behind > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'clean';
      return { state, layout: 'embedded', repoRoot: root, ahead, behind, dirty, checkedAt: at };
    } catch (cause) {
      return { state: 'unknown', layout: 'embedded', ahead: 0, behind: 0, dirty: false, checkedAt: at, error: cause.message };
    }
  }
  try {
    // rebase 中途 = 上次冲突中止未处理完
    if (fs.existsSync(path.join(hd, '.git', 'rebase-merge')) || fs.existsSync(path.join(hd, '.git', 'rebase-apply'))) {
      return { state: 'blocked', ahead: 0, behind: 0, dirty: true, checkedAt: at };
    }
    const remotes = (await g(['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (remotes.length === 0) {
      return { state: 'no-remote', ahead: 0, behind: 0, dirty: false, checkedAt: at };
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const branch = readKit(ws)?.assets?.branch
      || (await g(['branch', '--show-current'])).stdout.trim() || 'master';
    const dirty = !!(await g(['status', '--porcelain'])).stdout.trim();
    const fetch = await g(['fetch', remote, branch], 60_000);
    if (fetch.code !== 0) {
      return { state: 'offline', ahead: 0, behind: 0, dirty, checkedAt: at, error: (fetch.stderr || fetch.stdout).trim().slice(0, 300) };
    }
    const upstream = `${remote}/${branch}`;
    const counts = (await g(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).stdout.trim().split(/\s+/);
    const ahead = Number(counts[0]) || 0;
    const behind = Number(counts[1]) || 0;
    const state = ahead > 0 && behind > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'clean';
    return { state, ahead, behind, dirty, checkedAt: at };
  } catch (cause) {
    return { state: 'unknown', ahead: 0, behind: 0, dirty: false, checkedAt: at, error: cause.message };
  }
}

/** 低频缓存的同步健康（同步返回，后台刷新）；force=true 强制后台重检。 */
/** 工作区内目录列举（新建任务「浏览…」）：拒绝越界/符号链接逃逸，过滤 .git 与 node_modules，目录优先排序。 */
export function browseDir(wsPath, rel = '') {
  const rootReal = fs.realpathSync(wsPath);
  const abs = path.resolve(wsPath, String(rel).replace(/^\/+|\/+$/g, '') || '.');
  if (!fs.existsSync(abs)) return { error: '目录不存在' };
  const absReal = fs.realpathSync(abs);
  if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) return { error: '目录越界' };
  if (!fs.statSync(absReal).isDirectory()) return { error: '不是目录' };
  const SKIP = new Set(['.git', 'node_modules']);
  const entries = fs.readdirSync(absReal, { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name))
    .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : (e.isFile() ? 'file' : 'other') }))
    .filter((e) => e.kind !== 'other')
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    .slice(0, 500);
  const dir = path.relative(rootReal, absReal).split(path.sep).filter(Boolean).join('/');
  return { ok: true, dir, parent: dir ? (path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir)) : null, entries };
}

export function syncHealth(ws, { force = false } = {}) {
  const cached = syncCache.get(ws);
  if (force || !cached || (!cached.inflight && Date.now() - cached.at >= SYNC_TTL_MS)) {
    if (!cached?.inflight) {
      const inflight = computeSyncHealth(ws).then((data) => {
        syncCache.set(ws, { at: Date.now(), data, inflight: null });
        return data;
      }).catch(() => cached?.data ?? null);
      syncCache.set(ws, { at: Date.now(), data: cached?.data ?? null, inflight });
    }
  }
  return syncCache.get(ws)?.data ?? { state: 'checking', ahead: 0, behind: 0, dirty: false };
}

/** 团队动态（git log，缓存 5 分钟）。 */
const activityCache = new Map();
export function teamActivity(ws, { force = false } = {}) {
  const cached = activityCache.get(ws);
  if (!force && cached && Date.now() - cached.at < SYNC_TTL_MS) return Promise.resolve(cached.data);
  const hd = harnessDir(ws);
  if (!fs.existsSync(path.join(hd, '.git'))) return Promise.resolve([]);
  return runGit(['log', '-n', '50', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--date=format:%Y-%m-%d %H:%M'], { cwd: hd, timeoutMs: 15_000 })
    .then((r) => {
      const entries = r.code === 0 ? parseGitLog(r.stdout) : [];
      activityCache.set(ws, { at: Date.now(), data: entries });
      return entries;
    })
    .catch(() => cached?.data ?? []);
}

// --------------------------------------------------------------- HTTP 接线
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Guard one panel HTTP handler with DSH Connection's Host/Origin and browser
 * authentication check. Every route is owner-private (workspace paths,
 * commands, filesystem browsing, git operations), so a route that skips this
 * can be called by any web page open in the same browser.
 *
 * Exported for the regression suite. `connection` must expose
 * `requestRejection(req)`; the caller decides whether a missing service is a
 * mount-time error. Here a missing service fails closed.
 */
export function guardPanelHandler(handler, connection) {
  return async function guardedPanelHandler(req, res) {
    if (!connection || typeof connection.requestRejection !== 'function') {
      return sendJson(res, 500, { ok: false, error: 'connection-unavailable' });
    }
    const refused = connection.requestRejection(req);
    if (refused !== undefined) {
      return sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' });
    }
    return handler(req, res);
  };
}

const findWs = (registry, ref) => registry.list().find((w) => w.id === ref || w.path === ref);

/**
 * 注册面板 HTTP 端点。全部服务按可选读取（非 web 组成下静默跳过）。
 * 返回 disposer 列表（调用方负责挂 ctx.effect）。
 */
export function registerPanelApi(ctx) {
  const webServer = ctx.get('webServer');
  const registry = ctx.get('workspaceRegistry');
  if (!webServer || !registry) return [];
  const agents = ctx.get('agents');
  const commands = ctx.get('commands');
  const sessionTitle = ctx.get('sessionTitle');
  const llm = ctx.get('llm');
  const connection = ctx.get('connection');
  const logger = ctx.get('logger');
  if (!connection) {
    logger?.warn?.('harness-kit: connection service unavailable; panel API not mounted');
    return [];
  }

  const disposers = [];
  const mount = (route) => {
    try {
      const guarded = typeof route.handler === 'function'
        ? { ...route, handler: guardPanelHandler(route.handler, connection) }
        : route;
      const rawDispose = webServer.register(guarded);
      // webServer 的 disposer 按 key 删除（table.delete(path)）：旧 fiber 的处置
      // 若晚于新 fiber 注册执行，会误删新注册。挂 identity 守卫——仅当表中
      // 当前条目确为本 fiber 注册的 route 对象时才真正摘除。
      const table = guarded.kind === 'exact' ? webServer.exact : webServer.prefixes;
      disposers.push(() => {
        if (table?.get?.(guarded.path) === guarded) rawDispose();
      });
    } catch (cause) {
      // 热重载残留的史前注册无法在进程内摘除；容忍复用，重启 Host 后由新代码接管。
      if (/duplicate/.test(cause.message)) {
        logger?.warn?.(`harness-kit: route ${route.path} 已被旧实例占用，沿用旧处理器（重启 Host 后刷新）`);
      } else throw cause;
    }
  };

  // ---- 自动续接引擎：人裁决（定稿 approved / 审批 1：通过）落盘后自动接力下一条命令，
  // 不再要求人手动敲 /hk-propose、/hk-apply。7s 轮询全部含 .harness 的工作区；
  // 触发需同时满足：看板闸门（PENDING/IN_PROGRESS）+ 一次性标记未落盘 +
  // 任务有会话绑定且该会话 agent 在线。失败按 5 分钟退避重试，成功才落标记。
  // kit.json 里 autoAdvance=false 可整区关闭。审批/归档本身始终是人裁决。
  const advanceBackoff = new Map(); // `${wsPath}|${task}|${hop}` → 上次尝试 ts
  let advanceRunning = false;
  const autoAdvanceTick = async () => {
    if (advanceRunning || !agents || !commands) return;
    advanceRunning = true;
    try {
      for (const w of registry.list()) {
        const ws = w.path;
        if (!fs.existsSync(harnessDir(ws))) continue;
        let kit = null;
        try { kit = readKit(ws); } catch { continue; }
        if (kit?.autoAdvance === false) continue;
        let hops;
        try { hops = scanAutoAdvance(ws); } catch { continue; }
        const decisions = readDecisions(ws);
        for (const hop of hops) {
          // 有待裁决决策点的任务：引擎不自动重试（重试无意义且刷日志），等人在面板/会话裁决后清决策点
          if (decisions[hop.task]) continue;
          const key = `${ws}|${hop.task}|${hop.hop}`;
          if (Date.now() - (advanceBackoff.get(key) ?? 0) < 5 * 60 * 1000) continue;
          const sessionId = readTaskSessions(ws)[hop.task]?.sessionId;
          if (!sessionId) continue;
          const agent = agents.get(sessionId);
          if (!agent) continue;
          advanceBackoff.set(key, Date.now());
          try {
            const exec = await commands.execute(agent, hop.line, [], new AbortController().signal);
            if (exec?.result?.kind === 'error') {
              logger?.warn?.(`harness-kit 自动续接失败：${hop.line} → ${exec.result.text}`);
              continue;
            }
            markAdvanceFired(ws, hop.task, hop.hop);
            advanceBackoff.delete(key);
            logger?.info?.(`harness-kit 自动续接：${hop.task} ${hop.hop === 'propose' ? '定稿→propose' : hop.hop === 'archive' ? '审批2→archive' : '审批1→apply'}（${hop.line} → ${sessionId}）`);
          } catch (cause) {
            logger?.warn?.(`harness-kit 自动续接异常：${hop.line} → ${cause.message}`);
          }
        }
        // TE 环境对账：holder 越过 TE（链标 ✅/—/归档）→ 自动释放并晋升队首，
        // 向被晋升任务绑定的会话注入「轮到你了」。排队任务自己越过 TE → 自动出队。
        try {
          const board = parseBoard(fs.readFileSync(path.join(harnessDir(ws), 'tasks', 'board.md'), 'utf8')).rows;
          const { promoted } = reconcileTestEnv(ws, board);
          if (promoted) {
            const sessionId = readTaskSessions(ws)[promoted]?.sessionId;
            const agent = sessionId && agents.get(sessionId);
            if (agent) {
              try {
                await commands.execute(agent, `TE 环境已释放，已授权给本任务：请继续 TE 阶段（环境独占，直接派发 Test Engineer 即可，无需再 acquire）。`, [], new AbortController().signal);
                logger?.info?.(`harness-kit TE 环境晋升：${promoted}（→ ${sessionId}）`);
              } catch (cause) {
                logger?.warn?.(`harness-kit TE 晋升注入失败：${promoted} → ${cause.message}`);
              }
            }
          }
        } catch { /* 对账失败下轮重试 */ }
      }
    } finally {
      advanceRunning = false;
    }
  };
  const advanceTimer = setInterval(() => { void autoAdvanceTick(); }, 7000);
  if (typeof advanceTimer.unref === 'function') advanceTimer.unref();
  disposers.push(() => clearInterval(advanceTimer));

  mount({
    kind: 'exact',
    path: '/harness-kit/state',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const workspaces = [];
        for (const w of registry.list()) {
          if (!fs.existsSync(harnessDir(w.path))) continue;
          // 同步健康走缓存：命中立即返回，未命中后台刷新本轮先给旧值/空
          const sync = syncHealth(w.path);
          const state = workspaceState(w.path, { sync });
          if (!state) continue;
          const archivedSet = new Set(registry.archivedSessionIds ?? []);
          const sessions = w.sessionIds.map((id) => ({ id, live: !!agents?.get(id), archived: archivedSet.has(id) }));
          // 新建任务模态框的分析基点下拉：各仓可选分支清单
          let gitBranches = {};
          try { gitBranches = await listAllGitBranches(w.path, readKit(w.path) ?? {}); } catch { gitBranches = {}; }
          // init：初始化任务进行状态（页面关掉后重开也能看到，防止无感知重复初始化）
          workspaces.push({ id: w.id, title: w.title, ...state, sessions, gitBranches, init: initProgress.get(w.path) ?? null });
        }
        sendJson(res, 200, { ok: true, workspaces });
      } catch (cause) {
        logger?.warn?.(`harness-kit panel state failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  mount({
    kind: 'exact',
    path: '/harness-kit/config',
    async handler(req, res) {
      const ref = new URL(req.url, 'http://x').searchParams.get('workspace');
      if (req.method === 'GET') {
        try {
          const ws = findWs(registry, ref);
          if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
          const kit = readKit(ws.path);
          if (!kit) return sendJson(res, 404, { ok: false, error: '尚未初始化' });
          sendJson(res, 200, {
            ok: true,
            kit: {
              pack: kit.pack ?? 'ai-coding',
              hosts: kit.hosts ?? [],
              sources: kit.sources ?? [],
              models: kit.models ?? {},
              assets: kit.assets ?? { mode: 'local' },
              // 流程配置（原 .harness/config.json，2026-11-18 迁入 kit.json）
              applyMode: kit.applyMode ?? 'auto',
              legacyConfig: readLegacyConfig(ws.path),
            },
            sync: syncHealth(ws.path),
            catalog: await listModelCatalog(llm),
            presetModels: logicalModelNames(kit),
            roles: listRoles(ws.path, kit).map((r) => ({ role: r.role, name: r.meta?.name ?? r.role, logical: r.meta?.model ?? null, origin: r.origin })),
          });
        } catch (cause) {
          sendJson(res, 500, { ok: false, error: cause.message });
        }
        return;
      }
      if (req.method === 'POST') {
        try {
          const { workspace, patch } = JSON.parse(await readBody(req) || '{}');
          const ws = findWs(registry, workspace);
          if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
          const r = updateKit(ws.path, patch);
          if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
          sendJson(res, 200, { ok: true });
        } catch (cause) {
          sendJson(res, 500, { ok: false, error: cause.message });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    },
  });

  // 新建任务「浏览…」：工作区内目录列举（仅供选文件；拒绝越界/符号链接逃逸；过滤 .git 与 node_modules）
  mount({
    kind: 'exact',
    path: '/harness-kit/browse',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        const ws = findWs(registry, q.get('workspace'));
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
        const r = browseDir(ws.path, q.get('dir') ?? '');
        if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
        sendJson(res, 200, r);
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // 环境预检：向导打开时检查 git / Python 3，缺失项返回对应平台的安装命令。
  mount({
    kind: 'exact',
    path: '/harness-kit/env',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        sendJson(res, 200, { ok: true, ...(await checkEnvironment()) });
      } catch (cause) {
        logger?.warn?.(`harness-kit env check failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  mount({
    kind: 'exact',
    path: '/harness-kit/activity',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const ref = new URL(req.url, 'http://x').searchParams.get('workspace');
        const ws = findWs(registry, ref);
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
        sendJson(res, 200, { ok: true, entries: await teamActivity(ws.path) });
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  mount({
    kind: 'exact',
    path: '/harness-kit/sync',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const { workspace } = JSON.parse(await readBody(req) || '{}');
        const ws = findWs(registry, workspace);
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
        const kit = readKit(ws.path);
        if (!kit) return sendJson(res, 404, { ok: false, error: '尚未初始化' });
        const r = await syncAssets(ws.path, kit);
        syncCache.delete(ws.path); // 同步后强制下次重检
        sendJson(res, r.kind === 'success' ? 200 : 409, { ok: r.kind === 'success', text: r.text });
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // 临时排障（2026-11-13，「继续推进跳转异常」）：命令路由关键步骤落盘，事后可回放点击链路。
  const dbg = (obj) => {
    try {
      fs.appendFileSync('/tmp/hk-command-debug.log',
        JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
    } catch { /* 排障日志失败不阻断 */ }
  };

  mount({
    kind: 'exact',
    path: '/harness-kit/command',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const { workspace, line, sessionId } = JSON.parse(await readBody(req) || '{}');
        dbg({ ev: 'recv', workspace, line, sessionId: sessionId ?? null });
        if (typeof line !== 'string' || !line.startsWith('/hk-')) {
          return sendJson(res, 400, { ok: false, error: '仅允许 /hk-* 命令' });
        }
        const ws = findWs(registry, workspace);
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
        let found;
        if (typeof sessionId === 'string' && sessionId) {
          // 定向注入（立项专属会话）：新建会话的 agent 注册有延迟，轮询等待就绪（≤15s）
          const deadline = Date.now() + 15000;
          let agent = agents?.get(sessionId);
          while (!agent && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            agent = agents?.get(sessionId);
          }
          if (agent) found = { id: sessionId, agent };
        } else {
          // 优先有活 agent 的会话（最近注册优先）
          found = [...ws.sessionIds].reverse().map((id) => ({ id, agent: agents?.get(id) })).find((x) => x.agent);
        }
        if (!found) {
          dbg({ ev: 'no-agent', directed: !!sessionId, wsSessions: [...ws.sessionIds] });
          return sendJson(res, 409, {
            ok: false,
            error: sessionId ? '目标会话尚未就绪，请稍后重试' : '该工作区没有活动会话，请先打开一个会话再操作',
          });
        }
        dbg({ ev: 'pick', directed: !!sessionId, picked: found.id });
        // execute 返回 CommandExecution|undefined（语法/名称未解析时 undefined，且不落任何日志）；
        // 必须检查 result.kind——handler 失败（如任务撞名）时把真实错误透传给面板，
        // 否则用户只看到「已发送」而会话里什么都没发生。
        const exec = await commands.execute(found.agent, line, [], new AbortController().signal);
        dbg({ ev: 'exec', sessionId: found.id, execUndefined: !exec, resultKind: exec?.result?.kind ?? null });
        if (!exec) {
          return sendJson(res, 400, { ok: false, error: `命令未注册或无法解析：${line}`, sessionId: found.id });
        }
        if (exec.result?.kind === 'error') {
          return sendJson(res, 200, { ok: false, error: exec.result.text || '命令执行失败', sessionId: found.id });
        }
        if (exec.result?.kind === 'decision') {
          // 结构化决策点：面板渲染可点选项（不登记绑定——命令未成功执行）
          return sendJson(res, 200, {
            ok: false, decision: true, code: exec.result.code,
            text: exec.result.text, options: exec.result.options, sessionId: found.id,
          });
        }
        // 任务↔会话绑定：命令成功才登记；命令行可解析出 ASCII 任务名即登记（--auto 自动命名场景由后续 hk-propose/apply 补绑）
        const boundTask = line.match(/^\/hk-(?:new|fix|propose|apply|archive)\s+([A-Za-z0-9][A-Za-z0-9_-]*)/)?.[1];
        if (boundTask) {
          try { recordTaskSession(ws.path, boundTask, found.id); } catch { /* 绑定失败不阻断命令 */ }
        }
        // 立项会话命名：hk-new/hk-fix 成功后把会话标题固定为任务名（user 源，后续自动标题生成不再覆盖）。
        // --auto 场景命令行没有任务名，从成功文本的 **task** 提取。
        if (/^\/hk-(?:new|fix)\s/.test(line)) {
          const named = boundTask || exec.result?.text?.match(/\*\*([A-Za-z0-9][A-Za-z0-9_-]*)\*\*/)?.[1];
          if (named && found.agent?.session) {
            try { sessionTitle?.rename(found.agent.session, named); } catch { /* 命名失败不阻断命令 */ }
          }
        }
        sendJson(res, 200, { ok: true, line, sessionId: found.id, text: exec.result?.text });
        // 归档兜底（2026-11-13 定位）：绑定会话被归档后，客户端 openSession 选中它会被
        // 导航效应立刻清回空白「新会话」视图（归档会话在侧栏隐藏），表现为「跳到一个空白
        // 新对话窗」。命令成功即视为用户关注该会话，这里幂等取消归档；放在响应之后，
        // 不影响时延，失败只记日志。
        if (registry.archivedSessionIds?.includes?.(found.id)) {
          registry.unarchiveSession(found.id).catch((e) => logger?.warn?.(`harness-kit unarchive failed: ${e.message}`));
        }
      } catch (cause) {
        logger?.warn?.(`harness-kit panel command failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // 临时排障端点：客户端把跳转步骤（hasLiveSession/openSession 结果）回报到同一日志文件。
  mount({
    kind: 'exact',
    path: '/harness-kit/debug-log',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        dbg({ ev: 'client', ...body });
      } catch { /* 忽略坏包 */ }
      sendJson(res, 200, { ok: true });
    },
  });

  mount({
    kind: 'exact',
    path: '/harness-kit/bind-session',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const { workspace, task, sessionId } = JSON.parse(await readBody(req) || '{}');
        const ws = findWs(registry, workspace);
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区' });
        if (typeof task !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(task)) {
          return sendJson(res, 400, { ok: false, error: '任务名非法' });
        }
        if (typeof sessionId !== 'string' || !sessionId) {
          return sendJson(res, 400, { ok: false, error: 'sessionId 缺失' });
        }
        recordTaskSession(ws.path, task, sessionId);
        sendJson(res, 200, { ok: true });
      } catch (cause) {
        logger?.warn?.(`harness-kit bind-session failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // ------------------------------------------------------- 工作区开通/初始化（面板向导）
  // inspect：目录预检（打开/新建向导共用，返回是否 Harness 工作区与注册状态）
  mount({
    kind: 'exact',
    path: '/harness-kit/workspace/inspect',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const info = inspectDir(body.path);
        const registered = info.path ? findWs(registry, info.path) : undefined;
        sendJson(res, 200, {
          ok: true,
          inspect: info,
          registered: registered ? { id: registered.id, title: registered.title, path: registered.path } : null,
        });
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // create：把任意已存在目录注册为 DSH 工作区（新建向导第一步；不建目录、不写资产）
  mount({
    kind: 'exact',
    path: '/harness-kit/workspace/create',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const wsPath = typeof body.path === 'string' ? body.path.trim() : '';
        if (!wsPath || !path.isAbsolute(wsPath)) return sendJson(res, 400, { ok: false, error: 'path 必须是绝对路径' });
        const info = inspectDir(wsPath);
        if (!info.exists) return sendJson(res, 400, { ok: false, error: `目录不存在：${wsPath}` });
        if (!info.isDir) return sendJson(res, 400, { ok: false, error: `不是目录：${wsPath}` });
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
        const w = await registry.create(wsPath, title);
        sendJson(res, 200, { ok: true, workspace: { id: w.id, title: w.title, path: w.path }, inspect: inspectDir(w.path) });
      } catch (cause) {
        logger?.warn?.(`harness-kit workspace create failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // open：打开已有 Harness 工作区——必须含可解析的 .harness/kit.json，否则 409
  mount({
    kind: 'exact',
    path: '/harness-kit/workspace/open',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const wsPath = typeof body.path === 'string' ? body.path.trim() : '';
        if (!wsPath || !path.isAbsolute(wsPath)) return sendJson(res, 400, { ok: false, error: 'path 必须是绝对路径' });
        const info = inspectDir(wsPath);
        if (!info.exists) return sendJson(res, 400, { ok: false, error: `目录不存在：${wsPath}` });
        if (!info.isDir) return sendJson(res, 400, { ok: false, error: `不是目录：${wsPath}` });
        if (!info.hasKit) {
          return sendJson(res, 409, { ok: false, code: 'not-harness', error: '该目录不是 Harness 工作区：缺少 .harness/kit.json（可改用「新建工作区」并在此目录初始化）', inspect: info });
        }
        if (info.kitError) {
          return sendJson(res, 409, { ok: false, code: 'kit-corrupt', error: `.harness/kit.json 解析失败：${info.kitError}`, inspect: info });
        }
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
        const w = await registry.create(wsPath, title);
        sendJson(res, 200, { ok: true, workspace: { id: w.id, title: w.title, path: w.path }, inspect: info });
      } catch (cause) {
        logger?.warn?.(`harness-kit workspace open failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  // init：在已注册工作区上执行 /hk-init 等价物化（幂等），可附带登记子工程（/hk-setup --add 等价）。
  // body: {workspace, assets?: {mode:'local'|'init'|'url', url?, branch?}, sources?: [{url, name?, path?, role?, branch?}]}
  mount({
    kind: 'exact',
    path: '/harness-kit/workspace/init',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const ws = findWs(registry, body.workspace);
        if (!ws) return sendJson(res, 404, { ok: false, error: '未知工作区（请先在 DSH 注册该目录）' });
        let assets;
        let branch;
        if (body.assets != null) {
          const a = body.assets;
          if (!a || typeof a !== 'object' || !['local', 'init', 'url'].includes(a.mode)) {
            return sendJson(res, 400, { ok: false, error: 'assets.mode 必须是 local/init/url' });
          }
          if (a.mode === 'url') {
            const url = typeof a.url === 'string' ? a.url.trim() : '';
            if (!url) return sendJson(res, 400, { ok: false, error: 'assets.mode=url 时必须提供 assets.url' });
            assets = url;
          } else {
            assets = a.mode;
          }
          branch = typeof a.branch === 'string' && a.branch.trim() ? a.branch.trim() : undefined;
        }
        const sources = [];
        if (body.sources != null) {
          if (!Array.isArray(body.sources)) return sendJson(res, 400, { ok: false, error: 'sources 必须是数组' });
          for (const s of body.sources) {
            if (!s || typeof s !== 'object') return sendJson(res, 400, { ok: false, error: 'sources 元素必须是对象' });
            const url = typeof s.url === 'string' ? s.url.trim() : '';
            if (!url) return sendJson(res, 400, { ok: false, error: '每个子工程必须提供 url' });
            const spec = { url };
            for (const k of ['name', 'path', 'role', 'branch']) {
              if (typeof s[k] === 'string' && s[k].trim()) spec[k] = s[k].trim();
            }
            if (spec.path) {
              const abs = path.resolve(ws.path, spec.path);
              if (abs !== ws.path && !abs.startsWith(ws.path + path.sep)) {
                return sendJson(res, 400, { ok: false, error: `子工程路径越界：${spec.path}` });
              }
            }
            sources.push(spec);
          }
        }
        // 异步任务化（2026-11-17）：初始化可能持续十几分钟（大仓克隆），不能挂在单个
        // HTTP 请求上——页面刷新/重载会掐断请求，前端只看到 "Failed to fetch" 而任务其实在跑。
        // 改为：POST 立即返回 started，后台执行 + 进度端点轮询；刷新页面不影响任务完成。
        const prevJob = initProgress.get(ws.path);
        if (prevJob && !prevJob.done) {
          return sendJson(res, 409, { ok: false, error: '该工作区初始化已在进行中，请等待完成（可刷新页面，任务不受影响）' });
        }
        initProgress.set(ws.path, { stage: '准备', detail: '校验参数', startedAt: Date.now(), done: false, error: null, result: null });
        void (async () => {
          const setP = (patch) => {
            initProgress.set(ws.path, { ...(initProgress.get(ws.path) ?? {}), ...patch });
          };
          try {
            const r = await runInit(ws.path, {
              assets, branch, sources,
              onProgress: (p) => setP({ stage: p.stage, detail: p.detail, done: false, error: null }),
            });
            if (!r.ok) {
              setP({ stage: '失败', detail: '', done: true, error: r.error });
              return;
            }
            setP({
              stage: '完成', detail: '', done: true, error: null, finishedAt: Date.now(),
              result: {
                report: formatInitReport(r),
                created: r.created,
                kept: r.kept,
                scanned: r.scanned,
                warnings: r.warnings,
                sources: r.kit.sources,
                sourceErrors: r.sourceReports.filter((x) => !x.ok).map((x) => x.error),
              },
            });
          } catch (cause) {
            setP({ stage: '失败', detail: '', done: true, error: String(cause?.message ?? cause) });
          }
        })();
        return sendJson(res, 200, { ok: true, started: true, workspace: ws.id });
      } catch (cause) {
        logger?.warn?.(`harness-kit workspace init failed: ${cause.message}`);
        sendJson(res, 500, { ok: false, error: cause.message });
      }
    },
  });

  logger?.info?.('harness-kit: M4b panel API mounted (state/config/activity/sync/command/bind-session/workspace-inspect/create/open/init)');
  return disposers;
}
