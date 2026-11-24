// IM 桥接安装：监听 user-questions/request waterfall，识别 HK 标记，发卡片到 IM
// 这是 kernel/im/ 模块与 DSH userQuestions 服务的接线层

import { ApprovalBridge } from './im/bridge.js';
import { readImConfig, hasEnabledChannel } from './im/config.js';
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

/** 安装 IM 桥接 */
export function installImBridge(ctx) {
  const logger = ctx.get('logger');
  const userQuestions = ctx.get('userQuestions');
  const disposers = [];
  const bridges = new Map(); // ws -> ApprovalBridge
  const handledRequests = new WeakMap(); // request -> Promise，避免 global/agent 双监听重复处理

  // 监听 user-questions/request waterfall。
  // 该事件按 Agent scope 过滤：必须注册在 agent.ctx 上，根 ctx 的全局监听收不到。
  const processQuestion = async (request, next) => {
    const { agent, questions } = request;
    if (!agent || !questions || questions.length === 0) {
      return next();
    }

    // 检查是否有 HK 标记的问题
    const hkQuestions = questions.filter(isHkQuestion);
    if (hkQuestions.length === 0) {
      return next();
    }

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
    for (const q of hkQuestions) {
      const imDetail = q.imDetail ?? q.detail;
      if (imDetail !== undefined) imDetails.set(q.id ?? q.question, imDetail);
      delete q.detail;
      delete q.imDetail;
    }

    const ws = getWs(agent);
    if (!ws) {
      logger?.warn?.('[im-bridge] 无法获取工作区路径，跳过 IM 通知');
      return next();
    }

    // 获取或创建该工作区的 bridge
    let bridge = bridges.get(ws);
    if (!bridge) {
      const config = readImConfig(ws);
      if (!hasEnabledChannel(config)) {
        // 未配置 IM，直接走 Web
        return next();
      }
      bridge = new ApprovalBridge({ ws, logger, userQuestions });
      await bridge.init();
      bridges.set(ws, bridge);
    }

    // 找到第一个启用的渠道
    const channel = Object.entries(bridge.config.channels).find(([, c]) => c.enabled)?.[0];
    if (!channel) {
      return next();
    }

    const channelConfig = bridge.config.channels[channel];
    const targetOpenId = channelConfig.targetOpenId;
    if (!targetOpenId) {
      logger?.warn?.('[im-bridge] 未绑定目标用户，跳过 IM 通知');
      return next();
    }

    // 提取任务名
    const task = extractTaskName(hkQuestions[0]) ?? '未知任务';

    try {
      // 创建 IM 审批
      const pending = await bridge.createApproval({
        sessionId: agent.session?.id ?? agent.id,
        task,
        questions: hkQuestions.map((q) => ({
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
      logger?.error?.('[im-bridge] 创建 IM 审批失败:', err?.message ?? err);
      return next();
    }
  };

  // global 与 agent-scoped 都注册；同一个 request 只处理一次（谁先到用谁）
  const handleQuestion = (request, next) => {
    const existing = handledRequests.get(request);
    if (existing) return existing;
    const pending = processQuestion(request, next);
    handledRequests.set(request, pending);
    return pending;
  };

  // DSH 的 user-questions/request 是 scope-filtered waterfall：必须 global + prepend
  disposers.push(ctx.on('user-questions/request', handleQuestion, { global: true, prepend: true }));

  // 清理
  disposers.push(async () => {
    for (const bridge of bridges.values()) {
      await bridge.dispose();
    }
    bridges.clear();
  });

  return disposers;
}
