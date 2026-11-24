// IM Transport 抽象接口
// 每个渠道 adapter 实现这个接口，ApprovalBridge 不关心具体平台

/**
 * @typedef {Object} ImTransport
 * @property {string} channel - 渠道标识：feishu | wecom | dingtalk
 * @property {boolean} ready - 是否已连接就绪
 * @property {Function} connect - 建立连接
 * @property {Function} disconnect - 断开连接
 * @property {Function} sendCard - 发送卡片 (targetId, cardJson) => Promise<messageId>
 * @property {Function} updateCard - 更新卡片 (messageId, cardJson) => Promise<void>
 * @property {Function} onCardAction - 注册卡片按钮回调 handler
 * @property {Function} onMessage - 注册文本消息回调 handler（用于数字回复）
 * @property {Function} getStatus - 获取连接状态
 */

/** Transport 注册表 */
const transports = new Map();

/** 注册一个 transport 工厂 */
export function registerTransport(channel, factory) {
  transports.set(channel, factory);
}

/** 获取已注册的 transport 实例 */
export function getTransport(channel) {
  return transports.get(channel);
}

/** 列出所有已注册渠道 */
export function listChannels() {
  return [...transports.keys()];
}
