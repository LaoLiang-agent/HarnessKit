// /hk-* command registrations. Commands follow the plan-mode precedent:
// handlers do deterministic file/git work themselves, then steer the
// receiving agent with a compiled orchestration prompt for the LLM part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wsRoot, readKit, writeKit, defaultKit, harnessDir, packDir, protectedSourcePaths } from './paths.js';
import { runGit, run } from './exec.js';
import { steer } from './steer.js';
import { resolveRole, listRoles, readCoreRules } from './roles.js';
import { loadFlow, compileFlowPrompt } from './flows.js';
import { activeTasks, taskIsPlanning } from './state.js';
import { assetsLayout, syncAssets } from './sync.js';
import { claimTask } from './panel.js';
import { clearAdvanceMarks } from './advance.js';
import { ensureTaskWorkspaces, releaseTaskWorkspaces, clearTaskWorkspaces, renderWorkspaceNotice, ensureBaselineMirrors, renderAnalysisNotice, ensureTaskAnalysisWorktrees, removeTaskAnalysisWorktrees, parseBaseSpec, describeMainWorktree, recordDecision, clearDecision, readWorkspaces, mergeTaskBranches, reconcileArchivedWorktrees } from './worktree.js';
import { acquireTestEnv, releaseTestEnv, describeTestEnv } from './te.js';
import { discoverAll, discoverSource, readLocalFiles, writeLocalFiles, provisionAllSlots } from './local-files.js';
import { recordTaskSession } from './bindings.js';
import { addSource, runInit, formatInitReport, guessRole, boardTemplate } from './setup.js';
import { dispatchSection, describeWorkerModel } from './models.js';

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });
// 结构化决策点（B 方案）：需要人裁决但选项明确的场景（如工作区外来占用）。
// 会话路由按 text 渲染；面板路由识别 kind 后渲染可点选项。options[].line 可直接重跑。
const decision = (text, code, options) => ({ kind: 'decision', text, code, options });

/** 把任务绑定到执行命令的当前会话（覆盖手敲命令等面板路由不在场的入口；取不到 id 则跳过）。 */
function bindCurrentSession(ws, task, agent) {
  const sid = agent?.session?.id ?? agent?.id;
  if (typeof sid !== 'string' || sid.length === 0) return;
  try { recordTaskSession(ws, task, sid); } catch { /* 绑定失败不阻断命令 */ }
}

/** 归档台账对账失败不阻断命令；下一次命令/doctor 会再试。 */
async function reconcileArchivedQuiet(ws, kit) {
  try { return await reconcileArchivedWorktrees(ws, kit); } catch { return null; }
}

function parseArgs(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[key] = tokens[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

// ----------------------------------------------------------- M2 shared helpers
const PROFILES = ['standard', 'quick', 'bugfix', 'refactor'];
const APPROVAL1 = /审批\s*1[^0-9\n]{0,20}(通过|PASS)/i;
const STATUS_APPROVED = /状态[*＊]*[:：][ \t]*`?approved(?![\w-])/im;
/** 任务名即活目录名：中英文/数字开头，可含 - 与 _。 */
const TASK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // 英文/数字开头，可含 -_（中文名走 --auto 派生 slug）

/** --auto：从描述派生任务名（英文词 kebab；纯中文回退时间戳；撞名自动加序号）。 */
function autoTaskName(ws, desc) {
  const words = (String(desc).match(/[A-Za-z][A-Za-z0-9]*/g) || []).slice(0, 4);
  let base = words.join('-').toLowerCase().replace(/^-+|-+$/g, '');
  if (!base) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    base = `auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  base = base.slice(0, 40);
  let name = base;
  for (let i = 2; fs.existsSync(path.join(harnessDir(ws), 'deliverables', name)); i++) name = `${base}-${i}`;
  return name;
}

/** Extract the declared profile from proposal.md; template option lines ("A | B") are ignored. */
function readProfile(proposal) {
  for (const line of proposal.split('\n')) {
    const m = line.match(/profile[*＊]*[:：][ \t]*`?\**\s*(standard|quick|bugfix|refactor)(?![\w-])/i);
    if (m && !line.slice(line.indexOf(m[1]) + m[1].length).includes('|')) return m[1].toLowerCase();
  }
  return 'standard';
}

/**
 * Verdict of the LAST conclusion section (`## 结论` / `### 结论` / `## 就绪自评`).
 * Prefers an explicit 「结论：PASS/BLOCK」 line; falls back to the last PASS/BLOCK
 * token in the section. Returns 'PASS' | 'BLOCK' | null.
 */
function lastConclusion(text) {
  const matches = [...text.matchAll(/^#{2,3}\s*\**\s*(结论|就绪自评)\s*\**\s*$/gm)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const rest = text.slice(last.index + last[0].length);
  const next = rest.search(/^#{1,4}\s/m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const explicit = [...section.matchAll(/结论[*＊]*[:：][ \t]*`?\**\s*(PASS|BLOCK)(?![\w-])/gi)];
  if (explicit.length > 0) return explicit[explicit.length - 1][1].toUpperCase();
  const tokens = [...section.matchAll(/(PASS|BLOCK)(?![\w-])/g)];
  return tokens.length > 0 ? tokens[tokens.length - 1][1].toUpperCase() : null;
}

/** Unique workers of a flow phase, in stage order: [{ role, stageModel }]. */
function flowWorkers(flow, phase) {
  const seen = new Map();
  for (const s of flow.stages ?? []) {
    if (!s.worker) continue;
    if (phase && s.phase && s.phase !== phase) continue;
    if (!seen.has(s.worker)) seen.set(s.worker, { role: s.worker, stageModel: s.model ?? null });
  }
  return [...seen.values()];
}

/** Build worker file refs + model-routing rows for a flow phase. */
function buildWorkerContext(ws, kit, flow, phase) {
  const refs = [];
  const modelRows = [];
  for (const w of flowWorkers(flow, phase)) {
    const r = resolveRole(ws, kit, w.role);
    const logical = w.stageModel ?? r?.meta?.model ?? null;
    refs.push(
      r
        ? `- ${w.role}：派发前用 read 工具读 \`${r.file}\`（${r.origin === 'workspace' ? '工作区覆写' : '内容包默认'}）全文，内嵌进 Worker prompt；模型：${describeWorkerModel(kit, w.role, logical)}`
        : `- ⚠️ ${w.role}：角色定义缺失，按通用职责派发；模型：${describeWorkerModel(kit, w.role, logical)}`,
    );
    modelRows.push({ role: w.role, logical });
  }
  return { refs: refs.join('\n'), modelRows };
}

/**
 * 看板行健壮解析（与 panel.js parseBoard、update_board.py parse_row 三方同源）：
 * 超列时溢出并入「续接提示」（管道符只可能从自由文本混入），不足 7 格补 —。
 */
function parseBoardRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (cells.length > 7) return [...cells.slice(0, 6), cells.slice(6).join(' / ')];
  while (cells.length < 7) cells.push('—');
  return cells;
}

/**
 * Append/update one board row for the task（7 列契约）。
 * 内核只机械更新 [1]状态 与 [5]上次活动；Profile/Apply进度/分支/续接提示由 PM/Worker 按剧本维护，
 * 更新既有行时保留其余列。
 */
export function updateBoard(ws, task, status, opts = {}) {
  const boardDir = path.join(harnessDir(ws), 'tasks');
  fs.mkdirSync(boardDir, { recursive: true });
  const board = path.join(boardDir, 'board.md');
  if (!fs.existsSync(board)) {
    fs.writeFileSync(board, boardTemplate(), 'utf8');
  }
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const text = fs.readFileSync(board, 'utf8');
  const rowRe = new RegExp(`^\\| ${task} \\|.*$`, 'm');
  if (rowRe.test(text)) {
    const updated = text.replace(rowRe, (line) => {
      const cells = parseBoardRow(line);
      cells[1] = status;
      cells[5] = date;
      return `| ${cells.join(' | ')} |`;
    });
    fs.writeFileSync(board, updated, 'utf8');
  } else {
    // 新行：fix 直通三态可直接定档并写初始链（全 … 待做），其余 profile — 待 propose 定档。
    // 必须插到表格末尾（最后一个表格行之后）而非盲 appendFileSync——文件尾部有
    // 「续接提示编写规范」引用块，盲追加会把行落到表格外（2026-11-13 cluster-monitor 踩中）。
    const newRow = `| ${task} | ${status} | ${opts.profile ?? '—'} | ${opts.apply ?? '—'} | — | ${date} | — |`;
    const lines = text.split('\n');
    let lastRow = -1;
    for (let i = 0; i < lines.length; i++) if (/^\s*\|/.test(lines[i])) lastRow = i;
    if (lastRow >= 0) {
      lines.splice(lastRow + 1, 0, newRow);
      fs.writeFileSync(board, lines.join('\n'), 'utf8');
    } else {
      fs.appendFileSync(board, `${newRow}\n`, 'utf8');
    }
  }
}

/** Infer the task name when omitted: exactly one active task wins. */
function inferTask(ws, positional, usage) {
  if (positional[0]) return { task: positional[0] };
  const act = activeTasks(ws);
  if (act.length === 1) return { task: act[0] };
  return { error: `${usage}${act.length ? `（当前活跃任务：${act.join('、')}）` : ''}` };
}

// ---------------------------------------------------------------- /hk-setup
async function hkSetup({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const { flags, positional } = parseArgs(rawInput);
  let kit = readKit(ws) ?? defaultKit();

  if (!flags.add) {
    const lines = ['## Harness Kit 工作区仓库清单', ''];
    if (kit.sources.length === 0) lines.push('（空）使用 `/hk-setup --add <git-url> [--name n] [--path p] [--branch b]` 登记或克隆代码仓库。');
    for (const s of kit.sources) {
      const exists = fs.existsSync(path.join(ws, s.path));
      lines.push(`- **${s.name}** (${s.role ?? 'backend'}) → \`${s.path}\` ${exists ? '✅ 已存在' : '❌ 缺失'}${s.url ? ` — ${s.url}` : ''}${s.branch ? ` [${s.branch}]` : ''}`);
    }
    lines.push('', '路径已存在的仓库直接登记；不存在时会先 `git clone`（普通 clone）。之后运行 `/hk-init`。');
    return ok(lines.join('\n'));
  }

  const r = await addSource(ws, { url: flags.add, name: flags.name, path: flags.path, role: flags.role, branch: flags.branch });
  if (!r.ok) return err(r.error);
  return ok(r.lines.join('\n'));
}

// ----------------------------------------------------------------- /hk-init
async function hkInit({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const { flags } = parseArgs(rawInput);
  const r = await runInit(ws, { assets: flags.assets, branch: flags.branch });
  if (!r.ok) return err(r.error);
  const { kit } = r;

  // 5. steer the init orchestration prompt (original /harness-init Steps 1-7b)
  let steered = false;
  if (kit.sources.length > 0) {
    const loaded = loadFlow(ws, kit, 'init');
    if (loaded) {
      const pm = resolveRole(ws, kit, 'project-manager');
      const prompt = compileFlowPrompt(loaded.flow, {
        task: '工程初始化',
        desc: '探测 services/ 下子工程的技术栈与结构，按模板生成子工程文档（CLAUDE.md / build.json / CODE_STANDARDS.md / 模块级 CLAUDE.md）；再与人协作补齐各端 build.json 的编译/启动命令并实跑一次编译+启动验证（成功后停掉服务）；最后建 CodeGraph 代码索引 —— 原 /harness-init 流程',
        flowFile: loaded.file,
        artifacts: '各子工程（生成清单见 .harness/.logs/workflow/harness-init-plan.json）',
        roleSections: pm ? `### PM 角色（你立即切换到此身份）\n\n${pm.body}` : undefined,
        rules: readCoreRules(kit),
      });
      steer(agent, prompt);
      steered = true;
    }
  }

  return ok(formatInitReport(r, { steered }));
}

// ------------------------------------------------------------------ /hk-fix
async function hkFix({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  await reconcileArchivedQuiet(ws, kit);
  const { flags, positional } = parseArgs(rawInput);
  // parseArgs 会把 --auto 后首个词吞为旗标值；先还原完整词序再解构
  const words = typeof flags.auto === 'string' ? [flags.auto, ...positional] : positional;
  let [task, ...descParts] = words;
  if (flags.auto) task = null;
  const desc = (flags.auto ? words : descParts).join(' ') || '（未提供描述，PM 须先向人反问澄清）';
  const autoNamed = !!flags.auto;
  if (autoNamed) task = autoTaskName(ws, desc);
  if (!task || !TASK_NAME_RE.test(task)) return err('用法：/hk-fix [任务名] <一句话描述> [--full|--light] [--auto]（任务名限英文/数字/-_；留空或 --auto 按描述自动生成）');

  const taskDir = path.join(harnessDir(ws), 'deliverables', task);
  if (fs.existsSync(taskDir)) {
    // 空目录（上次执行中断/手动清理后的残留）直接复用；有内容才判撞名
    if (fs.readdirSync(taskDir).length > 0) return err(`任务 ${task} 的活目录已存在：换任务名，或先归档/清理。`);
  } else {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  // scaffold bugfix.md from the pack template
  const tplPath = path.join(packDir(kit), 'templates', 'bugfix.md');
  const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf8') : '# Bugfix：{{task}}\n\n## 问题描述\n{{desc}}\n\n## 质量门\n\n## R0\n- 质量门裁决：\n';
  const date = new Date().toISOString().slice(0, 10);
  let doc = tpl.replaceAll('{{task}}', task).replaceAll('{{desc}}', desc).replaceAll('{{date}}', date);
  const preVerdict = flags.full ? '--full' : flags.light ? '轻量' : null;
  if (preVerdict) doc = doc.replace(/质量门裁决：[^\n]*/, `质量门裁决：${preVerdict}（调用时预声明）`);
  fs.writeFileSync(path.join(taskDir, 'bugfix.md'), doc, 'utf8');

  // resolve roles: PM embedded; workers referenced by file for just-in-time read
  const pm = resolveRole(ws, kit, 'project-manager');
  const loaded = loadFlow(ws, kit, 'fix');
  if (!loaded) return err('找不到 fix 流程定义（packs/ai-coding/flows/fix.yml 或 .harness/flows/fix.yml）。');
  const wctx = buildWorkerContext(ws, kit, loaded.flow, null);
  const workerRefs = wctx.refs || '- （Worker 角色定义缺失）';

  // 并行开发：fix 也会改源码——清同名残留 + 分配工作区（fix/harness-<task>）
  clearDecision(ws, task);
  await clearTaskWorkspaces(ws, kit, task);
  await removeTaskAnalysisWorktrees(ws, kit, task);
  const wt = await ensureTaskWorkspaces(ws, kit, task, { branchPrefix: 'fix', forceSlot: flags.slot === true });
  if (wt.refused.length > 0) {
    const details = [];
    for (const f of wt.refused) {
      const source = (kit.sources ?? []).find((s) => s.name === f.source);
      if (source) details.push(await describeMainWorktree(ws, source));
    }
    const text = `工作区分配需要人工裁决（不开发工）：\n${wt.refused.map((f) => `- ${f.source}：${f.reason}`).join('\n')}` +
      (details.length > 0 ? `\n\n主工作树现场：\n${details.join('\n\n')}` : '');
    const options = [
      { label: '在隔离 slot 开发', line: `/hk-fix ${task} --slot`, primary: true },
      { label: '已处理主树，按原样重跑', line: `/hk-fix ${task}` },
    ];
    recordDecision(ws, task, { code: 'workspace-foreign', text, options });
    return decision(text, 'workspace-foreign', options);
  }
  clearDecision(ws, task);
  const wtNotice = renderWorkspaceNotice(wt, task);
  // 质量门评估可能读源码：同样给只读基线镜像 + --base 任务专属分析区
  const mirrors = await ensureBaselineMirrors(ws, kit);
  const taskAnalysis = await ensureTaskAnalysisWorktrees(ws, kit, task, parseBaseSpec(flags.base));
  const mirrorNotice = renderAnalysisNotice(mirrors, taskAnalysis);

  const prompt = compileFlowPrompt(loaded.flow, {
    task,
    desc,
    flowFile: loaded.file,
    artifacts: `.harness/deliverables/${task}/`,
    roleSections: [
      pm ? `### PM 角色（你立即切换到此身份）\n\n${pm.body}` : '（缺 project-manager 角色定义，按通用 PM 职责执行）',
      '',
      '### Worker 角色（派发时逐个读取并内嵌）',
      workerRefs,
    ].join('\n'),
    rules: [readCoreRules(kit), wtNotice, mirrorNotice, TE_NOTICE].filter(Boolean).join('\n\n'),
    dispatchSection: dispatchSection(kit, wctx.modelRows),
  });

  steer(agent, prompt);
  // fix 直通三态定档：--full → fix-full；--light → fix-light（CR/TE 直接标 —）；未声明 → fix（直通·裁决未定，质量门裁决后 PM 改写）
  const fixProfile = flags.full ? 'fix-full' : flags.light ? 'fix-light' : 'fix';
  const initChain = flags.light ? 'R1：质量门▶ Dev… CR— TE— 验证…' : 'R1：质量门▶ Dev… CR… TE… 验证…';
  updateBoard(ws, task, 'PENDING', { profile: fixProfile, apply: initChain });
  clearAdvanceMarks(ws, task);
  bindCurrentSession(ws, task, agent);
  const wtSummary = wt.assigned.length > 0 ? `\n- 工作区分配：${wt.assigned.map((w) => `${w.source} → ${w.placement === 'main' ? '主工作树' : w.placement}${w.branch ? `（\`${w.branch}\` ← \`${w.base}\`）` : ''}`).join('；')}` : '';
  return ok(`fix 任务 **${task}** 已启动：\n- 活目录 \`.harness/deliverables/${task}/bugfix.md\` 已生成${autoNamed ? '\n- 任务名由描述自动生成；如需更名请现在告诉我' : ''}\n- 看板已登记（PENDING，profile=${fixProfile}）\n- 执行剧本已提交给 PM（本会话），从「分支准备」阶段开始${wtSummary}${preVerdict ? `\n- 质量门已预声明：${preVerdict}` : '\n- 质量门将由 PM 评估后交你裁决（裁决后 PM 须把看板 profile 改写为 fix-full / fix-light）'}`);
}

// ------------------------------------------------------------------ /hk-new
// Bootstrap: scaffold proposal.md + register board + steer clarification flow.
async function hkNew({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  await reconcileArchivedQuiet(ws, kit);
  const { flags, positional } = parseArgs(rawInput);
  // parseArgs 会把 --auto 后首个词吞为旗标值；先还原完整词序再解构
  const words = typeof flags.auto === 'string' ? [flags.auto, ...positional] : positional;
  let [task, ...descParts] = words;
  if (flags.auto) task = null;
  const desc = (flags.auto ? words : descParts).join(' ') || '（未提供描述，PM 须先向人反问澄清）';
  const autoNamed = !!flags.auto;
  if (autoNamed) task = autoTaskName(ws, desc);
  if (!task || !TASK_NAME_RE.test(task)) {
    return err('用法：/hk-new [任务名] <需求描述> [--file <需求文件>] [--auto]（任务名限英文/数字/-_；留空或 --auto 按描述自动生成）');
  }

  const taskDir = path.join(harnessDir(ws), 'deliverables', task);
  if (fs.existsSync(taskDir)) {
    // 空目录（上次执行中断/手动清理后的残留）直接复用；有内容才判撞名
    if (fs.readdirSync(taskDir).length > 0) return err(`任务 ${task} 的活目录已存在：换任务名，或先归档/清理。`);
  } else {
    fs.mkdirSync(taskDir, { recursive: true });
  }
  // 任务重建：先清上一化身的自动续接标记与同名工作区/分析区残留（须在 --base 建分析区之前，否则刚建的会被当残留回收）
  clearAdvanceMarks(ws, task);
  clearDecision(ws, task);
  await clearTaskWorkspaces(ws, kit, task);
  await removeTaskAnalysisWorktrees(ws, kit, task);

  // optional requirement file: copy into the task dir for the bootstrap to read
  let reqFile = '（无）';
  if (typeof flags.file === 'string') {
    const src = path.resolve(ws, flags.file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      fs.rmSync(taskDir, { recursive: true, force: true });
      return err(`需求文件不存在：${flags.file}`);
    }
    reqFile = path.basename(src);
    fs.copyFileSync(src, path.join(taskDir, reqFile));
  }

  const tplPath = path.join(packDir(kit), 'templates', 'proposal.md');
  const tpl = fs.existsSync(tplPath)
    ? fs.readFileSync(tplPath, 'utf8')
    : '# 提案：{{task}}\n\n> **状态**：draft\n\n## 输入\n\n- **来源**：{{source}}\n- **文件**：{{file}}\n- **描述**：{{desc}}\n';
  const doc = tpl
    .replaceAll('{{task}}', task)
    .replaceAll('{{desc}}', desc)
    .replaceAll('{{source}}', reqFile === '（无）' ? '描述' : '描述+文件')
    .replaceAll('{{file}}', reqFile);
  fs.writeFileSync(path.join(taskDir, 'proposal.md'), doc, 'utf8');
  // 交接摘要模板：PM 在每次派发前更新，Worker 只读 handoff + 指定章节，不整份重读上游文档。
  const handoffTplPath = path.join(packDir(kit), 'assets', 'templates', 'handoff.md');
  if (fs.existsSync(handoffTplPath)) {
    const handoff = fs.readFileSync(handoffTplPath, 'utf8')
      .replaceAll('{{task}}', task)
      .replaceAll('{{desc}}', desc)
      .replaceAll('{{profile}}', '待判定')
      .replaceAll('{{round}}', '1');
    fs.writeFileSync(path.join(taskDir, 'handoff.md'), handoff, 'utf8');
  }
  // --base 开发基线（同时是分析基点与归档合入目标）：落盘 spec + 立即建任务专属分析工作区（propose 时幂等复用）
  let baseNote = '';
  if (typeof flags.base === 'string') {
    const spec = parseBaseSpec(flags.base);
    if (Object.keys(spec).length > 0) {
      const ta = await ensureTaskAnalysisWorktrees(ws, kit, task, spec);
      const parts = [];
      if (ta.created.length > 0) parts.push(`新建专属分析区：${ta.created.map((w) => `${w.source}@${w.branch}`).join('、')}`);
      if (ta.reused.length + ta.switched.length > 0) parts.push(`复用/切换专属分析区：${[...ta.reused, ...ta.switched].map((w) => w.source).join('、')}`);
      if (ta.worktrees.length > 0) parts.push(`开发基线（分析基点）：${ta.worktrees.map((w) => `${w.source}→${w.branch}(${w.sha})`).join('；')}`);
      parts.push(...ta.notes);
      baseNote = `\n- ${parts.join('\n- ')}`;
    }
  }
  updateBoard(ws, task, 'PENDING');
  bindCurrentSession(ws, task, agent);

  const pm = resolveRole(ws, kit, 'project-manager');
  const loaded = loadFlow(ws, kit, 'new');
  if (!loaded) return err('找不到 bootstrap 流程定义（packs/ai-coding/flows/new.yml）。');
  const router = loadFlow(ws, kit, '_router');
  const prompt = compileFlowPrompt(loaded.flow, {
    task,
    desc,
    flowFile: loaded.file,
    artifacts: `.harness/deliverables/${task}/`,
    roleSections: [
      pm ? `### PM 角色（你立即切换到此身份）\n\n${pm.body}` : '（缺 project-manager 角色定义，按通用 PM 职责执行）',
      '',
      '### Profile 路由表（逐条对照 when 条件判定）',
      router ? `\`\`\`yaml\n${fs.readFileSync(router.file, 'utf8').trim()}\n\`\`\`` : '（缺 flows/_router.yml：按默认 standard 处理，并在汇报中注明）',
    ].join('\n'),
    rules: readCoreRules(kit),
    dispatchSection: dispatchSection(kit, []),
  });

  steer(agent, prompt);
  return ok(
    `新任务 **${task}** 已创建：\n- 提案草稿 \`.harness/deliverables/${task}/proposal.md\` 已生成（状态 draft）${autoNamed ? '\n- 任务名由描述自动生成；如需更名请现在告诉我' : ''}${reqFile === '（无）' ? '' : `\n- 需求文件已拷入：\`${reqFile}\``}\n- 看板已登记（PENDING）${baseNote}\n- Bootstrap 剧本已提交 PM：解读输入 → 起草 → Profile 判定 → ⛔模糊点反问 → ⛔定稿（approved）→ 交接\n\n红线生效：定稿+审批 1 前，源码区（${protectedSourcePaths(kit).join('、')}）禁写。`,
  );
}

// -------------------------------------------------------------- /hk-propose
async function hkPropose({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  const { flags, positional } = parseArgs(rawInput);
  const inferred = inferTask(ws, positional, '用法：/hk-propose [任务名] [--base <仓:分支,…>]（省略任务名时要求唯一活跃任务；--base=按仓指定开发基线，同时作为分析基点与归档合入目标，如 backend:release/1.2）');
  if (inferred.error) return err(inferred.error);
  const task = inferred.task;
  const taskDir = path.join(harnessDir(ws), 'deliverables', task);
  const proposalPath = path.join(taskDir, 'proposal.md');
  if (!fs.existsSync(proposalPath)) {
    return err(`任务 ${task} 缺少 proposal.md：全流程任务由 /hk-new 创建；简单 bug 修复请用 /hk-fix。`);
  }
  const proposal = fs.readFileSync(proposalPath, 'utf8');
  if (!STATUS_APPROVED.test(proposal)) {
    return err(`proposal.md 未定稿（状态行需为「> **状态**：approved」）：先完成 Bootstrap 消歧义与人工定稿，再运行 /hk-propose。`);
  }

  const profile = readProfile(proposal);
  const loaded = loadFlow(ws, kit, profile);
  if (!loaded) return err(`找不到 ${profile} 流程定义（packs/ai-coding/flows/${profile}.yml）。`);
  const pm = resolveRole(ws, kit, 'project-manager');
  const wctx = buildWorkerContext(ws, kit, loaded.flow, 'propose');
  // 设计期源码分析：常驻只读基线镜像（主树被在途任务占用时 BA/SA/RR 仍有确定的分析基点）
  const mirrors = await ensureBaselineMirrors(ws, kit);
  // --base 按任务指定分析基点 → 任务专属分析工作区（不切换共享镜像，无需锁定）
  const taskAnalysis = await ensureTaskAnalysisWorktrees(ws, kit, task, parseBaseSpec(flags.base));
  const mirrorNotice = renderAnalysisNotice(mirrors, taskAnalysis);
  const prompt = compileFlowPrompt(loaded.flow, {
    task,
    desc: `按已定稿的 proposal.md 执行 **propose 阶段**（profile=${profile}）。先通读 proposal.md 全文，交叉验证 profile 与任务规模是否匹配，不匹配则停下交人裁决`,
    flowFile: loaded.file,
    artifacts: `.harness/deliverables/${task}/`,
    phase: 'propose',
    roleSections: [
      pm ? `### PM 角色（你立即切换到此身份）\n\n${pm.body}` : '（缺 project-manager 角色定义，按通用 PM 职责执行）',
      '',
      '### Worker 角色（派发时逐个读取并内嵌）',
      wctx.refs,
    ].join('\n'),
    rules: [readCoreRules(kit), mirrorNotice].filter(Boolean).join('\n\n'),
    dispatchSection: dispatchSection(kit, wctx.modelRows),
  });

  updateBoard(ws, task, 'IN_PROGRESS');
  bindCurrentSession(ws, task, agent);
  // M4b 自动认领：追加式 claims.json（sync 白名单，随 /hk-sync 全队可见）
  let claimHint = '';
  try {
    const who = (await runGit(['config', 'user.name'], { cwd: harnessDir(ws) })).stdout.trim()
      || os.userInfo()?.username || 'unknown';
    claimTask(ws, task, who);
    claimHint = `\n- 已自动认领给 **${who}**（claims.json，随 /hk-sync 共享）`;
  } catch { /* 认领失败不阻塞流程 */ }
  steer(agent, prompt);
  return ok(`propose 阶段已启动（任务 **${task}**，profile=${profile}）：\n- 执行剧本已提交 PM：${flowWorkers(loaded.flow, 'propose').map((w) => w.role).join(' → ') || 'PM 自行执行'} → ⛔审批 1\n- 审批 1 通过后 PM 会把「审批 1：通过」写入 proposal.md（红线解锁），随后自动续接引擎会接力执行 \`/hk-apply ${task}\`（无需人再手动运行）${claimHint}`);
}

// ---------------------------------------------------------------- /hk-apply
async function hkApply({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  await reconcileArchivedQuiet(ws, kit);
  const { flags, positional } = parseArgs(rawInput);
  const inferred = inferTask(ws, positional, '用法：/hk-apply [任务名] [反馈] [--slot]（省略任务名时要求唯一活跃任务；--slot=主树有未处理改动时强制隔离到 slot 开发）');
  if (inferred.error) return err(inferred.error);
  const task = inferred.task;
  const feedback = positional.slice(1).join(' ');

  const taskDir = path.join(harnessDir(ws), 'deliverables', task);
  const proposalPath = path.join(taskDir, 'proposal.md');
  if (!fs.existsSync(proposalPath)) {
    return err(`任务 ${task} 缺少 proposal.md：/hk-apply 只服务全流程任务；fix 直通的质量门后直接继续，无需本命令。`);
  }
  const proposal = fs.readFileSync(proposalPath, 'utf8');
  if (!APPROVAL1.test(proposal)) {
    return err(`审批 1 未记录：propose 阶段的人审批通过后，PM 须把「审批 1：通过（日期）」写入 proposal.md 末尾。`);
  }

  const profile = readProfile(proposal);
  // readiness preflight per profile (原 harness-apply 3a+ 规则)
  const readyDoc = { standard: 'readiness-report.md', refactor: 'readiness-report.md', quick: 'design.md', bugfix: 'bugfix.md' }[profile];
  const readyPath = path.join(taskDir, readyDoc);
  if (!fs.existsSync(readyPath)) {
    return err(`就绪预检 FAIL：缺 ${readyDoc}（propose 阶段未产出）。先运行 /hk-propose ${task} 完成方案阶段。`);
  }
  const verdict = lastConclusion(fs.readFileSync(readyPath, 'utf8'));
  if (verdict !== 'PASS') {
    return err(`就绪预检 FAIL：${readyDoc} 最后结论为 ${verdict ?? '缺失'}，需 PASS 才能开工（propose 被打回时先回炉重做）。`);
  }

  const loaded = loadFlow(ws, kit, profile);
  if (!loaded) return err(`找不到 ${profile} 流程定义（packs/ai-coding/flows/${profile}.yml）。`);
  const pm = resolveRole(ws, kit, 'project-manager');
  const wctx = buildWorkerContext(ws, kit, loaded.flow, 'apply');

  // 并行开发：预检全过后分配工作区（主工作树 or 池化 slot）；外来占用 → 结构化决策点（面板渲染可点选项）
  const wt = await ensureTaskWorkspaces(ws, kit, task, { forceSlot: flags.slot === true });
  if (wt.refused.length > 0) {
    const details = [];
    for (const f of wt.refused) {
      const source = (kit.sources ?? []).find((s) => s.name === f.source);
      if (source) details.push(await describeMainWorktree(ws, source));
    }
    const text = `工作区分配需要人工裁决（不开发工）：\n${wt.refused.map((f) => `- ${f.source}：${f.reason}`).join('\n')}` +
      (details.length > 0 ? `\n\n主工作树现场：\n${details.join('\n\n')}` : '');
    const options = [
      { label: '在隔离 slot 开发', line: `/hk-apply ${task}${feedback ? ` ${feedback}` : ''} --slot`, primary: true },
      { label: '已处理主树，按原样重跑', line: `/hk-apply ${task}${feedback ? ` ${feedback}` : ''}` },
    ];
    recordDecision(ws, task, { code: 'workspace-foreign', text, options });
    return decision(text, 'workspace-foreign', options);
  }
  clearDecision(ws, task);
  const wtNotice = renderWorkspaceNotice(wt, task);

  const prompt = compileFlowPrompt(loaded.flow, {
    task,
    desc: `按 proposal.md + 方案文档执行 **apply 阶段**（profile=${profile}）。先通读 proposal/design 等既有产物；若 Dev/CR 产物已存在（续接场景），跳过已完成阶段从断点继续${feedback ? `\n\n续接反馈（人）：${feedback}` : ''}`,
    flowFile: loaded.file,
    artifacts: `.harness/deliverables/${task}/`,
    phase: 'apply',
    roleSections: [
      pm ? `### PM 角色（你立即切换到此身份）\n\n${pm.body}` : '（缺 project-manager 角色定义，按通用 PM 职责执行）',
      '',
      '### Worker 角色（派发时逐个读取并内嵌）',
      wctx.refs,
    ].join('\n'),
    rules: [readCoreRules(kit), wtNotice, TE_NOTICE].filter(Boolean).join('\n\n'),
    dispatchSection: dispatchSection(kit, wctx.modelRows),
  });

  steer(agent, prompt);
  bindCurrentSession(ws, task, agent);
  const wtSummary = wt.assigned.length > 0
    ? `\n- 工作区分配：${wt.assigned.map((w) => `${w.source} → ${w.placement === 'main' ? '主工作树' : w.placement}${w.branch ? `（\`${w.branch}\` ← \`${w.base}\`）` : ''}`).join('；')}`
    : '';
  const wtOverlap = wt.overlaps.length > 0
    ? `\n- ⚠️ 与在途任务文件重叠：${wt.overlaps.map((o) => `${o.task}（${o.source}：${o.files.slice(0, 3).join('、')}${o.files.length > 3 ? ' 等' : ''}）`).join('；')}——同文件并发修改必冲突，已写入剧本提示 PM 先向你确认`
    : '';
  return ok(`apply 阶段已启动（任务 **${task}**，profile=${profile}）：\n- 就绪预检 PASS（${readyDoc}）\n- 执行剧本已提交 PM：${flowWorkers(loaded.flow, 'apply').map((w) => w.role).join(' → ')} → ⛔审批 2${feedback ? `\n- 已携带续接反馈` : ''}${wtSummary}${wtOverlap}\n- 审批 2 通过后，PM 把看板置 AWAITING_ARCHIVE 并记录审批 2 ✅，自动续接引擎会接力 \`/hk-archive ${task}\`（无需手动敲；关闭自动续接时由人运行）`);
}

// --------------------------------------------------------------- /hk-archive
async function hkArchive({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  const { flags, positional } = parseArgs(rawInput);
  const task = positional[0];
  if (!task) return err('用法：/hk-archive <任务名> [--merge [仓:分支,…]]');
  // 合入确认（B 方案，2026-11-17）：--merge = 人显式确认要把任务分支本地合入目标基线；
  // 可带 repo:branch 覆盖目标（不带则用任务创建时指定的基线）。合并只做本地提交，不推送。
  const mergeAsked = flags.merge !== undefined;
  const mergeOverrides = mergeAsked && typeof flags.merge === 'string' ? parseBaseSpec(flags.merge) : {};

  const taskDir = path.join(harnessDir(ws), 'deliverables', task);
  // 活跃任务归档前先清理其他已归档残留；残留收尾（taskDir 不存在）不能先清理，
  // 否则 releaseTaskWorkspaces 的 ledger 入口会被提前删掉。
  if (fs.existsSync(taskDir)) await reconcileArchivedQuiet(ws, kit);
  if (!fs.existsSync(taskDir)) {
    // 已归档任务的残留收尾（2026-11-17 新增）：文档已归档但工作区 slot 因分支未合入而保留
    // （stale-unmerged），注意力条提示「远端 MR 合入后重跑 /hk-archive 释放槽位」——
    // 此时活目录已清，正常预检必然失败；这里识别为「只做工作区释放」的收尾模式。
    const wl = readWorkspaces(ws);
    if (wl.tasks?.[task]) {
      const mg = mergeAsked ? await mergeTaskBranches(ws, kit, task, mergeOverrides) : null;
      const rel = await releaseTaskWorkspaces(ws, kit, task);
      const ta = await removeTaskAnalysisWorktrees(ws, kit, task);
      clearDecision(ws, task);
      const lines = [
        ...(mg ? mergeLines(mg) : []),
        ...rel.released.map((r) => `${r.placement === 'main' ? '主工作树' : `slot ${r.placement}`} 已释放（${r.source}）`),
        ...rel.stale.map((s) => `⚠️ ${s.source}：${s.reason}`),
        ...(ta.removed > 0 ? [`任务分析工作区已回收 ×${ta.removed}`] : []),
        ...ta.notes,
      ];
      if (rel.stale.length > 0) {
        const targets = [...new Set([...rel.stale.map((x) => x.source)])]
          .map((src) => `${src}→${(wl.tasks?.[task]?.repos?.[src]?.base) ?? '?'}`).join('、');
        return err(`任务 **${task}** 已归档，但工作区仍未释放：\n${lines.join('\n')}\n\n确认要本地合入目标基线（${targets}）后运行：\n\`/hk-archive ${task} --merge\`（可用 \`--merge 仓:分支\` 覆盖目标；只做本地合并，推送仍由人执行）`);
      }
      return ok(`任务 **${task}** 已归档，残留工作区已收尾：\n${lines.join('\n') || '（无残留）'}`);
    }
    return err(`活目录 .harness/deliverables/${task}/ 不存在。`);
  }

  const isFullFlow = fs.existsSync(path.join(taskDir, 'proposal.md'));

  // preflight 1: planning gate must be recorded
  if (taskIsPlanning(ws, task)) {
    return err(
      isFullFlow
        ? `归档预检 FAIL：${task} 的 proposal.md 缺少「审批 1：通过」记录（审批 1 通过后由 PM 写入）。`
        : `归档预检 FAIL：${task} 的 bugfix.md 缺少质量门人裁决记录（需含「裁决：轻量」或「裁决：--full」）。`,
    );
  }

  if (isFullFlow) {
    // preflight 2 (full flow): test report must conclude PASS
    const trPath = path.join(taskDir, 'test-report.md');
    if (!fs.existsSync(trPath)) return err(`归档预检 FAIL：缺 test-report.md（apply 阶段未产出测试报告）。`);
    const verdict = lastConclusion(fs.readFileSync(trPath, 'utf8'));
    if (verdict !== 'PASS') {
      return err(`归档预检 FAIL：test-report.md 最后结论为 ${verdict ?? '缺失'}，需 PASS 才能归档（BUG→回开发，需求级→回 propose，环境阻塞→升级给人）。`);
    }
  } else {
    // preflight 2 (fix flow): --full verdict requires real CR/TE docs
    const fixText = fs.readFileSync(path.join(taskDir, 'bugfix.md'), 'utf8');
    const m = fixText.match(/裁决[*＊]*[:：][ \t]*`?(--full|full)(?![\w-])/i);
    if (m) {
      const missing = ['code-review.md', 'test-report.md'].filter((f) => !fs.existsSync(path.join(taskDir, f)));
      if (missing.length > 0) {
        return err(`归档预检 FAIL：质量门裁决为 --full，但缺 ${missing.join('、')}（--full 必须真实走 CR → TE）。`);
      }
    }
  }

  // preflight 3 (full flow): spec 编号门禁内核化——合并前的 specs 必须已 PASS（原仅 steer 提示，PM 可能漏跑）。
  // 仅当 specs 已有实质 spec 文件时启用（首个任务尚无 spec 可合，lint 的「无 spec 文件」退出码不视为 FAIL）。
  if (isFullFlow) {
    const specsDir = path.join(harnessDir(ws), 'specs');
    const hasSpecs = fs.existsSync(specsDir) && fs.readdirSync(specsDir).some((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'spec-template.md');
    const lint = path.join(harnessDir(ws), 'scripts', 'spec_lint.py');
    if (hasSpecs && fs.existsSync(lint)) {
      const r = await run('python3', [lint], { cwd: ws, timeoutMs: 60_000 });
      if (r.code !== 0) {
        return err(`归档预检 FAIL：spec 编号门禁未通过——\n${(r.stdout || r.stderr).trim()}\n修复后重试（门禁：.harness/scripts/spec_lint.py）。`);
      }
    }
  }

  const archiveDir = path.join(harnessDir(ws), 'deliverables', '_archive', task);
  fs.mkdirSync(archiveDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  // round number: existing rounds in archive + 1... count previous archive files' R markers
  let round = 0;
  const marker = path.join(archiveDir, 'rounds.md');
  if (fs.existsSync(marker)) {
    const text = fs.readFileSync(marker, 'utf8');
    const rounds = [...text.matchAll(/^\| R(\d+) /gm)];
    round = rounds.length;
  }
  const tag = `R${round}`;

  // append each active doc to its archive counterpart under an R<N> section
  const appended = [];
  for (const name of fs.readdirSync(taskDir)) {
    if (!name.endsWith('.md')) continue;
    const body = fs.readFileSync(path.join(taskDir, name), 'utf8');
    const target = path.join(archiveDir, name);
    const section = `\n\n---\n\n## ${tag}（${date} 归档）\n\n${body.trim()}\n`;
    fs.appendFileSync(target, section, 'utf8');
    appended.push(name);
  }

  // rounds.md summary line (append-only)
  const summaryLine = `| ${tag} | ${date} | ${appended.join(', ') || '（无文档）'} |\n`;
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, `# ${task} 归档轮次\n\n| 轮次 | 日期 | 文档 |\n|---|---|---|\n`, 'utf8');
  fs.appendFileSync(marker, summaryLine, 'utf8');

  // clear the active dir
  fs.rmSync(taskDir, { recursive: true, force: true });
  updateBoard(ws, task, 'DONE');
  clearAdvanceMarks(ws, task);
  bindCurrentSession(ws, task, agent);

  // worktree 收尾：slot 已合入基线的 → 切回基线释放（目录保留）；未合入 → stale 保留提示
  // 合入确认（B 方案）：--merge 时先本地合入目标基线，再释放槽位
  const mgNormal = mergeAsked ? await mergeTaskBranches(ws, kit, task, mergeOverrides) : null;
  const wtResult = await releaseTaskWorkspaces(ws, kit, task);
  clearDecision(ws, task);
  const taCleanup = await removeTaskAnalysisWorktrees(ws, kit, task);
  const staleLines = wtResult.stale.map((s) => `⚠️ ${s.source}：${s.reason}`);
  const confirmHint = wtResult.stale.length > 0 && !mergeAsked
    ? [`确认要本地合入目标基线后运行：\`/hk-archive ${task} --merge\`（可用 \`--merge 仓:分支\` 覆盖目标；只本地合并，推送由人执行）`]
    : [];
  const wtNote = wtResult.missing && taCleanup.removed === 0 && taCleanup.notes.length === 0 && !mgNormal
    ? ''
    : [
        ...(mgNormal ? mergeLines(mgNormal) : []),
        ...wtResult.released.map((r) => `${r.placement === 'main' ? '主工作树无需处理' : `slot ${r.placement} 已释放（切回基线，目录保留）`}（${r.source}）`),
        ...staleLines,
        ...confirmHint,
        ...(taCleanup.removed > 0 ? [`任务分析工作区已回收 ×${taCleanup.removed}`] : []),
        ...taCleanup.notes,
      ].join('\n');

  // full flow: steer PM to do Spec Merge + Memory Merge from the archived R<N> docs
  let mergeNote = '提示：Memory/Spec Merge 由 PM 在归档前完成；';
  if (isFullFlow) {
    const pm = resolveRole(ws, kit, 'project-manager');
    const mergePrompt = [
      `# Harness Kit 归档收尾（${task} ${tag}）`,
      '',
      `${pm ? `你继续以 PM 身份执行收尾（角色定义见 ${pm.file}，先读全文）。` : '你以 PM 身份执行收尾。'}本轮产物已追加归档到 \`.harness/deliverables/_archive/${task}/\` 的 ${tag} 段。按顺序完成两个合并：`,
      '',
      '## 1. Spec Merge',
      `- 读 \`_archive/${task}/requirements.md\` ${tag} 段的「§7 Spec Delta」，把 ADDED/MODIFIED/REMOVED 条目并入 \`.harness/specs/\` 对应能力文档（id_max 编号不回收）`,
      '- 全新能力建新文档：**格式必须遵循 \`.harness/specs/spec-template.md\`**（frontmatter：domain/summary/entities/api_prefixes/prefix/id_max_r/id_max_s/retired/last_updated；Requirement/Scenario 编号 \`<PREFIX>-R-<NNN>\` / \`<PREFIX>-S-<NNN>\`），并登记 \`specs/_index.md\` 业务域表',
      '- 合并后运行 \`python3 .harness/scripts/spec_lint.py\`（存在时）做门禁校验，FAIL 必须修复',
      '',
      '## 2. Memory Merge',
      `- 从 \`_archive/${task}/\` 本轮各文档（dev-log / test-report / code-review）提取可复用踩坑与经验，并入 \`.harness/memory/\``,
      '- **每条新条目必须遵循 `.harness/memory/templates/entry.md`**：文件名 `YYYY-MM-DD_<scope>_<slug>.md`，frontmatter 含 id/date/scope/tags（建议补 areas/symptoms/pinned），正文含症状/根因/修复/防复发/复发检测；tooling/infra/shared 类必须含「流程优化排除」节',
      '- 不再手写 `memory/index.md`：新增/修改 entry 后运行 `python3 .harness/scripts/memory_index.py sync` 重建 hot/cold 索引；默认 hot 只读，cold 仅在 hot 无匹配时搜索',
      '- 归档时执行一次自动降温：`python3 .harness/scripts/memory_index.py cool --days 60 --max-hot 30 --apply`，再运行 `check`；cold 只移出默认上下文，不删除条目',
      '- 本轮实际读取并起作用的 memory，运行 `python3 .harness/scripts/memory_index.py touch <id>` 提升/保活；高风险条目在 frontmatter 标 `pinned: true`',
      '- 流程优先决策门：若经验属于 tooling/infra/shared 级，应改 harness 资产本身（模板/角色/流程定义），而不是只写记忆',
      '',
      '完成后向人汇报两个合并的结果清单（含 hot/cold 数量）。',
    ].join('\n');
    steer(agent, mergePrompt);
    mergeNote = 'Spec/Memory Merge 收尾剧本已提交 PM（基于归档段执行）；';
  }

  let syncHint;
  if (kit.assets?.autoSync === true && fs.existsSync(path.join(harnessDir(ws), '.git'))) {
    const r = await syncAssets(ws, kit);
    syncHint = r.kind === 'success' ? `资产已自动同步（assets.autoSync）：${r.text}` : `资产自动同步失败（assets.autoSync）：${r.text}`;
  } else if (kit.assets && kit.assets.mode !== 'local') {
    syncHint = `资产仓库已绑定${kit.assets.url ? `（${kit.assets.url}）` : ''}，请运行 \`/hk-sync\` 同步（或在 kit.json 设 \`assets.autoSync=true\` 让归档后自动同步）`;
  } else {
    const lay = await assetsLayout(ws);
    syncHint =
      lay.layout === 'embedded'
        ? `资产随工作区根仓库管理（\`${lay.repoRoot}\`），随根仓库 commit/push 即共享，无需 \`/hk-sync\``
        : '资产仓库为本地模式；如需团队共享，绑定远端后用 `/hk-sync` 同步';
  }
  return ok(`任务 **${task}** 已归档为 ${tag}：\n- 追加归档：${appended.map((f) => `\`_archive/${task}/${f}\``).join('、') || '（无）'}\n- 轮次摘要追加到 \`_archive/${task}/rounds.md\`\n- 活目录已清空${wtNote ? `\n- ${wtNote}` : ''}\n\n${mergeNote}${syncHint}。`);
}

// ---------------------------------------------------------------- /hk-te
// TE 环境串行租约（测试环境全局只有一个；排队细节见 kernel/te.js）。
function hkTe({ agent, rawInput }) {
  const ws = wsRoot(agent);
  if (!readKit(ws)) return err('尚未初始化：请先运行 `/hk-init`。');
  const { positional } = parseArgs(rawInput);
  const sub = positional[0] ?? 'status';
  const task = positional[1];
  if (sub === 'acquire') {
    if (!task) return err('用法：/hk-te acquire <任务名>');
    const r = acquireTestEnv(ws, task);
    return ok(r.text);
  }
  if (sub === 'release') {
    if (!task) return err('用法：/hk-te release <任务名>');
    return ok(releaseTestEnv(ws, task).text);
  }
  if (sub === 'status') return ok(describeTestEnv(ws));
  return err('用法：/hk-te [acquire|release <任务名> | status]');
}

/** 合入结果的行化输出（--merge 用）。 */
function mergeLines(mg) {
  const lines = [];
  for (const m of mg.merged) lines.push(`✅ ${m.repo} → ${m.target} 已本地合入（commit ${m.commit}，未推送）`);
  for (const c of mg.conflicts) lines.push(`⛔ ${c.repo} → ${c.target} 合并冲突（已中止回滚）：${c.files.slice(0, 8).join('、') || '见 git status'}`);
  for (const r of mg.refused) lines.push(`⚠️ ${r.repo}：${r.reason}`);
  return lines;
}

/** TE 串行纪律节（注入 apply/fix 剧本；PM 派发 TE Worker 前的门）。 */
const TE_NOTICE = [
  '### TE 环境（串行排队，必须遵守）',
  '- 测试环境（起服务/连 TDengine/jmeter）全局只有一个，TE 阶段按租约串行。',
  '- 派发 TE Worker **之前**必须先获取租约：',
  '  - 人可运行 `/hk-te acquire <任务名>`；',
  '  - PM/自动流程可直接运行 `python3 .harness/scripts/te_lease.py acquire <任务名>`（与 `/hk-te` 共用同一 `tasks/test-env.json`，不需要人代跑 slash command）。',
  '  - 已获授权 → 正常派发；排队中 → **暂停 TE 阶段**，向人汇报「TE 环境被谁占用、本任务已排队」，**不要派发 TE Worker、不要起服务/连测试库**（内核无法抢占运行中的 Worker，门必须在派发前）。',
  '- 租约只是串行锁，不是人工审批；获取后仍按 TE 门禁执行。',
  '- TE 完成（看板链 TE 标 ✅）后内核自动释放并通知下一个排队任务，无需手工 release。',
].join('\n');

// ---------------------------------------------------------------- /hk-sync
async function hkSync({ agent }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  await reconcileArchivedQuiet(ws, kit);
  return syncAssets(ws, kit);
}

// ---------------------------------------------------------------- /hk-local
// 本地配置（git-ignored）发现/确认/复制：确认一次写本机 manifest，后续 slot 自动补。
function localEntry(manifest, name) {
  const entry = manifest.sources?.[name];
  return entry && typeof entry === 'object' ? entry : {};
}
function localUpdate(ws, name, patch) {
  const manifest = readLocalFiles(ws);
  const prev = localEntry(manifest, name);
  manifest.sources[name] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeLocalFiles(ws, manifest);
  return manifest.sources[name];
}
function localSources(ws, kit, repo) {
  const sources = Array.isArray(kit?.sources) ? kit.sources : [];
  return repo ? sources.filter((s) => s.name === repo) : sources;
}
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

async function hkLocal({ agent, rawInput }) {
  const ws = wsRoot(agent);
  const kit = readKit(ws);
  if (!kit) return err('尚未初始化：请先运行 `/hk-init`。');
  const { flags, positional } = parseArgs(rawInput);
  const sub = positional[0] ?? 'scan';
  const sources = localSources(ws, kit, flags.repo);
  if (sources.length === 0) return err(`未找到仓库${flags.repo ? `：${flags.repo}` : ''}。`);

  if (sub === 'scan' || sub === 'status') {
    const lines = [`## 本地配置（${sources.map((s) => s.name).join('、')}）`, ''];
    for (const source of sources) {
      const manifest = readLocalFiles(ws);
      const entry = localEntry(manifest, source.name);
      const baseline = Array.isArray(source.localFiles) ? source.localFiles : [];
      const approved = [...new Set([...baseline, ...(Array.isArray(entry.approved) ? entry.approved : [])])];
      const skipped = new Set(Array.isArray(entry.skipped) ? entry.skipped : []);
      const candidates = await discoverSource(ws, source);
      const pending = candidates.filter((c) => !approved.includes(c.path) && !skipped.has(c.path));
      lines.push(`### ${source.name}（${source.path}）`);
      lines.push(`- 模式：${entry.mode === 'symlink' ? 'symlink' : 'copy'}；已确认 ${approved.length} 个；候选 ${pending.length} 个`);
      if (pending.length > 0) {
        lines.push('', '| 置信 | 来源 | 大小 | 路径 |', '|---|---|---:|---|');
        for (const c of pending) lines.push(`| ${c.reason === 'high' ? '高' : '配置'} | ${c.kind} | ${fmtSize(c.size)} | \`${c.path}\` |`);
        lines.push('', `确认：\`/hk-local approve all --repo ${source.name}\`，或按路径：\`/hk-local approve <path> --repo ${source.name}\``);
      } else {
        lines.push('- 没有未确认候选。');
      }
      lines.push('');
    }
    return ok(lines.join('\n'));
  }

  if (sub === 'approve' || sub === 'skip') {
    const target = positional[1];
    if (!target) return err(`用法：/hk-local ${sub} all|path... --repo <仓库>`);
    const out = [];
    for (const source of sources) {
      const candidates = await discoverSource(ws, source);
      const paths = target === 'all' ? candidates.map((c) => c.path) : positional.slice(1);
      if (paths.length === 0) {
        out.push(`${source.name}：没有候选`);
        continue;
      }
      const manifest = readLocalFiles(ws);
      const entry = localEntry(manifest, source.name);
      const approved = new Set([...(Array.isArray(entry.approved) ? entry.approved : []), ...(sub === 'approve' ? paths : [])]);
      const skipped = new Set(Array.isArray(entry.skipped) ? entry.skipped : []);
      for (const p of paths) {
        if (sub === 'approve') { skipped.delete(p); } else { skipped.add(p); approved.delete(p); }
      }
      localUpdate(ws, source.name, { approved: [...approved], skipped: [...skipped] });
      out.push(`${source.name}：${sub === 'approve' ? '确认' : '跳过'} ${paths.length} 个`);
    }
    out.push('', '运行 `/hk-local apply` 补齐当前已绑定的 slot。');
    return ok(out.join('\n'));
  }

  if (sub === 'mode') {
    const mode = flags.mode ?? positional[1];
    if (!['copy', 'symlink'].includes(mode)) return err('用法：/hk-local mode copy|symlink --repo <仓库>');
    for (const source of sources) localUpdate(ws, source.name, { mode });
    return ok(`已设置 ${sources.map((s) => s.name).join('、')} 为 ${mode}。`);
  }

  if (sub === 'apply') {
    const notes = await provisionAllSlots(ws, sources);
    return ok(notes.length ? notes.join('\n') : '没有需要补齐的已绑定 slot。');
  }

  return err('用法：/hk-local [scan|status|approve all|path... | skip path... | mode copy|symlink | apply] [--repo <仓库>]');
}

// ---------------------------------------------------------------- /hk-doctor
async function hkDoctor({ agent }) {
  const ws = wsRoot(agent);
  const lines = ['## Harness Kit 体检', ''];
  lines.push(`- 工作区：\`${ws}\``);
  lines.push(`- 内容包目录：\`${packDir(readKit(ws) ?? undefined)}\` ${fs.existsSync(packDir(readKit(ws) ?? undefined)) ? '✅' : '❌ 缺失'}`);

  const kit = readKit(ws);
  if (!kit) {
    lines.push('- kit.json：❌ 不存在 → 运行 `/hk-init`');
    return ok(lines.join('\n'));
  }
  const reconcile = await reconcileArchivedQuiet(ws, kit);
  if (reconcile) {
    const released = reconcile.released.length;
    const stale = reconcile.stale.length;
    lines.push(
      `- 归档工作区台账：${
        released === 0 && stale === 0
          ? '✅ 无残留'
          : `${released > 0 ? `已释放 ${released} 项` : ''}${released > 0 && stale > 0 ? '，' : ''}${stale > 0 ? `保留 ${stale} 项待合入` : ''}`
      }${reconcile.tasks.length > 0 ? `（任务：${reconcile.tasks.map((t) => `\`${t}\``).join('、')}）` : ''}`,
    );
  } else {
    lines.push('- 归档工作区台账：⚠️ 对账失败（下一次命令或重跑 /hk-doctor 再试）');
  }
  lines.push(`- kit.json：✅（pack: ${kit.pack ?? 'ai-coding'}，sources: ${kit.sources.length} 个）`);
  for (const s of kit.sources) {
    lines.push(`  - ${s.name} → \`${s.path}\` ${fs.existsSync(path.join(ws, s.path)) ? '✅' : '❌ 路径缺失'}`);
  }
  const a = kit.assets;
  const embedded = !a || a.mode === 'local' ? await assetsLayout(ws) : null;
  lines.push(
    `- 资产仓库：${
      embedded?.layout === 'embedded'
        ? `🔗 随工作区根仓库管理（\`${embedded.repoRoot}\`，embedded：资产随根仓库 commit/push 共享，\`/hk-sync\` 不适用）`
        : !a || a.mode === 'local'
          ? '📁 本地模式（`/hk-init --assets <url|init>` 可绑定）'
          : a.mode === 'clone'
            ? `🔗 clone 自 \`${a.url}\`（分支 \`${a.branch ?? '?'}\`）`
            : `📦 本地 git（分支 \`${a.branch ?? '?'}\`${a.url ? `，远端 \`${a.url}\`` : '，无远端'}）`
    }${a?.autoSync === true ? '，归档后自动同步（autoSync）' : ''}`,
  );

  const roles = listRoles(ws, kit);
  lines.push(`- 角色注册表：${roles.length} 个（${roles.map((r) => `${r.role}${r.origin === 'workspace' ? '·覆写' : ''}`).join('、') || '无'}）`);
  for (const r of roles.filter((x) => x.error)) lines.push(`  - ⚠️ ${r.role}：${r.error}`);

  const planning = activeTasks(ws).filter((t) => taskIsPlanning(ws, t));
  const active = activeTasks(ws);
  lines.push(`- 活跃任务：${active.length ? active.map((t) => `\`${t}\``).join('、') : '无'}`);
  lines.push(`- Bootstrap 红线：${planning.length ? `🔒 锁定中（规划未裁决：${planning.join('、')}），写禁区 ${protectedSourcePaths(kit).join('、')}` : '🔓 未锁定'}`);

  const flowNames = ['fix', 'new', 'standard', 'quick', 'bugfix', 'refactor', '_router', 'init'];
  const flowStatus = flowNames.map((n) => {
    const f = loadFlow(ws, kit, n);
    return `${n} ${f ? '✅' : '❌'}`;
  });
  lines.push(`- 流程定义：${flowStatus.join('、')}`);

  const models = kit.models && typeof kit.models === 'object' ? Object.entries(kit.models) : [];
  lines.push(
    `- 模型映射：${models.length === 0 ? '（空 → 全部走会话默认；在 kit.json models 中配置 logical→{provider,model}）' : models.map(([k, v]) => `${k}→${v?.provider ? `${v.provider}/` : ''}${v?.model ?? '?'}`).join('、')}`,
  );

  // init assets materialization state：与 /hk-init 物化契约逐项对账（缺件 → 重跑 /hk-init create-only 补齐）
  const assetChecks = [
    'scripts/harness_init.py', 'scripts/harness.py', 'scripts/lib.py',
    'scripts/verify.py', 'scripts/spec_lint.py', 'scripts/env_auto.py',
    'scripts/check_codegraph.py', 'scripts/run_field.py', 'scripts/codebase_guide_init.py',
    'scripts/update_board.py', 'scripts/memory_index.py', 'scripts/te_lease.py',
    'rules/code-standards.md', 'specs/spec-template.md', 'memory/templates/entry.md',
    'memory/README.md', 'memory/cold.md',
  ];
  const missing = assetChecks.filter((rel) => !fs.existsSync(path.join(harnessDir(ws), rel)));
  const templatesOk = fs.existsSync(path.join(harnessDir(ws), 'templates')) && fs.readdirSync(path.join(harnessDir(ws), 'templates')).length > 0;
  if (!templatesOk) missing.push('templates/（目录为空）');
  lines.push(
    `- 初始化资产：${missing.length === 0 ? `✅ ${assetChecks.length} 项脚本/规范/模板 + templates 齐全` : `❌ 缺 ${missing.length} 项：${missing.map((m) => `\`${m}\``).join('、')} → 重跑 \`/hk-init\` 补齐`}`,
  );
  // 看板 7 列契约（lib.py _board_rows 硬编码列序；4 列旧简表会使分支列读取落空）
  const boardPath = path.join(harnessDir(ws), 'tasks', 'board.md');
  if (fs.existsSync(boardPath)) {
    const boardText = fs.readFileSync(boardPath, 'utf8');
    lines.push(`- 看板契约：${boardText.includes('| 任务名 | 状态 | Profile |') ? '✅ 7 列契约' : '⚠️ 非 7 列格式（缺 Profile/分支/续接提示列，lib.py 将读取落空）→ 按 boardTemplate 7 列表头整改'}`);
    // 看板内容体检（列格式契约，唯一写入门禁 update_board.py --check；脚本缺失则跳过，由上方资产检查报缺件）
    const ub = path.join(harnessDir(ws), 'scripts', 'update_board.py');
    if (fs.existsSync(ub)) {
      const chk = await run('python3', [ub, '--check'], { cwd: ws, timeoutMs: 15_000 });
      lines.push(`- 看板体检：${chk.code === 0 ? '✅ 全行合规' : `❌ 列格式违规 → python3 .harness/scripts/update_board.py --repair --write 修复\n${(chk.stdout || '').trim().split('\n').map((l) => `  ${l}`).join('\n')}`}`);
    }
  }
  // memory hot/cold 索引体检（脚本存在时；老工作区尚未迁移时给出明确提示）
  const memIndex = path.join(harnessDir(ws), 'scripts', 'memory_index.py');
  if (fs.existsSync(memIndex)) {
    if (fs.existsSync(path.join(harnessDir(ws), 'memory', 'index.md')) && fs.existsSync(path.join(harnessDir(ws), 'memory', 'cold.md'))) {
      const mc = await run('python3', [memIndex, 'check'], { cwd: ws, timeoutMs: 15_000 });
      lines.push(`- 记忆 hot/cold 索引：${mc.code === 0 ? `✅ ${(mc.stdout || '').trim()}` : `❌ ${(mc.stdout || mc.stderr || '').trim()}`}`);
    } else {
      lines.push('- 记忆 hot/cold 索引：⚠️ 尚未迁移（缺 memory/index.md 或 cold.md），运行 `/hk-init` 后执行 `python3 .harness/scripts/memory_index.py sync`');
    }
  }

  // pack 管理运行时漂移：scripts 内容与 pack 不一致 → 重跑 /hk-init 刷新（scripts 不入库，漂移只来自手改或 pack 升级后未刷新）
  const packScripts = path.join(packDir(kit), 'assets', 'scripts');
  const wsScripts = path.join(harnessDir(ws), 'scripts');
  if (fs.existsSync(packScripts)) {
    const drift = [];
    for (const f of fs.readdirSync(packScripts)) {
      if (!f.endsWith('.py')) continue;
      const b = path.join(wsScripts, f);
      if (!fs.existsSync(b)) drift.push(`${f}（缺失）`);
      else if (fs.readFileSync(path.join(packScripts, f), 'utf8') !== fs.readFileSync(b, 'utf8')) drift.push(`${f}（不一致）`);
    }
    lines.push(`- 运行时脚本：${drift.length === 0 ? '✅ 与 pack 一致' : `⚠️ 与 pack 漂移：${drift.join('、')} → 重跑 \`/hk-init\` 刷新`}`);
  }
  const py = await run('python3', ['--version'], { timeoutMs: 10_000 });
  lines.push(`- python3：${py.code === 0 ? `✅ ${py.stdout.trim()}` : '❌ 不可用（init 探测/校验脚本需要）'}`);
  const cg = await run('codegraph', ['--version'], { timeoutMs: 15_000 });
  lines.push(`- codegraph CLI：${cg.code === 0 ? `✅ ${cg.stdout.trim().split('\n')[0]}` : '⚠️ 未安装（init 的 CodeGraph 阶段会自动 npm install -g，需人批准）'}`);
  return ok(lines.join('\n'));
}

export function registerCommands(ctx) {
  const defs = [
    { name: 'hk-setup', description: '收集代码仓库并登记 kit.json（--add <url> [--name n] [--path p] [--role r] [--branch b]）', hint: '[--add <git-url> …]', handler: hkSetup },
    { name: 'hk-init', description: '初始化 .harness 骨架/资产仓库绑定/脚本模板物化，并编排子工程文档与 CodeGraph 索引生成（幂等）', hint: '[--assets <url|init|local>] [--branch <分支>]', handler: hkInit },
    { name: 'hk-fix', description: '启动轻量 fix 直通任务：脚手架 + PM 编排剧本', hint: '[任务名] <一句话描述> [--full|--light] [--auto]', handler: hkFix },
    { name: 'hk-new', description: '启动全流程任务（Bootstrap）：proposal 脚手架 + 需求澄清/profile 判定/定稿编排', hint: '[任务名] <需求描述> [--file <需求文件>] [--auto]', handler: hkNew },
    { name: 'hk-propose', description: '执行 propose 方案阶段（BA→SA→RR→审批1，按 proposal profile）', hint: '[任务名]', handler: hkPropose },
    { name: 'hk-apply', description: '执行 apply 实施阶段（Dev→CR→TE→审批2；含就绪预检与续接）', hint: '[任务名] [反馈]', handler: hkApply },
    { name: 'hk-archive', description: '归档任务本轮产物到 _archive 并清空活目录（全流程附带 Spec/Memory Merge 收尾）', hint: '<任务名>', handler: hkArchive },
    { name: 'hk-te', description: 'TE 环境串行租约（测试环境全局唯一）：acquire 授权/排队、release 释放/退队、status 查看', hint: '[acquire|release <任务名> | status]', handler: hkTe },
    { name: 'hk-local', description: '本地配置（git-ignored）发现/确认/复制：首次确认后新 slot 自动补齐', hint: '[scan|status|approve all|path... | skip path... | mode copy|symlink | apply] [--repo <仓库>]', handler: hkLocal },
    { name: 'hk-sync', description: '资产仓库 git 同步：自动提交 → pull --rebase → 纯追加文件自动三路合并 → push（其余冲突中止回滚转人工）', handler: hkSync },
    { name: 'hk-doctor', description: '检查 harness 工作区健康度（kit/角色/红线/流程）', hint: '', handler: hkDoctor },
  ];
  for (const def of defs) {
    ctx.commands.register({
      name: def.name,
      description: def.description,
      ...(def.hint ? { input: { hint: def.hint } } : {}),
      handler: ({ agent, rawInput }) => def.handler({ agent, rawInput }),
    });
  }
}
