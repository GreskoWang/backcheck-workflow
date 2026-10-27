#!/usr/bin/env node
// Offline black-box regression, derived from the repository integration fixture.
// Starts ONLY a fake CDP service and an isolated broker on random loopback ports.
// Its environment points CDP_BROWSER_WS_URL at that fake service; no real browser is discovered.
// Requires Node 24, and local-listener permission. Temporary files are removed.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorRecord, makeTimeline, observeChild, settleWithin, waitForStage } from './protocol-startup-diagnostics.mjs';

function option(name) { const i=process.argv.indexOf(name); return i<0?null:process.argv[i+1]; }
const repoRoot=option('--repo');
if (!repoRoot) { console.error('Usage: node test-dom-abort-protocol.mjs --repo PATH [--out result.json]'); process.exit(2); }
const SCRIPT_DIR = path.resolve(repoRoot,'skills/web-access/scripts');
const {windowsSystemPath}=await import(pathToFileURL(path.join(SCRIPT_DIR,'windows-paths.mjs')));
const {default:LoopbackWebSocket}=await import(pathToFileURL(path.join(SCRIPT_DIR,'loopback-websocket.mjs')));
const {assertCdpMethodAllowed}=await import(pathToFileURL(path.join(SCRIPT_DIR,'cdp-proxy.mjs')));
const BROKER_PATH = path.join(SCRIPT_DIR, 'cdp-proxy.mjs');
const OWNER = 'integration-test:fake-cdp';
const TARGET_ID = 'fake-page-1';
const TARGET_URL = 'https://example.test/public-page';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const timeline = makeTimeline();
const HARNESS_BUDGETS = Object.freeze({
  tokenMs: 30000, connectedMs: 8000, runtimeObservedMs: 1000,
  handshakeMs: 1500, brokerRequestMs: 6000, shutdownMs: 5000,
  // New client caps make the existing stage deadlines effective. They do not
  // add time or restart the broker. Health polling is read-only.
  healthRequestMs: 1000, protocolHttpRequestMs: 7000,
  forcedExitMs: 2000, pipeDrainMs: 1000,
});
let brokerSpawnCount = 0;

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

async function waitFor(check, options = {}) {
  return await waitForStage(check, { ...options, timeline });
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
    tcpConnectionCount: 0,
    upgradeRequestCount: 0,
    rejectedUpgradeCount: 0,
    fixtureErrors: [],
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
  server.on('connection', () => {
    state.tcpConnectionCount += 1;
    timeline.mark('fake_cdp_tcp_connection', { count: state.tcpConnectionCount });
  });
  server.on('error', (error) => {
    state.fixtureErrors.push(errorRecord(error));
    timeline.mark('fake_cdp_server_error', { error: errorRecord(error) });
  });

  const replyFor = async (socket, message) => {
    const count = state.methodCounts.get(message.method) || 0;
    state.methodCounts.set(message.method, count + 1);
    const socketState = state.socketStates.get(socket);
    state.commandLog.push({
      at: new Date().toISOString(),
      elapsedMs: timeline.elapsed(),
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
    state.upgradeRequestCount += 1;
    if (request.url !== '/devtools/browser/fake-integration-test') {
      state.rejectedUpgradeCount += 1;
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      state.rejectedUpgradeCount += 1;
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
    timeline.mark('fake_cdp_websocket_upgrade', { connectionId: state.connectionCount });
    state.socketStates.set(socket, { id: state.connectionCount, discoveryEnabled: false });
    const frameState = { socket, buffer: Buffer.from(head), fragmentOpcode: null, fragments: [] };
    const onText = (text) => {
      let message;
      try { message = JSON.parse(text); } catch { socket.destroy(); return; }
      void replyFor(socket, message).catch((error) => {
        state.fixtureErrors.push(errorRecord(error));
        timeline.mark('fake_cdp_reply_error', { error: errorRecord(error) });
        socket.destroy();
      });
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
  timeline.mark('fake_cdp_bound', { address });
  return {
    port: address.port,
    state,
    snapshot() {
      return { boundAddress: address, listening: server.listening,
        tcpConnectionCount: state.tcpConnectionCount,
        upgradeRequestCount: state.upgradeRequestCount,
        rejectedUpgradeCount: state.rejectedUpgradeCount,
        websocketConnectionCount: state.connectionCount,
        openWebsocketConnections: sockets.size,
        closedConnectionIds: [...state.closedConnectionIds],
        methodCounts: Object.fromEntries(state.methodCounts),
        commandLog: state.commandLog.slice(-40), fixtureErrors: state.fixtureErrors.slice(-10) };
    },
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
  brokerSpawnCount += 1;
  const sourceSha256AtSpawn = createHash('sha256').update(fs.readFileSync(BROKER_PATH)).digest('hex');
  timeline.mark('broker_spawn_requested', { attempt: brokerSpawnCount, requestedPort: port, fakeCdpPort });
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
      CDP_HANDSHAKE_TIMEOUT_MS: String(HARNESS_BUDGETS.handshakeMs),
      CDP_REQUEST_TIMEOUT_MS: String(HARNESS_BUDGETS.brokerRequestMs),
      CDP_LEASE_TTL_MS: String(leaseTtlMs),
      CDP_IDEMPOTENCY_TTL_MS: String(leaseTtlMs),
    },
    stdio: shutdownIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const observed = observeChild(child, timeline);
  observed.sourceSha256AtSpawn = sourceSha256AtSpawn;
  return observed;
}

async function stopBroker(processState) {
  if (!processState) return null;
  if (!processState.spawnError && processState.child.exitCode === null && processState.child.signalCode === null) {
    timeline.mark('broker_shutdown_requested');
    if (typeof processState.child.send === 'function' && processState.child.connected) {
      processState.child.send('cdp-broker-selftest:shutdown');
    } else processState.child.kill('SIGTERM');
    const graceful = await settleWithin(processState.exit, HARNESS_BUDGETS.shutdownMs);
    if (!graceful.settled) {
      timeline.mark('broker_force_kill');
      processState.child.kill('SIGKILL');
      const forced = await settleWithin(processState.exit, HARNESS_BUDGETS.forcedExitMs);
      if (!forced.settled) throw new Error('Broker child exit was not observed after SIGKILL');
    }
  }
  const drained = await settleWithin(processState.close, HARNESS_BUDGETS.pipeDrainMs);
  if (!drained.settled) throw new Error('Broker exited but stdout/stderr close was not observed within the pipe-drain budget');
  return processState.exitStatus;
}

async function brokerRequest(baseUrl, pathname, { method = 'GET', token, owner = OWNER, lease, manage, requestId, json, rawBody, signal, timeoutMs = HARNESS_BUDGETS.protocolHttpRequestMs } = {}) {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Harness HTTP deadline exceeded after ${timeoutMs}ms: ${pathname}`)), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method, headers, body, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    const text = await response.text();
    let value = null;
    try { value = JSON.parse(text); } catch {}
    return { status: response.status, value, text };
  } finally { clearTimeout(timer); }
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


const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edge-broker-integration-dom-abort-'));
let fake = null, broker = null, brokerPort = null, tokenObserved = false;
let phase = 'fake_cdp_start', result = null, failure = null, failureSnapshot = null;
let lastHealth = null, pendingAbortController = null;
const healthTransitions = [];
const cleanupErrors = [];
const startupFault = option('--startup-fixture-fault');
function snapshot() {
  return { phase, tokenObserved, brokerRequestedAddress: brokerPort ? { address: '127.0.0.1', port: brokerPort } : null,
    brokerSpawnCount, lastHealth, healthTransitions: [...healthTransitions],
    child: broker?.snapshot() || null, fakeCdp: fake?.snapshot() || null };
}
function classifyFailure() {
  if (broker?.childError || broker?.exitStatus) return 'broker_child_failed_or_exited';
  if (!tokenObserved) return 'broker_token_not_observed';
  if (!broker?.listeningObserved) return 'secure_startup_not_observed_complete';
  if (!fake?.state?.connectionCount) return 'fake_cdp_websocket_not_observed';
  if (lastHealth?.connection?.lastErrorCode) return 'broker_connection_error_reported';
  if (phase === 'broker_connected') return 'connected_not_observed_before_deadline';
  return 'protocol_assertion_or_request_failed';
}
try {
  assert.ok(!startupFault || startupFault === 'wrong-browser-identity', 'Unknown test-only --startup-fixture-fault');
  timeline.mark('fixture_start', { node: process.version, platform: process.platform, startupFault });
  fake = await startFakeCdp(startupFault ? { browserVersion: { product: 'Chrome/152.0.0.0', userAgent: 'Synthetic non-Edge fixture' } } : {});
  phase = 'broker_port_reservation';
  const port = await reservePort();
  brokerPort = port;
  timeline.mark('broker_port_reserved_then_released', { address: '127.0.0.1', port });
  const tokenDir = path.join(tempRoot, 'tokens');
  broker = startBroker({port,tokenDir,fakeCdpPort:fake.port});
  const baseUrl = `http://127.0.0.1:${port}`;
  phase = 'broker_token';
  const token = await waitFor(()=>{
    broker.assertAlive();
    const f=path.join(tokenDir,`${port}.token`);
    return fs.existsSync(f) && fs.readFileSync(f,'utf8').trim();
  },{timeoutMs:HARNESS_BUDGETS.tokenMs,label:phase});
  tokenObserved = true;
  timeline.mark('broker_token_observed'); // Token contents must never enter diagnostics.
  // Token rename precedes final Windows ACL verification and marker-key setup.
  // Observe secure startup separately before beginning the unchanged connection budget.
  phase = 'broker_secure_startup';
  await waitFor(() => { broker.assertAlive(); return broker.snapshot().listeningObserved; },
    {timeoutMs:HARNESS_BUDGETS.tokenMs,label:phase});
  timeline.mark('broker_secure_startup_observed');
  phase = 'broker_connected';
  await waitFor(async({signal,remainingMs})=> {
    broker.assertAlive();
    const health = await brokerRequest(baseUrl,'/health',{
      owner:null,signal,timeoutMs:Math.max(1,Math.min(HARNESS_BUDGETS.healthRequestMs,remainingMs)),
    });
    lastHealth = { at:new Date().toISOString(), elapsedMs:timeline.elapsed(), status:health.status,
      service:health.value?.service || null, connection:health.value?.connection || null };
    const signature = JSON.stringify([lastHealth.status,lastHealth.service,lastHealth.connection]);
    if (healthTransitions.at(-1)?.signature !== signature) {
      healthTransitions.push({...lastHealth,signature});
      timeline.mark('health_state', {status:lastHealth.status,connection:lastHealth.connection});
    }
    return health.value?.connection?.state==='connected';
  },{timeoutMs:HARNESS_BUDGETS.connectedMs,label:phase});
  timeline.mark('broker_connected_observed');
  phase = 'acquire_target';
  timeline.mark('protocol_request', {phase,timeoutMs:HARNESS_BUDGETS.protocolHttpRequestMs});
  const acquired=await brokerRequest(baseUrl,`/acquire?target=${TARGET_ID}`,{method:'POST',token,requestId:'dom-cancel-repro-request-0001'});
  assert.equal(acquired.status,200,acquired.text);
  timeline.mark('protocol_response', {phase,status:acquired.status});
  const lease=acquired.value.leaseToken;
  phase = 'warm_read';
  timeline.mark('protocol_request', {phase,timeoutMs:HARNESS_BUDGETS.protocolHttpRequestMs});
  const warm=await brokerRequest(baseUrl,`/info?target=${TARGET_ID}`,{token,lease});
  assert.equal(warm.status,200,warm.text);
  timeline.mark('protocol_response', {phase,status:warm.status});
  fake.state.delayRuntimeOnce=2000;
  const before=fake.state.methodCounts.get('Runtime.callFunctionOn') || 0;
  const ctl=new AbortController();
  pendingAbortController = ctl;
  const original=fetch(`${baseUrl}/info?target=${TARGET_ID}`,{headers:{Authorization:`Bearer ${token}`,'X-CDP-Owner':OWNER,'X-CDP-Lease':lease},signal:ctl.signal}).then(r=>r.text()).catch(e=>e.name);
  phase = 'delayed_runtime_observed';
  await waitFor(()=>{
    broker.assertAlive();
    return (fake.state.methodCounts.get('Runtime.callFunctionOn')||0)>before;
  },{timeoutMs:HARNESS_BUDGETS.runtimeObservedMs,label:phase});
  const firstSentAt=Date.now();
  timeline.mark('delayed_runtime_received_by_fake');
  phase = 'cancel_inflight_read';
  ctl.abort();
  const originalOutcome=await original;
  timeline.mark('read_cancelled', {originalOutcome});
  await sleep(80);
  phase = 'read_quarantined_target';
  timeline.mark('protocol_request', {phase,timeoutMs:HARNESS_BUDGETS.protocolHttpRequestMs});
  const after=await brokerRequest(baseUrl,`/info?target=${TARGET_ID}`,{token,lease});
  timeline.mark('protocol_response', {phase,status:after.status,code:after.value?.error?.code || null});
  const elapsed=Date.now()-firstSentAt;
  const detachCalls=fake.state.methodCounts.get('Target.detachFromTarget')||0;
  result={
    fixture:'production broker HTTP against fake CDP, no real browser',
    repairKitBaseCommit:'3256f4e94e19d30df4ca414df8136511c5038475',
    originalOutcome,
    firstRemoteResponseDelayMs:2000,
    subsequentReadHttpStatus:after.status,
    subsequentReadCode:after.value?.error?.code||null,
    secondReadCompletedBeforeFirstRemoteResponse:elapsed<2000,
    elapsedFromFirstRuntimeSendMs:elapsed,
    detachCalls,
    defectReproduced:after.status===200 && elapsed<2000 && detachCalls===0,
    passed:after.status===409 && after.value?.error?.code==='target_quarantined' && detachCalls===1,
  };
  phase = 'assert_quarantine';
  assert.equal(result.passed,true,'Cancelled DOM read must quarantine its target and detach its session');
  await sleep(Math.max(0,2100-elapsed));
  phase = 'protocol_complete';
  timeline.mark('protocol_complete');
} catch (error) {
  failure = errorRecord(error);
  failure.classification = classifyFailure();
  failureSnapshot = snapshot(); // Preserve BEFORE cleanup changes child/fake state.
  timeline.mark('first_failure', {phase,error:failure});
  process.exitCode = 1;
} finally {
  pendingAbortController?.abort();
  timeline.mark('cleanup_started');
  await stopBroker(broker).catch((error)=>cleanupErrors.push({step:'stop_broker',error:errorRecord(error)}));
  await fake?.close().catch((error)=>cleanupErrors.push({step:'close_fake',error:errorRecord(error)}));
  try { removeTestTempRoot(tempRoot); } catch (error) { cleanupErrors.push({step:'remove_temp',error:errorRecord(error)}); }
  timeline.mark('cleanup_finished', {errors:cleanupErrors.length});
  if (cleanupErrors.length) process.exitCode = 1;
  const sourceSha256AtEnd = createHash('sha256').update(fs.readFileSync(BROKER_PATH)).digest('hex');
  const sourceChangedDuringRun = Boolean(broker?.sourceSha256AtSpawn && broker.sourceSha256AtSpawn !== sourceSha256AtEnd);
  if (sourceChangedDuringRun) process.exitCode = 1;
  result = { ...(result || {fixture:'production broker HTTP against fake CDP, no real browser',passed:false}),
    passed: Boolean(result?.passed && !failure && !cleanupErrors.length && !sourceChangedDuringRun),
    diagnostics: {
      schemaVersion:1, node:process.version, platform:process.platform, architecture:process.arch,
      repo:path.resolve(repoRoot), sourceSha256AtSpawn:broker?.sourceSha256AtSpawn || null,
      sourceSha256AtEnd, sourceChangedDuringRun,
      startupFault:startupFault || null, automaticRetries:0, brokerSpawnCount,
      budgets:HARNESS_BUDGETS, failure, firstFailureSnapshot:failureSnapshot,
      finalSnapshot:snapshot(), cleanupErrors, ...timeline.value, elapsedMs:timeline.elapsed(),
    },
  };
  const serialized = JSON.stringify(result,null,2)+'\n';
  if(option('--out')) {
    const output = path.resolve(option('--out'));
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,serialized);
  }
  console.log(serialized.trimEnd());
  if(failure) console.error(failure.stack || failure.message);
}
