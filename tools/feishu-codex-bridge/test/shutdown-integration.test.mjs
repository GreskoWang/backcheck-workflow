import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSource = path.join(repoRoot, 'test', 'fixtures', 'shutdown-bridge-child.mjs');
const legacyFixtureSource = path.join(repoRoot, 'test', 'fixtures', 'legacy-bridge-child.mjs');
const stopScript = path.join(repoRoot, 'scripts', 'stop.ps1');
const cimCanInspectSelf = process.platform === 'win32' && spawnSync('pwsh', [
  '-NoProfile', '-NonInteractive', '-Command',
  'try { if (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop) { exit 0 } } catch {} ; exit 1',
], { windowsHide: true, stdio: 'ignore' }).status === 0;

function collectProcess(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { closed, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitForLine(output, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = output().split(/\r?\n/u).find((candidate) => predicate(candidate));
    if (line !== undefined) return line;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for child readiness');
}

for (const prefix of ['feishu-graceful-stop-', 'feishu-中文停机-']) {
test(`stop.ps1 gracefully cleans up a separately running bridge (${prefix})`, {
  skip: process.platform !== 'win32' ? 'Windows stop path' :
    !cimCanInspectSelf ? 'CIM process identity query is denied in this execution account' : false,
  timeout: 20_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const entry = path.join(root, 'src', 'bridge.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(fixtureSource, entry);

  const bridge = spawn(process.execPath, [
    entry,
    root,
    path.join(repoRoot, 'src', 'instance-lock.mjs'),
    path.join(repoRoot, 'src', 'shutdown-control.mjs'),
  ], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgeOutput = collectProcess(bridge);
  t.after(async () => {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGTERM');
    try { await bridgeOutput.closed; } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readyLine = await waitForLine(
    bridgeOutput.getStdout,
    (line) => line.includes('"ready":true'),
  );
  const ready = JSON.parse(readyLine);
  assert.equal(ready.pid, bridge.pid);

  const taskName = `Codex-Feishu-Bridge-Test-${process.pid}-${Date.now()}`;
  const stopper = spawn('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', stopScript,
    '-RootPath', root,
    '-ScheduledTaskName', taskName,
    '-TimeoutSeconds', '5',
    '-RequestTimeoutSeconds', '2',
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopOutput = collectProcess(stopper);
  const stopResult = await stopOutput.closed;
  assert.equal(stopResult.code, 0, stopResult.stderr || stopResult.stdout);
  assert.match(stopResult.stdout, new RegExp(`STOPPED_GRACEFULLY pid=${bridge.pid}`, 'u'));

  const bridgeResult = await bridgeOutput.closed;
  assert.equal(bridgeResult.code, 0, bridgeResult.stderr || bridgeResult.stdout);
  const marker = JSON.parse(fs.readFileSync(
    path.join(root, 'state', 'graceful-stop-complete.json'),
    'utf8',
  ));
  assert.deepEqual(marker, { signal: 'CONTROL_PIPE', pid: bridge.pid });
  assert.equal(fs.existsSync(path.join(root, 'state', 'bridge.pid')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'bridge.instance.lock')), false);
});
}

test('stop.ps1 refuses a live pid whose command line is not this bridge entry', {
  skip: process.platform !== 'win32' ? 'Windows stop path' : false,
  timeout: 15_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-stop-ownership-'));
  const stateDir = path.join(root, 'state');
  const lockDir = path.join(stateDir, 'bridge.instance.lock');
  fs.mkdirSync(lockDir, { recursive: true });

  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const unrelatedOutput = collectProcess(unrelated);
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGTERM');
    try { await unrelatedOutput.closed; } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(stateDir, 'bridge.pid'), `${unrelated.pid}\n`, 'utf8');
  fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
    pid: unrelated.pid,
    token: 'test-owner-token',
    createdAt: new Date().toISOString(),
  })}\n`, 'utf8');

  const stopper = spawn('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', stopScript,
    '-RootPath', root,
    '-ScheduledTaskName', `Codex-Feishu-Bridge-Test-${process.pid}-${Date.now()}`,
    '-TimeoutSeconds', '5',
    '-RequestTimeoutSeconds', '2',
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopOutput = collectProcess(stopper);
  const stopResult = await stopOutput.closed;
  assert.notEqual(stopResult.code, 0, 'ownership mismatch should fail closed');
  assert.match(stopResult.stderr, cimCanInspectSelf
    ? /does not belong to this bridge; refusing to stop it/u
    : /Cannot verify process identity .* through CIM; refusing to treat it as stopped/u);
  assert.equal(fs.existsSync(path.join(stateDir, 'bridge.pid')), true);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test('stop.ps1 can safely retire a pre-control legacy bridge after the timeout', {
  skip: process.platform !== 'win32' ? 'Windows stop path' :
    !cimCanInspectSelf ? 'CIM process identity query is denied in this execution account' : false,
  timeout: 20_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-legacy-stop-'));
  const entry = path.join(root, 'src', 'bridge.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(legacyFixtureSource, entry);

  const bridge = spawn(process.execPath, [entry, root], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgeOutput = collectProcess(bridge);
  t.after(async () => {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGTERM');
    try { await bridgeOutput.closed; } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitForLine(bridgeOutput.getStdout, (line) => line.includes('"legacy":true'));

  const stopper = spawn('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', stopScript,
    '-RootPath', root,
    '-ScheduledTaskName', `Codex-Feishu-Bridge-Test-${process.pid}-${Date.now()}`,
    '-TimeoutSeconds', '5',
    '-RequestTimeoutSeconds', '2',
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopOutput = collectProcess(stopper);
  const stopResult = await stopOutput.closed;
  assert.equal(stopResult.code, 0, stopResult.stderr || stopResult.stdout);
  assert.match(
    stopResult.stdout,
    new RegExp(`STOPPED_FORCED_AFTER_TIMEOUT pid=${bridge.pid}`, 'u'),
  );

  const bridgeResult = await bridgeOutput.closed;
  assert.notEqual(bridgeResult.code, 0, 'legacy fixture should be force-terminated');
  assert.equal(fs.existsSync(path.join(root, 'state', 'bridge.pid')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'bridge.instance.lock')), false);
});
