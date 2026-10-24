#!/usr/bin/env node

// Black-box coverage for the broker's private httpJson helper. Occupying the
// broker port forces startServer() through existingBrokerHealthy(), without
// exporting internals or touching a real browser.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BROKER_PATH = path.join(SCRIPT_DIR, 'cdp-proxy.mjs');

async function startHostileHealthServer(mode) {
  const sockets = new Set();
  const timers = new Set();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'drip') {
      response.write('{');
      const timer = setInterval(() => {
        if (response.destroyed) {
          clearInterval(timer);
          timers.delete(timer);
          return;
        }
        response.write(' ');
      }, 40);
      timers.add(timer);
      response.once('close', () => {
        clearInterval(timer);
        timers.delete(timer);
      });
      return;
    }
    if (mode === 'oversize') {
      response.write(`{"padding":"${'x'.repeat(300 * 1024)}`);
      return; // Deliberately never end the response.
    }
    throw new Error(`unknown hostile response mode: ${mode}`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(typeof address === 'object' && address && Number.isInteger(address.port));
  return {
    port: address.port,
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runBrokerAgainstOccupiedPort(port, tokenDir, timeoutMs = 2500) {
  const child = spawn(process.execPath, [BROKER_PATH], {
    cwd: SCRIPT_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      CDP_PROXY_PORT: String(port),
      CDP_PROXY_TOKEN_DIR: tokenDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let timer;
  const result = await Promise.race([
    exit,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!result) {
    child.kill('SIGKILL');
    await exit;
    assert.fail(`broker did not honor the absolute HTTP deadline; stderr=${stderr.join('')}`);
  }
  return { ...result, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function assertBoundedHostileResponse(mode, maxElapsedMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-cdp-http-${mode}-`));
  const server = await startHostileHealthServer(mode);
  const startedAt = Date.now();
  try {
    const result = await runBrokerAgainstOccupiedPort(server.port, path.join(root, 'tokens'));
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.code, 1, `occupied-port broker unexpectedly succeeded: ${result.stdout}`);
    assert.match(result.stderr, /port_in_use/u);
    assert.ok(elapsedMs <= maxElapsedMs, `${mode} response exceeded ${maxElapsedMs}ms (${elapsedMs}ms)`);
    return elapsedMs;
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const dripElapsedMs = await assertBoundedHostileResponse('drip', 2000);
const oversizeElapsedMs = await assertBoundedHostileResponse('oversize', 1500);
console.log(`cdp-proxy HTTP self-test: drip=${dripElapsedMs}ms oversize=${oversizeElapsedMs}ms`);

