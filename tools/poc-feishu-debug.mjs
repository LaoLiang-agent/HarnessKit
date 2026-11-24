#!/usr/bin/env node
/**
 * Minimal Feishu WS debug: print every frame received
 */
import lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (event) => {
    console.log('\n=== MESSAGE RECEIVED ===');
    console.log(JSON.stringify(event, null, 2).slice(0, 2000));
    console.log('=======================\n');
  },
  'card.action.trigger': (event) => {
    console.log('\n=== CARD ACTION ===');
    console.log(JSON.stringify(event, null, 2).slice(0, 2000));
    console.log('===================\n');
  },
});

// Also listen to ALL events via a catch-all if possible
const originalRegister = dispatcher.register.bind(dispatcher);
dispatcher.register = function(handles) {
  for (const [name, fn] of Object.entries(handles)) {
    const wrapped = (event) => {
      console.log(`\n>>> DISPATCH: ${name}`);
      console.log(JSON.stringify(event, null, 2).slice(0, 500));
      return fn(event);
    };
    originalRegister.call(dispatcher, { [name]: wrapped });
  }
  return this;
};

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.debug,  // verbose
  onReady: () => {
    console.log('\n✅ WS READY - waiting for events...\n');
  },
  onError: (err) => {
    console.error('\n❌ WS ERROR:', err?.message ?? err);
  },
  onReconnecting: () => console.log('\n🔄 RECONNECTING...\n'),
  onReconnected: () => console.log('\n✅ RECONNECTED\n'),
});

console.log('Starting WSClient...');
wsClient.start({ eventDispatcher: dispatcher });

process.on('SIGINT', () => {
  console.log('\nStopping...');
  wsClient.close();
  process.exit(0);
});
