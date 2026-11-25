// Entry used only by scripts/vendor-feishu.mjs. The generated bundle is committed
// so consumers never install @larksuiteoapi/node-sdk or its protobufjs postinstall.
import * as mod from '@larksuiteoapi/node-sdk';

const lark = mod.default ?? mod;
export default lark;
export const Client = lark.Client;
export const WSClient = lark.WSClient;
export const EventDispatcher = lark.EventDispatcher;
export const LoggerLevel = lark.LoggerLevel;
