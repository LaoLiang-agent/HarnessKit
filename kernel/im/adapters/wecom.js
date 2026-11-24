// 企微 Transport Adapter（占位，等审批通过后实现）
import { registerTransport } from '../transport.js';

class WeComTransport {
  constructor(config, logger) {
    this.channel = 'wecom';
    this.config = config;
    this.logger = logger ?? console;
    this.ready = false;
  }

  async connect() {
    // TODO: 等企微机器人审批通过后实现
    // 使用 @wecom/aibot-node-sdk
    throw new Error('企微渠道暂未实现，等待机器人审批');
  }

  disconnect() {}
  async sendCard() { throw new Error('企微渠道暂未实现'); }
  async updateCard() { throw new Error('企微渠道暂未实现'); }
  onCardAction() {}
  onMessage() {}
  getStatus() { return { channel: this.channel, ready: false, error: '未实现' }; }
}

registerTransport('wecom', (config, logger) => new WeComTransport(config, logger));
export { WeComTransport };
