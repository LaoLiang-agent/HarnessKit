// Task/gate state derived from the workspace: the guard reads these facts
// instead of a session state machine, so reloads and forks stay consistent.
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir, protectedSourcePaths } from './paths.js';

// NOTE: no \b — CJK chars are non-word in JS regex, so \b after 轻量 never matches.
// Tolerates markdown bold between 裁决 and colon: "**人裁决**：`轻量`" (legacy format).
// Horizontal whitespace only — a colon at line end must not match a keyword on the next line.
const VERDICT = /裁决[*＊]*[:：][ \t]*`?(轻量|light|--full|full)(?![\w-])/i;
// Full-flow unlock: human approval 1 recorded by PM at the end of proposal.md
// (see flows/*.yml 审批 1 stage). "审批 1：通过" / "审批1: PASS" both match.
const APPROVAL1 = /审批\s*1[^0-9\n]{0,20}(通过|PASS)/i;
// M2: fix直通 unlocks on bugfix.md quality-gate verdict; full flow (any task
// with proposal.md, including profile=bugfix) unlocks on recorded approval 1.
// A full-flow bugfix.md (BA-written, "## 结论" PASS) has no verdict line, so
// the two docs must not be checked interchangeably.
const VERDICT_DOC = { file: 'bugfix.md', unlock: VERDICT };
const PROPOSAL_DOC = { file: 'proposal.md', unlock: APPROVAL1 };

/** Active task dirs under .harness/deliverables (excluding _archive, _template, dotfiles). */
export function activeTasks(ws) {
  const dir = path.join(harnessDir(ws), 'deliverables');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/**
 * A task is "planning" while its planning doc exists without the recorded
 * human gate. Full flow (proposal.md present) → approval 1; fix直通 → verdict.
 * proposal.md takes precedence: a full-flow bugfix profile writes both docs,
 * and only the proposal approval gate applies.
 */
export function taskIsPlanning(ws, task) {
  const dir = path.join(harnessDir(ws), 'deliverables', task);
  const hasProposal = fs.existsSync(path.join(dir, PROPOSAL_DOC.file));
  const doc = hasProposal ? PROPOSAL_DOC : VERDICT_DOC;
  const file = path.join(dir, doc.file);
  if (!fs.existsSync(file)) return false;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return true; // unreadable planning doc → stay locked
  }
  return !doc.unlock.test(text);
}

/**
 * Source paths currently locked by the Bootstrap red line: non-empty while
 * any active task is still in planning (no recorded human gate).
 */
export function lockedSourcePaths(ws, kit) {
  const planning = activeTasks(ws).filter((t) => taskIsPlanning(ws, t));
  return planning.length > 0 ? protectedSourcePaths(kit) : [];
}
