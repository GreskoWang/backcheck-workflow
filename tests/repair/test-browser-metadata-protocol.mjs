#!/usr/bin/env node
// U07 two-owner HTTP regression using an isolated production broker and fake CDP.
// Node built-ins only. Never discovers or connects to a real browser.
// The WebSocket/CDP fixture is derived from the existing integration fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {waitForStage,makeTimeline} from './protocol-startup-diagnostics.mjs';
const timeline=makeTimeline();
function option(name) {const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}
const root=option('--repo');
if(!root){console.error('Usage: node test-browser-metadata-protocol.mjs --repo PATH [--out result.json]');process.exit(2);}
const SCRIPT_DIR=path.resolve(root,'skills/web-access/scripts');
const BROKER_PATH=path.join(SCRIPT_DIR,'cdp-proxy.mjs');
const {windowsSystemPath}=await import(pathToFileURL(path.join(SCRIPT_DIR,'windows-paths.mjs')));
const OWNER='recovery-test:fake-cdp',TARGET_ID='fake-page-1',TARGET_URL='https://example.test/public-page';
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

async function waitFor(check,options={}) { return await waitForStage(check,{...options,timeline}); }

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
    if (state.u07MetadataBehavior && state.u07MetadataBehavior.method === message.method
        && (!state.u07MetadataBehavior.targetId || state.u07MetadataBehavior.targetId === message.params?.targetId)) {
      const behavior=state.u07MetadataBehavior;state.u07MetadataBehavior=null;
      state.u07MetadataObserved={method:message.method,id:message.id,connectionId:socketState?.id};
      await sleep(behavior.delayMs);
      if(socket.destroyed)return;
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
        if (Object.hasOwn(state, 'nextRuntimeResponse')) {
          const response = state.nextRuntimeResponse; delete state.nextRuntimeResponse; sendResult(response); return;
        }
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


function startBroker({port,tokenDir,fakeCdpPort}) {
  const stdout=[],stderr=[];
  const childEnv={...process.env};
  for(const key of Object.keys(childEnv)) {
    if(/^(CDP_|FEISHU_|LARK_)/iu.test(key)||/^(http_proxy|https_proxy|all_proxy)$/iu.test(key))delete childEnv[key];
  }
  Object.assign(childEnv,{CDP_PROXY_PORT:String(port),CDP_PROXY_TOKEN_DIR:tokenDir,
    CDP_BROWSER_WS_URL:`ws://127.0.0.1:${fakeCdpPort}/devtools/browser/fake-integration-test`,
    NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1'});
  const preload="process.on('message',(message)=>{if(message==='cdp-broker-selftest:shutdown')process.emit('SIGTERM')})";
  const preloadUrl=`data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`;
  const child=spawn(process.execPath,[`--import=${preloadUrl}`,BROKER_PATH],{
    cwd:SCRIPT_DIR,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
  child.on('error',error=>stderr.push(`Spawn error: ${error.message}`));
  const exit=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',error=>resolve({error:error.message}));});
  return {child,stdout,stderr,exit};
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

async function brokerRequest(baseUrl, pathname, { method = 'GET', token, owner = OWNER, lease, manage, requestId, json, rawBody, signal } = {}) {
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
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body, signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000) });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { status: response.status, value, text };
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

const cases=[],TARGET_B='fake-page-B',TARGET_C='fake-page-C',OWNER_B='u07-owner-B';
let fake,broker,tempRoot,baseUrl,token,leaseA,leaseB,leaseC;
const request=(route,options={})=>brokerRequest(baseUrl,route,{token,...options});
async function test(name,fn){const at=Date.now();try{const details=await fn();cases.push({name,passed:true,elapsedMs:Date.now()-at,details});}catch(e){cases.push({name,passed:false,elapsedMs:Date.now()-at,error:e.message,code:e.code||null});}}
const count=method=>fake.state.methodCounts.get(method)||0;
async function acquire(target,owner,key){const r=await request(`/acquire?target=${target}`,{method:'POST',owner,requestId:key});assert.equal(r.status,200,r.text);return r.value.leaseToken;}
try{
  tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'codex-edge-broker-integration-u07-'));
  fake=await startFakeCdp();
  for(const target of [TARGET_B,TARGET_C])fake.state.targets.set(target,{targetId:target,type:'page',title:target,url:`https://example.test/${target}`,attached:false});
  const port=await reservePort(),tokenDir=path.join(tempRoot,'tokens');
  broker=startBroker({port,tokenDir,fakeCdpPort:fake.port});baseUrl=`http://127.0.0.1:${port}`;
  await waitFor(()=>{
    if(broker.child.exitCode!==null){const e=new Error('broker exited before secure startup');e.fatal=true;throw e;}
    const p=path.join(tokenDir,`${port}.token`);
    if(fs.existsSync(p)&&broker.stdout.join('').includes('[Edge CDP Broker] listening')){token=fs.readFileSync(p,'utf8').trim();return true;}
  },{timeoutMs:45000,label:'secure_broker_startup'});
  await waitFor(async({signal})=>(await request('/health',{owner:null,signal})).value?.connection?.state==='connected',{timeoutMs:8000,label:'one_fake_cdp_connection'});
  leaseA=await acquire(TARGET_ID,OWNER,'u07-acquire-A-stable-key');
  leaseB=await acquire(TARGET_B,OWNER_B,'u07-acquire-B-stable-key');
  leaseC=await acquire(TARGET_C,OWNER,'u07-acquire-C-stable-key');
  const warm=await request(`/info?target=${TARGET_B}`,{owner:OWNER_B,lease:leaseB});assert.equal(warm.status,200,warm.text);
  const bSession=[...fake.state.sessions.entries()].find(([,s])=>s.targetId===TARGET_B)?.[0];assert.ok(bSession);
  for(const method of ['Target.getTargetInfo','Target.getTargets'])await test(`${method}_timeout_preserves_other_owner_inflight_read_and_connection`,async()=>{
    fake.state.u07MetadataObserved=null;fake.state.u07MetadataBehavior={method,...(method==='Target.getTargetInfo'?{targetId:TARGET_ID}:{}),delayMs:2800};
    const beforeProbe=count('Browser.getVersion'),beforeMetadata=count(method),beforeConnections=fake.state.connectionCount;
    const failing=request(method==='Target.getTargetInfo'?`/info?target=${TARGET_ID}`:'/targets',{owner:OWNER,lease:leaseA});
    await waitFor(()=>fake.state.u07MetadataObserved,{timeoutMs:1500,label:`${method}_sent`});
    fake.state.delayRuntimeOnce=2400;
    const ongoing=request(`/info?target=${TARGET_B}`,{owner:OWNER_B,lease:leaseB});
    const [a,b]=await Promise.all([failing,ongoing]);
    assert.equal(a.status,504,a.text);assert.equal(a.value.error.code,'cdp_timeout');assert.equal(a.value.error.details.method,method);
    assert.equal(b.status,200,b.text);assert.equal(b.value.page.url,`https://example.test/${TARGET_B}`);
    await waitFor(async({signal})=>(await request('/health',{owner:null,signal})).value?.connection?.lastCommandTimeout?.connectionHealthCheck?.status==='healthy',{timeoutMs:2000,label:'bounded_metadata_health_probe'});
    assert.equal(fake.state.connectionCount,beforeConnections,'metadata delay reconnected the shared transport');
    assert.equal(fake.state.sessions.has(bSession),true,'other owner session was discarded');assert.equal(count('Browser.getVersion')-beforeProbe,1);
    // The delayed metadata reply is allowed to arrive after its waiter expired.
    await sleep(450);
    const next=await request(`/info?target=${TARGET_B}`,{owner:OWNER_B,lease:leaseB});assert.equal(next.status,200,next.text);assert.equal(next.value.page.url,`https://example.test/${TARGET_B}`);
    return {failedRequestHttp:a.status,otherOwnerHttp:b.status,lateResponseFollowupHttp:next.status,healthProbes:1,connectionsBefore:beforeConnections,connectionsAfter:fake.state.connectionCount,metadataCallsSinceStart:count(method)-beforeMetadata,otherOwnerSessionRetained:true};
  });
  await test('unknown_attach_still_retires_shared_generation',async()=>{
    fake.state.attachBehaviors.set(TARGET_C,'stall');const beforeAttach=count('Target.attachToTarget'),beforeConnections=fake.state.connectionCount,beforeProbe=count('Browser.getVersion');
    const failed=request(`/info?target=${TARGET_C}`,{owner:OWNER,lease:leaseC});
    await waitFor(()=>count('Target.attachToTarget')>beforeAttach,{timeoutMs:1500,label:'unknown_attach_sent'});
    fake.state.delayRuntimeOnce=2400;const b=request(`/info?target=${TARGET_B}`,{owner:OWNER_B,lease:leaseB});
    const [a,other]=await Promise.all([failed,b]);assert.equal(a.status,504,a.text);assert.equal(a.value.error.details.method,'Target.attachToTarget');
    assert.equal(other.status,502,other.text);assert.equal(other.value.error.code,'unresponsive_connection');
    const health=await request('/health',{owner:null});assert.equal(health.value.connection.state,'disconnected');assert.equal(health.value.connection.lastCommandTimeout.connectionRetired,true);
    assert.equal(count('Browser.getVersion'),beforeProbe,'attach must not enter readonly health-probe policy');assert.equal(fake.state.connectionCount,beforeConnections,'failure itself must not reconnect');
    return {attachHttp:a.status,otherOwnerHttp:other.status,retired:true,automaticReconnects:0};
  });
}catch(e){cases.push({name:'fixture_startup_or_execution',passed:false,error:e.message,code:e.code||null});}
finally{
  try{await stopBroker(broker);}catch(e){cases.push({name:'broker_cleanup',passed:false,error:e.message});}
  try{await fake?.close();}catch(e){cases.push({name:'fake_cleanup',passed:false,error:e.message});}
  try{if(tempRoot)removeTestTempRoot(tempRoot);}catch(e){cases.push({name:'temporary_files_cleanup',passed:false,error:e.message});}
}
const report={suite:'U07 real broker HTTP with two synthetic owners and fake CDP',runtime:process.version,platform:process.platform,
  sourceSha256:createHash('sha256').update(fs.readFileSync(BROKER_PATH)).digest('hex'),liveBrowserUsed:false,externalAccountsUsed:false,loopbackUsed:true,
  automaticRetries:0,passed:cases.filter(x=>x.passed).length,total:cases.length,allPassed:cases.every(x=>x.passed),cases,timeline:timeline.value,
  diagnostic:{brokerExitCode:broker?.child.exitCode??null,brokerSignalCode:broker?.child.signalCode??null,fakeConnections:fake?.state.connectionCount??0,brokerStdout:broker?.stdout.join('').slice(-4000)||'',brokerStderr:broker?.stderr.join('').slice(-4000)||''}};
if(option('--out')){const out=path.resolve(option('--out'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));if(!report.allPassed)process.exitCode=1;

