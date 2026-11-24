// 钉钉 Transport Adapter（占位）
import { registerTransport } from '../transport.js';

class DingTalkTransport {
  constructor(config, logger) {
    this.channel = 'dingtalk';
    this.config = config;
    this.logger = logger ?? console;
    this.ready = false;
  }

  async connect() {
    // TODO: 使用 dingtalk-stream SDK 实现
    throw new Error('钉钉渠道暂未实现');
  }

  disconnect() {}
  async sendCard() { throw new Error('钉钉渠道暂未实现'); }
  async updateCard() { throw new Error('钉钉渠道暂未实现'); }
  onCardAction() {}
  onMessage() {}
  getStatus() { return { channel: this.channel, ready: false, error: '未实现' }; }
}

registerTransport('dingtalk', (config, logger) => new DingTalkTransport(config, logger));
export { DingTalkTransport };
