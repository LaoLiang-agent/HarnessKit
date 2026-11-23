// 工作区初始化/子工程登记的确定性内核：/hk-setup 与 /hk-init 的文件与 git 操作层。
// 供 commands.js（CLI）与 panel.js（面板 HTTP 端点）共用；steer 编排留在 commands.js。
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './exec.js';
import { readKit, writeKit, defaultKit, harnessDir, packDir, kitPath, migrateLegacyLocalState } from './paths.js';

export function guessRole(name) {
  if (/front|web|ui/i.test(name)) return 'frontend';
  if (/app|android|ios|mobile/i.test(name)) return 'app';
  return 'backend';
}

export function boardTemplate() {
  return [
    '# 任务看板',
    '',
    '> **状态机**：PENDING → IN_PROGRESS → AWAITING_ARCHIVE → DONE →（重开轮次）→ PENDING',
    '> **Apply 子步骤**：Dev → CR → TE（记录在「Apply进度」列）',
    '> **重开轮次**：已归档（DONE）任务因 bugfix/新需求重开时，`/hk-apply` 将状态 `DONE → PENDING` 并标注 `R<N+1>`；归档为增量',
    '> **续接机制**：任何人读看板 + deliverables 即可接手继续',
    '',
    '| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |',
    '|--------|------|---------|-----------|------|---------|----------|',
    '',
    '> **写入纪律**：禁止直接编辑本文件，一律 `python3 .harness/scripts/update_board.py <任务> [--status …] [--apply …] [--branch …] [--hint …]`。',
    '> 列格式契约（脚本强校验）：状态=枚举；Profile=`standard/quick/bugfix/fix/fix-full/fix-light/refactor`（bugfix=全流程；fix 直通三态：',
    '> full 走 CR→TE、light 跳过 CR/TE 标 `—`、裸 `fix`=裁决未定过渡态（裁决后 PM 改写为 fix-full/fix-light）；未定档 `—`）；',
    '> Apply进度=`—｜已归档｜R<n>：阶段链`——链必须完整等于该 profile 固定流程（standard/quick/bugfix：`propose 审批1 Dev CR TE 审批2 验证`；',
    '> refactor 前置 `影响面`；fix 直通：`质量门 Dev CR TE 验证`），每阶段后缀 `✅完成 ▶当前(至多一个) …待做 ⛔阻塞 —跳过`，缺省阶段不许省略；',
    '> **顺序约束**：`▶` 之前必须全部 `✅` 或 `—`（面板会检测越序并在「需要你」提醒），⛔ 阻塞需人工裁决后改写；',
    '> 续接提示 ≤300 字符一句话「卡在X，下一步Y」，依赖前缀 `[等 任务名]`，禁 `|`/换行；上次活动由写入方自动打分钟级时间戳。',
    '',
  ].join('\n');
}

/** Recursively copy pack files. Default never overwrites; managed=true refreshes differing files (pack 管理运行时). */
export function copyNew(srcDir, dstDir, managed = false) {
  let added = 0;
  let existed = 0;
  let updated = 0;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, e.name);
    const dst = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      const r = copyNew(src, dst, managed);
      added += r.added;
      existed += r.existed;
      updated += r.updated;
    } else if (fs.existsSync(dst)) {
      if (managed && fs.readFileSync(src, 'utf8') !== fs.readFileSync(dst, 'utf8')) {
        fs.copyFileSync(src, dst);
        updated += 1;
      } else existed += 1;
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      added += 1;
    }
  }
  return { added, existed, updated };
}

/**
 * 登记/克隆一个代码仓库（/hk-setup --add 的确定性层）。
 * @returns {Promise<{ok:true, lines:string[], source:object}|{ok:false, error:string}>}
 */
export async function addSource(ws, { url, name, path: relPath, role, branch } = {}) {
  const kit = readKit(ws) ?? defaultKit();
  name = name ?? path.basename(url).replace(/\.git$/, '');
  const explicitRole = role; // 只有显式指定的 role 才触发语义目录名；自动推断保持仓名目录（CLI 行为不变）
  role = role ?? guessRole(name);
  // path 派生（2026-11-17 定）：显式 role 在已登记 sources 中唯一 → services/<role>（语义布局，
  // 与 iot-harness 手工约定一致）；role 空/重名/跨端 → 回落 services/<仓名>。
  // 显式传入的 path 永远优先；path 与 name 一样是"克隆后难改"字段，默认值在登记时定好。
  relPath = relPath ?? (explicitRole && !kit.sources.some((s) => s.role === explicitRole)
    ? `services/${explicitRole}`
    : `services/${name}`);
  const lines = [];

  // 已登记判定（2026-11-17 修复）：只看 kit.json 不够——团队资产仓库的 kit.json 自带
  // sources 登记（如 services/sie-iiot），克隆 .harness 后本地目录并不存在；此时必须补 clone，
  // 否则"初始化完成"但 services/ 空的假象。判定 = 登记 && 目录实际存在。
  const existing = kit.sources.find((s) => s.name === name || s.path === relPath);
  if (existing) {
    const existingAbs = path.join(ws, existing.path);
    const okExisting = fs.existsSync(existingAbs)
      && (await runGit(['rev-parse', '--git-dir'], { cwd: existingAbs })).code === 0;
    if (okExisting) {
      return { ok: false, error: `仓库 ${name}（${existing.path}）已登记且目录存在，无需重复添加。` };
    }
    // 已登记但本地无代码（资产仓库带来的登记）→ 沿用其登记坐标补 clone
    relPath = existing.path;
    name = existing.name;
    role = existing.role ?? role;
    lines.push(`登记已在资产仓库存在（${existing.path}），本地无代码 → 补 clone。`);
  }

  // 补 clone 时优先沿用资产仓库已登记的分支；显式传入的分支永远优先。
  // 修复：分支为空时之前不带 --branch，克隆默认分支后又按 existing.branch 登记，导致登记分支与实际 checkout 不一致。
  const requestedBranch = typeof branch === 'string' && branch.trim() ? branch.trim() : null;
  const cloneBranch = requestedBranch ?? existing?.branch ?? null;

  const abs = path.join(ws, relPath);
  if (fs.existsSync(abs)) {
    const isRepo = (await runGit(['rev-parse', '--git-dir'], { cwd: abs })).code === 0;
    if (isRepo) {
      lines.push(`路径 \`${relPath}\` 已存在且是 git 仓库，跳过 clone，直接登记。`);
    } else if (fs.readdirSync(abs).length === 0) {
      // 空目录（上次中断残留）→ 清掉重 clone
      fs.rmdirSync(abs);
      lines.push(`路径 \`${relPath}\` 是空目录（中断残留），已清理并重新 clone。`);
      const r = await runGit(['clone', ...(cloneBranch ? ['--branch', cloneBranch] : []), url, relPath], { cwd: ws, timeoutMs: 600_000 });
      if (r.code !== 0) return { ok: false, error: `git clone 失败（exit ${r.code}）：\n${r.stderr || r.stdout}` };
    } else {
      // 非 git 的已有目录：按既有约定直接登记（不 clone），但要提示（可能是本地代码/中断残留）
      lines.push(`路径 \`${relPath}\` 已存在但不是 git 仓库，跳过 clone 直接登记（如需克隆请先清理该目录）。`);
    }
  } else {
    lines.push(`执行：git clone ${cloneBranch ? `--branch ${cloneBranch} ` : ''}${url} ${relPath}`);
    const r = await runGit(['clone', ...(cloneBranch ? ['--branch', cloneBranch] : []), url, relPath], { cwd: ws, timeoutMs: 600_000 });
    if (r.code !== 0) return { ok: false, error: `git clone 失败（exit ${r.code}）：\n${r.stderr || r.stdout}` };
    lines.push('clone 完成。');
  }

  let resolvedBranch = cloneBranch;
  if (!resolvedBranch) {
    const b = await runGit(['branch', '--show-current'], { cwd: abs });
    resolvedBranch = b.code === 0 && b.stdout.trim() ? b.stdout.trim() : 'master';
  }
  if (existing) {
    // 补 clone 场景：刷新登记（url/role/branch 以本次为准，path/name 沿用资产登记）
    existing.url = url;
    existing.role = role;
    existing.branch = resolvedBranch;
  } else {
    kit.sources.push({ name, url, path: relPath, role, branch: resolvedBranch });
  }
  writeKit(ws, kit);
  lines.push(`已登记 **${name}** → \`${relPath}\`（role: ${role}, branch: ${resolvedBranch}），写入 .harness/kit.json。`);
  return { ok: true, lines, source: { name, path: relPath, role, branch: resolvedBranch } };
}

/**
 * 初始化 .harness 骨架/资产仓库绑定/脚本模板物化（/hk-init 的确定性层，幂等）。
 * @param {string} ws 工作区绝对路径
 * @param {{assets?: string, branch?: string, sources?: Array<object>}} opts
 *   assets 取值与 CLI 一致：'<git-url>' | 'init' | 'local' | undefined（省略=保持现状探测）；
 *   sources 为面板初始化向导登记的代码仓库（等价于逐个 /hk-setup --add，骨架物化后执行）。
 * @returns {Promise<{ok:true, created, kept, scanned, warnings, assetsBinding, attachPending, attachPushed, kit, sourceReports}|{ok:false, error:string}>}
 */
export async function runInit(ws, { assets, branch, sources = [], onProgress } = {}) {
  const hd = harnessDir(ws);
  const created = [];
  const kept = [];
  // 进度上报（面板初始化向导的"当前动作"动态提示；错误容忍，不影响初始化本身）
  const progress = (stage, detail = '') => {
    try { onProgress?.({ stage, detail }); } catch { /* 忽略 */ }
  };
  progress('骨架物化', '准备 .harness 资产与脚本');

  // 0. assets repo binding — clone must happen BEFORE the skeleton exists
  // (git clone requires an empty/missing target dir). Three cases (§7.2):
  //   --assets <url>  → clone the team assets repo as .harness/
  //   --assets init   → git init + first commit (after skeleton)
  //   --assets local / omitted → local mode, no git binding
  let assetsBinding = null;
  let attachPending = false; // 已有资产接管空远端：待骨架/物化完成后统一 commit+push
  if (assets && assets !== 'init' && assets !== 'local') {
    const url = assets;
    progress('资产仓库', `检查/克隆 ${url}`);
    if (fs.existsSync(hd) && fs.readdirSync(hd).length > 0) {
      // 已绑定同一远端 → 幂等跳过（重跑初始化/向导重复提交的常见场景，2026-11-17 事故：
      // 之前这里直接报"远端已有内容需人工合并"，导致已绑定工作区无法补齐子工程 clone）
      let bound = null;
      if (fs.existsSync(path.join(hd, '.git'))) {
        const curRemote = await runGit(['remote', 'get-url', 'origin'], { cwd: hd });
        if (curRemote.code === 0 && curRemote.stdout.trim() === url) {
          const cb = await runGit(['branch', '--show-current'], { cwd: hd });
          bound = { mode: 'clone', url, branch: cb.stdout.trim() || branch || 'master' };
        }
      }
      if (bound) {
        assetsBinding = bound;
        progress('资产仓库', `已绑定 ${url}（跳过克隆）`);
      } else {
        // 本地已有资产 + 想挂远端：仅当远端是空仓库（ls-remote 无任何 ref）才可自动接管——
        // git init + 绑定 origin，待骨架物化完成后整体首次提交并 push -u（见 step 5）。
        // 远端非空时存在同名文件取舍，必须人工合并，保持拒绝。
        const probe = await runGit(['ls-remote', url], { cwd: ws, timeoutMs: 60_000 });
        if (probe.code !== 0) {
          return { ok: false, error: `无法访问远端 \`${url}\`（exit ${probe.code}），无法确认其为空仓库：\n${(probe.stderr || probe.stdout).trim()}\n请确认 URL/凭据后重试，或按人工流程绑定。` };
        }
        if (probe.stdout.trim()) {
          return {
            ok: false,
            error:
              `远端 \`${url}\` 已有内容，与本地已有资产可能存在同名文件，需人工取舍，插件不自动合并（仅空仓库可自动接管）。\n` +
              '手工执行：\n' +
              '  cd .harness && git init && git remote add origin <url> && git fetch\n' +
              '  取舍合并后 push，再重跑 /hk-init（会自动探测回填绑定）。',
          };
        }
        // 空远端 → 自动接管
        if (!fs.existsSync(path.join(hd, '.git'))) {
          const gi = await runGit(['init', ...(branch ? ['-b', branch] : [])], { cwd: hd });
          if (gi.code !== 0) return { ok: false, error: `git init 失败（exit ${gi.code}）：\n${(gi.stderr || gi.stdout).trim()}` };
        }
        const ro = await runGit(['remote', 'get-url', 'origin'], { cwd: hd });
        if (ro.code !== 0) {
          const ra = await runGit(['remote', 'add', 'origin', url], { cwd: hd });
          if (ra.code !== 0) return { ok: false, error: `git remote add 失败（exit ${ra.code}）：\n${(ra.stderr || ra.stdout).trim()}` };
        } else if (ro.stdout.trim() !== url) {
          return { ok: false, error: `.harness 已绑定另一远端 \`${ro.stdout.trim()}\`，与参数 \`${url}\` 不一致，转人工处理。` };
        }
        const b = await runGit(['branch', '--show-current'], { cwd: hd });
        assetsBinding = { mode: 'clone', url, branch: b.stdout.trim() || branch || 'master' };
        attachPending = true;
        created.push('.harness/（已有资产接管空远端，待推送）');
      }
    } else {
      const r = await runGit(['clone', ...(branch ? ['--branch', branch] : []), url, '.harness'], { cwd: ws, timeoutMs: 600_000 });
      if (r.code !== 0) return { ok: false, error: `git clone 资产仓库失败（exit ${r.code}）：\n${r.stderr || r.stdout}` };
      const b = await runGit(['branch', '--show-current'], { cwd: hd });
      assetsBinding = { mode: 'clone', url, branch: b.stdout.trim() || branch || 'master' };
      created.push('.harness/（clone 自团队资产仓库）');
    }
  }

  // 1. .harness skeleton (idempotent)
  for (const dir of ['deliverables/_archive', 'specs', 'memory/entries', 'tasks', 'codebase-guide', 'agents', 'flows', 'templates', 'rules']) {
    const abs = path.join(hd, dir);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(`.harness/${dir}/`);
    }
  }
  for (const [file, content] of [
    ['tasks/board.md', boardTemplate()],
    // memory/index.md 只是 hot 路由表；规则/写入纪律在 memory/README.md，cold 默认不读。
    ['memory/index.md', [
      '# 工程记忆索引（hot）',
      '',
      '> 默认只读本文件；cold 索引见 `cold.md`，仅在 hot 无匹配时按需搜索。',
      '> 规则、写入纪律与降温阈值见 `README.md`；条目全文在 `entries/`。',
      '',
      '## hot 条目',
      '',
      '| scope | tags | 症状 / 触发 | entry |',
      '|---|---|---|---|',
      '<!-- 由 memory_index.py sync 生成/更新，勿手写 -->',
      '',
    ].join('\n')],
    ['memory/cold.md', [
      '# 工程记忆冷索引（cold）',
      '',
      '> 默认不读。hot 无匹配时，按 scope/tags/symptom 搜索本文件，再读命中的 entry。',
      '> 条目文件仍在 `entries/`，不删除；使用后运行 `memory_index.py touch <id>` 提升回 hot。',
      '',
      '## cold 条目',
      '',
      '| scope | tags | 症状 / 触发 | entry |',
      '|---|---|---|---|',
      '<!-- 由 memory_index.py sync 生成/更新，勿手写 -->',
      '',
    ].join('\n')],
    ['codebase-guide/index.md', [
      '# Codebase Guide 入口索引',
      '',
      '> **路由表**：不存代码细节，只告诉 Agent 去哪找。代码知识三层都在子工程自己维护。',
      '',
      '## 知识分布三层模型',
      '',
      '| 层 | 位置 | 性质 | 用途 |',
      '|---|---|---|---|---|',
      '| L1 入口 | `services/<子工程>/AGENTS.md`（优先）或 `CLAUDE.md`（兼容） | 人工编写 | 技术栈、框架模式、模块发现索引 |',
      '| L2 规范 | `services/<子工程>/docs/CODE_STANDARDS.md` | 人工编写 | 编码规范，团队持续打磨 |',
      '| L3 索引 | `services/<子工程>/.codegraph/` | CodeGraph 生成 | 类/方法/调用链，AI 通过 `codegraph explore` 查询 |',
      '',
      '## 按角色路由',
      '',
      '| 角色 | 必读 | 按需 |',
      '|---|---|---|',
      '| PM | overview.md、specs/_index.md、tasks/board.md | memory/index.md |',
      '| BA | overview.md、specs/_index.md、对应子工程 L1 AGENTS.md/CLAUDE.md | 相关模块 L1 AGENTS.md/CLAUDE.md |',
      '| SA | 对应子工程 L1 + L2、codegraph explore（L3） | 相关模块 L1 AGENTS.md/CLAUDE.md |',
      '| Dev | 对应子工程 L1 + L2、对应模块 L1 AGENTS.md/CLAUDE.md | codegraph explore（调用链） |',
      '| CR | .harness/rules/code-standards.md、子工程 L2 | codegraph explore（影响范围） |',
      '| TE | 任务 deliverables（proposal/requirements/design） | 对应子工程 L1 |',
      '',
      '## 本目录文件清单',
      '',
      '| 文件 | 内容 |',
      '|---|---|',
      '| `index.md` | 本文件 — 路由表 |',
      '| `overview.md` | 项目架构总览（技术栈、目录结构、子工程关系），由 `/hk-init` 流程据实补全 |',
      '',
    ].join('\n')],
    // overview.md 预置骨架：对应旧框架「框架模板预置 + 人/AI 逐步补全」约定，
    // codebase_guide_init.py 不生成此文件；BA/SA/RR 角色均引用它，缺失会导致悬空引用。
    ['codebase-guide/overview.md', [
      '# 项目架构总览',
      '',
      '> 预置骨架：`/hk-init` 物化，内容由人/AI 随任务逐步补全（技术栈、目录结构属工程事实，不得编造）。',
      '',
      '## 技术栈',
      '',
      '| 端 | 技术 | 说明 |',
      '|---|---|---|',
      '<!-- TODO: 按各子工程 AGENTS.md 或 CLAUDE.md / build.json 据实补全 -->',
      '',
      '## 目录结构',
      '',
      '<!-- TODO: 据实补全 -->',
      '',
      '## 核心开发流程',
      '',
      '1. 初始化：`/hk-setup` → `/hk-init`（探测子工程、生成三层文档 + CodeGraph 索引）',
      '2. 提案：`/hk-propose` → PM 调度 BA→SA→RR → 人工审批 1',
      '3. 执行：`/hk-apply` → PM 调度 Dev→CR→TE → 人工审批 2',
      '4. 归档：`/hk-archive` → Spec Merge + Memory Merge + 归档',
      '',
      '## 知识定位',
      '',
      '| 想知道什么 | 去哪看 |',
      '|---|---|---|',
      '| 子工程技术细节、框架模式 | `services/<子工程>/AGENTS.md`（优先）或 `CLAUDE.md`（兼容） |',
      '| 编码规范 | `services/<子工程>/docs/CODE_STANDARDS.md` |',
      '| 构建/启动/测试命令 | `services/<子工程>/.harness/build.json` |',
      '| 已有系统能力 | `.harness/specs/_index.md` |',
      '| 代码调用关系 | `codegraph explore <符号名>`（L3） |',
      '',
    ].join('\n')],
    // specs/_index.md 预置骨架：归档时 Spec Merge 更新；缺失时 BA/RR 的 specs 引用悬空。
    ['specs/_index.md', [
      '# 系统能力索引',
      '',
      '> **Source of Truth**。按业务域分组。每次 `/hk-archive` 时由 PM 执行 Spec Merge 更新。',
      '',
      '## 业务域',
      '',
      '| 域 | Prefix | 能力 | 对应 spec | 实体 | API 前缀 | 最后更新 |',
      '|----|--------|------|-----------|------|----------|---------|',
      '<!-- 首个任务归档时由 Spec Merge 填入 -->',
      '',
      '## 跨域约束登记表',
      '',
      '> 每条 CSTR 指向已登记域码的 Requirement——此处只做指针编排，不复制行为。',
      '',
      '| CSTR | 约束描述 | 锚定 Requirement | 注册时间 |',
      '|------|---------|-----------------|---------|',
      '<!-- 按需登记 -->',
      '',
      '## 跨域流程',
      '',
      '> 跨域时序/状态机沉淀到 `_flows.md`（首个跨域流程归档时创建并在此登记指针）。',
      '',
      '<!-- 按需登记 -->',
      '',
      '（spec 文档格式见 [`spec-template.md`](spec-template.md)：frontmatter + Requirement/Scenario 编号，id_max 不回收。）',
      '',
    ].join('\n')],
    // transient logs + pack 管理运行时 stay out of the assets repo (independent-repo layout)
    ['.gitignore', '.logs/**/*\n!.logs/**/\n!.logs/**/.gitkeep\n# pack 管理运行时（/hk-init 每次刷新，勿手改、勿提交）\nscripts/\n# 本机状态（机器本地，不共享、勿提交）\nlocal/\n'],
  ]) {
    const abs = path.join(hd, file);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, content, 'utf8');
      created.push(`.harness/${file}`);
    } else kept.push(`.harness/${file}`);
  }
  // 存量 .gitignore 补 scripts/ 排除（scripts 是 pack 管理运行时，不入资产仓库，§7 资产分层）
  const giPath = path.join(hd, '.gitignore');
  if (fs.existsSync(giPath) && !fs.readFileSync(giPath, 'utf8').split('\n').some((l) => l.trim() === 'scripts/')) {
    fs.appendFileSync(giPath, '# pack 管理运行时（/hk-init 每次刷新，勿手改、勿提交）\nscripts/\n', 'utf8');
    created.push('.harness/.gitignore（追加 scripts/ 排除）');
  }
  // 存量迁移：旧 .harness/config.json（apply-mode / mainline-branch）并入 kit.json 并删除
  // （2026-11-18：流程配置统一收进 kit.json，由面板设置页管理；旧文件只做一次性迁移）
  {
    const legacyPath = path.join(hd, 'config.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        const applyMode = legacy['apply-mode'];
        const k = readKit(ws) ?? defaultKit();
        let changed = false;
        if ((applyMode === 'auto' || applyMode === 'review') && k.applyMode === undefined) { k.applyMode = applyMode; changed = true; }
        if (changed) writeKit(ws, k);
        fs.rmSync(legacyPath, { force: true });
        created.push('.harness/config.json 已迁入 kit.json（applyMode；主线分支改用 sources[].branch）并删除旧文件');
      } catch (cause) {
        warnings.push(`旧 config.json 迁移失败（${cause.message}），文件保留：请手工把 apply-mode/mainline-branch 填入 kit.json 后删除`);
      }
    }
  }

  // 存量迁移：本机状态统一到 .harness/local/（旧 tasks/*.json 自动搬移），整目录不进资产库
  migrateLegacyLocalState(ws);
  const LOCAL_STATE = ['local/'];
  if (fs.existsSync(giPath)) {
    const cur = fs.readFileSync(giPath, 'utf8');
    const missing = LOCAL_STATE.filter((e) => !cur.split('\n').some((l) => l.trim() === e));
    if (missing.length > 0) {
      fs.appendFileSync(giPath, `# 本机状态（各机独立，勿提交）\n${missing.join('\n')}\n`, 'utf8');
      created.push('.harness/.gitignore（追加本机状态排除）');
    }
  }

  // 1b. 内容包模板/规则物化（spec/memory 格式契约 + 跨端编码底线；create-only）
  for (const [file, tpl] of [
    ['memory/templates/entry.md', 'memory-entry.md'],
    ['memory/README.md', 'memory-README.md'],
    ['specs/spec-template.md', 'spec-template.md'],
  ]) {
    const abs = path.join(hd, file);
    if (fs.existsSync(abs)) {
      kept.push(`.harness/${file}`);
      continue;
    }
    const src = path.join(packDir(readKit(ws) ?? undefined), 'templates', tpl);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    created.push(`.harness/${file}`);
  }
  // .harness/rules/code-standards.md：CR/Dev 契约引用的跨端底线，随包分发（create-only，工程可自行加严）
  {
    const abs = path.join(hd, 'rules/code-standards.md');
    if (fs.existsSync(abs)) kept.push('.harness/rules/code-standards.md');
    else {
      const src = path.join(packDir(readKit(ws) ?? undefined), 'rules', 'code-standards.md');
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(src, abs);
        created.push('.harness/rules/code-standards.md');
      }
    }
  }

  // 2. kit.json + sources auto-scan fallback (services/*/)
  let kit = readKit(ws);
  if (!kit) {
    kit = defaultKit();
    created.push('.harness/kit.json');
  }
  const scanned = [];
  const servicesDir = path.join(ws, 'services');
  if (fs.existsSync(servicesDir)) {
    for (const e of fs.readdirSync(servicesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rel = `services/${e.name}`;
      if (kit.sources.some((s) => s.path === rel)) continue;
      const abs = path.join(ws, rel);
      if (!fs.existsSync(path.join(abs, '.git'))) continue;
      const b = await runGit(['branch', '--show-current'], { cwd: abs });
      kit.sources.push({ name: e.name, path: rel, role: guessRole(e.name), branch: b.code === 0 && b.stdout.trim() ? b.stdout.trim() : 'master' });
      scanned.push(rel);
    }
  }

  // 2b. resolve assets binding (--assets init runs here, after the skeleton exists)
  const gitDir = path.join(hd, '.git');
  const warnings = [];
  if (fs.existsSync(gitDir)) {
    if (!assetsBinding) {
      const remote = await runGit(['remote', 'get-url', 'origin'], { cwd: hd });
      const b = await runGit(['branch', '--show-current'], { cwd: hd });
      const url = remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : undefined;
      assetsBinding = { mode: url ? 'clone' : 'init', ...(url ? { url } : {}), branch: b.stdout.trim() || 'master' };
    }
  } else if (assets === 'init') {
    const r1 = await runGit(['init'], { cwd: hd });
    if (r1.code !== 0) {
      warnings.push(`git init 失败（exit ${r1.code}）：${r1.stderr.trim() || r1.stdout.trim()}`);
      assetsBinding = { mode: 'local' };
    } else {
      await runGit(['add', '-A'], { cwd: hd });
      const rc = await runGit(['commit', '-m', 'harness: workspace init'], { cwd: hd });
      if (rc.code !== 0) {
        warnings.push(`首次 commit 失败（exit ${rc.code}）：${(rc.stderr || rc.stdout).trim()} —— 请检查 git user.name/user.email 配置后手工 commit`);
      } else {
        created.push('.harness/.git（首次 commit 完成）');
      }
      const b = await runGit(['branch', '--show-current'], { cwd: hd });
      assetsBinding = { mode: 'init', branch: b.stdout.trim() || 'master' };
    }
  } else {
    assetsBinding = { mode: 'local' };
  }
  kit.assets = { ...(kit.assets ?? {}), ...assetsBinding };
  writeKit(ws, kit);

  // 2c. 面板初始化向导登记的代码仓库（等价于逐个 /hk-setup --add；clone 失败的单项转为警告继续）
  const sourceReports = [];
  for (const [i, spec] of sources.entries()) {
    progress('克隆子工程', `${spec?.name || spec?.url || '?'}（${i + 1}/${sources.length}）→ ${spec?.path || 'services/…'}`);
    const r = await addSource(ws, spec);
    sourceReports.push(r);
    if (!r.ok) warnings.push(`子工程 ${spec?.url ?? spec?.name ?? '?'}：${r.error}`);
  }
  if (sources.length > 0) kit = readKit(ws) ?? kit;

  // 迁移：scripts/ 曾入库的仓库摘除追踪（本地文件保留；摘除结果随下次 /hk-sync 推送生效）
  if (fs.existsSync(gitDir)) {
    const tracked = await runGit(['ls-files', 'scripts'], { cwd: hd });
    if (tracked.code === 0 && tracked.stdout.trim()) {
      const rm = await runGit(['rm', '-r', '--cached', '-q', 'scripts'], { cwd: hd });
      if (rm.code === 0) created.push('scripts/ 已从资产仓库摘除追踪（本地文件保留，随 /hk-sync 生效）');
      else warnings.push(`scripts/ 摘除追踪失败（exit ${rm.code}）：${(rm.stderr || rm.stdout).trim()} —— 可手工 cd .harness && git rm -r --cached scripts`);
    }
  }

  // 3. host instruction file: prefer AGENTS.md; if either AGENTS.md or legacy CLAUDE.md
  //    already exists, do not generate the missing one (never overwrite).
  const agentsMd = path.join(ws, 'AGENTS.md');
  const legacyClaudeMd = path.join(ws, 'CLAUDE.md');
  const hasAgents = fs.existsSync(agentsMd);
  const hasClaude = fs.existsSync(legacyClaudeMd);
  if (!hasAgents && !hasClaude) {
    const sourceLines = kit.sources.map((s) => `| ${s.name} | \`${s.path}\` | ${s.role} | ${s.branch} |`).join('\n');
    fs.writeFileSync(
      agentsMd,
      [
        '# 项目指南（Harness Kit 生成）',
        '',
        '本工作区由 Harness Kit 管理：多子工程协作、需求/设计/交付物与经验记忆全部沉淀在 `.harness/`。深入任何子工程前先查下表资源，不要凭猜测行动。',
        '',
        '## 子工程地图',
        '',
        '| 名称 | 路径 | 角色 | 分支 |',
        '|---|---|---|---|',
        sourceLines || '| （待 /hk-setup 登记） | | | |',
        '',
        '## 工作区资源（.harness/）',
        '',
        '| 资源 | 位置 | 说明 |',
        '|---|---|---|',
        '| 协作契约 | `.harness/kit.json` | pack、资产仓库绑定、子工程清单 |',
        '| 系统能力索引 | `.harness/specs/_index.md` | 已有需求能力（Source of Truth） |',
        '| 架构总览 | `.harness/codebase-guide/overview.md` | 技术栈、目录结构、子工程关系 |',
        '| 知识路由 | `.harness/codebase-guide/index.md` | L1/L2/L3 三层知识模型与角色路由 |',
        '| 任务看板 | `.harness/tasks/board.md` | 当前任务与质量门状态 |',
        '| 经验记忆 | `.harness/memory/index.md` | 历史坑与流程优化条目 |',
        '| 编码底线 | `.harness/rules/code-standards.md` | 跨端编码红线 |',
        '| 交付物 | `.harness/deliverables/<任务>/` | 提案、需求、设计、测试报告 |',
        '',
        '## 构建与运行',
        '',
        '各子工程的编译/启动/测试命令以其自身 `services/<子工程>/.harness/build.json` 为唯一权威来源，本文件不重复登记。',
        '统一执行入口（自动解析运行时环境）：`python3 .harness/scripts/harness.py run-field <子工程> compile|start|stop|test`。',
        '',
        '## 红线',
        '',
        '- 规划阶段（质量门未裁决）禁止修改 services/ 下子工程与 e2e/ 源码。',
        '- 范围/口径/验收模糊时必须向人反问，禁止 AI 自行补全。',
        '',
      ].join('\n'),
      'utf8',
    );
    created.push('AGENTS.md');
  } else {
    kept.push(hasAgents ? 'AGENTS.md' : 'CLAUDE.md（legacy，未改动）');
  }

  // 4. materialize init assets from the pack — scripts 是 pack 管理运行时（不入库，每次刷新覆盖）；
  //    templates 是播种资产（项目可裁剪，create-only 不覆盖）
  for (const [srcDir, dstDir, label, managed] of [
    [path.join(packDir(kit), 'assets', 'scripts'), path.join(hd, 'scripts'), 'scripts', true],
    [path.join(packDir(kit), 'assets', 'templates'), path.join(hd, 'templates'), 'templates', false],
  ]) {
    if (!fs.existsSync(srcDir)) continue;
    const { added, existed, updated } = copyNew(srcDir, dstDir, managed);
    if (managed) {
      if (added > 0 || updated > 0) created.push(`.harness/${label}/（pack 刷新：新增 ${added}、更新 ${updated}${existed ? `、未变 ${existed}` : ''}）`);
      else kept.push(`.harness/${label}/（${existed} 个文件与 pack 一致）`);
    } else if (added > 0) created.push(`.harness/${label}/（物化 ${added} 个文件${existed ? `，保留已有 ${existed} 个` : ''}）`);
    else if (existed > 0) kept.push(`.harness/${label}/（${existed} 个文件已存在，未改动）`);
  }

  // 4b. 空远端接管收尾：骨架 + 物化完成后整体首次提交并 push -u
  let attachPushed = false;
  if (attachPending) {
    await runGit(['add', '-A'], { cwd: hd });
    const rc = await runGit(['commit', '-m', 'harness: 初始资产导入'], { cwd: hd });
    if (rc.code !== 0) {
      warnings.push(`初始提交失败（exit ${rc.code}）：${(rc.stderr || rc.stdout).trim()} —— 请检查 git user.name/user.email 配置后运行 \`/hk-sync\` 完成提交与推送`);
    } else {
      const rp = await runGit(['push', '-u', 'origin', assetsBinding.branch], { cwd: hd, timeoutMs: 600_000 });
      if (rp.code !== 0) {
        warnings.push(`push 失败（exit ${rp.code}）：${(rp.stderr || rp.stdout).trim()} —— 修复后运行 \`/hk-sync\` 重试推送`);
      } else {
        attachPushed = true;
        created.push('.harness/ 首次提交已推送到空远端');
      }
    }
  }

  progress('完成', '骨架/子工程/脚本已就绪');
  return { ok: true, created, kept, scanned, warnings, assetsBinding, attachPending, attachPushed, kit, sourceReports };
}

/** 将 runInit 结果格式化为 /hk-init 的完成汇报文本（CLI 与面板共用口径）。 */
export function formatInitReport(r, { steered = false } = {}) {
  const { created, kept, scanned, warnings, assetsBinding, attachPending, attachPushed, kit } = r;
  const lines = ['## /hk-init 完成', ''];
  if (created.length) lines.push(`新建：${created.map((c) => `\`${c}\``).join('、')}`);
  if (kept.length) lines.push(`保留（幂等）：${kept.map((c) => `\`${c}\``).join('、')}`);
  if (scanned.length) lines.push(`自动探测源码仓库：${scanned.map((s) => `\`${s}\``).join('、')}（已写入 kit.json sources）`);
  lines.push(
    `资产仓库：${
      assetsBinding.mode === 'clone'
        ? attachPending
          ? attachPushed
            ? `🔗 已有资产接管空远端 \`${assetsBinding.url}\`（分支 \`${assetsBinding.branch}\`，首次提交已推送）`
            : `🔗 已有资产接管空远端 \`${assetsBinding.url}\`（分支 \`${assetsBinding.branch}\`，⚠️ 推送未完成，见上方警告）`
          : `🔗 已绑定远端 \`${assetsBinding.url}\`（分支 \`${assetsBinding.branch}\`）`
        : assetsBinding.mode === 'init'
          ? `📦 本地 git 仓库（分支 \`${assetsBinding.branch}\`，尚无远端；建好远端后 \`cd .harness && git remote add origin <url> && git push -u\`）`
          : '📁 本地模式（未绑 git）；有团队资产仓库请在新工作区用 `/hk-init --assets <url>`，或新建仓库用 `/hk-init --assets init`'
    }`,
  );
  for (const w of warnings) lines.push(`⚠️ ${w}`);
  if (kit.sources.length === 0) lines.push('', '⚠️ 尚未登记任何代码仓库：先 `/hk-setup --add <url>`。');
  else if (steered) lines.push('', '初始化剧本已提交 PM：探测子工程 → 计划展示 → ⛔人确认 → 生成文档/索引 → 校验诊断。');
  else lines.push('', '⚠️ 未找到 init 流程定义（packs/ai-coding/flows/init.yml），跳过子工程文档生成编排。');
  return lines.join('\n');
}

/**
 * 目录预检（打开/新建工作区向导共用）：
 * 是否存在、是否目录、是否 Harness 工作区（.harness/kit.json）、kit 摘要。
 */
export function inspectDir(wsPath) {
  const out = { path: typeof wsPath === 'string' ? wsPath.trim() : '', exists: false, isDir: false, hasHarness: false, hasKit: false, pack: null, sourceCount: 0, assetsMode: null, kitError: null };
  if (!out.path) return out;
  if (!fs.existsSync(out.path)) return out;
  out.exists = true;
  try {
    out.isDir = fs.statSync(out.path).isDirectory();
  } catch {
    return out;
  }
  if (!out.isDir) return out;
  out.hasHarness = fs.existsSync(harnessDir(out.path));
  out.hasKit = fs.existsSync(kitPath(out.path));
  if (out.hasKit) {
    try {
      const kit = readKit(out.path);
      out.pack = kit?.pack ?? null;
      out.sourceCount = Array.isArray(kit?.sources) ? kit.sources.length : 0;
      out.assetsMode = kit?.assets?.mode ?? 'local';
    } catch (cause) {
      out.kitError = cause.message;
    }
  }
  return out;
}
