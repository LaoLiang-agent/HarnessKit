// Per-machine Worker model overrides: .harness/local/models.json.
// This file is gitignored (same directory as sessions.json/worktrees.json), so
// personal provider/model choices never enter the team asset repository.
import fs from 'node:fs';
import { localStatePath } from './paths.js';
import { normalizeModelMap } from './models.js';

const FILE = 'models.json';

export function localModelsPath(ws) {
  return localStatePath(ws, FILE);
}

/** Read local overrides; malformed files are ignored so routing still works. */
export function readLocalModels(ws) {
  const p = localModelsPath(ws);
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const raw = parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object'
      ? parsed.models
      : parsed;
    const norm = normalizeModelMap(raw, 'local models');
    return norm.models ?? {};
  } catch {
    return {};
  }
}

/** Replace the whole local override map. Caller validates first. */
export function writeLocalModels(ws, models) {
  const p = localModelsPath(ws);
  fs.writeFileSync(p, JSON.stringify({ version: 1, models }, null, 2) + '\n', 'utf8');
  return p;
}

/** Remove the local override file entirely (effective config falls back to team defaults). */
export function clearLocalModels(ws) {
  const p = localModelsPath(ws);
  if (fs.existsSync(p)) fs.rmSync(p);
  return p;
}
