import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('the pinned SDK fatal level emits info but the quiet client emits only caller JSON', () => {
  const code = `
    import * as Lark from '@larksuiteoapi/node-sdk';
    import { createQuietFeishuClient } from './src/quiet-feishu-client.mjs';
    new Lark.Client({ appId: 'dummy', appSecret: 'dummy', loggerLevel: Lark.LoggerLevel.fatal });
    process.stdout.write('OLD_DONE\\n');
    createQuietFeishuClient({ appId: 'dummy', appSecret: 'dummy' });
    process.stdout.write('QUIET_DONE\\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[info\].*client ready[\s\S]*OLD_DONE/u);
  assert.equal(result.stdout.split('OLD_DONE\n')[1], 'QUIET_DONE\n');
});
