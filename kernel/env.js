// 向导环境预检：git / Python 3 是 Harness Kit 的硬依赖，缺失时在面板里直接给出
// 对应平台的安装命令，避免用户提交初始化后才发现失败。
// 纯逻辑 + 注入式执行器：sim 套件可在不 spawn 进程的情况下覆盖三平台提示。
import { run } from './exec.js';

/** 受检工具及其安装指引（命令只做展示，不自动执行）。 */
export const ENV_TOOLS = [
  {
    id: 'git',
    name: 'git',
    command: 'git',
    args: ['--version'],
    purpose: '克隆代码/资产仓库、团队资产同步、任务并行 worktree',
    install: {
      darwin: { command: 'xcode-select --install', url: 'https://git-scm.com/download/mac' },
      win32: { command: 'winget install --id Git.Git -e --source winget', url: 'https://git-scm.com/download/win' },
      linux: { command: 'sudo apt install git   # Debian/Ubuntu；Fedora: sudo dnf install git', url: 'https://git-scm.com/download/linux' },
      default: { command: 'https://git-scm.com/downloads', url: 'https://git-scm.com/downloads' },
    },
  },
  {
    id: 'python3',
    name: 'Python 3',
    command: 'python3',
    args: ['--version'],
    purpose: '初始化脚本、看板写入、规格校验、体检与验证',
    install: {
      darwin: { command: 'brew install python', url: 'https://www.python.org/downloads/mac-osx/' },
      win32: {
        command: 'winget install --id Python.Python.3.12 -e --source winget',
        url: 'https://www.python.org/downloads/windows/',
      },
      linux: { command: 'sudo apt install python3   # Debian/Ubuntu；Fedora: sudo dnf install python3', url: 'https://www.python.org/downloads/source/' },
      default: { command: 'https://www.python.org/downloads/', url: 'https://www.python.org/downloads/' },
    },
  },
];

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0]?.trim() ?? '';
}

/**
 * 检查每个工具的 `--version`。失败不是异常：返回 missing 项与安装指引。
 * @param {{ platform?: NodeJS.Platform, runCommand?: typeof run }} options
 * @returns {Promise<{ allOk: boolean, platform: string, tools: Array<object> }>}
 */
export async function checkEnvironment({ platform = process.platform, runCommand = run } = {}) {
  const tools = [];
  for (const tool of ENV_TOOLS) {
    const result = await runCommand(tool.command, tool.args, { timeoutMs: 10_000 });
    const found = result.code === 0;
    const install = tool.install[platform] ?? tool.install.default;
    tools.push({
      id: tool.id,
      name: tool.name,
      purpose: tool.purpose,
      ok: found,
      version: found ? firstLine(result.stdout) || firstLine(result.stderr) || undefined : undefined,
      ...(found ? {} : { install, error: firstLine(result.stderr) || `exit ${result.code}` }),
    });
  }
  return { allOk: tools.every((tool) => tool.ok), platform, tools };
}
