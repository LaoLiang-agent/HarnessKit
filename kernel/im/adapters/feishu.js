// 飞书 Transport Adapter
// 使用 @larksuiteoapi/node-sdk WSClient + EventDispatcher
// 支持：长连接、卡片发送/更新、按钮回调、文本消息（数字回复）

import { registerTransport } from '../transport.js';

class FeishuTransport {
  constructor(config, logger) {
    this.channel = 'feishu';
    this.config = config;
    this.logger = logger ?? console;
    this.ready = false;
    this.client = null;
    this.wsClient = null;
    this.dispatcher = null;
    this.cardActionHandlers = [];
    this.messageHandlers = [];
  }

  async connect() {
    const { default: lark } = await import('@larksuiteoapi/node-sdk');
    this.lark = lark;
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('飞书配置缺少 appId 或 appSecret');
    }

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event) => {
        const msg = event?.message;
        if (!msg) return;
        const text = msg.content ? JSON.parse(msg.content).text : '';
        const senderOpenId = event?.sender?.sender_id?.open_id;
        this.logger.info?.(`[im:feishu] 收到文本消息 sender=${senderOpenId ?? '-'} len=${String(text ?? '').length}`);
        for (const handler of this.messageHandlers) {
          try { handler({ text, senderOpenId, raw: event }); } catch { /* ignore */ }
        }
      },
      'card.action.trigger': (event) => {
        for (const handler of this.cardActionHandlers) {
          try { handler(event); } catch { /* ignore */ }
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => {
        this.ready = true;
        this.logger.info?.('[im:feishu] 长连接已就绪');
      },
      onError: (err) => {
        this.ready = false;
        this.logger.error?.('[im:feishu] 连接错误:', err?.message ?? err);
      },
      onReconnecting: () => {
        this.ready = false;
        this.logger.info?.('[im:feishu] 重连中…');
      },
      onReconnected: () => {
        this.ready = true;
        this.logger.info?.('[im:feishu] 重连成功');
      },
    });

    this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  disconnect() {
    this.wsClient?.close();
    this.ready = false;
  }

  async sendCard(targetOpenId, cardJson) {
    if (!this.client) throw new Error('飞书客户端未初始化');
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: targetOpenId, msg_type: 'interactive', content: cardJson },
    });
    if (res?.code && res.code !== 0) {
      throw new Error(`飞书发送失败: ${res.msg || res.code}`);
    }
    return res?.data?.message_id;
  }

  async updateCard(messageId, cardJson) {
    if (!this.client) throw new Error('飞书客户端未初始化');
    const res = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
    if (res?.code && res.code !== 0) {
      throw new Error(`飞书更新失败: ${res.msg || res.code}`);
    }
    return messageId;
  }

  onCardAction(handler) {
    this.cardActionHandlers.push(handler);
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  getStatus() {
    return {
      channel: this.channel,
      ready: this.ready,
      targetBound: !!this.config.targetOpenId,
      whitelistSize: this.config.whitelist?.length ?? 0,
    };
  }
}

// 注册飞书 transport
registerTransport('feishu', (config, logger) => new FeishuTransport(config, logger));

export { FeishuTransport };
