// Flow loading + compilation of a flow definition into a Lead orchestration
// prompt (ruling 2: prompt orchestration first, no hard state machine).
import fs from 'node:fs';
import path from 'node:path';
import { packDir, harnessDir } from './paths.js';
import { parseYaml } from './miniyaml.js';

/** Load flows/<name>.yml; workspace override .harness/flows/ wins. */
export function loadFlow(ws, kit, name) {
  const candidates = [
    path.join(harnessDir(ws), 'flows', `${name}.yml`),
    path.join(packDir(kit), 'flows', `${name}.yml`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return { flow: parseYaml(fs.readFileSync(file, 'utf8')), file };
      } catch (cause) {
        throw new Error(`流程定义 ${file} 解析失败：${cause.message}`);
      }
    }
  }
  return null;
}

function stageLines(flow, context) {
  const lines = [];
  // phase filter: stages without `phase` belong to every phase (fix/init flows);
  // full-flow stages carry phase: propose|apply and are filtered by the command.
  const stages = (flow.stages ?? []).filter(
    (s) => !context.phase || !s.phase || s.phase === context.phase,
  );
  for (const [i, stage] of stages.entries()) {
    const head = `### 阶段 ${i + 1}：${stage.name}`;
    const body = [];
    if (stage.actor) body.push(`- 执行者：${stage.actor}`);
    if (stage.worker) body.push(`- Worker 角色：${stage.worker}（用 subagent 工具派发，prompt 中内嵌角色定义全文）`);
    if (stage.model) body.push(`- 派发模型：${stage.model}`);
    if (Array.isArray(stage.do)) for (const item of stage.do) body.push(`- ${item}`);
    if (stage.gate) body.push(`- ⛔ 人工质量门：${stage.gate} —— 用 ask_user_question 工具交人裁决，禁止自行决定`);
    if (stage.approval) body.push(`- ⛔ 审批点：${stage.approval} —— 用 ask_user_question 交人审批后方可继续`);
    if (stage.gate || stage.approval) {
      body.push('- ⛔ 审批材料必须可见：先发普通 assistant 消息（非 reasoning），用 Markdown 链接列出本轮产物；ask_user_question 的 question 也要带链接；present 卡片本轮结束后才出现，不能替代等待回答前的链接。');
    }
    lines.push([head, ...body].join('\n'));
  }
  return lines.join('\n\n');
}

/**
 * Compile the flow into a Lead orchestration prompt.
 * context: { task, desc, roleSections, rules, artifacts, phase?, dispatchSection? }
 * phase='propose'|'apply' filters full-flow stages; dispatchSection overrides the
 * default dispatch appendix (used by M2 commands to embed model routing).
 */
export function compileFlowPrompt(flow, context) {
  const parts = [
    `# Harness Kit 任务调度指令（${flow.name ?? 'flow'}）`,
    '',
    `你现在以 **PM（项目负责人）** 身份编排本任务。以下是流程定义（${context.flowFile}）编译出的执行剧本，严格按阶段顺序推进；标注 ⛔ 处必须停下来交人裁决/审批。`,
    '',
    `## 任务`,
    `- 任务名：${context.task}`,
    `- 需求描述：${context.desc}`,
    `- 活目录：${context.artifacts}`,
    ...(context.materials ? [`- 参考材料：${context.materials}`] : []),
    '',
    `## 流程阶段`,
    stageLines(flow, context),
  ];
  if (flow.after?.length) {
    parts.push('', '## 收尾', ...flow.after.map((s) => `- ${s}`));
  }
  if (context.roleSections) {
    parts.push('', '## 角色定义', context.roleSections);
  }
  if (context.rules) {
    parts.push('', '## 运行时纪律（必须遵守）', context.rules);
  }
  if (context.dispatchSection) {
    parts.push('', context.dispatchSection);
  } else {
    parts.push(
      '',
      '## 派发方式',
      '- 你自己承担 PM 职责：拆解、派发、汇总、向人汇报。',
      '- Worker/subagent 一律用 subagent 工具派发：prompt 自包含（任务背景 + 产出路径 + 写范围约束；阶段指定 Worker 角色时另需先读角色文件并内嵌定义全文），等待其返回结果后再进下一阶段。',
      '-  Worker 产物写入上述活目录对应文件；Worker 只能写其 write_scopes 声明的范围。',
      '- 任何时候信息不足或口径模糊：先向人反问，不要自行补全。',
    );
  }
  return parts.join('\n');
}
