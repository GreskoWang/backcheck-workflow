import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ShutdownControlServer,
  requestBridgeShutdown,
  shutdownControlPath,
} from '../src/shutdown-control.mjs';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-shutdown-control-'));
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached before timeout');
}

test('the local control channel acknowledges ownership before invoking shutdown', async () => {
  const root = temporaryRoot();
  const pipePath = shutdownControlPath(root);
  let shutdownSignal = null;
  const server = new ShutdownControlServer({
    pipePath,
    pid: process.pid,
    token: 'verified-owner-token',
    onShutdown(signal) { shutdownSignal = signal; },
  });
  try {
    await server.start();
    const response = await requestBridgeShutdown({
      pipePath,
      pid: process.pid,
      token: 'verified-owner-token',
    });
    assert.deepEqual(response, { ok: true, pid: process.pid });
    await waitFor(() => shutdownSignal !== null);
    assert.equal(shutdownSignal, 'CONTROL_PIPE');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wrong pid or token cannot request shutdown', async () => {
  const root = temporaryRoot();
  const pipePath = shutdownControlPath(root);
  let shutdownCount = 0;
  const server = new ShutdownControlServer({
    pipePath,
    pid: process.pid,
    token: 'correct-token',
    onShutdown() { shutdownCount += 1; },
  });
  try {
    await server.start();
    await assert.rejects(
      requestBridgeShutdown({ pipePath, pid: process.pid, token: 'wrong-token' }),
      /ownership_mismatch/u,
    );
    await assert.rejects(
      requestBridgeShutdown({ pipePath, pid: process.pid + 1, token: 'correct-token' }),
      /ownership_mismatch/u,
    );
    assert.equal(shutdownCount, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control pipe identity is stable per bridge root and different across roots', () => {
  const first = path.join(os.tmpdir(), 'bridge-a');
  const second = path.join(os.tmpdir(), 'bridge-b');
  assert.equal(shutdownControlPath(first), shutdownControlPath(first));
  assert.notEqual(shutdownControlPath(first), shutdownControlPath(second));
});
