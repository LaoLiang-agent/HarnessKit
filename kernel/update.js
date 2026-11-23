// Lightweight npm update check for the panel. The plugin never upgrades itself;
// it only reports whether the registry has a newer version so the user can open
// Plugins -> Harness Kit -> Update.
import fs from 'node:fs';
import path from 'node:path';
import { PACK_ROOT } from './paths.js';

const REGISTRY_URL = 'https://registry.npmjs.org/dsh-harness-kit/latest';
const SUCCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

const cache = { ok: false, latest: null, at: 0 };

/** Parse the numeric core of a SemVer string. Prerelease/build suffixes are ignored. */
export function parseVersion(value) {
  const m = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function currentPluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function status(current, latest, checkedAt, ok) {
  return {
    ok,
    current,
    latest: latest ?? null,
    updateAvailable: ok && isNewerVersion(latest, current),
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

/** Clear the in-process cache (tests / diagnostics). */
export function resetUpdateCache() {
  cache.ok = false;
  cache.latest = null;
  cache.at = 0;
}

/**
 * Check npm for the latest version, with one-hour success caching.
 * Failures are cached briefly and never throw to the panel.
 */
export async function checkPluginUpdate({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (process.env.HARNESS_KIT_UPDATE_CHECK === '0') {
    return { ...status(currentPluginVersion(), null, now(), false), disabled: true };
  }
  const current = currentPluginVersion();
  const at = now();
  if (cache.latest && cache.ok && at - cache.at < SUCCESS_TTL_MS) {
    return status(current, cache.latest, cache.at, true);
  }
  if (!cache.ok && cache.at && at - cache.at < FAILURE_TTL_MS) {
    return status(current, null, cache.at, false);
  }
  if (typeof fetchImpl !== 'function' || !current) {
    cache.ok = false;
    cache.at = at;
    return status(current, null, at, false);
  }

  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchImpl(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res?.ok) throw new Error(`registry response ${res?.status ?? 'unknown'}`);
    const body = await res.json();
    const latest = typeof body?.version === 'string' ? body.version.trim() : '';
    if (!parseVersion(latest)) throw new Error('registry returned an invalid version');
    cache.ok = true;
    cache.latest = latest;
    cache.at = at;
    return status(current, latest, at, true);
  } catch {
    cache.ok = false;
    cache.latest = null;
    cache.at = at;
    return status(current, null, at, false);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
