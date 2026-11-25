// IM 模块入口：导出所有子模块
export { readImConfig, writeImConfig, appendImAudit, readImAudit, pruneImAudit, hasEnabledChannel, defaultImConfig } from './config.js';
export { registerTransport, getTransport, listChannels } from './transport.js';
export { ApprovalBridge } from './bridge.js';
export { buildApprovalCard, buildPermissionCard, buildResultCard, parseActionValue } from './cards.js';
// 注册 adapters（import 即注册）
import './adapters/feishu.js';
import './adapters/wecom.js';
import './adapters/dingtalk.js';
