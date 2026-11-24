// Task reference materials: copy files/directories into
// .harness/deliverables/<task>/inputs/ and build a model-readable index.
//
// The new-task dialog can reference many workspace files, whole prototype
// folders, and locally uploaded files. Everything is copied (not linked) so
// the task stays self-contained after archive and can be read by other agents.
import fs from 'node:fs';
import path from 'node:path';
import { harnessDir } from './paths.js';

export const MAX_MATERIAL_FILES = 300;
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 50;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tif', '.tiff', '.ico', '.avif']);
const DOC_EXT = new Set([
  '.md', '.txt', '.rst', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.html', '.htm', '.json', '.yaml', '.yml', '.xml', '.csv', '.css', '.js', '.jsx',
  '.ts', '.tsx', '.vue', '.sql', '.log',
]);

const mb = (n) => `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

/** File names become path segments: strip separators/control chars, keep CJK. */
export function safeName(name, fallback = 'material') {
  const base = path.basename(String(name ?? '').replaceAll('\\', '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 20);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10000; i += 1) {
    const next = `${stem}-${i}${ext}`;
    if (!used.has(next)) { used.add(next); return next; }
  }
  throw new Error(`无法为参考材料生成唯一文件名：${name}`);
}

function materialKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}

function kindLabel(kind) {
  return kind === 'image' ? '图片' : kind === 'doc' ? '文档' : '其他';
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return mb(n);
}

/**
 * Resolve user-provided refs (relative to cwd) into a flat, bounded file list.
 * Directories are walked recursively; symlinks and VCS/build junk are skipped.
 * Throws a user-facing Error when a ref is missing, empty, or over limits.
 */
export function collectMaterialRefs(cwd, refs, {
  maxFiles = MAX_MATERIAL_FILES,
  maxBytes = MAX_MATERIAL_BYTES,
} = {}) {
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  const add = (abs, source, top, rel, refIndex) => {
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (!st.isFile()) return;
    const real = fs.realpathSync(abs);
    if (seen.has(real)) return;
    if (files.length >= maxFiles) {
      throw new Error(`参考材料超过 ${maxFiles} 个文件上限：请减少文件，或只引用原型目录中的关键页面。`);
    }
    if (totalBytes + st.size > maxBytes) {
      throw new Error(`参考材料超过 ${mb(maxBytes)} 上限：请压缩图片、减少文件，或把大文件放到工作区后按目录引用。`);
    }
    seen.add(real);
    totalBytes += st.size;
    files.push({ abs: real, source, top, rel, size: st.size, refIndex });
  };

  for (const [refIndex, raw] of (refs ?? []).entries()) {
    const input = String(raw ?? '').trim();
    if (!input) continue;
    const src = path.resolve(cwd, input);
    let st;
    try { st = fs.lstatSync(src); } catch { throw new Error(`参考材料不存在：${input}`); }
    if (st.isSymbolicLink()) throw new Error(`参考材料不能是符号链接：${input}`);
    if (st.isFile()) {
      add(src, src, path.basename(src), '', refIndex);
      continue;
    }
    if (!st.isDirectory()) throw new Error(`参考材料不是文件或目录：${input}`);
    const top = path.basename(src);
    const stack = [{ dir: src, rel: '' }];
    while (stack.length > 0) {
      const { dir, rel } = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (SKIP_NAMES.has(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) { stack.push({ dir: abs, rel: nextRel }); continue; }
        if (!ent.isFile()) continue;
        add(abs, src, top, nextRel, refIndex);
      }
    }
  }
  files.sort((a, b) => (a.top.localeCompare(b.top) || a.rel.localeCompare(b.rel)));
  return { files, totalBytes };
}

function renderIndex(task, entries, totalBytes) {
  const counts = { image: 0, doc: 0, other: 0 };
  for (const e of entries) counts[e.kind] += 1;
  const rows = entries.map((e, i) => {
    const href = `<./${e.rel.replaceAll('>', '%3E')}>`;
    const label = e.rel.replaceAll('|', '\\|');
    return `| ${i + 1} | [\`${label}\`](${href}) | ${kindLabel(e.kind)} | ${humanBytes(e.size)} |`;
  });
  return [
    `# 参考材料索引 — ${task}`,
    '',
    `> 共 ${entries.length} 个文件（图片 ${counts.image}、文档 ${counts.doc}、其他 ${counts.other}），合计 ${humanBytes(totalBytes)}。`,
    '> 文本/代码/原型入口页请读全文；图片请用 `read_image` 逐张查看；无法读取的二进制在此注明，不要假装看过。',
    '',
    '| # | 文件 | 类型 | 大小 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * Copy refs into <taskDir>/inputs, then write inputs/INDEX.md.
 * Returns { files, totalBytes, indexRel } or empty when no refs were given.
 */
export function copyMaterials({ cwd, taskDir, task, refs }) {
  const collected = collectMaterialRefs(cwd, refs);
  if (collected.files.length === 0) {
    return { files: [], totalBytes: 0, indexRel: null };
  }
  const inputsDir = path.join(taskDir, 'inputs');
  fs.mkdirSync(inputsDir, { recursive: true });
  const topByRef = new Map();
  // Reserve the generated index name so an input called INDEX.md is renamed, not overwritten.
  const usedTop = new Set(['INDEX.md']);
  const entries = [];
  for (const file of collected.files) {
    if (!topByRef.has(file.refIndex)) {
      const base = safeName(file.top || path.basename(file.source));
      topByRef.set(file.refIndex, uniqueName(base, usedTop));
    }
    const top = topByRef.get(file.refIndex);
    const dest = path.resolve(inputsDir, top, file.rel);
    if (dest !== inputsDir && !dest.startsWith(inputsDir + path.sep)) {
      throw new Error(`参考材料路径越界：${file.rel}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.abs, dest);
    const rel = path.relative(inputsDir, dest).split(path.sep).join('/');
    entries.push({ rel, name: path.basename(dest), size: file.size, kind: materialKind(dest) });
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  fs.writeFileSync(path.join(inputsDir, 'INDEX.md'), renderIndex(task, entries, collected.totalBytes), 'utf8');
  return {
    files: entries,
    totalBytes: collected.totalBytes,
    indexRel: 'inputs/INDEX.md',
    imageCount: entries.filter((e) => e.kind === 'image').length,
  };
}

/** Remove stale local upload staging directories (gitignored, machine-local). */
export function cleanupStages(ws, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const root = path.join(harnessDir(ws), 'local', 'staging');
  if (!fs.existsSync(root)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (now - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/** Persist one browser upload under .harness/local/staging/<batch>/. */
export function stageUpload(ws, { batch, name, buffer }) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(batch ?? ''))) {
    throw new Error('上传批次标识无效');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('上传文件为空');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`单个文件超过 ${mb(MAX_UPLOAD_BYTES)} 上限`);
  const dir = path.join(harnessDir(ws), 'local', 'staging', batch);
  fs.mkdirSync(dir, { recursive: true });
  const count = fs.readdirSync(dir).filter((n) => {
    try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; }
  }).length;
  if (count >= MAX_UPLOAD_FILES) throw new Error(`单次最多上传 ${MAX_UPLOAD_FILES} 个文件`);
  const usedBytes = fs.readdirSync(dir).reduce((sum, n) => {
    try { return sum + fs.statSync(path.join(dir, n)).size; } catch { return sum; }
  }, 0);
  if (usedBytes + buffer.length > MAX_MATERIAL_BYTES) {
    throw new Error(`本次上传合计超过 ${mb(MAX_MATERIAL_BYTES)} 上限`);
  }
  const fileName = safeName(name || 'upload', 'upload');
  const dest = uniqueName(fileName, new Set(fs.readdirSync(dir)));
  fs.writeFileSync(path.join(dir, dest), buffer);
  return {
    path: path.relative(ws, path.join(dir, dest)).split(path.sep).join('/'),
    name: dest,
    size: buffer.length,
  };
}

/** Drop a staged upload batch after the user cancels the dialog. */
export function clearStage(ws, batch) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(batch ?? ''))) return;
  const dir = path.join(harnessDir(ws), 'local', 'staging', batch);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
