import path from 'node:path';

import { bridgeRoot as defaultBridgeRoot } from '../src/config.mjs';
import { requestBridgeShutdown, shutdownControlPath } from '../src/shutdown-control.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.once('end', () => resolve(body));
    process.stdin.once('error', reject);
  });
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  process.stderr.write('shutdown request input must be JSON\n');
  process.exitCode = 2;
}

if (input) {
  const requestedRoot = String(input.bridgeRoot || defaultBridgeRoot).trim();
  const bridgeRoot = path.resolve(requestedRoot);
  const pid = Number(input.pid);
  const token = String(input.token || '').trim();
  const timeoutMs = Number(input.timeoutMs || 5000);
  if (
    !requestedRoot ||
    bridgeRoot === path.parse(bridgeRoot).root ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !token
  ) {
    process.stderr.write('shutdown request requires a positive pid and lock token\n');
    process.exitCode = 2;
  } else {
    try {
      await requestBridgeShutdown({
        pipePath: shutdownControlPath(bridgeRoot),
        pid,
        token,
        timeoutMs,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, pid })}\n`);
    } catch (error) {
      process.stderr.write(`graceful shutdown request failed: ${String(error?.message || error)}\n`);
      process.exitCode = 3;
    }
  }
}

// Keep this script free of state writes. stop.ps1 owns PID/lock verification
// and the bridge itself removes them during shutdown.
