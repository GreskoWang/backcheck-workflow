import fs from 'node:fs';
import path from 'node:path';
import { assertListenerReady } from './backcheck-config.mjs';
try {
  assertListenerReady();
  if (!fs.existsSync(path.join(process.env.FEISHU_CREDENTIAL_DIR, 'credentials.json'))) throw new Error('Feishu App Secret has not been entered locally');
  console.log('LISTENER_PREREQUISITES_READY');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
