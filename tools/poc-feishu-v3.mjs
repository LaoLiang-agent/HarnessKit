#!/usr/bin/env node
/**
 * Feishu PoC v3: 自动测试版
 * 连接成功后自动发送卡片，不需要 REPL
 */
import lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OPEN_ID = process.env.FEISHU_OPEN_ID;

const state = {
  connected: false,
  pendingApprovals: new Map(),
  whitelist: new Set([OPEN_ID]),
};

function plainText(content) { return { tag: 'plain_text', content: String(content) }; }
function markdown(content) { return { tag: 'lark_md', content: String(content) }; }

function buildOldCard({ approvalId, title, detail, options, currentIndex, totalQuestions }) {
  const elements = [];
  if (totalQuestions > 1) elements.push({ tag: 'div', text: markdown(`**问题 ${currentIndex + 1}/${totalQuestions}**`) });
  if (detail) elements.push({ tag: 'div', text: markdown(detail) });
  elements.push({ tag: 'hr' });
  const actions = options.map((opt, i) => ({
    tag: 'button',
    text: plainText(opt.label),
    type: i === 0 ? 'primary' : 'danger',
    value: { action: `${approvalId}:${currentIndex}:${i}` },
  }));
  elements.push({ tag: 'action', actions });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { title: plainText(title), template: 'blue' }, elements });
}

function buildResultCard({ title, resultText, template = 'grey' }) {
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { title: plainText(title), template }, elements: [{ tag: 'div', text: markdown(resultText) }] });
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

async function sendCard(openId, cardJson) {
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: cardJson },
  });
  if (res?.code && res.code !== 0) throw new Error(`发送失败: ${res.msg || res.code}`);
  return res?.data?.message_id;
}

async function updateCard(messageId, cardJson) {
  const res = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: cardJson } });
  if (res?.code && res.code !== 0) throw new Error(`更新失败: ${res.msg || res.code}`);
  return messageId;
}

async function startApproval({ title, questions }) {
  const approvalId = `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pending = { approvalId, title, questions, answers: new Array(questions.length).fill(undefined), currentIndex: 0, messageId: null, expiresAt: Date.now() + 10 * 60 * 1000 };
  state.pendingApprovals.set(approvalId, pending);
  console.log(`\n📋 新审批：${approvalId}`);
  pending.messageId = await sendCard(OPEN_ID, buildOldCard({ approvalId, title, detail: questions[0].detail ?? questions[0].question, options: questions[0].options ?? [], currentIndex: 0, totalQuestions: questions.length }));
  console.log(`📤 卡片已发送：${pending.messageId}`);
  return approvalId;
}

async function handleCardAction(event) {
  const action = event?.action;
  const value = action?.value;
  if (!value?.action) return;
  const parts = String(value.action).split(':');
  if (parts.length < 3) return;
  const [approvalId, qIndexStr, optIndexStr] = parts;
  const qIndex = Number(qIndexStr);
  const optIndex = Number(optIndexStr);
  const operatorOpenId = event?.operator?.open_id;
  const msgId = event?.open_message_id;
  console.log(`\n🎯 [card.action] approval=${approvalId} q=${qIndex} opt=${optIndex} by=${operatorOpenId}`);

  if (state.whitelist.size > 0 && !state.whitelist.has(operatorOpenId)) {
    await updateCard(msgId, buildResultCard({ title: '无权限', resultText: '只有任务发起人才能处理。', template: 'red' })).catch(() => {});
    return;
  }

  const pending = state.pendingApprovals.get(approvalId);
  if (!pending) {
    await updateCard(msgId, buildResultCard({ title: '已处理', resultText: '这条审批已处理或过期。' })).catch(() => {});
    return;
  }

  if (Date.now() > pending.expiresAt) {
    await updateCard(msgId, buildResultCard({ title: '已过期', resultText: '请到 DSH 处理。', template: 'orange' })).catch(() => {});
    state.pendingApprovals.delete(approvalId);
    return;
  }

  if (pending.answers[qIndex] !== undefined) {
    await updateCard(msgId, buildResultCard({ title: '已收到', resultText: '已记录你的选择。' })).catch(() => {});
    return;
  }

  const question = pending.questions[qIndex];
  const selectedLabel = question.options?.[optIndex]?.label ?? `选项${optIndex + 1}`;
  pending.answers[qIndex] = { id: question.id, selected: [selectedLabel] };
  pending.currentIndex = Math.max(pending.currentIndex, qIndex + 1);
  console.log(`✅ 记录答案：q${qIndex + 1} = "${selectedLabel}"`);

  await updateCard(msgId, buildResultCard({ title: '已收到', resultText: `已记录：**${selectedLabel}**\n\n处理中…` })).catch(() => {});

  const nextUnanswered = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
  if (nextUnanswered === -1) {
    console.log(`\n🎉 审批完成：${approvalId}`);
    console.log('答案:', JSON.stringify(pending.answers, null, 2));
    state.pendingApprovals.delete(approvalId);
    await sendCard(OPEN_ID, buildResultCard({ title: '审批完成', resultText: `全部 ${pending.questions.length} 个问题已回答。`, template: 'green' })).catch(() => {});
  } else {
    pending.messageId = await sendCard(OPEN_ID, buildOldCard({
      approvalId, title: pending.title,
      detail: pending.questions[nextUnanswered].detail ?? pending.questions[nextUnanswered].question,
      options: pending.questions[nextUnanswered].options ?? [],
      currentIndex: nextUnanswered, totalQuestions: pending.questions.length,
    }));
    console.log(`📤 已发送问题 ${nextUnanswered + 1}/${pending.questions.length}`);
  }
}

// ── EventDispatcher ──
const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (event) => {
    const msg = event?.message;
    if (!msg) return;
    const text = msg.content ? JSON.parse(msg.content).text : '';
    console.log(`[msg] ${text}`);
    // 数字回复
    if (text && state.pendingApprovals.size > 0) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num)) {
        const pending = [...state.pendingApprovals.values()][0];
        const qIndex = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
        if (qIndex !== -1 && num >= 1 && num <= (pending.questions[qIndex].options?.length ?? 0)) {
          await handleCardAction({
            action: { value: { action: `${pending.approvalId}:${qIndex}:${num - 1}` } },
            operator: { open_id: event?.sender?.sender_id?.open_id },
            open_message_id: pending.messageId,
          });
        }
      }
    }
  },
  'card.action.trigger': (event) => {
    console.log('\n=== CARD ACTION TRIGGER ===');
    handleCardAction(event);
  },
});

// ── WSClient ──
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => {
    state.connected = true;
    console.log('✅ 飞书长连接已就绪');
    // 自动发送测试卡片
    setTimeout(async () => {
      console.log('\n🚀 自动发送测试卡片...');
      await startApproval({
        title: 'Harness Kit · 审批 1',
        questions: [{
          id: 'hk-approval-1',
          question: '是否进入开发？',
          detail: '**范围**：新增告警详情接口\n**RR**：PASS',
          options: [{ label: '✅ 通过' }, { label: '❌ 打回' }],
        }],
      });
      console.log('\n请检查飞书私聊，点击按钮测试。');
      console.log('也可以回复数字 1 或 2 代替点击按钮。\n');
    }, 1000);
  },
  onError: (err) => { state.connected = false; console.error('❌ 连接错误:', err?.message ?? err); },
  onReconnecting: () => { state.connected = false; console.log('🔄 重连中…'); },
  onReconnected: () => { state.connected = true; console.log('✅ 重连成功'); },
});

console.log('正在启动飞书 WSClient…');
wsClient.start({ eventDispatcher: dispatcher });

process.on('SIGINT', () => { console.log('\n断开连接'); wsClient.close(); process.exit(0); });
