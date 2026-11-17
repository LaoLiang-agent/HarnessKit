// Build a user-role message and submit it to the receiving agent.
// Mirrors @deepseek-ai/dsh-llm createUserMessage() at runtime
// ({ id, role, content, source }, deep-frozen; brands are compile-time only),
// so the bundle needs no imports from shipped dsh packages.
import { randomUUID } from 'node:crypto';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function userText(text, source = { kind: 'user' }) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  });
}

/** Submit a model-visible user message to the agent (plan-mode precedent). */
export function steer(agent, text) {
  agent.steer(userText(text));
}
