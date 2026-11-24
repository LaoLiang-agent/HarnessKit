// IM 通知桥接配置：机器本地，不提交、不同步
import fs from 'node:fs';
import path from 'node:path';
import { localDir } from '../paths.js';

const CONFIG_NAME = 'im-config.json';
const AUDIT_NAME = 'im-audit.jsonl';

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
        whitelist: [],
      },
      wecom: {
        enabled: false,
        botId: '',
        botSecret: '',
        targetUserId: '',
        whitelist: [],
      },
      dingtalk: {
        enabled: false,
        appKey: '',
        appSecret: '',
        targetUserId: '',
        whitelist: [],
      },
    },
    // 审批过期时间（分钟）
    approvalExpiryMinutes: 120,
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

/** 追加审计日志 */
export function appendImAudit(ws, event) {
  try {
    const dir = localDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(auditPath(ws), line, 'utf8');
  } catch { /* 审计失败不阻断 */ }
}

/** 读取最近 N 条审计日志 */
export function readImAudit(ws, limit = 100) {
  try {
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
