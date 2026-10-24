import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function loopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function clientFrame(opcode, value = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.allocUnsafe(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }
  const output = Buffer.allocUnsafe(header.length + payload.length);
  header.copy(output);
  for (let index = 0; index < payload.length; index += 1) {
    output[header.length + index] = payload[index] ^ mask[index % 4];
  }
  return output;
}

export class LoopbackWebSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(rawUrl, { maxMessageBytes = 32 * 1024 * 1024 } = {}) {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'ws:' || !loopbackHost(parsed.hostname) || parsed.username || parsed.password || parsed.hash) {
      throw new Error('LoopbackWebSocket only accepts credential-free ws:// loopback URLs.');
    }
    this.url = parsed.toString();
    this.readyState = CONNECTING;
    this.maxMessageBytes = maxMessageBytes;
    this.listeners = new Map();
    this.request = null;
    this.transportSocket = null;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closeEmitted = false;
    this.closeTimer = null;

    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    const request = http.request({
      host: hostname,
      port: Number(parsed.port || 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    this.request = request;
    request.once('socket', (socket) => { this.transportSocket = socket; });
    request.once('upgrade', (response, socket, head) => {
      if (this.readyState !== CONNECTING) { socket.destroy(); return; }
      const accept = String(response.headers['sec-websocket-accept'] || '');
      const upgrade = String(response.headers.upgrade || '').toLowerCase();
      const connection = String(response.headers.connection || '').toLowerCase();
      if (response.statusCode !== 101 || accept !== expectedAccept || upgrade !== 'websocket' || !connection.split(/\s*,\s*/u).includes('upgrade') || response.headers['sec-websocket-extensions']) {
        socket.destroy();
        this._fail(new Error('Invalid WebSocket upgrade response.'));
        return;
      }
      this.socket = socket;
      this.transportSocket = socket;
      this.request = null;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._consume(chunk));
      socket.once('error', (error) => this._fail(error));
      socket.once('close', () => this._finishClose());
      socket.once('end', () => this._finishClose());
      this.readyState = OPEN;
      this._emit('open');
      if (head?.length) this._consume(head);
    });
    request.once('response', (response) => {
      response.resume();
      this._fail(new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}.`));
    });
    request.once('error', (error) => this._fail(error));
    request.end();
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return this;
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  addEventListener(event, listener) { return this.on(event, listener); }
  removeEventListener(event, listener) { return this.off(event, listener); }

  send(value) {
    if (this.readyState !== OPEN || !this.socket) throw new Error('WebSocket is not open.');
    const payload = Buffer.from(String(value), 'utf8');
    if (payload.length > this.maxMessageBytes) throw new Error('WebSocket outbound message exceeds limit.');
    this.socket.write(clientFrame(0x1, payload));
  }

  close() {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (this.readyState === CONNECTING) { this.terminate(); return; }
    this.readyState = CLOSING;
    try { this.socket?.write(clientFrame(0x8)); } catch {}
    try { this.socket?.end(); } catch {}
    this.closeTimer = setTimeout(() => this.terminate(), 250);
    this.closeTimer.unref?.();
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    try { this.request?.destroy(); } catch {}
    const sockets = new Set([this.transportSocket, this.socket].filter(Boolean));
    for (const socket of sockets) {
      try {
        // On Windows, destroy() can leave an upgraded HTTP socket observable
        // at the peer for several seconds. A reset makes timeout/abort
        // retirement immediate, which is essential before a new lease may
        // attach to the same Edge target.
        if (typeof socket.resetAndDestroy === 'function' && !socket.destroyed) socket.resetAndDestroy();
        else socket.destroy();
      } catch {
        try { socket.destroy(); } catch {}
      }
    }
    this.request = null;
    this.transportSocket = null;
    this.socket = null;
    this._finishClose();
  }

  _emit(event, value) {
    for (const listener of [...(this.listeners.get(event) || [])]) {
      try { listener(value); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  _fail(error) {
    if (this.readyState === CLOSED) return;
    this._emit('error', error instanceof Error ? error : new Error(String(error)));
    this.terminate();
  }

  _finishClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    clearTimeout(this.closeTimer);
    this.readyState = CLOSED;
    this.request = null;
    this.transportSocket = null;
    this.socket = null;
    this._emit('close');
  }

  _protocolError(message) {
    this._fail(new Error(`WebSocket protocol error: ${message}`));
  }

  _consume(chunk) {
    if (this.readyState === CLOSED) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (this.buffer.length > this.maxMessageBytes + 14) { this._protocolError('receive buffer exceeds limit'); return; }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      if (first & 0x70) { this._protocolError('RSV bits are set'); return; }
      if (second & 0x80) { this._protocolError('server frame is masked'); return; }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER) || large > BigInt(this.maxMessageBytes)) { this._protocolError('frame exceeds limit'); return; }
        length = Number(large);
        offset = 10;
      }
      if (opcode >= 0x8 && (!fin || length > 125)) { this._protocolError('invalid control frame'); return; }
      if (length > this.maxMessageBytes || this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        if (length === 1) { this._protocolError('invalid close payload'); return; }
        if (this.readyState === OPEN) {
          this.readyState = CLOSING;
          try { this.socket?.write(clientFrame(0x8, payload)); } catch {}
        }
        try { this.socket?.end(); } catch {}
        this._finishClose();
        return;
      }
      if (opcode === 0x9) {
        try { this.socket?.write(clientFrame(0xA, payload)); } catch {}
        continue;
      }
      if (opcode === 0xA) continue;
      if (![0x0, 0x1, 0x2].includes(opcode)) { this._protocolError('unsupported opcode'); return; }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) { this._protocolError('unexpected continuation'); return; }
      } else {
        if (this.fragmentOpcode !== null) { this._protocolError('interleaved fragmented message'); return; }
        this.fragmentOpcode = opcode;
      }
      this.fragments.push(Buffer.from(payload));
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) { this._protocolError('message exceeds limit'); return; }
      if (!fin) continue;
      const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentBytes);
      const messageOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = null;
      if (messageOpcode === 0x1) {
        try { this._emit('message', new TextDecoder('utf-8', { fatal: true }).decode(message)); }
        catch { this._protocolError('invalid UTF-8 text'); return; }
      } else this._emit('message', message);
    }
  }
}

export default LoopbackWebSocket;
