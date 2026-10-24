import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = path.resolve('.');
const shell = 'powershell.exe';

function runPowerShell(script) {
  return spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: workspace, encoding: 'utf8', timeout: 15_000,
  });
}

test('Windows PowerShell 5.1 reads BOM-free UTF-8 and redacts malformed input', {
  skip: process.platform !== 'win32',
}, () => {
  const result = runPowerShell(path.join(workspace, 'test', 'diagnostic-json-windows.ps1'));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, shell: 'Windows PowerShell 5.1', cases: 10,
  });
});

