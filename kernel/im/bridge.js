// IM 审批桥接：监听 user-questions/request，识别 HK 标记，发卡片到 IM
// 核心逻辑：Promise.race(Web 回答, IM 回答)，先到先得

import { readImConfig, appendImAudit, hasEnabledChannel } from './config.js';
import { getTransport, listChannels } from './transport.js';
import { buildApprovalCard, buildResultCard, parseActionValue } from './cards.js';

/** 审批记录 */
class PendingApproval {
  constructor({ approvalId, sessionId, task, questions, expiresAt, targetOpenId, channel }) {
    this.approvalId = approvalId;
    this.sessionId = sessionId;
    this.task = task;
    this.questions = questions;
    this.answers = new Array(questions.length).fill(undefined);
    this.currentIndex = 0;
    this.messageId = null;
    this.status = 'pending';
    this.expiresAt = expiresAt;
    this.targetOpenId = targetOpenId;
    this.channel = channel;
    this.createdAt = Date.now();
  }

  get answeredCount() {
    return this.answers.filter(Boolean).length;
  }

  get isComplete() {
    return this.answers.every((a) => a !== undefined);
  }

  get isExpired() {
    return Date.now() > this.expiresAt;
  }
}

/** IM 审批桥接器 */
export class ApprovalBridge {
  constructor({ ws, logger, userQuestions }) {
    this.ws = ws;
    this.logger = logger ?? console;
    this.userQuestions = userQuestions;
    this.config = readImConfig(ws);
    this.transports = new Map();
    this.pendingApprovals = new Map(); // approvalId -> PendingApproval
    this.disposers = [];
  }

  /** 初始化：连接所有启用的渠道 */
  async init() {
    if (!hasEnabledChannel(this.config)) {
      this.logger.info?.('[im] 未启用任何 IM 渠道，跳过初始化');
      return;
    }

    for (const [channel, channelConfig] of Object.entries(this.config.channels)) {
      if (!channelConfig.enabled) continue;
      const factory = getTransport(channel);
      if (!factory) {
        this.logger.warn?.(`[im] 渠道 ${channel} 未注册 transport，跳过`);
        continue;
      }
      try {
        const transport = factory(channelConfig, this.logger);
        await transport.connect();
        this.transports.set(channel, transport);
        this._wireTransport(transport, channel);
        this.logger.info?.(`[im] ${channel} 已连接`);
      } catch (err) {
        this.logger.error?.(`[im] ${channel} 连接失败:`, err?.message ?? err);
      }
    }
  }

  /** 断开所有连接 */
  async dispose() {
    for (const [channel, transport] of this.transports) {
      try { transport.disconnect(); } catch { /* ignore */ }
    }
    this.transports.clear();
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  /** 监听 transport 的卡片回调和消息 */
  _wireTransport(transport, channel) {
    transport.onCardAction((event) => this._handleCardAction(event, channel));
    transport.onMessage((msg) => this._handleMessage(msg, channel));
  }

  /** 处理卡片按钮点击 */
  async _handleCardAction(event, channel) {
    const action = event?.action;
    const value = action?.value;
    if (!value?.action) return;

    const parsed = parseActionValue(value.action);
    if (!parsed) return;

    const { approvalId, qIndex, optIndex } = parsed;
    const operatorId = event?.operator?.open_id ?? event?.operator?.user_id;
    const msgId = event?.open_message_id ?? event?.message_id;

    this.logger.info?.(`[im] 卡片点击: approval=${approvalId} q=${qIndex} opt=${optIndex} by=${operatorId}`);

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      this.logger.warn?.(`[im] 未知审批: ${approvalId}`);
      return;
    }

    // 白名单校验：显式白名单优先；未配置时只允许私聊目标本人（群聊默认拒绝）
    if (!this._isAllowed(pending, operatorId)) {
      this.logger.warn?.(`[im] 非白名单用户: ${operatorId}`);
      await this._updateCard(pending, buildResultCard({ title: '无权限', resultText: '只有任务发起人才能处理这条审批。', template: 'red' }));
      appendImAudit(this.ws, { type: 'rejected', approvalId, actor: operatorId, result: 'not-allowed' });
      return;
    }

    // 过期校验
    if (pending.isExpired) {
      this.logger.info?.(`[im] 审批已过期: ${approvalId}`);
      await this._updateCard(pending, buildResultCard({ title: '已过期', resultText: '这条审批已过期，请到 DSH 处理。', template: 'orange' }));
      this.pendingApprovals.delete(approvalId);
      appendImAudit(this.ws, { type: 'expired', approvalId, actor: operatorId, result: 'expired' });
      return;
    }

    // 重复点击
    if (pending.answers[qIndex] !== undefined) {
      this.logger.info?.(`[im] 重复点击: q=${qIndex}`);
      await this._updateCard(pending, buildResultCard({ title: '已收到', resultText: '已记录你的选择。' }));
      return;
    }

    const question = pending.questions[qIndex];
    const selectedLabel = question.options?.[optIndex]?.label ?? `选项${optIndex + 1}`;
    await this._recordAndAdvance(pending, qIndex, { id: question.id, selected: [selectedLabel] }, operatorId);
  }

  /** 是否允许该操作者处理此审批 */
  _isAllowed(pending, actor) {
    if (!actor) return false;
    const whitelist = this.config.channels[pending.channel]?.whitelist ?? [];
    if (whitelist.length > 0) return whitelist.includes(actor);
    // 未配置白名单：私聊时 targetOpenId 就是用户 open_id，只允许本人；群聊默认拒绝
    return actor === pending.targetOpenId;
  }

  /** 记录一题答案并推进（按钮与文本回复共用） */
  async _recordAndAdvance(pending, qIndex, answerItem, actor) {
    pending.answers[qIndex] = answerItem;
    pending.currentIndex = Math.max(pending.currentIndex, qIndex + 1);
    const display = answerItem.custom || (answerItem.selected ?? []).join(', ') || '（空）';
    this.logger.info?.(`[im] 记录答案: q${qIndex + 1} = "${display}"`);

    // 5 秒内更新卡片
    await this._updateCard(pending, buildResultCard({ title: '已收到', resultText: `已记录：**${display}**\n\n处理中…` }));

    if (pending.isComplete) {
      this.logger.info?.(`[im] 审批完成: ${pending.approvalId}`);
      this.pendingApprovals.delete(pending.approvalId);
      await this._sendCard(pending.targetOpenId, buildResultCard({
        title: '审批完成',
        resultText: `全部 ${pending.questions.length} 个问题已回答。`,
        template: 'green',
      }), pending.channel);
      appendImAudit(this.ws, { type: 'completed', approvalId: pending.approvalId, actor, result: 'completed' });
      await this._resolveToDSH(pending);
    } else {
      const nextUnanswered = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
      pending.messageId = await this._sendQuestionCard(pending, nextUnanswered);
      this.logger.info?.(`[im] 已发送问题 ${nextUnanswered + 1}/${pending.questions.length}`);
    }
  }

  /** 处理文本消息：数字选选项、选项文字匹配，或作为澄清问题的自定义答案 */
  async _handleMessage({ text, senderOpenId }, channel) {
    if (!text || !senderOpenId) return;
    const candidates = [...this.pendingApprovals.values()]
      .filter((p) => p.answers.some((a) => a === undefined))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const pending = candidates[0];
    if (!pending || !this._isAllowed(pending, senderOpenId) || pending.isExpired) return;

    const qIndex = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
    if (qIndex === -1) return;
    const question = pending.questions[qIndex];
    const options = question.options ?? [];
    const trimmed = String(text).trim();

    // 1) 数字 → 对应选项
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num >= 1 && num <= options.length) {
        await this._recordAndAdvance(pending, qIndex, { id: question.id, selected: [options[num - 1].label] }, senderOpenId);
        return;
      }
    }
    // 2) 选项文字精确/包含匹配
    if (options.length > 0) {
      const matched = options.find((o) => o.label === trimmed) ?? options.find((o) => trimmed && o.label.includes(trimmed));
      if (matched) {
        await this._recordAndAdvance(pending, qIndex, { id: question.id, selected: [matched.label] }, senderOpenId);
        return;
      }
    }
    // 3) 自由文本 → 澄清类问题的自定义答案
    await this._recordAndAdvance(pending, qIndex, { id: question.id, selected: [], custom: trimmed }, senderOpenId);
  }

  /** 把答案提交回 DSH */
  async _resolveToDSH(pending) {
    if (!this.userQuestions) return;
    try {
      const answer = {
        answers: pending.answers.map((a, i) => ({
          id: pending.questions[i].id,
          selected: a?.selected ?? [],
        })),
      };
      // 通过 userQuestions.answer 提交（用于 continued 状态的问题）
      // 或者通过 waterfall resolve（用于进行中的问题）
      // 这里需要根据 DSH 的 user-questions 服务接口来调整
      this.logger.info?.(`[im] 答案已准备提交到 DSH: ${JSON.stringify(answer)}`);
      // TODO: 实际提交逻辑在 waterfall 监听器中实现
    } catch (err) {
      this.logger.error?.('[im] 提交答案到 DSH 失败:', err?.message ?? err);
    }
  }

  /** 发送卡片 */
  async _sendCard(targetId, cardJson, channel) {
    const transport = this.transports.get(channel);
    if (!transport) throw new Error(`渠道 ${channel} 未连接`);
    return transport.sendCard(targetId, cardJson);
  }

  /** 更新卡片 */
  async _updateCard(pending, cardJson) {
    if (!pending.messageId) return;
    try {
      await this._sendCard(pending.targetOpenId, cardJson, pending.channel);
    } catch (err) {
      this.logger.warn?.(`[im] 更新卡片失败: ${err?.message ?? err}`);
    }
  }

  /** 发送问题卡片 */
  async _sendQuestionCard(pending, qIndex) {
    const q = pending.questions[qIndex];
    const card = buildApprovalCard({
      approvalId: pending.approvalId,
      title: pending.task ? `Harness Kit · ${pending.task}` : 'Harness Kit · 审批',
      detail: q.detail ?? q.question,
      options: q.options ?? [],
      currentIndex: qIndex,
      totalQuestions: pending.questions.length,
      expiresAt: pending.expiresAt,
    });
    return this._sendCard(pending.targetOpenId, card, pending.channel);
  }

  /** 创建新审批（由 waterfall 监听器调用） */
  async createApproval({ sessionId, task, questions, targetOpenId, channel }) {
    const approvalId = `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const pending = new PendingApproval({
      approvalId,
      sessionId,
      task,
      questions,
      expiresAt: Date.now() + this.config.approvalExpiryMinutes * 60 * 1000,
      targetOpenId,
      channel,
    });
    this.pendingApprovals.set(approvalId, pending);

    // 发送第一题卡片
    pending.messageId = await this._sendQuestionCard(pending, 0);
    this.logger.info?.(`[im] 新审批: ${approvalId}（${questions.length} 个问题）`);
    appendImAudit(this.ws, { type: 'started', approvalId, result: 'pending' });

    return pending;
  }

  /** 获取审批状态 */
  getApproval(approvalId) {
    return this.pendingApprovals.get(approvalId);
  }

  /** 取消审批（Web 先回答时） */
  async cancelApproval(approvalId, reason = '已在 DSH 处理') {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    this.pendingApprovals.delete(approvalId);
    await this._updateCard(pending, buildResultCard({ title: '已处理', resultText: reason }));
    appendImAudit(this.ws, { type: 'cancelled', approvalId, result: reason });
  }

  /** 获取所有进行中的审批 */
  listPending() {
    return [...this.pendingApprovals.values()];
  }
}
