// Promisified child_process runner for git/script invocations owned by
// command handlers. Runs unsandboxed like Claude Code hooks; every call site
// reports the command and outcome in the command result text.
import { spawn } from 'node:child_process';

export function run(cmd, args, { cwd, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr + `\n[harness-kit] 超时（${timeoutMs}ms），进程已终止` });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[harness-kit] 启动失败：${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export function runGit(args, opts) {
  return run('git', args, opts);
}
