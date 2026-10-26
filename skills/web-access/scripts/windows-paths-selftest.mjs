import assert from 'node:assert/strict';
import path from 'node:path';
import { systemPathFromEnv } from './windows-paths.mjs';

// A fictional non-default Windows drive ensures there is no drive assumption.
const root = path.win32.join('Q:', path.win32.sep, 'Windows Fixture');
assert.equal(systemPathFromEnv({ SystemRoot: root }, 'whoami.exe'), path.win32.join(root, 'System32', 'whoami.exe'));
assert.equal(systemPathFromEnv({ WINDIR: root }, 'icacls.exe'), path.win32.join(root, 'System32', 'icacls.exe'));
for (const env of [{}, { SystemRoot: 'relative' }]) {
  assert.throws(() => systemPathFromEnv(env, 'icacls.exe'), { code: 'acl_tool_missing' });
}
console.log('PASS: environment-derived Windows tools; missing/relative roots fail closed');
