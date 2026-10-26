#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { windowsSystemPath } from './windows-paths.mjs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import LoopbackWebSocket from './loopback-websocket.mjs';
import { assertCdpMethodAllowed } from './cdp-proxy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BROKER_PATH = path.join(SCRIPT_DIR, 'cdp-proxy.mjs');
const OWNER = 'integration-test:fake-cdp';
const TARGET_ID = 'fake-page-1';
const TARGET_URL = 'https://example.test/public-page';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// WHATWG Fetch blocks these ports even on loopback. Avoid a rare test-harness
// failure when the OS happens to allocate one of them for a fake server.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

async function waitFor(check, { timeoutMs = 8000, intervalMs = 30, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function reservePort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    await new Promise((resolve) => server.close(resolve));
    assert.ok(Number.isInteger(port) && port > 0, 'failed to reserve a loopback port');
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error('failed to reserve a Fetch-compatible loopback port');
}

function makeTestBrokerMarker(port, markerKey, nonce) {
  assert.match(nonce, /^[A-Za-z0-9_-]{24}$/u, 'test marker nonce must be 18-byte base64url');
  const mac = createHmac('sha256', markerKey).update(`v2:${port}:${nonce}`).digest('base64url');
  return `about:blank#codex-edge-broker-v2-${port}-${nonce}-${mac}`;
}

function windowsAclSnapshot(filePath) {
  assert.equal(os.platform(), 'win32', 'Windows ACL snapshot is Windows-only');
  const whoami = windowsSystemPath('whoami.exe');
  const identity = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
  });
  const fields = String(identity.stdout || '').trim().match(/"([^"]*)","([^"]*)"/u);
  assert.equal(identity.status, 0, identity.stderr || identity.stdout || 'whoami failed');
  assert.ok(fields?.[2], 'current Windows SID was not reported');
  const sid = fields[2];
  const payload = Buffer.from(JSON.stringify({ filePath }), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    '$acl=Get-Acl -LiteralPath ([string]$d.filePath)',
    '$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{Sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;Type=$_.AccessControlType.ToString()} })',
    '[pscustomobject]@{Protected=$acl.AreAccessRulesProtected;Rules=$rules}|ConvertTo-Json -Compress -Depth 4',
  ].join(';');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const powershellCandidates = [
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')] : []),
    windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  const powershell = powershellCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(powershell, 'PowerShell executable required for ACL verification was not found');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Get-Acl failed');
  const value = JSON.parse(String(result.stdout || '').trim());
  const rules = Array.isArray(value.Rules) ? value.Rules : value.Rules ? [value.Rules] : [];
  return { protected: value.Protected, rules, sid };
}

async function assertConnectingTerminateClosesTcp() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const socket = new LoopbackWebSocket(`ws://127.0.0.1:${address.port}/devtools/browser/blackhole`);
  socket.on('error', () => {});
  await waitFor(() => sockets.size === 1, { timeoutMs: 2000, label: 'blackhole websocket TCP accept' });
  socket.terminate();
  await waitFor(() => sockets.size === 0, { timeoutMs: 2000, label: 'CONNECTING websocket TCP teardown' });
  await new Promise((resolve) => server.close(resolve));
}

function encodeServerFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function consumeClientFrames(state, onText) {
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let payloadLength = second & 0x7f;
    let offset = 2;
    if (payloadLength === 126) {
      if (state.buffer.length < 4) return;
      payloadLength = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (state.buffer.length < 10) return;
      const longLength = state.buffer.readBigUInt64BE(2);
      assert.ok(longLength <= BigInt(Number.MAX_SAFE_INTEGER), 'oversized websocket frame');
      payloadLength = Number(longLength);
      offset = 10;
    }
    const maskBytes = masked ? 4 : 0;
    if (state.buffer.length < offset + maskBytes + payloadLength) return;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskBytes;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + payloadLength));
    state.buffer = state.buffer.subarray(offset + payloadLength);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }

    if (opcode === 0x8) {
      state.socket.write(encodeServerFrame(0x8, payload));
      state.socket.end();
      continue;
    }
    if (opcode === 0x9) {
      state.socket.write(encodeServerFrame(0xA, payload));
      continue;
    }
    if (opcode === 0x1) {
      state.fragmentOpcode = opcode;
      state.fragments = [payload];
    } else if (opcode === 0x0 && state.fragmentOpcode === 0x1) {
      state.fragments.push(payload);
    } else if (opcode === 0xA) {
      continue;
    } else {
      throw new Error(`unsupported websocket opcode ${opcode}`);
    }
    if (fin) {
      const text = Buffer.concat(state.fragments).toString('utf8');
      state.fragmentOpcode = null;
      state.fragments = [];
      onText(text);
    }
  }
}

async function startFakeCdp({ browserVersion = null } = {}) {
  const sockets = new Set();
  const state = {
    activeRuntimeCalls: 0,
    maxActiveRuntimeCalls: 0,
    runtimeCallCount: 0,
    researchSnapshot: null,
    researchRuntimeCalls: [],
    methodCounts: new Map(),
    targets: new Map([[TARGET_ID, { targetId: TARGET_ID, type: 'page', title: 'Fake Page', url: TARGET_URL, attached: false }]]),
    sessions: new Map(),
    socketStates: new WeakMap(),
    connectionCount: 0,
    attachCount: 0,
    closedConnectionIds: new Set(),
    closedConnectionTimes: new Map(),
    commandLog: [],
    createdTargetCount: 0,
    nextCreateBehavior: null,
    delayedCreateRecords: [],
    navigateBehaviorsByUrl: new Map(),
    delayedNavigateRecords: [],
    lostNavigateRecords: [],
    destroyNextCreatedDuringInitialization: false,
    pendingDestroyOnEnable: new Set(),
    destroyAfterTargetInfoResponse: new Set(),
    attachAfterTargetInfoResponse: new Set(),
    closeBehaviors: new Map(),
    detachBehaviors: new Map(),
    attachBehaviors: new Map(),
    delayedAttachRecords: [],
    destroyDuringNavigate: new Set(),
    stallRuntimeForTarget: null,
    destroyedTargetIds: new Set(),
    lastDestroyedTargetId: null,
    nextRuntimeWindowOpen: null,
    lastRuntimeNoOpenerTargetId: null,
    emitExistingTargetsOnDiscover: false,
  };
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end('fake CDP only accepts websocket upgrades');
  });

  const replyFor = async (socket, message) => {
    const count = state.methodCounts.get(message.method) || 0;
    state.methodCounts.set(message.method, count + 1);
    const socketState = state.socketStates.get(socket);
    state.commandLog.push({
      method: message.method,
      targetId: message.params?.targetId || null,
      sessionId: message.sessionId || message.params?.sessionId || null,
      url: message.params?.url || null,
      connectionId: socketState?.id || null,
    });
    const send = (value) => socket.write(encodeServerFrame(0x1, JSON.stringify(value)));
    const sendError = (code, errorMessage) => send({ id: message.id, error: { code, message: errorMessage } });
    const sendResult = (result) => send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result });
    const sessionTarget = (sessionId) => state.sessions.get(sessionId)?.targetId || null;
    const destroyTarget = (targetId) => {
      state.targets.delete(targetId);
      for (const [sessionId, entry] of state.sessions) {
        if (entry.targetId === targetId) state.sessions.delete(sessionId);
      }
      state.destroyedTargetIds.add(targetId);
      state.lastDestroyedTargetId = targetId;
      if (socketState?.discoveryEnabled && !socket.destroyed) send({ method: 'Target.targetDestroyed', params: { targetId } });
    };
    if (message.method.startsWith('Target.') && message.method !== 'Target.setDiscoverTargets' && !socketState?.discoveryEnabled) {
      sendError(-32000, 'Target discovery must be enabled first');
      return;
    }
    let result;
    switch (message.method) {
      case 'Browser.getVersion':
        result = browserVersion || { product: 'Chrome/152.0.0.0', userAgent: 'Mozilla/5.0 Edg/152.0.0.0', parserPadding: 'x'.repeat(70_000) };
        break;
      case 'Target.setDiscoverTargets':
        if (socketState) socketState.discoveryEnabled = message.params?.discover === true;
        if (message.params?.discover === true && state.emitExistingTargetsOnDiscover) {
          state.emitExistingTargetsOnDiscover = false;
          for (const targetInfo of state.targets.values()) {
            send({ method: 'Target.targetCreated', params: { targetInfo } });
          }
        }
        result = {};
        break;
      case 'Target.getTargets':
        result = { targetInfos: [...state.targets.values()] };
        break;
      case 'Target.getTargetInfo': {
        const targetId = message.params?.targetId;
        const targetInfo = state.targets.get(targetId);
        if (!targetInfo) {
          sendError(-32602, 'No target with given id');
          return;
        }
        if (state.destroyAfterTargetInfoResponse.delete(targetId)) {
          sendResult({ targetInfo });
          destroyTarget(targetId);
          return;
        }
        if (state.attachAfterTargetInfoResponse.delete(targetId)) {
          sendResult({ targetInfo });
          targetInfo.attached = true;
          return;
        }
        result = { targetInfo };
        break;
      }
      case 'Target.createTarget': {
        const targetId = `fake-created-${++state.createdTargetCount}`;
        state.targets.set(targetId, { targetId, type: 'page', title: '', url: message.params?.url || 'about:blank', attached: false });
        const behavior = state.nextCreateBehavior;
        state.nextCreateBehavior = null;
        if (behavior === 'stall-after-create') {
          state.delayedCreateRecords.push({
            socket,
            connectionId: socketState?.id || null,
            commandId: message.id,
            targetId,
            markerUrl: message.params?.url || 'about:blank',
            receivedAt: Date.now(),
          });
          return;
        }
        if (state.destroyNextCreatedDuringInitialization) {
          state.destroyNextCreatedDuringInitialization = false;
          state.pendingDestroyOnEnable.add(targetId);
        }
        result = { targetId };
        break;
      }
      case 'Target.attachToTarget': {
        const targetId = message.params?.targetId;
        if (!state.targets.has(targetId)) {
          sendError(-32602, 'No target with given id');
          return;
        }
        const sessionId = `session-${targetId}-${++state.attachCount}`;
        const behavior = state.attachBehaviors.get(targetId);
        if (behavior) state.attachBehaviors.delete(targetId);
        if (behavior === 'stall') {
          state.delayedAttachRecords.push({
            socket,
            connectionId: socketState?.id || null,
            targetId,
            sessionId,
            receivedAt: Date.now(),
          });
          return;
        }
        state.sessions.set(sessionId, { targetId, socket });
        result = { sessionId };
        break;
      }
      case 'Page.getFrameTree': {
        if (state.delayFrameOnce) { const ms=state.delayFrameOnce; state.delayFrameOnce=0; await sleep(ms); }
        const targetId = sessionTarget(message.sessionId);
        const target = state.targets.get(targetId);
        result = { frameTree: { frame: { id: `frame-${targetId || 'unknown'}`, url: target?.url || 'about:blank',
          ...(state.testLoaderGeneration ? {loaderId:`loader-${targetId}-${state.testLoaderGeneration}`} : {}) } } };
        break;
      }
      case 'Page.createIsolatedWorld':
        if (state.delayWorldOnce) { const ms=state.delayWorldOnce; state.delayWorldOnce=0; await sleep(ms); }
        result = { executionContextId: 101 };
        break;
      case 'Runtime.callFunctionOn':
        if (state.delayRuntimeOnce) { const ms=state.delayRuntimeOnce; state.delayRuntimeOnce=0; await sleep(ms); }
        if (state.stallRuntimeForTarget === sessionTarget(message.sessionId)) {
          state.stallRuntimeForTarget = null;
          return;
        }
        if (state.nextRuntimeWindowOpen?.sourceTargetId === sessionTarget(message.sessionId)) {
          const popupPlan = state.nextRuntimeWindowOpen;
          state.nextRuntimeWindowOpen = null;
          const targetId = `fake-noopener-derived-${++state.createdTargetCount}`;
          const targetInfo = {
            targetId,
            type: 'page',
            title: 'No-opener derived task page',
            url: popupPlan.url || `https://example.test/noopener-derived-${state.createdTargetCount}`,
            attached: false,
            ...(popupPlan.includeOpener ? { openerId: popupPlan.sourceTargetId } : {}),
          };
          state.lastRuntimeNoOpenerTargetId = targetId;
          const windowOpenMessage = {
            method: 'Page.windowOpen',
            sessionId: message.sessionId,
            params: { url: targetInfo.url, windowName: '_blank', windowFeatures: [], userGesture: true },
          };
          const targetCreatedMessage = { method: 'Target.targetCreated', params: { targetInfo } };
          state.targets.set(targetId, targetInfo);
          if (popupPlan.targetFirst) {
            send(targetCreatedMessage);
            send(windowOpenMessage);
          } else {
            send(windowOpenMessage);
            send(targetCreatedMessage);
          }
        }
        state.runtimeCallCount += 1;
        state.activeRuntimeCalls += 1;
        state.maxActiveRuntimeCalls = Math.max(state.maxActiveRuntimeCalls, state.activeRuntimeCalls);
        await sleep(140);
        state.activeRuntimeCalls -= 1;
        if (String(message.params?.functionDeclaration || '').includes('function readResearchVisibleDom(recipe)')) {
          state.researchRuntimeCalls.push({ ...message.params, sessionId: message.sessionId });
          result = { result: { type: 'object', value: state.researchSnapshot } };
          break;
        }
        result = { result: { type: 'object', value: { title: 'Fake Page', url: state.targets.get(sessionTarget(message.sessionId))?.url || TARGET_URL, lang: 'en', text: 'public test content' } } };
        break;
      case 'Target.detachFromTarget': {
        const sessionId = message.params?.sessionId;
        const targetId = sessionTarget(sessionId);
        const behavior = state.detachBehaviors.get(targetId);
        if (behavior) state.detachBehaviors.delete(targetId);
        if (behavior === 'stall') return;
        if (behavior === 'error') {
          sendError(-32000, 'Synthetic ordinary detach failure');
          return;
        }
        if (behavior === 'no-session') {
          state.sessions.delete(sessionId);
          sendError(-32001, 'No session with given id');
          return;
        }
        state.sessions.delete(sessionId);
        result = {};
        break;
      }
      case 'Page.enable': {
        if (state.delayEnableOnce) { const ms=state.delayEnableOnce; state.delayEnableOnce=0; await sleep(ms); }
        result = {};
        const targetId = sessionTarget(message.sessionId);
        if (targetId && state.pendingDestroyOnEnable.delete(targetId)) {
          setTimeout(() => destroyTarget(targetId), 20);
        }
        break;
      }
      case 'Page.bringToFront': {
        state.activatedTarget = sessionTarget(message.sessionId);
        result = {};
        break;
      }
      case 'Page.navigate': {
        const targetId = sessionTarget(message.sessionId);
        if (targetId && state.destroyDuringNavigate.delete(targetId)) {
          destroyTarget(targetId);
          return;
        }
        const target = state.targets.get(targetId);
        if (!target) {
          sendError(-32602, 'No target with given id');
          return;
        }
        const destination = message.params?.url || target.url;
        const behavior = state.navigateBehaviorsByUrl.get(destination);
        if (behavior) state.navigateBehaviorsByUrl.delete(destination);
        if (behavior === 'error') {
          sendError(-32000, 'Synthetic explicit Page.navigate failure');
          return;
        }
        if (behavior === 'stall') {
          const record = {
            socket,
            connectionId: socketState?.id || null,
            commandId: message.id,
            sessionId: message.sessionId,
            targetId,
            destination,
            receivedAt: Date.now(),
            settled: false,
            respond() {
              if (record.settled) return;
              record.settled = true;
              target.url = destination;
              if (!socket.destroyed) sendResult({ frameId: `frame-${targetId}` });
            },
          };
          state.delayedNavigateRecords.push(record);
          return;
        }
        target.url = destination;
        if (behavior === 'drop-connection-after-apply') {
          state.lostNavigateRecords.push({
            connectionId: socketState?.id || null,
            commandId: message.id,
            sessionId: message.sessionId,
            targetId,
            destination,
            receivedAt: Date.now(),
          });
          socket.destroy();
          return;
        }
        result = { frameId: `frame-${targetId}` };
        break;
      }
      case 'Target.closeTarget': {
        const targetId = message.params?.targetId;
        const behavior = state.closeBehaviors.get(targetId) || 'success';
        state.closeBehaviors.delete(targetId);
        if (behavior === 'destroy-before-response') {
          destroyTarget(targetId);
          setTimeout(() => { if (!socket.destroyed) sendResult({ success: true }); }, 800);
          return;
        }
        if (behavior === 'false-no-destroy') {
          result = { success: false };
          break;
        }
        if (behavior === 'error-no-destroy') {
          sendError(-32000, 'Synthetic close refusal');
          return;
        }
        if (behavior === 'destroy-no-response') {
          destroyTarget(targetId);
          return;
        }
        const existed = state.targets.has(targetId);
        if (existed) destroyTarget(targetId);
        result = { success: existed };
        break;
      }
      default:
        sendError(-32601, `Unhandled fake method ${message.method}`);
        return;
    }
    sendResult(result);
  };

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/devtools/browser/fake-integration-test') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    sockets.add(socket);
    state.connectionCount += 1;
    state.socketStates.set(socket, { id: state.connectionCount, discoveryEnabled: false });
    const frameState = { socket, buffer: Buffer.from(head), fragmentOpcode: null, fragments: [] };
    const onText = (text) => {
      let message;
      try { message = JSON.parse(text); } catch { socket.destroy(); return; }
      void replyFor(socket, message).catch(() => socket.destroy());
    };
    if (frameState.buffer.length) consumeClientFrames(frameState, onText);
    socket.on('data', (chunk) => {
      frameState.buffer = Buffer.concat([frameState.buffer, chunk]);
      try { consumeClientFrames(frameState, onText); } catch { socket.destroy(); }
    });
    const forgetSocket = () => {
      sockets.delete(socket);
      const metadata = state.socketStates.get(socket);
      if (metadata?.id) {
        state.closedConnectionIds.add(metadata.id);
        state.closedConnectionTimes.set(metadata.id, Date.now());
      }
      for (const [sessionId, entry] of state.sessions) {
        if (entry.socket === socket) state.sessions.delete(sessionId);
      }
    };
    socket.once('close', forgetSocket);
    socket.once('error', forgetSocket);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(typeof address === 'object' && address, 'fake CDP did not bind');
  return {
    port: address.port,
    state,
    spawnDerivedTarget(openerId, { closeBehavior = null, emitCreated = true } = {}) {
      const targetId = `fake-derived-${++state.createdTargetCount}`;
      const targetInfo = {
        targetId,
        type: 'page',
        title: 'Derived task page',
        url: `https://example.test/derived-${state.createdTargetCount}`,
        attached: false,
        openerId,
      };
      if (closeBehavior) state.closeBehaviors.set(targetId, closeBehavior);
      state.targets.set(targetId, targetInfo);
      if (emitCreated) {
        const event = encodeServerFrame(0x1, JSON.stringify({
          method: 'Target.targetCreated',
          params: { targetInfo },
        }));
        for (const socket of sockets) {
          if (state.socketStates.get(socket)?.discoveryEnabled && !socket.destroyed) socket.write(event);
        }
      }
      return targetId;
    },
    spawnNoOpenerDerivedTarget(sourceTargetId) {
      const session = [...state.sessions.entries()].find(([, entry]) => entry.targetId === sourceTargetId);
      assert.ok(session, `source target ${sourceTargetId} has no attached session for Page.windowOpen`);
      const [sessionId, sessionEntry] = session;
      const targetId = `fake-noopener-derived-${++state.createdTargetCount}`;
      const targetInfo = {
        targetId,
        type: 'page',
        title: 'No-opener derived task page',
        url: `https://example.test/noopener-derived-${state.createdTargetCount}`,
        attached: false,
      };
      const windowOpenEvent = encodeServerFrame(0x1, JSON.stringify({
        method: 'Page.windowOpen',
        sessionId,
        params: { url: targetInfo.url, windowName: '_blank', windowFeatures: [], userGesture: true },
      }));
      sessionEntry.socket.write(windowOpenEvent);
      state.targets.set(targetId, targetInfo);
      const targetCreatedEvent = encodeServerFrame(0x1, JSON.stringify({
        method: 'Target.targetCreated',
        params: { targetInfo },
      }));
      sessionEntry.socket.write(targetCreatedEvent);
      return targetId;
    },
    armNoOpenerPopupOnNextRuntime(sourceTargetId) {
      state.nextRuntimeWindowOpen = { sourceTargetId, includeOpener: false, targetFirst: false };
      state.lastRuntimeNoOpenerTargetId = null;
    },
    armOpenerPopupOnNextRuntime(sourceTargetId, options = {}) {
      state.nextRuntimeWindowOpen = { sourceTargetId, includeOpener: true, targetFirst: true, ...options };
      state.lastRuntimeNoOpenerTargetId = null;
    },
    removeTargetSilently(targetId) {
      state.targets.delete(targetId);
      for (const [sessionId, entry] of state.sessions) {
        if (entry.targetId === targetId) state.sessions.delete(sessionId);
      }
    },
    disconnectAll() {
      for (const socket of [...sockets]) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const FIXTURE_LEASE_TTL_MS = 8000; // Longer than a 5s renderer timeout plus bounded detach.
function startBroker({ port, tokenDir, fakeCdpPort, leaseTtlMs = FIXTURE_LEASE_TTL_MS, shutdownIpc = true }) {
  const stdout = [];
  const stderr = [];
  const preloadSource = "process.on('message',(message)=>{if(message==='cdp-broker-selftest:shutdown')process.emit('SIGTERM')})";
  const preloadUrl = `data:text/javascript;base64,${Buffer.from(preloadSource, 'utf8').toString('base64')}`;
  const child = spawn(process.execPath, [...(shutdownIpc ? [`--import=${preloadUrl}`] : []), BROKER_PATH], {
    cwd: SCRIPT_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      CDP_PROXY_PORT: String(port),
      CDP_PROXY_TOKEN_DIR: tokenDir,
      CDP_BROWSER_WS_URL: `ws://127.0.0.1:${fakeCdpPort}/devtools/browser/fake-integration-test`,
      CDP_HANDSHAKE_TIMEOUT_MS: '1500',
      CDP_REQUEST_TIMEOUT_MS: '6000',
      CDP_LEASE_TTL_MS: String(leaseTtlMs),
      CDP_IDEMPOTENCY_TTL_MS: String(leaseTtlMs),
    },
    stdio: shutdownIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout, stderr, exit };
}

async function stopBroker(processState) {
  if (!processState || processState.child.exitCode !== null || processState.child.signalCode !== null) return await processState?.exit;
  if (typeof processState.child.send === 'function' && processState.child.connected) {
    processState.child.send('cdp-broker-selftest:shutdown');
  } else processState.child.kill('SIGTERM');
  const graceful = await Promise.race([
    processState.exit.then((value) => ({ exited: true, value })),
    sleep(5000).then(() => ({ exited: false })),
  ]);
  if (graceful.exited) return graceful.value;
  processState.child.kill('SIGKILL');
  return await processState.exit;
}

async function brokerRequest(baseUrl, pathname, { method = 'GET', token, owner = OWNER, lease, manage, requestId, json, rawBody } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (owner) headers['X-CDP-Owner'] = owner;
  if (lease) headers['X-CDP-Lease'] = lease;
  if (manage) headers['X-CDP-Manage'] = manage;
  if (requestId) headers['X-CDP-Request-Id'] = requestId;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (rawBody !== undefined) body = String(rawBody);
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { status: response.status, value, text };
}

async function rawHttpRequest(port, requestTarget) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error('raw HTTP response timed out')), 3000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    socket.once('connect', () => socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    socket.once('error', (error) => finish(reject, error));
  });
}

function expectError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.value?.ok, false, result.text);
  assert.equal(result.value?.error?.code, code, result.text);
}

function removeTestTempRoot(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const allowedPrefix = `${path.resolve(os.tmpdir())}${path.sep}codex-edge-broker-integration-`;
  if (!resolved.startsWith(allowedPrefix)) throw new Error(`refusing to clean unexpected path: ${resolved}`);
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  } catch (firstError) {
    if (os.platform() !== 'win32') throw firstError;
    const icacls = windowsSystemPath('icacls.exe');
    spawnSync(icacls, [resolved, '/reset', '/t', '/c', '/q'], {
      encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024,
    });
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

async function assertBrowserIdentityRejected(tempRoot, label, browserVersion) {
  const fake = await startFakeCdp({ browserVersion });
  const port = await reservePort();
  const tokenDir = path.join(tempRoot, `identity-${label}`);
  const processState = startBroker({ port, tokenDir, fakeCdpPort: fake.port });
  try {
    await waitFor(() => {
      if (processState.child.exitCode !== null) {
        throw new Error(`identity-test broker exited during startup (${processState.child.exitCode}): ${processState.stderr.join('')}`);
      }
      return fs.existsSync(path.join(tokenDir, `${port}.token`))
        && processState.stdout.join('').includes('[Edge CDP Broker] listening');
    }, { timeoutMs: 45000, label: `${label} broker secure startup` });
    const outcome = await waitFor(async () => {
      if (processState.child.exitCode !== null) {
        throw new Error(`identity-test broker exited early (${processState.child.exitCode}): ${processState.stderr.join('')}`);
      }
      if (processState.stderr.join('').includes('wrong_browser_identity')) return 'rejected';
      try {
        const health = await brokerRequest(`http://127.0.0.1:${port}`, '/health', { owner: null });
        if (health.value?.connection?.state === 'connected') return 'connected';
      } catch {}
      return null;
    }, { timeoutMs: 5000, label: `${label} identity rejection` });
    assert.equal(outcome, 'rejected', `${label} browser identity was accepted`);
    const health = await brokerRequest(`http://127.0.0.1:${port}`, '/health', { owner: null });
    assert.notEqual(health.value?.connection?.state, 'connected', 'rejected browser was published as connected');
    assert.equal(fake.state.methodCounts.get('Browser.getVersion'), 1);
    assert.equal(fake.state.methodCounts.get('Target.setDiscoverTargets') || 0, 0, 'rejected browser advanced past identity validation');
  } catch (error) {
    console.error('Identity fixture startup diagnostic:', {label,exitCode:processState.child.exitCode,stderr:processState.stderr.join('').slice(0,2000)});
    throw error;
  } finally {
    await stopBroker(processState).catch(() => {});
    await fake.close().catch(() => {});
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edge-broker-integration-'));
const tokenDir = path.join(tempRoot, 'tokens');
const brokerPort = await reservePort();
const tokenFile = path.join(tokenDir, `${brokerPort}.token`);
const markerKeyFile = path.join(tokenDir, `${brokerPort}.marker-key`);
const staleToken = 'stale-token-that-must-be-rotated-before-use';
let fakeCdp = null;
let broker = null;
let deferredRegressionError = null;
let attachAbortCloseDelayMs = null;

try {
  await assertConnectingTerminateClosesTcp();
  await assertBrowserIdentityRejected(tempRoot, 'chrome', {
    product: 'Chrome/152.0.0.0',
    userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36',
  });
  await assertBrowserIdentityRejected(tempRoot, 'headless', {
    product: 'HeadlessChrome/152.0.0.0',
    userAgent: 'Mozilla/5.0 HeadlessChrome/152.0.0.0 Edg/152.0.0.0',
  });
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${staleToken}\n`, 'utf8');
  fakeCdp = await startFakeCdp();
  broker = startBroker({ port: brokerPort, tokenDir, fakeCdpPort: fakeCdp.port });
  const baseUrl = `http://127.0.0.1:${brokerPort}`;

  const token = await waitFor(() => {
    if (broker.child.exitCode !== null) {
      throw new Error(`broker exited early (${broker.child.exitCode}): ${broker.stderr.join('')}`);
    }
    if (!fs.existsSync(tokenFile)) return null;
    const value = fs.readFileSync(tokenFile, 'utf8').trim();
    return value && value !== staleToken ? value : null;
  }, { timeoutMs: 45000, label: 'broker token rotation' });
  assert.match(token, /^[A-Za-z0-9_-]{40,64}$/u);
  assert.notEqual(token, staleToken);

  const markerKeyWaitStartedAt = Date.now();
  const markerKeyEncoded = await waitFor(() => {
    if (broker.child.exitCode !== null) throw new Error(`broker exited during marker setup (${broker.child.exitCode}): ${broker.stderr.join('')}`);
    if (!fs.existsSync(markerKeyFile)) return null;
    const value = fs.readFileSync(markerKeyFile, 'utf8').trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }, { timeoutMs: 45000, label: 'persistent marker key creation' });
  const markerKeyReadyMs = Date.now() - markerKeyWaitStartedAt;
  const markerKey = Buffer.from(markerKeyEncoded, 'base64url');
  assert.equal(markerKey.length, 32);
  if (os.platform() === 'win32') {
    const acl = windowsAclSnapshot(markerKeyFile);
    const allowed = new Set([acl.sid, 'S-1-5-18']);
    assert.equal(acl.protected, true, 'marker key ACL inheritance is not protected');
    assert.ok(acl.rules.length >= 2, 'marker key ACL is missing required allow entries');
    assert.equal(
      acl.rules.every((rule) => rule.Type === 'Allow' && allowed.has(rule.Sid)),
      true,
      `marker key ACL has an unexpected principal or deny rule: ${JSON.stringify(acl.rules)}`,
    );
    assert.equal(acl.rules.some((rule) => rule.Sid === acl.sid), true, 'marker key ACL lacks current user SID');
    assert.equal(acl.rules.some((rule) => rule.Sid === 'S-1-5-18'), true, 'marker key ACL lacks SYSTEM');
  }

  const health = await waitFor(async () => {
    const result = await brokerRequest(baseUrl, '/health', { owner: null });
    return result.status === 200 && result.value?.connection?.state === 'connected' ? result : null;
  }, { label: 'broker connection to fake CDP' });
  assert.equal(health.value.service, 'edge-cdp-broker-v2');
  assert.ok(health.value.capabilities.includes('research-dom-snapshot-v1'), 'fixed research snapshot capability was not advertised');

  const singletonContenderPort = await reservePort();
  const singletonContenderTokenFile = path.join(tokenDir, `${singletonContenderPort}.token`);
  const singletonContender = startBroker({
    port: singletonContenderPort,
    tokenDir,
    fakeCdpPort: fakeCdp.port,
    shutdownIpc: false,
  });
  try {
    await waitFor(
      () => singletonContender.child.exitCode !== null || singletonContender.child.signalCode !== null,
      { timeoutMs: 25000, label: 'same-profile singleton contender rejection' },
    );
    const contenderExit = await singletonContender.exit;
    assert.notEqual(contenderExit.code, 0, 'second broker using the same Edge CDP endpoint exited successfully');
    assert.equal(singletonContender.stdout.join('').includes('[Edge CDP Broker] listening'), false);
    assert.match(singletonContender.stderr.join(''), /edge_profile_in_use/u);
    assert.equal(fs.existsSync(singletonContenderTokenFile), false, 'rejected singleton contender left a bearer token behind');
    assert.equal((await brokerRequest(baseUrl, '/health', { owner: null })).value.connection.state, 'connected');
  } finally {
    await stopBroker(singletonContender).catch(() => {});
  }

  expectError(await brokerRequest(baseUrl, '/targets'), 401, 'unauthorized');
  expectError(await brokerRequest(baseUrl, '/targets', { token: 'not-the-token' }), 401, 'unauthorized');

  const targets = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targets.status, 200, targets.text);
  assert.deepEqual(targets.value.targets.map((target) => target.targetId), [TARGET_ID]);
  assert.equal(targets.value.targets[0].lease, 'available');

  // The broker ceiling counts every attributable task slot, not merely a
  // live-lease count. Six concurrent creations must yield exactly five pages, idempotent
  // replay must still work at capacity, and releasing a broker-created page
  // must not free its slot while the tab remains open.
  const capRequests = Array.from({ length: 6 }, (_, index) => ({
    path: `/new?url=${encodeURIComponent(`https://example.test/cap-${index}`)}`,
    requestId: `integration-cap-new-${String(index).padStart(4, '0')}`,
  }));
  const capResults = await Promise.all(capRequests.map((entry) => brokerRequest(baseUrl, entry.path, {
    method: 'POST', token, requestId: entry.requestId,
  })));
  const capCreated = capResults.filter((result) => result.status === 200);
  const capRejectedIndex = capResults.findIndex((result) => result.status !== 200);
  assert.equal(capCreated.length, 5, `six concurrent new requests created ${capCreated.length} task pages`);
  for (const result of capCreated) assert.match(result.value.manageToken, /^[A-Za-z0-9_-]{24,128}$/u);
  assert.ok(capRejectedIndex >= 0, 'sixth concurrent new request was not rejected');
  expectError(capResults[capRejectedIndex], 409, 'task_page_limit_reached');
  assert.deepEqual(capResults[capRejectedIndex].value.error.details, { active: 5, limit: 5 });
  const healthAtCap = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.deepEqual(healthAtCap.value.taskPages, { active: 5, limit: 5 });
  const clickAtCap = await brokerRequest(baseUrl, `/click?target=${capCreated[0].value.targetId}`, {
    method: 'POST', token, lease: capCreated[0].value.leaseToken, rawBody: 'body',
  });
  expectError(clickAtCap, 409, 'task_page_limit_reached');

  const closesBeforeOverflowPopup = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const overflowDerivedTargetId = fakeCdp.spawnDerivedTarget(capCreated[0].value.targetId);
  await waitFor(() => !fakeCdp.state.targets.has(overflowDerivedTargetId), {
    timeoutMs: 2000,
    label: 'overflow derived task page closure',
  });
  assert.ok(
    (fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closesBeforeOverflowPopup,
    'derived sixth task page was not closed',
  );
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });

  const closesBeforeFalseDerived = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const falseDerivedTargetId = fakeCdp.spawnDerivedTarget(capCreated[0].value.targetId, { closeBehavior: 'false-no-destroy' });
  await waitFor(() => (fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closesBeforeFalseDerived, {
    timeoutMs: 2000, label: 'success:false derived close attempt',
  });
  await sleep(100);
  assert.equal(fakeCdp.state.targets.has(falseDerivedTargetId), true);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 6, limit: 5 });
  fakeCdp.state.closeBehaviors.set(falseDerivedTargetId, 'false-no-destroy');
  const createsBeforeFalseDerivedRetry = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  const newWhileFalseDerived = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/blocked-by-false-derived')}`, {
    method: 'POST', token, requestId: 'integration-derived-false-block-0001',
  });
  expectError(newWhileFalseDerived, 409, 'derived_target_unresolved');
  assert.equal(fakeCdp.state.methodCounts.get('Target.createTarget') || 0, createsBeforeFalseDerivedRetry);
  const listedFalseDerived = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(listedFalseDerived.value.targets.find((target) => target.targetId === falseDerivedTargetId)?.lease, 'busy');
  fakeCdp.state.closeBehaviors.set(falseDerivedTargetId, 'false-no-destroy');
  const clickWhileFalseDerived = await brokerRequest(baseUrl, `/click?target=${capCreated[0].value.targetId}`, {
    method: 'POST', token, lease: capCreated[0].value.leaseToken, rawBody: 'body',
  });
  expectError(clickWhileFalseDerived, 409, 'derived_target_unresolved');
  const retryAfterFalseDerived = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/blocked-by-false-derived')}`, {
    method: 'POST', token, requestId: 'integration-derived-false-block-0001',
  });
  expectError(retryAfterFalseDerived, 409, 'derived_target_unresolved');
  assert.equal(fakeCdp.state.targets.has(falseDerivedTargetId), true);
  assert.equal(fakeCdp.state.methodCounts.get('Target.closeTarget'), closesBeforeFalseDerived + 1,
    'unknown derived close must not be replayed by new/click requests');
  fakeCdp.removeTargetSilently(falseDerivedTargetId);
  await brokerRequest(baseUrl, '/targets', { token });

  const closesBeforeErrorDerived = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const errorDerivedTargetId = fakeCdp.spawnDerivedTarget(capCreated[0].value.targetId, { closeBehavior: 'error-no-destroy' });
  await waitFor(() => (fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closesBeforeErrorDerived, {
    timeoutMs: 2000, label: 'cdp_error derived close attempt',
  });
  await sleep(100);
  assert.equal(fakeCdp.state.targets.has(errorDerivedTargetId), true);
  fakeCdp.state.closeBehaviors.set(errorDerivedTargetId, 'error-no-destroy');
  const createsBeforeErrorDerivedRetry = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  const newWhileErrorDerived = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/blocked-by-error-derived')}`, {
    method: 'POST', token, requestId: 'integration-derived-error-block-0001',
  });
  expectError(newWhileErrorDerived, 409, 'derived_target_unresolved');
  assert.equal(fakeCdp.state.methodCounts.get('Target.createTarget') || 0, createsBeforeErrorDerivedRetry);
  const retryAfterErrorDerived = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/blocked-by-error-derived')}`, {
    method: 'POST', token, requestId: 'integration-derived-error-block-0001',
  });
  expectError(retryAfterErrorDerived, 409, 'derived_target_unresolved');
  assert.equal(fakeCdp.state.targets.has(errorDerivedTargetId), true);
  assert.equal(fakeCdp.state.methodCounts.get('Target.closeTarget'), closesBeforeErrorDerived + 1,
    'failed derived close stays quarantined until disappearance is observed');
  fakeCdp.removeTargetSilently(errorDerivedTargetId);
  await brokerRequest(baseUrl, '/targets', { token });

  const closesBeforeLostDerived = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const lostResponseDerivedTargetId = fakeCdp.spawnDerivedTarget(capCreated[0].value.targetId, { closeBehavior: 'destroy-no-response' });
  await waitFor(() => !fakeCdp.state.targets.has(lostResponseDerivedTargetId), {
    timeoutMs: 2000, label: 'event-first response-lost derived closure',
  });
  assert.ok((fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closesBeforeLostDerived);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });

  const firstCapResultIndex = capResults.findIndex((result) => result.status === 200);
  const firstCapResult = capResults[firstCapResultIndex];
  const capReplay = await brokerRequest(baseUrl, capRequests[firstCapResultIndex].path, {
    method: 'POST', token, requestId: capRequests[firstCapResultIndex].requestId,
  });
  assert.equal(capReplay.status, 200, capReplay.text);
  assert.equal(capReplay.value.replayed, true);
  assert.equal(capReplay.value.targetId, firstCapResult.value.targetId);
  assert.equal(capReplay.value.leaseToken, firstCapResult.value.leaseToken);

  const capExistingTargetId = 'fake-cap-existing-overflow';
  fakeCdp.state.targets.set(capExistingTargetId, {
    targetId: capExistingTargetId, type: 'page', title: 'Cap existing page', url: 'https://example.test/cap-existing', attached: false,
  });
  const acquireAtCap = await brokerRequest(baseUrl, `/acquire?target=${capExistingTargetId}`, {
    method: 'POST', token, requestId: 'integration-cap-acquire-overflow-0001',
  });
  expectError(acquireAtCap, 409, 'task_page_limit_reached');

  const releaseManagedAtCap = await brokerRequest(baseUrl, `/release?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, lease: firstCapResult.value.leaseToken,
  });
  assert.equal(releaseManagedAtCap.status, 200, releaseManagedAtCap.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });
  const targetsAfterManagedRelease = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targetsAfterManagedRelease.value.targets.find((target) => target.targetId === firstCapResult.value.targetId)?.lease, 'busy');
  const stillFullAfterRelease = await brokerRequest(baseUrl, capRequests[capRejectedIndex].path, {
    method: 'POST', token, requestId: capRequests[capRejectedIndex].requestId,
  });
  expectError(stillFullAfterRelease, 409, 'task_page_limit_reached');

  // If Edge drops a managed page while the broker connection is unavailable,
  // the next creation sweep must remove that stale slot before enforcing the
  // cap. Otherwise one lost target can permanently reduce usable capacity.
  const staleSlotVictim = capCreated.find((result) => result.value.targetId !== firstCapResult.value.targetId);
  assert.ok(staleSlotVictim, 'no managed page available for stale-slot recovery test');
  fakeCdp.removeTargetSilently(staleSlotVictim.value.targetId);
  fakeCdp.disconnectAll();
  await waitFor(async () => {
    const state = await brokerRequest(baseUrl, '/health', { owner: null });
    return state.value?.connection?.state === 'disconnected';
  }, { timeoutMs: 2000, label: 'broker disconnect before stale-slot recovery' });
  const staleSlotReplacement = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/cap-stale-slot-replacement')}`, {
    method: 'POST', token, requestId: 'integration-cap-stale-slot-replacement-0001',
  });
  assert.equal(staleSlotReplacement.status, 200, staleSlotReplacement.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });

  const reacquireManagedWithoutCapability = await brokerRequest(baseUrl, `/acquire?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, requestId: 'integration-cap-reacquire-without-manage-0001',
  });
  expectError(reacquireManagedWithoutCapability, 409, 'manage_token_required');
  const reacquireManagedWithWrongCapability = await brokerRequest(baseUrl, `/acquire?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, manage: 'wrong-manage-capability-token-000000', requestId: 'integration-cap-reacquire-wrong-manage-0001',
  });
  expectError(reacquireManagedWithWrongCapability, 403, 'manage_token_conflict');
  const reacquiredManaged = await brokerRequest(baseUrl, `/acquire?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, manage: firstCapResult.value.manageToken, requestId: 'integration-cap-reacquire-managed-0001',
  });
  assert.equal(reacquiredManaged.status, 200, reacquiredManaged.text);
  const replayManagedAcquireWithoutCapability = await brokerRequest(baseUrl, `/acquire?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, requestId: 'integration-cap-reacquire-managed-0001',
  });
  expectError(replayManagedAcquireWithoutCapability, 409, 'manage_token_required');
  const replayManagedAcquire = await brokerRequest(baseUrl, `/acquire?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, manage: firstCapResult.value.manageToken, requestId: 'integration-cap-reacquire-managed-0001',
  });
  assert.equal(replayManagedAcquire.status, 200, replayManagedAcquire.text);
  assert.equal(replayManagedAcquire.value.replayed, true);
  assert.equal(replayManagedAcquire.value.leaseToken, reacquiredManaged.value.leaseToken);
  const finalizedManaged = await brokerRequest(baseUrl, `/finalize?target=${firstCapResult.value.targetId}`, {
    method: 'POST', token, lease: reacquiredManaged.value.leaseToken,
  });
  assert.equal(finalizedManaged.status, 200, finalizedManaged.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 4, limit: 5 });

  // A delayed discovery event must not let /new or an unrelated /acquire use
  // the last slot before a visible explicit child is classified and contained.
  const delayedChildBeforeNewId = fakeCdp.spawnDerivedTarget(staleSlotReplacement.value.targetId, { emitCreated: false });
  const newAfterDelayedChild = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/new-after-delayed-child')}`, {
    method: 'POST', token, requestId: 'integration-new-after-delayed-child-0001',
  });
  assert.equal(newAfterDelayedChild.status, 200, newAfterDelayedChild.text);
  assert.equal(fakeCdp.state.targets.has(delayedChildBeforeNewId), false, 'new admitted before closing a visible delayed child');
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });
  const finalizedNewAfterDelayedChild = await brokerRequest(baseUrl, `/finalize?target=${newAfterDelayedChild.value.targetId}`, {
    method: 'POST', token, lease: newAfterDelayedChild.value.leaseToken,
  });
  assert.equal(finalizedNewAfterDelayedChild.status, 200, finalizedNewAfterDelayedChild.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 4, limit: 5 });

  const delayedChildBeforeAcquireId = fakeCdp.spawnDerivedTarget(staleSlotReplacement.value.targetId, { emitCreated: false });
  const unrelatedAfterDelayedChildId = 'fake-unrelated-after-delayed-child';
  fakeCdp.state.targets.set(unrelatedAfterDelayedChildId, {
    targetId: unrelatedAfterDelayedChildId,
    type: 'page',
    title: 'Unrelated page after delayed child',
    url: 'https://example.test/unrelated-after-delayed-child',
    attached: false,
  });
  const acquiredAfterDelayedChild = await brokerRequest(baseUrl, `/acquire?target=${unrelatedAfterDelayedChildId}`, {
    method: 'POST', token, requestId: 'integration-acquire-after-delayed-child-0001',
  });
  assert.equal(acquiredAfterDelayedChild.status, 200, acquiredAfterDelayedChild.text);
  assert.equal(fakeCdp.state.targets.has(delayedChildBeforeAcquireId), false, 'unrelated acquire admitted before closing a visible delayed child');
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });
  const releasedAfterDelayedChild = await brokerRequest(baseUrl, `/release?target=${unrelatedAfterDelayedChildId}`, {
    method: 'POST', token, lease: acquiredAfterDelayedChild.value.leaseToken,
  });
  assert.equal(releasedAfterDelayedChild.status, 200, releasedAfterDelayedChild.text);
  fakeCdp.removeTargetSilently(unrelatedAfterDelayedChildId);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 4, limit: 5 });

  const acquiredAfterFinalize = await brokerRequest(baseUrl, `/acquire?target=${capExistingTargetId}`, {
    method: 'POST', token, requestId: 'integration-cap-acquire-after-finalize-0001',
  });
  assert.equal(acquiredAfterFinalize.status, 200, acquiredAfterFinalize.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });
  const releasedExisting = await brokerRequest(baseUrl, `/release?target=${capExistingTargetId}`, {
    method: 'POST', token, lease: acquiredAfterFinalize.value.leaseToken,
  });
  assert.equal(releasedExisting.status, 200, releasedExisting.text);

  const filledFreedSlot = await brokerRequest(baseUrl, capRequests[capRejectedIndex].path, {
    method: 'POST', token, requestId: capRequests[capRejectedIndex].requestId,
  });
  assert.equal(filledFreedSlot.status, 200, filledFreedSlot.text);
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 5, limit: 5 });
  for (const result of [
    ...capCreated.filter((entry) => entry.value.targetId !== firstCapResult.value.targetId && entry.value.targetId !== staleSlotVictim.value.targetId),
    staleSlotReplacement,
    filledFreedSlot,
  ]) {
    const finalized = await brokerRequest(baseUrl, `/finalize?target=${result.value.targetId}`, {
      method: 'POST', token, lease: result.value.leaseToken,
    });
    assert.equal(finalized.status, 200, finalized.text);
  }
  assert.deepEqual((await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages, { active: 0, limit: 5 });

  const preexistingChildId = 'fake-preexisting-child-before-source-lease';
  fakeCdp.state.targets.set(preexistingChildId, {
    targetId: preexistingChildId,
    type: 'page',
    title: 'Pre-existing user child',
    url: 'https://example.test/preexisting-child',
    attached: false,
    openerId: TARGET_ID,
  });
  const acquired = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, requestId: 'integration-acquire-0001',
  });
  assert.equal(acquired.status, 200, acquired.text);
  const lease = acquired.value.leaseToken;
  assert.match(lease, /^[A-Za-z0-9_-]{24,128}$/u);

  const closesBeforePreexistingChildChecks = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const targetsWithPreexistingChild = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(
    targetsWithPreexistingChild.value.targets.find((target) => target.targetId === preexistingChildId)?.lease,
    'available',
    'a child that predated the source lease was misclassified as task-derived',
  );
  const acquiredPreexistingChild = await brokerRequest(baseUrl, `/acquire?target=${preexistingChildId}`, {
    method: 'POST',
    token,
    owner: 'integration-test:preexisting-child-owner',
    requestId: 'integration-preexisting-child-acquire-0001',
  });
  assert.equal(acquiredPreexistingChild.status, 200, acquiredPreexistingChild.text);
  const releasedPreexistingChild = await brokerRequest(baseUrl, `/release?target=${preexistingChildId}`, {
    method: 'POST',
    token,
    owner: 'integration-test:preexisting-child-owner',
    lease: acquiredPreexistingChild.value.leaseToken,
  });
  assert.equal(releasedPreexistingChild.status, 200, releasedPreexistingChild.text);
  assert.equal(
    fakeCdp.state.methodCounts.get('Target.closeTarget') || 0,
    closesBeforePreexistingChildChecks,
    'broker closed a child that existed before its opener was leased',
  );
  fakeCdp.removeTargetSilently(preexistingChildId);

  // Re-enabling discovery after a socket loss may replay targetCreated for
  // pages that already existed. The validation-time getTargets baseline must
  // prevent such replay from closing or reserving an old child.
  const reconnectBaselineChildId = 'fake-child-existing-before-reconnect';
  fakeCdp.state.targets.set(reconnectBaselineChildId, {
    targetId: reconnectBaselineChildId,
    type: 'page',
    title: 'Existing child before reconnect',
    url: 'https://example.test/existing-before-reconnect',
    attached: false,
    openerId: TARGET_ID,
  });
  fakeCdp.state.emitExistingTargetsOnDiscover = true;
  const closesBeforeReconnectBaseline = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  fakeCdp.disconnectAll();
  await waitFor(async () => {
    const value = await brokerRequest(baseUrl, '/health', { owner: null });
    return value.value?.connection?.state === 'disconnected';
  }, { timeoutMs: 2000, label: 'disconnect before target discovery replay baseline' });
  const targetsAfterDiscoveryReplay = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targetsAfterDiscoveryReplay.status, 200, targetsAfterDiscoveryReplay.text);
  assert.equal(
    targetsAfterDiscoveryReplay.value.targets.find((target) => target.targetId === reconnectBaselineChildId)?.lease,
    'available',
    'discovery replay misclassified an existing child as newly task-derived',
  );
  assert.equal(fakeCdp.state.targets.has(reconnectBaselineChildId), true);
  assert.equal(
    fakeCdp.state.methodCounts.get('Target.closeTarget') || 0,
    closesBeforeReconnectBaseline,
    'discovery replay closed an existing child',
  );
  fakeCdp.removeTargetSilently(reconnectBaselineChildId);

  // Target metadata can become queryable before the discovery event is
  // delivered. Direct acquire and /targets must classify an explicit child of
  // the leased source synchronously, so another owner cannot seize that gap.
  const delayedAcquireChildId = fakeCdp.spawnDerivedTarget(TARGET_ID, { emitCreated: false });
  const delayedChildAcquire = await brokerRequest(baseUrl, `/acquire?target=${delayedAcquireChildId}`, {
    method: 'POST',
    token,
    owner: 'integration-test:delayed-child-contender',
    requestId: 'integration-delayed-child-acquire-0001',
  });
  assert.ok(
    (delayedChildAcquire.status === 409 && delayedChildAcquire.value?.error?.code === 'target_reserved')
      || (delayedChildAcquire.status === 404 && delayedChildAcquire.value?.error?.code === 'target_destroyed'),
    `delayed child acquire was neither reserved nor contained: ${delayedChildAcquire.text}`,
  );
  await waitFor(() => !fakeCdp.state.targets.has(delayedAcquireChildId), {
    timeoutMs: 2000, label: 'getTargetInfo-classified delayed child closure',
  });

  const delayedListChildId = fakeCdp.spawnDerivedTarget(TARGET_ID, {
    closeBehavior: 'false-no-destroy',
    emitCreated: false,
  });
  const delayedChildTargets = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(delayedChildTargets.status, 200, delayedChildTargets.text);
  assert.equal(
    delayedChildTargets.value.targets.find((target) => target.targetId === delayedListChildId)?.lease,
    'busy',
    '/targets advertised a delayed-event controlled child as available',
  );
  fakeCdp.state.closeBehaviors.set(delayedListChildId, 'success');
  const closesBeforeDelayedListRetry = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const blockedAfterDelayedList = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/delayed-list-cleanup-probe')}`, {
    method: 'POST', token, requestId: 'integration-delayed-list-cleanup-0001',
  });
  expectError(blockedAfterDelayedList, 409, 'derived_target_unresolved');
  assert.equal(fakeCdp.state.methodCounts.get('Target.closeTarget') || 0, closesBeforeDelayedListRetry);
  fakeCdp.removeTargetSilently(delayedListChildId);
  await brokerRequest(baseUrl, '/targets', { token });
  const cleanupAfterDelayedList = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/delayed-list-cleanup-probe')}`, {
    method: 'POST', token, requestId: 'integration-delayed-list-cleanup-0001',
  });
  assert.equal(cleanupAfterDelayedList.status, 200, cleanupAfterDelayedList.text);
  assert.equal(fakeCdp.state.targets.has(delayedListChildId), false);
  const cleanupAfterDelayedListFinalize = await brokerRequest(baseUrl, `/finalize?target=${cleanupAfterDelayedList.value.targetId}`, {
    method: 'POST',
    token,
    lease: cleanupAfterDelayedList.value.leaseToken,
    manage: cleanupAfterDelayedList.value.manageToken,
  });
  assert.equal(cleanupAfterDelayedListFinalize.status, 200, cleanupAfterDelayedListFinalize.text);

  const acquireReplay = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, requestId: 'integration-acquire-0001',
  });
  assert.equal(acquireReplay.status, 200, acquireReplay.text);
  assert.equal(acquireReplay.value.replayed, true);
  assert.equal(acquireReplay.value.leaseToken, lease);
  assert.equal(acquireReplay.value.leaseEpoch, acquired.value.leaseEpoch);

  const acquireKeyConflict = await brokerRequest(baseUrl, '/acquire?target=a-different-target', {
    method: 'POST', token, requestId: 'integration-acquire-0001',
  });
  expectError(acquireKeyConflict, 409, 'idempotency_key_conflict');

  // Complete the short-TTL replay checks before intentionally slow renderer
  // scenarios; their extra time must not expire an unrelated fixture key.
  fakeCdp.state.testLoaderGeneration = 1;
  fakeCdp.state.delayEnableOnce = 2200;
  const worldCountBefore = fakeCdp.state.methodCounts.get('Page.createIsolatedWorld') || 0;
  for (let i=0;i<3;i++) {
    if (i===1) fakeCdp.state.delayFrameOnce=2200;
    if (i===2) fakeCdp.state.delayRuntimeOnce=2200;
    const read=await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, {token,lease});
    assert.equal(read.status,200,read.text);
  }
  assert.equal((fakeCdp.state.methodCounts.get('Page.createIsolatedWorld')||0)-worldCountBefore,1);
  fakeCdp.state.testLoaderGeneration = 2;
  fakeCdp.state.delayWorldOnce = 2200;
  assert.equal((await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, {token,lease})).status,200);
  assert.equal((fakeCdp.state.methodCounts.get('Page.createIsolatedWorld')||0)-worldCountBefore,2);
  for (const flag of ['delayEnableOnce','delayFrameOnce','delayRuntimeOnce','delayWorldOnce']) assert.equal(fakeCdp.state[flag],0);
  fakeCdp.state.testLoaderGeneration = 0;

  const conflict = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, owner: 'integration-test:other', requestId: 'integration-acquire-0002',
  });
  expectError(conflict, 409, 'lease_conflict');

  const wrongLease = await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, { token, lease: 'wrong-lease-token-that-is-long-enough' });
  expectError(wrongLease, 409, 'lease_conflict');

  const activationCountBefore = fakeCdp.state.methodCounts.get('Page.bringToFront') || 0;
  const wrongActivationLease = await brokerRequest(baseUrl, `/activate?target=${TARGET_ID}`, {
    method: 'POST', token, lease: 'wrong-lease-token-that-is-long-enough',
  });
  expectError(wrongActivationLease, 409, 'lease_conflict');
  assert.equal(fakeCdp.state.methodCounts.get('Page.bringToFront') || 0, activationCountBefore);
  const activated = await brokerRequest(baseUrl, `/activate?target=${TARGET_ID}`, { method: 'POST', token, lease });
  assert.equal(activated.status, 200, activated.text);
  assert.equal(activated.value.activated, true);
  assert.equal(fakeCdp.state.activatedTarget, TARGET_ID);
  assert.equal(fakeCdp.state.targets.get(TARGET_ID).url, TARGET_URL, 'activation must not navigate');

  const removedEval = await brokerRequest(baseUrl, `/eval?target=${TARGET_ID}`, { method: 'POST', token, lease });
  expectError(removedEval, 410, 'endpoint_removed');

  const invalidDom = await brokerRequest(baseUrl, `/dom/query?target=${TARGET_ID}`, {
    method: 'POST', token, lease, json: { kind: 'elements', selector: 'a', fields: ['value'] },
  });
  expectError(invalidDom, 400, 'invalid_element_fields');

  // Fixed research snapshots retain complete visible bodies rather than the
  // ordinary DOM-query 16k ceiling, but keep lease ownership, fixed CDP calls,
  // isolated-world execution and recursive public-URL sanitization.
  const longVisibleBody = `全文起点${'完整可见正文，无关键词也保留。'.repeat(2200)}全文终点`;
  assert.ok(longVisibleBody.length > 16000);
  const publicNoteId = '6a575c8a000000002103cca9';
  const publicProfileId = '5f5140b50000000001004d8b';
  fakeCdp.state.researchSnapshot = {
    schema_version: 1,
    recipe: 'xiaohongshu-notes',
    items: [{
      source_id: publicNoteId,
      post_url: `https://www.xiaohongshu.com/explore/${publicNoteId}?xsec_token=secret-signature&access_token=secret-token#fragment`,
      full_visible_text: longVisibleBody,
      own_visible_text: longVisibleBody,
      repost: [{ text: '引用全文', post_url: 'https://www.facebook.com/story.php?id=123456&story_fbid=987654&access_token=secret-token' }],
      media: { urls: ['https://img.example.test/public.jpg?token=secret-token'], items: [{ url: 'https://img.example.test/public2.jpg?signature=secret-signature' }] },
      truncation: { text_collection_truncated: false, list_summary: true, needs_detail: true },
    }],
    page_state: { url: `https://www.xiaohongshu.com/user/profile/${publicProfileId}?xsec_token=secret-signature`, historical_completion_proven: false, completion: 'visible_dom_only' },
  };
  const researchCallsBefore = fakeCdp.state.runtimeCallCount;
  const research = await brokerRequest(baseUrl, `/research/snapshot?target=${TARGET_ID}`, {
    method: 'POST', token, lease, json: { recipe: 'xiaohongshu-notes' },
  });
  assert.equal(research.status, 200, research.text);
  assert.equal(research.value.value.items[0].full_visible_text, longVisibleBody, 'research body was silently truncated to the ordinary DOM-query ceiling');
  assert.equal(research.value.value.items[0].own_visible_text, longVisibleBody);
  assert.equal(research.value.value.items[0].source_id, publicNoteId, 'registered public source ID was redacted');
  assert.equal(research.value.value.items[0].post_url, `https://www.xiaohongshu.com/explore/${publicNoteId}`);
  assert.equal(research.value.value.page_state.url, `https://www.xiaohongshu.com/user/profile/${publicProfileId}`);
  assert.equal(research.value.value.items[0].repost[0].post_url, 'https://www.facebook.com/story.php?id=123456&story_fbid=987654');
  assert.deepEqual(research.value.value.items[0].media.urls, ['https://img.example.test/public.jpg']);
  assert.equal(research.value.value.items[0].media.items[0].url, 'https://img.example.test/public2.jpg');
  assert.equal(research.value.value.page_state.historical_completion_proven, false);
  assert.equal(fakeCdp.state.runtimeCallCount - researchCallsBefore, 1);
  assert.equal(fakeCdp.state.researchRuntimeCalls.length, 1);
  const researchCdp = fakeCdp.state.researchRuntimeCalls[0];
  assert.equal(researchCdp.executionContextId, 101, 'research read did not use the isolated DOM world');
  assert.equal(researchCdp.returnByValue, true);
  assert.equal(researchCdp.awaitPromise, false);
  assert.equal(researchCdp.userGesture, false);
  assert.deepEqual(researchCdp.arguments, []);
  assert.ok(researchCdp.sessionId, 'research read did not use a target session');
  assert.ok(researchCdp.functionDeclaration.endsWith(')("xiaohongshu-notes"); }'), 'recipe was not bound into the registered fixed reader');

  const rejectedResearchRuntimeBaseline = fakeCdp.state.runtimeCallCount;
  const badResearchLease = await brokerRequest(baseUrl, `/research/snapshot?target=${TARGET_ID}`, {
    method: 'POST', token, lease: 'wrong-lease-token-that-is-long-enough', json: { recipe: 'weibo-feed' },
  });
  expectError(badResearchLease, 409, 'lease_conflict');
  const invalidResearchBodies = [
    { body: { recipe: 'document.cookie' }, code: 'invalid_research_recipe' },
    { body: { recipe: '__proto__' }, code: 'invalid_research_recipe' },
    { body: { recipe: 'weibo-feed', expression: 'document.cookie' }, code: 'invalid_research_request' },
    { body: { recipe: 'weibo-feed', selector: 'input[value]' }, code: 'invalid_research_request' },
    { body: { recipe: 'weibo-feed', url: '/private/api' }, code: 'invalid_research_request' },
    { body: [], code: 'invalid_research_request' },
  ];
  for (const invalid of invalidResearchBodies) {
    const result = await brokerRequest(baseUrl, `/research/snapshot?target=${TARGET_ID}`, {
      method: 'POST', token, lease, json: invalid.body,
    });
    expectError(result, 400, invalid.code);
  }
  const malformedResearch = await brokerRequest(baseUrl, `/research/snapshot?target=${TARGET_ID}`, {
    method: 'POST', token, lease, rawBody: '{not-json',
  });
  expectError(malformedResearch, 400, 'invalid_json');
  assert.equal(fakeCdp.state.runtimeCallCount, rejectedResearchRuntimeBaseline, 'rejected recipe, injection, or lease still executed a CDP reader');
  assert.equal(fakeCdp.state.researchRuntimeCalls.length, 1);
  for (const method of ['Runtime.evaluate', 'Network.getCookies', 'Network.getAllCookies', 'DOMStorage.getDOMStorageItems', 'Fetch.enable']) {
    assert.throws(() => assertCdpMethodAllowed(method), error => error?.code === 'cdp_method_not_allowed');
    assert.equal(fakeCdp.state.methodCounts.get(method) || 0, 0, `research route broadened CDP access to ${method}`);
  }
  fakeCdp.state.researchSnapshot = null;

  fakeCdp.state.activeRuntimeCalls = 0;
  fakeCdp.state.maxActiveRuntimeCalls = 0;
  const runtimeCallsBefore = fakeCdp.state.runtimeCallCount;
  const startedAt = Date.now();
  const concurrentResults = await Promise.all([
    brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, { token, lease }),
    brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, { token, lease }),
  ]);
  for (const result of concurrentResults) assert.equal(result.status, 200, result.text);
  assert.equal(fakeCdp.state.runtimeCallCount - runtimeCallsBefore, 2);
  assert.equal(fakeCdp.state.maxActiveRuntimeCalls, 1, 'same-target Runtime calls were not serialized');
  assert.ok(Date.now() - startedAt >= 250, 'same-target requests did not wait for one another');

  const closeCountBeforeExpiry = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  const detachCountBeforeExpiry = fakeCdp.state.methodCounts.get('Target.detachFromTarget') || 0;
  const ttlReplayPath = `/new?url=${encodeURIComponent('https://example.test/active-idempotency-after-ttl')}`;
  const ttlReplayRequestId = 'integration-active-idempotency-after-ttl-0001';
  const ttlReplayCreated = await brokerRequest(baseUrl, ttlReplayPath, {
    method: 'POST', token, requestId: ttlReplayRequestId,
  });
  assert.equal(ttlReplayCreated.status, 200, ttlReplayCreated.text);
  await sleep(FIXTURE_LEASE_TTL_MS * 0.6);
  assert.equal((await brokerRequest(baseUrl, `/info?target=${ttlReplayCreated.value.targetId}`, {
    token, lease: ttlReplayCreated.value.leaseToken,
  })).status, 200);
  await sleep(FIXTURE_LEASE_TTL_MS * 0.4 + 300);
  const ttlReplay = await brokerRequest(baseUrl, ttlReplayPath, {
    method: 'POST', token, requestId: ttlReplayRequestId,
  });
  assert.equal(ttlReplay.status, 200, ttlReplay.text);
  assert.equal(ttlReplay.value.replayed, true);
  assert.equal(ttlReplay.value.targetId, ttlReplayCreated.value.targetId);
  assert.equal(ttlReplay.value.leaseToken, ttlReplayCreated.value.leaseToken);
  const ttlReplayFinalized = await brokerRequest(baseUrl, `/finalize?target=${ttlReplay.value.targetId}`, {
    method: 'POST', token, lease: ttlReplay.value.leaseToken,
  });
  assert.equal(ttlReplayFinalized.status, 200, ttlReplayFinalized.text);
  const targetsAfterExpiry = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targetsAfterExpiry.status, 200, targetsAfterExpiry.text);
  assert.equal(targetsAfterExpiry.value.targets.find((target) => target.targetId === TARGET_ID)?.lease, 'available');
  assert.equal(fakeCdp.state.methodCounts.get('Target.closeTarget') || 0, closeCountBeforeExpiry + 1, 'expired lease closed the user page');
  assert.ok((fakeCdp.state.methodCounts.get('Target.detachFromTarget') || 0) > detachCountBeforeExpiry, 'expired lease did not detach its broker session');

  const expiredLeaseUse = await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, { token, lease });
  expectError(expiredLeaseUse, 409, 'lease_required');
  const reacquired = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, requestId: 'integration-reacquire-after-expiry-0001',
  });
  assert.equal(reacquired.status, 200, reacquired.text);
  assert.notEqual(reacquired.value.leaseToken, lease);
  const releasedReacquired = await brokerRequest(baseUrl, `/release?target=${TARGET_ID}`, {
    method: 'POST', token, lease: reacquired.value.leaseToken,
  });
  assert.equal(releasedReacquired.status, 200, releasedReacquired.text);
  assert.equal(releasedReacquired.value.closed, false);

  const acquireRaceTargetId = 'fake-acquire-destroy-race';
  fakeCdp.state.targets.set(acquireRaceTargetId, {
    targetId: acquireRaceTargetId, type: 'page', title: 'Acquire race', url: 'https://example.test/acquire-race', attached: false,
  });
  fakeCdp.state.destroyAfterTargetInfoResponse.add(acquireRaceTargetId);
  const acquireDestroyedRace = await brokerRequest(baseUrl, `/acquire?target=${acquireRaceTargetId}`, {
    method: 'POST', token, requestId: 'integration-acquire-destroyed-0001',
  });
  expectError(acquireDestroyedRace, 502, 'target_destroyed');
  assert.equal(acquireDestroyedRace.value?.leaseToken, undefined);
  assert.equal((await brokerRequest(baseUrl, '/health', { owner: null })).value.leases, 0);

  const acquireExternalAttachRaceTargetId = 'fake-acquire-external-attach-race';
  fakeCdp.state.targets.set(acquireExternalAttachRaceTargetId, {
    targetId: acquireExternalAttachRaceTargetId,
    type: 'page',
    title: 'Acquire external attach race',
    url: 'https://example.test/acquire-external-attach-race',
    attached: false,
  });
  fakeCdp.state.attachAfterTargetInfoResponse.add(acquireExternalAttachRaceTargetId);
  const acquireExternalAttachRace = await brokerRequest(baseUrl, `/acquire?target=${acquireExternalAttachRaceTargetId}`, {
    method: 'POST', token, requestId: 'integration-acquire-external-attach-race-0001',
  });
  expectError(acquireExternalAttachRace, 409, 'external_debugger_present');
  assert.equal(acquireExternalAttachRace.value?.leaseToken, undefined);
  assert.equal((await brokerRequest(baseUrl, '/health', { owner: null })).value.leases, 0);
  fakeCdp.state.targets.get(acquireExternalAttachRaceTargetId).attached = false;

  const detachErrorTargetId = 'fake-detach-error';
  fakeCdp.state.targets.set(detachErrorTargetId, {
    targetId: detachErrorTargetId, type: 'page', title: 'Detach error', url: 'https://example.test/detach-error', attached: false,
  });
  const detachErrorAcquire = await brokerRequest(baseUrl, `/acquire?target=${detachErrorTargetId}`, {
    method: 'POST', token, requestId: 'integration-detach-error-acquire-0001',
  });
  assert.equal(detachErrorAcquire.status, 200, detachErrorAcquire.text);
  const detachErrorInfo = await brokerRequest(baseUrl, `/info?target=${detachErrorTargetId}`, {
    token, lease: detachErrorAcquire.value.leaseToken,
  });
  assert.equal(detachErrorInfo.status, 200, detachErrorInfo.text);
  fakeCdp.state.detachBehaviors.set(detachErrorTargetId, 'error');
  const connectionsBeforeDetachError = fakeCdp.state.connectionCount;
  const discoveryCallsBeforeDetachError = fakeCdp.state.methodCounts.get('Target.setDiscoverTargets') || 0;
  const detachErrorRelease = await brokerRequest(baseUrl, `/release?target=${detachErrorTargetId}`, {
    method: 'POST', token, lease: detachErrorAcquire.value.leaseToken,
  });
  assert.equal(detachErrorRelease.status, 200, detachErrorRelease.text);
  const healthAfterDetachError = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterDetachError.value.connection.state, 'disconnected');
  assert.equal(healthAfterDetachError.value.sessions, 0);
  assert.equal(healthAfterDetachError.value.leases, 0);
  const reconnectedTargets = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(reconnectedTargets.status, 200, reconnectedTargets.text);
  assert.equal(fakeCdp.state.connectionCount, connectionsBeforeDetachError + 1);
  assert.equal(fakeCdp.state.methodCounts.get('Target.setDiscoverTargets') || 0, discoveryCallsBeforeDetachError + 1);

  const noSessionTargetId = 'fake-detach-no-session';
  fakeCdp.state.targets.set(noSessionTargetId, {
    targetId: noSessionTargetId, type: 'page', title: 'Already detached', url: 'https://example.test/no-session', attached: false,
  });
  const noSessionAcquire = await brokerRequest(baseUrl, `/acquire?target=${noSessionTargetId}`, {
    method: 'POST', token, requestId: 'integration-no-session-acquire-0001',
  });
  assert.equal(noSessionAcquire.status, 200, noSessionAcquire.text);
  assert.equal((await brokerRequest(baseUrl, `/info?target=${noSessionTargetId}`, {
    token, lease: noSessionAcquire.value.leaseToken,
  })).status, 200);
  fakeCdp.state.detachBehaviors.set(noSessionTargetId, 'no-session');
  const connectionsBeforeNoSession = fakeCdp.state.connectionCount;
  const noSessionRelease = await brokerRequest(baseUrl, `/release?target=${noSessionTargetId}`, {
    method: 'POST', token, lease: noSessionAcquire.value.leaseToken,
  });
  assert.equal(noSessionRelease.status, 200, noSessionRelease.text);
  const healthAfterNoSession = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterNoSession.value.connection.state, 'connected');
  assert.equal(healthAfterNoSession.value.sessions, 0);
  assert.equal(fakeCdp.state.connectionCount, connectionsBeforeNoSession, 'No session detach error retired a healthy connection');

  assert.throws(() => new URL('//[', baseUrl), { name: 'TypeError' });
  const malformedResponse = await rawHttpRequest(brokerPort, '//[');
  assert.match(malformedResponse, /^HTTP\/1\.1 400 /u);
  assert.match(malformedResponse, /"code":"invalid_request_target"/u);
  assert.equal(broker.child.exitCode, null, 'malformed request-target terminated the broker');
  const healthAfterMalformedRequest = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterMalformedRequest.status, 200, healthAfterMalformedRequest.text);
  assert.equal(healthAfterMalformedRequest.value.connection.state, 'connected');

  const newUrl = 'https://example.test/new-page';
  const newPath = `/new?url=${encodeURIComponent(newUrl)}`;
  const createCountBefore = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  const created = await brokerRequest(baseUrl, newPath, {
    method: 'POST', token, requestId: 'integration-new-idempotency-0001',
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.value.ready, true);
  assert.match(created.value.leaseToken, /^[A-Za-z0-9_-]{24,128}$/u);
  assert.equal((fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createCountBefore, 1);

  const createdReplay = await brokerRequest(baseUrl, newPath, {
    method: 'POST', token, requestId: 'integration-new-idempotency-0001',
  });
  assert.equal(createdReplay.status, 200, createdReplay.text);
  assert.equal(createdReplay.value.replayed, true);
  assert.equal(createdReplay.value.targetId, created.value.targetId);
  assert.equal(createdReplay.value.leaseToken, created.value.leaseToken);
  assert.equal(createdReplay.value.leaseEpoch, created.value.leaseEpoch);
  assert.equal((fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createCountBefore, 1, 'new replay created a duplicate page');

  const newKeyConflict = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/different-page')}`, {
    method: 'POST', token, requestId: 'integration-new-idempotency-0001',
  });
  expectError(newKeyConflict, 409, 'idempotency_key_conflict');
  const finalizedCreated = await brokerRequest(baseUrl, `/finalize?target=${created.value.targetId}`, {
    method: 'POST', token, lease: created.value.leaseToken,
  });
  assert.equal(finalizedCreated.status, 200, finalizedCreated.text);
  assert.equal(finalizedCreated.value.closed, true);

  const staleReplayUrl = 'https://example.test/stale-complete-replay';
  const staleReplayPath = `/new?url=${encodeURIComponent(staleReplayUrl)}`;
  const staleReplayRequestId = 'integration-new-stale-complete-replay-0001';
  const createsBeforeStaleReplay = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  const staleReplayCreated = await brokerRequest(baseUrl, staleReplayPath, {
    method: 'POST', token, requestId: staleReplayRequestId,
  });
  assert.equal(staleReplayCreated.status, 200, staleReplayCreated.text);
  fakeCdp.removeTargetSilently(staleReplayCreated.value.targetId);
  fakeCdp.disconnectAll();
  await waitFor(async () => {
    const state = await brokerRequest(baseUrl, '/health', { owner: null });
    return state.value?.connection?.state === 'disconnected';
  }, { timeoutMs: 2000, label: 'broker disconnect before stale replay' });
  const staleReplay = await brokerRequest(baseUrl, staleReplayPath, {
    method: 'POST', token, requestId: staleReplayRequestId,
  });
  expectError(staleReplay, 404, 'target_destroyed');
  assert.deepEqual(
    (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
    { active: 0, limit: 5 },
    'stale complete replay left a phantom task-page slot',
  );
  assert.equal(
    (fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createsBeforeStaleReplay,
    1,
    'stale complete replay created a duplicate before reporting the missing target',
  );
  const staleReplayReplacement = await brokerRequest(baseUrl, staleReplayPath, {
    method: 'POST', token, requestId: staleReplayRequestId,
  });
  assert.equal(staleReplayReplacement.status, 200, staleReplayReplacement.text);
  assert.notEqual(staleReplayReplacement.value.targetId, staleReplayCreated.value.targetId);
  assert.equal(
    (fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createsBeforeStaleReplay,
    2,
    'same request id did not safely recreate the page after explicit target_destroyed',
  );
  const finalizedStaleReplacement = await brokerRequest(baseUrl, `/finalize?target=${staleReplayReplacement.value.targetId}`, {
    method: 'POST', token, lease: staleReplayReplacement.value.leaseToken,
  });
  assert.equal(finalizedStaleReplacement.status, 200, finalizedStaleReplacement.text);

  const staleFinalizeCreated = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/stale-finalize')}`, {
    method: 'POST', token, requestId: 'integration-new-stale-finalize-0001',
  });
  assert.equal(staleFinalizeCreated.status, 200, staleFinalizeCreated.text);
  fakeCdp.removeTargetSilently(staleFinalizeCreated.value.targetId);
  fakeCdp.disconnectAll();
  await waitFor(async () => {
    const state = await brokerRequest(baseUrl, '/health', { owner: null });
    return state.value?.connection?.state === 'disconnected';
  }, { timeoutMs: 2000, label: 'broker disconnect before stale finalize' });
  const staleFinalize = await brokerRequest(baseUrl, `/finalize?target=${staleFinalizeCreated.value.targetId}`, {
    method: 'POST', token, lease: staleFinalizeCreated.value.leaseToken,
  });
  assert.equal(staleFinalize.status, 200, staleFinalize.text);
  assert.equal(staleFinalize.value.closed, true);
  assert.deepEqual(
    (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
    { active: 0, limit: 5 },
    'stale finalize left a phantom task-page slot',
  );

  const createResponseLostUrl = 'https://example.test/create-response-recovered';
  const createResponseLostPath = `/new?url=${encodeURIComponent(createResponseLostUrl)}`;
  const createResponseLostRequestId = 'integration-new-create-response-lost-0001';
  const createCountBeforeLostResponse = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  fakeCdp.state.nextCreateBehavior = 'stall-after-create';
  const createResponseLostSocket = net.createConnection({ host: '127.0.0.1', port: brokerPort });
  createResponseLostSocket.on('error', () => {});
  await new Promise((resolve, reject) => {
    createResponseLostSocket.once('connect', resolve);
    createResponseLostSocket.once('error', reject);
  });
  createResponseLostSocket.write([
    `POST ${createResponseLostPath} HTTP/1.1`,
    `Host: 127.0.0.1:${brokerPort}`,
    `Authorization: Bearer ${token}`,
    `X-CDP-Owner: ${OWNER}`,
    `X-CDP-Request-Id: ${createResponseLostRequestId}`,
    'Content-Length: 0',
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  const lostCreateRecord = await waitFor(
    () => fakeCdp.state.delayedCreateRecords.find((record) => record.markerUrl?.startsWith('about:blank#codex-edge-broker-v2-')),
    { timeoutMs: 2000, label: 'lost createTarget response record' },
  );
  createResponseLostSocket.destroy();
  await sleep(75);
  const recoveredCreate = await brokerRequest(baseUrl, createResponseLostPath, {
    method: 'POST', token, requestId: createResponseLostRequestId,
  });
  assert.equal(recoveredCreate.status, 200, recoveredCreate.text);
  assert.equal(recoveredCreate.value.targetId, lostCreateRecord.targetId);
  assert.equal(recoveredCreate.value.replayed, true);
  assert.equal(recoveredCreate.value.recovered, true);
  assert.match(recoveredCreate.value.leaseToken, /^[A-Za-z0-9_-]{24,128}$/u);
  assert.equal(
    (fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createCountBeforeLostResponse,
    1,
    'same RequestId created a duplicate after createTarget response loss',
  );
  const navigateRecoveredCreate = await brokerRequest(
    baseUrl,
    `/navigate?target=${recoveredCreate.value.targetId}&url=${encodeURIComponent(createResponseLostUrl)}`,
    { method: 'POST', token, lease: recoveredCreate.value.leaseToken },
  );
  assert.equal(navigateRecoveredCreate.status, 200, navigateRecoveredCreate.text);
  const createResponseRecoveredDeliveredTargetId = recoveredCreate.value.targetId;
  assert.equal(fakeCdp.state.targets.get(createResponseRecoveredDeliveredTargetId)?.url, createResponseLostUrl);
  const releaseRecoveredCreate = await brokerRequest(baseUrl, `/release?target=${createResponseRecoveredDeliveredTargetId}`, {
    method: 'POST', token, lease: recoveredCreate.value.leaseToken,
  });
  assert.equal(releaseRecoveredCreate.status, 200, releaseRecoveredCreate.text);

  const concurrentNewUrl = 'https://example.test/concurrent-new-initialization';
  const concurrentNewPath = `/new?url=${encodeURIComponent(concurrentNewUrl)}`;
  const concurrentNewRequestId = 'integration-new-concurrent-initialization-0001';
  fakeCdp.state.navigateBehaviorsByUrl.set(concurrentNewUrl, 'stall');
  const firstConcurrentNewPromise = brokerRequest(baseUrl, concurrentNewPath, {
    method: 'POST', token, requestId: concurrentNewRequestId,
  });
  const delayedConcurrentNavigate = await waitFor(
    () => fakeCdp.state.delayedNavigateRecords.find((record) => record.destination === concurrentNewUrl),
    { timeoutMs: 2000, label: 'concurrent new initialization navigation stall' },
  );
  const secondConcurrentNewPromise = brokerRequest(baseUrl, concurrentNewPath, {
    method: 'POST', token, requestId: concurrentNewRequestId,
  });
  const earlyConcurrentReplay = await Promise.race([
    secondConcurrentNewPromise.then((value) => ({ settled: true, value })),
    sleep(200).then(() => ({ settled: false, value: null })),
  ]);
  delayedConcurrentNavigate.respond();
  const firstConcurrentNew = await firstConcurrentNewPromise;
  assert.equal(firstConcurrentNew.status, 200, firstConcurrentNew.text);
  assert.equal(firstConcurrentNew.value.ready, true);
  if (earlyConcurrentReplay.settled) {
    assert.notEqual(earlyConcurrentReplay.value.status, 200, 'concurrent same-RequestId replay received an early 200 lease');
    assert.equal(earlyConcurrentReplay.value.value?.leaseToken, undefined);
  }
  let completedConcurrentReplay = earlyConcurrentReplay.settled
    ? await brokerRequest(baseUrl, concurrentNewPath, { method: 'POST', token, requestId: concurrentNewRequestId })
    : await secondConcurrentNewPromise;
  if (completedConcurrentReplay.status !== 200) {
    completedConcurrentReplay = await brokerRequest(baseUrl, concurrentNewPath, {
      method: 'POST', token, requestId: concurrentNewRequestId,
    });
  }
  assert.equal(completedConcurrentReplay.status, 200, completedConcurrentReplay.text);
  assert.equal(completedConcurrentReplay.value.targetId, firstConcurrentNew.value.targetId);
  assert.equal(completedConcurrentReplay.value.leaseToken, firstConcurrentNew.value.leaseToken);
  assert.equal(completedConcurrentReplay.value.replayed, true);
  const finalizeConcurrentNew = await brokerRequest(baseUrl, `/finalize?target=${firstConcurrentNew.value.targetId}`, {
    method: 'POST', token, lease: firstConcurrentNew.value.leaseToken,
  });
  assert.equal(finalizeConcurrentNew.status, 200, finalizeConcurrentNew.text);

  const explicitNavigateFailureUrl = 'https://example.test/explicit-navigate-failure';
  const explicitNavigateFailurePath = `/new?url=${encodeURIComponent(explicitNavigateFailureUrl)}`;
  const explicitNavigateFailureRequestId = 'integration-new-explicit-navigate-failure-0001';
  fakeCdp.state.navigateBehaviorsByUrl.set(explicitNavigateFailureUrl, 'error');
  const explicitNavigateFailure = await brokerRequest(baseUrl, explicitNavigateFailurePath, {
    method: 'POST', token, requestId: explicitNavigateFailureRequestId,
  });
  assert.notEqual(explicitNavigateFailure.status, 200, 'explicit Page.navigate failure returned a 200 lease');
  assert.equal(explicitNavigateFailure.value?.ok, false, explicitNavigateFailure.text);
  assert.equal(explicitNavigateFailure.value?.leaseToken, undefined);
  fakeCdp.state.navigateBehaviorsByUrl.set(explicitNavigateFailureUrl, 'error');
  const explicitNavigateFailureReplay = await brokerRequest(baseUrl, explicitNavigateFailurePath, {
    method: 'POST', token, requestId: explicitNavigateFailureRequestId,
  });
  assert.notEqual(explicitNavigateFailureReplay.status, 200, 'failed Page.navigate was stored as a complete idempotent 200 lease');
  assert.equal(explicitNavigateFailureReplay.value?.leaseToken, undefined);
  const explicitNavigateRecovered = await brokerRequest(baseUrl, explicitNavigateFailurePath, {
    method: 'POST', token, requestId: explicitNavigateFailureRequestId,
  });
  assert.equal(explicitNavigateRecovered.status, 200, explicitNavigateRecovered.text);
  const finalizeExplicitNavigateRecovered = await brokerRequest(baseUrl, `/finalize?target=${explicitNavigateRecovered.value.targetId}`, {
    method: 'POST', token, lease: explicitNavigateRecovered.value.leaseToken,
  });
  assert.equal(finalizeExplicitNavigateRecovered.status, 200, finalizeExplicitNavigateRecovered.text);

  const lostNavigateUrl = 'https://example.test/navigate-result-lost';
  const lostNavigatePath = `/new?url=${encodeURIComponent(lostNavigateUrl)}`;
  const lostNavigateRequestId = 'integration-new-navigate-result-lost-0001';
  const createCountBeforeLostNavigate = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  fakeCdp.state.navigateBehaviorsByUrl.set(lostNavigateUrl, 'drop-connection-after-apply');
  const lostNavigate = await brokerRequest(baseUrl, lostNavigatePath, {
    method: 'POST', token, requestId: lostNavigateRequestId,
  });
  const lostNavigateRecord = await waitFor(
    () => fakeCdp.state.lostNavigateRecords.find((record) => record.destination === lostNavigateUrl),
    { timeoutMs: 2000, label: 'lost Page.navigate result record' },
  );
  assert.notEqual(lostNavigate.status, 200, 'outcome-unknown Page.navigate returned a 200 lease');
  assert.equal(lostNavigate.value?.ok, false, lostNavigate.text);
  assert.equal(lostNavigate.value?.leaseToken, undefined);
  assert.equal(fakeCdp.state.targets.get(lostNavigateRecord.targetId)?.url, lostNavigateUrl);
  await sleep(FIXTURE_LEASE_TTL_MS + 250);
  const recoveredLostNavigate = await brokerRequest(baseUrl, lostNavigatePath, {
    method: 'POST', token, requestId: lostNavigateRequestId,
  });
  assert.equal(recoveredLostNavigate.status, 200, recoveredLostNavigate.text);
  assert.equal(recoveredLostNavigate.value.targetId, lostNavigateRecord.targetId);
  assert.equal(recoveredLostNavigate.value.replayed, true);
  assert.match(recoveredLostNavigate.value.leaseToken, /^[A-Za-z0-9_-]{24,128}$/u);
  assert.equal(
    (fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createCountBeforeLostNavigate,
    1,
    'same RequestId created a duplicate after Page.navigate result loss',
  );
  const lostNavigateRecoveredDeliveredTargetId = recoveredLostNavigate.value.targetId;
  const releaseRecoveredLostNavigate = await brokerRequest(baseUrl, `/release?target=${lostNavigateRecoveredDeliveredTargetId}`, {
    method: 'POST', token, lease: recoveredLostNavigate.value.leaseToken,
  });
  assert.equal(releaseRecoveredLostNavigate.status, 200, releaseRecoveredLostNavigate.text);

  fakeCdp.state.destroyNextCreatedDuringInitialization = true;
  const destroyRequestId = 'integration-new-destroyed-0001';
  const createCountBeforeDestroyed = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
  const destroyedDuringInitialization = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('about:blank')}`, {
    method: 'POST', token, requestId: destroyRequestId,
  });
  assert.ok([404, 502].includes(destroyedDuringInitialization.status), destroyedDuringInitialization.text);
  assert.equal(destroyedDuringInitialization.value?.ok, false, destroyedDuringInitialization.text);
  assert.equal(destroyedDuringInitialization.value?.error?.code, 'target_destroyed', destroyedDuringInitialization.text);
  assert.equal(destroyedDuringInitialization.value.leaseToken, undefined);
  const destroyedTargetId = fakeCdp.state.lastDestroyedTargetId;
  assert.ok(destroyedTargetId);
  assert.equal(destroyedDuringInitialization.value.error.details.targetId, destroyedTargetId);
  assert.equal(fakeCdp.state.targets.has(destroyedTargetId), false);

  const retryAfterDestroyed = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('about:blank')}`, {
    method: 'POST', token, requestId: destroyRequestId,
  });
  assert.equal(retryAfterDestroyed.status, 200, retryAfterDestroyed.text);
  assert.notEqual(retryAfterDestroyed.value.targetId, destroyedTargetId);
  assert.notEqual(retryAfterDestroyed.value.replayed, true);
  assert.equal((fakeCdp.state.methodCounts.get('Target.createTarget') || 0) - createCountBeforeDestroyed, 2, 'destroyed target was replayed instead of recreated safely');
  const finalizedRetry = await brokerRequest(baseUrl, `/finalize?target=${retryAfterDestroyed.value.targetId}`, {
    method: 'POST', token, lease: retryAfterDestroyed.value.leaseToken,
  });
  assert.equal(finalizedRetry.status, 200, finalizedRetry.text);
  assert.equal(finalizedRetry.value.closed, true);

  const closeRaceCreated = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('about:blank')}`, {
    method: 'POST', token, requestId: 'integration-close-event-first-0001',
  });
  assert.equal(closeRaceCreated.status, 200, closeRaceCreated.text);
  fakeCdp.state.closeBehaviors.set(closeRaceCreated.value.targetId, 'destroy-before-response');
  const connectionsBeforeCloseRace = fakeCdp.state.connectionCount;
  const discoveryCallsBeforeCloseRace = fakeCdp.state.methodCounts.get('Target.setDiscoverTargets') || 0;
  const closeRaceStartedAt = Date.now();
  const closeRace = await brokerRequest(baseUrl, `/finalize?target=${closeRaceCreated.value.targetId}`, {
    method: 'POST', token, lease: closeRaceCreated.value.leaseToken,
  });
  const closeRaceElapsedMs = Date.now() - closeRaceStartedAt;
  assert.equal(closeRace.status, 200, closeRace.text);
  assert.equal(closeRace.value.closed, true);
  assert.ok(closeRaceElapsedMs < 600, `event-first close waited ${closeRaceElapsedMs}ms for the delayed response`);
  assert.equal(fakeCdp.state.connectionCount, connectionsBeforeCloseRace, 'event-first close rebuilt the CDP connection');
  assert.equal(fakeCdp.state.methodCounts.get('Target.setDiscoverTargets') || 0, discoveryCallsBeforeCloseRace, 'event-first close re-ran connection validation');
  assert.equal((await brokerRequest(baseUrl, '/health', { owner: null })).value.connection.state, 'connected');

  const closeFalseCreated = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('about:blank')}`, {
    method: 'POST', token, requestId: 'integration-close-false-0001',
  });
  assert.equal(closeFalseCreated.status, 200, closeFalseCreated.text);
  fakeCdp.state.closeBehaviors.set(closeFalseCreated.value.targetId, 'false-no-destroy');
  const closeFalse = await brokerRequest(baseUrl, `/finalize?target=${closeFalseCreated.value.targetId}`, {
    method: 'POST', token, lease: closeFalseCreated.value.leaseToken,
  });
  expectError(closeFalse, 502, 'close_failed');
  assert.equal(fakeCdp.state.targets.has(closeFalseCreated.value.targetId), true);
  const finalizedAfterCloseFalse = await brokerRequest(baseUrl, `/finalize?target=${closeFalseCreated.value.targetId}`, {
    method: 'POST', token, lease: closeFalseCreated.value.leaseToken,
  });
  assert.equal(finalizedAfterCloseFalse.status, 200, finalizedAfterCloseFalse.text);
  assert.equal(finalizedAfterCloseFalse.value.closed, true);

  const stalledTargetId = 'fake-stalled-lane';
  fakeCdp.state.targets.set(stalledTargetId, {
    targetId: stalledTargetId, type: 'page', title: 'Stalled lane', url: 'https://example.test/stalled', attached: false,
  });
  const stalledAcquire = await brokerRequest(baseUrl, `/acquire?target=${stalledTargetId}`, {
    method: 'POST', token, requestId: 'integration-stalled-acquire-0001',
  });
  assert.equal(stalledAcquire.status, 200, stalledAcquire.text);
  fakeCdp.state.stallRuntimeForTarget = stalledTargetId;
  fakeCdp.state.detachBehaviors.set(stalledTargetId, 'stall');
  const stalledInfo = await brokerRequest(baseUrl, `/info?target=${stalledTargetId}`, {
    token, lease: stalledAcquire.value.leaseToken,
  });
  // The enlarged read envelope now leaves room for bounded detach cleanup;
  // it must report the original method timeout and keep the page quarantined.
  expectError(stalledInfo, 504, 'cdp_timeout');
  expectError(await brokerRequest(baseUrl, `/info?target=${stalledTargetId}`, {
    token, lease:stalledAcquire.value.leaseToken,
  }), 409, 'target_quarantined');
  const stalledRelease = await brokerRequest(baseUrl, `/release?target=${stalledTargetId}`, {
    method: 'POST', token, lease: stalledAcquire.value.leaseToken,
  });
  assert.equal(stalledRelease.status, 200, stalledRelease.text);
  assert.equal(stalledRelease.value.released, true);
  assert.equal(stalledRelease.value.closed, false);
  const targetsAfterStalledRelease = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targetsAfterStalledRelease.status, 200, targetsAfterStalledRelease.text);
  assert.equal(targetsAfterStalledRelease.value.targets.find((target) => target.targetId === stalledTargetId)?.lease, 'available');
  assert.equal((await brokerRequest(baseUrl, '/health', { owner: null })).value.leases, 0);

  // Releasing and reacquiring the same original page must not erase failure.
  fakeCdp.state.detachBehaviors.delete(stalledTargetId);
  const afterStallAcquire = await brokerRequest(baseUrl, `/acquire?target=${stalledTargetId}`, {
    method: 'POST', token, requestId: 'integration-after-stall-acquire-0001',
  });
  assert.equal(afterStallAcquire.status, 200, afterStallAcquire.text);
  const runtimeBeforeReacquire = fakeCdp.state.methodCounts.get('Runtime.callFunctionOn') || 0;
  expectError(await brokerRequest(baseUrl, `/info?target=${stalledTargetId}`, {
    token, lease: afterStallAcquire.value.leaseToken,
  }), 409, 'target_quarantined');
  assert.equal(fakeCdp.state.methodCounts.get('Runtime.callFunctionOn') || 0, runtimeBeforeReacquire,
    'reacquisition must not silently retry the failed renderer');
  // Only an explicit successful recovery can clear the original failure.
  fakeCdp.state.stallRuntimeForTarget = null;
  const recoveredQuarantine = await brokerRequest(baseUrl, `/recover?target=${stalledTargetId}`, {
    method: 'POST', token, lease: afterStallAcquire.value.leaseToken,
  });
  assert.equal(recoveredQuarantine.status, 200, recoveredQuarantine.text);
  assert.equal((await brokerRequest(baseUrl, `/info?target=${stalledTargetId}`, {
    token, lease: afterStallAcquire.value.leaseToken,
  })).status, 200);
  assert.equal((await brokerRequest(baseUrl, `/release?target=${stalledTargetId}`, {
    method: 'POST', token, lease: afterStallAcquire.value.leaseToken,
  })).status, 200);

  const attachAbortTargetId = 'fake-attach-abort';
  fakeCdp.state.targets.set(attachAbortTargetId, {
    targetId: attachAbortTargetId, type: 'page', title: 'Attach abort', url: 'https://example.test/attach-abort', attached: false,
  });
  const attachAbortAcquire = await brokerRequest(baseUrl, `/acquire?target=${attachAbortTargetId}`, {
    method: 'POST', token, requestId: 'integration-attach-abort-acquire-0001',
  });
  assert.equal(attachAbortAcquire.status, 200, attachAbortAcquire.text);
  const attachAbortConnectionId = fakeCdp.state.connectionCount;
  fakeCdp.state.attachBehaviors.set(attachAbortTargetId, 'stall');
  const abortingHttpSocket = net.createConnection({ host: '127.0.0.1', port: brokerPort });
  await new Promise((resolve, reject) => {
    abortingHttpSocket.once('connect', resolve);
    abortingHttpSocket.once('error', reject);
  });
  abortingHttpSocket.write([
    `GET /info?target=${attachAbortTargetId} HTTP/1.1`,
    `Host: 127.0.0.1:${brokerPort}`,
    `Authorization: Bearer ${token}`,
    `X-CDP-Owner: ${OWNER}`,
    `X-CDP-Lease: ${attachAbortAcquire.value.leaseToken}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  const delayedAttach = await waitFor(
    () => fakeCdp.state.delayedAttachRecords.find((record) => record.targetId === attachAbortTargetId),
    { timeoutMs: 1500, label: 'stalled attach record' },
  );
  const attachAbortClientDestroyedAt = Date.now();
  abortingHttpSocket.destroy();
  try {
    await waitFor(
      () => fakeCdp.state.closedConnectionIds.has(delayedAttach.connectionId),
      { timeoutMs: 2500, label: 'aborted attach socket retirement' },
    );
    attachAbortCloseDelayMs = fakeCdp.state.closedConnectionTimes.get(delayedAttach.connectionId)
      - attachAbortClientDestroyedAt;
    assert.ok(
      attachAbortCloseDelayMs >= 0 && attachAbortCloseDelayMs < 1000,
      `aborted attach socket retirement was not prompt (${attachAbortCloseDelayMs}ms)`,
    );
  } catch (error) {
    let diagnosticHealth = null;
    try {
      diagnosticHealth = (await brokerRequest(baseUrl, '/health', { owner: null })).value;
    } catch (healthError) {
      diagnosticHealth = { healthRequestError: healthError?.message || String(healthError) };
    }
    deferredRegressionError = new Error([
      error.message,
      `attachReceivedAt=${delayedAttach.receivedAt}`,
      `clientDestroyedAt=${attachAbortClientDestroyedAt}`,
      `destroyMinusAttachMs=${attachAbortClientDestroyedAt - delayedAttach.receivedAt}`,
      `diagnosticAt=${Date.now()}`,
      `oldFakeSocketDestroyed=${delayedAttach.socket.destroyed}`,
      `health=${JSON.stringify({
        connectionState: diagnosticHealth?.connection?.state,
        lastError: diagnosticHealth?.connection?.lastError,
        lastErrorCode: diagnosticHealth?.connection?.lastErrorCode,
        leases: diagnosticHealth?.leases,
        sessions: diagnosticHealth?.sessions,
      })}`,
      `brokerStderr=${JSON.stringify(broker.stderr.join(''))}`,
    ].join('; '));
    delayedAttach.socket.destroy();
    await waitFor(
      () => fakeCdp.state.closedConnectionIds.has(delayedAttach.connectionId),
      { timeoutMs: 1000, label: 'test-forced stale attach socket cleanup' },
    );
  }
  assert.equal(delayedAttach.connectionId, attachAbortConnectionId);
  assert.equal(delayedAttach.socket.destroyed, true);
  const healthAfterAttachAbort = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterAttachAbort.value.connection.state, 'disconnected');
  assert.equal(healthAfterAttachAbort.value.sessions, 0);

  const releaseAfterAttachAbort = await brokerRequest(baseUrl, `/release?target=${attachAbortTargetId}`, {
    method: 'POST', token, lease: attachAbortAcquire.value.leaseToken,
  });
  assert.equal(releaseAfterAttachAbort.status, 200, releaseAfterAttachAbort.text);
  const reacquireAfterAttachAbort = await brokerRequest(baseUrl, `/acquire?target=${attachAbortTargetId}`, {
    method: 'POST', token, requestId: 'integration-attach-abort-reacquire-0001',
  });
  assert.equal(reacquireAfterAttachAbort.status, 200, reacquireAfterAttachAbort.text);
  assert.notEqual(reacquireAfterAttachAbort.value.leaseToken, attachAbortAcquire.value.leaseToken);
  const lateAttachedFrame = encodeServerFrame(0x1, JSON.stringify({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: delayedAttach.sessionId,
      targetInfo: fakeCdp.state.targets.get(attachAbortTargetId),
      waitingForDebugger: false,
    },
  }));
  const lateWriteError = await new Promise((resolve) => {
    let settled = false;
    const finish = (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve(error || null); } };
    const timer = setTimeout(() => finish(null), 200);
    try { delayedAttach.socket.write(lateAttachedFrame, finish); } catch (error) { finish(error); }
  });
  assert.ok(lateWriteError, 'retired attach socket unexpectedly accepted a late attachedToTarget event');
  await sleep(40);
  const healthAfterLateAttach = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterLateAttach.value.sessions, 0);
  assert.equal(healthAfterLateAttach.value.leases, 1);
  const releaseReacquiredAttach = await brokerRequest(baseUrl, `/release?target=${attachAbortTargetId}`, {
    method: 'POST', token, lease: reacquireAfterAttachAbort.value.leaseToken,
  });
  assert.equal(releaseReacquiredAttach.status, 200, releaseReacquiredAttach.text);

  const sideEffectDestroyedTargetId = 'fake-navigate-destroyed';
  fakeCdp.state.targets.set(sideEffectDestroyedTargetId, {
    targetId: sideEffectDestroyedTargetId, type: 'page', title: 'Navigate destroyed', url: 'https://example.test/before', attached: false,
  });
  const sideEffectAcquire = await brokerRequest(baseUrl, `/acquire?target=${sideEffectDestroyedTargetId}`, {
    method: 'POST', token, requestId: 'integration-side-effect-destroy-acquire-0001',
  });
  assert.equal(sideEffectAcquire.status, 200, sideEffectAcquire.text);
  fakeCdp.state.destroyDuringNavigate.add(sideEffectDestroyedTargetId);
  const destroyedNavigate = await brokerRequest(
    baseUrl,
    `/navigate?target=${sideEffectDestroyedTargetId}&url=${encodeURIComponent('https://example.test/after')}`,
    { method: 'POST', token, lease: sideEffectAcquire.value.leaseToken },
  );
  expectError(destroyedNavigate, 409, 'outcome_unknown');
  const healthAfterDestroyedNavigate = await brokerRequest(baseUrl, '/health', { owner: null });
  assert.equal(healthAfterDestroyedNavigate.value.leases, 0);
  assert.equal(healthAfterDestroyedNavigate.value.sessions, 0);
  const targetsAfterDestroyedNavigate = await brokerRequest(baseUrl, '/targets', { token });
  assert.equal(targetsAfterDestroyedNavigate.status, 200, targetsAfterDestroyedNavigate.text);
  assert.equal(targetsAfterDestroyedNavigate.value.targets.some((target) => target.targetId === sideEffectDestroyedTargetId), false);

  const orphanAuthenticId = 'fake-orphan-authentic';
  const orphanFakeHmacId = 'fake-orphan-fake-hmac';
  const orphanOtherPortId = 'fake-orphan-other-port';
  const orphanExternalId = 'fake-orphan-external';
  const otherBrokerPort = brokerPort === 65535 ? brokerPort - 1 : brokerPort + 1;
  const orphanAuthenticUrl = makeTestBrokerMarker(
    brokerPort, markerKey, Buffer.alloc(18, 0x11).toString('base64url'),
  );
  const orphanFakeHmacUrl = makeTestBrokerMarker(
    brokerPort, Buffer.alloc(32, 0x5a), Buffer.alloc(18, 0x22).toString('base64url'),
  );
  const orphanOtherPortUrl = makeTestBrokerMarker(
    otherBrokerPort, markerKey, Buffer.alloc(18, 0x33).toString('base64url'),
  );
  const orphanExternalUrl = 'https://example.test/unrelated-attached-page';
  assert.notEqual(orphanFakeHmacUrl, orphanAuthenticUrl);
  fakeCdp.state.targets.set(orphanAuthenticId, {
    targetId: orphanAuthenticId, type: 'page', title: '', url: orphanAuthenticUrl, attached: false,
  });
  fakeCdp.state.targets.set(orphanFakeHmacId, {
    targetId: orphanFakeHmacId, type: 'page', title: '', url: orphanFakeHmacUrl, attached: false,
  });
  fakeCdp.state.targets.set(orphanOtherPortId, {
    targetId: orphanOtherPortId, type: 'page', title: '', url: orphanOtherPortUrl, attached: false,
  });
  fakeCdp.state.targets.set(orphanExternalId, {
    targetId: orphanExternalId, type: 'page', title: '', url: orphanExternalUrl, attached: true,
  });
  const orphanLogStart = fakeCdp.state.commandLog.length;
  const newAfterOrphans = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/after-orphan-sweep')}`, {
    method: 'POST', token, requestId: 'integration-orphan-sweep-new-0001',
  });
  assert.equal(newAfterOrphans.status, 200, newAfterOrphans.text);
  const orphanCommands = fakeCdp.state.commandLog.slice(orphanLogStart);
  const orphanCloseIndex = orphanCommands.findIndex((command) => command.method === 'Target.closeTarget' && command.targetId === orphanAuthenticId);
  const newCreateIndex = orphanCommands.findIndex((command) => command.method === 'Target.createTarget');
  assert.ok(orphanCloseIndex >= 0, 'authentic same-port orphan marker was not closed');
  assert.ok(newCreateIndex > orphanCloseIndex, 'new target was created before authentic orphan cleanup');
  assert.equal(orphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanFakeHmacId), false);
  assert.equal(orphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanOtherPortId), false);
  assert.equal(orphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanExternalId), false);
  assert.equal(fakeCdp.state.targets.has(orphanAuthenticId), false);
  assert.equal(fakeCdp.state.targets.has(orphanFakeHmacId), true);
  assert.equal(fakeCdp.state.targets.has(orphanOtherPortId), true);
  assert.equal(fakeCdp.state.targets.has(orphanExternalId), true);
  const finalizeNewAfterOrphans = await brokerRequest(baseUrl, `/finalize?target=${newAfterOrphans.value.targetId}`, {
    method: 'POST', token, lease: newAfterOrphans.value.leaseToken,
  });
  assert.equal(finalizeNewAfterOrphans.status, 200, finalizeNewAfterOrphans.text);

  const orphanFailureCases = [
    { name: 'false', byte: 0x66, closeBehavior: 'false-no-destroy', attached: false, reason: 'close_not_confirmed' },
    { name: 'error', byte: 0x77, closeBehavior: 'error-no-destroy', attached: false, reason: 'cdp_error' },
    { name: 'attached', byte: 0x88, closeBehavior: null, attached: true, reason: 'externally_attached' },
  ];
  const orphanGuardAcquire = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, requestId: 'integration-orphan-click-guard-acquire-0001',
  });
  assert.equal(orphanGuardAcquire.status, 200, orphanGuardAcquire.text);
  const activeBeforeOrphanFailures = (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages.active;
  for (const scenario of orphanFailureCases) {
    const refreshOrphanGuardLease = await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, {
      token, lease: orphanGuardAcquire.value.leaseToken,
    });
    assert.equal(refreshOrphanGuardLease.status, 200, refreshOrphanGuardLease.text);
    const targetId = `fake-orphan-${scenario.name}-unresolved`;
    const markerUrl = makeTestBrokerMarker(
      brokerPort, markerKey, Buffer.alloc(18, scenario.byte).toString('base64url'),
    );
    fakeCdp.state.targets.set(targetId, {
      targetId, type: 'page', title: '', url: markerUrl, attached: scenario.attached,
    });
    if (scenario.closeBehavior) fakeCdp.state.closeBehaviors.set(targetId, scenario.closeBehavior);
    const createCountBeforeBlockedOrphan = fakeCdp.state.methodCounts.get('Target.createTarget') || 0;
    const closeCountBeforeBlockedOrphan = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
    const blockedPath = `/new?url=${encodeURIComponent(`https://example.test/after-orphan-${scenario.name}`)}`;
    const blockedRequestId = `integration-orphan-${scenario.name}-blocked-0001`;
    const blockedByOrphan = await brokerRequest(baseUrl, blockedPath, {
      method: 'POST', token, requestId: blockedRequestId,
    });
    expectError(blockedByOrphan, 409, 'orphan_marker_unresolved');
    assert.equal(blockedByOrphan.value.error.details.targets[0].reason, scenario.reason);
    assert.equal(fakeCdp.state.methodCounts.get('Target.createTarget') || 0, createCountBeforeBlockedOrphan);
    assert.equal(fakeCdp.state.targets.has(targetId), true);
    assert.deepEqual(
      (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
      { active: activeBeforeOrphanFailures + 1, limit: 5 },
    );
    const listedBlockedOrphan = await brokerRequest(baseUrl, '/targets', { token });
    assert.equal(listedBlockedOrphan.value.targets.find((target) => target.targetId === targetId)?.lease, 'busy');
    if (scenario.attached) {
      assert.equal(fakeCdp.state.methodCounts.get('Target.closeTarget') || 0, closeCountBeforeBlockedOrphan);
    } else {
      assert.ok((fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closeCountBeforeBlockedOrphan);
    }
    if (scenario.closeBehavior) fakeCdp.state.closeBehaviors.set(targetId, scenario.closeBehavior);
    const clickBlockedByOrphan = await brokerRequest(baseUrl, `/click?target=${TARGET_ID}`, {
      method: 'POST', token, lease: orphanGuardAcquire.value.leaseToken, rawBody: 'body',
    });
    expectError(clickBlockedByOrphan, 409, 'orphan_marker_unresolved');
    fakeCdp.removeTargetSilently(targetId);
    const recoveredAfterOrphanGone = await brokerRequest(baseUrl, blockedPath, {
      method: 'POST', token, requestId: blockedRequestId,
    });
    assert.equal(recoveredAfterOrphanGone.status, 200, recoveredAfterOrphanGone.text);
    const finalizedAfterOrphanGone = await brokerRequest(baseUrl, `/finalize?target=${recoveredAfterOrphanGone.value.targetId}`, {
      method: 'POST', token, lease: recoveredAfterOrphanGone.value.leaseToken,
    });
    assert.equal(finalizedAfterOrphanGone.status, 200, finalizedAfterOrphanGone.text);
    assert.deepEqual(
      (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
      { active: activeBeforeOrphanFailures, limit: 5 },
    );
  }
  const releaseOrphanGuard = await brokerRequest(baseUrl, `/release?target=${TARGET_ID}`, {
    method: 'POST', token, lease: orphanGuardAcquire.value.leaseToken,
  });
  assert.equal(releaseOrphanGuard.status, 200, releaseOrphanGuard.text);

  const deliveredBlank = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('about:blank')}`, {
    method: 'POST', token, requestId: 'integration-delivered-about-blank-0001',
  });
  assert.equal(deliveredBlank.status, 200, deliveredBlank.text);
  const deliveredBlankTargetId = deliveredBlank.value.targetId;
  assert.equal(
    fakeCdp.state.targets.get(deliveredBlankTargetId)?.url,
    'about:blank',
    'delivered about:blank target retained its private HMAC creation marker',
  );
  const releaseDeliveredBlank = await brokerRequest(baseUrl, `/release?target=${deliveredBlankTargetId}`, {
    method: 'POST', token, lease: deliveredBlank.value.leaseToken,
  });
  assert.equal(releaseDeliveredBlank.status, 200, releaseDeliveredBlank.text);
  assert.equal(fakeCdp.state.targets.get(deliveredBlankTargetId)?.url, 'about:blank');

  // Page.windowOpen reports one task-originated window attempt but supplies no
  // target id. A broker click holds a bounded event-ordering reservation, while
  // never closing a later no-opener target by URL or timing inference. The
  // reservation must expire so a blocked/cancelled popup cannot ghost a slot.
  const activeBeforeNoOpener = (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages.active;
  const noOpenerSource = await brokerRequest(baseUrl, `/acquire?target=${TARGET_ID}`, {
    method: 'POST', token, requestId: 'integration-noopener-source-acquire-0001',
  });
  assert.equal(noOpenerSource.status, 200, noOpenerSource.text);
  const noOpenerSourceInfo = await brokerRequest(baseUrl, `/info?target=${TARGET_ID}`, {
    token, lease: noOpenerSource.value.leaseToken,
  });
  assert.equal(noOpenerSourceInfo.status, 200, noOpenerSourceInfo.text);

  // With an explicit openerId, target creation consumes the bounded click
  // reservation before becoming a managed derived page, then closes it. This
  // prevents double-counting regardless of Page.windowOpen/targetCreated order.
  const closesBeforeAttributedPopup = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  fakeCdp.armOpenerPopupOnNextRuntime(TARGET_ID);
  const attributedPopupClick = await brokerRequest(baseUrl, `/click?target=${TARGET_ID}`, {
    method: 'POST', token, lease: noOpenerSource.value.leaseToken, rawBody: 'body',
  });
  assert.equal(attributedPopupClick.status, 200, attributedPopupClick.text);
  assert.equal(attributedPopupClick.value.popupUrlStatus, 'captured');
  assert.match(attributedPopupClick.value.popupUrls[0], /^https:\/\/example\.test\/noopener-derived-/u,
    'targetCreated arriving first must not discard the source click destination');
  const attributedPopupTargetId = fakeCdp.state.lastRuntimeNoOpenerTargetId;
  assert.ok(attributedPopupTargetId, 'fake opener-attributed popup was not emitted during the broker click');
  await waitFor(() => !fakeCdp.state.targets.has(attributedPopupTargetId), {
    timeoutMs: 2000, label: 'opener-attributed popup closure during bounded reservation',
  });
  assert.ok(
    (fakeCdp.state.methodCounts.get('Target.closeTarget') || 0) > closesBeforeAttributedPopup,
    'opener-attributed popup was not closed',
  );
  assert.deepEqual(
    (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
    { active: activeBeforeNoOpener + 1, limit: 5 },
  );

  for (const [url, expected, status] of [
    ['https://www.bilibili.com/opus/123456789012345678?token=SECRET#PRIVATE', ['https://www.bilibili.com/opus/123456789012345678'], 'captured'],
    ['https://user:password@example.test/private', [], 'filtered'],
    ['javascript:alert(1)', [], 'filtered'],
  ]) {
    fakeCdp.armOpenerPopupOnNextRuntime(TARGET_ID, { targetFirst: false, url });
    const result = await brokerRequest(baseUrl, `/click?target=${TARGET_ID}`, {
      method: 'POST', token, lease: noOpenerSource.value.leaseToken, rawBody: 'body',
    });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.value.popupUrls, expected);
    assert.equal(result.value.popupUrlStatus, status);
    await waitFor(() => !fakeCdp.state.targets.has(fakeCdp.state.lastRuntimeNoOpenerTargetId), {
      timeoutMs: 2000, label: 'test popup closed without losing sanitized source URL',
    });
  }
  const closesAfterPublicUrlTests = fakeCdp.state.methodCounts.get('Target.closeTarget') || 0;
  fakeCdp.armNoOpenerPopupOnNextRuntime(TARGET_ID);
  const ambiguousPopupClick = await brokerRequest(baseUrl, `/click?target=${TARGET_ID}`, {
    method: 'POST', token, lease: noOpenerSource.value.leaseToken, rawBody: 'body',
  });
  assert.equal(ambiguousPopupClick.status, 200, ambiguousPopupClick.text);
  const ambiguousNoOpenerTargetId = fakeCdp.state.lastRuntimeNoOpenerTargetId;
  assert.ok(ambiguousNoOpenerTargetId, 'fake no-opener popup was not emitted during the broker click');
  assert.equal(
    fakeCdp.state.methodCounts.get('Target.closeTarget') || 0,
    closesAfterPublicUrlTests,
    'Page.windowOpen timing/URL heuristic closed a no-opener target without proof of ownership',
  );
  assert.equal(fakeCdp.state.targets.has(ambiguousNoOpenerTargetId), true, 'ambiguous no-opener page was closed');
  assert.deepEqual(
    (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
    { active: activeBeforeNoOpener + 2, limit: 5 },
  );
  const blockedByNoOpenerReservation = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/blocked-by-noopener-reservation')}`, {
    method: 'POST', token, requestId: 'integration-noopener-reservation-block-0001',
  });
  expectError(blockedByNoOpenerReservation, 409, 'task_page_limit_reached');
  await waitFor(async () => {
    const value = await brokerRequest(baseUrl, '/health', { owner: null });
    return value.value?.taskPages?.active === activeBeforeNoOpener + 1;
  }, { timeoutMs: 2500, label: 'bounded Page.windowOpen reservation expiry' });
  assert.equal(
    fakeCdp.state.targets.has(ambiguousNoOpenerTargetId),
    true,
    'bounded reservation expiry closed an ambiguous no-opener target',
  );
  fakeCdp.removeTargetSilently(ambiguousNoOpenerTargetId);
  const releaseNoOpenerSource = await brokerRequest(baseUrl, `/release?target=${TARGET_ID}`, {
    method: 'POST', token, lease: noOpenerSource.value.leaseToken,
  });
  assert.equal(releaseNoOpenerSource.status, 200, releaseNoOpenerSource.text);
  assert.deepEqual(
    (await brokerRequest(baseUrl, '/health', { owner: null })).value.taskPages,
    { active: activeBeforeNoOpener, limit: 5 },
  );

  const restartOrphanId = 'fake-orphan-after-restart';
  const restartOrphanUrl = makeTestBrokerMarker(
    brokerPort, markerKey, Buffer.alloc(18, 0x55).toString('base64url'),
  );
  fakeCdp.state.targets.set(restartOrphanId, {
    targetId: restartOrphanId, type: 'page', title: '', url: restartOrphanUrl, attached: false,
  });
  const markerKeyBeforeRestart = fs.readFileSync(markerKeyFile, 'utf8').trim();
  const firstBrokerExit = await stopBroker(broker);
  assert.equal(firstBrokerExit?.code, 0, `first broker did not stop cleanly: ${broker.stderr.join('')}`);
  await waitFor(() => !fs.existsSync(tokenFile), { timeoutMs: 2000, label: 'first broker token cleanup' });
  assert.equal(fs.existsSync(markerKeyFile), true, 'persistent marker key was removed on broker shutdown');
  assert.equal(fs.readFileSync(markerKeyFile, 'utf8').trim(), markerKeyBeforeRestart);
  broker = null;

  broker = startBroker({ port: brokerPort, tokenDir, fakeCdpPort: fakeCdp.port });
  const restartToken = await waitFor(() => {
    if (broker.child.exitCode !== null) {
      throw new Error(`restarted broker exited early (${broker.child.exitCode}): ${broker.stderr.join('')}`);
    }
    if (!fs.existsSync(tokenFile)) return null;
    const value = fs.readFileSync(tokenFile, 'utf8').trim();
    return value && value !== token ? value : null;
  }, { timeoutMs: 25000, label: 'restarted broker token rotation' });
  assert.match(restartToken, /^[A-Za-z0-9_-]{40,64}$/u);
  assert.notEqual(restartToken, token);
  assert.equal(fs.readFileSync(markerKeyFile, 'utf8').trim(), markerKeyBeforeRestart, 'marker key rotated across broker restart');
  const restartConnectionWaitStartedAt = Date.now();
  await waitFor(async () => {
    if (broker.child.exitCode !== null) {
      throw new Error(`restarted broker exited (${broker.child.exitCode}): ${broker.stderr.join('')}`);
    }
    const result = await brokerRequest(baseUrl, '/health', { owner: null });
    if (result.status === 200 && result.value?.connection?.state === 'connected') return result;
    throw new Error(`state=${result.value?.connection?.state || 'unknown'} lastError=${result.value?.connection?.lastErrorCode || 'none'} stderr=${JSON.stringify(broker.stderr.join(''))}`);
  }, { timeoutMs: 25000, label: 'restarted broker connection to fake CDP' });
  const restartConnectionReadyMs = Date.now() - restartConnectionWaitStartedAt;
  const restartOrphanLogStart = fakeCdp.state.commandLog.length;
  const newAfterRestart = await brokerRequest(baseUrl, `/new?url=${encodeURIComponent('https://example.test/after-restart-orphan-sweep')}`, {
    method: 'POST', token: restartToken, requestId: 'integration-orphan-restart-new-0001',
  });
  assert.equal(newAfterRestart.status, 200, newAfterRestart.text);
  const restartOrphanCommands = fakeCdp.state.commandLog.slice(restartOrphanLogStart);
  const restartCloseIndex = restartOrphanCommands.findIndex(
    (command) => command.method === 'Target.closeTarget' && command.targetId === restartOrphanId,
  );
  const restartCreateIndex = restartOrphanCommands.findIndex((command) => command.method === 'Target.createTarget');
  assert.ok(restartCloseIndex >= 0, 'restarted broker did not reclaim an authentic orphan with its persisted key');
  assert.ok(restartCreateIndex > restartCloseIndex, 'restarted broker created a target before orphan recovery');
  assert.equal(fakeCdp.state.targets.has(restartOrphanId), false);
  assert.equal(
    restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === deliveredBlankTargetId),
    false,
    'restarted broker orphan sweep closed a delivered ordinary about:blank page',
  );
  assert.equal(fakeCdp.state.targets.get(deliveredBlankTargetId)?.url, 'about:blank');
  assert.equal(
    restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === createResponseRecoveredDeliveredTargetId),
    false,
    'restarted broker orphan sweep closed a delivered page recovered after create response loss',
  );
  assert.equal(fakeCdp.state.targets.get(createResponseRecoveredDeliveredTargetId)?.url, createResponseLostUrl);
  assert.equal(
    restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === lostNavigateRecoveredDeliveredTargetId),
    false,
    'restarted broker orphan sweep closed a delivered page recovered after navigate result loss',
  );
  assert.equal(fakeCdp.state.targets.get(lostNavigateRecoveredDeliveredTargetId)?.url, lostNavigateUrl);
  assert.equal(restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanFakeHmacId), false);
  assert.equal(restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanOtherPortId), false);
  assert.equal(restartOrphanCommands.some((command) => command.method === 'Target.closeTarget' && command.targetId === orphanExternalId), false);
  const finalizeNewAfterRestart = await brokerRequest(baseUrl, `/finalize?target=${newAfterRestart.value.targetId}`, {
    method: 'POST', token: restartToken, lease: newAfterRestart.value.leaseToken,
  });
  assert.equal(finalizeNewAfterRestart.status, 200, finalizeNewAfterRestart.text);

  if (deferredRegressionError) throw deferredRegressionError;

  const exit = await stopBroker(broker);
  assert.equal(exit?.code, 0, `broker did not stop cleanly: ${broker.stderr.join('')}`);
  await waitFor(() => !fs.existsSync(tokenFile), { timeoutMs: 2000, label: 'token cleanup after broker exit' });
  broker = null;

  console.log(`cdp-proxy integration self-test: auth, five-slot broker admission, popup-click reservation with reverse-order opener transfer and bounded no-opener recovery, delayed-discovery containment, pre-lease/reconnect child baselines, derived/orphan fail-closed cleanup, managed-page capability, stale-slot cleanup, queue, fixed research DOM snapshots (full long bodies, isolated world, recursive public URL sanitation, recipe/lease/injection rejection, unchanged CDP allowlist), idempotency, new-loss recovery/concurrency, attach abort (${attachAbortCloseDelayMs}ms socket retirement), side-effect destruction, authenticated orphan cleanup/restart (${restartConnectionReadyMs}ms post-token reconnect), delivered-page preservation, profile singleton, marker-key ACL (${markerKeyReadyMs}ms post-token wait), target lifecycle, malformed HTTP, detach recovery, and lease-expiry checks passed`);
} catch (error) {
  if (broker) console.error('Fixture broker diagnostic:', {exitCode:broker.child.exitCode,stderr:broker.stderr.join('').slice(0,2000)});
  throw error;
} finally {
  if (broker) await stopBroker(broker).catch(() => {});
  if (fakeCdp) await fakeCdp.close().catch(() => {});
  removeTestTempRoot(tempRoot);
}
