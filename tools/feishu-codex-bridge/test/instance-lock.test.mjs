import { fixturePath } from './fixture-paths.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireInstanceLock } from '../src/instance-lock.mjs';

const moduleUrl = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/instance-lock.mjs',
)).href;

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-instance-lock-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function childAcquire(lockPath, legacyPidPath = null) {
  const source = `
    import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lock = acquireInstanceLock(${JSON.stringify(lockPath)}, {
        legacyPidPath: ${JSON.stringify(legacyPidPath)},
      });
      lock.release();
      console.log('ACQUIRED');
      process.exitCode = 9;
    } catch (error) {
      console.log(error.code || error.name);
      process.exitCode = 0;
    }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('a second process is rejected while the owner is alive', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const first = acquireInstanceLock(lockPath);
    try {
      const child = childAcquire(lockPath);
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /INSTANCE_LOCKED/u);
    } finally {
      assert.equal(first.release(), true);
    }
  });
});

test('release allows a later instance to acquire the lock', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const first = acquireInstanceLock(lockPath);
    assert.equal(first.release(), true);

    const second = acquireInstanceLock(lockPath);
    assert.notEqual(second.token, first.token);
    assert.equal(second.release(), true);
  });
});

test('a dead owner is atomically reclaimed', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'stale-owner-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    }), 'utf8');

    const lock = acquireInstanceLock(lockPath);
    try {
      assert.equal(lock.pid, process.pid);
      assert.notEqual(lock.token, 'stale-owner-token');
      const persisted = JSON.parse(fs.readFileSync(
        path.join(lockPath, 'owner.json'),
        'utf8',
      ));
      assert.equal(persisted.pid, process.pid);
      assert.equal(persisted.token, lock.token);
    } finally {
      assert.equal(lock.release(), true);
    }
  });
});

test('a reused PID owned by an unrelated process does not preserve a stale lock or PID file', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const legacyPidPath = path.join(directory, 'bridge.pid');
    const entryPath = path.join(directory, 'src', 'bridge.mjs');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 5232, token: 'old-owner', createdAt: '2026-10-08T10:19:16.900Z',
    }));
    fs.writeFileSync(legacyPidPath, '5232\n');
    const lock = acquireInstanceLock(lockPath, {
      legacyPidPath, entryPath,
      inspectProcess: (pid) => pid === 5232 ? {
        name: 'svchost.exe', commandLine: fixturePath('system', 'svchost.exe'),
        createdAtMs: Date.parse('2026-10-08T12:40:17Z'),
      } : null,
    });
    try { assert.notEqual(lock.token, 'old-owner'); }
    finally { assert.equal(lock.release(), true); }
  });
});

test('a real bridge owner stays locked, including when another instance tries to start', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const entryPath = path.join(directory, 'src', 'bridge.mjs');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 34056, token: 'live-owner', createdAt: '2026-10-08T14:15:05.616Z',
    }));
    const commandLine = `"${process.execPath}" "${entryPath}"`;
    assert.throws(() => acquireInstanceLock(lockPath, {
      entryPath,
      inspectProcess: () => ({
        name: 'node.exe', commandLine,
        createdAtMs: Date.parse('2026-10-08T14:15:05Z'),
      }),
    }), (error) => error?.code === 'INSTANCE_LOCKED');
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).token, 'live-owner');
  });
});

test('unverifiable process identity cannot reclaim an existing lock', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const entryPath = path.join(directory, 'src', 'bridge.mjs');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 34056, token: 'unverified-owner', createdAt: '2026-10-08T14:15:05.616Z',
    }));
    assert.throws(() => acquireInstanceLock(lockPath, {
      entryPath,
      inspectProcess: () => { throw new Error('CIM unavailable'); },
    }), /CIM unavailable/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).token, 'unverified-owner');
  });
});

test('identity failure after quarantine restores the original lock', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const entryPath = path.join(directory, 'src', 'bridge.mjs');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 34056, token: 'protected-owner', createdAt: '2026-10-08T14:15:05.616Z',
    }));
    let inspections = 0;
    assert.throws(() => acquireInstanceLock(lockPath, {
      entryPath,
      inspectProcess: () => {
        inspections += 1;
        if (inspections === 1) return null;
        throw new Error('identity became unreadable');
      },
    }), /identity became unreadable/u);
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).token, 'protected-owner');
  });
});

test('Windows CIM recognizes a real Node owner through a Unicode entry path', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '飞书进程身份-'));
  const entryPath = path.join(directory, 'bridge.mjs');
  const lockPath = path.join(directory, 'bridge.lock');
  fs.writeFileSync(entryPath, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [entryPath], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: child.pid, token: 'unicode-live-owner', createdAt: new Date().toISOString(),
    }));
    assert.throws(() => acquireInstanceLock(lockPath, { entryPath }),
      (error) => error?.code === 'INSTANCE_LOCKED');
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a live legacy pid owned by another process is rejected', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const legacyPidPath = path.join(directory, 'bridge.pid');
    fs.writeFileSync(legacyPidPath, `${process.pid}\n`, 'utf8');

    const child = childAcquire(lockPath, legacyPidPath);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /LEGACY_INSTANCE_RUNNING/u);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('release never deletes a lock whose token has changed', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    const lock = acquireInstanceLock(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'replacement-owner-token',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    assert.equal(lock.release(), false);
    assert.equal(fs.existsSync(lockPath), true);
    const persisted = JSON.parse(fs.readFileSync(
      path.join(lockPath, 'owner.json'),
      'utf8',
    ));
    assert.equal(persisted.token, 'replacement-owner-token');
  });
});

test('a delayed initializer never deletes a replacement lock after stale reclaim', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'bridge.lock');
    let replacement;

    assert.throws(
      () => acquireInstanceLock(lockPath, {
        pid: 111_111,
        token: 'delayed-owner-token',
        initializationGraceMs: 0,
        isProcessAlive: () => false,
        beforeOwnerWrite() {
          const old = new Date('2000-01-01T00:00:00.000Z');
          fs.utimesSync(lockPath, old, old);
          replacement = acquireInstanceLock(lockPath, {
            pid: 222_222,
            token: 'replacement-owner-token',
            initializationGraceMs: 0,
            isProcessAlive: () => false,
          });
        },
      }),
      (error) => error?.code === 'EEXIST',
    );

    try {
      assert.equal(fs.existsSync(lockPath), true);
      const persisted = JSON.parse(fs.readFileSync(
        path.join(lockPath, 'owner.json'),
        'utf8',
      ));
      assert.equal(persisted.token, 'replacement-owner-token');
    } finally {
      assert.equal(replacement.release(), true);
    }
  });
});
