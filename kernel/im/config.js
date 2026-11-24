// IM 通知桥接配置：机器本地，不提交、不同步
import fs from 'node:fs';
import path from 'node:path';
import { localDir } from '../paths.js';

const CONFIG_NAME = 'im-config.json';
const AUDIT_NAME = 'im-audit.jsonl';
const DEFAULT_AUDIT_RETENTION_DAYS = 15;

function configPath(ws) {
  return path.join(localDir(ws), CONFIG_NAME);
}

function auditPath(ws) {
  return path.join(localDir(ws), AUDIT_NAME);
}

/** 默认配置 */
export function defaultImConfig() {
  return {
    enabled: false,
    channels: {
      feishu: {
        enabled: false,
        appId: '',
        appSecret: '',
        targetOpenId: '',
      },
      wecom: {
        enabled: false,
        botId: '',
        botSecret: '',
        targetUserId: '',
      },
      dingtalk: {
        enabled: false,
        appKey: '',
        appSecret: '',
        targetUserId: '',
      },
    },
    // 审批过期时间（分钟）
    approvalExpiryMinutes: 120,
    // 审批日志保留天数（默认 15 天，自动清理）
    auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    // 最大并发审批数
    maxPendingApprovals: 5,
  };
}

/** 读取 IM 配置（不存在时返回默认） */
export function readImConfig(ws) {
  try {
    const raw = fs.readFileSync(configPath(ws), 'utf8');
    const parsed = JSON.parse(raw);
    // 合并默认值，确保新字段有值
    const def = defaultImConfig();
    return {
      ...def,
      ...parsed,
      channels: {
        feishu: { ...def.channels.feishu, ...parsed.channels?.feishu },
        wecom: { ...def.channels.wecom, ...parsed.channels?.wecom },
        dingtalk: { ...def.channels.dingtalk, ...parsed.channels?.dingtalk },
      },
    };
  } catch {
    return defaultImConfig();
  }
}

/** 写入 IM 配置 */
export function writeImConfig(ws, config) {
  const dir = localDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(ws), JSON.stringify(config, null, 2) + '\n', 'utf8');
  // 可能含 App Secret：仅本人可读写
  try { fs.chmodSync(configPath(ws), 0o600); } catch { /* Windows 等平台忽略 */ }
}

/** 按保留天数清理审计日志（默认 15 天），返回剩余条数 */
export function pruneImAudit(ws, retentionDays = null) {
  try {
    const file = auditPath(ws);
    if (!fs.existsSync(file)) return 0;
    const days = Number(retentionDays ?? readImConfig(ws).auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS);
    if (!Number.isFinite(days) || days <= 0) return null; // 0/非法 = 不清理
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const at = Date.parse(entry?.at ?? '');
        if (Number.isFinite(at) && at >= cutoff) kept.push(line);
      } catch { /* 损坏行直接丢弃 */ }
    }
    if (kept.length !== lines.length) {
      fs.writeFileSync(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
      try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
    }
    return kept.length;
  } catch {
    return null;
  }
}

/** 追加审计日志（写入前按保留策略清理） */
export function appendImAudit(ws, event) {
  try {
    const dir = localDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    pruneImAudit(ws);
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(auditPath(ws), line, 'utf8');
  } catch { /* 审计失败不阻断 */ }
}

/** 读取最近 N 条审计日志（读取时也按策略清理） */
export function readImAudit(ws, limit = 100) {
  try {
    pruneImAudit(ws);
    const raw = fs.readFileSync(auditPath(ws), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

/** 检查是否配置了至少一个启用的渠道 */
export function hasEnabledChannel(config) {
  return Object.values(config.channels).some((c) => c.enabled);
}
