import path from 'node:path';
import { createRequire } from 'node:module';

import {requireLark} from './runtime-paths.mjs';
const express = requireLark('express');
const { LarkAuthHandlerLocal } = requireLark('./dist/auth/handler/handler-local.js');
const { authStore } = requireLark('./dist/auth/store.js');

function report(status, exitCode) {
  console.log(JSON.stringify({ status }));
  // The official token store keeps a file watcher open; finish after writes settle.
  process.exit(exitCode);
}

const appId = process.env.APP_ID;
const appSecret = process.env.APP_SECRET;
if (!appId || !appSecret) {
  report('MISSING_CREDENTIAL', 2);
} else {
  try {
    const accessToken = await authStore.getLocalAccessToken(appId);
    const storedToken = accessToken ? await authStore.getToken(accessToken) : null;
    if (!accessToken || !storedToken) {
      report('NO_LOCAL_TOKEN', 3);
    } else if (!storedToken.extra?.refreshToken) {
      report('NO_REFRESH_TOKEN', 3);
    } else {
      const handler = new LarkAuthHandlerLocal(express(), {
        port: 3000,
        host: 'localhost',
        domain: process.env.LARK_DOMAIN || 'https://open.feishu.cn',
        appId,
        appSecret,
        scope: storedToken.scopes || [],
      });
      await handler.refreshToken(accessToken);
      report('REFRESHED', 0);
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (/invalid.refresh.token|refresh.token.is.invalid|Token parse failed: invalid response: (20038|20024|20025)/i.test(message)) {
      report('REFRESH_TOKEN_REJECTED', 3);
    } else if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|socket hang up/i.test(message)) {
      report('NETWORK_FAILURE', 2);
    } else {
      report('REFRESH_FAILED', 2);
    }
  }
}
