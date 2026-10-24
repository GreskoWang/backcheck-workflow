import * as Lark from '@larksuiteoapi/node-sdk';

export const silentFeishuLogger = Object.freeze({
  error() {}, warn() {}, info() {}, debug() {}, trace() {},
});

export function createQuietFeishuClient(credential) {
  return new Lark.Client({
    appId: credential.appId,
    appSecret: credential.appSecret,
    // The pinned SDK uses `loggerLevel || info`; fatal (0) would enable info.
    loggerLevel: Lark.LoggerLevel.error,
    logger: silentFeishuLogger,
  });
}
