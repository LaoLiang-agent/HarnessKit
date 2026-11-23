// Model routing: content packs name logical models (reasoning/coding/fast) in
// role frontmatter and flow stages; kit.json `models` maps them to concrete
// provider/model. Missing mapping degrades to the session default model.
// Availability is validated by the Lead at dispatch time (list_subagent_models),
// so this module only resolves the mapping deterministically.

/** 校验并规范化 {key: {provider?, model, reasoning_effort?}} 映射。 */
export function normalizeModelMap(input, label = 'models') {
  if (input == null) return { models: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: `${label} 必须是对象` };
  }
  const models = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = String(rawKey).trim();
    if (!key) return { error: `${label} 的键不能为空` };
    if (value == null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { error: `${label}.${key} 需为 {provider?, model, reasoning_effort?}` };
    }
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!model) return { error: `${label}.${key} 需提供非空 model` };
    if (value.provider !== undefined && value.provider !== null && typeof value.provider !== 'string') {
      return { error: `${label}.${key}.provider 必须是字符串` };
    }
    if (value.reasoning_effort !== undefined && value.reasoning_effort !== null
      && (typeof value.reasoning_effort !== 'string' || !value.reasoning_effort.trim())) {
      return { error: `${label}.${key}.reasoning_effort 必须是非空字符串` };
    }
    const entry = {};
    if (typeof value.provider === 'string' && value.provider.trim()) entry.provider = value.provider.trim();
    entry.model = model;
    if (typeof value.reasoning_effort === 'string' && value.reasoning_effort.trim()) {
      entry.reasoning_effort = value.reasoning_effort.trim();
    }
    models[key] = entry;
  }
  return { models };
}

function resolveEntry(models, logical) {
  if (!logical || typeof logical !== 'string') return null;
  const entry = models?.[logical];
  if (!entry || typeof entry !== 'object' || !entry.model) return null;
  return {
    ...(entry.provider ? { provider: entry.provider } : {}),
    model: entry.model,
    ...(entry.reasoning_effort ? { reasoning_effort: entry.reasoning_effort } : {}),
  };
}

/** Resolve a logical model name to { provider?, model, reasoning_effort? } or null. */
export function resolveModel(kit, logical) {
  return resolveEntry(kit?.models, logical);
}

/** Human-readable dispatch description for prompts/status output. */
export function describeModel(kit, logical, localModels = null) {
  if (!logical) return '会话默认（角色未声明逻辑模型）';
  const local = resolveEntry(localModels, logical);
  if (local) {
    const eff = local.reasoning_effort ? `, reasoning_effort=${local.reasoning_effort}` : '';
    return `${logical} → 本机覆盖 provider=${local.provider ?? '（会话默认 provider）'}, model=${local.model}${eff}`;
  }
  const r = resolveModel(kit, logical);
  if (!r) return `${logical}（kit.json models 未映射 → 会话默认）`;
  const eff = r.reasoning_effort ? `, reasoning_effort=${r.reasoning_effort}` : '';
  return `${logical} → provider=${r.provider ?? '（会话默认 provider）'}, model=${r.model}${eff}`;
}

/**
 * 角色级模型映射：本机覆盖优先于团队默认，每级允许用「角色名」（business-analyst 等）
 * 或逻辑模型名（fast/coding/reasoning）做键。返回 {entry, via, source}：
 * via=local-role/role/local-logical/logical；null 都未映射。
 */
export function resolveWorkerModel(kit, role, logical, localModels = null) {
  // 本机覆盖优先于团队默认；每一级仍按角色名 > 逻辑名。
  const byLocalRole = resolveEntry(localModels, role);
  if (byLocalRole) return { entry: byLocalRole, via: 'local-role', source: 'local' };
  const byRole = resolveModel(kit, role);
  if (byRole) return { entry: byRole, via: 'role', source: 'team' };
  const byLocalLogical = resolveEntry(localModels, logical);
  if (byLocalLogical) return { entry: byLocalLogical, via: 'local-logical', source: 'local' };
  const byLogical = resolveModel(kit, logical);
  if (byLogical) return { entry: byLogical, via: 'logical', source: 'team' };
  return null;
}

/**
 * 从团队 + 本机模型映射收集子智能体路由授权（去重）。
 * DSH 默认子模型限父会话当前模型且宿主无 GUI 开关（subagentModelSelection 出厂关）——
 * HarnessKit 按工作区映射自动授权：映射了的路由就是人想用的（2026-11-16 iot-harness RR 降级事故）。
 */
export function collectModelRoutes(kit, localModels = null) {
  const seen = new Map();
  for (const map of [kit?.models ?? {}, localModels ?? {}]) {
    for (const m of Object.values(map)) {
      if (m && typeof m.provider === 'string' && m.provider && typeof m.model === 'string' && m.model) {
        seen.set(`${m.provider}/${m.model}`, { provider: m.provider, model: m.model });
      }
    }
  }
  return [...seen.values()];
}

/** 派发描述：本机覆盖 > 团队默认；每级角色名优先于逻辑名，并标注命中来源。 */
export function describeWorkerModel(kit, role, logical, localModels = null) {
  const r = resolveWorkerModel(kit, role, logical, localModels);
  if (!r) {
    if (!logical) return '会话默认（角色未声明逻辑模型）';
    return `${logical}（kit.json/local 均未映射 → 会话默认）`;
  }
  const { provider, model, reasoning_effort } = r.entry;
  const via = {
    'local-role': `本机角色映射 ${role}`,
    role: `角色映射 ${role}`,
    'local-logical': `本机逻辑模型 ${logical}`,
    logical: `逻辑模型 ${logical}`,
  }[r.via];
  // subagent 工具要求 provider/model 必须成对（缺一即报错）；映射缺 provider 时无法成对传递，
  // 视为会话默认派发——不显式传任何模型参数（2026-11-16 iot-harness 真实踩坑：PM 只传 model 触发校验报错）
  if (!provider) {
    return `${via} 只配了 model 未配 provider：无法成对传递，按会话默认派发（不传任何模型参数）`;
  }
  const eff = reasoning_effort ? `, reasoning_effort=${reasoning_effort}` : '';
  return `${via} → provider=${provider}, model=${model}${eff}`;
}

/**
 * Render the "## 派发方式" appendix with per-worker model routing.
 * workers: [{ role, logical }] — logical from role frontmatter / stage override.
 */
export function dispatchSection(kit, workers, localModels = null) {
  const lines = [
    '## 派发方式',
    '- 你自己承担 PM 职责：拆解、派发、汇总、向人汇报。',
    '- Worker/subagent 一律用 subagent 工具派发：prompt 自包含（任务背景 + handoff 路径 + 产出路径 + 读写范围约束；阶段指定 Worker 角色时另需先读角色文件并内嵌定义全文）。',
    '- 派发前更新 `handoff.md` 的「读取清单」；Worker 只读 handoff + 清单中的章节，不整份重读 requirements/design/spec。',
    '- 等待纪律：优先结束当前回合，靠子代理完成通知继续；必须阻塞时只调用一次 `wait_agent`（timeout_ms ≤ 3600000），禁止 5 分钟轮询，禁止用 send_message 问进度。',
    '- 编排噪音：看板只在阶段边界写；相关 git status/log/branch 合并成一条 bash；日志只取失败摘要，不整段回贴。',
    '- Worker 产物写入活目录对应文件；Worker 只能写其 write_scopes 声明的范围。',
    '- 任何时候信息不足或口径模糊：先向人反问，不要自行补全。',
    '',
    '### 模型路由（派发时必须执行）',
    '- 模型来源：`.harness/local/models.json`（仅本机，优先）> `kit.json models`（团队默认）；每级内支持两级键：角色名（business-analyst 等）优先，其次逻辑模型名（fast/coding/reasoning）；下方每行已标注命中来源。',
  ];
  if (workers.length === 0) {
    lines.push('- 本流程无 Worker 阶段，全部 PM 自行执行。');
  } else {
    for (const w of workers) {
      lines.push(`- **${w.role}** → ${describeWorkerModel(kit, w.role, w.logical, localModels)}`);
    }
  }
  lines.push(
    '- 派发带模型的 Worker 前，先用 list_subagent_models 校验 provider/model 可用；',
    '  可用 → subagent 调用传 provider/model（及 reasoning_effort，如有）：**provider 与 model 必须成对，缺一即报错**；',
    '  不可用或报错 → **不带 provider/model 任何参数**重新派发（= 会话默认），并在汇报中告知人「模型映射失效，已降级」；',
    '- 未映射的逻辑模型、或映射缺 provider（无法成对）→ 直接按会话默认派发，不必校验、不传任何模型参数。',
    '- 可用性是会话级作用域：子模型路由默认限父会话当前模型；其他 provider 需人在 DSH 会话的模型选择里显式授权子智能体路由。',
  );
  return lines.join('\n');
}
