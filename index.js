// Harness Kit — Host plugin entry.
// M1: command-driven orchestration (commands steer the Lead with compiled
// flow prompts), role registry with workspace override, and the Bootstrap
// write-zone ToolGuard. No custom tools, no runtime imports from shipped
// dsh packages (bundles cannot resolve @deepseek-ai/* from the profile).
import fs from 'node:fs';
import path from 'node:path';
import { registerCommands } from './kernel/commands.js';
import { installGuards } from './kernel/guards.js';
import { registerPanelApi } from './kernel/panel.js';
import { readKit, wsRoot } from './kernel/paths.js';
import { collectModelRoutes } from './kernel/models.js';
import { readLocalModels } from './kernel/local-models.js';
import { installImBridge } from './kernel/im-bridge.js';

export const inject = ['commands', 'tools'];

export function apply(ctx) {
  registerCommands(ctx);
  installGuards(ctx, ctx.get('logger'));

  // 子智能体模型路由自动授权：DSH 默认子模型限父会话当前模型，宿主级 subagentModelSelection
  // 出厂关且无 GUI——HarnessKit 在会话创建时按工作区 kit.json + local/models.json 映射追加授权策略事件
  // （与宿主 SubagentModelSelectionConfig 同一挂点 agent/created；子会话自动继承父策略）。
  try {
    ctx.on('agent/created', ({ agent }) => {
      try {
        const session = agent?.session;
        const cwd = session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd === '') return;
        if (!fs.existsSync(path.join(cwd, '.harness', 'kit.json'))) return;
        const kit = readKit(cwd);
        const routes = collectModelRoutes(kit, readLocalModels(cwd));
        if (routes.length === 0) return;
        // 已挂策略的会话（含子会话继承）由投影幂等忽略重复 append
        session?.append?.('subagent/model-selection-policy', { allowedModels: routes });
      } catch { /* 授权失败不阻断会话 */ }
    });
  } catch { /* 事件不可用（非常规宿主）则静默跳过 */ }

  // webServer / workspaceRegistry 是异步启动的 cordis 服务：冷启动时 apply
  // 可能先于它们就绪（ctx.get 返回 undefined，路由静默不挂载——2026-11-12
  // 事故：插件随会话中途启用时服务已就绪所以能用，重启后 404）。用 ctx.inject
  // 依赖注入回调，服务就绪后才注册路由；回调返回值作为该注入作用域的 disposer。
  ctx.inject(['webServer', 'workspaceRegistry', 'connection'], (webCtx) => {
    const disposers = registerPanelApi(webCtx);
    webCtx.get('logger')?.info?.('harness-kit: panel api mounted');
    return () => disposers.forEach((d) => d());
  });

  // IM 审批桥接：监听 user-questions/request，识别 HK 标记，发卡片到 IM
  ctx.inject(['userQuestions'], (uqCtx) => {
    const disposers = installImBridge(uqCtx);
    uqCtx.get('logger')?.info?.('harness-kit: IM bridge installed');
    return () => disposers.forEach((d) => d());
  });

  ctx.get('logger')?.info?.('harness-kit: loaded (commands + guards)');
}
