// IM 桥接安装：监听 user-questions/request 与 approval/request waterfall，发卡片到 IM
// 这是 kernel/im/ 模块与 DSH userQuestions / approval 服务的接线层

import { ApprovalBridge } from './im/bridge.js';
import { readImConfig, hasEnabledChannel, appendImAudit } from './im/config.js';
import { wsRoot } from './paths.js';
// 副作用导入：注册内置 transport（飞书/企微/钉钉 adapter）
import './im/index.js';

/** 从 agent 获取工作区路径 */
function getWs(agent) {
  try {
    return wsRoot(agent);
  } catch {
    return null;
  }
}

/** 检查问题是否带 HK 标记 */
function isHkQuestion(question) {
  const q = question?.question ?? '';
  const id = question?.id ?? '';
  return q.startsWith('HK:') || id.startsWith('hk-');
}

/** 从问题中提取任务名（从 HK:xxx · <任务名> 格式） */
function extractTaskName(question) {
  const q = question?.question ?? '';
  // 匹配 "HK:审批 1 · task-name" 或 "HK:澄清" 等格式
  const match = q.match(/HK:[^·]+·\s*(.+)$/);
  return match ? match[1].trim() : null;
}

/** 取 DSH 权限审批的展示原因（优先本地化文案，其次原始 reason） */
function approvalReason(request) {
  const display = request?.displayReason;
  const localized = display && (display.zh ?? display['zh-CN'] ?? display.en ?? Object.values(display)[0]);
  const parts = [localized, request?.reason]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  return [...new Set(parts)].join('\n\n') || '（DSH 未提供原因）';
}

/** 安装 IM 桥接 */
export function installImBridge(ctx) {
  const logger = ctx.get('logger');
  const userQuestions = ctx.get('userQuestions');
  const disposers = [];
  const bridges = new Map(); // ws -> ApprovalBridge
  const bridgeConfigKeys = new Map(); // ws -> 当前 bridge 对应的 im-config 快照
  const handledRequests = new WeakMap(); // request -> Promise，避免 global/agent 双监听重复处理
  const handledApprovals = new WeakMap(); // approval request -> Promise，避免重复处理

  /**
   * 获取或创建该工作区的 bridge，并返回当前启用的渠道。
   * 配置是热更新的：每次事件都重新读 im-config.json；目标 Open ID/凭据/启停变化后
   * 不能继续用旧 bridge（旧实现只在首次创建时读配置，改了 Open ID 或先配置后启用时
   * 会一直发到旧目标/一直不发，表现为「DSH 有弹窗、飞书没通知」）。
   */
  const ensureBridge = async (ws) => {
    const config = readImConfig(ws);
    const configKey = JSON.stringify(config);
    let bridge = bridges.get(ws);

    if (!hasEnabledChannel(config)) {
      if (bridge && bridge.pendingApprovals.size === 0) {
        await bridge.dispose();
        bridges.delete(ws);
        bridgeConfigKeys.delete(ws);
      }
      return null;
    }

    if (bridge && bridgeConfigKeys.get(ws) !== configKey) {
      if (bridge.pendingApprovals.size > 0) {
        logger?.warn?.('[im-bridge] IM 配置已变更，但仍有审批进行中；本事件先走 Web，审批结束后重建连接');
        return null;
      }
      await bridge.dispose();
      bridges.delete(ws);
      bridgeConfigKeys.delete(ws);
      bridge = null;
      logger?.info?.('[im-bridge] IM 配置已变更，重建连接');
    }

    if (!bridge) {
      bridge = new ApprovalBridge({ ws, logger, userQuestions, config });
      await bridge.init();
      if (bridge.transports.size === 0) {
        // 连接失败不留坏 bridge：否则后续事件会一直复用它，永远没有飞书通知
        await bridge.dispose();
        appendImAudit(ws, { type: 'connect-failed', result: 'error', error: '没有可用的 IM transport（检查 App ID/Secret、事件订阅与网络）' });
        return null;
      }
      bridges.set(ws, bridge);
      bridgeConfigKeys.set(ws, configKey);
    }

    const entry = Object.entries(bridge.config.channels).find(([, c]) => c.enabled);
    if (!entry) return null;
    const [channel, channelConfig] = entry;
    if (!channelConfig.targetOpenId) {
      logger?.warn?.('[im-bridge] 未绑定目标用户，跳过 IM 通知');
      appendImAudit(ws, { type: 'notify-failed', result: 'error', error: '未绑定目标 Open ID' });
      return null;
    }

    return { bridge, channel, targetOpenId: channelConfig.targetOpenId };
  };

  // 监听 user-questions/request waterfall。
  // 该事件按 Agent scope 过滤：必须注册在 agent.ctx 上，根 ctx 的全局监听收不到。
  const processQuestion = async (request, next) => {
    const { agent, questions } = request;
    if (!agent || !questions || questions.length === 0) {
      return next();
    }

    // HK 标记只用于提取任务名/决定是否摘 detail；IM 启用后所有
    // ask_user_question 都应通知，否则旧任务里没有 HK 前缀的审批会漏掉。
    const hkQuestions = questions.filter(isHkQuestion);

    // 给本题一个独立生命周期：IM 先答时 abort 这个 controller，
    // 让 DSH Web 的问题卡收到 ASK_ABORTED 后自动消失（不能 abort 整个 turn）。
    const turnSignal = request.signal;
    const questionAbort = new AbortController();
    const forwardTurnAbort = () => questionAbort.abort(turnSignal?.reason);
    turnSignal?.addEventListener('abort', forwardTurnAbort, { once: true });
    request.signal = questionAbort.signal;

    // Feishu 专用 detail 不进入 DSH 弹窗：DSH 保持原来的 header+question+options 格式。
    // 在调用 next() 之前摘掉 detail，飞书卡片仍用摘下来的副本。
    const imDetails = new Map();
    for (const q of questions) {
      const isHk = isHkQuestion(q);
      const imDetail = q.imDetail ?? q.detail;
      if (imDetail !== undefined) imDetails.set(q.id ?? q.question, imDetail);
      delete q.imDetail;
      // 只有 HK 审批的 detail 是 IM 专用；普通 DSH 问题的 detail 保持原格式
      if (isHk) delete q.detail;
    }

    const ws = getWs(agent);
    if (!ws) {
      logger?.warn?.('[im-bridge] 无法获取工作区路径，跳过 IM 通知');
      return next();
    }

    const ensured = await ensureBridge(ws);
    if (!ensured) return next();
    const { bridge, channel, targetOpenId } = ensured;

    // 提取任务名
    const task = extractTaskName(hkQuestions[0]) ?? agent.session?.title ?? 'DSH 提问';

    try {
      // 创建 IM 审批
      const pending = await bridge.createApproval({
        sessionId: agent.session?.id ?? agent.id,
        task,
        questions: questions.map((q) => ({
          id: q.id,
          question: q.question,
          detail: imDetails.get(q.id ?? q.question) ?? q.question,
          options: q.options ?? [],
        })),
        targetOpenId,
        channel,
      });

      // 同时发起 Web 回答（next()）和 IM 回答，先到先得。
      // 没有 Web 客户端时 next() 会以 NO_PROVIDER 拒绝；此时不应当作失败，继续等 IM 作答。
      const webAnswer = Promise.resolve()
        .then(() => next())
        .catch((err) => {
          if (err?.code === 'NO_PROVIDER') return new Promise(() => {});
          throw err;
        });
      const imAnswer = new Promise((resolve) => {
        // 监听 bridge 的完成事件
        const checkInterval = setInterval(() => {
          if (!bridge.pendingApprovals.has(pending.approvalId)) {
            clearInterval(checkInterval);
            // 审批已完成（通过 IM）
            resolve({
              answers: pending.answers.map((a, i) => ({
                id: pending.questions[i].id,
                selected: a?.selected ?? [],
                ...(a?.custom ? { custom: a.custom } : {}),
              })),
            });
          }
        }, 500);
        // 超时清理
        setTimeout(() => clearInterval(checkInterval), pending.expiresAt - Date.now() + 1000);
      });

      //  race：Web 先回答或 IM 先回答
      const result = await Promise.race([
        webAnswer.then((r) => ({ source: 'web', result: r })),
        imAnswer.then((r) => ({ source: 'im', result: r })),
      ]);

      turnSignal?.removeEventListener('abort', forwardTurnAbort);
      if (result.source === 'web') {
        // Web 整组提交时，按题合并此前已在飞书答过的部分：
        // 同一题以先答的那一侧为准，其余题用 Web 的答案。
        const web = result.result;
        if (web?.answers && Array.isArray(web.answers)) {
          let mergedCount = 0;
          web.answers = web.answers.map((a, i) => {
            const im = pending.answers[i];
            if (!im) return a;
            mergedCount += 1;
            return {
              id: im.id ?? a.id,
              selected: im.selected ?? [],
              ...(im.custom ? { custom: im.custom } : {}),
            };
          });
          if (mergedCount > 0) logger?.info?.(`[im-bridge] 合并 ${mergedCount} 个飞书已答项`);
        }
        // Web 先回答，取消 IM 审批
        await bridge.cancelApproval(pending.approvalId, '已在 DSH 处理');
        return web;
      } else {
        // IM 先回答：结束本题生命周期，让 DSH Web 的问题卡自行消失
        const reason = Object.assign(new Error('the question was answered on IM'), {
          name: 'UserQuestionError',
          code: 'ASK_ABORTED',
        });
        questionAbort.abort(reason);
      }

      return result.result;
    } catch (err) {
      const message = String(err?.message ?? err);
      logger?.error?.('[im-bridge] 创建 IM 审批失败:', message);
      appendImAudit(ws, {
        type: 'notify-failed',
        result: 'error',
        error: message.slice(0, 500),
        questions: questions.length,
      });
      return next();
    }
  };

  /**
   * DSH 工具权限弹窗（approval/request）也走飞书。
   * 与 user-questions 一样让 Web 和飞书先答先得；IM 先答时只 abort 子 signal，
   * 让 Web 卡片消失，不取消整个 turn。
   */
  const processApproval = async (request, next) => {
    const { agent, toolName } = request;
    if (!agent) return next();
    const ws = getWs(agent);
    if (!ws) return next();

    const originalSignal = request.signal;
    if (originalSignal?.aborted) return next();

    const localAbort = new AbortController();
    const forwardAbort = () => localAbort.abort(originalSignal?.reason);
    if (originalSignal) {
      originalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    // 下游 Web 只看到子 signal；IM 先答时 abort 它即可收起 Web 卡片，outer turn 不受影响。
    request.signal = localAbort.signal;

    const cleanupForward = () => originalSignal?.removeEventListener('abort', forwardAbort);

    // 先让 Web 弹窗出现，再发飞书卡片；任意一端先答先得。
    const webAnswer = Promise.resolve()
      .then(() => next())
      .catch((err) => {
        logger?.warn?.(`[im-bridge] approval Web answer failed: ${err?.message ?? err}`);
        return 'unavailable';
      });

    const ensured = await ensureBridge(ws);
    if (!ensured) {
      void webAnswer.finally(cleanupForward);
      return webAnswer;
    }
    const { bridge, channel, targetOpenId } = ensured;
    if (localAbort.signal.aborted) {
      void webAnswer.finally(cleanupForward);
      return webAnswer;
    }

    const title = agent.session?.title ? `DSH 权限审批 · ${agent.session.title}` : 'DSH 权限审批';
    const detail = approvalReason(request);

    let pending;
    try {
      pending = await bridge.createApproval({
        sessionId: agent.session?.id ?? agent.id,
        task: title,
        kind: 'permission',
        title,
        toolName: toolName ?? 'unknown',
        expiryMinutes: bridge.config.permissionExpiryMinutes ?? 10,
        questions: [{
          id: 'permission',
          question: detail,
          detail,
          options: [{ label: '允许一次' }, { label: '拒绝' }],
        }],
        targetOpenId,
        channel,
      });
    } catch (err) {
      const message = String(err?.message ?? err);
      logger?.error?.('[im-bridge] 创建飞书权限审批失败:', message);
      appendImAudit(ws, {
        type: 'notify-failed',
        result: 'error',
        error: message.slice(0, 500),
        tool: toolName,
      });
      void webAnswer.finally(cleanupForward);
      return webAnswer;
    }

    const imAnswer = bridge.waitForDecision(pending, { signal: localAbort.signal });
    const winner = await Promise.race([
      webAnswer.then((outcome) => ({ source: 'web', outcome })),
      imAnswer.then((outcome) => ({ source: 'im', outcome })),
    ]);

    if (winner.source === 'web' && winner.outcome !== 'unavailable') {
      // Web 先答（或 turn 被取消）：撤掉飞书卡片，按 Web 的结果返回。
      await bridge.cancelApproval(pending.approvalId, '已在 DSH 处理');
      cleanupForward();
      return winner.outcome;
    }

    if (winner.source === 'web') {
      // 没有可用的 Web 回答者（next() 直接返回 unavailable），继续等飞书。
      const outcome = await imAnswer;
      cleanupForward();
      return outcome;
    }

    // 飞书先答：只收起 Web 卡片，不取消整个 turn。
    localAbort.abort(new Error('approval answered on IM'));
    void webAnswer.catch(() => {});
    cleanupForward();
    return winner.outcome;
  };

  // 同一个 request 只处理一次（global 监听可能被多次触发）
  const handleQuestion = (request, next) => {
    const existing = handledRequests.get(request);
    if (existing) return existing;
    const pending = processQuestion(request, next);
    handledRequests.set(request, pending);
    return pending;
  };
  const handleApproval = (request, next) => {
    const existing = handledApprovals.get(request);
    if (existing) return existing;
    const pending = processApproval(request, next);
    handledApprovals.set(request, pending);
    return pending;
  };

  // DSH 的 user-questions/request 与 approval/request 都是 scope-filtered waterfall：
  // 必须 global + prepend，根 ctx 的普通监听收不到。
  disposers.push(ctx.on('user-questions/request', handleQuestion, { global: true, prepend: true }));
  disposers.push(ctx.on('approval/request', handleApproval, { global: true, prepend: true }));

  // 清理
  disposers.push(async () => {
    for (const bridge of bridges.values()) {
      await bridge.dispose();
    }
    bridges.clear();
  });

  return disposers;
}
