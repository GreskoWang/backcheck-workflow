import fs from 'node:fs';

import { config } from './config.mjs';
import { resolveDispatchScope } from './codex-runner.mjs';

const requestText = fs.readFileSync(0, 'utf8').trim();
if (!requestText) throw new Error('Pass one background-check request on stdin');

const { scope } = await resolveDispatchScope({
  requestId: 'RQ-SCOPE-CHECK',
  senderId: 'local-check',
  requestText,
}, config);
console.log(JSON.stringify(scope, null, 2));
