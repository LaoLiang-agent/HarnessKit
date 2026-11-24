#!/usr/bin/env node
/**
 * 按流程顺序模拟 session 中出现的全部 ask_user_question 审批。
 * 用法：
 *   FEISHU_APP_ID=... FEISHU_APP_SECRET=... FEISHU_OPEN_ID=... \
 *   node tools/poc-feishu-multi.mjs /tmp/hk-approvals.json
 */
import fs from 'node:fs';
import { ApprovalBridge } from '../kernel/im/bridge.js';
import '../kernel/im/index.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OPEN_ID = process.env.FEISHU_OPEN_ID;
const FILE = process.argv[2] || '/tmp/hk-approvals.json';
if (!APP_ID || !APP_SECRET || !OPEN_ID) {
  console.error('请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_OPEN_ID');
  process.exit(1);
}
const calls = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const config = {
  enabled: true,
  channels: {
    feishu: { enabled: true, appId: APP_ID, appSecret: APP_SECRET, targetOpenId: OPEN_ID },
    wecom: { enabled: false },
    dingtalk: { enabled: false },
  },
  approvalExpiryMinutes: 30,
};
const logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

const bridge = new ApprovalBridge({ ws: '/Users/leo/Server/sie/iot-harnessKit', logger, config });
await bridge.init();

const results = [];
for (let i = 0; i < calls.length; i++) {
  const call = calls[i];
  const questions = call.questions.map((q) => ({
    id: q.id,
    question: q.question,
    detail: q.detail ?? (q.header ? `**${q.header}**\n\n${q.question}` : q.question),
    options: q.options ?? [],
  }));
  console.log(`\n========== 批次 ${i + 1}/${calls.length}：${questions.length} 个裁决项 (seq=${call.seq}) ==========`);
  const pending = await bridge.createApproval({
    sessionId: 'session-b0c1dd8b-95fb-4019-a1ab-442c05f7005d',
    task: 'phm-feature-binding',
    questions,
    targetOpenId: OPEN_ID,
    channel: 'feishu',
  });
  console.log(`卡片已发送：approvalId=${pending.approvalId}，请依次回答 ${questions.length} 个问题`);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (bridge.pendingApprovals.has(pending.approvalId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
  }
  if (bridge.pendingApprovals.has(pending.approvalId)) {
    console.log('本批次等待超时，停止后续批次。');
    break;
  }
  const answers = pending.answers.map((a, j) => ({
    id: pending.questions[j].id,
    selected: a?.selected ?? [],
    custom: a?.custom ?? null,
  }));
  console.log('本批次答案：');
  console.log(JSON.stringify(answers, null, 2));
  results.push({ seq: call.seq, questions: questions.length, answers });
}

console.log('\n========== 全部结果 ==========');
console.log(JSON.stringify(results, null, 2));
await bridge.dispose();
process.exit(0);
