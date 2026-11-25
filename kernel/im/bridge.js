// IM 审批桥接：监听 user-questions/request，识别 HK 标记，发卡片到 IM
// 核心逻辑：Promise.race(Web 回答, IM 回答)，先到先得

import { readImConfig, appendImAudit, hasEnabledChannel } from './config.js';
import { getTransport, listChannels } from './transport.js';
import { buildApprovalCard, buildResultCard, buildCustomTextCard, parseActionValue, displayOptionLabel } from './cards.js';

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
    this.awaitingCustom = null; // 选择了需要补充说明的选项时，等待用户回复文字
    this.customFormMessageId = null; // 补充说明表单卡片的消息 ID
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
  constructor({ ws, logger, userQuestions, config }) {
    this.ws = ws;
    this.logger = logger ?? console;
    this.userQuestions = userQuestions;
    this.config = config ?? readImConfig(ws);
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
        const message = String(err?.message ?? err);
        this.logger.error?.(`[im] ${channel} 连接失败:`, message);
        appendImAudit(this.ws, { type: 'connect-failed', channel, result: 'error', error: message.slice(0, 500) });
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
    // 卡片内表单提交：action.form_value 携带输入框内容，不依赖文本消息事件
    if (action?.form_value && typeof action.form_value === 'object') {
      await this._handleCustomFormSubmit(event, action.form_value, channel);
      return;
    }
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

    // 已要求补充说明：先等文字，避免误当成新的选择
    if (pending.awaitingCustom) {
      await this._updateCard(pending, buildResultCard({ title: '请补充说明', resultText: '请直接回复文字补充说明；补充完成后才能继续。', template: 'orange' }));
      return;
    }

    // 重复点击
    if (pending.answers[qIndex] !== undefined) {
      this.logger.info?.(`[im] 重复点击: q=${qIndex}`);
      await this._updateCard(pending, buildResultCard({ title: '已收到', resultText: '已记录你的选择。' }));
      return;
    }

    const question = pending.questions[qIndex];
    const option = question.options?.[optIndex];
    const selectedLabel = option?.label ?? `选项${optIndex + 1}`;

    // 需要补充说明的选项：先记录待补充状态，收到文字后再落答案
    if (this._requiresCustomText(option)) {
      pending.awaitingCustom = { qIndex, label: selectedLabel };
      this.logger.info?.(`[im] 等待补充说明: q${qIndex + 1} = "${selectedLabel}"`);
      try {
        const card = buildCustomTextCard({
          approvalId,
          qIndex,
          label: selectedLabel,
          detail: question.detail ?? question.question,
          expiresAt: pending.expiresAt,
        });
        pending.customFormMessageId = await this._sendCard(pending.targetOpenId, card, pending.channel);
      } catch (err) {
        this.logger.warn?.(`[im] 补充说明表单发送失败: ${err?.message ?? err}`);
        await this._updateCard(pending, buildResultCard({
          title: '请补充说明',
          resultText: `你选择了「${displayOptionLabel(selectedLabel)}」。

请直接回复文字补充说明。`,
          template: 'orange',
        }));
      }
      return;
    }

    await this._recordAndAdvance(pending, qIndex, { id: question.id, selected: [selectedLabel] }, operatorId);
  }

  /** 处理卡片内表单提交（补充说明） */
  async _handleCustomFormSubmit(event, formValue, channel) {
    const operatorId = event?.operator?.open_id ?? event?.operator?.user_id;
    const msgId = event?.open_message_id ?? event?.message_id;
    const candidates = [...this.pendingApprovals.values()]
      .filter((p) => p.awaitingCustom)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const pending = candidates.find((p) => p.customFormMessageId && p.customFormMessageId === msgId) ?? candidates[0];
    if (!pending) {
      this.logger.warn?.('[im] 收到表单提交但没有等待补充的审批');
      return;
    }
    if (!this._isAllowed(pending, operatorId)) {
      this.logger.warn?.(`[im] 非本人提交补充说明: ${operatorId}`);
      return;
    }
    if (pending.isExpired) {
      this.logger.info?.(`[im] 补充说明已过期: ${pending.approvalId}`);
      this.pendingApprovals.delete(pending.approvalId);
      return;
    }
    const text = String(Object.values(formValue)[0] ?? '').trim();
    if (!text) {
      await this._updateCard(pending, buildResultCard({ title: '请补充说明', resultText: '补充说明不能为空，请重新填写。', template: 'orange' }));
      return;
    }
    const { qIndex, label } = pending.awaitingCustom;
    const question = pending.questions[qIndex];
    this.logger.info?.(`[im] 收到补充说明: q${qIndex + 1} len=${text.length}`);
    await this._recordAndAdvance(pending, qIndex, {
      id: question.id,
      selected: label ? [label] : [],
      custom: text,
    }, operatorId);
  }

  /** 该选项是否必须附带文字说明（常见于“其他/额外范围/需要补充”类选项） */
  _requiresCustomText(option) {
    const text = `${option?.label ?? ''} ${option?.description ?? ''}`;
    return /(?:\[|（|\()\s*需?补充(?:说明)?\s*(?:\]|）|\))|额外范围|其他(?:范围|说明|情况)?|自定义|手动输入|请补充|请说明|需说明/.test(text);
  }

  /** 是否允许该操作者处理此审批：仅私聊目标本人（不做白名单） */
  _isAllowed(pending, actor) {
    if (!actor) return false;
    return actor === pending.targetOpenId;
  }

  /** 记录一题答案并推进（按钮与文本回复共用） */
  async _recordAndAdvance(pending, qIndex, answerItem, actor) {
    pending.answers[qIndex] = answerItem;
    pending.currentIndex = Math.max(pending.currentIndex, qIndex + 1);
    pending.awaitingCustom = null;
    pending.customFormMessageId = null;
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
    const trimmed = String(text).trim();
    this.logger.info?.(`[im] 收到文本回复 sender=${senderOpenId} len=${trimmed.length} awaiting=${[...this.pendingApprovals.values()].filter((p) => p.awaitingCustom).length}`);
    if (!trimmed) return;

    // 优先处理“等待补充说明”的审批：此时文字是补充内容，不是选项
    const awaiting = [...this.pendingApprovals.values()]
      .filter((p) => p.awaitingCustom)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (awaiting) {
      if (!this._isAllowed(awaiting, senderOpenId) || awaiting.isExpired) return;
      const { qIndex, label } = awaiting.awaitingCustom;
      const question = awaiting.questions[qIndex];
      await this._recordAndAdvance(awaiting, qIndex, { id: question.id, selected: [label], custom: trimmed }, senderOpenId);
      return;
    }

    const candidates = [...this.pendingApprovals.values()]
      .filter((p) => p.answers.some((a) => a === undefined))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const pending = candidates[0];
    if (!pending || !this._isAllowed(pending, senderOpenId) || pending.isExpired) return;

    const qIndex = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
    if (qIndex === -1) return;
    const question = pending.questions[qIndex];
    const options = question.options ?? [];

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
      const matched = options.find((o) => o.label === trimmed || displayOptionLabel(o.label) === trimmed)
        ?? options.find((o) => trimmed && (o.label.includes(trimmed) || displayOptionLabel(o.label).includes(trimmed)));
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
          ...(a?.custom ? { custom: a.custom } : {}),
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
    const options = q.options ?? [];
    // 无选项的澄清题：用卡片内表单收集文字，不依赖文本消息事件
    if (options.length === 0) {
      pending.awaitingCustom = { qIndex, label: null };
      try {
        const card = buildCustomTextCard({
          approvalId: pending.approvalId,
          qIndex,
          label: null,
          detail: q.imDetail ?? q.detail ?? q.question,
          expiresAt: pending.expiresAt,
          title: '请回答',
        });
        pending.customFormMessageId = await this._sendCard(pending.targetOpenId, card, pending.channel);
        return pending.customFormMessageId;
      } catch (err) {
        pending.awaitingCustom = null;
        throw err;
      }
    }
    const card = buildApprovalCard({
      approvalId: pending.approvalId,
      title: pending.task ? `Harness Kit · ${pending.task}` : 'Harness Kit · 审批',
      detail: q.imDetail ?? q.detail ?? q.question,
      options,
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

    // 发送第一题卡片；失败时清掉 pending，避免留下永不完成的审批
    try {
      pending.messageId = await this._sendQuestionCard(pending, 0);
    } catch (err) {
      this.pendingApprovals.delete(approvalId);
      throw err;
    }
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
