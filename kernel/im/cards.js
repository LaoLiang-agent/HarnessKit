// 飞书卡片构造工具
// 使用旧版卡片格式（config + header + elements），兼容性好，按钮回调稳定

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}

function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

/** 审批卡片 */
export function buildApprovalCard({ approvalId, title, detail, options, currentIndex, totalQuestions, expiresAt }) {
  const elements = [];

  if (totalQuestions > 1) {
    elements.push({ tag: 'div', text: markdown(`**问题 ${currentIndex + 1}/${totalQuestions}**`) });
  }

  if (detail) {
    elements.push({ tag: 'div', text: markdown(detail) });
  }

  elements.push({ tag: 'hr' });

  // 无选项（澄清类）：提示直接回复文字；有选项则生成按钮
  if (options.length === 0) {
    elements.push({ tag: 'div', text: markdown('请直接回复文字作答。') });
  } else {
    const actions = options.map((opt, i) => ({
      tag: 'button',
      text: plainText(opt.label),
      type: i === 0 ? 'primary' : 'danger',
      value: { action: `${approvalId}:${currentIndex}:${i}` },
    }));
    elements.push({ tag: 'action', actions });
  }

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

/** 结果卡片（已处理/已过期/无权限） */
export function buildResultCard({ title, resultText, template = 'grey' }) {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: plainText(title), template },
    elements: [{ tag: 'div', text: markdown(resultText) }],
  });
}

/** 解析按钮回调的 action value */
export function parseActionValue(actionValue) {
  if (!actionValue || typeof actionValue !== 'string') return null;
  const parts = actionValue.split(':');
  if (parts.length < 3) return null;
  const [approvalId, qIndexStr, optIndexStr] = parts;
  const qIndex = Number(qIndexStr);
  const optIndex = Number(optIndexStr);
  if (isNaN(qIndex) || isNaN(optIndex)) return null;
  return { approvalId, qIndex, optIndex };
}
