#!/usr/bin/env node
/**
 * 用真实飞书桥接模拟 phm-feature-binding 的 Q-05 审批。
 * 发送卡片 → 等待用户点击 → 打印桥接收到的结构化答案。
 */
import { ApprovalBridge } from '../kernel/im/bridge.js';
import '../kernel/im/index.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OPEN_ID = process.env.FEISHU_OPEN_ID;
if (!APP_ID || !APP_SECRET || !OPEN_ID) {
  console.error('请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_OPEN_ID 环境变量');
  process.exit(1);
}
const WS = '/Users/leo/Server/sie/iot-harnessKit';

const config = {
  enabled: true,
  channels: {
    feishu: { enabled: true, appId: APP_ID, appSecret: APP_SECRET, targetOpenId: OPEN_ID },
    wecom: { enabled: false },
    dingtalk: { enabled: false },
  },
  approvalExpiryMinutes: 10,
};

const question = {
  id: 'q5-health-chain',
  question: 'Q-05 健康分影响面：健康分链路是否纳入本次绑定改造？',
  detail: [
    '**材料**：[提案](.harness/deliverables/phm-feature-binding/proposal.md) · [需求文档](.harness/deliverables/phm-feature-binding/inputs/phm-物属性特征值绑定与设备概览收敛.md) · [PHM spec](.harness/specs/phm/spec.md)',
    '',
    '健康度取数底座 `getFeatureTrend`（PHM-R-036）的数据源同为字典 `source_property_tpl` 模板；需求文档只改 `getFeatureCurve`，且「本次不做」包含健康分算法变更。',
    '',
    '若维持边界：同一设备详情页曲线（读绑定属性）与健康分（读模板属性）取数来源分裂——曲线有值时健康分可为 null；绑定 62 项无模板特征时曲线可用、健康分恒 null。',
  ].join('\n'),
  options: [
    { label: '维持需求边界 (Recommended)', description: '健康分算法不变更；proposal 登记为已知限制，后续另开任务' },
    { label: '扩范围：健康分链路也走绑定', description: 'getFeatureTrend 同步按绑定取数，健康分与曲线同源；需求/验收扩充' },
  ],
};

const logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

const bridge = new ApprovalBridge({ ws: WS, logger, config });
await bridge.init();

const pending = await bridge.createApproval({
  sessionId: 'session-b0c1dd8b-95fb-4019-a1ab-442c05f7005d',
  task: 'phm-feature-binding',
  questions: [question],
  targetOpenId: OPEN_ID,
  channel: 'feishu',
});

console.log(`\n卡片已发送，等待点击…（approvalId=${pending.approvalId}，最多 5 分钟）`);
const deadline = Date.now() + 5 * 60 * 1000;
while (bridge.pendingApprovals.has(pending.approvalId) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
}

if (bridge.pendingApprovals.has(pending.approvalId)) {
  console.log('\n等待超时，未收到点击。');
} else {
  console.log('\n收到回答：');
  console.log(JSON.stringify(pending.answers.map((a, i) => ({
    id: pending.questions[i].id,
    selected: a?.selected ?? [],
    custom: a?.custom ?? null,
  })), null, 2));
}

await bridge.dispose();
process.exit(0);
