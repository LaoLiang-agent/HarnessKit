#!/usr/bin/env node
/**
 * Feishu PoC v2: 修复卡片回调 + 数字回复备选
 *
 * 修复：飞书 SDK 1.73.0 会忽略 type=card 的长连接帧
 * 方案：监听原始 WS 消息，手动解析 card.action.trigger
 */
import lark from '@larksuiteoapi/node-sdk';
import readline from 'node:readline';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OPEN_ID = process.env.FEISHU_OPEN_ID;

const state = {
  connected: false,
  pendingApprovals: new Map(),
  whitelist: new Set([OPEN_ID]),
  auditLog: [],
};

function audit(event) {
  const entry = { at: new Date().toISOString(), ...event };
  state.auditLog.push(entry);
  console.log(`[audit] ${entry.at} ${event.type} approval=${event.approvalId ?? '-'} result=${event.result ?? '-'}`);
}

function generateApprovalId() {
  return `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}
function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

/** 旧版卡片格式（不需要 cardkit，支持按钮） */
function buildOldCard({ approvalId, title, detail, options, currentIndex, totalQuestions, expiresAt }) {
  const elements = [];

  if (totalQuestions > 1) {
    elements.push({ tag: 'div', text: markdown(`**问题 ${currentIndex + 1}/${totalQuestions}**`) });
  }
  if (detail) {
    elements.push({ tag: 'div', text: markdown(detail) });
  }
  elements.push({ tag: 'hr' });

  // 按钮：旧版用 action 元素
  const actions = options.map((opt, i) => ({
    tag: 'button',
    text: plainText(opt.label),
    type: i === 0 ? 'primary' : 'danger',
    value: { action: `${approvalId}:${currentIndex}:${i}` },
  }));
  elements.push({ tag: 'action', actions });

  if (expiresAt) {
    const mins = Math.round((expiresAt - Date.now()) / 60000);
    elements.push({ tag: 'div', text: markdown(`\n\n⏱ 有效期约 ${mins} 分钟`) });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: plainText(title), template: 'blue' },
    elements,
  });
}

function buildResultCard({ title, resultText, template = 'grey' }) {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: plainText(title), template },
    elements: [{ tag: 'div', text: markdown(resultText) }],
  });
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
  const res = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: cardJson },
  });
  if (res?.code && res.code !== 0) throw new Error(`更新失败: ${res.msg || res.code}`);
  return messageId;
}

async function startApproval({ title, questions, expiresInMinutes = 120 }) {
  const approvalId = generateApprovalId();
  const pending = {
    approvalId,
    title,
    questions,
    answers: new Array(questions.length).fill(undefined),
    currentIndex: 0,
    messageId: null,
    status: 'pending',
    expiresAt: Date.now() + expiresInMinutes * 60 * 1000,
  };
  state.pendingApprovals.set(approvalId, pending);

  console.log(`\n📋 新审批：${approvalId}（${questions.length} 个问题）`);
  pending.messageId = await sendCard(OPEN_ID, buildOldCard({
    approvalId,
    title,
    detail: questions[0].detail ?? questions[0].question,
    options: questions[0].options ?? [],
    currentIndex: 0,
    totalQuestions: questions.length,
    expiresAt: pending.expiresAt,
  }));
  console.log(`📤 卡片已发送：${pending.messageId}`);
  audit({ type: 'started', approvalId, result: 'pending' });
  return approvalId;
}

// ── 处理卡片按钮点击 ──
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

  console.log(`[card.action] approval=${approvalId} q=${qIndex} opt=${optIndex} by=${operatorOpenId}`);

  // 白名单
  if (state.whitelist.size > 0 && !state.whitelist.has(operatorOpenId)) {
    console.log(`⛔ 非白名单：${operatorOpenId}`);
    await updateCard(msgId, buildResultCard({ title: '无权限', resultText: '只有任务发起人才能处理。', template: 'red' })).catch(() => {});
    return;
  }

  const pending = state.pendingApprovals.get(approvalId);
  if (!pending) {
    console.log(`⚠️  未知审批：${approvalId}`);
    await updateCard(msgId, buildResultCard({ title: '已处理', resultText: '这条审批已处理或过期。' })).catch(() => {});
    return;
  }

  // 过期
  if (Date.now() > pending.expiresAt) {
    console.log(`⏰ 已过期：${approvalId}`);
    await updateCard(msgId, buildResultCard({ title: '已过期', resultText: '请到 DSH 处理。', template: 'orange' })).catch(() => {});
    state.pendingApprovals.delete(approvalId);
    return;
  }

  // 重复点击
  if (pending.answers[qIndex] !== undefined) {
    console.log(`⚠️  重复点击：q=${qIndex}`);
    await updateCard(msgId, buildResultCard({ title: '已收到', resultText: '已记录你的选择。' })).catch(() => {});
    return;
  }

  // 记录答案
  const question = pending.questions[qIndex];
  const selectedLabel = question.options?.[optIndex]?.label ?? `选项${optIndex + 1}`;
  pending.answers[qIndex] = { id: question.id, selected: [selectedLabel] };
  pending.currentIndex = Math.max(pending.currentIndex, qIndex + 1);

  console.log(`✅ 记录答案：q${qIndex + 1} = "${selectedLabel}"`);

  // 5 秒内更新卡片
  await updateCard(msgId, buildResultCard({ title: '已收到', resultText: `已记录：**${selectedLabel}**\n\n处理中…` })).catch(() => {});

  // 下一题或完成
  const nextUnanswered = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
  if (nextUnanswered === -1) {
    console.log(`\n🎉 审批完成：${approvalId}`);
    console.log('   答案:', JSON.stringify(pending.answers, null, 2));
    state.pendingApprovals.delete(approvalId);
    await sendCard(OPEN_ID, buildResultCard({ title: '审批完成', resultText: `全部 ${pending.questions.length} 个问题已回答。`, template: 'green' })).catch(() => {});
    audit({ type: 'completed', approvalId, result: 'completed' });
  } else {
    pending.messageId = await sendCard(OPEN_ID, buildOldCard({
      approvalId,
      title: pending.title,
      detail: pending.questions[nextUnanswered].detail ?? pending.questions[nextUnanswered].question,
      options: pending.questions[nextUnanswered].options ?? [],
      currentIndex: nextUnanswered,
      totalQuestions: pending.questions.length,
      expiresAt: pending.expiresAt,
    }));
    console.log(`📤 已发送问题 ${nextUnanswered + 1}/${pending.questions.length}`);
  }
}

// ── EventDispatcher ──
const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (event) => {
    const msg = event?.message;
    if (!msg) return;
    const chatType = msg.chat_type;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    const text = msg.content ? JSON.parse(msg.content).text : '';

    console.log(`[msg] ${senderOpenId}: ${text}`);

    // 数字回复处理（备选方案）
    if (text && state.pendingApprovals.size > 0) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num)) {
        const pending = [...state.pendingApprovals.values()][0];
        const qIndex = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
        if (qIndex !== -1 && num >= 1 && num <= (pending.questions[qIndex].options?.length ?? 0)) {
          // 模拟按钮点击
          await handleCardAction({
            action: { value: { action: `${pending.approvalId}:${qIndex}:${num - 1}` } },
            operator: { open_id: senderOpenId },
            open_message_id: pending.messageId,
          });
        }
      }
    }
  },
  'card.action.trigger': (event) => {
    console.log('\n=== CARD ACTION TRIGGER ===');
    console.log(JSON.stringify(event, null, 2).slice(0, 1000));
    handleCardAction(event);
  },
});

// ── WSClient with raw message hack ──
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => {
    state.connected = true;
    console.log('✅ 飞书长连接已就绪');
    console.log('   输入 test1 发送单问题审批');
    console.log('   输入 test3 发送多问题澄清');
    console.log('   输入 q 退出\n');
    prompt();
  },
  onError: (err) => {
    state.connected = false;
    console.error('❌ 连接错误:', err?.message ?? err);
  },
  onReconnecting: () => { state.connected = false; console.log('🔄 重连中…'); },
  onReconnected: () => { state.connected = true; console.log('✅ 重连成功'); },
});

// 关键修复：监听原始 WS 消息，捕获 SDK 忽略的 type=card 帧
const originalOnMessage = wsClient.onmessage;
wsClient.onmessage = (data) => {
  try {
    const frame = JSON.parse(data);
    if (frame?.type === 'card' || frame?.header?.event_type === 'card.action.trigger') {
      console.log('\n>>> RAW CARD FRAME:', JSON.stringify(frame).slice(0, 500));
      // 手动分发给 dispatcher
      dispatcher.invoke(frame).catch((e) => console.error('dispatch error:', e));
      return;
    }
  } catch { /* not JSON */ }
  if (originalOnMessage) originalOnMessage.call(wsClient, data);
};

console.log('正在启动飞书 WSClient…');
wsClient.start({ eventDispatcher: dispatcher });

// ── REPL ──
let rl = null;
function ensurePrompt() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('poc> ', handleCommand);
}
function prompt() { ensurePrompt(); }

async function handleCommand(line) {
  const cmd = line.trim();
  if (!cmd) return prompt();

  if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
    console.log('再见');
    wsClient.close();
    process.exit(0);
  }

  if (cmd === 'list') {
    if (state.pendingApprovals.size === 0) console.log('（无进行中的审批）');
    for (const [id, p] of state.pendingApprovals) {
      const answered = p.answers.filter(Boolean).length;
      console.log(`  ${id}  ${p.title}  ${answered}/${p.questions.length}`);
    }
    return prompt();
  }

  if (cmd === 'audit') {
    for (const e of state.auditLog) console.log(`  ${e.at}  ${e.type}  ${e.approvalId ?? '-'}  ${e.result ?? ''}`);
    return prompt();
  }

  if (cmd === 'test1') {
    await startApproval({
      title: 'Harness Kit · 审批 1',
      questions: [{
        id: 'hk-approval-1',
        question: '是否进入开发？',
        detail: '**范围**：新增告警详情接口\n**RR**：PASS\n**风险**：涉及 2 个仓库',
        options: [{ label: '✅ 通过' }, { label: '❌ 打回' }],
      }],
    });
    return prompt();
  }

  if (cmd === 'test3') {
    await startApproval({
      title: 'Harness Kit · 澄清',
      questions: [
        { id: 'q1', question: '问题一？', detail: '描述一', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '问题二？', detail: '描述二', options: [{ label: 'C' }, { label: 'D' }] },
        { id: 'q3', question: '问题三？', detail: '描述三', options: [{ label: 'E' }, { label: 'F' }] },
      ],
    });
    return prompt();
  }

  console.log('未知命令。可用：list, audit, test1, test3, q');
  prompt();
}

process.on('SIGINT', () => {
  console.log('\n断开连接');
  wsClient.close();
  process.exit(0);
});
