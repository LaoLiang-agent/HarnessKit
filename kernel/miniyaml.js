// Minimal YAML subset parser/dumper for flow definitions.
// Supported: nested maps by 2-space indent, `- item` and `- key: value` lists,
// scalars (string/number/boolean/null), `#` comments, single- and
// double-quoted strings. Anything else (anchors, flow style, block scalars)
// throws — flow files authored for the kernel stay inside this subset.

class YamlSubsetError extends Error {}

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function tokenize(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const noComment = rawLine.replace(/(^|\s)#.*$/, '');
    if (noComment.trim() === '') continue;
    const indent = /^ */.exec(noComment)[0].length;
    if (indent % 2 !== 0) throw new YamlSubsetError(`奇数缩进不受支持: ${rawLine}`);
    lines.push({ indent, text: noComment.trim() });
  }
  return lines;
}

export function parseYaml(text) {
  const lines = tokenize(text);
  let pos = 0;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    if (lines[pos].indent !== indent) throw new YamlSubsetError(`缩进错位（期望 ${indent}）: ${lines[pos].text}`);
    const isList = lines[pos].text.startsWith('- ') || lines[pos].text === '-';
    return isList ? parseList(indent) : parseMap(indent);
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('-')) {
      const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(lines[pos].text);
      if (!m) throw new YamlSubsetError(`无法解析的行: ${lines[pos].text}`);
      const [, key, rest] = m;
      pos += 1;
      if (rest !== undefined && rest !== '') {
        out[key] = scalar(rest);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        out[key] = parseBlock(lines[pos].indent);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  function parseList(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const itemText = lines[pos].text === '-' ? '' : lines[pos].text.slice(2);
      const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(itemText);
      if (m) {
        // List item opening a map; subsequent keys indent past the dash.
        const itemIndent = indent + 2;
        const obj = {};
        const [, key, rest] = m;
        pos += 1;
        obj[key] = rest !== undefined && rest !== '' ? scalar(rest) : pos < lines.length && lines[pos].indent > itemIndent - 2 ? parseBlock(lines[pos].indent) : null;
        while (pos < lines.length && lines[pos].indent === itemIndent && !lines[pos].text.startsWith('-')) {
          const km = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(lines[pos].text);
          if (!km) throw new YamlSubsetError(`无法解析的行: ${lines[pos].text}`);
          const [, k2, r2] = km;
          pos += 1;
          obj[k2] = r2 !== undefined && r2 !== '' ? scalar(r2) : pos < lines.length && lines[pos].indent > itemIndent ? parseBlock(lines[pos].indent) : null;
        }
        out.push(obj);
      } else {
        out.push(scalar(itemText));
        pos += 1;
      }
    }
    return out;
  }

  const result = lines.length === 0 ? null : parseBlock(lines[0].indent);
  if (pos < lines.length) throw new YamlSubsetError(`解析在以下行处停滞: ${lines[pos].text}`);
  return result;
}

function dumpValue(value, indent) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return /[:#\n]|^[\s"'-]|^\s*$|^(true|false|null|~)$|^-?\d/.test(value) ? JSON.stringify(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item);
          if (entries.length === 0) return `${pad}- {}`;
          const [k0, v0] = entries[0];
          const head = typeof v0 === 'object' && v0 !== null && Object.keys(v0).length > 0
            ? `${pad}- ${k0}:\n${dumpValue(v0, indent + 4)}`
            : `${pad}- ${k0}: ${dumpValue(v0, 0)}`;
          const rest = dumpValue(Object.fromEntries(entries.slice(1)), indent + 2);
          return entries.length > 1 ? `${head}\n${rest}` : head;
        }
        return `${pad}- ${dumpValue(item, 0)}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !(Array.isArray(v) && v.length === 0) && Object.keys(v).length > 0) {
        return `${pad}${k}:\n${dumpValue(v, indent + 2)}`;
      }
      return `${pad}${k}: ${dumpValue(v, 0)}`;
    })
    .join('\n');
}

export function dumpYaml(value) {
  return dumpValue(value, 0) + '\n';
}
