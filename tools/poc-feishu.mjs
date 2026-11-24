#!/usr/bin/env node
/**
 * Harness Kit · Feishu Approval Bridge PoC
 *
 * 验证目标：
 *  1. 飞书长连接稳定（WSClient + EventDispatcher）
 *  2. 私聊目标绑定（用户发消息 → 记录 open_id）
 *  3. 主动发送 button_interaction 卡片（im.message.create, msg_type=interactive）
 *  4. card.action.trigger → 更新卡片（im.message.patch）
 *  5. 多问题逐题卡（第一张答完发第二张，全部答完一次性提交）
 *  6. 边界：重复点击 / 过期 / 非白名单 / 断网重连
 *
 * 用法：
 *   node tools/poc-feishu.mjs \
 *     --app-id cli_xxx \
 *     --app-secret xxx \
 *     [--open-id ou_xxx]          # 跳过等待私聊，直接指定目标
 *     [--test]                    # 连接成功后自动跑完整测试
 *
 * 前置条件：
 *   - 飞书自建应用已开启机器人能力
 *   - 权限：im:message, im:message.receive_v1, card.action.trigger
 *   - 事件订阅：im.message.receive_v1（私聊消息）
 *   - 长连接模式已开启
 */

import lark from '@larksuiteoapi/node-sdk';
import readline from 'node:readline';

// ────────────────────────────── 配置 ──────────────────────────────

const args = parseArgs(process.argv.slice(2));
const APP_ID = args['app-id'] || process.env.FEISHU_APP_ID;
const APP_SECRET = args['app-secret'] || process.env.FEISHU_APP_SECRET;
const FORCE_OPEN_ID = args['open-id'] || null;
const AUTO_TEST = args['test'] === true;

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 --app-id / --app-secret（或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）');
  process.exit(1);
}

// ────────────────────────────── 状态 ──────────────────────────────

const state = {
  connected: false,
  targetOpenId: FORCE_OPEN_ID,   // 私聊目标
  targetName: null,
  pendingApprovals: new Map(),   // approvalId → { questions, answers, currentIndex, messageId, cardId, status, expiresAt }
  whitelist: new Set(),          // 允许点击的用户 open_id
  auditLog: [],
};

// ────────────────────────────── 工具 ──────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

function audit(event) {
  const entry = { at: new Date().toISOString(), ...event };
  state.auditLog.push(entry);
  console.log(`[audit] ${entry.at} ${event.type} approval=${event.approvalId ?? '-'} actor=${event.actor ?? '-'} result=${event.result ?? '-'}`);
}

function generateApprovalId() {
  return `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s, max = 80) {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ────────────────────────────── 卡片构造 ──────────────────────────────

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}
function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

function buttonElement(content, actionValue) {
  return {
    tag: 'button',
    text: plainText(content),
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { action: actionValue } }],
  };
}

/** 按钮必须放在 column_set > column > elements 里 */
function buttonRow(buttons) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: buttons.map((btn) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [btn],
    })),
  };
}

function buttonPair(leftContent, leftAction, rightContent, rightAction) {
  return buttonRow([
    buttonElement(leftContent, leftAction),
    buttonElement(rightContent, rightAction),
  ]);
}

/** 审批卡片 JSON（schema 2.0，发给 im.message.create 的 content 字段） */
function buildApprovalCard({ approvalId, title, detail, options, currentIndex, totalQuestions, expiresAt }) {
  const elements = [];

  // 进度指示
  if (totalQuestions > 1) {
    elements.push({ tag: 'div', text: markdown(`**问题 ${currentIndex + 1}/${totalQuestions}**`) });
  }

  // 摘要
  if (detail) {
    elements.push({ tag: 'div', text: markdown(detail) });
  }

  elements.push({ tag: 'hr' });

  // 按钮
  if (options.length === 2) {
    elements.push(buttonPair(
      options[0].label, `${approvalId}:${currentIndex}:0`,
      options[1].label, `${approvalId}:${currentIndex}:1`,
    ));
  } else {
    // 单按钮或 >2 选项：每个按钮一行
    for (let i = 0; i < options.length; i++) {
      elements.push(buttonRow([
        buttonElement(options[i].label, `${approvalId}:${currentIndex}:${i}`),
      ]));
    }
  }

  // 过期提示
  if (expiresAt) {
    const mins = Math.round((expiresAt - Date.now()) / 60000);
    elements.push({ tag: 'div', text: markdown(`\n\n⏱ 有效期约 ${mins} 分钟，过期后请到 DSH 处理`) });
  }

  return JSON.stringify({
    header: {
      title: plainText(title),
      template: 'blue',
    },
    body: { elements },
  });
}

/** 结果卡片（已处理/已过期/无权限） */
function buildResultCard({ title, resultText, template = 'grey' }) {
  return JSON.stringify({
    header: { title: plainText(title), template },
    body: { elements: [{ tag: 'div', text: markdown(resultText) }] },
  });
}

// ────────────────────────────── 飞书客户端 ──────────────────────────────

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

const dispatcher = new lark.EventDispatcher({}).register({
  // 私聊消息：用于目标绑定
  'im.message.receive_v1': async (event) => {
    const msg = event?.message;
    if (!msg) return;
    const chatType = msg.chat_type;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    const senderName = event?.sender?.sender_id?.name;

    console.log(`[msg] chat_type=${chatType} sender=${senderName ?? senderOpenId} content=${truncate(msg.content, 60)}`);

    if (chatType === 'p2p' && senderOpenId) {
      if (!state.targetOpenId) {
        state.targetOpenId = senderOpenId;
        state.targetName = senderName;
        state.whitelist.add(senderOpenId);
        console.log(`\n✅ 目标已绑定：${senderName ?? senderOpenId}（open_id=${senderOpenId}）`);
        console.log('   现在可以发送测试卡片了。\n');
        if (AUTO_TEST) setTimeout(runFullTest, 500);
      } else if (state.targetOpenId !== senderOpenId) {
        console.log(`⚠️  收到非绑定用户消息，已忽略（当前绑定：${state.targetOpenId}）`);
      }
    }
  },

  // 卡片按钮回调
  'card.action.trigger': async (event) => {
    state.lastCardActionAt = Date.now();
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

    // 白名单校验
    if (state.whitelist.size > 0 && !state.whitelist.has(operatorOpenId)) {
      console.log(`⛔ 非白名单用户点击：${operatorOpenId}`);
      await updateCard(msgId, buildResultCard({
        title: '无权限',
        resultText: '只有任务发起人才能处理这条审批。',
        template: 'red',
      })).catch(() => {});
      audit({ type: 'rejected', approvalId, actor: operatorOpenId, result: 'not-allowed' });
      return;
    }

    const pending = state.pendingApprovals.get(approvalId);
    if (!pending) {
      console.log(`⚠️  未知或已处理的审批：${approvalId}`);
      await updateCard(msgId, buildResultCard({
        title: '已处理',
        resultText: '这条审批已处理或已过期。',
      })).catch(() => {});
      audit({ type: 'rejected', approvalId, actor: operatorOpenId, result: 'unknown' });
      return;
    }

    // 过期校验
    if (Date.now() > pending.expiresAt) {
      console.log(`⏰ 审批已过期：${approvalId}`);
      await updateCard(msgId, buildResultCard({
        title: '已过期',
        resultText: '这条审批已过期，请到 DSH 处理。',
        template: 'orange',
      })).catch(() => {});
      pending.status = 'expired';
      state.pendingApprovals.delete(approvalId);
      audit({ type: 'expired', approvalId, actor: operatorOpenId, result: 'expired' });
      return;
    }

    // 重复点击校验
    if (pending.answers[qIndex] !== undefined) {
      console.log(`⚠️  重复点击：q=${qIndex}`);
      await updateCard(msgId, buildResultCard({
        title: '已收到',
        resultText: `已记录你的选择：${pending.questions[qIndex].options?.[optIndex]?.label ?? optIndex}`,
      })).catch(() => {});
      return;
    }

    // 记录答案
    const question = pending.questions[qIndex];
    const selectedLabel = question.options?.[optIndex]?.label ?? `选项${optIndex + 1}`;
    pending.answers[qIndex] = { id: question.id, selected: [selectedLabel] };
    pending.currentIndex = Math.max(pending.currentIndex, qIndex + 1);

    console.log(`✅ 记录答案：q${qIndex + 1} = "${selectedLabel}"（${pending.answers.filter(Boolean).length}/${pending.questions.length}）`);

    // 立即更新卡片（5 秒内 ACK）
    await updateCard(msgId, buildResultCard({
      title: '已收到',
      resultText: `已记录：**${selectedLabel}**\n\n处理中…`,
    })).catch((err) => console.warn('卡片更新失败（非致命）:', err?.message));

    // 是否还有下一题？
    const nextUnanswered = pending.questions.findIndex((_, i) => pending.answers[i] === undefined);
    if (nextUnanswered === -1) {
      // 全部答完
      pending.status = 'completed';
      console.log(`\n🎉 审批完成：${approvalId}`);
      console.log('   答案:', JSON.stringify(pending.answers, null, 2));
      state.pendingApprovals.delete(approvalId);

      await sendCardMessage(
        state.targetOpenId,
        buildResultCard({
          title: '审批完成',
          resultText: `全部 ${pending.questions.length} 个问题已回答。\n\n结果已提交，任务将继续。`,
          template: 'green',
        }),
      ).catch((err) => console.warn('结果通知发送失败:', err?.message));

      audit({ type: 'completed', approvalId, actor: operatorOpenId, result: 'completed' });
    } else {
      // 发送下一题
      pending.messageId = await sendQuestionCard(pending, nextUnanswered);
      console.log(`📤 已发送问题 ${nextUnanswered + 1}/${pending.questions.length}`);
    }
  },
});

// ────────────────────────────── 卡片发送/更新 ──────────────────────────────

async function sendCardMessage(openId, cardJson) {
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

async function sendQuestionCard(pending, qIndex) {
  const q = pending.questions[qIndex];
  const card = buildApprovalCard({
    approvalId: pending.approvalId,
    title: pending.title,
    detail: q.detail ?? q.question,
    options: q.options ?? [],
    currentIndex: qIndex,
    totalQuestions: pending.questions.length,
    expiresAt: pending.expiresAt,
  });
  return sendCardMessage(state.targetOpenId, card);
}

// ────────────────────────────── 审批生命周期 ──────────────────────────────

async function startApproval({ title, questions, expiresInMinutes = 120 }) {
  if (!state.targetOpenId) throw new Error('未绑定目标用户');
  if (state.pendingApprovals.size >= 5) throw new Error('同时进行的审批过多（>5）');

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

  console.log(`\n📋 新审批：${approvalId}（${questions.length} 个问题，${expiresInMinutes} 分钟有效期）`);
  pending.messageId = await sendQuestionCard(pending, 0);
  console.log(`📤 卡片已发送：${pending.messageId}`);

  audit({ type: 'started', approvalId, result: 'pending' });
  return approvalId;
}

// ────────────────────────────── 自动测试 ──────────────────────────────

async function runFullTest() {
  console.log('\n═══════════════ 自动测试开始 ═══════════════\n');

  // ── 测试 1：单问题按钮卡 ──
  console.log('── 测试 1：单问题审批卡 ──');
  await startApproval({
    title: 'Harness Kit · 审批 1',
    questions: [{
      id: 'hk-approval-1',
      question: '是否进入开发？',
      detail: '**范围**：新增告警详情接口 + 前端联动\n**RR**：PASS\n**风险**：涉及 2 个仓库',
      options: [
        { label: '✅ 通过，进入开发' },
        { label: '❌ 打回' },
      ],
    }],
    expiresInMinutes: 10,
  });

  await sleep(3000);

  // ── 测试 2：多问题逐题卡 ──
  console.log('\n── 测试 2：多问题澄清（3 题逐题卡）──');
  await startApproval({
    title: 'Harness Kit · 需求澄清',
    questions: [
      {
        id: 'clarify-1',
        question: '接口范围是否包含推送通知？',
        detail: '**背景**：告警详情目前只有轮询，没有推送',
        options: [{ label: '包含推送' }, { label: '不包含' }],
      },
      {
        id: 'clarify-2',
        question: '前端改动范围？',
        detail: '**背景**：涉及列表页和详情页',
        options: [{ label: '只改详情页' }, { label: '列表页 + 详情页' }],
      },
      {
        id: 'clarify-3',
        question: '是否需要 E2E 测试？',
        detail: '**背景**：当前只有单测，没有 E2E',
        options: [{ label: '需要 E2E' }, { label: '不需要' }],
      },
    ],
    expiresInMinutes: 10,
  });

  console.log('\n═══════════════════════════════════════════');
  console.log('  测试卡片已发送，请在飞书私聊中点击按钮。');
  console.log('  输入 list 查看进行中的审批');
  console.log('  输入 audit 查看审计日志');
  console.log('  输入 q 退出');
  console.log('═══════════════════════════════════════════\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ────────────────────────────── 交互式 REPL ──────────────────────────────

// 交互式 REPL（等绑定成功后或用户主动启动时进入）
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
      console.log(`  ${id}  ${p.title}  ${answered}/${p.questions.length}  过期=${new Date(p.expiresAt).toLocaleTimeString()}`);
    }
    return prompt();
  }

  if (cmd === 'audit') {
    for (const e of state.auditLog) console.log(`  ${e.at}  ${e.type}  ${e.approvalId ?? '-'}  ${e.result ?? ''}`);
    return prompt();
  }

  if (cmd === 'status') {
    console.log(`  连接: ${state.connected ? '✅' : '❌'}`);
    console.log(`  目标: ${state.targetOpenId ?? '未绑定'}`);
    console.log(`  白名单: ${[...state.whitelist].join(', ') || '（空）'}`);
    console.log(`  进行中审批: ${state.pendingApprovals.size}`);
    return prompt();
  }

  if (cmd === 'test1') {
    await startApproval({
      title: 'Harness Kit · 审批 1',
      questions: [{
        id: 'hk-approval-1',
        question: '是否进入开发？',
        detail: '**范围**：新增告警详情接口\n**RR**：PASS',
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

  if (cmd.startsWith('approve ')) {
    const id = cmd.slice(8).trim();
    const p = state.pendingApprovals.get(id);
    if (!p) { console.log('未找到'); return prompt(); }
    // 模拟全部通过
    for (let i = 0; i < p.questions.length; i++) {
      p.answers[i] = { id: p.questions[i].id, selected: [p.questions[i].options?.[0]?.label ?? '通过'] };
    }
    state.pendingApprovals.delete(id);
    console.log(`已模拟通过：${id}`);
    return prompt();
  }

  console.log('未知命令。可用：list, audit, status, test1, test3, approve <id>, q');
  prompt();
}

// ────────────────────────────── 启动 ──────────────────────────────

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => {
    state.connected = true;
    console.log('✅ 飞书长连接已就绪');
    if (FORCE_OPEN_ID) {
      state.whitelist.add(FORCE_OPEN_ID);
      console.log(`目标已预设：${FORCE_OPEN_ID}`);
      if (AUTO_TEST) setTimeout(runFullTest, 500);
      else prompt();
    } else {
      console.log('等待用户私聊机器人以绑定目标…');
      // 不自动进 REPL，等绑定后再进
    }
  },
  onError: (err) => {
    state.connected = false;
    console.error('❌ 连接错误:', err?.message ?? err);
  },
  onReconnecting: () => {
    state.connected = false;
    console.log('🔄 正在重连…');
  },
  onReconnected: () => {
    state.connected = true;
    console.log('✅ 重连成功');
  },
});

console.log('正在启动飞书 WSClient…');
wsClient.start({ eventDispatcher: dispatcher });

// 如果 30 秒内没绑定成功，提示用户
if (!FORCE_OPEN_ID) {
  const timer = setTimeout(() => {
    if (!state.targetOpenId) {
      console.log('\n⚠️  30 秒内未收到私聊消息。请先在飞书里给机器人发一条消息。');
      console.log('   或者使用 --open-id 参数直接指定目标。\n');
      ensurePrompt();
    }
    clearTimeout(timer);
  }, 30000);
} else {
  // 有预设 open_id 时，如果没有自动测试，也进 REPL
  if (!AUTO_TEST) {
    // onReady 里会调 prompt
  }
}

process.on('SIGINT', () => {
  console.log('\n断开连接');
  wsClient.close();
  process.exit(0);
});
