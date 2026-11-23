// Harness Kit regression suite (mock-agent simulation, no DSH runtime needed).
// Usage: node test/sim.mjs   (from the bundle root; exits non-zero on failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 插件内部会自己 spawn `git commit`（资产仓库初始化/同步）。CI 与干净机器没有全局
// git 身份，会让这些子进程提交失败；给整套测试一个固定身份，让子进程继承。
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'harness-kit-test',
  GIT_AUTHOR_EMAIL: 'test@harness-kit.invalid',
  GIT_COMMITTER_NAME: 'harness-kit-test',
  GIT_COMMITTER_EMAIL: 'test@harness-kit.invalid',
});

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { registerCommands } = await import(path.join(bundleRoot, 'kernel/commands.js'));
const { installGuards } = await import(path.join(bundleRoot, 'kernel/guards.js'));
const { addSource, runInit, inspectDir, formatInitReport } = await import(path.join(bundleRoot, 'kernel/setup.js'));

const handlers = new Map();
registerCommands({ commands: { register: (d) => handlers.set(d.name, d.handler) } });

const results = [];
const ok = (name, cond) => results.push({ name, cond: !!cond });
const section = (s) => results.push({ section: s });

const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-sim-'));
const agentFor = (ws, steered = []) => ({ session: { header: { cwd: ws } }, steer: (m) => steered.push(m.content[0].text) });
const readKitJson = (ws) => JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
const fake = (ws, rel, content) => {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (args, cwd) => execSync(`git ${args}`, { cwd, encoding: 'utf8', env: gitEnv });
const run = (name, raw, ws, steered = []) => handlers.get(name)({ agent: agentFor(ws, steered), rawInput: raw });

const cleanups = [];
const ws0 = mkws();
cleanups.push(ws0);

// ---------------------------------------------------------------- hk-init base
section('hk-init 骨架/物化/幂等/编排');
{
  const ws = ws0;
  fake(ws, 'services/backend/.git/HEAD', 'ref: refs/heads/dev');
  fake(ws, 'services/backend/pom.xml', '<project><modules><module>core</module></modules></project>');
  fake(ws, 'services/backend/core/pom.xml', '<project/>');
  const steered = [];
  const res = await run('hk-init', '', ws, steered);
  ok('骨架+kit.json 生成', res.kind === 'success' && fs.existsSync(path.join(ws, '.harness/deliverables/_archive')));
  ok('services/* 自动扫描登记', readKitJson(ws).sources.some((s) => s.name === 'backend'));
  ok('scripts 物化', fs.existsSync(path.join(ws, '.harness/scripts/harness_init.py')));
  ok('templates 物化', fs.existsSync(path.join(ws, '.harness/templates/java/maven-multimodule/build.tmpl')));
  ok('模板使用 AGENTS 命名', fs.existsSync(path.join(ws, '.harness/templates/java/maven-multimodule/root-AGENTS.tmpl')) && !fs.existsSync(path.join(ws, '.harness/templates/java/maven-multimodule/root-CLAUDE.tmpl')));
  ok('新工作区只生成 AGENTS，不生成 CLAUDE', fs.existsSync(path.join(ws, 'AGENTS.md')) && !fs.existsSync(path.join(ws, 'CLAUDE.md')));
  ok('assets.mode=local（默认）', readKitJson(ws).assets?.mode === 'local');
  ok('codebase-guide/overview.md 预置骨架', fs.readFileSync(path.join(ws, '.harness/codebase-guide/overview.md'), 'utf8').includes('项目架构总览'));
  ok('specs/_index.md 预置骨架（含跨域流程节）', (() => { const t = fs.readFileSync(path.join(ws, '.harness/specs/_index.md'), 'utf8'); return t.includes('系统能力索引') && t.includes('跨域流程'); })());
  ok('specs/spec-template.md 物化（frontmatter 契约）', fs.readFileSync(path.join(ws, '.harness/specs/spec-template.md'), 'utf8').includes('id_max_r'));
  ok('memory/index.md 预置 hot 索引（scope/tags/症状/entry）', (() => { const t = fs.readFileSync(path.join(ws, '.harness/memory/index.md'), 'utf8'); return t.includes('hot') && t.includes('scope') && t.includes('症状') && t.includes('entry'); })());
  ok('memory/cold.md 与 README 预置', fs.existsSync(path.join(ws, '.harness/memory/cold.md')) && fs.readFileSync(path.join(ws, '.harness/memory/README.md'), 'utf8').includes('hot / cold'));
  ok('memory_index.py 物化', fs.existsSync(path.join(ws, '.harness/scripts/memory_index.py')));
  ok('memory/templates/entry.md 物化（含流程优化排除节）', fs.readFileSync(path.join(ws, '.harness/memory/templates/entry.md'), 'utf8').includes('流程优化排除'));
  ok('handoff 模板物化（含读取清单）', fs.readFileSync(path.join(ws, '.harness/templates/handoff.md'), 'utf8').includes('读取清单'));
  ok('verify.py 物化（非子模块布局可跳过阶段1/2）', (() => { const p = path.join(ws, '.harness/scripts/verify.py'); return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('非子模块布局'); })());
  ok('rules/code-standards.md 物化（跨端编码底线）', (() => { const p = path.join(ws, '.harness/rules/code-standards.md'); return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('注入防护'); })());
  ok('spec_lint.py 物化（扁平/目录双布局）', (() => { const p = path.join(ws, '.harness/scripts/spec_lint.py'); return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('specs/<domain>.md'); })());
  ok('codebase-guide/index.md 路由表骨架', fs.readFileSync(path.join(ws, '.harness/codebase-guide/index.md'), 'utf8').includes('知识分布三层模型'));
  // 包资产契约：PM 前置检查不得硬依赖未随包物化的 check_harness.py；归档门禁指向随包的 spec_lint.py；shim 按存在性过滤
  const packAssets = path.join(bundleRoot, 'packs/ai-coding');
  const pmContract = fs.readFileSync(path.join(packAssets, 'agents/project-manager.md'), 'utf8');
  ok('PM 契约前置检查不硬依赖 check_harness.py', !pmContract.includes('必须先运行 `python3 .harness/scripts/check_harness.py') && pmContract.includes('check_codegraph.py --sync --all'));
  ok('PM 契约归档门禁指向 spec_lint.py', pmContract.includes('spec_lint.py` PASS'));
  ok('harness.py shim 按存在性过滤命令', fs.readFileSync(path.join(packAssets, 'assets/scripts/harness.py'), 'utf8').includes('def available()'));
  ok('steer init 剧本（含探测/确认/CodeGraph）', steered.length === 1 && steered[0].includes('harness_init.py --detect') && steered[0].includes('生成确认') && steered[0].includes('CodeGraph'));
  // scripts 是 pack 管理运行时：重跑刷新覆盖本地手改；templates 播种资产仍 create-only
  fs.writeFileSync(path.join(ws, '.harness/scripts/harness_init.py'), '# user modified\n');
  const tmplPath = path.join(ws, '.harness/templates');
  const tmplFile = fs.readdirSync(tmplPath, { recursive: true }).find((f) => String(f).endsWith('.md') || String(f).endsWith('.tmpl'));
  fs.appendFileSync(path.join(tmplPath, tmplFile), '\n# user tuned\n');
  await run('hk-init', '', ws, []);
  ok('pack 管理：scripts 刷新覆盖本地手改', fs.readFileSync(path.join(ws, '.harness/scripts/harness_init.py'), 'utf8') !== '# user modified\n');
  ok('播种资产：templates 保留项目裁剪', fs.readFileSync(path.join(tmplPath, tmplFile), 'utf8').includes('# user tuned'));
  ok('.gitignore 排除 scripts/', fs.readFileSync(path.join(ws, '.harness/.gitignore'), 'utf8').split('\n').some((l) => l.trim() === 'scripts/'));
}

// ------------------------------------------------- hk-init assets binding
section('hk-init 资产仓库绑定三情形');
const remote = (() => {
  const tmp = mkws();
  cleanups.push(tmp);
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'memory/entries'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'memory/entries/team-lesson.md'), '# 团队踩坑\n');
  fs.writeFileSync(path.join(seed, 'kit.json'), JSON.stringify({ version: 1, pack: 'ai-coding', sources: [{ name: 'legacy', path: 'services/legacy', role: 'backend', branch: 'dev' }] }));
  git('init -q', seed);
  git('add -A && git commit -qm seed', seed);
  git(`clone -q --bare ${seed} remote.git`, tmp);
  return path.join(tmp, 'remote.git');
})();
{
  const ws = mkws();
  cleanups.push(ws);
  const res = await run('hk-init', `--assets ${remote}`, ws);
  const kit = readKitJson(ws);
  ok('clone：远端 sources/记忆保留', kit.sources.some((s) => s.name === 'legacy') && fs.existsSync(path.join(ws, '.harness/memory/entries/team-lesson.md')));
  ok('clone：assets.mode=clone + url', kit.assets?.mode === 'clone' && kit.assets?.url === remote);
  ok('clone：结果文本含远端', res.text.includes('已绑定远端'));
  // 重跑初始化 + 同一 assets url（已绑定）→ 幂等跳过，不报"需人工合并"（2026-11-17 iot-test 事故）
  const againSame = await run('hk-init', `--assets ${remote}`, ws);
  ok('已绑定同一资产远端 → 重跑幂等成功', againSame.kind === 'success' && againSame.text.includes('已绑定远端') && !againSame.text.includes('人工取舍'));
}
{
  const ws = mkws();
  cleanups.push(ws);
  fs.mkdirSync(path.join(ws, '.harness/deliverables'), { recursive: true });
  const res = await run('hk-init', `--assets ${remote}`, ws);
  ok('非空远端 + 本地已有内容 → 拒绝且指引人工', res.kind === 'error' && res.text.includes('人工取舍') && res.text.includes('空仓库'));
}
{
  // 空远端 + 本地已有资产 → 自动接管：git init + 绑定 origin + 首次提交（含物化产物）+ push -u
  const tmp = mkws();
  cleanups.push(tmp);
  git('init -q --bare empty.git', tmp);
  const emptyRemote = path.join(tmp, 'empty.git');
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, '.harness/memory/entries/local-lesson.md', '# 本地踩坑\n');
  const res = await run('hk-init', `--assets ${emptyRemote}`, ws);
  const kit = readKitJson(ws);
  ok('接管空远端：mode=clone + 本地文件保留', kit.assets?.mode === 'clone' && kit.assets?.url === emptyRemote && fs.existsSync(path.join(ws, '.harness/memory/entries/local-lesson.md')));
  ok('接管空远端：结果文本含已推送', res.text.includes('首次提交已推送'));
  const remoteFiles = git('ls-tree -r --name-only HEAD', emptyRemote);
  ok('接管空远端：远端含本地资产+7列看板', remoteFiles.includes('memory/entries/local-lesson.md') && git('show HEAD:tasks/board.md', emptyRemote).includes('| 任务名 | 状态 | Profile |'));
  ok('接管空远端：scripts 不入库 + 本地仍物化', !remoteFiles.split('\n').some((f) => f.startsWith('scripts/')) && fs.existsSync(path.join(ws, '.harness/scripts/verify.py')));
  ok('接管空远端：远端 .gitignore 排除 scripts/', git('show HEAD:.gitignore', emptyRemote).includes('scripts/'));
}
{
  // 迁移：scripts 已入库的老仓库，重跑 init 自动摘除追踪（本地文件保留）
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '--assets init', ws);
  const hd = path.join(ws, '.harness');
  git('add -f scripts && git commit -qm legacy-tracked', hd); // 模拟旧版入库状态
  ok('旧行为前置：scripts 曾被追踪', git('ls-files scripts', hd).trim().length > 0);
  await run('hk-init', '', ws);
  ok('迁移：scripts 摘除追踪 + 本地文件保留', git('ls-files scripts', hd).trim() === '' && fs.existsSync(path.join(hd, 'scripts/verify.py')));
}
{
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '--assets init', ws);
  const log = git('log --oneline', path.join(ws, '.harness'));
  ok('init：首次 commit + mode=init', log.includes('harness: workspace init') && readKitJson(ws).assets?.mode === 'init');
}
{
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '', ws);
  git('init -q && git add -A && git commit -qm manual', path.join(ws, '.harness'));
  git(`remote add origin ${remote}`, path.join(ws, '.harness'));
  await run('hk-init', '', ws);
  ok('手工绑定后重跑 → 自动探测回填', readKitJson(ws).assets?.mode === 'clone' && readKitJson(ws).assets?.url === remote);
}

// ---------------------------------------------------------------- hk-fix
section('hk-fix 直通');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  const steered = [];
  const res = await run('hk-fix', 'login-bug 登录偶发 401', ws, steered);
  ok('bugfix.md 脚手架生成', res.kind === 'success' && fs.existsSync(path.join(ws, '.harness/deliverables/login-bug/bugfix.md')));
  ok('steer fix 剧本（含 PM 角色/质量门）', steered.length === 1 && steered[0].includes('PM 角色') && steered[0].includes('质量门'));
  const again = await run('hk-fix', 'login-bug 重复', ws, []);
  ok('任务目录已存在 → 拒绝重复', again.kind === 'error');
}

// ---------------------------------------------------------------- hk-archive
section('hk-archive 归档与预检');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  await run('hk-fix', 't1 描述', ws);
  const fail = await run('hk-archive', 't1', ws);
  ok('无裁决 → 预检 FAIL', fail.kind === 'error' && fail.text.includes('预检 FAIL'));
  fs.appendFileSync(path.join(ws, '.harness/deliverables/t1/bugfix.md'), '\n\n裁决：轻量\n');
  const done = await run('hk-archive', 't1', ws);
  ok('有裁决 → 归档成功', done.kind === 'success');
  ok('_archive 追加 + rounds.md + 活目录清空',
    fs.existsSync(path.join(ws, '.harness/deliverables/_archive/t1/bugfix.md')) &&
    fs.readFileSync(path.join(ws, '.harness/deliverables/_archive/t1/rounds.md'), 'utf8').includes('| R0 |') &&
    !fs.existsSync(path.join(ws, '.harness/deliverables/t1')));
}

// ---------------------------------------------------------------- guards
section('红线护栏');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  let guardFn;
  installGuards({ tools: { guard: (fn) => { guardFn = fn; } } }, null);
  const exec = (name, args) => guardFn({ name, arguments: args, agent: agentFor(ws) });

  ok('无条件拦截 git push -f', !!exec('bash', { command: 'git push -f origin dev' }));
  ok('无条件拦截 git reset --hard', !!exec('bash', { command: 'git reset --hard HEAD~1' }));
  ok('放行普通 git', !exec('bash', { command: 'git status' }));

  await run('hk-fix', 'g1 描述', ws);
  ok('规划未裁决 → 拦截 edit 源码区', !!exec('edit', { file_path: 'services/backend/src/Main.java' }));
  ok('规划未裁决 → 拦截 bash 写源码区', !!exec('bash', { command: "echo x >> services/backend/src/Main.java" }));
  ok('规划未裁决 → 放行非保护区', !exec('edit', { file_path: '.harness/deliverables/g1/bugfix.md' }));
  fs.appendFileSync(path.join(ws, '.harness/deliverables/g1/bugfix.md'), '\n\n裁决：轻量\n');
  ok('裁决后 → 放行源码区', !exec('edit', { file_path: 'services/backend/src/Main.java' }));
}

// ---------------------------------------------------------------- hk-doctor
section('hk-doctor 体检');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '--assets init', ws);
  const res = await run('hk-doctor', '', ws);
  ok('体检成功', res.kind === 'success');
  ok('含资产仓库/角色/init资产/python3 行', res.text.includes('资产仓库') && res.text.includes('角色注册表') && res.text.includes('初始化资产') && res.text.includes('python3'));
  ok('含全流程定义与模型映射行', res.text.includes('standard ✅') && res.text.includes('_router ✅') && res.text.includes('模型映射'));
  ok('初始化资产全量对账齐全', res.text.includes('初始化资产：✅') && !res.text.includes('初始化资产：❌'));
  ok('看板契约 7 列 ✅', res.text.includes('看板契约：✅'));
  ok('运行时脚本与 pack 一致 ✅', res.text.includes('运行时脚本：✅'));
  // 手改 scripts → 漂移被点名；重跑 init 刷新后恢复一致
  fs.appendFileSync(path.join(ws, '.harness/scripts/verify.py'), '\n# hand tweak\n');
  const resDrift = await run('hk-doctor', '', ws);
  ok('scripts 漂移被点名', resDrift.text.includes('运行时脚本：⚠️') && resDrift.text.includes('verify.py（不一致）'));
  await run('hk-init', '', ws);
  const resFresh = await run('hk-doctor', '', ws);
  ok('重跑 init 刷新后恢复一致', resFresh.text.includes('运行时脚本：✅'));
  // 缺件与旧看板格式应被点名
  fs.rmSync(path.join(ws, '.harness/scripts/spec_lint.py'));
  fs.rmSync(path.join(ws, '.harness/rules'), { recursive: true, force: true });
  fs.writeFileSync(path.join(ws, '.harness/tasks/board.md'), '# 看板\n\n| 任务 | 状态 | 负责 | 更新 |\n|---|---|---|---|\n');
  const res2 = await run('hk-doctor', '', ws);
  ok('缺件被点名（spec_lint/rules）', res2.text.includes('初始化资产：❌') && res2.text.includes('spec_lint.py') && res2.text.includes('rules/code-standards.md'));
  ok('4 列旧看板被警告', res2.text.includes('看板契约：⚠️'));
  const resFix = await run('hk-doctor', '--fix', ws);
  ok('doctor --fix 补齐脚本/规范', resFix.kind === 'success' && fs.existsSync(path.join(ws, '.harness/scripts/spec_lint.py')) && fs.existsSync(path.join(ws, '.harness/rules/code-standards.md')));
  ok('doctor --fix 修复看板并复检通过', resFix.text.includes('看板已按 7 列契约修复') && fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8').includes('| 任务名 | 状态 | Profile |'));
}

// ---------------------------------------------------------------- 本机状态目录
section('本机状态统一到 .harness/local/');
{
  const { readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const { readTaskSessions } = await import(path.join(bundleRoot, 'kernel/bindings.js'));
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, '.harness/tasks/worktrees.json', JSON.stringify({ version: 2, slots: { backend: { 'slot-1': { task: 't1' } } }, tasks: { t1: { repos: {} } } }));
  fake(ws, '.harness/tasks/sessions.json', JSON.stringify({ tasks: { t1: { sessionId: 's1', at: 'now' } } }));
  const ledger = readWorkspaces(ws);
  ok('旧 worktrees.json 自动迁入 local/', fs.existsSync(path.join(ws, '.harness/local/worktrees.json')) && !fs.existsSync(path.join(ws, '.harness/tasks/worktrees.json')) && !!ledger.tasks.t1);
  const sessions = readTaskSessions(ws);
  ok('旧 sessions.json 自动迁入 local/', fs.existsSync(path.join(ws, '.harness/local/sessions.json')) && !fs.existsSync(path.join(ws, '.harness/tasks/sessions.json')) && sessions.t1?.sessionId === 's1');
  ok('迁移时补 .gitignore local/', fs.readFileSync(path.join(ws, '.harness/.gitignore'), 'utf8').split('\n').some((l) => l.trim() === 'local/'));
}
// ---------------------------------------------------------------- /hk 统一入口
section('/hk 统一入口：init / task / close / doctor');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'ref: refs/heads/dev');
  const help = await run('hk', '', ws);
  ok('/hk 无参数返回入口说明', help.kind === 'success' && help.text.includes('/hk init') && help.text.includes('/hk close'));
  const init = await run('hk', 'init', ws);
  ok('/hk init 等价初始化', init.kind === 'success' && fs.existsSync(path.join(ws, '.harness/kit.json')));
  const task = await run('hk', 'task unified-one 统一入口立项', ws, []);
  ok('/hk task 等价 /hk-new', task.kind === 'success' && fs.existsSync(path.join(ws, '.harness/deliverables/unified-one/proposal.md')));
  const doctor = await run('hk', 'doctor', ws);
  ok('/hk doctor 等价体检', doctor.kind === 'success' && doctor.text.includes('Harness Kit 体检'));
  const fix = await run('hk', 'task --fix quick-one 一句话修复', ws, []);
  fs.appendFileSync(path.join(ws, '.harness/deliverables/quick-one/bugfix.md'), '\n\n裁决：轻量\n');
  const close = await run('hk', 'close quick-one', ws);
  ok('/hk close 等价归档并写统计', fix.kind === 'success' && close.kind === 'success' && !fs.existsSync(path.join(ws, '.harness/deliverables/quick-one')) && fs.existsSync(path.join(ws, '.harness/deliverables/_archive/quick-one/metrics/R0.json')));
  const unknown = await run('hk', 'nope', ws);
  ok('/hk 未知子命令给指引', unknown.kind === 'error' && unknown.text.includes('init / task / close / doctor'));
}
// ---------------------------------------------------------------- hk-new
section('hk-new Bootstrap 脚手架');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  fake(ws, 'req.md', '# 需求：设备接入');
  await run('hk-init', '', ws);
  const steered = [];
  const res = await run('hk-new', 'device-onboard 新增设备接入 --file req.md', ws, steered);
  const taskDir = path.join(ws, '.harness/deliverables/device-onboard');
  ok('proposal.md 脚手架 + 需求文件拷入',
    res.kind === 'success' &&
    fs.existsSync(path.join(taskDir, 'proposal.md')) &&
    fs.existsSync(path.join(taskDir, 'req.md')));
  const proposal = fs.readFileSync(path.join(taskDir, 'proposal.md'), 'utf8');
  ok('提案含任务名/描述/状态 draft', proposal.includes('device-onboard') && proposal.includes('新增设备接入') && /\*\*状态\*\*：draft/.test(proposal));
  ok('立项即生成 handoff（含任务名/读取清单）', (() => { const t = fs.readFileSync(path.join(taskDir, 'handoff.md'), 'utf8'); return t.includes('Handoff — device-onboard') && t.includes('读取清单'); })());
  ok('看板登记 PENDING（7 列契约）', (() => { const t = fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8'); return t.includes('| device-onboard | PENDING |') && t.includes('| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |') && t.includes('状态机'); })());
  ok('steer bootstrap 剧本（路由表/反问/定稿）', steered.length === 1 && steered[0].includes('路由表') && steered[0].includes('ask_user_question'));
  const dup = await run('hk-new', 'device-onboard 重复', ws, []);
  ok('任务目录已存在 → 拒绝重复', dup.kind === 'error');
  const badFile = await run('hk-new', 't-x 描述 --file nope.md', ws, []);
  ok('需求文件缺失 → FAIL 且不残留目录', badFile.kind === 'error' && !fs.existsSync(path.join(ws, '.harness/deliverables/t-x')));
  // 空目录残留（上次中断/手动清理后只剩空壳）→ 复用重建而不是报撞名
  fs.rmSync(path.join(taskDir, 'proposal.md'));
  fs.rmSync(path.join(taskDir, 'req.md'));
  fs.rmSync(path.join(taskDir, 'handoff.md'));
  const retry = await run('hk-new', 'device-onboard 清理残留后重试', ws, []);
  ok('空目录残留 → 复用重建成功', retry.kind === 'success' && fs.existsSync(path.join(taskDir, 'proposal.md')));
}

// ---------------------------------------------------------------- memory hot/cold
section('memory hot/cold 索引与自动降温');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  const memory = path.join(ws, '.harness/memory');
  const script = path.join(ws, '.harness/scripts/memory_index.py');
  fake(ws, '.harness/memory/entries/2026-08-01_backend_old.md', [
    '---', 'id: M-20260801-backend-old', 'date: 2026-08-01', 'scope: backend',
    'tags: [RecordSet, old]', 'pinned: false', '---', '', '# 旧条目：RecordSet 空集', '',
  ].join('\n'));
  fake(ws, '.harness/memory/entries/2026-08-01_backend_pinned.md', [
    '---', 'id: M-20260801-backend-pinned', 'date: 2026-08-01', 'scope: backend',
    'tags: [Kafka, pinned]', 'pinned: true', '---', '', '# 高风险旧条目：Kafka 认证', '',
  ].join('\n'));
  fake(ws, '.harness/memory/entries/2026-11-01_frontend_new.md', [
    '---', 'id: M-20261101-frontend-new', 'date: 2026-11-01', 'scope: frontend',
    'tags: [Vue, new]', 'pinned: false', '---', '', '# 新条目：Vue 响应式', '',
  ].join('\n'));
  const py = (args) => execSync(`python3 ${script} ${args}`, { cwd: ws, encoding: 'utf8' });
  py('sync');
  const hot1 = fs.readFileSync(path.join(memory, 'index.md'), 'utf8');
  const cold1 = fs.readFileSync(path.join(memory, 'cold.md'), 'utf8');
  ok('memory sync：三条均在 hot', hot1.includes('M-20260801-backend-old') === false && hot1.includes('entries/2026-08-01_backend_old.md') && hot1.includes('entries/2026-11-01_frontend_new.md') && !cold1.includes('entries/2026-08-01_backend_old.md'));
  const cool = py('cool --days 60 --apply');
  const hot2 = fs.readFileSync(path.join(memory, 'index.md'), 'utf8');
  const cold2 = fs.readFileSync(path.join(memory, 'cold.md'), 'utf8');
  ok('自动降温：未 pin 旧条目进 cold', cool.includes('applied') && !hot2.includes('entries/2026-08-01_backend_old.md') && cold2.includes('entries/2026-08-01_backend_old.md'));
  ok('自动降温：pinned 旧条目保持 hot', hot2.includes('entries/2026-08-01_backend_pinned.md') && !cold2.includes('entries/2026-08-01_backend_pinned.md'));
  const touch = py('touch M-20260801-backend-old');
  const hot3 = fs.readFileSync(path.join(memory, 'index.md'), 'utf8');
  ok('touch：cold 条目提升回 hot', touch.includes('touched') && hot3.includes('entries/2026-08-01_backend_old.md'));
  ok('memory check 通过', py('check').includes('PASS'));
}

// ---------------------------------------------------------------- 任务名：ASCII / --auto
section('任务名：ASCII 限制与 --auto');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  const cn = await run('hk-new', '设备接入优化 中文任务名描述', ws, []);
  ok('中文任务名 → 拒绝（提示英文命名）', cn.kind === 'error');
  const auto1 = await run('hk-new', '--auto 纯中文描述没有英文词', ws, []);
  ok('hk-new --auto 纯中文 → 时间戳名', auto1.kind === 'success' && /auto-\d{8}-\d{4}/.test(auto1.text) && auto1.text.includes('自动生成'));
  const auto2 = await run('hk-fix', '--auto fix login timeout retry', ws, []);
  ok('hk-fix --auto → 英文词 kebab 名', auto2.kind === 'success' && fs.existsSync(path.join(ws, '.harness/deliverables/fix-login-timeout-retry/bugfix.md')));
  ok('hk-fix 登记看板 PENDING', fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8').includes('| fix-login-timeout-retry | PENDING |'));
  const bad = await run('hk-new', '-x 描述', ws, []);
  ok('非法任务名（符号开头）→ 拒绝', bad.kind === 'error');
  const autoDup = await run('hk-fix', '--auto fix login timeout retry', ws, []);
  ok('--auto 撞名自动加序号', autoDup.kind === 'success' && autoDup.text.includes('fix-login-timeout-retry-2'));
}

// ------------------------------------------------- 全流程：propose/apply/archive
section('全流程 propose/apply/archive');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  const steered = [];
  await run('hk-new', 'feat-x 新增能力 X', ws, steered);
  const taskDir = path.join(ws, '.harness/deliverables/feat-x');

  // red line: proposal without approval 1 locks source paths
  let guardFn;
  installGuards({ tools: { guard: (fn) => { guardFn = fn; } } }, null);
  const exec = (name, args) => guardFn({ name, arguments: args, agent: agentFor(ws) });
  ok('审批 1 未记录 → 红线锁定源码区', !!exec('edit', { file_path: 'services/backend/src/A.java' }));

  // propose requires approved proposal
  const notApproved = await run('hk-propose', 'feat-x', ws, []);
  ok('proposal draft → propose 拒绝', notApproved.kind === 'error' && notApproved.text.includes('未定稿'));
  // 定稿（模拟 PM 写回）+ 人工填 profile
  let proposal = fs.readFileSync(path.join(taskDir, 'proposal.md'), 'utf8');
  proposal = proposal.replace('**状态**：draft', '**状态**：approved');
  fs.writeFileSync(path.join(taskDir, 'proposal.md'), proposal, 'utf8');
  const p1 = await run('hk-propose', 'feat-x', ws, steered);
  ok('approved → propose 启动（默认 standard）', p1.kind === 'success' && p1.text.includes('profile=standard'));
  // M4b 自动认领
  {
    const claimsFile = path.join(ws, '.harness/tasks/claims.json');
    const lines = fs.existsSync(claimsFile) ? fs.readFileSync(claimsFile, 'utf8').trim().split('\n') : [];
    const entry = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    ok('propose 自动认领写 claims.json', !!entry && entry.task === 'feat-x' && typeof entry.by === 'string' && !!entry.ts);
    ok('propose 返回含认领提示', p1.text.includes('自动认领'));
  }
  ok('propose 剧本只含 propose 阶段且带模型路由',
    steered[steered.length - 1].includes('需求分析') &&
    steered[steered.length - 1].includes('就绪评审') &&
    !steered[steered.length - 1].includes('### 阶段 5') &&
    steered[steered.length - 1].includes('模型路由'));
  ok('看板转 IN_PROGRESS', fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8').includes('| feat-x | IN_PROGRESS |'));
  // 模拟 PM 维护看板：补 Profile/分支列，验证后续状态迁移保留这些列
  {
    const bp = path.join(ws, '.harness/tasks/board.md');
    fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8').replace(/^\| feat-x \|.*$/m,
      '| feat-x | IN_PROGRESS | standard | — | feat/harness-feat-x (backend) | 2026-11-10 | Dev 进行中 |'), 'utf8');
  }

  // apply requires approval 1 + readiness PASS
  const noAp1 = await run('hk-apply', 'feat-x', ws, []);
  ok('审批 1 未记录 → apply 拒绝', noAp1.kind === 'error' && noAp1.text.includes('审批 1'));
  fs.appendFileSync(path.join(taskDir, 'proposal.md'), '\n\n审批 1：通过（2026-11-10）\n');
  const noReady = await run('hk-apply', 'feat-x', ws, []);
  ok('缺 readiness-report → 就绪预检 FAIL', noReady.kind === 'error' && noReady.text.includes('就绪预检 FAIL'));
  fake(ws, '.harness/deliverables/feat-x/readiness-report.md', '# 就绪评审\n\n## 结论\n\nBLOCK：方案有坑\n');
  const blocked = await run('hk-apply', 'feat-x', ws, []);
  ok('结论 BLOCK → 就绪预检 FAIL', blocked.kind === 'error');
  fake(ws, '.harness/deliverables/feat-x/readiness-report.md', '# 就绪评审\n\n## 结论\n\n结论：PASS\n');
  const a1 = await run('hk-apply', 'feat-x 续接：先补单测', ws, steered);
  ok('PASS → apply 启动且携带反馈', a1.kind === 'success' && a1.text.includes('续接反馈'));
  ok('apply 剧本只含 apply 阶段（Dev/CR/TE）',
    steered[steered.length - 1].includes('代码审查') &&
    !steered[steered.length - 1].includes('需求分析'));
  ok('审批 1 已记录 → 红线解锁源码区', !exec('edit', { file_path: 'services/backend/src/A.java' }));

  // archive requires test-report PASS
  const noTr = await run('hk-archive', 'feat-x', ws, []);
  ok('缺 test-report → 归档预检 FAIL', noTr.kind === 'error' && noTr.text.includes('test-report.md'));
  fake(ws, '.harness/deliverables/feat-x/test-report.md', '# 测试报告\n\n## 结论\n\nPASS\n');
  fake(ws, '.harness/deliverables/feat-x/requirements.md', '# 需求\n\n## §7 Spec Delta\n\nADDED: 能力X\n');
  // spec 门禁内核化：specs 有违规（同码 Requirement）→ 归档被内核拦截；修复后放行
  fake(ws, '.harness/specs/test.md',
    '---\ndomain: test\nsummary: x\nentities: []\napi_prefixes: []\nprefix: TST\nid_max_r: 2\nid_max_s: 0\nretired: []\nlast_updated: 2026-11-11\n---\n\n' +
    '### Requirement: 一 (TST-R-1)\n系统 SHALL 做一。\n\n#### Scenario: 一 (TST-S-1)\n- GIVEN a WHEN b THEN c\n\n' +
    '### Requirement: 二 (TST-R-1)\n系统 SHALL 做二。\n\n#### Scenario: 二 (TST-S-2)\n- GIVEN a WHEN b THEN c\n');
  const lintBlocked = await run('hk-archive', 'feat-x', ws, []);
  ok('spec 门禁违规 → 归档内核拦截', lintBlocked.kind === 'error' && lintBlocked.text.includes('spec 编号门禁'));
  fs.rmSync(path.join(ws, '.harness/specs/test.md'));
  const arch = await run('hk-archive', 'feat-x', ws, steered);
  ok('全流程归档成功 + 收尾剧本 steer',
    arch.kind === 'success' &&
    steered[steered.length - 1].includes('Spec Merge') &&
    fs.existsSync(path.join(ws, '.harness/deliverables/_archive/feat-x/proposal.md')) &&
    !fs.existsSync(taskDir));
  ok('归档写入运行统计快照',
    fs.existsSync(path.join(ws, '.harness/deliverables/_archive/feat-x/metrics/R0.json')));
  ok('收尾剧本锚定 spec/memory 格式契约模板',
    steered[steered.length - 1].includes('spec-template.md') &&
    steered[steered.length - 1].includes('memory/templates/entry.md') &&
    steered[steered.length - 1].includes('流程优化排除'));
  ok('看板转 DONE（保留 Profile/分支等既有列）', (() => { const t = fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8'); return t.includes('| feat-x | DONE |') && t.includes('| feat-x | DONE | standard | — | feat/harness-feat-x (backend) |'); })());
  ok('看板上次活动为分钟级时间戳', /\| feat-x \| DONE \| standard \| — \| feat\/harness-feat-x \(backend\) \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/.test(fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8')));
}

// ---------------------------------------------------------------- 看板防漂移（破列容错）
section('看板防漂移（破列容错）');
{
  const { updateBoard } = await import(path.join(bundleRoot, 'kernel/commands.js'));
  const { parseBoard } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const ws = mkws();
  cleanups.push(ws);
  // 历史漂移现场复刻：续接提示混入 |（15 列）+ 状态列夹带括注 + 超长填充
  fake(ws, '.harness/tasks/board.md', [
    '# 任务看板',
    '',
    '| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |',
    '|--------|------|---------|-----------|------|---------|----------|',
    '| kafka-forward-sasl | DONE | refactor | R1 完成 | feat/sasl (backend) | 2026-09-25 | TE PASS | 待人归档 | 残留 | 多余 | 列 |',
    '| feat-y | PENDING | standard | — | — | 2026-11-10 | — |',
    '',
  ].join('\n'));
  const before = parseBoard(fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8'));
  ok('parseBoard 破列容错：溢出并入续接提示，前列不错位', (() => {
    const r = before.rows.find((x) => x.task === 'kafka-forward-sasl');
    return r && r.status === 'DONE' && r.branch === 'feat/sasl (backend)' && r.hint === 'TE PASS / 待人归档 / 残留 / 多余 / 列';
  })());
  updateBoard(ws, 'kafka-forward-sasl', 'AWAITING_ARCHIVE');
  const after = parseBoard(fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8'));
  ok('updateBoard 破列行状态写入正确列且其余列不丢', (() => {
    const r = after.rows.find((x) => x.task === 'kafka-forward-sasl');
    return r && r.status === 'AWAITING_ARCHIVE' && r.branch === 'feat/sasl (backend)' && r.hint.includes('TE PASS / 待人归档');
  })());
  ok('updateBoard 不影响其他行', after.rows.find((x) => x.task === 'feat-y')?.status === 'PENDING');
  // 新行必须插进表格（尾部引用块之后不得出现任务行）——2026-11-13 cluster-monitor 落表格外事故
  const tail = ['', '> **续接提示编写规范**：一句话说明「现在卡在哪、下一步做什么」。', '> 例如："等待 CR 审查 feedback"', ''];
  fake(ws, '.harness/tasks/board.md', [
    '# 任务看板', '',
    '| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |',
    '|--------|------|---------|-----------|------|---------|----------|',
    '| feat-y | PENDING | standard | — | — | 2026-11-10 | — |',
    ...tail,
  ].join('\n'));
  updateBoard(ws, 'brand-new-task', 'IN_PROGRESS');
  const lines = fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8').split('\n');
  const newIdx = lines.findIndex((l) => l.startsWith('| brand-new-task '));
  const quoteIdx = lines.findIndex((l) => l.startsWith('>'));
  ok('updateBoard 新行插入表格内（引用块之前）', newIdx > 0 && quoteIdx > 0 && newIdx < quoteIdx);
  ok('updateBoard 新行紧随最后表格行', lines[newIdx - 1].startsWith('| feat-y '));
  const nb = parseBoard(lines.join('\n'));
  ok('updateBoard 新行可被 parseBoard 读回', nb.rows.some((x) => x.task === 'brand-new-task' && x.status === 'IN_PROGRESS'));
  // update_board.py 存在且语法可解析（列格式契约强校验的唯一写入门禁）
  ok('update_board.py 随包分发且可编译', (() => {
    const p = path.join(bundleRoot, 'packs/ai-coding/assets/scripts/update_board.py');
    execSync(`python3 -c "import ast; ast.parse(open('${p}').read())"`);
    return true;
  })());
  ok('init 资产清单含 update_board.py', fs.readFileSync(path.join(bundleRoot, 'kernel/commands.js'), 'utf8').includes("'scripts/update_board.py'"));
  // 重复任务行（契约：一任务一行）：--check 检出、--repair 合并（保留非 DONE 行）、写入拒绝
  const ub = `python3 ${path.join(bundleRoot, 'packs/ai-coding/assets/scripts/update_board.py')}`;
  const boardFile = path.join(ws, '.harness/tasks/board.md');
  fs.appendFileSync(boardFile, '| kafka-forward-sasl | PENDING | — | — | — | 2026-11-12 | 延期尾巴 |\n| kafka-forward-sasl | PENDING | — | — | — | 2026-11-12 | 重复二号 |\n');
  ok('--check 检出重复任务行', (() => {
    try { execSync(`${ub} --check`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 1; }
  })());
  ok('--repair 合并重复行（保留非 DONE 行）', (() => {
    execSync(`${ub} --repair --write`, { cwd: ws, stdio: 'pipe' });
    const rows = parseBoard(fs.readFileSync(boardFile, 'utf8')).rows.filter((r) => r.task === 'kafka-forward-sasl');
    return rows.length === 1 && rows[0].status === 'PENDING';
  })());
  ok('写入时拒绝重复任务（提示先 repair）', (() => {
    fs.appendFileSync(boardFile, '| feat-y | PENDING | — | — | — | 2026-11-12 | 重复 |\n');
    try { execSync(`${ub} feat-y --status IN_PROGRESS`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2; }
    finally { execSync(`${ub} --repair --write`, { cwd: ws, stdio: 'pipe' }); }
  })());
  // v4：链必须完整等于 profile 固定流程模板（省略即违规；— 仅 fix 直通轻量 CR/TE）
  ok('省略阶段的链写入被拒（standard 缺 propose/审批1）', (() => {
    try { execSync(`${ub} vt1 --status IN_PROGRESS --profile standard --apply 'R2：Dev✅ 验证▶'`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2 && String(e.stdout).includes('完整覆盖'); }
  })());
  ok('standard 链 CR 标 — 被拒（仅 fix 直通轻量允许）', (() => {
    execSync(`${ub} vt1 --status IN_PROGRESS --profile standard --apply 'R1：propose✅ 审批1✅ Dev▶ CR… TE… 审批2… 验证…'`, { cwd: ws, stdio: 'pipe' });
    try { execSync(`${ub} vt1 --apply 'R2：propose✅ 审批1✅ Dev▶ CR— TE… 审批2… 验证…'`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2 && String(e.stdout).includes('不允许标'); }
  })());
  ok('fix-light 轻量链（CR— TE—）合法；fix-full / 裸 fix 拒绝 —', (() => {
    execSync(`${ub} vt2 --status IN_PROGRESS --profile fix-light --apply 'R1：质量门✅ Dev✅ CR— TE— 验证▶'`, { cwd: ws, stdio: 'pipe' });
    const legal = !!parseBoard(fs.readFileSync(boardFile, 'utf8')).rows.find((r) => r.task === 'vt2')?.apply.includes('CR— TE—');
    let fullRejected = false;
    try { execSync(`${ub} vt2b --status PENDING --profile fix-full --apply 'R1：质量门▶ Dev… CR— TE— 验证…'`, { cwd: ws, stdio: 'pipe' }); }
    catch (e) { fullRejected = e.status === 2 && String(e.stdout).includes('不允许标'); }
    let bareRejected = false;
    try { execSync(`${ub} vt2c --status PENDING --profile fix --apply 'R1：质量门▶ Dev… CR— TE— 验证…'`, { cwd: ws, stdio: 'pipe' }); }
    catch (e) { bareRejected = e.status === 2; }
    return legal && fullRejected && bareRejected;
  })());
  ok('bugfix=全流程模板校验（直通链被拒）', (() => {
    try { execSync(`${ub} vt3 --status IN_PROGRESS --profile bugfix --apply 'R1：质量门✅ Dev▶ CR… TE… 验证…'`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2 && String(e.stdout).includes('完整覆盖'); }
  })());
  ok('越序链写入被拒（▶ 前有 … 待做）', (() => {
    try { execSync(`${ub} vt4 --status IN_PROGRESS --profile quick --apply 'R1：propose✅ 审批1✅ Dev✅ CR… TE… 审批2… 验证▶'`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2 && String(e.stdout).includes('待做阶段之后'); }
  })());
  ok('⛔ 在 … 之后同样被拒', (() => {
    try { execSync(`${ub} vt5 --status IN_PROGRESS --profile quick --apply 'R1：propose✅ 审批1✅ Dev… CR⛔ TE… 审批2… 验证…'`, { cwd: ws, stdio: 'pipe' }); return false; }
    catch (e) { return e.status === 2 && String(e.stdout).includes('待做阶段之后'); }
  })());
  ok('repair 遗留 fix 三态消解（proposal→bugfix；--full→fix-full；轻量→fix-light；无→fix）', (() => {
    fake(ws, '.harness/deliverables/inf1/proposal.md', '# p\n');
    fake(ws, '.harness/deliverables/inf2/bugfix.md', '## R0\n- 质量门裁决：--full\n');
    fake(ws, '.harness/deliverables/inf3/bugfix.md', '## R0\n- 质量门裁决：轻量\n');
    fs.appendFileSync(boardFile, [
      '| inf1 | IN_PROGRESS | fix | R1：质量门✅ Dev▶ CR… TE… 验证… | — | 2026-11-12 | x |',
      '| inf2 | IN_PROGRESS | fix | R1：质量门✅ Dev▶ CR… TE… 验证… | — | 2026-11-12 | x |',
      '| inf3 | IN_PROGRESS | fix | R1：质量门✅ Dev▶ CR… TE… 验证… | — | 2026-11-12 | x |',
      '| inf4 | PENDING | fix | — | — | 2026-11-12 | x |',
      '',
    ].join('\n'));
    execSync(`${ub} --repair --write`, { cwd: ws, stdio: 'pipe' });
    const rows = parseBoard(fs.readFileSync(boardFile, 'utf8')).rows;
    const g = (n) => rows.find((r) => r.task === n);
    return g('inf1')?.profile === 'bugfix' && !!g('inf1')?.apply.startsWith('R1：propose✅ 审批1✅ Dev▶')
      && g('inf2')?.profile === 'fix-full' && g('inf3')?.profile === 'fix-light'
      && g('inf4')?.profile === 'fix' && g('inf4')?.apply === 'R1：质量门… Dev… CR… TE… 验证…';
  })());
  ok('repair 规范化为固定模板（缺省补齐、非法 — 重推导）', (() => {
    fs.appendFileSync(boardFile, '| vt4 | IN_PROGRESS | standard | R2：Dev✅ 验证▶ | — | 2026-11-12 | x |\n');
    fs.appendFileSync(boardFile, '| vt5 | PENDING | quick | — | — | 2026-11-12 | y |\n');
    execSync(`${ub} --repair --write`, { cwd: ws, stdio: 'pipe' });
    const rows = parseBoard(fs.readFileSync(boardFile, 'utf8')).rows;
    const r4 = rows.find((r) => r.task === 'vt4')?.apply;
    const r5 = rows.find((r) => r.task === 'vt5')?.apply;
    return r4 === 'R2：propose✅ 审批1✅ Dev✅ CR… TE… 审批2… 验证▶'
      && r5 === 'R1：propose… 审批1… Dev… CR… TE… 审批2… 验证…';
  })());
}

// ---------------------------------------------------------------- hk-fix --full 一致性
section('hk-archive fix --full 一致性预检');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  await run('hk-fix', 'fb 描述 --full', ws);
  const dir = path.join(ws, '.harness/deliverables/fb');
  fs.appendFileSync(path.join(dir, 'bugfix.md'), '\n\n裁决：--full\n');
  const fail = await run('hk-archive', 'fb', ws, []);
  ok('--full 缺 CR/TE 文档 → FAIL', fail.kind === 'error' && fail.text.includes('code-review.md'));
  fake(ws, '.harness/deliverables/fb/code-review.md', '# CR\nPASS\n');
  fake(ws, '.harness/deliverables/fb/test-report.md', '# TE\nPASS\n');
  const done = await run('hk-archive', 'fb', ws, []);
  ok('--full 文档齐备 → 归档成功', done.kind === 'success');
}

// ---------------------------------------------------------------- 模型路由
section('模型路由解析');
{
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'services/backend/.git/HEAD', 'x');
  await run('hk-init', '', ws);
  // write logical model mapping into kit.json
  const kitFile = path.join(ws, '.harness/kit.json');
  const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
  kit.models = { reasoning: { provider: 'p1', model: 'm-reason' }, fast: { provider: 'p2', model: 'm-fast' } };
  fs.writeFileSync(kitFile, JSON.stringify(kit, null, 2));
  const steered = [];
  await run('hk-new', 'mx 测试模型路由', ws, []);
  let proposal = fs.readFileSync(path.join(ws, '.harness/deliverables/mx/proposal.md'), 'utf8');
  fs.writeFileSync(path.join(ws, '.harness/deliverables/mx/proposal.md'), proposal.replace('**状态**：draft', '**状态**：approved'), 'utf8');
  await run('hk-propose', 'mx', ws, steered);
  const prompt = steered[steered.length - 1];
  ok('SA(reasoning) 映射为 p1/m-reason', prompt.includes('reasoning → provider=p1, model=m-reason'));
  ok('未映射逻辑模型标注会话默认', prompt.includes('会话默认'));
  ok('含 list_subagent_models 校验指令', prompt.includes('list_subagent_models'));
}
{
  // 角色级映射优先于逻辑模型名；dispatchSection 标注命中来源
  const { resolveWorkerModel, describeWorkerModel, dispatchSection } = await import(path.join(bundleRoot, 'kernel/models.js'));
  const kit = { models: { reasoning: { model: 'm-reason' }, 'solution-architect': { provider: 'p9', model: 'm-sa' } } };
  ok('角色映射优先于逻辑名', (() => {
    const r = resolveWorkerModel(kit, 'solution-architect', 'reasoning');
    return r.via === 'role' && r.entry.model === 'm-sa' && r.entry.provider === 'p9';
  })());
  ok('无角色映射时回落逻辑名', (() => {
    const r = resolveWorkerModel(kit, 'developer', 'reasoning');
    return r.via === 'logical' && r.entry.model === 'm-reason';
  })());
  ok('都未映射返回 null', resolveWorkerModel(kit, 'developer', 'fast') === null && resolveWorkerModel(kit, 'developer', null) === null);
  ok('describeWorkerModel 标注命中来源', describeWorkerModel(kit, 'solution-architect', 'reasoning').includes('角色映射 solution-architect') && describeWorkerModel(kit, 'developer', 'reasoning').includes('逻辑模型 reasoning'));
  ok('缺 provider 的映射 → 指引为不传参数（成对校验规避）', describeWorkerModel(kit, 'developer', 'reasoning').includes('会话默认') && !describeWorkerModel(kit, 'developer', 'reasoning').includes('provider=（会话默认 provider）'));
  // 子智能体路由授权收集（kit.json models → 去重路由）
  const { collectModelRoutes } = await import(path.join(bundleRoot, 'kernel/models.js'));
  ok('路由收集去重（同路由多角色只授权一次）', (() => {
    const routes = collectModelRoutes({ models: { a: { provider: 'p1', model: 'm1' }, b: { provider: 'p1', model: 'm1' }, c: { provider: 'p2', model: 'm2' }, d: { model: 'no-provider' } } });
    return routes.length === 2 && routes.some((r) => r.provider === 'p1' && r.model === 'm1') && routes.some((r) => r.provider === 'p2' && r.model === 'm2');
  })());
  ok('路由收集：空/坏映射容忍', collectModelRoutes(null).length === 0 && collectModelRoutes({ models: { x: { provider: '', model: 'm' }, y: { provider: 'p' } } }).length === 0);
  const sec = dispatchSection(kit, [{ role: 'solution-architect', logical: 'reasoning' }, { role: 'developer', logical: 'reasoning' }]);
  ok('dispatchSection 含两级键说明与来源标注', sec.includes('两级键') && sec.includes('角色映射 solution-architect') && sec.includes('逻辑模型 reasoning'));
}
{
  // 本机覆盖：local 角色 > team 角色 > local 逻辑 > team 逻辑 > 会话默认
  const { resolveWorkerModel, describeWorkerModel, collectModelRoutes } = await import(path.join(bundleRoot, 'kernel/models.js'));
  const team = { models: {
    reasoning: { provider: 'team', model: 'm-reason' },
    'solution-architect': { provider: 'team', model: 'm-sa' },
    developer: { provider: 'team', model: 'm-dev' },
  } };
  const local = {
    'solution-architect': { provider: 'local', model: 'l-sa' },
    reasoning: { provider: 'local', model: 'l-reason' },
  };
  const sa = resolveWorkerModel(team, 'solution-architect', 'reasoning', local);
  ok('本机角色覆盖团队角色', sa.via === 'local-role' && sa.entry.provider === 'local' && sa.entry.model === 'l-sa');
  const dev = resolveWorkerModel(team, 'developer', 'reasoning', local);
  ok('团队角色优先于本机逻辑', dev.via === 'role' && dev.entry.model === 'm-dev');
  const te = resolveWorkerModel(team, 'test-engineer', 'reasoning', local);
  ok('无团队角色时本机逻辑覆盖', te.via === 'local-logical' && te.entry.model === 'l-reason');
  const unknown = resolveWorkerModel(team, 'code-reviewer', 'fast', local);
  ok('都未映射返回 null', unknown === null);
  const desc = describeWorkerModel(team, 'solution-architect', 'reasoning', local);
  ok('本机覆盖标注来源', desc.includes('本机角色映射') && desc.includes('provider=local'));
  ok('本机逻辑覆盖标注来源', describeWorkerModel(team, 'test-engineer', 'reasoning', local).includes('本机逻辑模型 reasoning'));
  const routes = collectModelRoutes(team, local);
  ok('路由授权合并团队+本机', routes.some((r) => r.provider === 'local' && r.model === 'l-sa')
    && routes.some((r) => r.provider === 'team' && r.model === 'm-dev'));
}
{
  // 本机模型文件：路径、忽略、读写、坏数据容错
  const { writeLocalModels, readLocalModels, localModelsPath } = await import(path.join(bundleRoot, 'kernel/local-models.js'));
  const ws = mkws();
  cleanups.push(ws);
  const p = localModelsPath(ws);
  ok('本机模型文件路径', p === path.join(ws, '.harness/local/models.json'));
  writeLocalModels(ws, { developer: { provider: 'p', model: 'm', reasoning_effort: 'high' } });
  ok('本机模型写入/读取', readLocalModels(ws).developer?.model === 'm' && readLocalModels(ws).developer?.reasoning_effort === 'high');
  const gi = fs.readFileSync(path.join(ws, '.harness/.gitignore'), 'utf8');
  ok('local/ 自动加入 gitignore', gi.split('\n').some((l) => l.trim() === 'local/'));
  fake(ws, '.harness/local/models.json', '{bad json');
  ok('坏本机模型文件容错为空', Object.keys(readLocalModels(ws)).length === 0);
}

// ---------------------------------------------------------------- 并行 worktree
section('池化工作区（主树优先 + slot 池）');
{
{
  // hk-apply 端到端（真实 git 仓）：单任务分配主工作树 + 剧本注入「并行工作区」节
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  await run('hk-init', '', ws);
  const steered = [];
  await run('hk-new', 'wt-e2e 池化工作区集成', ws, steered);
  const proposalPath = path.join(ws, '.harness/deliverables/wt-e2e/proposal.md');
  fs.writeFileSync(proposalPath, fs.readFileSync(proposalPath, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  await run('hk-propose', 'wt-e2e', ws, steered);
  fs.appendFileSync(proposalPath, '\n\n审批 1：通过（2026-11-14）\n');
  fake(ws, '.harness/deliverables/wt-e2e/readiness-report.md', '# 就绪\n\n## 结论\n\nPASS\n');
  const r = await run('hk-apply', 'wt-e2e', ws, steered);
  ok('hk-apply 返回工作区分配摘要', r.kind === 'success' && r.text.includes('工作区分配') && r.text.includes('主工作树') && r.text.includes('feat/harness-wt-e2e'));
  const prompt = steered[steered.length - 1];
  ok('剧本注入并行工作区节（主树模式）', prompt.includes('并行工作区') && prompt.includes('主工作树') && prompt.includes('feat/harness-wt-e2e'));
  ok('单任务不建 slot（仅有分析镜像目录）', !fs.existsSync(path.join(ws, '.worktrees/backend/slot-1')));
}

  const { ensureTaskWorkspaces, releaseTaskWorkspaces, clearTaskWorkspaces, renderWorkspaceNotice, readWorkspaces, reconcileArchivedWorktrees } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  const slotDir = (n) => path.join(ws, `.worktrees/backend/slot-${n}`);
  const currentBranchOf = (dir) => git('branch --show-current', dir).trim();

  // 场景1：单任务 → 主工作树，不建任何 slot
  const a = await ensureTaskWorkspaces(ws, kit, 'task-a');
  ok('单任务 → 主工作树分配（原模式）', a.assigned.length === 1 && a.assigned[0].placement === 'main' && a.refused.length === 0);
  ok('主树模式不建 slot 目录', !fs.existsSync(path.join(ws, '.worktrees')));

  // 场景2：并发第二任务 → 建 slot-1
  const b = await ensureTaskWorkspaces(ws, kit, 'task-b');
  ok('并发第二任务 → 创建 slot-1', b.assigned[0].placement === 'slot-1' && fs.existsSync(path.join(slotDir(1), 'app.txt')) && b.assigned[0].branch === 'feat/harness-task-b');
  ok('slot-1 绑定台账', readWorkspaces(ws).slots.backend['slot-1'].task === 'task-b');
  const b2 = await ensureTaskWorkspaces(ws, kit, 'task-b');
  ok('幂等：重入复用 slot-1', b2.assigned[0].reused === true && b2.assigned[0].placement === 'slot-1');

  // 场景3：B 提交改动 → 冲突前置检测 + slot-2
  fake(ws, '.worktrees/backend/slot-1/app.txt', 'v2-by-b');
  git('add .', slotDir(1));
  git('commit -m b-change', slotDir(1));
  const c = await ensureTaskWorkspaces(ws, kit, 'task-c');
  ok('三并发 → 创建 slot-2', c.assigned[0].placement === 'slot-2' && fs.existsSync(slotDir(2)));
  ok('冲突前置检测：C 检出 B 的改动文件', c.overlaps.some((o) => o.task === 'task-b' && o.files.includes('app.txt')));
  ok('notice 含 slot 红线与重叠警告', renderWorkspaceNotice(c, 'task-c').includes('slot-2') && renderWorkspaceNotice(c, 'task-c').includes('task-b'));

  // 场景4：B 归档未合入 → stale；合入后释放（切回基线、目录保留、解绑）
  const relB1 = await releaseTaskWorkspaces(ws, kit, 'task-b');
  ok('未合入 → slot-1 标 stale 保留', relB1.stale.some((s) => s.reason.includes('未合入')) && fs.existsSync(slotDir(1)) && readWorkspaces(ws).slots.backend['slot-1'].state === 'stale-unmerged');
  const d = await ensureTaskWorkspaces(ws, kit, 'task-d');
  ok('stale slot 不被新任务占用（D 落 slot-3）', d.assigned[0].placement === 'slot-3');
  git('merge feat/harness-task-b', repo);
  const relB2 = await releaseTaskWorkspaces(ws, kit, 'task-b');
  const parkedAtBase = git('rev-parse HEAD', slotDir(1)).trim() === git('rev-parse dev', repo).trim();
  ok('合入后释放：slot 停在基线提交（detached，目录保留、解绑）', relB2.released.some((r) => r.placement === 'slot-1') && fs.existsSync(slotDir(1)) && parkedAtBase && !readWorkspaces(ws).slots.backend['slot-1']);

  // 场景5：新任务 E → 复用空闲 slot-1（不新建）
  const e = await ensureTaskWorkspaces(ws, kit, 'task-e');
  ok('空闲 slot 复用（E 落 slot-1，不建 slot-4）', e.assigned.some((w) => w.placement === 'slot-1') && !fs.existsSync(slotDir(4)));

  // 场景6a：主树任务 A 未合入 → 保护性保留占用
  git('checkout -b feat/harness-task-a', repo);
  fake(ws, 'services/backend/feat-a.txt', 'a-work');
  git('add .', repo);
  git('commit -m a-work', repo);
  const relA1 = await releaseTaskWorkspaces(ws, kit, 'task-a');
  ok('主树任务未合入 → 保护性保留占用', relA1.stale.some((s) => s.reason.includes('主工作树保持占用')) && !!readWorkspaces(ws).tasks['task-a']);

  // 场景7：脏 slot 跳过并提示（不阻塞任务）
  fake(ws, '.worktrees/backend/slot-1/e-work.txt', 'e-work');
  git('add .', slotDir(1));
  git('commit -m e-work', slotDir(1));
  git('checkout dev', repo);
  git('merge feat/harness-task-e', repo);
  const relE = await releaseTaskWorkspaces(ws, kit, 'task-e');
  ok('E 合入 → slot-1 释放', relE.released.some((r) => r.placement === 'slot-1') && !readWorkspaces(ws).slots.backend['slot-1']);
  fake(ws, '.worktrees/backend/slot-1/junk.txt', 'leftover');
  const f = await ensureTaskWorkspaces(ws, kit, 'task-f');
  ok('脏 slot 跳过并提示（不阻塞，F 落新 slot）', f.notes.some((n) => n.includes('未提交改动')) && f.assigned.length > 0 && f.assigned[0].placement !== 'slot-1');

  // 场景8：主树未知占用（非台账任务的开发分支 checkout 着）→ 拒绝
  await clearTaskWorkspaces(ws, kit, 'task-a');
  git('checkout -b random-branch', repo);
  const h = await ensureTaskWorkspaces(ws, kit, 'task-h');
  ok('主树未知占用 → 拒绝给人工指引', h.refused.some((r) => r.reason.includes('非本工作区台账任务')));
  git('checkout dev', repo);
  git('branch -D random-branch', repo);

  // 场景9：主树任务合入后释放 → 切回基线、删分支、台账清
  const m = await ensureTaskWorkspaces(ws, kit, 'task-m');
  ok('主树空闲 → M 回主工作树', m.assigned[0].placement === 'main');
  git('checkout -b feat/harness-task-m', repo);
  fake(ws, 'services/backend/feat-m.txt', 'm-work');
  git('add .', repo);
  git('commit -m m-work', repo);
  git('checkout dev', repo);
  git('merge feat/harness-task-m', repo);
  git('checkout feat/harness-task-m', repo);
  const relM = await releaseTaskWorkspaces(ws, kit, 'task-m');
  ok('主树任务合入后释放：切回基线并删分支', relM.released.some((r) => r.placement === 'main') && currentBranchOf(repo) === 'dev' && !git('branch --list feat/harness-task-m', repo).includes('feat/harness-task-m') && !readWorkspaces(ws).tasks['task-m']);

  // 场景9b：归档时未合入、之后才合并并切到 test → 对账释放台账
  git('checkout dev', repo);
  await ensureTaskWorkspaces(ws, kit, 'task-r');
  git('checkout -b feat/harness-task-r', repo);
  fake(ws, 'services/backend/r-work.txt', 'r-work');
  git('add .', repo);
  git('commit -m r-work', repo);
  const relR1 = await releaseTaskWorkspaces(ws, kit, 'task-r');
  ok('归档时未合入 → 主树台账保留', relR1.stale.some((s) => s.reason.includes('主工作树保持占用')) && !!readWorkspaces(ws).tasks['task-r']);
  fs.mkdirSync(path.join(ws, '.harness/deliverables/_archive/task-r'), { recursive: true });
  git('checkout dev', repo);
  git('merge feat/harness-task-r', repo);
  git('checkout -b test dev', repo);
  const recR = await reconcileArchivedWorktrees(ws, kit);
  ok('归档后合入并切 test → 对账释放台账、不改当前分支', recR.released.some((r) => r.task === 'task-r') && !readWorkspaces(ws).tasks['task-r'] && currentBranchOf(repo) === 'test');

  // 场景9c：归档任务分支一直未合入 → 台账保留；合入后下一次对账释放
  git('checkout dev', repo);
  await ensureTaskWorkspaces(ws, kit, 'task-u');
  git('checkout -b feat/harness-task-u', repo);
  fake(ws, 'services/backend/u-work.txt', 'u-work');
  git('add .', repo);
  git('commit -m u-work', repo);
  await releaseTaskWorkspaces(ws, kit, 'task-u');
  git('checkout dev', repo);
  fs.mkdirSync(path.join(ws, '.harness/deliverables/_archive/task-u'), { recursive: true });
  const recU1 = await reconcileArchivedWorktrees(ws, kit);
  ok('归档后仍未合入 → 台账保留并标 stale', recU1.stale.some((r) => r.task === 'task-u') && !!readWorkspaces(ws).tasks['task-u']);
  git('merge feat/harness-task-u', repo);
  const recU2 = await reconcileArchivedWorktrees(ws, kit);
  ok('合入后对账 → 释放台账', recU2.released.some((r) => r.task === 'task-u') && !readWorkspaces(ws).tasks['task-u']);

  // 场景9d：任务分支已合入但主树脏 → 不释放，避免把未提交改动切走
  git('checkout dev', repo);
  await ensureTaskWorkspaces(ws, kit, 'task-dirty');
  git('checkout -b feat/harness-task-dirty', repo);
  fake(ws, 'services/backend/dirty-work.txt', 'dirty-work');
  git('add .', repo);
  git('commit -m dirty-work', repo);
  git('checkout dev', repo);
  git('merge feat/harness-task-dirty', repo);
  git('checkout feat/harness-task-dirty', repo);
  fake(ws, 'services/backend/uncommitted.txt', 'keep-me');
  fs.mkdirSync(path.join(ws, '.harness/deliverables/_archive/task-dirty'), { recursive: true });
  const recD = await reconcileArchivedWorktrees(ws, kit);
  ok('已合入但主树脏 → 保留台账并标 stale', recD.stale.some((r) => r.task === 'task-dirty' && r.reason.includes('未提交改动')) && !!readWorkspaces(ws).tasks['task-dirty']);
  fs.unlinkSync(path.join(repo, 'uncommitted.txt'));
  git('checkout dev', repo);
  const recD2 = await reconcileArchivedWorktrees(ws, kit);
  ok('清理脏改动后对账 → 释放', recD2.released.some((r) => r.task === 'task-dirty') && !readWorkspaces(ws).tasks['task-dirty']);

  // 场景10：clearTaskWorkspaces 清残留（不阻塞）
  ok('clearTaskWorkspaces 幂等（无绑定）', (await clearTaskWorkspaces(ws, kit, 'task-none')).cleared === 0);
  const clrF = await clearTaskWorkspaces(ws, kit, 'task-f');
  ok('clearTaskWorkspaces 释放绑定', clrF.cleared >= 1 && !readWorkspaces(ws).tasks['task-f']);

  // 场景11：非 git 仓 → 退回主工作树原模式
  const ws2 = mkws();
  cleanups.push(ws2);
  fake(ws2, 'services/backend/.git/HEAD', 'ref: refs/heads/dev');
  const kit2 = { sources: [{ name: 'backend', path: 'services/backend' }] };
  const ng = await ensureTaskWorkspaces(ws2, kit2, 't');
  ok('非 git 仓 → 主工作树原模式（不拒绝）', ng.assigned[0].placement === 'main' && ng.refused.length === 0);
  ok('非 git 仓 notice 标注', renderWorkspaceNotice(ng, 't').includes('非 git 仓'));

  // 场景12（2026-11-14 人工裁决补充）：脏基线是决策点，--slot 是用户裁决的表达方式
  const ws3 = mkws();
  cleanups.push(ws3);
  const repo3 = path.join(ws3, 'services/backend');
  fs.mkdirSync(repo3, { recursive: true });
  git('init -b dev', repo3);
  fake(ws3, 'services/backend/app.txt', 'v1');
  git('add .', repo3);
  git('commit -m init', repo3);
  fake(ws3, 'services/backend/dirty.txt', '手工改动未提交');
  const kit3 = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  const refused = await ensureTaskWorkspaces(ws3, kit3, 'task-r1');
  ok('脏基线 → 拒绝并给决策提示（含 --slot）', refused.refused.length === 1 && refused.assigned.length === 0 && refused.refused[0].reason.includes('未提交改动') && refused.refused[0].reason.includes('--slot'));
  const forced = await ensureTaskWorkspaces(ws3, kit3, 'task-r1', { forceSlot: true });
  ok('--slot 裁决 → 隔离 slot 开发（不碰脏主树）', forced.assigned[0].placement.startsWith('slot-') && forced.refused.length === 0);
  ok('本机状态本地化：.gitignore 排除 local/', fs.readFileSync(path.join(ws3, '.harness/.gitignore'), 'utf8').split('\n').some((l) => l.trim() === 'local/'));
  // 场景13：主树空闲时 --slot 也强制进 slot（用户主动隔离）
  const ws4 = mkws();
  cleanups.push(ws4);
  const repo4 = path.join(ws4, 'services/backend');
  fs.mkdirSync(repo4, { recursive: true });
  git('init -b dev', repo4);
  fake(ws4, 'services/backend/app.txt', 'v1');
  git('add .', repo4);
  git('commit -m init', repo4);
  const forcedFree = await ensureTaskWorkspaces(ws4, { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] }, 'task-r2', { forceSlot: true });
  ok('主树空闲 + --slot → 也进 slot（主动隔离）', forcedFree.assigned[0].placement === 'slot-1');
}

// ---------------------------------------------------------------- slot 本地配置
section('slot 本地配置复制');
{
  const { discoverSource, writeLocalFiles, readLocalFiles } = await import(path.join(bundleRoot, 'kernel/local-files.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/.gitignore', 'target/\napplication-local.properties\ndbcp-local.properties\nconfig/local.yml\n');
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  fake(ws, 'services/backend/application-local.properties', 'local');
  fake(ws, 'services/backend/dbcp-local.properties', 'dbcp');
  fake(ws, 'services/backend/config/local.yml', 'local: true');
  fake(ws, 'services/backend/target/classes/application-local.properties', 'build-output');
  fake(ws, 'services/backend/notes.txt', 'not-config');
  const source = { name: 'backend', path: 'services/backend' };
  const found = await discoverSource(ws, source);
  ok('发现 ignored 本地配置候选', found.some((f) => f.path === 'application-local.properties') && found.some((f) => f.path === 'dbcp-local.properties') && found.some((f) => f.path === 'config/local.yml'));
  ok('过滤 build/target 与非配置文本', !found.some((f) => f.path.includes('target/')) && !found.some((f) => f.path === 'notes.txt'));
  writeLocalFiles(ws, { sources: { backend: { approved: ['application-local.properties'] } } });
  const slot = path.join(ws, '.worktrees/backend/slot-1');
  const notes = await (await import(path.join(bundleRoot, 'kernel/local-files.js'))).provisionLocalFiles(ws, source, slot);
  ok('确认项复制、未确认项只提示', fs.readFileSync(path.join(slot, 'application-local.properties'), 'utf8') === 'local' && !fs.existsSync(path.join(slot, 'dbcp-local.properties')) && notes.some((n) => n.includes('本机配置文件')));
  ok('manifest 落本机 local/local-files.json', fs.existsSync(path.join(ws, '.harness/local/local-files.json')) && readLocalFiles(ws).sources.backend.approved.includes('application-local.properties'));
}
{
  const { ensureTaskWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  fake(ws, 'services/backend/application-local.properties', 'local-config');
  fake(ws, 'services/backend/dbcp-local.properties', 'dbcp-config');
  const kit = { sources: [{
    name: 'backend', path: 'services/backend', branch: 'dev',
    localFiles: ['application-local.properties', 'dbcp-local.properties'],
  }] };
  const r = await ensureTaskWorkspaces(ws, kit, 'local-task', { forceSlot: true });
  const slot = path.join(ws, '.worktrees/backend/slot-1');
  ok('slot 自动复制 ignored 本地配置', r.assigned[0]?.placement === 'slot-1'
    && fs.readFileSync(path.join(slot, 'application-local.properties'), 'utf8') === 'local-config'
    && fs.readFileSync(path.join(slot, 'dbcp-local.properties'), 'utf8') === 'dbcp-config');
  fs.writeFileSync(path.join(slot, 'application-local.properties'), 'slot-local', 'utf8');
  await ensureTaskWorkspaces(ws, kit, 'local-task', { forceSlot: true });
  ok('slot 复用不覆盖已有本地配置', fs.readFileSync(path.join(slot, 'application-local.properties'), 'utf8') === 'slot-local');
}
{
  // 选了开发基线 + 干净主树在注册基线：apply 分配时应从所选基线切任务分支，而不是卡在 dev 裁决点
  const { ensureTaskWorkspaces, renderWorkspaceNotice, clearTaskWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  git('checkout -b feature/x', repo);
  fake(ws, 'services/backend/feat.txt', 'feature');
  git('add .', repo);
  git('commit -m feature', repo);
  const featSha = git('rev-parse feature/x', repo).trim();
  git('checkout dev', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  fake(ws, '.harness/deliverables/task-base/analysis-base.json', JSON.stringify({ backend: 'feature/x' }));
  const r = await ensureTaskWorkspaces(ws, kit, 'task-base');
  ok('选了开发基线 + 主树在 dev → 自动切任务分支', r.assigned[0]?.placement === 'main' && git('branch --show-current', repo).trim() === 'feat/harness-task-base');
  ok('任务分支从所选基线创建', git('rev-parse HEAD', repo).trim() === featSha && fs.existsSync(path.join(repo, 'feat.txt')));
  ok('分配摘要标注已切好并给出提示', r.assigned[0]?.ready === true && r.notes.some((n) => n.includes('切到任务分支')) && renderWorkspaceNotice(r, 'task-base').includes('内核已切好'));
  let upstream = null;
  try { upstream = git('rev-parse --abbrev-ref "feat/harness-task-base@{upstream}"', repo).trim(); } catch { /* no upstream */ }
  ok('任务分支不跟踪所选基线（防误 push）', !upstream);
  // 主树在外来分支时仍拒绝，不静默切别人的分支（先清掉主树 ledger 占用，模拟无台账占用的外来分支）
  await clearTaskWorkspaces(ws, kit, 'task-base');
  git('checkout dev', repo);
  git('checkout -b random', repo);
  const r2 = await ensureTaskWorkspaces(ws, kit, 'task-foreign');
  ok('主树在外来分支 → 仍拒绝并给 --slot', r2.refused.length === 1 && r2.refused[0].reason.includes('非本工作区台账任务') && r2.refused[0].reason.includes('--slot'));
  git('checkout dev', repo);
}
{
  // M2 面板透出：workspaceState 行内工作区分配 + slot 池概览 + stale 注意力项
  const { workspaceState, attentionItems } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const { ensureTaskWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] }));
  fake(ws, '.harness/tasks/board.md', '# 任务看板\n\n| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |\n|---|---|---|---|---|---|---|\n| tk-a | IN_PROGRESS | standard | — | — | 2026-11-15 | — |\n');
  await ensureTaskWorkspaces(ws, JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8')), 'tk-a');
  const st = workspaceState(ws);
  ok('workspaceState 行透出工作区分配', st.tasks[0].workspace?.backend?.placement === 'main' && st.tasks[0].workspace?.backend?.branch === 'feat/harness-tk-a');
  ok('workspaceState slot 池概览字段存在', st.slots && typeof st.slots === 'object');
  // stale slot → 注意力 warn（纯函数）
  const items = attentionItems([], null, [], [{ repo: 'backend', slot: 'slot-1', task: 'tk-x', branch: 'feat/harness-tk-x' }]);
  ok('stale slot 入注意力（warn+释放指引）', items.some((i) => i.kind === 'workspace-stale' && i.level === 'warn' && i.text.includes('slot-1') && i.text.includes('hk-archive')));
}

// ---------------------------------------------------------------- TE 环境串行租约
section('TE 环境串行排队（租约）');
{
  const { readTestEnv, acquireTestEnv, releaseTestEnv, reconcileTestEnv } = await import(path.join(bundleRoot, 'kernel/te.js'));
  const { attentionItems } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [] }));
  const rows = (chains) => Object.entries(chains).map(([task, apply]) => ({ task, status: 'IN_PROGRESS', apply }));
  // 授权/自持/排队
  const a1 = acquireTestEnv(ws, 't-a');
  ok('空闲 acquire → 授权', a1.granted === true && readTestEnv(ws).holder === 't-a');
  const a2 = acquireTestEnv(ws, 't-a');
  ok('自持 acquire → 提示已持有', a2.granted === true && a2.queued === false);
  const a3 = acquireTestEnv(ws, 't-b');
  ok('他持 acquire → 排队（带位次与暂停指引）', a3.granted === false && a3.queued === true && a3.position === 1 && a3.text.includes('不要派发 TE Worker'));
  acquireTestEnv(ws, 't-c');
  ok('排队去重不重复入队', readTestEnv(ws).queue.join(',') === 't-b,t-c');
  // 释放与晋升
  const r1 = releaseTestEnv(ws, 't-b');
  ok('排队任务 release = 退队', r1.text.includes('退出 TE 排队') && readTestEnv(ws).queue.join(',') === 't-c');
  const r2 = releaseTestEnv(ws, 't-a');
  ok('持有者 release → 空闲', r2.released === true && readTestEnv(ws).holder === null);
  // 对账：holder 越过 TE → 自动释放 + 晋升队首
  acquireTestEnv(ws, 't-a');
  acquireTestEnv(ws, 't-b');
  const rc1 = reconcileTestEnv(ws, rows({ 't-a': 'R1：Dev✅ CR✅ TE✅ 验证…', 't-b': 'R1：Dev✅ CR✅ TE▶ 验证…' }));
  ok('holder TE✅ → 自动释放并晋升队首', rc1.released.join(',') === 't-a' && rc1.promoted === 't-b' && readTestEnv(ws).holder === 't-b');
  // 对账：排队任务自己越过 TE → 自动出队（无晋升）
  acquireTestEnv(ws, 't-a');
  const rc2 = reconcileTestEnv(ws, rows({ 't-b': 'R1：Dev✅ CR✅ TE▶ 验证…', 't-a': 'R1：Dev✅ CR✅ TE— 验证…' }));
  ok('排队任务 TE—（跳过）→ 出队不占晋升', rc2.promoted === null && readTestEnv(ws).queue.length === 0 && readTestEnv(ws).holder === 't-b');
  // 对账：holder 链还没写 TE▶（先 acquire 后写板宽限）→ 不释放
  const rc3 = reconcileTestEnv(ws, rows({ 't-b': 'R1：Dev✅ CR… TE… 验证…' }));
  ok('holder 未到 TE 阶段（宽限）→ 保持持有', rc3.released.length === 0 && readTestEnv(ws).holder === 't-b');
  // 对账：任务归档 → 释放
  const rc4 = reconcileTestEnv(ws, rows({ 't-b': 'R1：Dev✅ CR✅ TE✅ 验证✅', 't-b2': 'x' }) .map((r) => r.task === 't-b' ? { ...r, status: 'DONE' } : r));
  ok('任务 DONE → 释放', rc4.released.join(',') === 't-b' && readTestEnv(ws).holder === null);
  // 命令入口
  const st = await run('hk-te', 'status', ws);
  ok('/hk-te status 空闲文案', st.kind === 'success' && st.text.includes('空闲'));
  const acq = await run('hk-te', 'acquire t-z', ws);
  ok('/hk-te acquire 授权', acq.kind === 'success' && acq.text.includes('已授权'));
  // 台账本地化排除
  ok('test-env.json 进 .gitignore（本机状态）', fs.readFileSync(path.join(ws, '.harness/.gitignore'), 'utf8').split('\n').some((l) => l.trim() === 'local/'));
  // 注意力：有排队时提示
  acquireTestEnv(ws, 't-y');
  const items2 = attentionItems([], null, [], [], readTestEnv(ws));
  ok('TE 排队入注意力（warn，含持有者+队列）', items2.some((i) => i.kind === 'te-queued' && i.level === 'warn' && i.text.includes('t-z') && i.text.includes('t-y')));
  // workspaceState 行透出 teHolder
  fake(ws, '.harness/tasks/board.md', '# 任务看板\n\n| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |\n|---|---|---|---|---|---|---|\n| t-z | IN_PROGRESS | standard | — | — | 2026-11-15 | — |\n');
  const { workspaceState } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const st2 = workspaceState(ws);
  ok('workspaceState 行透出 teHolder', st2.tasks[0].teHolder === true && st2.te?.holder === 't-z');
}

// ---------------------------------------------------------------- 基线分析镜像
section('基线分析镜像（设计期只读）');
{
  const { ensureBaselineMirrors, renderAnalysisNotice, ensureTaskWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const currentBranchOf = (dir) => git('branch --show-current', dir).trim();
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  const m1 = await ensureBaselineMirrors(ws, kit);
  const mirror = path.join(ws, '.worktrees/backend/_baseline');
  ok('镜像创建：detached 在基线提交且含工作区文件', m1.created.length === 1 && fs.existsSync(path.join(mirror, 'app.txt')) && (await currentBranchOf(mirror)) === '');
  ok('镜像清单含基线与 sha', m1.mirrors[0].base === 'dev' && !!m1.mirrors[0].sha);
  const m2 = await ensureBaselineMirrors(ws, kit);
  ok('幂等：干净且基线未前进 → 复用', m2.reused.length === 1 && m2.updated.length === 0);
  // 基线前进 → 镜像跟随
  fake(ws, 'services/backend/app2.txt', 'v2');
  git('add .', repo);
  git('commit -m advance', repo);
  const m3 = await ensureBaselineMirrors(ws, kit);
  ok('基线前进 → 镜像跟随更新', m3.updated.length === 1 && fs.existsSync(path.join(mirror, 'app2.txt')));
  // 脏镜像 → 不切换，提示人工
  fake(ws, '.worktrees/backend/_baseline/junk.txt', 'x');
  const m4 = await ensureBaselineMirrors(ws, kit);
  ok('脏镜像 → 提示人工不切换', m4.notes.some((n) => n.includes('未提交改动')));
  ok('notice 含只读红线与镜像路径', (() => {
    fs.rmSync(path.join(mirror, 'junk.txt'));
    const n = renderAnalysisNotice(m3);
    return n.includes('只读') && n.includes('_baseline') && n.includes('基线分支');
  })());
  // 镜像不占 slot：主树被占后新任务仍从 slot-1 开始
  await ensureTaskWorkspaces(ws, kit, 'task-a');           // 主树
  git('checkout -b feat/other', repo);                      // 主树被"别人"占用
  await ensureTaskWorkspaces(ws, kit, 'task-b');            // slot-1
  await ensureTaskWorkspaces(ws, kit, 'task-c');            // slot-2（_baseline 不得被当成 slot 复用/计数干扰）
  ok('_baseline 不参与 slot 分配（task-c 落 slot-2 而非复用镜像）', fs.existsSync(path.join(ws, '.worktrees/backend/slot-2')));
  // propose 端到端：剧本注入镜像节
  const ws2 = mkws();
  cleanups.push(ws2);
  const repo2 = path.join(ws2, 'services/backend');
  fs.mkdirSync(repo2, { recursive: true });
  git('init -b dev', repo2);
  fake(ws2, 'services/backend/app.txt', 'v1');
  git('add .', repo2);
  git('commit -m init', repo2);
  await run('hk-init', '', ws2);
  const steered = [];
  await run('hk-new', 'mir-e2e 镜像集成', ws2, steered);
  const pp = path.join(ws2, '.harness/deliverables/mir-e2e/proposal.md');
  fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  await run('hk-propose', 'mir-e2e', ws2, steered);
  const prompt = steered[steered.length - 1];
  ok('propose 剧本含只读分析镜像节（路径+基线+红线）', prompt.includes('源码分析基线') && prompt.includes('_baseline') && prompt.includes('禁止修改'));
}

// ---------------------------------------------------------------- 任务专属分析基点（--base）
section('任务专属分析基点（--base 按仓指定）');
{
  const { ensureTaskAnalysisWorktrees, removeTaskAnalysisWorktrees, parseBaseSpec } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  // 旗标解析
  ok('parseBaseSpec 多仓解析', (() => {
    const s = parseBaseSpec('backend:release/1.2, frontend:dev');
    return s.backend === 'release/1.2' && s.frontend === 'dev';
  })());
  ok('parseBaseSpec 坏段忽略', JSON.stringify(parseBaseSpec('bad,nocolon,x:')) === JSON.stringify({}));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  git('checkout -b release/1.2', repo);
  fake(ws, 'services/backend/rel.txt', 'rel-only');
  git('add .', repo);
  git('commit -m rel', repo);
  git('checkout dev', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  const t1 = await ensureTaskAnalysisWorktrees(ws, kit, 'task-x', { backend: 'release/1.2' });
  const dir = path.join(ws, '.worktrees/backend/_task-task-x');
  ok('--base 建任务专属工作区且停在指定分支内容', t1.created.length === 1 && fs.existsSync(path.join(dir, 'rel.txt')) && t1.worktrees[0].branch === 'release/1.2');
  ok('spec 落盘（重跑幂等重建）', fs.existsSync(path.join(ws, '.harness/deliverables/task-x/analysis-base.json')));
  const t2 = await ensureTaskAnalysisWorktrees(ws, kit, 'task-x', null);
  ok('重跑不传 --base → 按落盘 spec 复用', t2.reused.length === 1 && t2.created.length === 0);
  // 换基点 → 任务独占直接切换（无需锁）
  const t3 = await ensureTaskAnalysisWorktrees(ws, kit, 'task-x', { backend: 'dev' });
  ok('改 --base → 任务独占工作区直接切换', t3.switched.length === 1 && !fs.existsSync(path.join(dir, 'rel.txt')) && fs.existsSync(path.join(dir, 'app.txt')));
  // 分支不存在 → 提示
  const t4 = await ensureTaskAnalysisWorktrees(ws, kit, 'task-y', { backend: 'no-such-branch' });
  ok('分支不存在 → 提示且不建目录', t4.notes.some((n) => n.includes('不存在')) && !fs.existsSync(path.join(ws, '.worktrees/backend/_task-task-y')));
  // 回收
  const rm = await removeTaskAnalysisWorktrees(ws, kit, 'task-x');
  ok('归档回收任务分析工作区', rm.removed === 1 && !fs.existsSync(dir));
  // 远端分支回退（origin/<branch>）
  const remote = mkws();
  cleanups.push(remote);
  git('init -q --bare r.git', remote);
  git(`clone -q ${path.join(remote, 'r.git')} seed`, remote);
  fake(remote, 'seed/f.txt', 'x');
  git('add -A && git commit -qm i && git push -q origin HEAD:main', path.join(remote, 'seed'));
  git('checkout -b topic', path.join(remote, 'seed'));
  fake(remote, 'seed/topic.txt', 't');
  git('add -A && git commit -qm t && git push -q origin topic', path.join(remote, 'seed'));
  git(`remote add origin ${path.join(remote, 'r.git')}`, repo);
  git('fetch -q origin', repo);
  const ws2 = mkws();
  cleanups.push(ws2);
  fs.mkdirSync(path.join(ws2, 'services/backend'), { recursive: true });
  fs.cpSync(repo, path.join(ws2, 'services/backend'), { recursive: true });
  const t5 = await ensureTaskAnalysisWorktrees(ws2, { sources: [{ name: 'backend', path: 'services/backend' }] }, 'task-z', { backend: 'topic' });
  ok('仅远端分支（origin/<branch>）也可用', t5.worktrees[0]?.branch === 'topic' && fs.existsSync(path.join(ws2, '.worktrees/backend/_task-task-z/topic.txt')));
  // e2e：hk-propose --base 注入剧本
  const ws3 = mkws();
  cleanups.push(ws3);
  const repo3 = path.join(ws3, 'services/backend');
  fs.mkdirSync(repo3, { recursive: true });
  git('init -b dev', repo3);
  fake(ws3, 'services/backend/app.txt', 'v1');
  git('add .', repo3);
  git('commit -m init', repo3);
  git('branch release/1.2', repo3);
  await run('hk-init', '', ws3);
  const steered = [];
  await run('hk-new', 'base-e2e 专属基点', ws3, steered);
  const pp = path.join(ws3, '.harness/deliverables/base-e2e/proposal.md');
  fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  await run('hk-propose', 'base-e2e --base backend:release/1.2', ws3, steered);
  const prompt = steered[steered.length - 1];
  ok('propose --base 剧本含专属分析区（路径+指定分支）', prompt.includes('专属') && prompt.includes('_task-base-e2e') && prompt.includes('release/1.2'));
}
{
  // 面板新建任务：分支清单 + /hk-new --base（立项即建分析区，propose 幂等复用）
  const { listGitBranches, listAllGitBranches } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  git('checkout -b release/1.2', repo);
  git('checkout dev', repo);
  const branches = await listGitBranches(ws, { name: 'backend', path: 'services/backend' });
  ok('分支清单含本地分支', branches.includes('dev') && branches.includes('release/1.2'));
  const all = await listAllGitBranches(ws, { sources: [{ name: 'backend', path: 'services/backend' }] });
  ok('全仓分支清单按键归仓', Array.isArray(all.backend) && all.backend.length === branches.length);  // /hk-new --base：spec 落盘 + 立即建分析区 + 返回文本提示
  await run('hk-init', '', ws);
  const r = await run('hk-new', 'ui-task 面板选分支 --base backend:release/1.2', ws, []);
  ok('hk-new --base 返回分析基点摘要', r.kind === 'success' && r.text.includes('release/1.2') && r.text.includes('分析基点'));
  ok('hk-new --base 立项即建任务专属分析区', fs.existsSync(path.join(ws, '.worktrees/backend/_task-ui-task')));
  ok('spec 落盘供 propose 幂等复用', JSON.parse(fs.readFileSync(path.join(ws, '.harness/deliverables/ui-task/analysis-base.json'), 'utf8')).backend === 'release/1.2');
  // propose 不带 --base → 复用落盘 spec（不重建不切换）
  const pp = path.join(ws, '.harness/deliverables/ui-task/proposal.md');
  fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  const steered = [];
  await run('hk-propose', 'ui-task', ws, steered);
  ok('propose 复用落盘 spec：专属分析区进剧本', steered[steered.length - 1].includes('_task-ui-task') && steered[steered.length - 1].includes('release/1.2'));
}

// ---------------------------------------------------------------- 台账前在途任务（真实场景回填）
section('台账前在途任务占用：自动 slot + 台账回填');
{
  const { ensureTaskWorkspaces, releaseTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const currentBranchOf = (dir) => git('branch --show-current', dir).trim();
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  // 模拟台账机制前的在途任务：主树 checkout feat/harness-legacy，台账无记录，看板有行
  git('checkout -b feat/harness-legacy', repo);
  fake(ws, 'services/backend/legacy.txt', 'legacy-work');
  git('add .', repo);
  git('commit -m legacy', repo);
  fake(ws, '.harness/tasks/board.md', '# 任务看板\n\n| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |\n|---|---|---|---|---|---|---|\n| legacy | IN_PROGRESS | standard | — | feat/harness-legacy (backend) | 2026-11-16 | — |\n');
  const r = await ensureTaskWorkspaces(ws, kit, 'new-task');
  ok('harness 分支占用（台账无记录）→ 自动 slot 不拒绝', r.assigned[0].placement === 'slot-1' && r.refused.length === 0);
  ok('占用者台账回填（后续归档可正确释放主树）', readWorkspaces(ws).tasks['legacy']?.repos?.backend?.placement === 'main');
  // legacy 合入后归档 → 主树正确释放
  git('checkout dev', repo);
  git('merge feat/harness-legacy', repo);
  git('checkout feat/harness-legacy', repo);
  const rel = await releaseTaskWorkspaces(ws, kit, 'legacy');
  ok('回填任务归档 → 主树切回基线、删分支、清台账', rel.released.some((x) => x.placement === 'main') && currentBranchOf(repo) === 'dev' && !git('branch --list feat/harness-legacy', repo).includes('feat/harness-legacy') && !readWorkspaces(ws).tasks['legacy']);
  // 外来分支 → 仍拒绝（决策点保留）
  git('checkout -b some-random-branch', repo);
  const r2 = await ensureTaskWorkspaces(ws, kit, 'another-task');
  ok('外来分支仍拒绝（人决策点保留）', r2.refused.length === 1 && r2.refused[0].reason.includes('--slot') && r2.assigned.length === 0);
  git('checkout dev', repo);
  git('branch -D some-random-branch', repo);
  // 看板外的 harness 分支 → 自动 slot 但不回填台账
  git('checkout -b feat/harness-ghost', repo);
  const r3 = await ensureTaskWorkspaces(ws, kit, 'third-task');
  ok('看板外 harness 分支 → slot 但不回填', r3.assigned.length === 1 && r3.refused.length === 0 && !readWorkspaces(ws).tasks['ghost']);
}

// ---------------------------------------------------------------- 结构化决策点（B+C）
section('结构化决策点（外来占用 → 可点选项 + 引擎停重试）');
{
  const { readDecisions, recordDecision, clearDecision, describeMainWorktree } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const { attentionItems } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  // 决策点台账读写
  const ws0 = mkws();
  cleanups.push(ws0);
  fake(ws0, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [] }));
  recordDecision(ws0, 't1', { code: 'workspace-foreign', text: 'x', options: [{ label: 'a', line: '/hk-apply t1 --slot' }] });
  ok('决策点记录/读取', readDecisions(ws0).t1?.code === 'workspace-foreign' && readDecisions(ws0).t1.options.length === 1);
  ok('决策点台账本机化（gitignore）', fs.readFileSync(path.join(ws0, '.harness/.gitignore'), 'utf8').split('\n').some((l) => l.trim() === 'local/'));
  clearDecision(ws0, 't1');
  ok('决策点清除', readDecisions(ws0).t1 === undefined);
  // hk-apply 外来分支 → 结构化 decision（含现场详情与选项）
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  await run('hk-init', '', ws);
  const steered = [];
  await run('hk-new', 'dec-task 决策点测试', ws, steered);
  const pp = path.join(ws, '.harness/deliverables/dec-task/proposal.md');
  fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  await run('hk-propose', 'dec-task', ws, steered);
  fs.appendFileSync(pp, '\n\n审批 1：通过（2026-11-16）\n');
  fake(ws, '.harness/deliverables/dec-task/readiness-report.md', '# R\n\n## 结论\nPASS\n');
  git('checkout -b foreign-branch', repo);
  fake(ws, 'services/backend/mystery.txt', '???');
  git('add .', repo);
  git('commit -m mystery', repo);
  const r = await run('hk-apply', 'dec-task', ws, steered);
  ok('外来分支 → kind=decision + code', r.kind === 'decision' && r.code === 'workspace-foreign');
  ok('决策文本含主树现场（分支+工作区状态）', r.text.includes('foreign-branch') && r.text.includes('工作区干净'));
  ok('选项含 --slot 重跑行', r.options?.some((o) => o.line === '/hk-apply dec-task --slot'));
  ok('决策点落盘（注意力/引擎可见）', readDecisions(ws)['dec-task']?.code === 'workspace-foreign');
  // 注意力项渲染数据
  const items = attentionItems([], null, [], [], null, readDecisions(ws));
  ok('决策点入注意力（block+options+jump）', items.some((i) => i.kind === 'workspace-decision' && i.level === 'block' && i.options.length === 2 && i.jump === true));
  // describeMainWorktree 详情
  const detail = await describeMainWorktree(ws, { name: 'backend', path: 'services/backend' });
  ok('主树现场详情含分支与状态行', detail.includes('foreign-branch'));
  // 裁决后重跑成功 → 决策点清除
  git('checkout dev', repo);
  git('branch -D foreign-branch', repo);
  const r2 = await run('hk-apply', 'dec-task', ws, steered);
  ok('裁决后重跑成功并清决策点', r2.kind === 'success' && readDecisions(ws)['dec-task'] === undefined);
}
{
  // 已归档任务的槽位收尾（2026-11-17）：文档已归档、活目录已清，但 slot 因分支未合入保留——
  // 注意力条提示「MR 合入后重跑 /hk-archive 释放槽位」，重跑必须能走"只释放工作区"的收尾模式
  const { ensureTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  await run('hk-init', '', ws);
  // 造两个任务：A 占主树 → B 落 slot-1（模拟 phm 场景）；只归档 B 的文档（stale 槽位保留）
  const kit = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
  kit.worktree = { autoClose: false };
  fs.writeFileSync(path.join(ws, '.harness/kit.json'), JSON.stringify(kit, null, 2) + '\n');
  await ensureTaskWorkspaces(ws, kit, 'task-a');
  await ensureTaskWorkspaces(ws, kit, 'task-b');
  ok('前置：B 落 slot-1', readWorkspaces(ws).tasks['task-b']?.repos?.backend?.placement === 'slot-1');
  // slot 分支上先有未合入的提交（真实场景：分支已开发完、MR 未合）
  fake(ws, '.worktrees/backend/slot-1/work.txt', 'b-work');
  git('add .', path.join(ws, '.worktrees/backend/slot-1'));
  git('commit -m b-work', path.join(ws, '.worktrees/backend/slot-1'));
  fake(ws, '.harness/deliverables/task-b/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws, '.harness/deliverables/task-b/test-report.md', '# t\n\n## 结论\nPASS\n');
  const arch1 = await run('hk-archive', 'task-b', ws);
  ok('归档后槽位未合入 → stale 保留', arch1.kind === 'success' && !!readWorkspaces(ws).tasks['task-b']);
  ok('活目录已清（文档归档完成）', !fs.existsSync(path.join(ws, '.harness/deliverables/task-b')));
  // 重跑 = 收尾模式：分支未合入 → 报错提示，不因"活目录不存在"崩
  const again1 = await run('hk-archive', 'task-b', ws);
  ok('已归档任务重跑 → 收尾模式（未合入给提示）', again1.kind === 'error' && again1.text.includes('已归档') && again1.text.includes('未合入'));
  // MR 合入后重跑 → 释放 slot，台账清空
  git('merge feat/harness-task-b', repo);
  const again2 = await run('hk-archive', 'task-b', ws);
  ok('合入后重跑 → 槽位释放并清台账', again2.kind === 'success' && again2.text.includes('已收尾') && !readWorkspaces(ws).tasks['task-b']);
}
{
  // 目标基线 = 创建时指定的基线（--base），不是默认基线（2026-11-17）
  const { ensureTaskWorkspaces, releaseTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  // release/1.2 分支上有独占提交（与 dev 分叉）
  git('checkout -b release/1.2', repo);
  fake(ws, 'services/backend/rel.txt', 'rel-only');
  git('add .', repo);
  git('commit -m rel', repo);
  git('checkout dev', repo);
  const kit = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  await ensureTaskWorkspaces(ws, kit, 'task-a'); // 主树被占 → task-r 落 slot-1
  // 任务创建时指定 backend:release/1.2（hk-new --base 的落盘形态）
  fake(ws, '.harness/deliverables/task-r/analysis-base.json', JSON.stringify({ backend: 'release/1.2' }));
  const r = await ensureTaskWorkspaces(ws, kit, 'task-r');
  const wt = path.join(ws, '.worktrees/backend/slot-1');
  ok('指定基线优先：开发分支从 release/1.2 拉（含 rel-only）', r.assigned[0].base === 'release/1.2' && fs.existsSync(path.join(wt, 'rel.txt')));
  ok('台账记录指定基线为合入目标', readWorkspaces(ws).tasks['task-r']?.repos?.backend?.base === 'release/1.2');
  // 分支提交后：未合入 → stale；合入指定基线 release/1.2 → 释放
  fake(ws, '.worktrees/backend/slot-1/w.txt', 'work');
  git('add .', wt);
  git('commit -m work', wt);
  const rel1 = await releaseTaskWorkspaces(ws, kit, 'task-r');
  ok('未合入任何基线 → 保留并提示', rel1.stale.some((s) => s.reason.includes('未合入')) && rel1.released.length === 0);
  git('checkout release/1.2', repo);
  git('merge feat/harness-task-r', repo);
  git('checkout dev', repo);
  const rel2 = await releaseTaskWorkspaces(ws, kit, 'task-r');
  ok('合入指定基线 release/1.2 → 正常释放', rel2.released.some((x) => x.placement === 'slot-1') && !readWorkspaces(ws).tasks['task-r']);
}
{
  // 基线中途变更（2026-11-17 phm 事故）：任务按 dev 分配，人把 kit 基线改成新分支且代码已推到那里
  // → 归档合入检测必须认「当前基线」，否则永远误报未合入
  const { ensureTaskWorkspaces, releaseTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  const kitDev = { sources: [{ name: 'backend', path: 'services/backend', branch: 'dev' }] };
  await ensureTaskWorkspaces(ws, kitDev, 'task-a');       // 主树
  await ensureTaskWorkspaces(ws, kitDev, 'task-x');       // slot-1，台账 base=dev
  fake(ws, '.worktrees/backend/slot-1/feat.txt', 'phm-work');
  git('add .', path.join(ws, '.worktrees/backend/slot-1'));
  git('commit -m phm', path.join(ws, '.worktrees/backend/slot-1'));
  // 人改基线到新分支，并把新分支指向任务分支 tip（等价于"已合入"）
  const kitNew = { sources: [{ name: 'backend', path: 'services/backend', branch: 'feat_phm' }] };
  git('branch feat_phm feat/harness-task-x', repo);
  const rel = await releaseTaskWorkspaces(ws, kitNew, 'task-x');
  ok('基线中途变更 → 按当前基线判定已合入并释放', rel.released.some((x) => x.source === 'backend' && x.note.includes('feat_phm')) && !readWorkspaces(ws).tasks['task-x']);
  ok('槽位目录保留（可复用）', fs.existsSync(path.join(ws, '.worktrees/backend/slot-1')));
}
{
  // --merge：人显式确认后本地合入目标基线（不推送），再释放槽位（B 方案，2026-11-17）
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/app.txt', 'v1');
  git('add .', repo);
  git('commit -m init', repo);
  await run('hk-init', '', ws);
  const kit = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
  kit.worktree = { autoClose: false };
  fs.writeFileSync(path.join(ws, '.harness/kit.json'), JSON.stringify(kit, null, 2) + '\n');
  const { ensureTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  await ensureTaskWorkspaces(ws, kit, 'task-m1'); // 主树
  await ensureTaskWorkspaces(ws, kit, 'task-m2'); // slot-1
  // slot 分支上开发出未合入提交
  fake(ws, '.worktrees/backend/slot-1/feat.txt', 'm2-work');
  git('add .', path.join(ws, '.worktrees/backend/slot-1'));
  git('commit -m m2', path.join(ws, '.worktrees/backend/slot-1'));
  fake(ws, '.harness/deliverables/task-m2/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws, '.harness/deliverables/task-m2/test-report.md', '# t\n\n## 结论\nPASS\n');
  // 不带 --merge：归档成功但槽位保留，给确认指令
  const a1 = await run('hk-archive', 'task-m2', ws);
  ok('未确认合入 → 槽位保留并提示 --merge', a1.kind === 'success' && a1.text.includes('--merge') && !!readWorkspaces(ws).tasks['task-m2']);
  // --merge 确认：本地合入 dev → 释放槽位
  const a2 = await run('hk-archive', 'task-m2', ws);
  ok('收尾模式未确认 → 报错并给 --merge 指引', a2.kind === 'error' && a2.text.includes('--merge'));
  const a3 = await run('hk-archive', 'task-m2 --merge', ws);
  ok('--merge 本地合入并释放槽位', a3.kind === 'success' && a3.text.includes('已本地合入') && a3.text.includes('未推送') && !readWorkspaces(ws).tasks['task-m2']);
  ok('目标基线 dev 已含合入内容（本地）', fs.existsSync(path.join(repo, 'feat.txt')));
  // 冲突场景：dev 与任务分支改同一文件 → 中止回滚，不污染基线
  const ws2 = mkws();
  cleanups.push(ws2);
  const repo2 = path.join(ws2, 'services/backend');
  fs.mkdirSync(repo2, { recursive: true });
  git('init -b dev', repo2);
  fake(ws2, 'services/backend/same.txt', 'base');
  git('add .', repo2);
  git('commit -m init', repo2);
  await run('hk-init', '', ws2);
  const kit2 = JSON.parse(fs.readFileSync(path.join(ws2, '.harness/kit.json'), 'utf8'));
  kit2.worktree = { autoClose: false };
  fs.writeFileSync(path.join(ws2, '.harness/kit.json'), JSON.stringify(kit2, null, 2) + '\n');
  await ensureTaskWorkspaces(ws2, kit2, 'task-c1');
  await ensureTaskWorkspaces(ws2, kit2, 'task-c2');
  fake(ws2, '.worktrees/backend/slot-1/same.txt', 'from-task');
  git('add .', path.join(ws2, '.worktrees/backend/slot-1'));
  git('commit -m task-change', path.join(ws2, '.worktrees/backend/slot-1'));
  fake(ws2, 'services/backend/same.txt', 'from-dev');
  git('add .', repo2);
  git('commit -m dev-change', repo2);
  fake(ws2, '.harness/deliverables/task-c2/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws2, '.harness/deliverables/task-c2/test-report.md', '# t\n\n## 结论\nPASS\n');
  const c1 = await run('hk-archive', 'task-c2', ws2);
  ok('前置：归档后槽位保留', !!readWorkspaces(ws2).tasks['task-c2']);
  const c2 = await run('hk-archive', 'task-c2 --merge', ws2);
  ok('冲突 → 中止回滚并报冲突文件', c2.kind === 'error' && c2.text.includes('合并冲突') && c2.text.includes('same.txt'));
  ok('冲突后基线未污染（dev 保持原提交）', git('log --oneline -1', repo2).includes('dev-change') && fs.readFileSync(path.join(repo2, 'same.txt'), 'utf8').trim() === 'from-dev');
  ok('冲突后槽位仍保留', !!readWorkspaces(ws2).tasks['task-c2']);
}
// ---------------------------------------------------------------- 零人工收尾（0.2.0）
section('零人工收尾：目标快进、重复收尾、失败前置、dry-run/--no-merge');
{
  // 远端目标落后 + autoClose：一条归档命令完成快进、合入、释放，且不推送
  const { ensureTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const remote = mkws();
  cleanups.push(remote);
  const bare = path.join(remote, 'r.git');
  git('init -q --bare r.git', remote);
  git('init -q -b dev seed', remote);
  const seed = path.join(remote, 'seed');
  fake(remote, 'seed/app.txt', 'v1');
  git('add -A && git commit -qm init', seed);
  git(`remote add origin ${bare}`, seed);
  git('push -q -u origin dev', seed);
  git('symbolic-ref HEAD refs/heads/dev', bare);

  const ws = mkws();
  cleanups.push(ws);
  fs.mkdirSync(path.join(ws, 'services'), { recursive: true });
  git(`clone -q ${bare} services/backend`, ws);
  await run('hk-init', '', ws);
  const repo = path.join(ws, 'services/backend');
  const kitPath = path.join(ws, '.harness/kit.json');
  const kit = JSON.parse(fs.readFileSync(kitPath, 'utf8'));
  kit.worktree = { autoClose: true, targetSync: 'safe' };
  fs.writeFileSync(kitPath, JSON.stringify(kit, null, 2) + '\n');

  await ensureTaskWorkspaces(ws, kit, 'task-a');
  await ensureTaskWorkspaces(ws, kit, 'task-b');
  const slot = path.join(ws, '.worktrees/backend/slot-1');
  fake(ws, '.worktrees/backend/slot-1/work.txt', 'task-work');
  git('add .', slot);
  git('commit -m task-work', slot);
  fake(ws, '.harness/deliverables/task-b/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws, '.harness/deliverables/task-b/test-report.md', '# t\n\n## 结论\nPASS\n');

  // 远端前进一个提交，本地 dev 仍停在旧提交
  git('checkout dev', seed);
  fake(remote, 'seed/remote.txt', 'remote');
  git('add -A && git commit -qm remote && git push -q origin dev', seed);
  const remoteBefore = git('rev-list --count refs/heads/dev', bare).trim();

  const dry = await run('hk-archive', 'task-b --dry-run', ws);
  ok('dry-run 只出预演，不归档不合入', dry.kind === 'success' && dry.text.includes('预演') && fs.existsSync(path.join(ws, '.harness/deliverables/task-b/proposal.md')) && !!readWorkspaces(ws).tasks['task-b']);

  const r = await run('hk-archive', 'task-b', ws);
  ok('autoClose 自动快进目标并本地合入', r.kind === 'success' && r.text.includes('已快进') && r.text.includes('已本地合入'));
  ok('autoClose 释放槽位并删除任务分支', !readWorkspaces(ws).tasks['task-b'] && !git('branch --list feat/harness-task-b', repo).includes('feat/harness-task-b'));
  ok('autoClose 不推送远端', git('rev-list --count refs/heads/dev', bare).trim() === remoteBefore);
  ok('本地 dev 同时含远端提交与任务提交', git('show dev:remote.txt', repo).trim() === 'remote' && git('show dev:work.txt', repo).trim() === 'task-work');

  // 本地 dev 现在领先 origin（未推送的收尾提交）；远端再次前进 → 下一次收尾必须仍可自动进行
  await ensureTaskWorkspaces(ws, kit, 'task-c');
  const slot2 = path.join(ws, '.worktrees/backend/slot-1');
  fake(ws, '.worktrees/backend/slot-1/work2.txt', 'task-work-2');
  git('add .', slot2);
  git('commit -m task-work-2', slot2);
  fake(ws, '.harness/deliverables/task-c/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws, '.harness/deliverables/task-c/test-report.md', '# t\n\n## 结论\nPASS\n');
  git('checkout dev', seed);
  fake(remote, 'seed/remote2.txt', 'remote-2');
  git('add -A && git commit -qm remote-2 && git push -q origin dev', seed);
  const remote2Before = git('rev-list --count refs/heads/dev', bare).trim();
  const r2 = await run('hk-archive', 'task-c', ws);
  ok('本地领先 + 远端再前进仍可 safe 收尾', r2.kind === 'success' && r2.text.includes('已并入 origin') && r2.text.includes('已本地合入'));
  ok('重复收尾仍不推送远端', git('rev-list --count refs/heads/dev', bare).trim() === remote2Before);
  ok('重复收尾保留两轮远端提交与任务提交', git('show dev:remote2.txt', repo).trim() === 'remote-2' && git('show dev:work2.txt', repo).trim() === 'task-work-2');
}
{
  // 冲突：归档前置失败，任务保持活跃、文档仍在；--no-merge 可退化为只归档
  const { ensureTaskWorkspaces, readWorkspaces } = await import(path.join(bundleRoot, 'kernel/worktree.js'));
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/same.txt', 'base');
  git('add .', repo);
  git('commit -m init', repo);
  await run('hk-init', '', ws);
  const kitPath = path.join(ws, '.harness/kit.json');
  const kit = JSON.parse(fs.readFileSync(kitPath, 'utf8'));
  kit.worktree = { autoClose: true, targetSync: 'safe' };
  fs.writeFileSync(kitPath, JSON.stringify(kit, null, 2) + '\n');
  await ensureTaskWorkspaces(ws, kit, 'task-a');
  await ensureTaskWorkspaces(ws, kit, 'task-b');
  const slot = path.join(ws, '.worktrees/backend/slot-1');
  fake(ws, '.worktrees/backend/slot-1/same.txt', 'from-task');
  git('add .', slot);
  git('commit -m task-change', slot);
  // 在 dev 上制造冲突提交（ensureTaskWorkspaces 只登记主树，不会替任务切分支，当前仍在 dev）
  fake(ws, 'services/backend/same.txt', 'from-dev');
  git('add .', repo);
  git('commit -m dev-change', repo);
  fake(ws, '.harness/deliverables/task-b/proposal.md', '# p\n\n审批 1：通过\n');
  fake(ws, '.harness/deliverables/task-b/test-report.md', '# t\n\n## 结论\nPASS\n');
  const c = await run('hk-archive', 'task-b', ws);
  ok('冲突 → 归档前置失败并报冲突文件', c.kind === 'error' && c.text.includes('归档未执行') && c.text.includes('same.txt'));
  ok('冲突后任务仍活跃、文档未归档', fs.existsSync(path.join(ws, '.harness/deliverables/task-b/proposal.md')) && !!readWorkspaces(ws).tasks['task-b']);
  const nm = await run('hk-archive', 'task-b --no-merge', ws);
  ok('--no-merge 只归档文档并保留 stale 槽位', nm.kind === 'success' && nm.text.includes('已归档') && !fs.existsSync(path.join(ws, '.harness/deliverables/task-b')) && !!readWorkspaces(ws).tasks['task-b']);
}
// ---------------------------------------------------------------- hk-sync
section('hk-sync 资产同步');
{
  // 未绑定 git → 指引
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '', ws);
  const r1 = await run('hk-sync', '', ws);
  ok('本地模式（无 .git）→ 拒绝并指引绑定', r1.kind === 'error' && r1.text.includes('未绑定 git'));
}
{
  // 有 git 无远端 → 指引 remote add
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '--assets init', ws);
  const r2 = await run('hk-sync', '', ws);
  ok('无远端 → 拒绝并指引 remote add', r2.kind === 'error' && r2.text.includes('remote add'));
}
{
  // 正常同步：本地新文件 + 远端新提交 → 自动提交 + rebase + push
  const tmp = mkws();
  cleanups.push(tmp);
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tasks/board.md'), '# 任务看板\n\n| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |\n|---|---|---|---|---|---|---|\n');
  git('init -q -b main && git add -A && git commit -qm seed', seed);
  git(`clone -q --bare ${seed} ${bare}`, tmp);
  const ws = mkws();
  cleanups.push(ws);
  git(`clone -q ${bare} .harness`, ws);
  git('config user.email t@t && git config user.name t', path.join(ws, '.harness'));
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [], assets: { mode: 'clone', url: bare, branch: 'main' } }));
  // 远端前进：另一客户端追加一行 board
  const other = path.join(tmp, 'other');
  git(`clone -q ${bare} ${other}`, tmp);
  fs.appendFileSync(path.join(other, 'tasks/board.md'), '| task-a | PENDING | — | — | — | 2026-11-10 | — |\n');
  git('add -A && git commit -qm remote-row && git push -q origin main', other);
  // 本地变更：新 memory 条目（未提交）
  fake(ws, '.harness/memory/index.md', '# Memory 索引\n');
  const r3 = await run('hk-sync', '', ws);
  git('pull -q origin main', other);
  const boardRemote = fs.readFileSync(path.join(other, 'tasks/board.md'), 'utf8');
  ok('本地未提交变更自动提交 + rebase 远端 + push', r3.kind === 'success' && r3.text.includes('自动提交') && r3.text.includes('push'));
  ok('远端新行与本地新文件合并生效', fs.existsSync(path.join(ws, '.harness/memory/index.md')) && boardRemote.includes('task-a'));
  ok('memory/index.md 已推到远端', fs.existsSync(path.join(other, 'memory/index.md')));
}
{
  // 纯追加冲突 → 自动三路合并（双方都 append memory/index.md 不同行）
  const tmp = mkws();
  cleanups.push(tmp);
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'memory/index.md'), '# Memory 索引\n\n（条目一人一文件，此索引只追加）\n');
  git('init -q -b main && git add -A && git commit -qm seed', seed);
  git(`clone -q --bare ${seed} ${bare}`, tmp);
  const ws = mkws();
  cleanups.push(ws);
  git(`clone -q ${bare} .harness`, ws);
  git('config user.email t@t && git config user.name t', path.join(ws, '.harness'));
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [], assets: { mode: 'clone', url: bare, branch: 'main' } }));
  const other = path.join(tmp, 'other');
  git(`clone -q ${bare} ${other}`, tmp);
  fs.appendFileSync(path.join(other, 'memory/index.md'), '- 远端条目\n');
  git('add -A && git commit -qm remote-append && git push -q origin main', other);
  fs.appendFileSync(path.join(ws, '.harness/memory/index.md'), '- 本地条目\n');
  const r4 = await run('hk-sync', '', ws);
  const mergedLocal = fs.readFileSync(path.join(ws, '.harness/memory/index.md'), 'utf8');
  ok('纯追加冲突自动合并成功', r4.kind === 'success' && r4.text.includes('自动三路合并'));
  ok('合并结果含双方追加行', mergedLocal.includes('- 本地条目') && mergedLocal.includes('- 远端条目'));
  ok('已推送合并结果', fs.readFileSync(path.join(ws, '.harness/memory/index.md'), 'utf8') === git('show main:memory/index.md', bare));
  ok('rebase 已干净收尾（无进行中状态）', !fs.existsSync(path.join(ws, '.harness/.git/rebase-merge')) && !fs.existsSync(path.join(ws, '.harness/.git/rebase-apply')));
}
{
  // 非白名单冲突 → 中止回滚 + 转人工
  const tmp = mkws();
  cleanups.push(tmp);
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'kit.json'), '{"version":1}\n');
  git('init -q -b main && git add -A && git commit -qm seed', seed);
  git(`clone -q --bare ${seed} ${bare}`, tmp);
  const ws = mkws();
  cleanups.push(ws);
  git(`clone -q ${bare} .harness`, ws);
  git('config user.email t@t && git config user.name t', path.join(ws, '.harness'));
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [], assets: { mode: 'clone', url: bare, branch: 'main' } }));
  const other = path.join(tmp, 'other');
  git(`clone -q ${bare} ${other}`, tmp);
  fs.writeFileSync(path.join(other, 'kit.json'), '{"version":2}\n');
  git('add -A && git commit -qm remote-change && git push -q origin main', other);
  fs.writeFileSync(path.join(ws, '.harness/kit.json'), '{"version":3}\n');
  const headBefore = git('rev-parse HEAD', path.join(ws, '.harness'));
  const r5 = await run('hk-sync', '', ws);
  ok('非白名单冲突 → 报错转人工', r5.kind === 'error' && r5.text.includes('转人工') && r5.text.includes('kit.json'));
  ok('rebase 已中止（无进行中状态）、本地改动保留、远端未被污染', !fs.existsSync(path.join(ws, '.harness/.git/rebase-merge')) && !fs.existsSync(path.join(ws, '.harness/.git/rebase-apply')) && git('show HEAD:kit.json', path.join(ws, '.harness')).includes('"version":3') && git('show main:kit.json', bare).includes('"version":2') && git('rev-parse HEAD', path.join(ws, '.harness')) !== headBefore);
}
{
  // hk-archive + assets.autoSync=true → 归档后自动同步
  const tmp = mkws();
  cleanups.push(tmp);
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'seed.md'), 'x\n');
  git('init -q -b main && git add -A && git commit -qm seed', seed);
  git(`clone -q --bare ${seed} ${bare}`, tmp);
  const ws = mkws();
  cleanups.push(ws);
  git(`clone -q ${bare} .harness`, ws);
  git('config user.email t@t && git config user.name t', path.join(ws, '.harness'));
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [], assets: { mode: 'clone', url: bare, branch: 'main', autoSync: true } }));
  fake(ws, '.harness/deliverables/t2/bugfix.md', '# 修\n\n裁决：轻量\n');
  fake(ws, '.harness/tasks/board.md', '# 任务看板\n\n| 任务名 | 状态 | Profile | Apply进度 | 分支 | 上次活动 | 续接提示 |\n|---|---|---|---|---|---|---|\n| t2 | IN_PROGRESS | — | — | — | 2026-11-10 | — |\n');
  const r6 = await run('hk-archive', 't2', ws);
  ok('归档后自动同步执行并推送', r6.kind === 'success' && r6.text.includes('自动同步') && r6.text.includes('push'));
  ok('归档产物已在远端', git('ls-tree -r --name-only main', bare).includes('deliverables/_archive/t2/rounds.md'));
}

// ---------------------------------------------------------------- M4 面板数据
section('M4 面板：看板解析/流程进度/动作推导');
{
  const { parseBoard, taskProgress, nextAction, workspaceState } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const ws = mkws();
  cleanups.push(ws);
  await run('hk-init', '', ws);
  // 造一个 standard 任务：需求/设计完成，RR 通过，等审批 1
  fake(ws, '.harness/deliverables/demo/requirements.md', '# 需求\n');
  fake(ws, '.harness/deliverables/demo/design.md', '# 方案\n');
  fake(ws, '.harness/deliverables/demo/readiness-report.md', '# RR\n\n## 结论\nPASS\n');
  const boardText = fs.readFileSync(path.join(ws, '.harness/tasks/board.md'), 'utf8');
  const parsed = parseBoard(boardText + '| demo | IN_PROGRESS | standard | — | — | 2026-11-11 | 待审批 |\n');
  ok('parseBoard 表头 7 列', parsed.headers.length === 7);
  ok('parseBoard 行字段', parsed.rows.length === 1 && parsed.rows[0].task === 'demo' && parsed.rows[0].hint === '待审批');
  const p1 = taskProgress(ws, null, 'demo', 'standard', 'IN_PROGRESS');
  ok('流程阶段识别（standard 8 阶段）', p1.stages.length === 8);
  ok('产物证据置 done（需求/设计/RR）', p1.stages[0].done && p1.stages[1].done && p1.stages[2].done);
  ok('待审批 1 检出', p1.pendingApproval === '审批 1');
  const a1 = nextAction(parsed.rows[0], p1);
  ok('审批中动作=wait', a1.kind === 'wait' && a1.approval === '审批 1');
  // 审批 1 通过后 → 动作变 apply，pendingApproval 清空
  fake(ws, '.harness/deliverables/demo/proposal.md', '# 提案\n\n审批 1：通过（2026-11-11）\n');
  const p2 = taskProgress(ws, null, 'demo', 'standard', 'IN_PROGRESS');
  ok('审批 1 标记置 done', p2.stages[3].done && p2.pendingApproval === null);
  ok('进入 apply 阶段动作', nextAction(parsed.rows[0], p2).kind === 'apply');
  // DONE 任务
  ok('DONE 动作=reopen', nextAction({ ...parsed.rows[0], status: 'DONE' }, p2).kind === 'reopen');
  ok('AWAITING_ARCHIVE 动作=archive', nextAction({ ...parsed.rows[0], status: 'AWAITING_ARCHIVE' }, p2).kind === 'archive');
  // fix 任务：无 profile 时按 bugfix.md 推断 flow
  fake(ws, '.harness/deliverables/bug1/bugfix.md', '# 修\n');
  const p3 = taskProgress(ws, null, 'bug1', '—', 'IN_PROGRESS');
  ok('无 Profile 时按 bugfix.md 推断 fix 流', p3.flow === 'fix');
  // fix 短名二义：有 proposal.md → bugfix 全流程（含审批），无 → fix 直通
  fake(ws, '.harness/deliverables/fx1/bugfix.md', '# 修\n');
  fake(ws, '.harness/deliverables/fx2/bugfix.md', '# 修\n');
  fake(ws, '.harness/deliverables/fx2/proposal.md', '# 提案\n');
  ok('fix+无 proposal → fix 直通流程', taskProgress(ws, null, 'fx1', 'fix', 'IN_PROGRESS').flow === 'fix');
  const pFx2 = taskProgress(ws, null, 'fx2', 'fix', 'IN_PROGRESS');
  ok('fix+有 proposal → bugfix 全流程', pFx2.flow === 'bugfix' && pFx2.stages.some((s) => s.kind === 'approval'));
  // 看板 Apply 链驱动圆点（v3：链为权威进度，证据文件只作无链回退）
  const ch1 = taskProgress(ws, null, 'c1', 'standard', 'IN_PROGRESS', 'R2：Dev✅ 验证▶');
  ok('链驱动：圆点=链阶段', ch1.stages.length === 2 && ch1.stages[0].name === 'Dev' && ch1.stages[0].done && ch1.current === 1 && ch1.round === 2);
  const ch2 = taskProgress(ws, null, 'c2', 'standard', 'AWAITING_ARCHIVE', 'R10：Dev✅ 验证✅');
  ok('链驱动：全✅待归档 → current=-1 无审批挂起', ch2.current === -1 && ch2.pendingApproval === null && ch2.stages.every((s) => s.done));
  const ch3 = taskProgress(ws, null, 'c3', 'standard', 'IN_PROGRESS', 'R1：propose✅ 审批1▶ Dev…');
  ok('链驱动：▶审批1 → pendingApproval', ch3.pendingApproval === '审批1' && ch3.stages[1].kind === 'approval' && ch3.current === 1);
  const ch4 = taskProgress(ws, null, 'c4', 'fix', 'IN_PROGRESS', 'R1：质量门✅ Dev▶ CR— TE— 验证…');
  ok('链驱动：— 跳过不阻断推进', ch4.stages[2].skipped === true && ch4.current === 1);
  const ch5 = taskProgress(ws, null, 'c5', 'standard', 'IN_PROGRESS', 'R1：Dev✅ 坏token');
  ok('链驱动：不合规链回退证据推导', ch5.stages.length > 2);
  const ch6 = taskProgress(ws, null, 'c6', 'quick', 'IN_PROGRESS', 'R1：propose✅ 审批1✅ Dev✅ CR… TE… 审批2… 验证▶');
  ok('链越序检测：▶ 前有 … → outOfOrder', ch6.outOfOrder === true);
  ok('正常链 outOfOrder=false（含 — 跳过）', ch1.outOfOrder === false && ch4.outOfOrder === false);
  // workspaceState 汇总
  fs.writeFileSync(path.join(ws, '.harness/tasks/board.md'), boardText + '| demo | IN_PROGRESS | standard | — | — | 2026-11-11 | 待审批 |\n| bug1 | IN_PROGRESS | — | — | — | 2026-11-11 | — |\n');
  const state = workspaceState(ws);
  ok('workspaceState 汇总两任务', state && state.tasks.length === 2 && state.tasks.every((x) => x.action));
  ok('无 .harness 工作区返回 null', workspaceState(mkws()) === null);
  // 任务↔会话绑定（M4c）：recordTaskSession 登记，workspaceState 行内透出
  const { readTaskSessions, recordTaskSession } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  recordTaskSession(ws, 'demo', 'sess-abc');
  ok('任务↔会话绑定登记', readTaskSessions(ws).demo?.sessionId === 'sess-abc');
  const state2 = workspaceState(ws);
  ok('workspaceState 行透出 sessionId', state2.tasks.find((x) => x.task === 'demo')?.sessionId === 'sess-abc');
  ok('未绑定任务 sessionId 为 null', state2.tasks.find((x) => x.task === 'bug1')?.sessionId === null);
  ok('坏 sessions.json 容忍为 {}', (() => {
    fs.writeFileSync(path.join(ws, '.harness/local/sessions.json'), '{坏', 'utf8');
    return Object.keys(readTaskSessions(ws)).length === 0;
  })());
  recordTaskSession(ws, 'demo', 'sess-abc'); // 复原，避免影响后续断言
}

// ------------------------------------------------------------- 自动续接引擎
section('自动续接引擎：定稿→propose、审批1→apply 扫描与一次性标记');
{
  const { scanAutoAdvance, readAdvanceMarks, markAdvanceFired, clearAdvanceMarks } = await import(path.join(bundleRoot, 'kernel/advance.js'));
  const { readTaskSessions: readBindings } = await import(path.join(bundleRoot, 'kernel/bindings.js'));
  const ws = mkws();
  cleanups.push(ws);
  const board = '# 任务看板\n\n| 任务 | 状态 | Profile | Apply进度 | 分支 | 更新 | 续接提示 |\n|---|---|---|---|---|---|---|\n';
  // PENDING + draft → 无动作
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | PENDING | — | — | — | 2026-11-13 | — |
`);
  fake(ws, '.harness/deliverables/adv-a/proposal.md', '# 提案\n\n> **状态**：draft\n');
  ok('draft → 无自动接力', scanAutoAdvance(ws).length === 0);
  // 定稿 → propose 接力
  fake(ws, '.harness/deliverables/adv-a/proposal.md', '# 提案\n\n> **状态**：approved\n');
  let hops = scanAutoAdvance(ws);
  ok('approved+PENDING → 接力 /hk-propose', hops.length === 1 && hops[0].hop === 'propose' && hops[0].line === '/hk-propose adv-a');
  // 一次性标记阻断重复
  markAdvanceFired(ws, 'adv-a', 'propose');
  ok('propose 标记已落盘', !!readAdvanceMarks(ws)['adv-a:propose']);
  ok('标记阻断重复触发', scanAutoAdvance(ws).length === 0);
  // IN_PROGRESS + 审批 1 → apply 接力
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | IN_PROGRESS | standard | — | — | 2026-11-13 | — |
`);
  ok('审批 1 未记录 → 无 apply 接力', scanAutoAdvance(ws).length === 0);
  fs.appendFileSync(path.join(ws, '.harness/deliverables/adv-a/proposal.md'), '\n\n审批 1：通过（2026-11-13）\n');
  hops = scanAutoAdvance(ws);
  ok('审批1+IN_PROGRESS → 接力 /hk-apply', hops.length === 1 && hops[0].hop === 'apply' && hops[0].line === '/hk-apply adv-a');
  markAdvanceFired(ws, 'adv-a', 'apply');
  ok('apply 标记阻断重复', scanAutoAdvance(ws).length === 0);
  // 清理标记（任务重建/归档场景）→ 可重新接力
  clearAdvanceMarks(ws, 'adv-a');
  ok('clearAdvanceMarks 清空本任务标记', Object.keys(readAdvanceMarks(ws)).length === 0);
  ok('清理标记后可重新接力', scanAutoAdvance(ws).some((h) => h.task === 'adv-a' && h.hop === 'apply'));
  // 审批 2 → archive 接力（2026-11-17 定：人裁决归档，机器执行）
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | AWAITING_ARCHIVE | standard | R1：propose✅ 审批1✅ Dev✅ CR✅ TE✅ 审批2✅ 验证… | — | 2026-11-17 | 审批2通过 |
`);
  hops = scanAutoAdvance(ws);
  ok('审批2✅+AWAITING_ARCHIVE → 接力 /hk-archive', hops.length === 1 && hops[0].hop === 'archive' && hops[0].line === '/hk-archive adv-a');
  markAdvanceFired(ws, 'adv-a', 'archive');
  ok('archive 标记阻断重复', scanAutoAdvance(ws).length === 0);
  clearAdvanceMarks(ws, 'adv-a');
  // 审批 2 未落（链上 …, 或 IN_PROGRESS 状态）→ 不接力
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | AWAITING_ARCHIVE | standard | R1：propose✅ 审批1✅ Dev✅ CR✅ TE✅ 审批2… 验证… | — | 2026-11-17 | x |
`);
  ok('审批 2 未落 → 无 archive 接力', scanAutoAdvance(ws).length === 0);
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | IN_PROGRESS | standard | R1：propose✅ 审批1✅ Dev✅ CR✅ TE✅ 审批2✅ 验证… | — | 2026-11-17 | x |
`);
  ok('IN_PROGRESS 即使审批2✅ → 无 archive 接力（不重复触发归档）', !scanAutoAdvance(ws).some((h) => h.hop === 'archive'));
  // fix 直通任务（无 proposal.md）不参与 archive 接力
  fake(ws, '.harness/tasks/board.md', `${board}| adv-fix2 | AWAITING_ARCHIVE | fix | R1：质量门✅ Dev✅ CR— TE— 验证✅ | — | 2026-11-17 | x |
`);
  ok('fix 直通无 proposal → 不自动归档', scanAutoAdvance(ws).length === 0);
  fake(ws, '.harness/tasks/board.md', `${board}| adv-a | IN_PROGRESS | standard | — | — | 2026-11-13 | — |
`);
  // 坏板容忍为空扫描
  fake(ws, '.harness/tasks/board.md', '{坏');
  ok('坏 board.md 容忍为空扫描', scanAutoAdvance(ws).length === 0);
  // fix 直通（无 proposal.md）不参与
  fake(ws, '.harness/tasks/board.md', `${board}| adv-fix | PENDING | — | — | — | 2026-11-13 | — |
`);
  ok('无 proposal.md 的行跳过', scanAutoAdvance(ws).length === 0);
  // kernel 命令内绑定 + 重建清标记（手敲命令入口）
  await run('hk-init', '', ws, []);
  markAdvanceFired(ws, 'adv-b', 'propose');
  const agent = { ...agentFor(ws, []), id: 'sess-xyz' };
  const resNew = await handlers.get('hk-new')({ agent, rawInput: 'adv-b 自动续接绑定测试' });
  ok('hk-new 成功', resNew.kind === 'success');
  ok('hk-new 内登记任务↔会话绑定', readBindings(ws)['adv-b']?.sessionId === 'sess-xyz');
  ok('hk-new 清理同名任务续接标记', readAdvanceMarks(ws)['adv-b:propose'] === undefined);
  ok('新建任务 draft → 无接力', scanAutoAdvance(ws).length === 0);
  const proposalPath = path.join(ws, '.harness/deliverables/adv-b/proposal.md');
  fs.writeFileSync(proposalPath, fs.readFileSync(proposalPath, 'utf8').replace('**状态**：draft', '**状态**：approved'), 'utf8');
  ok('新建任务定稿 → 接力 /hk-propose（闭环）', scanAutoAdvance(ws).some((h) => h.task === 'adv-b' && h.hop === 'propose'));
  // hk-propose 内同样登记绑定（手敲入口防漂移）
  const resProp = await handlers.get('hk-propose')({ agent: { ...agentFor(ws, []), id: 'sess-prop' }, rawInput: 'adv-b' });
  ok('approved → hk-propose 成功', resProp.kind === 'success');
  ok('hk-propose 内更新任务绑定', readBindings(ws)['adv-b']?.sessionId === 'sess-prop');
}

// ------------------------------------------------------------- 本机配置路由
section('本机配置面板：GET 扫描 + POST 确认');
{
  const { registerPanelApi } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const { EventEmitter } = await import('node:events');
  const ws = mkws();
  cleanups.push(ws);
  const repo = path.join(ws, 'services/backend');
  fs.mkdirSync(repo, { recursive: true });
  git('init -b dev', repo);
  fake(ws, 'services/backend/.gitignore', 'application-local.properties\n');
  fake(ws, 'services/backend/application-local.properties', 'local=true\n');
  fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, pack: 'ai-coding', sources: [{ name: 'backend', path: 'services/backend', role: 'backend', branch: 'dev' }] }));
  const routes = new Map();
  const webServer = {
    exact: routes, prefixes: new Map(),
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
  };
  const registry = { list: () => [{ id: 'ws-local', path: ws, title: 'local', sessionIds: [] }] };
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'workspaceRegistry') return registry;
      if (name === 'connection') return { requestRejection: () => undefined };
      return undefined;
    },
  };
  const disposers = registerPanelApi(ctx);
  const route = routes.get('/harness-kit/local');
  const response = () => ({ code: 0, body: null, writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } });
  const getRes = response();
  await route.handler({ method: 'GET', url: '/harness-kit/local?workspace=ws-local' }, getRes);
  const candidates = getRes.body?.sources?.[0]?.candidates ?? [];
  ok('GET 本机配置返回候选', getRes.code === 200 && candidates.some((c) => c.path === 'application-local.properties' && c.pending));
  const req = new EventEmitter();
  req.method = 'POST'; req.url = '/harness-kit/local';
  const postRes = response();
  const pending = route.handler(req, postRes);
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify({ workspace: 'ws-local', repo: 'backend', action: 'approve', paths: ['application-local.properties'] })));
    req.emit('end');
  });
  await pending;
  ok('POST 本机配置不再报未知工作区', postRes.code === 200 && postRes.body?.ok === true);
  ok('POST 确认写入本机清单', JSON.parse(fs.readFileSync(path.join(ws, '.harness/local/local-files.json'), 'utf8')).sources.backend.approved.includes('application-local.properties'));
  disposers.forEach((d) => d());
}
// ------------------------------------------------------------- 任务运行统计
section('任务运行统计：会话树、token、覆盖率、归档快照');
{
  const { collectTaskMetrics, writeTaskMetrics, readLatestTaskMetrics } = await import(path.join(bundleRoot, 'kernel/metrics.js'));
  const { recordTaskSession, readTaskSessions } = await import(path.join(bundleRoot, 'kernel/bindings.js'));
  const ws = mkws();
  cleanups.push(ws);
  recordTaskSession(ws, 'metric-task', 's-pm');
  recordTaskSession(ws, 'hist-task', 's1');
  recordTaskSession(ws, 'hist-task', 's2');
  const hist = readTaskSessions(ws)['hist-task'];
  ok('会话绑定保留历史并去重', hist.sessionId === 's2' && hist.sessions.length === 2 && hist.sessions[1].id === 's2');
  const events = {
    's-pm': [
      { type: 'request/header', time: 1000, data: { header: { config: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } } } },
      { type: 'turn/start', time: 1000, data: { turn: 1 } },
      { type: 'assistant/message', time: 2000, data: { message: { source: { provider: 'deepseek', model: 'chat' } }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 } } },
      { type: 'tool/call', time: 2100, data: {} },
      { type: 'tool/result', time: 2200, data: { error: { code: 'x' } } },
      { type: 'turn/end', time: 3000, data: { turn: 1 } },
      { type: 'subagent/catalog', time: 1500, data: { childId: 's-child', label: 'Dev' } },
    ],
    's-child': [
      { seq: 0, type: 'assistant/message', time: 3000, data: { message: { source: { provider: 'p2', model: 'm2' } }, usage: { inputTokens: 999, outputTokens: 999 } } },
      { type: 'request/header', time: 4000, data: { header: { config: { provider: 'p2', model: 'm2', reasoningEffort: 'low' } } } },
      { type: 'turn/start', time: 4000, data: { turn: 1 } },
      { type: 'assistant/message', time: 4500, data: { message: { source: { provider: 'p2', model: 'm2' } }, usage: { inputTokens: 50, outputTokens: 10 } } },
      { type: 'turn/end', time: 5000, data: { turn: 1 } },
    ],
  };
  const sessionQuery = {
    traceSession: async (id) => {
      if (id === 's-pm') return { target: { header: { id: 's-pm' } }, descendants: [{ session: { header: { id: 's-child' } }, descendants: [] }] };
      if (id === 's-child') return { target: { header: { id: 's-child' } }, descendants: [] };
      throw new Error('missing');
    },
    readSession: async (id) => ({ session: { id }, inheritedEventCount: id === 's-child' ? 1 : 0, events: events[id] ?? [] }),
    inspectSession: async (id, read) => read({ header: { id } }),
  };
  const tokenMeter = { contextPressure: () => ({ pressureTokens: 50, contextWindow: 100 }) };
  const m = await collectTaskMetrics(ws, { sources: [] }, 'metric-task', { sessionQuery, tokenMeter });
  ok('统计覆盖 PM + 子会话且顺序稳定', m.coverage === 'complete' && m.agents.length === 2 && m.agents[0].label === 'PM' && m.agents[1].label === 'Dev');
  ok('统计汇总 provider/model/effort', m.agents[0].provider === 'deepseek' && m.agents[0].model === 'chat' && m.agents[0].reasoningEffort === 'high' && m.agents[1].provider === 'p2');
  ok('统计 token 分项与合计', m.agents[0].inputTokens === 100 && m.agents[0].outputTokens === 20 && m.agents[0].cacheReadTokens === 40 && m.agents[0].totalTokens === 120 && m.totals.totalTokens === 180);
  ok('统计轮次/耗时/失败', m.totals.turns === 2 && m.totals.activeDurationMs === 3000 && m.totals.toolFailures === 1 && m.agents[0].contextPressure === 0.5);
  ok('统计不携带原始 session id / 正文', !JSON.stringify(m).includes('s-pm') && !JSON.stringify(m).includes('s-child') && !JSON.stringify(m).includes('assistant/message'));
  const written = writeTaskMetrics(ws, 'metric-task', 'R0', m);
  const file = path.join(ws, '.harness/deliverables/_archive/metric-task/metrics/R0.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('归档统计快照写入 metrics/R0.json', fs.existsSync(file) && saved.task === 'metric-task' && saved.round === 'R0' && saved.coverage === 'complete');
  ok('同一轮统计不覆盖', writeTaskMetrics(ws, 'metric-task', 'R0', { ...m, coverage: 'partial' }).skipped === true && JSON.parse(fs.readFileSync(file, 'utf8')).coverage === 'complete');
  ok('历史任务可读最新归档统计', readLatestTaskMetrics(ws, 'metric-task')?.round === 'R0' && readLatestTaskMetrics(ws, 'missing') === null);
  const empty = await collectTaskMetrics(ws, { sources: [] }, 'none', {});
  ok('无会话绑定 → unavailable', empty.coverage === 'unavailable' && empty.agents.length === 0);
}
// ------------------------------------------------------------- M4b 面板 v2
section('M4b 面板：lane/claims/注意力/团队动态/配置更新');
{
  const { laneOf, parseClaims, claimTask, attentionItems, parseGitLog, updateKit, guardPanelHandler } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  // lane 派生
  ok('DONE → done 泳道', laneOf({ status: 'DONE' }, {}) === 'done');
  ok('AWAITING_ARCHIVE → archive 泳道', laneOf({ status: 'AWAITING_ARCHIVE' }, {}) === 'archive');
  ok('当前阶段 phase=apply → build', laneOf({ status: 'IN_PROGRESS' }, { current: 1, stages: [{}, { phase: 'apply' }] }) === 'build');
  ok('其余 → plan', laneOf({ status: 'IN_PROGRESS' }, { current: 0, stages: [{ phase: 'propose' }] }) === 'plan');
  ok('PENDING → plan（不看链阶段 phase）', laneOf({ status: 'PENDING' }, { current: 0, stages: [{ phase: 'apply' }] }) === 'plan');
  // claims 解析：JSONL、后者覆盖、by=null 释放、坏行容忍
  {
    const text = '{"task":"a","by":"leo","ts":"t1"}\n坏行\n{"task":"a","by":"anna","ts":"t2"}\n{"task":"b","by":"leo","ts":"t3"}\n{"task":"b","by":null,"ts":"t4"}\n';
    const claims = parseClaims(text);
    ok('claims 后者覆盖 + 释放', claims.a?.by === 'anna' && claims.b === undefined);
  }
  // claimTask 追加
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    claimTask(ws, 't-claim', 'tester');
    claimTask(ws, 't-claim', 'tester2');
    const claims = parseClaims(fs.readFileSync(path.join(ws, '.harness/tasks/claims.json'), 'utf8'));
    ok('claimTask 追加式 + 末条生效', claims['t-claim']?.by === 'tester2');
  }
  // 注意力项
  {
    const tasks = [
      { task: 'a', status: 'IN_PROGRESS', progress: { pendingApproval: '审批 1' } },
      { task: 'b', status: 'AWAITING_ARCHIVE', progress: {} },
      { task: 'c', status: 'DONE', progress: {} },
    ];
    const items = attentionItems(tasks, { state: 'blocked' });
    ok('审批阻塞入注意力（block+jump）', items.some((i) => i.kind === 'approval' && i.level === 'block' && i.jump === true));
    ok('同步阻塞入注意力（block）', items.some((i) => i.kind === 'sync-blocked' && i.level === 'block'));
    ok('待归档入注意力（warn+归档命令）', items.some((i) => i.kind === 'archive' && i.line === '/hk-archive b'));
    ok('DONE 不进注意力', !items.some((i) => i.task === 'c'));
    const behind = attentionItems([], { state: 'behind', behind: 3, dirty: true });
    ok('落后远端入注意力（warn）', behind.length === 1 && behind[0].kind === 'sync-behind' && behind[0].text.includes('3'));
    // embedded（随工作区根仓库）：落后/rebase 阻塞只指路，不挂「立即同步」动作
    const embBehind = attentionItems([], { state: 'behind', behind: 5, dirty: false, layout: 'embedded', repoRoot: '/x' });
    ok('embedded 落后指路不挂同步动作', embBehind.length === 1 && embBehind[0].kind === 'sync-behind' && embBehind[0].sync !== true && embBehind[0].text.includes('根仓库') && embBehind[0].text.includes('5'));
    const embBlocked = attentionItems([], { state: 'blocked', layout: 'embedded', repoRoot: '/x' });
    ok('embedded rebase 阻塞指路不挂同步动作', embBlocked.some((i) => i.kind === 'sync-blocked' && i.level === 'block' && i.sync !== true && i.text.includes('根仓库')));
    const plainBlocked = attentionItems([], { state: 'blocked' });
    ok('独立仓 rebase 阻塞保留同步动作', plainBlocked.some((i) => i.kind === 'sync-blocked' && i.sync === true));
    // 初始化缺口（init-incomplete）：有缺口才出现，warn 级
    const withGap = attentionItems([], null, ['backend 的 build.json']);
    ok('初始化缺口入注意力（warn+init 动作）', withGap.length === 1 && withGap[0].kind === 'init-incomplete' && withGap[0].init === true && withGap[0].text.includes('backend 的 build.json'));
    ok('无缺口不出现 init-incomplete', !attentionItems([], null).some((i) => i.kind === 'init-incomplete'));
    // ⛔ 阻塞与链越序入注意力
    const blockedTask = [{ task: 'blk', status: 'IN_PROGRESS', progress: { stages: [{ name: 'CR', blocked: true }] } }];
    ok('⛔ 阻塞入注意力（block+jump）', attentionItems(blockedTask, null).some((i) => i.kind === 'stage-blocked' && i.level === 'block' && i.jump === true && i.text.includes('CR')));
    const oooTask = [{ task: 'ooo', status: 'IN_PROGRESS', progress: { outOfOrder: true, stages: [] } }];
    ok('链越序入注意力（warn+jump）', attentionItems(oooTask, null).some((i) => i.kind === 'chain-out-of-order' && i.level === 'warn'));
    ok('DONE 的 ⛔/越序不进注意力', !attentionItems([{ task: 'd', status: 'DONE', progress: { outOfOrder: true, stages: [{ name: 'CR', blocked: true }] } }], null).length);
    const arch = attentionItems([], null, [], [], null, {}, [{ task: 'old', repos: ['backend', 'frontend'] }]);
    ok('已归档但台账未释放入注意力（warn + 归档命令）', arch.some((i) => i.kind === 'worktree-archived' && i.level === 'warn' && i.task === 'old' && i.line === '/hk-archive old' && i.text.includes('backend')));
  }
  // 面板 HTTP 路由的 DSH Connection 访问检查：任意网页不能调用 owner-private 路由
  {
    const fakeRes = () => {
      const out = { code: null, body: null };
      return { out, writeHead: (code) => { out.code = code; }, end: (body) => { out.body = body; } };
    };
    const req = { method: 'GET', url: '/harness-kit/state', headers: { host: '127.0.0.1' } };
    let called = 0;
    const handler = async () => { called += 1; };
    const r401 = fakeRes();
    await guardPanelHandler(handler, { requestRejection: () => 401 })(req, r401);
    ok('connection 拒绝 401 时不执行 handler', r401.out.code === 401 && called === 0 && String(r401.out.body).includes('unauthorized'));
    const r403 = fakeRes();
    await guardPanelHandler(handler, { requestRejection: () => 403 })(req, r403);
    ok('connection 拒绝 403 时不执行 handler', r403.out.code === 403 && called === 0 && String(r403.out.body).includes('forbidden'));
    const rOk = fakeRes();
    await guardPanelHandler(handler, { requestRejection: () => undefined })(req, rOk);
    ok('connection 放行时执行 handler', called === 1 && rOk.out.code === null);
    const rMissing = fakeRes();
    await guardPanelHandler(handler, null)(req, rMissing);
    ok('connection 缺失时 fail closed', rMissing.out.code === 500 && called === 1);
    const indexSrc = fs.readFileSync(path.join(bundleRoot, 'index.js'), 'utf8');
    ok('Host 注入 connection 后才挂面板路由', indexSrc.includes("'webServer', 'workspaceRegistry', 'connection'"));
    const panelSrc = fs.readFileSync(path.join(bundleRoot, 'kernel/panel.js'), 'utf8');
    ok('所有面板路由统一经 guardPanelHandler', panelSrc.includes('handler: guardPanelHandler(route.handler, connection)'));
    ok('历史任务统计优先归档快照', panelSrc.includes('readLatestTaskMetrics') && panelSrc.includes("!fs.existsSync(path.join(harnessDir(ws.path), 'deliverables', task))"));
    ok('本机配置 POST 从 body 解析工作区', panelSrc.includes("const { workspace, repo, action, paths } = JSON.parse") && panelSrc.includes('const targetWs = findWs(registry, workspace)'));
  }
  // initGaps：根 AGENTS.md/CLAUDE.md + 子工程 build.json / AGENTS.md
  {
    const { initGaps, initGapItems } = await import(path.join(bundleRoot, 'kernel/panel.js'));
    const ws = mkws();
    cleanups.push(ws);
    fs.mkdirSync(path.join(ws, 'services/backend'), { recursive: true });
    const kit = { sources: [{ name: 'backend', path: 'services/backend' }, { name: 'gone', path: 'services/gone' }] };
    ok('全缺：根 AGENTS/CLAUDE + 子工程两文件', (() => {
      const g = initGaps(ws, kit);
      return g.includes('根 AGENTS.md/CLAUDE.md') && g.includes('backend 的 build.json') && g.includes('backend 的 AGENTS.md/CLAUDE.md') && g.length === 3;
    })());
    ok('路径不存在的子工程不报缺口', !initGaps(ws, kit).some((g) => g.includes('gone')));
    const gi = initGapItems(ws, kit);
    ok('缺口结构化（kind/repo/path/action）', gi.length === 3 && gi.some((g) => g.kind === 'root-entry' && g.action === 'orchestrate') && gi.some((g) => g.kind === 'build-json' && g.repo === 'backend') && gi.some((g) => g.kind === 'subproject-entry' && g.repo === 'backend' && g.path === 'services/backend/AGENTS.md'));
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# x\n', 'utf8');
    fs.mkdirSync(path.join(ws, 'services/backend/.harness'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'services/backend/.harness/build.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(ws, 'services/backend/CLAUDE.md'), '# x\n', 'utf8');
    ok('齐全后无缺口（legacy CLAUDE 也算）', initGaps(ws, kit).length === 0);
    fs.unlinkSync(path.join(ws, 'services/backend/CLAUDE.md'));
    fs.writeFileSync(path.join(ws, 'services/backend/AGENTS.md'), '# x\n', 'utf8');
    ok('AGENTS 存在时也不报缺口', initGaps(ws, kit).length === 0);
  }
  // 设置页模型下拉数据源：listModelCatalog 聚合 provider/模型、单 provider 失败容忍、无服务返回 []
  {
    const { listModelCatalog } = await import(path.join(bundleRoot, 'kernel/panel.js'));
    const fakeLlm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'pi-ai', name: 'Pi AI' }],
      listModels: async (id) => id === 'deepseek' ? [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner' }] : Promise.reject(new Error('down')),
      resolveModelInfo: async (provider, model) => provider === 'deepseek' && model === 'deepseek-reasoner'
        ? { reasoning: { defaultEffort: 'high', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }
        : { reasoning: null },
    };
    const cat = await listModelCatalog(fakeLlm);
    ok('listModelCatalog 聚合 provider+模型', cat.length === 2 && cat[0].provider === 'deepseek' && cat[0].models.length === 2 && cat[1].models.length === 0);
    ok('listModelCatalog 透传模型推理等级', (() => {
      const m = cat[0].models.find((x) => x.id === 'deepseek-reasoner');
      return m?.reasoning?.defaultEffort === 'high' && m.reasoning.efforts.map((e) => e.id).join(',') === 'off,low,high,max' && cat[0].models.find((x) => x.id === 'deepseek-chat')?.reasoning === null;
    })());
    const catalogActiveOnly = await listModelCatalog({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }],
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek' },
        { provider: 'anthropic', displayName: 'Anthropic', declared: true },
      ],
    });
    ok('provider 下拉只列已注册项（不列未启用）', catalogActiveOnly.length === 1
      && catalogActiveOnly[0].provider === 'deepseek'
      && !catalogActiveOnly.some((c) => c.provider === 'anthropic'));
    ok('listModelCatalog 无服务返回 []', (await listModelCatalog(null)).length === 0 && (await listModelCatalog(undefined)).length === 0);
    ok('listModelCatalog 坏 listProviders 容忍为 []', (await listModelCatalog({ listProviders: () => { throw new Error('x'); } })).length === 0);
    // modelSuggest：provider 过滤 + 全部模型 id
    const { modelSuggest } = await import(path.join(bundleRoot, 'kernel/panel.js'));
    const sampleCatalog = [
      { provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
      { provider: 'kimi-coding', models: [{ id: 'k3' }, { id: 'k3-256k' }] },
    ];
    ok('modelSuggest provider 过滤', modelSuggest(sampleCatalog, 'kimi-coding').join(',') === 'k3,k3-256k');
    ok('modelSuggest 无 provider 时全部', modelSuggest(sampleCatalog).length === 4);
    ok('modelSuggest 空输入容忍', modelSuggest(null, 'x').length === 0 && modelSuggest(undefined).length === 0);
  }
  // git log 解析
  {
    const entries = parseGitLog('abc123\x1fleo\x1f2026-11-11 10:00\x1fharness: 归档 demo\x1f忽略尾部分隔\n');
    ok('parseGitLog 字段', entries.length === 1 && entries[0].hash === 'abc123' && entries[0].author === 'leo' && entries[0].subject === 'harness: 归档 demo\x1f忽略尾部分隔');
  }
  // updateKit 受控更新
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    const initialKit = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
    ok('新工作区默认开启 autoClose', initialKit.worktree?.autoClose === true && initialKit.worktree?.targetSync === 'safe');
    fs.writeFileSync(path.join(ws, '.harness/kit.json'), JSON.stringify({
      version: 1, pack: 'ai-coding', hosts: ['dsh'],
      sources: [{ name: 'backend', path: 'services/backend', role: 'backend', branch: 'dev' }],
      models: {}, assets: { mode: 'local', autoSync: false },
    }), 'utf8');
    ok('未知子工程报错', updateKit(ws, { sources: [{ name: 'ghost', branch: 'x' }] }).error?.includes('ghost'));
    ok('坏 model 映射报错', updateKit(ws, { models: { dev: { provider: 'p' } } }).error !== undefined);
    ok('坏 reasoning_effort 报错', updateKit(ws, { models: { dev: { provider: 'p', model: 'm', reasoning_effort: 3 } } }).error !== undefined);
    ok('非布尔 autoSync 报错', updateKit(ws, { autoSync: 'yes' }).error !== undefined);
    const r = updateKit(ws, { sources: [{ name: 'backend', branch: 'release' }], autoSync: true, models: { dev: { provider: 'ds', model: 'k3', reasoning_effort: 'low' } } });
    ok('合法 patch 保存成功', r.ok === true);
    const kit = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
    ok('kit.json 落盘（分支/autoSync/models/reasoning）', kit.sources[0].branch === 'release' && kit.assets.autoSync === true && kit.models.dev.model === 'k3' && kit.models.dev.provider === 'ds' && kit.models.dev.reasoning_effort === 'low');
    const r2 = updateKit(ws, { models: { dev: null } });
    ok('models null 删除映射', r2.ok && JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8')).models.dev === undefined);
    const rl = updateKit(ws, { localModels: { dev: { provider: 'local', model: 'm-local', reasoning_effort: 'high' } } });
    const localFile = path.join(ws, '.harness/local/models.json');
    const localJson = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    ok('localModels 写入 local/models.json', rl.ok && localJson.models.dev.model === 'm-local' && localJson.models.dev.provider === 'local');
    ok('localModels 不写 kit.json', JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8')).models.dev === undefined);
    ok('坏 local model 映射报错', updateKit(ws, { localModels: { dev: { provider: 'p' } } }).error !== undefined);
    updateKit(ws, { localModels: {} });
    ok('清空 localModels 删除本机文件', !fs.existsSync(localFile));
    // 流程配置（原 config.json 的 apply-mode）：applyMode 并入 kit.json；mainlineBranch 已废弃
    ok('applyMode 非法值拒绝', updateKit(ws, { applyMode: 'nope' }).error !== undefined);
    const r3 = updateKit(ws, { applyMode: 'review' });
    const k3 = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
    ok('applyMode 保存进 kit.json', r3.ok === true && k3.applyMode === 'review');
    ok('worktree targetSync 非法值拒绝', updateKit(ws, { worktree: { targetSync: 'nope' } }).error !== undefined);
    const r4 = updateKit(ws, { worktree: { autoClose: true, targetSync: 'ff-only' } });
    const k4 = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
    ok('worktree 收尾配置保存进 kit.json', r4.ok === true && k4.worktree.autoClose === true && k4.worktree.targetSync === 'ff-only');
  }
  // 旧 config.json → kit.json 迁移并在 init 时删除（2026-11-18）
  {
    const ws = mkws();
    cleanups.push(ws);
    fake(ws, '.harness/config.json', JSON.stringify({ 'apply-mode': 'review', 'mainline-branch': 'rel-9', description: 'x' }));
    await run('hk-init', '', ws);
    const k = JSON.parse(fs.readFileSync(path.join(ws, '.harness/kit.json'), 'utf8'));
    ok('init 迁移 config.json 到 kit.json（仅 applyMode）', k.applyMode === 'review' && k.mainlineBranch === undefined);
    ok('迁移后旧 config.json 已删除', !fs.existsSync(path.join(ws, '.harness/config.json')));
  }
  // lib.get_mainline_branch：主线 = kit.json sources[该仓].branch（build.json 覆盖优先）
  {
    const ws = mkws();
    cleanups.push(ws);
    fake(ws, '.harness/kit.json', JSON.stringify({ version: 1, sources: [{ name: 'backend', path: 'services/backend', branch: 'rel-2.0' }] }));
    fake(ws, '.harness/scripts/lib.py', fs.readFileSync(path.join(bundleRoot, 'packs/ai-coding/assets/scripts/lib.py'), 'utf8'));
    fs.mkdirSync(path.join(ws, 'services/backend'), { recursive: true });
    const out = execSync(`python3 -c "import sys; sys.path.insert(0,'.harness/scripts'); import lib; print(lib.get_mainline_branch('services/backend'))"`, { cwd: ws, encoding: 'utf8' }).trim();
    ok('主线分支 = sources[].branch（无 mainlineBranch 字段）', out === 'rel-2.0');
    fake(ws, 'services/backend/.harness/build.json', JSON.stringify({ 'mainline-branch': 'hotfix/9' }));
    const out2 = execSync(`python3 -c "import sys; sys.path.insert(0,'.harness/scripts'); import lib; print(lib.get_mainline_branch('services/backend'))"`, { cwd: ws, encoding: 'utf8' }).trim();
    ok('build.json mainline-branch 覆盖优先', out2 === 'hotfix/9');
  }
}

// ---------------------------------------------------------------- kernel/setup.js
section('setup.js：addSource / runInit(sources) / inspectDir');
{
  // 造一个本地 git 源仓库（本地路径即合法 git url）
  const srcTmp = mkws();
  cleanups.push(srcTmp);
  const repoWeb = path.join(srcTmp, 'web-admin');
  fs.mkdirSync(repoWeb, { recursive: true });
  git('init -q', repoWeb);
  fs.writeFileSync(path.join(repoWeb, 'README.md'), '# web\n');
  git('add -A && git commit -qm init', repoWeb);
  git('checkout -qb dev', repoWeb);
  fs.writeFileSync(path.join(repoWeb, 'dev.txt'), 'dev branch\n');
  git('add -A && git commit -qm dev', repoWeb);
  git('checkout -q master', repoWeb);

  // addSource 默认值推导（名称/路径/角色）+ 克隆落地 + kit.json 登记
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    const r = await addSource(ws, { url: repoWeb });
    const kit = readKitJson(ws);
    const s = kit.sources.find((x) => x.name === 'web-admin');
    ok('addSource 默认推导（name/path/role）', r.ok === true && !!s && s.path === 'services/web-admin' && s.role === 'frontend');
    ok('addSource 克隆落地 + 分支非空', fs.existsSync(path.join(ws, 'services/web-admin/README.md')) && typeof s.branch === 'string' && s.branch.length > 0);
    // 重复登记（同名/同路径）→ 拒绝
    const dup = await addSource(ws, { url: repoWeb });
    ok('addSource 重复登记拒绝', dup.ok === false && /已存在|重复|存在/.test(dup.error));
    // 已有目录 → 仅登记不克隆
    fake(ws, 'services/manual/.git/HEAD', 'ref: refs/heads/master\n');
    const reg = await addSource(ws, { url: repoWeb, name: 'manual', path: 'services/manual', role: 'backend' });
    ok('addSource 已有目录仅登记', reg.ok === true && readKitJson(ws).sources.some((x) => x.name === 'manual' && x.path === 'services/manual'));
  }

  // 团队资产 kit.json 自带登记但本地无代码 → 补 clone（2026-11-17 iot-test 事故）
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    const kitFile = path.join(ws, '.harness/kit.json');
    const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
    kit.sources = [{ name: 'web-admin', url: repoWeb, path: 'services/legacy-front', role: 'frontend', branch: 'master' }];
    fs.writeFileSync(kitFile, JSON.stringify(kit, null, 2));
    const r = await addSource(ws, { url: repoWeb }); // 名称从 url 推导 = web-admin，命中已登记
    ok('已登记但本地无目录 → 补 clone 到登记坐标', r.ok === true && fs.existsSync(path.join(ws, 'services/legacy-front/README.md')) && readKitJson(ws).sources.filter((x) => x.name === 'web-admin').length === 1);
    const again = await addSource(ws, { url: repoWeb });
    ok('补 clone 后重复添加 → 拒绝（目录已存在）', again.ok === false && /已登记且目录存在/.test(again.error));
  }

  // 补 clone 未显式传 branch → 沿用资产登记分支（不能克隆默认 master）
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    const kitFile = path.join(ws, '.harness/kit.json');
    const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
    kit.sources = [{ name: 'web-admin', url: repoWeb, path: 'services/legacy-dev', role: 'frontend', branch: 'dev' }];
    fs.writeFileSync(kitFile, JSON.stringify(kit, null, 2));
    const r = await addSource(ws, { url: repoWeb }); // branch 省略
    ok('补 clone 沿用登记分支 dev', r.ok === true && fs.existsSync(path.join(ws, 'services/legacy-dev/dev.txt')));
    ok('补 clone 登记分支仍为 dev', readKitJson(ws).sources.find((x) => x.name === 'web-admin')?.branch === 'dev');
  }

  // path 派生（2026-11-17）：显式 role 唯一 → services/<role>；重名/无显式 role → services/<仓名>
  {
    const srcTmp2 = mkws();
    cleanups.push(srcTmp2);
    const repoA = path.join(srcTmp2, 'sie-iiot');
    const repoB = path.join(srcTmp2, 'sie-iot-web-new');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    git('init -q', repoA); fs.writeFileSync(path.join(repoA, 'README.md'), '# a\n'); git('add -A && git commit -qm i', repoA);
    git('init -q', repoB); fs.writeFileSync(path.join(repoB, 'README.md'), '# b\n'); git('add -A && git commit -qm i', repoB);
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    // 显式 role 唯一 → services/<role>
    const r1 = await addSource(ws, { url: repoA, role: 'backend' });
    ok('显式 role 唯一 → services/<role>', r1.ok === true && readKitJson(ws).sources.some((x) => x.role === 'backend' && x.path === 'services/backend'));
    // 第二个显式 role 唯一 → services/<role>
    const r2 = await addSource(ws, { url: repoB, role: 'frontend' });
    ok('第二仓显式 role 唯一 → services/<role>', r2.ok === true && readKitJson(ws).sources.some((x) => x.role === 'frontend' && x.path === 'services/frontend'));
    // 显式 path 永远优先
    const repoC = path.join(srcTmp2, 'custom-repo');
    fs.mkdirSync(repoC, { recursive: true });
    git('init -q', repoC); fs.writeFileSync(path.join(repoC, 'README.md'), '# c\n'); git('add -A && git commit -qm i', repoC);
    const r3 = await addSource(ws, { url: repoC, role: 'backend', path: 'services/custom' });
    ok('显式 path 优先于 role 派生', r3.ok === true && readKitJson(ws).sources.some((x) => x.path === 'services/custom'));
  }

  // runInit 携带 sources（面板向导负载）：登记子工程；失败源进 warnings 不阻断
  {
    const ws = mkws();
    cleanups.push(ws);
    const r = await runInit(ws, {
      assets: 'local',
      sources: [{ url: repoWeb }, { url: path.join(srcTmp, 'no-such-repo') }],
    });
    const kit = readKitJson(ws);
    ok('runInit(sources) 子工程登记成功', r.ok === true && kit.sources.some((x) => x.name === 'web-admin'));
    ok('runInit(sources) 失败源进 warnings', r.warnings.length > 0 && r.sourceReports.some((x) => !x.ok));
    const report = formatInitReport(r);
    ok('formatInitReport 含完成标题', report.includes('/hk-init 完成'));
    // 幂等重跑（重发同样负载 → 重复登记被拒绝但 init 仍 ok）
    const r2 = await runInit(ws, { assets: 'local', sources: [{ url: repoWeb }] });
    ok('runInit 幂等重跑不炸', r2.ok === true);
  }

  // inspectDir 预检
  {
    const miss = inspectDir(path.join(srcTmp, 'ghost'));
    ok('inspectDir 不存在路径', miss.exists === false && miss.isDir === false && miss.hasKit === false);
    const plain = mkws();
    cleanups.push(plain);
    const p = inspectDir(plain);
    ok('inspectDir 普通目录未初始化', p.exists === true && p.isDir === true && p.hasKit === false && p.hasHarness === false);
    await run('hk-init', '', plain);
    const q = inspectDir(plain);
    ok('inspectDir 已初始化工作区', q.hasKit === true && q.assetsMode === 'local' && q.pack === 'ai-coding');
    fs.writeFileSync(path.join(plain, '.harness/kit.json'), '{bad json');
    const bad = inspectDir(plain);
    ok('inspectDir 坏 kit.json 上报', bad.hasKit === true && typeof bad.kitError === 'string' && bad.kitError.length > 0);
  }
}

// ---------------------------------------------------------------- embedded 资产布局
section('sync.js/panel.js：embedded 资产布局（.harness 随根仓库管理）');
{
  const { assetsLayout, syncAssets } = await import(path.join(bundleRoot, 'kernel/sync.js'));
  const { syncHealth } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const waitSync = async (ws) => {
    syncHealth(ws, { force: true });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const d = syncHealth(ws);
      if (d.state !== 'checking') return d;
    }
    return syncHealth(ws);
  };

  // plain：无任何 git
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    const lay = await assetsLayout(ws);
    ok('assetsLayout 纯本地 → plain', lay.layout === 'plain');
    const r = await syncAssets(ws, readKitJson(ws));
    ok('plain /hk-sync 指引绑定', r.kind === 'error' && r.text.includes('本地模式'));
    const d = await waitSync(ws);
    ok('plain 同步健康 = local', d.state === 'local' && d.layout === undefined);
  }

  // repo：.harness 自带 .git
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    git('init -q', path.join(ws, '.harness'));
    const lay = await assetsLayout(ws);
    ok('assetsLayout 独立资产仓 → repo', lay.layout === 'repo');
  }

  // embedded：根仓库跟踪 .harness
  {
    const ws = mkws();
    cleanups.push(ws);
    await run('hk-init', '', ws);
    git('init -q', ws);
    git('add .harness && git commit -qm harness', ws);
    const lay = await assetsLayout(ws);
    ok('assetsLayout 根仓跟踪 .harness → embedded', lay.layout === 'embedded' && lay.rel === '.harness');
    const r = await syncAssets(ws, readKitJson(ws));
    ok('embedded /hk-sync 解释随根仓库管理', r.kind === 'error' && r.text.includes('随工作区根仓库') && r.text.includes('不适用'));
    const d1 = await waitSync(ws);
    ok('embedded 无远端同步健康 = embedded（干净）', d1.state === 'embedded' && d1.layout === 'embedded' && d1.dirty === false);
    fs.appendFileSync(path.join(ws, '.harness/kit.json'), '\n', 'utf8');
    const d2 = await waitSync(ws);
    ok('embedded dirty 只看 .harness 范围（改动后 dirty）', d2.dirty === true);
    // 物理嵌套但未跟踪 → plain
    const ws2 = mkws();
    cleanups.push(ws2);
    await run('hk-init', '', ws2);
    git('init -q', ws2);
    const lay2 = await assetsLayout(ws2);
    ok('assetsLayout 父仓未跟踪 → plain', lay2.layout === 'plain');
  }
}

// ---------------------------------------------------------------- 文件浏览
section('panel.js：browseDir 工作区内文件浏览');
{
  const { browseDir } = await import(path.join(bundleRoot, 'kernel/panel.js'));
  const ws = mkws();
  cleanups.push(ws);
  fake(ws, 'docs/需求.md', '# x\n');
  fake(ws, 'docs/api/spec.md', '# y\n');
  fake(ws, 'README.md', '# r\n');
  fake(ws, '.git/HEAD', 'ref\n');
  fake(ws, 'node_modules/pkg/index.js', 'x\n');

  const root = browseDir(ws, '');
  ok('根目录：目录优先 + 过滤 .git/node_modules', root.ok === true && root.dir === '' && root.parent === null
    && root.entries[0].name === 'docs' && root.entries[0].kind === 'dir'
    && root.entries.some((e) => e.name === 'README.md' && e.kind === 'file')
    && !root.entries.some((e) => e.name === '.git' || e.name === 'node_modules'));
  const sub = browseDir(ws, 'docs');
  ok('子目录：dir/parent 正确', sub.ok === true && sub.dir === 'docs' && sub.parent === ''
    && sub.entries.some((e) => e.name === 'api' && e.kind === 'dir') && sub.entries.some((e) => e.name === '需求.md' && e.kind === 'file'));
  ok('更深层 parent 链', browseDir(ws, 'docs/api').parent === 'docs');
  ok('越界拒绝（..）', browseDir(ws, '..').error === '目录越界');
  ok('越界拒绝（绝对路径）', browseDir(ws, '/etc').error !== undefined);
  ok('不存在目录报错', browseDir(ws, 'ghost').error === '目录不存在');
  ok('文件路径报错', browseDir(ws, 'README.md').error === '不是目录');
  // 符号链接逃逸 → 拒绝
  fs.symlinkSync(path.join(os.tmpdir()), path.join(ws, 'link-out'));
  ok('符号链接逃逸拒绝', browseDir(ws, 'link-out').error === '目录越界');
  // 尾斜杠/前导斜杠归一
  ok('斜杠归一', browseDir(ws, '/docs/').dir === 'docs');
}

// ---------------------------------------------------------------- 环境预检
section('env.js：向导环境预检');
{
  const { checkEnvironment } = await import(path.join(bundleRoot, 'kernel/env.js'));
  const probe = (versions, platform = 'darwin') => checkEnvironment({
    platform,
    runCommand: async (command) => versions[command] ?? { code: 127, stdout: '', stderr: 'command not found' },
  });

  const all = await probe({
    git: { code: 0, stdout: 'git version 2.44.0\n' },
    python3: { code: 0, stdout: 'Python 3.12.4\n' },
  });
  ok('全部可用 → allOk', all.allOk === true && all.tools.length === 2);
  ok('版本取首行', all.tools.find((t) => t.id === 'git').version === 'git version 2.44.0');
  ok('可用项不带安装指引', !('install' in all.tools.find((t) => t.id === 'git')));

  const missing = await probe({
    git: { code: 0, stdout: 'git version 2.44.0' },
    python3: { code: 127, stdout: '', stderr: 'python3: command not found' },
  });
  const py = missing.tools.find((t) => t.id === 'python3');
  ok('缺失项 → allOk false', missing.allOk === false && py.ok === false);
  ok('macOS 安装提示', py.install.command.includes('brew') && py.install.url.startsWith('https://'));
  ok('缺失原因透出', py.error.includes('command not found'));

  const win = await probe({ git: { code: 127, stdout: '' }, python3: { code: 0, stdout: 'Python 3.12' } }, 'win32');
  ok('Windows 安装提示', win.tools.find((t) => t.id === 'git').install.command.includes('winget'));
  const linux = await probe({ git: { code: 127, stdout: '' }, python3: { code: 0, stdout: 'Python 3.12' } }, 'linux');
  ok('Linux 安装提示', linux.tools.find((t) => t.id === 'git').install.command.includes('apt'));
  const other = await probe({ git: { code: 127, stdout: '' }, python3: { code: 0, stdout: 'Python 3.12' } }, 'aix');
  ok('未知平台回退通用指引', other.tools.find((t) => t.id === 'git').install.url === 'https://git-scm.com/downloads');
}

// ---------------------------------------------------------------- 审批材料可见性
section('flows：审批材料必须可见且带文件链接');
{
  const { loadFlow, compileFlowPrompt } = await import(path.join(bundleRoot, 'kernel/flows.js'));
  const ws = mkws();
  cleanups.push(ws);
  const compile = (name, phase) => {
    const loaded = loadFlow(ws, null, name);
    return compileFlowPrompt(loaded.flow, {
      task: 't', desc: 'd', artifacts: '.harness/deliverables/t', phase, flowFile: loaded.file,
    });
  };
  for (const name of ['standard', 'quick', 'bugfix', 'refactor']) {
    const propose = compile(name, 'propose');
    const apply = compile(name, 'apply');
    ok(`${name} 审批 1 要求可见消息+文件链接`, propose.includes('可见消息') && propose.includes('ask_user_question') && propose.includes('.harness/deliverables/<任务名>/'));
    ok(`${name} 审批 2 要求可见消息+文件链接`, apply.includes('可见消息') && apply.includes('ask_user_question') && apply.includes('test-report.md'));
  }
  const fix = compile('fix');
  ok('fix 质量门要求可见消息+文件链接', fix.includes('可见消息') && fix.includes('bugfix.md'));
  const boot = compile('new');
  ok('bootstrap 定稿要求可见消息+文件链接', boot.includes('可见消息') && boot.includes('proposal.md'));
  const custom = compileFlowPrompt({ name: 'custom', stages: [{ name: 'gt', approval: '确认一下' }] }, {
    task: 't', desc: 'd', artifacts: '.harness/deliverables/t', flowFile: 'custom.yml',
  });
  ok('自定义流程审批也强制可见材料', custom.includes('审批材料必须可见'));
  const pm = fs.readFileSync(path.join(bundleRoot, 'packs/ai-coding/agents/project-manager.md'), 'utf8');
  const core = fs.readFileSync(path.join(bundleRoot, 'packs/ai-coding/rules/core.md'), 'utf8');
  ok('PM 角色包含审批材料可见规则', pm.includes('审批材料必须可见可点'));
  ok('core 规则包含审批材料可见规则', core.includes('审批材料必须可见可点'));
  ok('PM 角色包含 handoff/等待纪律', pm.includes('handoff.md') && pm.includes('不要 5 分钟轮询') && pm.includes('3600000'));
  ok('core 规则包含等待/读取纪律', core.includes('子代理等待纪律') && core.includes('上下文读取纪律') && core.includes('不整份重读'));
  ok('PM/core 包含看板与命令批处理纪律', pm.includes('看板与命令批处理纪律') && core.includes('编排噪音纪律') && core.includes('阶段边界') && core.includes('合并'));
  const { dispatchSection } = await import(path.join(bundleRoot, 'kernel/models.js'));
  const dispatch = dispatchSection({}, [{ role: 'business-analyst', logical: 'fast' }]);
  ok('派发附录注入 handoff/等待纪律', dispatch.includes('handoff.md') && dispatch.includes('wait_agent') && dispatch.includes('3600000') && dispatch.includes('不整份重读'));
  ok('派发附录注入编排噪音纪律', dispatch.includes('看板只在阶段边界') && dispatch.includes('合并成一条 bash') && dispatch.includes('失败摘要'));
}

// ---------------------------------------------------------------- 会话内工作区提醒
section('client：工作区提醒');
{
  const clientSrc = fs.readFileSync(path.join(bundleRoot, 'client.js'), 'utf8');
  ok('会话输入区注册工作区提醒', clientSrc.includes("conversation.input.dock") && clientSrc.includes('AttentionDock'));
  ok('侧栏图标带提醒红点', clientSrc.includes('hk-alert-dot'));
  ok('提醒条复用面板 attention 接口', clientSrc.includes("fetch('/harness-kit/state')"));
  ok('模型映射含推理等级选择（默认 low 逻辑）', clientSrc.includes('reasoning_effort') && clientSrc.includes('推理等级') && clientSrc.includes("e.id === 'low'"));
  ok('新建工作区分支必填', clientSrc.includes("s.url.trim() && !s.branch.trim()") && clientSrc.includes('分支为空时不会创建并克隆子工程'));
  ok('provider 下拉不显示未启用项', !clientSrc.includes('（未启用）') && !clientSrc.includes('已声明但未启用'));
  ok('模型映射文案已精简', clientSrc.includes('未配置的角色走下一级或会话默认') && clientSrc.includes('推理等级随模型能力变化'));
  ok('历史任务运行记录入口', clientSrc.includes('历史任务运行记录弹窗') && clientSrc.includes('运行记录 · ${histInsight.task}') && clientSrc.includes('setHistInsight(t)'));
  ok('运行记录主视图不展示失败次数', !clientSrc.includes("'失败'].map") && !clientSrc.includes('· 失败 ${d.totals'));
  ok('本机配置使用普通用户文案', clientSrc.includes('本机开发配置') && clientSrc.includes('不会提交到代码仓库') && !clientSrc.includes('本机配置（git-ignored）'));
  ok('本机配置支持逐文件选择', clientSrc.includes('同步选中（') && clientSrc.includes('toggleLocal') && clientSrc.includes('maxHeight: 230'));
  ok('本机配置 POST 带 workspace query（兼容旧 Host）', clientSrc.includes("fetch(`/harness-kit/local?workspace=${encodeURIComponent(ws.id)}`"));
}

// ---------------------------------------------------------------- report

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.section) {
    console.log(`
== ${r.section}`);
    continue;
  }
  console.log(`${r.cond ? '✅' : '❌'} ${r.name}`);
  r.cond ? pass++ : fail++;
}
for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

