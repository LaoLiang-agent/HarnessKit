// 飞书卡片构造工具
// 使用旧版卡片格式（config + header + elements），兼容性好，按钮回调稳定。
// 手机端按钮文字容易截断：选项全文放在正文，按钮只显示「选 1 / 选 2」。

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}

function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

/** 展示用文案：把英文 (Recommended) 统一成中文（推荐） */
export function displayOptionLabel(label) {
  return String(label ?? '')
    .replace(/\s*[\(（]\s*recommended\s*[\)）]/gi, '（推荐）')
    .replace(/\s*[\(（]\s*推荐\s*[\)）]/g, '（推荐）');
}

/** 一个短按钮；value 里的索引对应原始 options，答案仍提交原始 label */
function optionButton(approvalId, questionIndex, option, index, total) {
  return {
    tag: 'button',
    text: plainText(total <= 2 ? `选 ${index + 1}` : `${index + 1}`),
    type: index === 0 ? 'primary' : 'default',
    width: 'fill',
    value: { action: `${approvalId}:${questionIndex}:${index}` },
  };
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

  if (options.length === 0) {
    elements.push({ tag: 'div', text: markdown('请直接回复文字作答。') });
  } else {
    // 选项全文放正文：手机端可完整换行阅读
    elements.push({ tag: 'div', text: markdown('**请选择：**') });
    options.forEach((opt, i) => {
      const desc = opt.description ? `\n   ${displayOptionLabel(opt.description)}` : '';
      elements.push({ tag: 'div', text: markdown(`${i + 1}. ${displayOptionLabel(opt.label)}${desc}`) });
    });
    // 按钮只放序号，避免长文案被截断；也支持直接回复数字
    const buttons = options.map((opt, i) => optionButton(approvalId, currentIndex, opt, i, options.length));
    if (options.length <= 2) {
      elements.push({ tag: 'action', actions: buttons });
    } else {
      for (const btn of buttons) {
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [btn] }],
        });
      }
    }
    elements.push({ tag: 'div', text: markdown('可直接回复数字（如 `1`）选择。') });
  }

  if (expiresAt) {
    const mins = Math.round((expiresAt - Date.now()) / 60000);
    elements.push({ tag: 'div', text: markdown(`\n⏱ 有效期约 ${mins} 分钟`) });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: plainText(title), template: 'blue' },
    elements,
  });
}

/** 结果卡片（已处理/已过期/无权限/请补充说明） */
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
