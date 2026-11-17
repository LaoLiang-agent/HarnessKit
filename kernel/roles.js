// Role registry: resolve role definitions with workspace override precedence
// (.harness/agents/<role>.md beats the pack copy). M1 embeds resolved role
// bodies into Lead orchestration prompts; preset registration arrives in M2.
import fs from 'node:fs';
import path from 'node:path';
import { packDir, harnessDir } from './paths.js';
import { parseYaml } from './miniyaml.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseRoleFile(text, fallbackRole) {
  const m = FRONTMATTER.exec(text);
  if (!m) return { meta: { role: fallbackRole }, body: text.trim() };
  let meta;
  try {
    meta = parseYaml(m[1]) ?? {};
  } catch (cause) {
    throw new Error(`角色文件 frontmatter 解析失败：${cause.message}`);
  }
  return { meta: { role: fallbackRole, ...meta }, body: text.slice(m[0].length).trim() };
}

function roleCandidates(ws, kit, role) {
  return [
    { file: path.join(harnessDir(ws), 'agents', `${role}.md`), origin: 'workspace' },
    { file: path.join(packDir(kit), 'agents', `${role}.md`), origin: 'pack' },
  ];
}

/** Resolve one role; returns { role, meta, body, file, origin } or null. */
export function resolveRole(ws, kit, role) {
  for (const c of roleCandidates(ws, kit, role)) {
    if (fs.existsSync(c.file)) {
      const { meta, body } = parseRoleFile(fs.readFileSync(c.file, 'utf8'), role);
      return { role, meta, body, file: c.file, origin: c.origin };
    }
  }
  return null;
}

/** List roles from both layers; workspace entries shadow pack entries. */
export function listRoles(ws, kit) {
  const seen = new Map();
  const scan = (dir, origin) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const role = name.slice(0, -3);
      if (seen.has(role)) continue; // workspace scanned first wins
      try {
        const { meta } = parseRoleFile(fs.readFileSync(path.join(dir, name), 'utf8'), role);
        seen.set(role, { role, meta, origin, file: path.join(dir, name) });
      } catch (cause) {
        seen.set(role, { role, meta: { role }, origin, file: path.join(dir, name), error: cause.message });
      }
    }
  };
  scan(path.join(harnessDir(ws), 'agents'), 'workspace');
  scan(path.join(packDir(kit), 'agents'), 'pack');
  return [...seen.values()];
}

/** Read the pack's domain-neutral rules document, when present. */
export function readCoreRules(kit) {
  const file = path.join(packDir(kit), 'rules', 'core.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}
