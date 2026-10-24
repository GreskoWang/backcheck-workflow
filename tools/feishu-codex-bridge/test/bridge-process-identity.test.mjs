import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptsDir = path.resolve('scripts');

function fixture(t, source = 'setInterval(() => {}, 1000);') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-identity-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'src', 'bridge.mjs'), source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runScript(name, root) {
  return spawnSync('pwsh', ['-NoProfile', '-File', path.join(scriptsDir, name), '-RootPath', root], {
    encoding: 'utf8', timeout: 20_000,
  });
}

test('status identifies a reused PID as unrelated, even while that PID is alive', (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(path.join(stateDir, 'bridge.pid'), `${process.pid}\n`);
  fs.mkdirSync(path.join(stateDir, 'bridge.instance.lock'));
  fs.writeFileSync(path.join(stateDir, 'bridge.instance.lock', 'owner.json'), JSON.stringify({
    pid: process.pid, token: 'old-lock', createdAt: '2000-01-01T00:00:00Z',
  }));
  const result = runScript('status.ps1', root);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.running, false);
  assert.equal(status.processIdentity, 'pid_reused_or_unrelated');
});

test('status verifies a genuine bridge process with a matching lock and start time', async (t) => {
  const root = fixture(t);
  const entry = path.join(root, 'src', 'bridge.mjs');
  const child = spawn(process.execPath, [entry], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stateDir = path.join(root, 'state');
    fs.writeFileSync(path.join(stateDir, 'bridge.pid'), `${child.pid}\n`);
    fs.mkdirSync(path.join(stateDir, 'bridge.instance.lock'));
    fs.writeFileSync(path.join(stateDir, 'bridge.instance.lock', 'owner.json'), JSON.stringify({
      pid: child.pid, token: 'live-lock', createdAt: new Date().toISOString(),
    }));
    const result = runScript('status.ps1', root);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.running, true);
    assert.equal(status.processIdentity, 'verified');
    const start = runScript('start.ps1', root);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, new RegExp(`ALREADY_RUNNING pid=${child.pid}`, 'u'));
    fs.writeFileSync(path.join(stateDir, 'bridge.instance.lock', 'owner.json'), JSON.stringify({
      pid: child.pid, token: 'old-lock-reused-pid', createdAt: '2000-01-01T00:00:00Z',
    }));
    const afterReuse = runScript('status.ps1', root);
    assert.equal(afterReuse.status, 0, afterReuse.stderr);
    assert.equal(JSON.parse(afterReuse.stdout).running, false);
    assert.equal(JSON.parse(afterReuse.stdout).processIdentity, 'lock_mismatch');
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
});

test('start archives a reused PID instead of reporting the unrelated process as running', (t) => {
  const root = fixture(t, 'process.exit(0);');
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(path.join(stateDir, 'bridge.pid'), `${process.pid}\n`);
  const result = runScript('start.ps1', root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /STALE_PID_ARCHIVED/u);
  assert.doesNotMatch(result.stdout, /ALREADY_RUNNING/u);
  assert.equal(fs.existsSync(path.join(stateDir, 'bridge.pid')), false);
  assert.equal(fs.readdirSync(stateDir).filter((name) => name.startsWith('bridge.pid.stale-')).length, 1);
});

test('start refuses a real bridge process whose PID file is missing', async (t) => {
  const root = fixture(t);
  const child = spawn(process.execPath, [path.join(root, 'src', 'bridge.mjs')], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = runScript('start.ps1', root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /live bridge process has no PID file/u);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
});
