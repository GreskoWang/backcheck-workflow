import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_REQUEST_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;

export function shutdownControlPath(bridgeRoot) {
  const normalized = path.resolve(String(bridgeRoot || ''));
  if (!bridgeRoot || normalized === path.parse(normalized).root) {
    throw new TypeError('bridgeRoot must name a non-root directory');
  }
  const identity = crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex')
    .slice(0, 24);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\codex-feishu-background-check-${identity}`;
  }
  return path.join(os.tmpdir(), `codex-feishu-background-check-${identity}.sock`);
}

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function safeUnlinkSocket(pipePath) {
  if (process.platform === 'win32') return;
  try {
    fs.rmSync(pipePath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeResponse(socket, response, callback) {
  socket.end(`${JSON.stringify(response)}\n`, 'utf8', callback);
}

export class ShutdownControlServer {
  constructor({ pipePath, pid = process.pid, token, onShutdown, logger } = {}) {
    if (!String(pipePath || '').trim()) throw new TypeError('pipePath is required');
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('pid must be positive');
    if (!String(token || '').trim()) throw new TypeError('token is required');
    if (typeof onShutdown !== 'function') throw new TypeError('onShutdown must be a function');
    this.pipePath = pipePath;
    this.pid = pid;
    this.token = String(token);
    this.onShutdown = onShutdown;
    this.logger = logger;
    this.server = null;
    this.sockets = new Set();
    this.accepted = false;
    this.shutdownPromise = null;
  }

  async start() {
    if (this.server) return;
    safeUnlinkSocket(this.pipePath);
    const server = net.createServer((socket) => this.#handle(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.pipePath);
    });
  }

  #handle(socket) {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
        writeResponse(socket, { ok: false, error: 'request_too_large' });
        return;
      }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      socket.pause();
      let request;
      try {
        request = JSON.parse(body.slice(0, newline));
      } catch {
        writeResponse(socket, { ok: false, error: 'invalid_json' });
        return;
      }
      if (
        request?.type !== 'shutdown' ||
        request?.pid !== this.pid ||
        !sameSecret(request?.token, this.token)
      ) {
        writeResponse(socket, { ok: false, error: 'ownership_mismatch' });
        return;
      }
      if (this.accepted) {
        writeResponse(socket, { ok: false, error: 'already_shutting_down' });
        return;
      }

      this.accepted = true;
      writeResponse(socket, { ok: true, pid: this.pid }, () => {
        queueMicrotask(() => {
          try {
            this.shutdownPromise = Promise.resolve(this.onShutdown('CONTROL_PIPE'));
            this.shutdownPromise.catch((error) => {
              this.logger?.error?.('control shutdown failed', String(error?.message || error));
            });
          } catch (error) {
            this.logger?.error?.('control shutdown failed', String(error?.message || error));
          }
        });
      });
    });
    socket.on('error', () => {});
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      server.close(finish);
      for (const socket of this.sockets) socket.end();
      timer = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
        finish();
      }, 2000);
      timer.unref?.();
    });
    safeUnlinkSocket(this.pipePath);
  }
}

export async function requestBridgeShutdown({
  pipePath,
  pid,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!String(pipePath || '').trim()) throw new TypeError('pipePath is required');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('pid must be positive');
  if (!String(token || '').trim()) throw new TypeError('token is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let settled = false;
    let body = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error(`timed out requesting graceful shutdown from pid ${pid}`));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'shutdown', pid, token })}\n`, 'utf8');
    });
    socket.on('data', (chunk) => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(body.slice(0, newline));
      } catch {
        finish(new Error('shutdown control returned invalid JSON'));
        return;
      }
      if (response?.ok !== true || response?.pid !== pid) {
        finish(new Error(`graceful shutdown rejected: ${response?.error || 'invalid_response'}`));
        return;
      }
      finish(null, response);
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('shutdown control closed without acknowledgement'));
    });
  });
}
