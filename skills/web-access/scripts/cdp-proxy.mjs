#!/usr/bin/env node
// Stable local broker for a visible, persistent Microsoft Edge session.
// It connects through Edge's DevToolsActivePort and deliberately avoids the
// ChatGPT browser extension's chrome.debugger lifecycle.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { windowsSystemPath } from './windows-paths.mjs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { URL } from 'node:url';
import LoopbackWebSocket from './loopback-websocket.mjs';
import { createFixedWorldResolver } from './fixed-world.mjs';
import { validateFrameSelector, wrapVisibleFrame } from './cdp-visible-frame.mjs';
import { assertResearchRecipe } from './research-dom-recipes.mjs';
import { getFixedResearchReadFunction } from './research-recipe-loader.mjs';

const HOST = '127.0.0.1';
const PORT = positiveInteger(process.env.CDP_PROXY_PORT, 3456);
const HANDSHAKE_TIMEOUT_MS = positiveInteger(process.env.CDP_HANDSHAKE_TIMEOUT_MS, 30000);
const BODY_LIMIT_BYTES = positiveInteger(process.env.CDP_BODY_LIMIT_BYTES, 1024 * 1024);
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.CDP_REQUEST_TIMEOUT_MS, 18000);
const DISCOVERY_JSON_LIMIT_BYTES = 64 * 1024;
const LEASE_TTL_MS = positiveInteger(process.env.CDP_LEASE_TTL_MS, 6 * 60 * 60 * 1000);
const IDEMPOTENCY_TTL_MS = Math.max(
  LEASE_TTL_MS,
  positiveInteger(process.env.CDP_IDEMPOTENCY_TTL_MS, 6 * 60 * 60 * 1000),
);
const MAX_ACTIVE_TASK_PAGES = process.env.CDP_MAX_ACTIVE_TASK_PAGES === 'unlimited' ? Number.MAX_SAFE_INTEGER : positiveInteger(process.env.CDP_MAX_ACTIVE_TASK_PAGES, 5);
const SERVICE_NAME = 'edge-cdp-broker-v2';
const TOKEN_DIR = process.env.CDP_PROXY_TOKEN_DIR
  ? path.resolve(process.env.CDP_PROXY_TOKEN_DIR)
  : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy');
const TOKEN_FILE = path.join(TOKEN_DIR, `${PORT}.token`);
const MARKER_KEY_FILE = path.join(TOKEN_DIR, `${PORT}.marker-key`);

const BUDGETS = Object.freeze({ metadata: 2000, context: 5000, read: 15000, dom: 5000, navigation: 15000, screenshot: 15000 });
const ALLOWED_CDP_METHODS = new Set([
  'Input.dispatchMouseEvent',
  'Browser.getVersion',
  'Page.captureScreenshot',
  'Page.bringToFront',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.navigate',
  'Runtime.callFunctionOn',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Target.detachFromTarget',
  'Target.getTargetInfo',
  'Target.getTargets',
  'Target.setDiscoverTargets',
]);
const DOM_QUERY_FIELDS = new Set(['tag', 'text', 'href', 'src', 'poster', 'title', 'ariaLabel', 'alt', 'role', 'dateTime', 'lang', 'rel', 'target', 'type']);

class BrokerError extends Error {
  constructor(code, message, details = undefined, status = 500) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isOpen = (socket) => Boolean(socket && socket.readyState === 1);

function socketOn(socket, event, handler) {
  if (typeof socket.on === 'function') socket.on(event, handler);
  else socket.addEventListener(event, handler);
}

function socketOff(socket, event, handler) {
  if (typeof socket.off === 'function') socket.off(event, handler);
  else socket.removeEventListener(event, handler);
}

function normalizeWsData(eventOrData) {
  const value = eventOrData?.data ?? eventOrData;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return String(value);
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function validateBrowserWsUrl(rawUrl, expectedPort = null) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw new BrokerError('invalid_browser_endpoint', '浏览器调试端点不是有效 URL。');
  }
  if (parsed.protocol !== 'ws:' || !isLoopbackHost(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BrokerError('unsafe_browser_endpoint', '只允许连接本机 loopback 的 ws:// Edge 调试端点。');
  }
  const port = Number(parsed.port || 80);
  if (expectedPort !== null && port !== expectedPort) throw new BrokerError('unsafe_browser_endpoint', 'Edge WebSocket 端口与已验证的 HTTP 端口不一致。');
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(parsed.pathname)) throw new BrokerError('unsafe_browser_endpoint', 'Edge WebSocket 路径不符合 browser endpoint 规范。');
  return `ws://${HOST}:${port}${parsed.pathname}`;
}

function checkTcpPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function httpJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    let responseRef = null;
    let request = null;
    const finish = (value, destroy = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (destroy) {
        try { responseRef?.destroy(); } catch {}
        try { request?.destroy(); } catch {}
      }
      resolve(value);
    };
    const absoluteTimer = setTimeout(() => finish(null, true), timeoutMs);
    request = http.get(url, (response) => {
      responseRef = response;
      const declaredLength = Number.parseInt(String(response.headers['content-length'] || ''), 10);
      if (Number.isFinite(declaredLength) && declaredLength > DISCOVERY_JSON_LIMIT_BYTES) { finish(null, true); return; }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > DISCOVERY_JSON_LIMIT_BYTES) { finish(null, true); return; }
        chunks.push(value);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { finish(null); return; }
        try { finish(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))); } catch { finish(null); }
      });
      response.once('aborted', () => finish(null, true));
      response.once('error', () => finish(null, true));
    });
    request.on('error', () => finish(null));
  });
}

function edgeActivePortFiles() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const home = os.homedir();
  if (os.platform() === 'win32') {
    return [
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'DevToolsActivePort'),
      path.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data', 'DevToolsActivePort'),
      path.join(localAppData, 'Microsoft', 'Edge Dev', 'User Data', 'DevToolsActivePort'),
      path.join(localAppData, 'Microsoft', 'Edge SxS', 'User Data', 'DevToolsActivePort'),
    ];
  }
  if (os.platform() === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'DevToolsActivePort'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge Beta', 'DevToolsActivePort'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge Dev', 'DevToolsActivePort'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge Canary', 'DevToolsActivePort'),
    ];
  }
  if (os.platform() === 'linux') {
    return [
      path.join(home, '.config', 'microsoft-edge', 'DevToolsActivePort'),
      path.join(home, '.config', 'microsoft-edge-beta', 'DevToolsActivePort'),
      path.join(home, '.config', 'microsoft-edge-dev', 'DevToolsActivePort'),
    ];
  }
  return [];
}

function edgeVersionMetadata(value) {
  const identity = `${value?.Browser || ''} ${value?.['User-Agent'] || ''}`;
  return !/Headless/iu.test(identity) && /(?:^|\s)(?:Edg|Microsoft Edge)\/[0-9]/iu.test(identity);
}

function edgeCdpVersion(value) {
  const identity = `${value?.product || ''} ${value?.userAgent || ''}`;
  return !/Headless/iu.test(identity) && /(?:^|\s)(?:Edg|Microsoft Edge)\/[0-9]/iu.test(identity);
}

async function discoverEdgeEndpoints(deadline = null) {
  if (process.env.CDP_BROWSER_WS_URL) {
    return [{ wsUrl: validateBrowserWsUrl(process.env.CDP_BROWSER_WS_URL), source: 'environment', port: Number(new URL(process.env.CDP_BROWSER_WS_URL).port || 80) }];
  }
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (seen.has(candidate.wsUrl)) return;
    seen.add(candidate.wsUrl);
    candidates.push(candidate);
  };
  for (const filePath of edgeActivePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      const wsPath = lines[1];
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !wsPath) continue;
      if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(wsPath)) continue;
      if (!await checkTcpPort(port, Math.min(300, deadline?.remaining('Edge endpoint discovery') ?? 300))) continue;
      add({ wsUrl: validateBrowserWsUrl(`ws://${HOST}:${port}${wsPath}`, port), source: filePath, port });
    } catch (error) {
      if (error?.code === 'request_timeout' || deadline?.signal?.aborted) throw error;
    }
  }
  for (const port of [9222, 9223, 9333]) {
    if (!await checkTcpPort(port, Math.min(300, deadline?.remaining('Edge endpoint discovery') ?? 300))) continue;
    const version = await httpJson(`http://${HOST}:${port}/json/version`, Math.min(1500, deadline?.remaining('Edge endpoint discovery') ?? 1500));
    if (!edgeVersionMetadata(version) || typeof version?.webSocketDebuggerUrl !== 'string') continue;
    try { add({ wsUrl: validateBrowserWsUrl(version.webSocketDebuggerUrl, port), source: `json-version:${port}`, port }); } catch {}
  }
  if (candidates.length) return candidates;
  throw new BrokerError(
    'remote_debugging_unavailable',
    '没有发现已启用远程调试的 Microsoft Edge。请在 edge://inspect/#remote-debugging 启用当前浏览器实例。',
    undefined,
    503,
  );
}

async function discoverEdgeEndpoint(deadline = null) {
  return (await discoverEdgeEndpoints(deadline))[0];
}

let browserSocket = null;
let connectionGeneration = 0;
let connectionState = 'disconnected';
let connectionMeta = null;
let connectingPromise = null;
let lastConnectError = null;
let lastCdpTimeout = null;
let metadataHealthProbe = null;
let profileLockServer = null;
let profileLockKey = null;
let commandId = 0;
const pending = new Map();
const sessions = new Map();
const targetsBySession = new Map();
const eventWaiters = new Set();
const contextVersions = new Map();
const fixedWorlds = createFixedWorldResolver({sendCdp, makeError:(...args) => new BrokerError(...args),
  frameTimeoutMs:BUDGETS.dom, worldTimeoutMs:BUDGETS.context});
let connectionBaselineTargets = new Set();
const leases = new Map();
const managedTabs = new Map();
const targetQueues = new Map();
const quarantinedTargets = new Map();
const pendingCreationMarkers = new Map();
// Authenticated creation markers left by a prior broker are known task pages,
// but no current caller owns a management capability for them. Count them and
// block new creation until Edge confirms they were closed or disappeared.
const orphanCreationTargets = new Map();
const idempotencyRecords = new Map();
const destroyedTargets = new Map();
const closingTargets = new Map();
const stalledTargets = new Map();
// Popup-capable broker actions reserve one slot while the action is in flight
// and for a short event-ordering guard afterwards. Page.windowOpen has no
// target id, so it may annotate this bounded reservation but must never create
// a lifetime ghost or authorize inspecting/closing a no-opener target.
const popupRiskReservations = new Map();
// Public navigation metadata belongs to the source click, not to a popup
// target. Keep it independent of reservations consumed by targetCreated.
const clickPopupCaptures = new Map();
let popupRiskActionTail = Promise.resolve();
let leaseEpoch = 0;

function endpointLockKey(endpoint) {
  const port = Number(endpoint?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrokerError('invalid_browser_endpoint', '无法为 Edge 调试端点建立进程级互斥锁。', undefined, 503);
  }
  // The loopback CDP port uniquely identifies the running Edge browser
  // instance. Using it also makes ActivePort and explicit-environment
  // discovery converge on the same lock.
  return `edge-cdp-loopback:${port}`;
}

function lockAddressForKey(key) {
  const digest = createHash('sha256').update(key).digest('hex');
  const numeric = Number.parseInt(digest.slice(0, 8), 16);
  // Windows named pipes permit multiple same-name instances, so they are not
  // a mutex. A loopback TCP listener is exclusive across local processes.
  return { host: HOST, port: 41000 + (numeric % 20000) };
}

async function closeProfileLock(server = profileLockServer) {
  if (!server) return;
  if (server === profileLockServer) {
    profileLockServer = null;
    profileLockKey = null;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, 1000);
    try { server.close(finish); } catch { finish(); }
  });
}

async function ensureProfileLock(endpoint) {
  const key = endpointLockKey(endpoint);
  if (profileLockServer?.listening && profileLockKey === key) return;
  const address = lockAddressForKey(key);
  const candidate = net.createServer((socket) => socket.destroy());
  candidate.unref?.();
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { candidate.off('listening', onListening); reject(error); };
      const onListening = () => { candidate.off('error', onError); resolve(); };
      candidate.once('error', onError);
      candidate.once('listening', onListening);
      candidate.listen(address.port, address.host);
    });
  } catch (error) {
    try { candidate.close(); } catch {}
    if (error?.code === 'EADDRINUSE') {
      throw new BrokerError(
        'edge_profile_in_use',
        '已有另一个 Edge CDP broker 控制这个浏览器实例；拒绝启动第二套 lease 域。',
        { edgePort: endpoint.port },
        409,
      );
    }
    throw new BrokerError('profile_lock_failed', '无法建立 Edge 浏览器实例的进程级互斥锁。', { edgePort: endpoint.port, cause: error?.code || null }, 503);
  }
  const previous = profileLockServer;
  profileLockServer = candidate;
  profileLockKey = key;
  if (previous && previous !== candidate) await closeProfileLock(previous);
}

function clearSessionByTarget(targetId, reason = 'session_invalid', expectedSessionId = null) {
  fixedWorlds.invalidate(targetId, expectedSessionId);
  const currentSessionId = sessions.get(targetId);
  const sessionId = expectedSessionId || currentSessionId;
  if (sessionId) {
    if (!expectedSessionId || currentSessionId === expectedSessionId) sessions.delete(targetId);
    targetsBySession.delete(sessionId);
  }
  for (const [id, entry] of pending) {
    const matches = expectedSessionId
      ? entry.sessionId === expectedSessionId
      : (sessionId && entry.sessionId === sessionId) || entry.targetId === targetId;
    if (!matches) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new BrokerError(reason, `目标 ${targetId} 的调试会话已失效。`, { targetId }, 502));
  }
  for (const waiter of [...eventWaiters]) {
    if (!sessionId) break;
    if (waiter.sessionId !== sessionId) continue;
    eventWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.reject(new BrokerError(reason, `目标 ${targetId} 的事件会话已失效。`, { targetId }, 502));
  }
}

function rejectAllPending(error) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(error);
  }
  for (const waiter of [...eventWaiters]) {
    eventWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function handleSocketLoss(socket, reason = 'connection_lost') {
  if (browserSocket !== socket) return;
  browserSocket = null;
  connectionState = 'disconnected';
  connectionMeta = null;
  lastConnectError = { code: reason, message: 'Edge CDP connection lost or unresponsive.', at: new Date().toISOString() };
  fixedWorlds.clear();
  sessions.clear();
  targetsBySession.clear();
  rejectAllPending(new BrokerError(reason, '与 Microsoft Edge 的 CDP 连接已断开。', undefined, 502));
}

function retireBrowserSocket(socket, reason = 'unresponsive_connection') {
  if (!socket || browserSocket !== socket) return;
  handleSocketLoss(socket, reason);
  try {
    if (typeof socket.terminate === 'function') socket.terminate();
    else socket.close();
  } catch {}
}

function handleBrowserMessage(socket, raw) {
  if (browserSocket !== socket) return;
  let message;
  try { message = JSON.parse(normalizeWsData(raw)); } catch { return; }
  if (message.method === 'Target.targetCreated') {
    const targetInfo = message.params?.targetInfo;
    const targetId = targetInfo?.targetId;
    if (targetId) {
      destroyedTargets.delete(targetId);
      trackDerivedTaskTarget(targetInfo);
    }
  } else if (message.method === 'Target.attachedToTarget') {
    const targetId = message.params?.targetInfo?.targetId;
    const sessionId = message.params?.sessionId;
    if (targetId && sessionId) {
      sessions.set(targetId, sessionId);
      targetsBySession.set(sessionId, targetId);
    }
  } else if (message.method === 'Target.detachedFromTarget') {
    const sessionId = message.params?.sessionId;
    const targetId = message.params?.targetId || targetsBySession.get(sessionId);
    if (targetId) clearSessionByTarget(targetId, 'target_detached', sessionId || null);
  } else if (message.method === 'Target.targetDestroyed') {
    const targetId = message.params?.targetId;
    if (targetId) {
      destroyedTargets.set(targetId, Date.now());
      connectionBaselineTargets.delete(targetId);
      const closing = closingTargets.get(targetId);
      if (closing) {
        closing.destroyed = true;
        for (const entry of pending.values()) {
          if (entry.method === 'Target.closeTarget' && entry.targetId === targetId && !entry.sessionId) {
            entry.resolve({ success: true, confirmedByTargetDestroyed: true });
          }
        }
        const sessionId = sessions.get(targetId);
        if (sessionId) clearSessionByTarget(targetId, 'target_destroyed', sessionId);
      } else clearSessionByTarget(targetId, 'target_destroyed');
      forgetDestroyedTargetState(targetId, 'target_destroyed');
    }
  } else if (message.method === 'Inspector.detached' && message.sessionId) {
    const targetId = targetsBySession.get(message.sessionId);
    if (targetId) clearSessionByTarget(targetId, 'inspector_detached', message.sessionId);
  } else if (['Page.frameNavigated', 'Page.frameDetached'].includes(message.method) && message.sessionId) {
    const targetId = targetsBySession.get(message.sessionId);
    if (targetId) fixedWorlds.invalidate(targetId, message.sessionId);
    if (targetId && message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
      contextVersions.set(targetId, (contextVersions.get(targetId) || 0) + 1);
    }
  } else if (message.method === 'Runtime.executionContextsCleared' && message.sessionId) {
    const targetId = targetsBySession.get(message.sessionId);
    if (targetId) { fixedWorlds.invalidate(targetId, message.sessionId); contextVersions.set(targetId, (contextVersions.get(targetId) || 0) + 1); }
  } else if (message.method === 'Page.windowOpen' && message.sessionId) {
    const sourceTargetId = targetsBySession.get(message.sessionId);
    if (sourceTargetId && (leases.has(sourceTargetId) || managedTabs.has(sourceTargetId))) {
      const capture = clickPopupCaptures.get(sourceTargetId);
      if (capture) {
        capture.seen = true;
        const url = sanitizePopupDestination(message.params?.url);
        if (url && capture.urls.size < 4) capture.urls.add(url);
        else if (!url) capture.filtered = true;
        capture.wake();
      }
      // The protocol supplies no target id or cross-domain ordering guarantee.
      // Mark only an already-authorized popup-capable action. A late or
      // unrelated event cannot manufacture a permanent capacity reservation.
      for (const reservation of popupRiskReservations.values()) {
        if (reservation.sourceTargetId !== sourceTargetId) continue;
        reservation.windowOpenSeenAt = Date.now();
        break;
      }
    }
  }
  if (message.method) {
    for (const waiter of [...eventWaiters]) {
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params ?? {});
    }
  }
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new BrokerError(
        'cdp_error',
        message.error.message || `CDP 命令 ${entry.method} 失败。`,
        { method: entry.method, cdpCode: message.error.code, targetId: entry.targetId },
        502,
      ));
    } else entry.resolve(message.result ?? {});
  }
}

function trackDerivedTaskTarget(targetInfo, { deferClose = false } = {}) {
  const targetId = targetInfo?.targetId;
  const openerId = targetInfo?.openerId;
  if (targetInfo?.type !== 'page' || !targetId || managedTabs.has(targetId) || leases.has(targetId)) return;
  // Discovery may replay targets that existed before this connection, and a
  // lease may be acquired after a user-created child already existed. Neither
  // is proof that the task created the child, even when openerId is explicit.
  if (connectionState !== 'connected' || connectionBaselineTargets.has(targetId)) return;
  const openerLease = openerId ? leases.get(openerId) : null;
  const openerManaged = openerId ? managedTabs.get(openerId) : null;
  if (openerLease?.preexistingChildTargetIds?.has(targetId)) return;
  const owner = openerLease?.owner || openerManaged?.owner;
  const manageToken = openerManaged?.manageToken || null;
  if (!owner) return;

  for (const [reservationId, reservation] of popupRiskReservations) {
    if (reservation.sourceTargetId !== openerId) continue;
    clearTimeout(reservation.releaseTimer);
    popupRiskReservations.delete(reservationId);
    break;
  }

  managedTabs.set(targetId, {
    owner,
    manageToken: manageToken || randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
    derivedFrom: openerId,
  });
  // A controlled page may create a popup without going through /new and the
  // caller has no lease capability for that new target. Close only the target
  // whose opener is task-controlled; callers can follow its public href in the
  // existing page or create an explicit leased page. Never infer ownership
  // from URL, and never leave an unclaimed task popup consuming memory.
  if (!deferClose) void closeOverflowDerivedTarget(targetId).catch(() => {});
  return true;
}

async function closeOverflowDerivedTarget(targetId, deadline = deadlineAfter(BUDGETS.metadata)) {
  const managed = managedTabs.get(targetId);
  if (!managed?.derivedFrom) return true;
  if (closingTargets.has(targetId)) {
    throw new BrokerError('derived_close_in_progress', '受控页面产生的派生页正在关闭。', { targetId }, 409);
  }
  const closing = { destroyed: false };
  closingTargets.set(targetId, closing);
  try {
    let result = null;
    try {
      result = await sendCdp('Target.closeTarget', { targetId }, {
        targetId,
        timeoutMs: BUDGETS.metadata,
        deadline,
      });
    } catch (error) {
      if (closing.destroyed || !managedTabs.has(targetId) || isTargetGoneCdpError(error)) {
        forgetDestroyedTargetState(targetId, 'target_destroyed');
        return true;
      }
      quarantinedTargets.set(targetId, {
        code: 'unclaimed_derived_target',
        method: 'Target.closeTarget',
        at: new Date().toISOString(),
        cause: error?.code || null,
      });
      throw error;
    }
    if (result?.success === true || closing.destroyed || destroyedTargets.has(targetId)) {
      forgetDestroyedTargetState(targetId, 'target_destroyed');
      return true;
    }
    try {
      await assertTargetExists(targetId, deadline);
    } catch (error) {
      if (error?.code === 'target_destroyed') return true;
      throw error;
    }
    quarantinedTargets.set(targetId, {
      code: 'unclaimed_derived_target',
      method: 'Target.closeTarget',
      at: new Date().toISOString(),
      cause: 'close_failed',
    });
    throw new BrokerError('close_failed', 'Edge 未确认关闭受控页面产生的无 lease 派生页。', { targetId }, 502);
  } finally {
    closingTargets.delete(targetId);
  }
}

function waitForSharedConnection(promise, deadline) {
  if (!deadline) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      deadline.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      const code = typeof deadline.signal?.reason === 'string' ? deadline.signal.reason : 'request_aborted';
      finish(reject, new BrokerError(code, '等待共享 Edge CDP 连接时请求已取消。', undefined, code === 'request_timeout' ? 504 : 499));
    };
    let waitMs;
    try { waitMs = deadline.remaining('Edge CDP connection'); } catch (error) { reject(error); return; }
    timer = setTimeout(() => finish(reject, new BrokerError('request_timeout', '等待共享 Edge CDP 连接超时。', undefined, 504)), waitMs);
    if (deadline.signal?.aborted) { onAbort(); return; }
    deadline.signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function openAndValidateCandidate(endpoint, connectionDeadline) {
  return await new Promise((resolve, reject) => {
    const socket = new LoopbackWebSocket(endpoint.wsUrl);
    let opened = false;
    let settled = false;
    let handshakeTimer = null;
    const signal = connectionDeadline.signal;
    const cleanupHandshake = () => {
      clearTimeout(handshakeTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      if (browserSocket === socket) retireBrowserSocket(socket, error?.code || 'connection_failed');
      else socket.terminate();
      connectionState = 'disconnected';
      connectionMeta = null;
      lastConnectError = { code: error.code || 'cdp_handshake_failed', message: error.message, at: new Date().toISOString() };
      reject(error);
    };
    const onAbort = () => {
      const code = typeof signal?.reason === 'string' ? signal.reason : 'request_aborted';
      finishReject(new BrokerError(code, 'Edge CDP 连接请求已取消。', undefined, code === 'request_timeout' ? 504 : 499));
    };
    const onError = (event) => {
      const message = event?.message || event?.error?.message || 'Edge CDP WebSocket 握手失败。';
      if (!opened) finishReject(new BrokerError('cdp_handshake_failed', message, undefined, 503));
      else handleSocketLoss(socket, 'connection_error');
    };
    const onClose = () => {
      if (!opened) finishReject(new BrokerError('cdp_handshake_failed', 'Edge 拒绝或关闭了 CDP WebSocket。', undefined, 503));
      else handleSocketLoss(socket, 'connection_closed');
    };
    const onMessage = (event) => handleBrowserMessage(socket, event);
    const onOpen = async () => {
      if (settled) return;
      opened = true;
      clearTimeout(handshakeTimer);
      browserSocket = socket;
      connectionState = 'validating';
      connectionMeta = null;
      try {
        const version = await sendCdp('Browser.getVersion', {}, { timeoutMs: BUDGETS.metadata, deadline: connectionDeadline });
        if (!edgeCdpVersion(version)) throw new BrokerError('wrong_browser_identity', '调试端点不是桌面 Microsoft Edge。', undefined, 503);
        await sendCdp('Target.setDiscoverTargets', { discover: true }, { timeoutMs: BUDGETS.metadata, deadline: connectionDeadline });
        const connectionTargets = await sendCdp('Target.getTargets', {}, { timeoutMs: BUDGETS.metadata, deadline: connectionDeadline });
        if (browserSocket !== socket || !isOpen(socket)) throw new BrokerError('connection_lost', 'Edge 在初始化 target discovery 时断开。', undefined, 502);
        await ensureProfileLock(endpoint);
        settled = true;
        cleanupHandshake();
        connectionGeneration += 1;
        connectionBaselineTargets = new Set(
          (connectionTargets.targetInfos || [])
            .filter((target) => target?.type === 'page' && target?.targetId)
            .map((target) => target.targetId),
        );
        connectionState = 'connected';
        connectionMeta = { source: endpoint.source, port: endpoint.port, generation: connectionGeneration, edgeIdentityVerified: true, targetDiscoveryEnabled: true };
        lastConnectError = null;
        resolve(connectionMeta);
      } catch (error) { finishReject(error); }
    };
    socketOn(socket, 'open', onOpen);
    socketOn(socket, 'error', onError);
    socketOn(socket, 'close', onClose);
    socketOn(socket, 'message', onMessage);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const handshakeBudget = Math.min(HANDSHAKE_TIMEOUT_MS, connectionDeadline.remaining('Edge CDP handshake'));
    handshakeTimer = setTimeout(() => finishReject(new BrokerError(
      endpoint.source === 'environment' ? 'cdp_handshake_failed' : 'cdp_handshake_timeout',
      endpoint.source === 'environment'
        ? '指定的本机 CDP WebSocket 未在握手预算内连接。'
        : `Edge 已发现，但远程调试连接未在 ${Math.ceil(handshakeBudget / 1000)} 秒内完成握手。若浏览器实际显示安全提示，请选择允许；否则等待启动完成后只重试一次。`,
      { timeoutMs: handshakeBudget },
      503,
    )), handshakeBudget);
  });
}

async function connectBrowser(deadline = null) {
  if (connectingPromise) return await waitForSharedConnection(connectingPromise, deadline);
  if (connectionState === 'connected' && isOpen(browserSocket)) return connectionMeta;
  if (browserSocket) retireBrowserSocket(browserSocket, 'uninitialized_connection');
  const connectionDeadline = deadlineAfter(HANDSHAKE_TIMEOUT_MS + 8000);
  let wrapped;
  const attempt = (async () => {
    connectionState = 'connecting';
    lastConnectError = null;
    const endpoints = await discoverEdgeEndpoints(connectionDeadline);
    let handshakeTimeoutError = null;
    let lastError = null;
    for (const endpoint of endpoints) {
      connectionDeadline.remaining('Edge CDP candidate selection');
      try { return await openAndValidateCandidate(endpoint, connectionDeadline); }
      catch (error) {
        if (error?.code === 'edge_profile_in_use') throw error;
        lastError = error;
        if (error?.code === 'cdp_handshake_timeout') handshakeTimeoutError = error;
      }
    }
    throw handshakeTimeoutError || lastError || new BrokerError('remote_debugging_unavailable', '没有可用的 Microsoft Edge 调试端点。', undefined, 503);
  })();
  wrapped = attempt.finally(() => { if (connectingPromise === wrapped) connectingPromise = null; });
  connectingPromise = wrapped;
  return await waitForSharedConnection(wrapped, deadline);
}

function methodTimeout(method, fallback = BUDGETS.dom) {
  if (method === 'Target.getTargets' || method === 'Target.getTargetInfo' || method === 'Target.attachToTarget') return BUDGETS.metadata;
  if (method === 'Page.navigate' || method === 'Target.createTarget') return BUDGETS.navigation;
  if (method === 'Page.captureScreenshot') return BUDGETS.screenshot;
  return fallback;
}

function deadlineAfter(ms, parent = null) {
  const parentExpiresAt = typeof parent === 'number' ? parent : parent?.expiresAt ?? Number.MAX_SAFE_INTEGER;
  const expiresAt = Math.min(Date.now() + ms, parentExpiresAt);
  const controller = new AbortController();
  if (parent && typeof parent === 'object' && parent.signal) {
    if (parent.signal.aborted) controller.abort(parent.signal.reason);
    else parent.signal.addEventListener('abort', () => controller.abort(parent.signal.reason), { once: true });
  }
  return {
    expiresAt,
    signal: controller.signal,
    cancel(code = 'request_aborted') { if (!controller.signal.aborted) controller.abort(code); },
    remaining(label = 'request') {
      if (controller.signal.aborted) {
        const code = typeof controller.signal.reason === 'string' ? controller.signal.reason : 'request_aborted';
        throw new BrokerError(code, `${label} 已取消。`, undefined, code === 'request_timeout' ? 504 : 499);
      }
      if (parent && typeof parent === 'object') parent.remaining(label);
      const value = expiresAt - Date.now();
      if (value <= 0) throw new BrokerError('request_timeout', `${label} 超过 ${ms}ms 的总预算。`, { budgetMs: ms }, 504);
      return value;
    },
  };
}

function assertCdpMethodAllowed(method) {
  if (!ALLOWED_CDP_METHODS.has(method)) {
    throw new BrokerError('cdp_method_not_allowed', `Broker 不允许执行 ${method}。`, { method }, 403);
  }
}

function sendCdp(method, params = {}, options = {}) {
  assertCdpMethodAllowed(method);
  const timeoutMs = Math.max(1, Math.min(
    positiveInteger(options.timeoutMs, methodTimeout(method)),
    options.deadline ? options.deadline.remaining(method) : Number.MAX_SAFE_INTEGER,
  ));
  const sessionId = options.sessionId || null;
  const targetId = options.targetId || (sessionId ? targetsBySession.get(sessionId) : null);
  return new Promise((resolve, reject) => {
    const commandSocket = browserSocket;
    if (!isOpen(commandSocket)) {
      reject(new BrokerError('connection_lost', 'Edge CDP WebSocket 未连接。', undefined, 502));
      return;
    }
    const startedAt = Date.now();
    const id = ++commandId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const signal = options.deadline?.signal;
    let settled = false;
    let timer = null;
    const onAbort = () => {
      const code = typeof signal?.reason === 'string' ? signal.reason : 'request_aborted';
      entry.reject(new BrokerError(code, `CDP 命令 ${method} 因请求取消而中止等待；远端结果未知。`, { method, targetId, outcomeUnknown: true }, code === 'request_timeout' ? 504 : 499));
      // attachToTarget may still succeed remotely after the local waiter is gone.
      // Retiring this generation makes Edge detach every session created on it,
      // so a late attachedToTarget event can never cross a lease boundary.
      if (method === 'Target.attachToTarget' && !sessionId) retireBrowserSocket(commandSocket, 'attach_outcome_unknown');
    };
    const cleanup = () => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
    };
    const entry = {
      method, sessionId, targetId, timer: null,
      resolve(value) { if (settled) return; settled = true; cleanup(); resolve(value); },
      reject(error) { if (settled) return; settled = true; cleanup(); reject(error); },
    };
    timer = setTimeout(() => {
      // A close for an already-owned, tracked target can finish late. Its
      // caller preserves quarantine/capacity when the outcome is unknown;
      // dropping every other owner's connection is neither required nor safe.
      const isolatedManagedClose = method === 'Target.closeTarget' && targetId
        && managedTabs.has(targetId) && closingTargets.has(targetId);
      // Read-only metadata cannot create a late session or page. Fail only
      // this request first, then test this already-validated socket once.
      // Initialization and every other browser-level method keep retirement.
      const isolatedReadOnlyMetadata = !sessionId && connectionState === 'connected'
        && (method === 'Target.getTargets' || method === 'Target.getTargetInfo');
      const retireConnection = !sessionId && !isolatedManagedClose && !isolatedReadOnlyMetadata;
      const timeoutRecord = { method, targetId:targetId || null, at:new Date().toISOString(), timeoutMs, elapsedMs:Date.now()-startedAt, connectionRetired:Boolean(retireConnection) };
      lastCdpTimeout = timeoutRecord;
      entry.reject(new BrokerError('cdp_timeout', `CDP 命令 ${method} 超过 ${timeoutMs}ms。`, { method, targetId, timeoutMs, outcomeUnknown: true }, 504));
      if (retireConnection) retireBrowserSocket(commandSocket, 'unresponsive_connection');
      else if (isolatedReadOnlyMetadata) probeReadOnlyMetadataSocket(commandSocket, timeoutRecord);
    }, timeoutMs);
    entry.timer = timer;
    pending.set(id, entry);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { commandSocket.send(JSON.stringify(message)); } catch (error) {
      entry.reject(new BrokerError('connection_lost', error.message || 'CDP 发送失败。', { method, targetId }, 502));
    }
  });
}

function probeReadOnlyMetadataSocket(socket, timeoutRecord) {
  if (browserSocket !== socket || connectionState !== 'connected' || !isOpen(socket)) return;
  if (metadataHealthProbe?.socket === socket) {
    timeoutRecord.connectionHealthCheck = metadataHealthProbe.observation;
    return;
  }
  const budgetMs = Math.min(1000, BUDGETS.metadata);
  const observation = { status: 'pending', method: 'Browser.getVersion', budgetMs };
  const probe = { socket, observation };
  metadataHealthProbe = probe;
  timeoutRecord.connectionHealthCheck = observation;
  const startedAt = Date.now();
  // No caller deadline, retry, reconnect or side-effect command is inherited.
  // Browser.getVersion is deliberately outside the metadata exception above,
  // so its timeout retires this generation and cannot recursively probe.
  probe.promise = (async () => {
    try {
      const version = await sendCdp('Browser.getVersion', {}, { timeoutMs: budgetMs });
      if (browserSocket !== socket || !isOpen(socket)) { observation.status = 'stale'; return; }
      if (!edgeCdpVersion(version)) throw new BrokerError('wrong_browser_identity', '健康探测没有确认当前 Edge 连接。', undefined, 503);
      observation.status = 'healthy';
    } catch (error) {
      observation.status = browserSocket === socket ? 'failed' : 'retired_or_replaced';
      observation.code = /^[a-z][a-z0-9_]{1,80}$/u.test(error?.code || '') ? error.code : 'health_probe_failed';
      retireBrowserSocket(socket, 'metadata_health_probe_failed');
    } finally {
      observation.elapsedMs = Date.now() - startedAt;
      if (metadataHealthProbe === probe) metadataHealthProbe = null;
    }
  })();
}

function waitForEvent(method, sessionId, timeoutMs, deadline) {
  const bounded = Math.max(1, Math.min(timeoutMs, deadline?.remaining(method) ?? timeoutMs));
  return new Promise((resolve, reject) => {
    const waiter = { method, sessionId, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      eventWaiters.delete(waiter);
      reject(new BrokerError('event_timeout', `等待 ${method} 超过 ${bounded}ms。`, { method }, 504));
    }, bounded);
    eventWaiters.add(waiter);
  });
}

async function ensureSession(targetId, deadline) {
  if (destroyedTargets.has(targetId)) throw new BrokerError('target_destroyed', `目标 ${targetId} 已被 Edge 销毁。`, { targetId }, 404);
  const existing = sessions.get(targetId);
  if (existing) return existing;
  const targetInfo = await assertTargetExists(targetId, deadline);
  assertNoExternalDebugger(targetInfo);
  const result = await sendCdp('Target.attachToTarget', { targetId, flatten: true }, {
    targetId,
    timeoutMs: BUDGETS.metadata,
    deadline,
  });
  if (destroyedTargets.has(targetId)) {
    if (result.sessionId && isOpen(browserSocket)) {
      try { await sendCdp('Target.detachFromTarget', { sessionId: result.sessionId }, { targetId, timeoutMs: 700, deadline }); } catch {}
    }
    throw new BrokerError('target_destroyed', `目标 ${targetId} 在附着期间已被 Edge 销毁。`, { targetId }, 404);
  }
  if (!result.sessionId) throw new BrokerError('attach_failed', `无法附着 Edge target ${targetId}。`, { targetId }, 502);
  sessions.set(targetId, result.sessionId);
  targetsBySession.set(result.sessionId, targetId);
  try {
    await sendCdp('Page.enable', {}, {
      sessionId: result.sessionId,
      targetId,
      timeoutMs: BUDGETS.dom,
      deadline,
    });
  } catch (error) {
    // Initialization may have exhausted the request deadline. Clean up only
    // our known session with an independent bounded budget before forgetting
    // it, so it cannot be mistaken for an external debugger on the next read.
    await detachSessionOrRetire(targetId, result.sessionId, deadlineAfter(1500), 700);
    clearSessionByTarget(targetId, 'page_enable_failed', result.sessionId);
    throw error;
  }
  return result.sessionId;
}

function isSessionInvalidError(error) {
  if (error?.code && ['target_detached', 'target_destroyed', 'inspector_detached', 'session_invalid'].includes(error.code)) return true;
  return /No session with given id|Session closed|Target closed|not attached|detached/iu.test(String(error?.message || ''));
}

function isOutcomeUnknownError(error) {
  return error?.details?.outcomeUnknown === true
    || ['cdp_timeout', 'request_timeout', 'request_aborted', 'connection_lost', 'connection_closed', 'connection_error', 'target_detached', 'inspector_detached', 'session_invalid'].includes(error?.code)
    || isSessionInvalidError(error);
}

function queueForTarget(targetId, deadline, operation, { allowStalled = false } = {}) {
  let waitMs;
  try { waitMs = deadline.remaining('target queue'); } catch (error) { return Promise.reject(error); }
  if (stalledTargets.has(targetId) && !allowStalled) {
    return Promise.reject(new BrokerError('target_lane_stalled', '该 target 的上一项操作未在绝对预算内结束；必须先 recover。', { targetId }, 409));
  }
  let lane = targetQueues.get(targetId);
  if (!lane) {
    lane = { active: false, queue: [] };
    targetQueues.set(targetId, lane);
  }
  return new Promise((resolve, reject) => {
    const item = { operation, deadline, resolve, reject, timer: null, settled: false, onAbort: null };
    const rejectWaiting = (code = 'request_timeout') => {
      if (item.settled || lane.active && lane.current === item) return;
      const index = lane.queue.indexOf(item);
      if (index >= 0) lane.queue.splice(index, 1);
      item.settled = true;
      clearTimeout(item.timer);
      deadline.signal?.removeEventListener('abort', item.onAbort);
      reject(new BrokerError(code, '等待 target 串行队列已超时或取消。', { targetId }, code === 'request_timeout' ? 504 : 499));
      if (!lane.active && lane.queue.length === 0 && targetQueues.get(targetId) === lane) targetQueues.delete(targetId);
    };
    item.onAbort = () => rejectWaiting(typeof deadline.signal?.reason === 'string' ? deadline.signal.reason : 'request_aborted');
    item.timer = setTimeout(() => rejectWaiting('request_timeout'), waitMs);
    deadline.signal?.addEventListener('abort', item.onAbort, { once: true });
    lane.queue.push(item);

    const pump = () => {
      if (lane.active) return;
      const next = lane.queue.shift();
      if (!next) {
        if (targetQueues.get(targetId) === lane) targetQueues.delete(targetId);
        return;
      }
      if (next.settled) { pump(); return; }
      lane.active = true;
      lane.current = next;
      clearTimeout(next.timer);
      next.deadline.signal?.removeEventListener('abort', next.onAbort);
      let activeTimer = null;
      const poison = () => {
        if (next.settled) return;
        next.settled = true;
        stalledTargets.set(targetId, { at: Date.now(), code: 'target_lane_stalled' });
        quarantinedTargets.set(targetId, { code: 'target_lane_stalled', method: null, at: new Date().toISOString() });
        const socket = browserSocket;
        if (socket) retireBrowserSocket(socket, 'target_lane_stalled');
        next.reject(new BrokerError('target_lane_stalled', '该 target 的操作未在绝对预算内结束；连接已退役，禁止并发重放。', { targetId }, 504));
        for (const waiting of lane.queue.splice(0)) {
          if (waiting.settled) continue;
          waiting.settled = true;
          clearTimeout(waiting.timer);
          waiting.deadline.signal?.removeEventListener('abort', waiting.onAbort);
          waiting.reject(new BrokerError('target_lane_stalled', '前序 target 操作未结束，队列已隔离。', { targetId }, 409));
        }
        lane.active = false;
        lane.current = null;
        if (targetQueues.get(targetId) === lane) targetQueues.delete(targetId);
      };
      // A timed-out renderer request may need up to 700ms to detach its own
      // session. Do not retire every owner's connection before that bounded
      // cleanup can finish. 15s operation + 1.5s grace stays inside HTTP's 18s.
      try { activeTimer = setTimeout(poison, next.deadline.remaining('active target operation') + 1500); }
      catch (error) { next.settled = true; next.reject(error); lane.active = false; lane.current = null; pump(); return; }
      Promise.resolve()
        .then(() => { next.deadline.remaining('target queue'); return next.operation(); })
        .then((value) => { if (!next.settled) { next.settled = true; next.resolve(value); } }, (error) => { if (!next.settled) { next.settled = true; next.reject(error); } })
        .finally(() => {
          clearTimeout(activeTimer);
          if (lane.current !== next) return;
          lane.active = false;
          lane.current = null;
          pump();
        });
    };
    pump();
  });
}

async function detachSessionOrRetire(targetId, sessionId, deadline, timeoutMs = 700) {
  if (!sessionId || !isOpen(browserSocket)) return { status: 'connection_absent' };
  const socket = browserSocket;
  try {
    await sendCdp('Target.detachFromTarget', { sessionId }, { targetId, timeoutMs, deadline });
    return { status: 'detached' };
  } catch (error) {
    if (isSessionInvalidError(error)) return { status: 'already_detached' };
    if (socket && browserSocket === socket) retireBrowserSocket(socket, 'detach_failed');
    return { status: 'connection_retired', errorCode: error?.code || 'detach_failed' };
  }
}

async function quarantineTimedOutTarget(targetId, sessionId, error) {
  const expectedLease = leases.get(targetId);
  if (!expectedLease || destroyedTargets.has(targetId)) {
    if (sessionId) await detachSessionOrRetire(targetId, sessionId, deadlineAfter(1500), 700);
    clearSessionByTarget(targetId, 'target_destroyed_or_unleased', sessionId || null);
    if (destroyedTargets.has(targetId)) quarantinedTargets.delete(targetId);
    return;
  }
  quarantinedTargets.set(targetId, {
    code: error?.code || 'cdp_timeout',
    method: error?.details?.method || null,
    at: new Date().toISOString(),
  });
  const cleanupDeadline = deadlineAfter(1500);
  if (sessionId) await detachSessionOrRetire(targetId, sessionId, cleanupDeadline, 700);
  clearSessionByTarget(targetId, 'session_quarantined', sessionId || null);
  if (destroyedTargets.has(targetId)) quarantinedTargets.delete(targetId);
}

async function targetCommandUnlocked(targetId, method, params, { deadline, timeoutMs, retrySession = true, sideEffect = false } = {}) {
  let sessionId = null;
  try {
    sessionId = await ensureSession(targetId, deadline);
    return await sendCdp(method, params, { sessionId, targetId, timeoutMs, deadline });
  } catch (error) {
    if (sideEffect && isOutcomeUnknownError(error)) {
      await quarantineTimedOutTarget(targetId, sessionId, error);
      throw new BrokerError('outcome_unknown', `${method} 可能已生效但响应丢失；已隔离 target，禁止自动重放。`, { targetId, method, cause: error?.code || null }, 409);
    }
    if (['cdp_timeout', 'request_timeout', 'request_aborted'].includes(error?.code)) {
      await quarantineTimedOutTarget(targetId, sessionId, error);
      throw error;
    }
    if (!retrySession || !isSessionInvalidError(error)) throw error;
    clearSessionByTarget(targetId, 'session_invalid', sessionId);
    try {
      sessionId = await ensureSession(targetId, deadline);
      return await sendCdp(method, params, { sessionId, targetId, timeoutMs, deadline });
    } catch (retryError) {
      if (sideEffect && isOutcomeUnknownError(retryError)) {
        await quarantineTimedOutTarget(targetId, sessionId, retryError);
        throw new BrokerError('outcome_unknown', `${method} 可能已生效但响应丢失；已隔离 target，禁止自动重放。`, { targetId, method, cause: retryError?.code || null }, 409);
      }
      if (['cdp_timeout', 'request_timeout', 'request_aborted'].includes(retryError?.code)) await quarantineTimedOutTarget(targetId, sessionId, retryError);
      throw retryError;
    }
  }
}

function validateOwner(value) {
  const owner = String(value || '').trim();
  if (!/^[A-Za-z0-9._:@-]{1,128}$/u.test(owner)) {
    throw new BrokerError('owner_required', '需要合法的 X-CDP-Owner（1—128 位字母、数字、点、下划线、冒号、@ 或连字符）。', undefined, 400);
  }
  return owner;
}

function requestOwner(request, query, required = true) {
  const header = request.headers['x-cdp-owner'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = query.owner;
  if (fromHeader && fromQuery && fromHeader !== fromQuery) throw new BrokerError('owner_mismatch', 'X-CDP-Owner 与 query owner 不一致。', undefined, 400);
  const value = fromHeader || fromQuery;
  if (!value && !required) return null;
  return validateOwner(value);
}

function activeTaskPageCount() {
  const targetIds = new Set();
  let unboundReservations = 0;
  // Broker-created pages continue to consume browser memory after their lease
  // is released or expires. Count them until Edge confirms that the target was
  // closed; otherwise repeated release/new cycles could bypass the five-page
  // ceiling while leaving old task tabs open.
  for (const targetId of managedTabs.keys()) targetIds.add(targetId);
  for (const targetId of leases.keys()) targetIds.add(targetId);
  for (const targetId of orphanCreationTargets.keys()) targetIds.add(targetId);
  for (const reservation of pendingCreationMarkers.values()) {
    if (reservation?.targetId) targetIds.add(reservation.targetId);
    else unboundReservations += 1;
  }
  return targetIds.size + unboundReservations + popupRiskReservations.size;
}

function assertTaskPageCapacity() {
  const active = activeTaskPageCount();
  if (active >= MAX_ACTIVE_TASK_PAGES) {
    throw new BrokerError(
      'task_page_limit_reached',
      `本任务 Edge 页面已达到 ${MAX_ACTIVE_TASK_PAGES} 个；既有用户页请先 release，自建任务页请先 finalize。`,
      { active, limit: MAX_ACTIVE_TASK_PAGES },
      409,
    );
  }
}

function acquireLease(targetId, owner, createdByBroker = false, capacityReserved = false, preexistingChildTargetIds = new Set()) {
  if (!targetId) throw new BrokerError('target_required', '缺少 target 参数。', undefined, 400);
  const existing = leases.get(targetId);
  if (existing && leaseExpired(existing)) {
    throw new BrokerError('lease_expired', '该 Edge target 的旧 lease 已过期，等待 broker 完成安全释放后请重试。', { targetId }, 409);
  }
  if (existing) throw new BrokerError('lease_conflict', '该 Edge target 已被占用；已有持有者应继续使用原 lease token。', { targetId }, 409);
  if (!capacityReserved) assertTaskPageCapacity();
  const lease = {
    owner,
    token: randomBytes(24).toString('base64url'),
    epoch: ++leaseEpoch,
    acquiredAt: new Date().toISOString(),
    lastUsedAt: Date.now(),
    createdByBroker,
    preexistingChildTargetIds,
  };
  leases.set(targetId, lease);
  return lease;
}

function requireLease(targetId, owner, leaseToken, { allowQuarantined = false } = {}) {
  const lease = leases.get(targetId);
  if (!lease) throw new BrokerError('lease_required', '必须先 acquire 该 Edge target。', { targetId }, 409);
  if (leaseExpired(lease)) {
    throw new BrokerError('lease_expired', '该 Edge target 的 lease 已过期，broker 不再接受此 capability；请重新 acquire。', { targetId }, 409);
  }
  if (lease.owner !== owner || !safeEqualToken(leaseToken, lease.token)) {
    throw new BrokerError('lease_conflict', '该 Edge target 的 owner 或 lease token 不匹配。', { targetId }, 409);
  }
  if (!allowQuarantined && quarantinedTargets.has(targetId)) {
    throw new BrokerError('target_quarantined', '该 target 上一条命令超时，已保留隔离状态；先核对原断点和既有恢复额度，不得换页重置失败次数。', {
      targetId,
      quarantine: quarantinedTargets.get(targetId),
    }, 409);
  }
  lease.lastUsedAt = Date.now();
  return lease;
}

function requestLeaseToken(request) {
  const header = request.headers['x-cdp-lease'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/u.test(value)) {
    throw new BrokerError('lease_token_required', '需要合法的 X-CDP-Lease。', undefined, 400);
  }
  return value;
}

function requestManageToken(request) {
  const header = request.headers['x-cdp-manage'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/u.test(value)) {
    throw new BrokerError('manage_token_invalid', 'X-CDP-Manage 不是合法的页面管理 capability。', undefined, 400);
  }
  return value;
}

function requestIdempotencyKey(request) {
  const header = request.headers['x-cdp-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new BrokerError('idempotency_key_required', 'lease 创建请求需要 16—128 位随机 X-CDP-Request-Id。', undefined, 400);
  }
  return value;
}

function opaqueFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function cleanupIdempotencyRecords(now = Date.now()) {
  for (const [key, record] of idempotencyRecords) {
    if (now - record.updatedAt <= IDEMPOTENCY_TTL_MS) continue;
    // Never age out the recovery key for a target that is still leased or is
    // still an open broker-created page. Otherwise the same /new request could
    // create a duplicate while its first page remains alive.
    if (record.targetId && (leases.has(record.targetId) || managedTabs.has(record.targetId))) continue;
    idempotencyRecords.delete(key);
    if (record.markerUrl) pendingCreationMarkers.delete(record.markerUrl);
  }
}

function isTargetGoneCdpError(error) {
  return error?.code === 'target_destroyed'
    || error?.code === 'cdp_error'
      && (error?.details?.cdpCode === -32602 || /no target|target.*(?:closed|not found|does not exist)/iu.test(error.message || ''));
}

function forgetDestroyedTargetState(targetId, reason = 'target_destroyed', { keepCompletedNewTombstone = true } = {}) {
  if (!targetId) return;
  clearSessionByTarget(targetId, reason);
  leases.delete(targetId);
  managedTabs.delete(targetId);
  orphanCreationTargets.delete(targetId);
  quarantinedTargets.delete(targetId);
  contextVersions.delete(targetId);
  stalledTargets.delete(targetId);
  // Keep a completed /new record just long enough for a retry using the same
  // request capability to receive an explicit target_destroyed response. The
  // replay handler then removes the tombstone, so only a following retry may
  // create a replacement instead of doing so silently during stale cleanup.
  invalidateTargetIdempotency(targetId, { keepCompletedNewTombstone });
}

const BROKER_MARKER_URL = /^about:blank#codex-edge-broker-v2-([1-9][0-9]{0,4})-([A-Za-z0-9_-]{24})-([A-Za-z0-9_-]{43})$/u;

function makeBrokerMarkerUrl() {
  if (!markerKey) throw new BrokerError('marker_key_unavailable', 'Broker marker key 尚未安全初始化。', undefined, 503);
  const nonce = randomBytes(18).toString('base64url');
  const payload = `v2:${PORT}:${nonce}`;
  const mac = createHmac('sha256', markerKey).update(payload).digest('base64url');
  return `about:blank#codex-edge-broker-v2-${PORT}-${nonce}-${mac}`;
}

function isAuthenticBrokerMarker(value) {
  const match = String(value || '').match(BROKER_MARKER_URL);
  if (!match || Number(match[1]) !== PORT || !markerKey) return false;
  const expected = createHmac('sha256', markerKey).update(`v2:${PORT}:${match[2]}`).digest();
  let actual;
  try { actual = Buffer.from(match[3], 'base64url'); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reserveAuthenticOrphanTargets(targetInfos) {
  const candidates = [];
  for (const target of targetInfos || []) {
    const targetId = target?.targetId;
    const markerUrl = target?.url;
    if (target?.type !== 'page' || !targetId || !isAuthenticBrokerMarker(markerUrl)) continue;
    if (pendingCreationMarkers.has(markerUrl) || leases.has(targetId) || managedTabs.has(targetId) || closingTargets.has(targetId)) {
      orphanCreationTargets.delete(targetId);
      continue;
    }
    orphanCreationTargets.set(targetId, {
      markerUrl,
      observedAt: Date.now(),
      attached: Boolean(target.attached && !sessions.has(targetId)),
    });
    candidates.push(target);
  }
  return candidates;
}

async function sweepOrphanCreationTargets(deadline, limit = 16) {
  if (!isOpen(browserSocket)) return 0;
  const result = await sendCdp('Target.getTargets', {}, { timeoutMs: BUDGETS.metadata, deadline });
  const liveTargetIds = new Set((result.targetInfos || []).map((target) => target?.targetId).filter(Boolean));
  for (const targetId of new Set([...leases.keys(), ...managedTabs.keys(), ...orphanCreationTargets.keys(), ...quarantinedTargets.keys()])) {
    if (!liveTargetIds.has(targetId)) forgetDestroyedTargetState(targetId, 'target_destroyed');
  }
  // Reserve every authenticated orphan before the first close await. This
  // makes concurrent /new requests see the physical page immediately.
  const candidates = reserveAuthenticOrphanTargets(result.targetInfos);

  let closed = 0;
  const unresolved = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const target = candidates[index];
    const targetId = target?.targetId;
    if (index >= limit) {
      unresolved.push({ targetId, reason: 'cleanup_limit' });
      continue;
    }
    // An attached marker could belong to a still-running process that has not
    // published its in-memory reservation yet. Never seize or close it, and do
    // not create another page while its ownership is unresolved.
    if (target.attached && !sessions.has(targetId)) {
      unresolved.push({ targetId, reason: 'externally_attached' });
      continue;
    }
    try {
      const closeResult = await sendCdp('Target.closeTarget', { targetId }, { targetId, timeoutMs: BUDGETS.metadata, deadline });
      if (closeResult?.success === true || destroyedTargets.has(targetId)) {
        orphanCreationTargets.delete(targetId);
        closed += 1;
      } else unresolved.push({ targetId, reason: 'close_not_confirmed' });
    } catch (error) {
      if (error?.code === 'request_timeout' || error?.code === 'request_aborted') throw error;
      if (isTargetGoneCdpError(error)) {
        forgetDestroyedTargetState(targetId, 'target_destroyed');
        closed += 1;
      } else {
        unresolved.push({ targetId, reason: error?.code || 'close_error' });
        // A retired browser socket cannot process the remaining candidates.
        // They were all reserved above, so stopping this pass remains safe.
        if (!isOpen(browserSocket)) {
          for (const remaining of candidates.slice(index + 1)) {
            unresolved.push({ targetId: remaining.targetId, reason: 'connection_lost' });
          }
          break;
        }
      }
    }
  }
  if (unresolved.length) {
    throw new BrokerError(
      'orphan_marker_unresolved',
      '发现未确认关闭的 broker 创建标记页；已计入任务页额度并拒绝创建新页。',
      {
        active: activeTaskPageCount(),
        limit: MAX_ACTIVE_TASK_PAGES,
        targets: unresolved.slice(0, 16),
      },
      409,
    );
  }
  return closed;
}

async function sweepUnclaimedDerivedTargets(deadline, limit = 16) {
  if (!isOpen(browserSocket)) return 0;
  const result = await sendCdp('Target.getTargets', {}, { timeoutMs: BUDGETS.metadata, deadline });
  const liveTargetIds = new Set((result.targetInfos || []).map((target) => target?.targetId).filter(Boolean));
  // A child can be queryable before its discovery event is delivered. Reserve
  // explicit, post-baseline children synchronously before /new or an unrelated
  // /acquire performs its capacity check.
  for (const target of result.targetInfos || []) trackDerivedTaskTarget(target, { deferClose: true });
  const candidates = [];
  for (const [targetId, managed] of managedTabs) {
    if (!managed?.derivedFrom || leases.has(targetId)) continue;
    if (!liveTargetIds.has(targetId)) {
      forgetDestroyedTargetState(targetId, 'target_destroyed');
      continue;
    }
    candidates.push(targetId);
  }

  let closed = 0;
  const unresolved = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const targetId = candidates[index];
    if (index >= limit) {
      unresolved.push({ targetId, reason: 'cleanup_limit' });
      continue;
    }
    if (closingTargets.has(targetId)) {
      unresolved.push({ targetId, reason: 'close_in_progress' });
      continue;
    }
    if (quarantinedTargets.get(targetId)?.code === 'unclaimed_derived_target') {
      unresolved.push({ targetId, reason: 'prior_close_outcome_unknown' });
      continue;
    }
    try {
      await closeOverflowDerivedTarget(targetId, deadline);
      closed += 1;
    } catch (error) {
      if (error?.code === 'request_timeout' || error?.code === 'request_aborted') throw error;
      unresolved.push({ targetId, reason: error?.code || 'close_error' });
      if (!isOpen(browserSocket)) {
        for (const remainingTargetId of candidates.slice(index + 1)) {
          unresolved.push({ targetId: remainingTargetId, reason: 'connection_lost' });
        }
        break;
      }
    }
  }
  if (unresolved.length) {
    throw new BrokerError(
      'derived_target_unresolved',
      '受控页面产生的派生页尚未确认关闭；已计入任务页额度并拒绝新的页面占用或点击。',
      {
        active: activeTaskPageCount(),
        limit: MAX_ACTIVE_TASK_PAGES,
        targets: unresolved.slice(0, 16),
      },
      409,
    );
  }
  return closed;
}

async function withPopupRiskReservation(sourceTargetId, deadline, operation) {
  const predecessor = popupRiskActionTail;
  let releaseCurrent;
  popupRiskActionTail = new Promise((resolve) => { releaseCurrent = resolve; });
  let reservationId = null;
  let capture = null;
  try {
    await waitForSharedConnection(predecessor, deadline);
    await sweepOrphanCreationTargets(deadline);
    await sweepUnclaimedDerivedTargets(deadline);
    assertTaskPageCapacity();
    reservationId = randomBytes(12).toString('base64url');
    popupRiskReservations.set(reservationId, {
      sourceTargetId,
      createdAt: Date.now(),
      windowOpenSeenAt: null,
      releaseTimer: null,
    });
    let wake;
    const event = new Promise((resolve) => { wake = resolve; });
    capture = { urls: new Set(), seen: false, filtered: false, wake };
    clickPopupCaptures.set(sourceTargetId, capture);
    try {
      const value = await operation();
      // A script-opened destination may be announced after the click reply.
      // Bound the wait; never inspect a popup or infer its ownership from URL.
      if (!capture.seen && !value?.navigationUrl) {
        let timer;
        try {
          await Promise.race([event, new Promise((resolve) => {
            timer = setTimeout(resolve, Math.min(750, deadline.remaining('popup destination')));
          })]);
        } finally { clearTimeout(timer); }
      }
      return { value, popupUrls: [...capture.urls], popupUrlStatus: capture.filtered ? 'filtered' : capture.seen ? 'captured' : 'not_observed' };
    } finally {
      // CDP does not promise Page.windowOpen/Target.targetCreated ordering.
      // Retain the slot briefly without delaying the HTTP response. Explicit
      // opener attribution consumes it atomically; otherwise it expires so a
      // blocked/cancelled/no-opener event cannot permanently exhaust capacity.
      const reservation = popupRiskReservations.get(reservationId);
      if (reservation) {
        const releaseReservationId = reservationId;
        reservation.releaseTimer = setTimeout(() => {
          popupRiskReservations.delete(releaseReservationId);
        }, 750);
        reservation.releaseTimer.unref?.();
      }
      reservationId = null;
    }
  } finally {
    if (capture && clickPopupCaptures.get(sourceTargetId) === capture) clickPopupCaptures.delete(sourceTargetId);
    if (reservationId) {
      const reservation = popupRiskReservations.get(reservationId);
      clearTimeout(reservation?.releaseTimer);
      popupRiskReservations.delete(reservationId);
    }
    releaseCurrent();
  }
}

const idempotencyCleanupTimer = setInterval(() => {
  const now = Date.now();
  cleanupIdempotencyRecords(now);
  for (const [targetId, destroyedAt] of destroyedTargets) {
    if (now - destroyedAt > IDEMPOTENCY_TTL_MS) destroyedTargets.delete(targetId);
  }
}, 60 * 1000);
idempotencyCleanupTimer.unref?.();

const orphanMarkerCleanupTimer = setInterval(() => {
  if (!isOpen(browserSocket) || connectionState !== 'connected') return;
  void sweepOrphanCreationTargets(deadlineAfter(Math.min(5000, REQUEST_TIMEOUT_MS))).catch(() => {});
  void sweepUnclaimedDerivedTargets(deadlineAfter(Math.min(5000, REQUEST_TIMEOUT_MS))).catch(() => {});
}, 60 * 1000);
orphanMarkerCleanupTimer.unref?.();

function idempotencyRecord(owner, requestId, operation, fingerprint) {
  cleanupIdempotencyRecords();
  const key = `${owner}\u0000${requestId}`;
  const existing = idempotencyRecords.get(key);
  if (existing && (existing.operation !== operation || existing.fingerprint !== fingerprint)) {
    throw new BrokerError('idempotency_key_conflict', '同一个 X-CDP-Request-Id 已用于不同操作或参数。', undefined, 409);
  }
  return { key, existing };
}

function storeIdempotency(key, value) {
  idempotencyRecords.set(key, { ...value, updatedAt: Date.now() });
  return idempotencyRecords.get(key);
}

function leaseExpired(lease, now = Date.now()) {
  return !Number.isFinite(lease?.lastUsedAt) || now - lease.lastUsedAt > LEASE_TTL_MS;
}

async function cleanupExpiredLeases(parentDeadline, limit = 1) {
  const now = Date.now();
  let cleaned = 0;
  for (const [targetId, expectedLease] of [...leases]) {
    if (cleaned >= limit) break;
    if (!leaseExpired(expectedLease, now)) continue;
    const lane = targetQueues.get(targetId);
    if (lane?.active) continue;
    stalledTargets.delete(targetId);
    let cleanupDeadline;
    try {
      cleanupDeadline = deadlineAfter(Math.min(1200, parentDeadline.remaining('expired lease cleanup')), parentDeadline);
      await queueForTarget(targetId, cleanupDeadline, async () => {
        const current = leases.get(targetId);
        if (current !== expectedLease || !leaseExpired(current)) return;
        const sessionId = sessions.get(targetId);
        if (sessionId) await detachSessionOrRetire(targetId, sessionId, cleanupDeadline, 700);
        clearSessionByTarget(targetId, 'lease_expired', sessionId || null);
        if (leases.get(targetId) === current) leases.delete(targetId);
        // A broker-created page remains open after lease expiry. Keep its
        // managed record so it still occupies a slot and a caller holding its
        // management capability can reacquire and finalize it later.
        // Lease expiry also preserves page failure state.
        contextVersions.delete(targetId);
        stalledTargets.delete(targetId);
        invalidateTargetIdempotency(targetId, { keepManagedNew: true });
        cleaned += 1;
      });
    } catch (error) {
      if (parentDeadline.signal?.aborted) break;
    }
  }
  return cleaned;
}

function invalidateTargetIdempotency(targetId, { keepManagedNew = false, keepCompletedNewTombstone = false } = {}) {
  for (const [key, record] of idempotencyRecords) {
    if (record.result?.targetId !== targetId && record.targetId !== targetId) continue;
    if (keepManagedNew && record.operation === 'new' && managedTabs.has(targetId)) continue;
    if (keepCompletedNewTombstone && record.operation === 'new' && record.status === 'complete') continue;
    idempotencyRecords.delete(key);
    if (record.markerUrl) pendingCreationMarkers.delete(record.markerUrl);
  }
}

async function withTargetLease(targetId, owner, leaseToken, deadline, operation, options = {}) {
  return await queueForTarget(targetId, deadline, async () => {
    const lease = requireLease(targetId, owner, leaseToken, options);
    const epoch = lease.epoch;
    const result = await operation(lease);
    const current = leases.get(targetId);
    if (!current || current.epoch !== epoch) {
      throw new BrokerError('lease_changed', '命令执行期间 target lease 已变化。', { targetId }, 409);
    }
    return result;
  }, { allowStalled: options.allowStalled === true });
}

function safeEqualToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

let brokerToken = null;
let markerKey = null;
function authorize(request) {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const candidate = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
  if (!brokerToken || !safeEqualToken(candidate, brokerToken)) throw new BrokerError('unauthorized', '缺少或无效的本机 broker bearer token。', undefined, 401);
}

function windowsPowerShellPath() {
  const candidates = [
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')] : []),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.resolve(directory, 'pwsh.exe')),
    windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new BrokerError('acl_tool_missing', '找不到可用于硬化 token ACL 的 PowerShell。');
  return found;
}

function currentWindowsSid() {
  const executable = windowsSystemPath('whoami.exe');
  const result = spawnSync(executable, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
  });
  const fields = String(result.stdout || '').trim().match(/"([^"]*)","([^"]*)"/u);
  if (result.status !== 0 || !fields?.[2]) throw new BrokerError('acl_identity_failed', '无法确定当前 Windows 用户 SID。');
  return fields[2];
}

function hardenAndVerifyWindowsAcl(filePath, isDirectory, sid) {
  if (os.platform() !== 'win32') return;
  const icacls = windowsSystemPath('icacls.exe');
  const commandOptions = { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024 };
  const reset = spawnSync(icacls, [filePath, '/reset', '/q'], commandOptions);
  if (reset.status !== 0) throw new BrokerError('acl_hardening_failed', String(reset.stderr || reset.stdout || 'icacls reset failed').trim());
  const protect = spawnSync(icacls, [filePath, '/inheritance:r', '/q'], commandOptions);
  if (protect.status !== 0) throw new BrokerError('acl_hardening_failed', String(protect.stderr || protect.stdout || 'icacls inheritance failed').trim());
  const suffix = isDirectory ? '(OI)(CI)(F)' : '(F)';
  const grant = spawnSync(icacls, [filePath, '/grant:r', `*${sid}:${suffix}`, `*S-1-5-18:${suffix}`, '/q'], commandOptions);
  if (grant.status !== 0) throw new BrokerError('acl_hardening_failed', String(grant.stderr || grant.stdout || 'icacls grant failed').trim());
  const payload = Buffer.from(JSON.stringify({ filePath, sid, kind: isDirectory ? 'directory' : 'file' }), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    '$p=[string]$d.filePath',
    '$sid=[string]$d.sid',
    '$check=Get-Acl -LiteralPath $p',
    '$rules=@($check.Access | ForEach-Object { [pscustomobject]@{Sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;Type=$_.AccessControlType.ToString()} })',
    '[pscustomobject]@{Protected=$check.AreAccessRulesProtected;Rules=$rules}|ConvertTo-Json -Compress -Depth 4',
  ].join(';');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const aclCheckStarted = Date.now();
  const result = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024,
  });
  if (result.status !== 0) throw new BrokerError('acl_hardening_failed', String(result.stderr || result.stdout || `ACL verification helper failed after ${Date.now()-aclCheckStarted}ms (error=${result.error?.code || 'none'}, status=${result.status}, signal=${result.signal || 'none'})`).trim());
  let check;
  try { check = JSON.parse(String(result.stdout || '').trim()); } catch { throw new BrokerError('acl_verification_failed', '无法解析 token ACL 验证结果。'); }
  const rules = Array.isArray(check.Rules) ? check.Rules : check.Rules ? [check.Rules] : [];
  const allowed = new Set([sid, 'S-1-5-18']);
  const present = new Set(rules.map((rule) => rule.Sid));
  if (check.Protected !== true || rules.length < 2 || rules.some((rule) => rule.Type !== 'Allow' || !allowed.has(rule.Sid)) || [...allowed].some((identity) => !present.has(identity))) {
    throw new BrokerError('acl_verification_failed', 'token 路径 ACL 未能收敛到当前用户与 SYSTEM。');
  }
}

function createTokenFile() {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(TOKEN_DIR).isSymbolicLink()) throw new BrokerError('unsafe_token_directory', 'token 目录不能是符号链接或 junction。');
  const sid = os.platform() === 'win32' ? currentWindowsSid() : null;
  if (sid) hardenAndVerifyWindowsAcl(TOKEN_DIR, true, sid);
  const generatedToken = randomBytes(32).toString('base64url');
  const temporaryFile = path.join(TOKEN_DIR, `.${PORT}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryFile, `${generatedToken}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temporaryFile, 0o600); } catch {}
    if (sid) hardenAndVerifyWindowsAcl(temporaryFile, false, sid);
    fs.rmSync(TOKEN_FILE, { force: true });
    fs.renameSync(temporaryFile, TOKEN_FILE);
    if (sid) hardenAndVerifyWindowsAcl(TOKEN_FILE, false, sid);
    brokerToken = generatedToken;
  } catch (error) {
    try { fs.rmSync(temporaryFile, { force: true }); } catch {}
    try {
      if (fs.readFileSync(TOKEN_FILE, 'utf8').trim() === generatedToken) fs.rmSync(TOKEN_FILE, { force: true });
    } catch {}
    brokerToken = null;
    throw error;
  }
}

function createOrLoadMarkerKey() {
  if (fs.existsSync(MARKER_KEY_FILE)) {
    const metadata = fs.lstatSync(MARKER_KEY_FILE);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BrokerError('unsafe_marker_key', 'marker key 必须是普通文件且不能是符号链接。');
    const encoded = fs.readFileSync(MARKER_KEY_FILE, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new BrokerError('invalid_marker_key', 'marker key 文件无效。');
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.length !== 32) throw new BrokerError('invalid_marker_key', 'marker key 长度无效。');
    try { fs.chmodSync(MARKER_KEY_FILE, 0o600); } catch {}
    if (os.platform() === 'win32') hardenAndVerifyWindowsAcl(MARKER_KEY_FILE, false, currentWindowsSid());
    markerKey = decoded;
    return;
  }
  const generated = randomBytes(32);
  const temporaryFile = path.join(TOKEN_DIR, `.${PORT}.marker.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const sid = os.platform() === 'win32' ? currentWindowsSid() : null;
  try {
    fs.writeFileSync(temporaryFile, `${generated.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temporaryFile, 0o600); } catch {}
    if (sid) hardenAndVerifyWindowsAcl(temporaryFile, false, sid);
    fs.renameSync(temporaryFile, MARKER_KEY_FILE);
    if (sid) hardenAndVerifyWindowsAcl(MARKER_KEY_FILE, false, sid);
    markerKey = generated;
  } catch (error) {
    try { fs.rmSync(temporaryFile, { force: true }); } catch {}
    markerKey = null;
    throw error;
  }
}

function removeOwnTokenFile() {
  try { if (fs.readFileSync(TOKEN_FILE, 'utf8').trim() === brokerToken) fs.unlinkSync(TOKEN_FILE); } catch {}
}

function writeJson(response, status, value) {
  if (response.destroyed || response.writableEnded || response.headersSent) return false;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
  return true;
}
const ok = (response, value = {}) => writeJson(response, 200, { ok: true, ...value });
function fail(response, error) {
  const normalized = error instanceof BrokerError ? error : new BrokerError('internal_error', error?.message || String(error));
  writeJson(response, normalized.status || 500, {
    ok: false,
    error: { code: normalized.code || 'internal_error', message: normalized.message, ...(normalized.details === undefined ? {} : { details: normalized.details }) },
  });
}

async function readBody(request, maxBytes = BODY_LIMIT_BYTES, deadline = null) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    deadline?.remaining('request body');
    size += chunk.length;
    if (size > maxBytes) throw new BrokerError('request_body_too_large', `请求体超过 ${maxBytes} 字节。`, undefined, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exactObjectKeys(value, allowed) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new BrokerError('unknown_query_field', `DOM 查询包含未知字段：${extras.join(', ')}`, { extras }, 400);
}

function validateSelector(value, required = true) {
  if (value === undefined && !required) return 'body';
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0')) {
    throw new BrokerError('invalid_selector', 'CSS 选择器必须是 1—512 位普通字符串。', undefined, 400);
  }
  if (value.includes('\\') || value.includes(':')) {
    throw new BrokerError('unsafe_selector', 'CSS escape 和伪类/伪元素不允许用于 broker 查询。', undefined, 400);
  }
  if ((value.match(/,/gu) || []).length > 7 || (value.match(/[>+~]/gu) || []).length > 32) {
    throw new BrokerError('selector_too_complex', 'CSS 选择器分组或组合符过多。', undefined, 400);
  }
  const allowedExistenceAttributes = new Set(['href', 'src', 'poster', 'alt', 'title', 'role', 'aria-label', 'datetime', 'lang', 'rel', 'target', 'type', 'name', 'id', 'class']);
  const withoutAttributes = value.replace(/\[([^\]]*)\]/gu, (whole, content) => {
    const attribute = String(content).trim().toLowerCase();
    if (!allowedExistenceAttributes.has(attribute)) {
      throw new BrokerError('unsafe_selector', '属性选择器只允许公开属性的存在性测试，禁止属性值比较。', { attribute }, 400);
    }
    return '';
  });
  if (withoutAttributes.includes('[') || withoutAttributes.includes(']')) {
    throw new BrokerError('unsafe_selector', 'CSS 属性选择器格式无效。', undefined, 400);
  }
  if (/(?:^|[^a-z0-9_-])(?:script|style|meta|link|template|noscript|iframe|object|embed|input|textarea|select|option)(?:$|[^a-z0-9_-])/iu.test(withoutAttributes)
    || /(?:password|secret|token|cookie|authorization|contenteditable|\bvalue\b|\bcontent\b|data-)/iu.test(value)) {
    throw new BrokerError('unsafe_selector', '选择器不得定位敏感或隐藏数据载体。', undefined, 400);
  }
  return value;
}


function validateShadowPath(value) {
  if (!Array.isArray(value) || value.length > 8) {
    throw new BrokerError('invalid_shadow_path', 'shadowPath 必须是最多 8 步的数组。', undefined, 400);
  }
  return value.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new BrokerError('invalid_shadow_path', 'shadowPath 每步必须是 selector 和 index 组成的对象。', undefined, 400);
    }
    exactObjectKeys(step, new Set(['selector', 'index']));
    const index = step.index === undefined ? 0 : step.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= 2000) {
      throw new BrokerError('invalid_shadow_index', 'index 必须是 0—1999 的整数。', undefined, 400);
    }
    return { selector: validateSelector(step.selector, true), index };
  });
}

function validateClickSpec(body) {
  const raw = String(body).trim();
  if (!raw.startsWith('{')) return validateSelector(raw, true);
  let value;
  try { value = JSON.parse(raw); } catch { throw new BrokerError('invalid_json', '点击定位体不是有效 JSON。', undefined, 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError('invalid_click_spec', '点击定位体必须是对象。', undefined, 400);
  exactObjectKeys(value, new Set(['selector', 'shadowPath', 'index', 'expectedText', 'frameSelector']));
  const result = { selector: validateSelector(value.selector, true), shadowPath: validateShadowPath(value.shadowPath === undefined ? [] : value.shadowPath) };
  if (value.frameSelector !== undefined) result.frameSelector = validateFrameSelector(value.frameSelector);
  if (value.index !== undefined) {
    if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= 2000) throw new BrokerError('invalid_shadow_index', 'index 必须是 0—1999 的整数。', undefined, 400);
    result.index = value.index;
  }
  if (value.expectedText !== undefined) {
    if (typeof value.expectedText !== 'string' || value.expectedText.length < 1 || value.expectedText.length > 160 || /[\u0000-\u001f\u007f]/u.test(value.expectedText)) {
      throw new BrokerError('invalid_expected_text', 'expectedText 必须是 1—160 字的普通可见文字。', undefined, 400);
    }
    result.expectedText = value.expectedText.replace(/\s+/gu, ' ').trim();
    if (!result.expectedText) throw new BrokerError('invalid_expected_text', 'expectedText 不能为空白。', undefined, 400);
  }
  return result;
}

function validateDomQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerError('invalid_dom_query', 'DOM 查询体必须是 JSON 对象。', undefined, 400);
  }
  if (value.kind === 'document') {
    exactObjectKeys(value, new Set(['kind']));
    return { kind: 'document' };
  }
  if (value.kind === 'text') {
    exactObjectKeys(value, new Set(['kind', 'selector', 'visibility', 'maxChars', 'shadowPath', 'frameSelector']));
    const maxChars = value.maxChars === undefined ? 8000 : Number(value.maxChars);
    const visibility = value.visibility === undefined ? 'rendered' : value.visibility;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 16000) {
      throw new BrokerError('invalid_max_chars', 'maxChars 必须是 1—16000 的整数。', undefined, 400);
    }
    if (!['rendered', 'viewport'].includes(visibility)) throw new BrokerError('invalid_visibility', 'visibility 只允许 rendered 或 viewport。', undefined, 400);
    return { kind: 'text', selector: validateSelector(value.selector, false), visibility, maxChars, ...(value.shadowPath !== undefined ? { shadowPath: validateShadowPath(value.shadowPath) } : {}), ...(value.frameSelector !== undefined ? {frameSelector: validateFrameSelector(value.frameSelector)} : {}) };
  }
  if (value.kind === 'elements') {
    exactObjectKeys(value, new Set(['kind', 'selector', 'visibility', 'limit', 'fields', 'shadowPath', 'frameSelector']));
    const limit = value.limit === undefined ? 30 : Number(value.limit);
    const visibility = value.visibility === undefined ? 'rendered' : value.visibility;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new BrokerError('invalid_element_limit', 'limit 必须是 1—50 的整数。', undefined, 400);
    }
    if (!['rendered', 'viewport'].includes(visibility)) throw new BrokerError('invalid_visibility', 'visibility 只允许 rendered 或 viewport。', undefined, 400);
    const rawFields = value.fields === undefined ? ['tag', 'text', 'href'] : value.fields;
    if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > DOM_QUERY_FIELDS.size) {
      throw new BrokerError('invalid_element_fields', 'fields 必须是非空且不重复的允许字段数组。', undefined, 400);
    }
    const fields = [...new Set(rawFields)];
    if (fields.length !== rawFields.length || fields.some((field) => typeof field !== 'string' || !DOM_QUERY_FIELDS.has(field))) {
      throw new BrokerError('invalid_element_fields', 'fields 只能使用允许字段，且不得重复。', { allowed: [...DOM_QUERY_FIELDS] }, 400);
    }
    return { kind: 'elements', selector: validateSelector(value.selector, true), visibility, limit, fields, ...(value.shadowPath !== undefined ? { shadowPath: validateShadowPath(value.shadowPath) } : {}), ...(value.frameSelector !== undefined ? {frameSelector: validateFrameSelector(value.frameSelector)} : {}) };
  }
  throw new BrokerError('invalid_dom_query_kind', 'kind 只允许 document、text 或 elements。', undefined, 400);
}

// Fixed, bounded DOM helpers. This file is inlined into the candidate broker.
function fixedOpenShadowTools(blockedTags, defaultVisibility = 'rendered') {
  const budget = { nodes: 0, texts: 0, candidates: 0, roots: 0, truncated: false };
  const rootsSeen = new WeakSet();
  const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const limit = () => { budget.truncated = true; return false; };
  const candidate = () => budget.candidates < 2000 ? (++budget.candidates, true) : limit();
  const enterRoot = (root, depth) => {
    if (!root || !root.host || root.host.shadowRoot !== root || depth > 16) return false;
    if (!rootsSeen.has(root)) {
      if (budget.roots >= 128) return limit();
      rootsSeen.add(root); budget.roots++;
    }
    return true;
  };
  const parentOf = element => {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return root?.host && root.host.shadowRoot === root ? root.host : null;
  };
  const visible = (element, mode = defaultVisibility, requireBox = true) => {
    if (!(element instanceof Element)) return false;
    const seen = new Set();
    let current = element;
    while (current instanceof Element) {
      if (seen.has(current) || seen.size >= 256) return false;
      seen.add(current);
      const root = current.getRootNode?.();
      if (root?.host && root.host.shadowRoot !== root) return false;
      if (blockedTags.has(current.tagName) || current.isContentEditable || current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity || 1) === 0) return false;
      current = parentOf(current);
    }
    if (!requireBox) return true;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return mode !== 'viewport' || (rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
  };
  const resolveScope = path => {
    let root = document;
    for (let depth = 0; depth < path.length; depth++) {
      const step = path[depth];
      const nodes = root.querySelectorAll(step.selector);
      let host = null;
      let visibleIndex = 0;
      for (let index = 0; index < nodes.length; index++) {
        if (!candidate()) return { error: 'traversal_limit' };
        const node = nodes[index];
        if (!visible(node, 'rendered', true)) continue;
        if (visibleIndex++ === step.index) { host = node; break; }
      }
      if (!host) return { error: 'shadow_host_not_found' };
      if (!host.shadowRoot || host.shadowRoot.host !== host) return { error: 'shadow_root_unavailable' };
      if (!enterRoot(host.shadowRoot, depth + 1)) return { error: 'traversal_limit' };
      root = host.shadowRoot;
    }
    return { root };
  };
  const textVisible = node => {
    const parent = node.parentElement || node.getRootNode?.()?.host;
    if (!parent || !visible(parent, 'rendered', false)) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return defaultVisibility !== 'viewport' || (rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
  };
  const readText = (root, maxChars, maxNodes) => {
    const seen = new Set();
    const stack = [{ node: root, depth: 0 }];
    const chunks = [];
    let length = 0;
    let scanned = 0;
    let truncated = false;
    while (stack.length) {
      if (budget.nodes >= 8000) { limit(); truncated = true; break; }
      const { node, depth } = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node); budget.nodes++;
      if (node.nodeType === 3) {
        if (scanned >= maxNodes || budget.texts >= 2500) { limit(); truncated = true; break; }
        scanned++; budget.texts++;
        if (!textVisible(node)) continue;
        const text = normalize(node.nodeValue);
        if (!text) continue;
        const remaining = maxChars - length;
        if (remaining <= 0) { truncated = true; break; }
        chunks.push(text.slice(0, remaining));
        length += Math.min(text.length, remaining) + 1;
        if (text.length > remaining || length >= maxChars) { truncated = true; break; }
        continue;
      }
      if (node instanceof Element && !visible(node, 'rendered', false)) continue;
      let children = node.childNodes || [];
      let nextDepth = depth;
      if (node instanceof Element && node.shadowRoot) {
        if (!enterRoot(node.shadowRoot, depth + 1)) { limit(); truncated = true; break; }
        children = node.shadowRoot.childNodes;
        nextDepth++;
      } else if (node instanceof Element && node.tagName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: false });
        if (assigned.length) children = assigned;
      }
      // Bound pending work as well as visited nodes; large sibling lists cannot grow an unbounded stack.
      const available = 8000 - budget.nodes - stack.length;
      if (children.length > available) { limit(); truncated = true; }
      for (let index = Math.min(children.length, Math.max(0, available)) - 1; index >= 0; index--) {
        stack.push({ node: children[index], depth: nextDepth });
      }
    }
    return { text: chunks.join(' ').slice(0, maxChars), truncated: truncated || budget.truncated, scannedTextNodes: scanned };
  };
  const hitAt = (x, y) => {
    let root = document;
    let hit = null;
    const seen = new Set();
    for (let depth = 0; depth <= 16; depth++) {
      if (typeof root.elementFromPoint !== 'function') return null;
      const next = root.elementFromPoint(x, y);
      if (!next || seen.has(next)) return null;
      seen.add(next); hit = next;
      if (!hit.shadowRoot) return hit;
      if (!enterRoot(hit.shadowRoot, depth + 1)) return null;
      root = hit.shadowRoot;
    }
    return null;
  };
  const contains = (element, node) => {
    const seen = new Set();
    for (let current = node; current instanceof Element; current = parentOf(current)) {
      if (current === element) return true;
      if (seen.has(current) || seen.size >= 256) return false;
      seen.add(current);
    }
    return false;
  };
  return { budget, candidate, resolveScope, visible, readText, hitAt, contains, parentOf, normalize };
}

function fixedOpenShadowClick(spec, activate, shadow) {
  const scope = shadow.resolveScope(spec.shadowPath || []);
  if (scope.error) return { error: scope.error };
  const nodes = scope.root.querySelectorAll(spec.selector);
  let element = null;
  let offscreen = null;
  let visibleIndex = 0;
  for (let index = 0; index < nodes.length; index++) {
    if (!shadow.candidate()) return { error: 'traversal_limit' };
    const candidate = nodes[index];
    if (!shadow.visible(candidate, 'rendered')) continue;
    if (spec.index !== undefined) {
      if (visibleIndex++ === spec.index) { element = candidate; break; }
      continue;
    }
    if (shadow.visible(candidate, 'viewport')) { element = candidate; break; }
    if (!offscreen) offscreen = candidate;
  }
  element = element || offscreen;
  if (!element) return { error: nodes.length ? 'not_visible' : 'not_found' };
  const matchesExpected = () => {
    if (spec.expectedText === undefined) return true;
    const actual = shadow.readText(element, 162, 200);
    return !actual.truncated && actual.text === spec.expectedText;
  };
  if (!matchesExpected()) return { error: 'text_mismatch' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (!shadow.visible(element, 'viewport') || !matchesExpected()) return { error: 'not_visible_or_changed' };
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const topmost = shadow.hitAt(x, y);
  if (!topmost || !shadow.contains(element, topmost)) return { error: 'occluded' };
  const text = shadow.readText(element, 160, 200);
  if (shadow.budget.truncated) return { error: 'traversal_limit' };
  const summary = { x, y, tag: element.tagName, text: text.text };
  let anchor = element;
  const ancestors = new Set();
  while (anchor instanceof Element && anchor.tagName !== 'A') {
    if (ancestors.has(anchor) || ancestors.size >= 256) return { error: 'traversal_limit' };
    ancestors.add(anchor); anchor = shadow.parentOf(anchor);
  }
  if (anchor && anchor.getAttribute('target') === '_blank') {
    try {
      const href = anchor.getAttribute('href');
      if (!href || !href.trim()) return { error: 'unsupported_link' };
      const destination = new URL(href, document.baseURI);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return { error: 'unsupported_link' };
      return { ...summary, navigationUrl: destination.toString() };
    } catch { return { error: 'unsupported_link' }; }
  }
  if (activate) element.click();
  return summary;
}

// Exact, public content routes only. Authentication and unknown routes retain
// the ordinary high-entropy filtering below, including every query parameter.
function registeredPublicPathSegment(parsed, index) {
  if (index < 2 || index > 4) return false;
  if (parsed.protocol !== 'https:' || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/');
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    return index === 2 && parts.length === 3 && parts[1] === 'post' && /^Ug[A-Za-z0-9_-]{16,70}$/u.test(parts[2]);
  }
  if (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(host)) return false;
  const publicId = value => /^[a-f0-9]{24}$/iu.test(value || '');
  if (parts.length === 3 && parts[1] === 'explore' && publicId(parts[2])) return index === 2;
  if (parts.length === 4 && parts[1] === 'discovery' && parts[2] === 'item' && publicId(parts[3])) return index === 3;
  if (parts[1] === 'user' && parts[2] === 'profile') {
    if (parts.length === 4 && publicId(parts[3])) return index === 3;
    if (parts.length === 5 && publicId(parts[3]) && publicId(parts[4])) return index === 3 || index === 4;
  }
  return false;
}

// Keep public locators only on known routes. Never broaden query retention to
// arbitrary sites: those parameters may carry credentials or signed access.
function registeredPublicQueryKeys(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return new Set(['v', 'list', 'index', 't', 'start', ...(parsed.pathname === '/results' ? ['search_query'] : [])]);
  }
  if (parsed.protocol !== 'https:' || parsed.port) return new Set();
  if (host === 'pbs.twimg.com' && /^\/media\/[A-Za-z0-9_-]{6,128}(?:\.(?:jpg|jpeg|png|webp))?$/u.test(parsed.pathname)) {
    const keys = new Set();
    if (parsed.searchParams.getAll('format').every(value => /^(?:jpg|jpeg|png|webp)$/u.test(value))) keys.add('format');
    if (parsed.searchParams.getAll('name').every(value => /^(?:thumb|small|medium|large|orig|\d{1,4}x\d{1,4})$/u.test(value))) keys.add('name');
    return keys;
  }
  if (host === 'space.bilibili.com' && /^\/\d+\/search(?:\/dynamic)?\/?$/u.test(parsed.pathname)) return new Set(['keyword']);
  if (host === 'music.163.com') {
    if (/^\/(?:artist(?:\/desc|\/album|\/mv)?|song|album|playlist|user\/home)\/?$/u.test(parsed.pathname)) return new Set(['id']);
    if (/^\/search(?:\/m)?\/?$/u.test(parsed.pathname)) return new Set(['s', 'type']);
  }
  if (['facebook.com', 'www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com'].includes(host)) {
    if (parsed.pathname === '/profile.php') return new Set(['id']);
    if (['/permalink.php', '/story.php'].includes(parsed.pathname)) return new Set(['id', 'story_fbid']);
    if (parsed.pathname === '/photo.php') return new Set(['fbid']);
    if (['/watch', '/watch/'].includes(parsed.pathname)) return new Set(['v']);
  }
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host) && parsed.pathname === '/search') return new Set(['q', 'f']);
  if (['instagram.com', 'www.instagram.com'].includes(host) && parsed.pathname === '/explore/search/keyword/') return new Set(['q']);
  if (['skland.com', 'www.skland.com'].includes(host) && parsed.pathname === '/article') return new Set(['id']);
  return new Set();
}

const DOM_QUERY_FUNCTION = `function(spec) {
  const blockedTags = new Set(['SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE','IFRAME','OBJECT','EMBED','INPUT','TEXTAREA','SELECT','OPTION']);
  const shadow = spec.shadowPath?.length ? (${fixedOpenShadowTools.toString()})(blockedTags, spec.visibility || 'rendered') : null;
  const registeredPublicQueryKeys = (${registeredPublicQueryKeys.toString()});
  const registeredPublicPathSegment = (${registeredPublicPathSegment.toString()});
  const cleanText = (value, max) => String(value || '').replace(/\\s+/gu, ' ').trim().slice(0, max);
  const sensitiveValue = (value) => {
    let decoded;
    try { decoded = decodeURIComponent(String(value)); } catch { decoded = String(value); }
    return /(?:^|[^A-Za-z0-9])(?:access|refresh|auth|authorization|bearer|csrf|xsrf|session|secret|password|credential|signature|jwt|token)(?:$|[^A-Za-z0-9])/iu.test(decoded)
      || /^[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}$/u.test(decoded)
      || /^[a-f0-9]{24,}$/iu.test(decoded)
      || /^[A-Za-z0-9_-]{32,}$/u.test(decoded)
      || (decoded.length > 96 && /^[A-Za-z0-9+/_=-]+$/u.test(decoded));
  };
  const publicAttribute = (value, max) => {
    const cleaned = cleanText(value, max);
    return !cleaned || sensitiveValue(cleaned) ? null : cleaned;
  };
  const publicUrl = (raw) => {
    if (!raw) return null;
    try {
      const parsed = new URL(String(raw), document.baseURI);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      const segments = parsed.pathname.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        const previous = index > 0 ? segments[index - 1] : '';
        if (!registeredPublicPathSegment(parsed, index) && (sensitiveValue(segments[index]) || (/^(?:reset|verify|oauth|callback|invite|magic|token|auth)$/iu.test(previous) && segments[index].length >= 16))) segments[index] = '[redacted]';
      }
      parsed.pathname = segments.join('/');
      const publicQueryKeys = registeredPublicQueryKeys(parsed);
      for (const key of [...parsed.searchParams.keys()]) {
        const values = parsed.searchParams.getAll(key);
        if (!publicQueryKeys.has(key.toLowerCase()) || values.some((value) => sensitiveValue(value) || value.length > 512)) parsed.searchParams.delete(key);
      }
      const result = parsed.toString();
      return result.length > 4096 ? parsed.origin + '/[redacted-long-url]' : result;
    } catch { return null; }
  };
  const visibilityCache = new WeakMap();
  const isVisible = (element, mode) => {
    if (shadow) return shadow.visible(element, mode);
    if (!(element instanceof Element)) return false;
    let current = element;
    while (current && current instanceof Element) {
      if (blockedTags.has(current.tagName) || current.isContentEditable || current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      let cached = visibilityCache.get(current);
      if (cached === undefined) {
        const style = getComputedStyle(current);
        cached = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity || 1) !== 0;
        visibilityCache.set(current, cached);
      }
      if (!cached) return false;
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (mode === 'viewport' && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)) return false;
    return true;
  };
  const visibleText = (root, maxChars, maxNodes) => {
    if (shadow) return shadow.readText(root, maxChars, maxNodes);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let length = 0;
    let scanned = 0;
    let truncated = false;
    while (scanned < maxNodes) {
      const node = walker.nextNode();
      if (!node) break;
      scanned += 1;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent, spec.visibility || 'rendered')) continue;
      const text = cleanText(node.nodeValue, maxChars);
      if (!text) continue;
      const remaining = maxChars - length;
      if (remaining <= 0) { truncated = true; break; }
      chunks.push(text.slice(0, remaining));
      length += Math.min(text.length, remaining) + 1;
      if (text.length > remaining || length >= maxChars) { truncated = true; break; }
    }
    if (scanned >= maxNodes) truncated = true;
    return { text: chunks.join(' ').slice(0, maxChars), truncated, scannedTextNodes: scanned };
  };
  if (spec.kind === 'document') {
    return {
      title: cleanText(document.title, 1000),
      url: publicUrl(location.href),
      ready: document.readyState,
      scroll: { x: scrollX, y: scrollY },
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  const resolved = shadow ? shadow.resolveScope(spec.shadowPath) : { root: document };
  if (resolved.error) return { found: false, returned: 0, text: null, items: [], reason: resolved.error, truncated: shadow.budget.truncated };
  const scope = resolved.root;
  if (spec.kind === 'text') {
    const root = scope.querySelector(spec.selector);
    if (!root) return { found: false, text: null };
    if (blockedTags.has(root.tagName)) return { found: false, blocked: true, text: null };
    return { found: true, ...visibleText(root, spec.maxChars, 2500) };
  }
  const nodes = scope.querySelectorAll(spec.selector);
  const items = [];
  let textTruncated = false;
  let scanned = 0;
  for (let index = 0; index < nodes.length && items.length < spec.limit && scanned < 2000; index += 1) {
    scanned += 1;
    if (shadow && !shadow.candidate()) break;
    const element = nodes[index];
    if (blockedTags.has(element.tagName) || !isVisible(element, spec.visibility)) continue;
    const item = {};
    for (const field of spec.fields) {
      if (field === 'tag') item.tag = element.tagName;
      else if (field === 'text') {
        const result = visibleText(element, 1000, 200);
        item.text = result.text;
        item.text_truncated = result.truncated;
        textTruncated ||= result.truncated;
      }
      else if (field === 'href') item.href = publicUrl(element.getAttribute('href'));
      else if (field === 'src') item.src = publicUrl(element.getAttribute('src'));
      else if (field === 'poster') item.poster = publicUrl(element.getAttribute('poster'));
      else if (field === 'title') item.title = publicAttribute(element.getAttribute('title'), 1000);
      else if (field === 'ariaLabel') item.ariaLabel = publicAttribute(element.getAttribute('aria-label'), 1000);
      else if (field === 'alt') item.alt = publicAttribute(element.getAttribute('alt'), 1000);
      else if (field === 'role') item.role = publicAttribute(element.getAttribute('role'), 200);
      else if (field === 'dateTime') item.dateTime = publicAttribute(element.getAttribute('datetime'), 200);
      else if (field === 'lang') item.lang = publicAttribute(element.getAttribute('lang'), 100);
      else if (field === 'rel') item.rel = publicAttribute(element.getAttribute('rel'), 200);
      else if (field === 'target') item.target = publicAttribute(element.getAttribute('target'), 100);
      else if (field === 'type') item.type = publicAttribute(element.getAttribute('type'), 100);
    }
    items.push(item);
  }
  return { returned: items.length, truncated: textTruncated || scanned < nodes.length || items.length >= spec.limit || Boolean(shadow?.budget.truncated), items };
}`;

const CLICK_FUNCTION = `function(locator, activate) {
  if (typeof locator !== 'string') {
    const blockedTags = new Set(['SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE','IFRAME','OBJECT','EMBED','INPUT','TEXTAREA','SELECT','OPTION']);
    const shadow = (${fixedOpenShadowTools.toString()})(blockedTags, 'rendered');
    return (${fixedOpenShadowClick.toString()})(locator, activate, shadow);
  }
  const selector = locator;
  const candidates = document.querySelectorAll(selector);
  const blocked = new Set(['SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE','IFRAME','OBJECT','EMBED','INPUT','TEXTAREA','SELECT','OPTION']);
  if (!candidates.length) return { error: 'not_found' };
  let element = null;
  let offscreen = null;
  for (let index = 0; index < candidates.length && index < 2000; index += 1) {
    const candidate = candidates[index];
    let current = candidate;
    let allowed = true;
    while (current && current instanceof Element) {
      if (blocked.has(current.tagName) || current.isContentEditable || current.hidden || current.getAttribute('aria-hidden') === 'true') { allowed = false; break; }
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity || 1) === 0) { allowed = false; break; }
      current = current.parentElement;
    }
    if (!allowed) continue;
    const bounds = candidate.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0 && bounds.x < innerWidth && bounds.y < innerHeight) {
      element = candidate;
      break;
    }
    if (!offscreen) offscreen = candidate;
  }
  element = element || offscreen;
  if (!element) return { error: 'not_visible' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { error: 'not_visible' };
  const topmost = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!topmost || (topmost !== element && !element.contains(topmost))) return { error: 'occluded' };
  const summary = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: element.tagName, text: String(element.innerText || '').replace(/\\s+/gu, ' ').trim().slice(0, 160) };
  // Follow ordinary new-tab links inside the leased page. The raw destination
  // stays inside the broker; it is never returned in a DOM/tool response.
  let anchor = element;
  while (anchor && anchor instanceof Element && anchor.tagName !== 'A') anchor = anchor.parentElement;
  if (anchor && anchor.getAttribute('target') === '_blank') {
    try {
      const href = anchor.getAttribute('href');
      if (!href || !href.trim()) return { error: 'unsupported_link' };
      const destination = new URL(href, document.baseURI);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return { error: 'unsupported_link' };
      return { ...summary, navigationUrl: destination.toString() };
    } catch { return { error: 'unsupported_link' }; }
  }
  if (activate) element.click();
  return summary;
}`;

const SCROLL_FUNCTION = `function(direction, amount, selector = null) {
  const root = document.scrollingElement || document.documentElement;
  let pane = null;
  const centerX = Math.floor(innerWidth / 2), centerY = Math.floor(innerHeight / 2);
  let current = null;
  let centerHit = null;
  if (selector !== null) {
    const blocked = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
    const visibleOrdinary = element => {
      if (!element || blocked.has(element.tagName)) return false;
      let node = element, depth = 0;
      while (node) {
        if (++depth > 256 || blocked.has(node.tagName) || node.isContentEditable
          || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || Number(style.opacity || 1) <= 0) return false;
        node = node.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    let matches;
    try { matches = document.querySelectorAll(selector); }
    catch { return { error: 'scroll_selector_invalid' }; }
    if (matches.length > 2000) return { error: 'scroll_selector_limit' };
    for (const element of matches) {
      if (!visibleOrdinary(element)) continue;
      if (current) return { error: 'scroll_target_ambiguous' };
      current = element;
    }
    if (!current) return { error: 'scroll_target_not_found' };
  } else {
    current = document.elementFromPoint(centerX, centerY);
    centerHit = current;
  }
  // Follow the visible content pane, not unrelated sidebars or hidden nodes.
  // Keep the same pane at its end; falling through would scroll another area.
  while (current && current !== root) {
    const style = getComputedStyle(current);
    const rect = current.getBoundingClientRect();
    if (!current.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName)
      && !current.hidden && current.getAttribute('aria-hidden') !== 'true'
      && style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && Number(style.opacity || 1) > 0
      && /^(auto|scroll|overlay)$/.test(style.overflowY)
      && current.scrollHeight > current.clientHeight + 1
      && rect.width > 0 && rect.height > 0) {
      pane = current;
      break;
    }
    current = current.parentElement;
  }
  const scroller = pane || root;
  const before = Number(scroller.scrollTop || 0);
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (selector !== null && !pane && maximum <= 1) return { error: 'scroll_target_not_scrollable' };
  const next = direction === 'top' ? 0 : direction === 'bottom' ? maximum
    : Math.max(0, Math.min(maximum, before + (direction === 'up' ? -amount : amount)));
  if (pane) pane.scrollTo({ top: next, left: pane.scrollLeft, behavior: 'instant' });
  else window.scrollTo({ top: next, left: scrollX, behavior: 'instant' });
  const y = Number(scroller.scrollTop || 0);
  const position = { target: pane ? 'element' : 'window', x: Number(scroller.scrollLeft || 0), y,
    moved: y !== before, atStart: y <= 1, atEnd: y >= maximum - 1 };
  // Only a non-scrollable outer window may hand a visible iframe one native
  // wheel event. Never leave an existing pane at its end or enter frame DOM.
  if (selector === null && !pane && maximum <= 1 && !position.moved && centerHit && centerHit.tagName === 'IFRAME') {
    const rect = centerHit.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0 && centerX >= rect.left && centerX < rect.right
      && centerY >= rect.top && centerY < rect.bottom;
    for (let node = centerHit; visible && node; node = node.parentElement) {
      const style = getComputedStyle(node);
      visible = !node.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)
        && !node.hidden && node.getAttribute('aria-hidden') !== 'true'
        && style.display !== 'none' && style.visibility !== 'hidden'
        && style.visibility !== 'collapse' && Number(style.opacity || 1) > 0;
      if (node === root) break;
    }
    if (visible) position.iframeWheelCandidate = { x: centerX, y: centerY,
      viewportWidth: innerWidth, viewportHeight: innerHeight };
  }
  return position;
}`;

async function scrollPositionUnlocked(targetId, direction, amount, {
  deadline, selector = null, fixedFunction = callFixedFunctionUnlocked, command = targetCommandUnlocked,
} = {}) {
  const args = selector === null ? [direction, amount] : [direction, amount, selector];
  const result = await fixedFunction(targetId, SCROLL_FUNCTION, args, {
    deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true,
  });
  const position = result.result?.value ?? null;
  if (position?.error) {
    const messages = {
      scroll_selector_limit: '滚动选择器匹配过多，未执行滚动。',
      scroll_selector_invalid: '滚动选择器语法无效，未执行滚动。',
      scroll_target_ambiguous: '滚动选择器须恰好匹配一个可见普通DOM目标。',
      scroll_target_not_found: '滚动选择器没有可见普通DOM目标。',
      scroll_target_not_scrollable: '指定目标及其祖先没有可滚动区域。',
    };
    const code = Object.hasOwn(messages, position.error) ? position.error : 'scroll_target_unavailable';
    throw new BrokerError(code, messages[code] || '指定滚动目标不可用。', { targetId }, 409);
  }
  const point = position?.iframeWheelCandidate;
  if (selector !== null && point) throw new BrokerError('scroll_selector_unsafe_result', '指定目标滚动不得产生iframe输入。', { targetId }, 502);
  if (!point) return position;
  if (!['up', 'down'].includes(direction) || !Number.isInteger(amount) || amount < 1 || amount > 800) {
    throw new BrokerError('iframe_requires_incremental_scroll', '可见iframe只允许每次1—800px的up/down增量滚动。', { targetId }, 400);
  }
  if (![point.x, point.y, point.viewportWidth, point.viewportHeight].every(Number.isInteger)
      || point.viewportWidth < 1 || point.viewportHeight < 1
      || point.x !== Math.floor(point.viewportWidth / 2) || point.y !== Math.floor(point.viewportHeight / 2)) {
    throw new BrokerError('invalid_scroll_point', '固定iframe滚动中心无效；未发送输入。', { targetId }, 502);
  }
  await command(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: direction === 'up' ? -amount : amount,
  }, { deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true });
  const { iframeWheelCandidate: _privatePoint, ...outerPosition } = position;
  return { ...outerPosition, target: 'iframe', x: null, y: null, moved: null, atStart: null, atEnd: null,
    wheelDispatched: true, motionConfirmed: false };
}

async function callFixedFunctionUnlocked(targetId, functionDeclaration, args, { deadline, timeoutMs = BUDGETS.dom, retrySession = true, sideEffect = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let sessionId = null;
    try {
      sessionId = await ensureSession(targetId, deadline);
      const executionContextId = await fixedWorlds.resolve(targetId, sessionId, deadline);
      // callFunctionOn has no protocol timeout parameter. The broker deadline
      // bounds waiting, not remote execution; timeout quarantine must persist.
      return await sendCdp('Runtime.callFunctionOn', {
        functionDeclaration,
        executionContextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      }, { sessionId, targetId, timeoutMs, deadline });
    } catch (error) {
      const contextInvalid = error?.code === 'isolated_context_changed' || /Cannot find context|Execution context.*destroyed|Inspected target navigated/iu.test(String(error?.message || ''));
      if (sideEffect && (isOutcomeUnknownError(error) || contextInvalid)) {
        await quarantineTimedOutTarget(targetId, sessionId, error);
        throw new BrokerError('outcome_unknown', '页面动作可能已生效但执行上下文或响应已丢失；已隔离 target，禁止自动重放。', { targetId, cause: error?.code || null }, 409);
      }
      if (['cdp_timeout', 'request_timeout', 'request_aborted'].includes(error?.code)) {
        await quarantineTimedOutTarget(targetId, sessionId, error);
        throw error;
      }
      if (retrySession && attempt === 0 && contextInvalid) {
        fixedWorlds.invalidate(targetId, sessionId);
        continue; // Same session; do not leak an attached session on a document change.
      }
      if (retrySession && attempt === 0 && isSessionInvalidError(error)) {
        if (sessionId) clearSessionByTarget(targetId, 'session_invalid', sessionId);
        continue;
      }
      throw error;
    }
  }
  throw new BrokerError('dom_query_failed', '固定 DOM 查询重试后仍失败。', { targetId }, 502);
}

async function pageTargets(deadline) {
  const result = await sendCdp('Target.getTargets', {}, { timeoutMs: BUDGETS.metadata, deadline });
  const targets = (result.targetInfos || []).filter((item) => item.type === 'page');
  const liveTargetIds = new Set(targets.map((item) => item.targetId));
  for (const targetId of liveTargetIds) destroyedTargets.delete(targetId);
  for (const [targetId, destroyedAt] of destroyedTargets) {
    if (Date.now() - destroyedAt > IDEMPOTENCY_TTL_MS) destroyedTargets.delete(targetId);
  }
  for (const targetId of new Set([...leases.keys(), ...managedTabs.keys(), ...orphanCreationTargets.keys(), ...quarantinedTargets.keys()])) {
    if (!liveTargetIds.has(targetId)) forgetDestroyedTargetState(targetId, 'target_destroyed');
  }
  // Target.getTargets may expose a child before the asynchronous
  // Target.targetCreated event is delivered. Classify explicit controlled
  // opener relationships from this authoritative snapshot so /targets cannot
  // advertise the child as available during that event-ordering gap.
  for (const target of targets) trackDerivedTaskTarget(target);
  reserveAuthenticOrphanTargets(targets);
  return targets;
}

async function assertTargetExists(targetId, deadline) {
  if (destroyedTargets.has(targetId)) {
    forgetDestroyedTargetState(targetId, 'target_destroyed');
    throw new BrokerError('target_destroyed', 'target 已被 Edge 销毁。', { targetId }, 404);
  }
  let result;
  try {
    result = await sendCdp('Target.getTargetInfo', { targetId }, { targetId, timeoutMs: BUDGETS.metadata, deadline });
  } catch (error) {
    if (error?.details?.method === 'Target.getTargetInfo' && isTargetGoneCdpError(error)) {
      forgetDestroyedTargetState(targetId, 'target_destroyed');
      throw new BrokerError('target_destroyed', 'target 已被 Edge 销毁。', { targetId }, 404);
    }
    throw error;
  }
  if (destroyedTargets.has(targetId)) {
    forgetDestroyedTargetState(targetId, 'target_destroyed');
    throw new BrokerError('target_destroyed', 'target 已被 Edge 销毁。', { targetId }, 404);
  }
  if (result.targetInfo?.type !== 'page') throw new BrokerError('invalid_target', 'target 不存在或不是页面。', { targetId }, 404);
  return result.targetInfo;
}

async function snapshotPreexistingChildTargetIds(openerId, deadline) {
  const result = await sendCdp('Target.getTargets', {}, { timeoutMs: BUDGETS.metadata, deadline });
  return new Set(
    (result.targetInfos || [])
      .filter((target) => target?.type === 'page' && target?.targetId && target?.openerId === openerId)
      .map((target) => target.targetId),
  );
}

async function waitForTargetDemarked(targetId, markerUrl, deadline) {
  const stopAt = Date.now() + Math.min(1500, deadline.remaining('creation marker removal'));
  let lastUrl = markerUrl;
  do {
    const targetInfo = await assertTargetExists(targetId, deadline);
    lastUrl = targetInfo.url;
    if (lastUrl !== markerUrl && !isAuthenticBrokerMarker(lastUrl)) return targetInfo;
    if (Date.now() >= stopAt) break;
    await sleep(Math.min(75, Math.max(1, stopAt - Date.now())));
  } while (Date.now() < stopAt);
  throw new BrokerError(
    'target_still_marked',
    'Edge 尚未确认任务页已离开内部创建标记；不得发布 lease。请用同一 request id 重试。',
    { targetId },
    409,
  );
}

function sameLease(left, right) {
  return Boolean(left && right && left.epoch === right.epoch && safeEqualToken(left.token, right.token));
}

function ensureManagedTaskTarget(targetId, owner, metadata = {}) {
  const existing = managedTabs.get(targetId);
  if (existing) {
    if (existing.owner !== owner) {
      throw new BrokerError('target_reserved', '该 broker 自建页面属于另一项任务。', { targetId }, 409);
    }
    const updated = { ...existing, ...metadata };
    managedTabs.set(targetId, updated);
    return updated;
  }
  const created = {
    owner,
    manageToken: randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
    ...metadata,
  };
  managedTabs.set(targetId, created);
  return created;
}

async function replayCompletedNewLease({ key, existing, owner, deadline }) {
  const previous = existing?.result;
  const targetId = previous?.targetId;
  const managed = targetId ? managedTabs.get(targetId) : null;
  if (!targetId || !managed || managed.owner !== owner) {
    idempotencyRecords.delete(key);
    throw new BrokerError('target_destroyed', '原幂等 new 对应的任务页已不存在。', { targetId: targetId || null }, 404);
  }

  try {
    const targetInfo = await assertTargetExists(targetId, deadline);
    if (isAuthenticBrokerMarker(targetInfo.url)) {
      throw new BrokerError('target_still_marked', '原幂等 new 仍处于内部初始化状态，不能重放完成结果。', { targetId }, 409);
    }
    assertNoExternalDebugger(targetInfo);
  } catch (error) {
    if (error?.code === 'target_destroyed') {
      clearSessionByTarget(targetId, 'target_destroyed');
      leases.delete(targetId);
      managedTabs.delete(targetId);
      quarantinedTargets.delete(targetId);
      contextVersions.delete(targetId);
      stalledTargets.delete(targetId);
      invalidateTargetIdempotency(targetId);
    }
    throw error;
  }

  let lease = leases.get(targetId);
  if (lease && leaseExpired(lease)) {
    throw new BrokerError('lease_expired', '原任务页 lease 已过期；等待安全清理后用同一 request id 重试。', { targetId }, 409);
  }
  if (lease && lease.owner !== owner) {
    throw new BrokerError('lease_conflict', '原任务页当前由另一条路线占用。', { targetId }, 409);
  }
  if (!lease) lease = acquireLease(targetId, owner, true, true);
  if (!lease.createdByBroker) {
    throw new BrokerError('lease_conflict', '原任务页当前 lease 不具备管理 capability。', { targetId }, 409);
  }

  const refreshed = {
    ...previous,
    targetId,
    leaseToken: lease.token,
    leaseEpoch: lease.epoch,
    acquiredAt: lease.acquiredAt,
    manageToken: managed.manageToken,
  };
  storeIdempotency(key, {
    operation: 'new',
    fingerprint: existing.fingerprint,
    status: 'complete',
    targetId,
    result: refreshed,
  });
  return refreshed;
}

async function replayCompletedAcquireLease({ key, existing, owner, manageToken, deadline }) {
  const result = existing?.result;
  const targetId = result?.targetId;
  const lease = targetId ? leases.get(targetId) : null;
  if (!targetId || !lease || leaseExpired(lease)) {
    idempotencyRecords.delete(key);
    throw new BrokerError('lease_required', '原幂等 acquire 的 lease 已不存在；请使用新的 request id。', { targetId: targetId || null }, 409);
  }
  if (lease.owner !== owner || lease.epoch !== result.leaseEpoch || !safeEqualToken(result.leaseToken, lease.token)) {
    throw new BrokerError('lease_conflict', '原幂等 acquire 的 target 已由其他 lease 占用。', { targetId }, 409);
  }
  const managed = managedTabs.get(targetId);
  if (managed && !manageToken) {
    throw new BrokerError('manage_token_required', '重放 broker 自建页面的 acquire 需要 X-CDP-Manage capability。', { targetId }, 409);
  }
  if (managed && !safeEqualToken(manageToken, managed.manageToken)) {
    throw new BrokerError('manage_token_conflict', 'X-CDP-Manage capability 与该 broker 自建页面不匹配。', { targetId }, 403);
  }
  try {
    const targetInfo = await assertTargetExists(targetId, deadline);
    assertNoExternalDebugger(targetInfo);
  } catch (error) {
    if (error?.code === 'target_destroyed') {
      clearSessionByTarget(targetId, 'target_destroyed');
      leases.delete(targetId);
      managedTabs.delete(targetId);
      quarantinedTargets.delete(targetId);
      contextVersions.delete(targetId);
      stalledTargets.delete(targetId);
      invalidateTargetIdempotency(targetId);
    }
    throw error;
  }
  lease.lastUsedAt = Date.now();
  return result;
}

function internalNewLease(targetId, owner) {
  const existing = leases.get(targetId);
  if (!existing) return acquireLease(targetId, owner, true, true);
  if (leaseExpired(existing)) {
    throw new BrokerError('lease_expired', '任务页的内部初始化 lease 已过期，等待安全清理后请用相同 request id 重试。', { targetId }, 409);
  }
  if (existing.owner !== owner || !existing.createdByBroker) {
    throw new BrokerError('lease_conflict', '任务页在初始化期间被另一 lease 域占用。', { targetId }, 409);
  }
  existing.lastUsedAt = Date.now();
  return existing;
}

async function initializePendingNewTarget({ key, owner, requestId, fingerprint, markerUrl, targetUrl, targetId, deadline, recovered }) {
  return await queueForTarget(targetId, deadline, async () => {
    const current = idempotencyRecords.get(key);
    if (current?.status === 'complete') return current.result;
    if (current?.status !== 'pending' || current.markerUrl !== markerUrl || current.targetId && current.targetId !== targetId) {
      throw new BrokerError('operation_state_changed', '幂等 new 请求的内部状态已变化，拒绝发布 lease。', { requestId, targetId }, 409);
    }

    const reservation = pendingCreationMarkers.get(markerUrl);
    if (reservation?.owner !== owner || reservation?.requestId !== requestId || !isAuthenticBrokerMarker(markerUrl)) {
      throw new BrokerError('target_reserved', '幂等 new 标记不再属于当前请求，拒绝恢复或接管该 target。', { requestId, targetId }, 409);
    }

    let liveTarget = await assertTargetExists(targetId, deadline);
    if (isAuthenticBrokerMarker(liveTarget.url) && liveTarget.url !== markerUrl) {
      throw new BrokerError('target_reserved', 'target 带有另一项受认证的创建标记，拒绝接管。', { requestId, targetId }, 409);
    }
    assertNoExternalDebugger(liveTarget);
    const managed = ensureManagedTaskTarget(targetId, owner, recovered ? { recovered: true } : {});
    const lease = internalNewLease(targetId, owner);
    pendingCreationMarkers.set(markerUrl, { ...reservation, targetId });
    storeIdempotency(key, { operation: 'new', fingerprint, status: 'pending', markerUrl, targetId });

    if (liveTarget.url === markerUrl) {
      await targetCommandUnlocked(targetId, 'Page.enable', {}, { deadline, timeoutMs: BUDGETS.dom });
      // A lease is never exposed while this authenticated marker remains in
      // the address bar. This applies to about:blank destinations as well.
      await targetCommandUnlocked(targetId, 'Page.navigate', { url: targetUrl }, {
        deadline,
        timeoutMs: BUDGETS.navigation,
        retrySession: false,
        sideEffect: true,
      });
      await sleep(Math.min(isHeavySpa(targetUrl) ? 350 : 700, deadline.remaining('new target settle')));
    }

    liveTarget = await waitForTargetDemarked(targetId, markerUrl, deadline);
    const currentLease = leases.get(targetId);
    if (!sameLease(currentLease, lease) || destroyedTargets.has(targetId)) {
      invalidateTargetIdempotency(targetId);
      throw new BrokerError('target_destroyed', '新建 Edge target 在初始化期间已消失；未发布失效 lease。', { targetId }, 502);
    }

    managedTabs.set(targetId, { ...managed, ...(recovered ? { recovered: true } : {}) });
    pendingCreationMarkers.delete(markerUrl);
    quarantinedTargets.delete(targetId);
    const payload = {
      targetId,
      leaseToken: lease.token,
      leaseEpoch: lease.epoch,
      acquiredAt: lease.acquiredAt,
      manageToken: managed.manageToken,
      requestId,
      url: sanitizePublicUrl(targetUrl),
      ready: true,
      ...(recovered ? { recovered: true } : {}),
    };
    storeIdempotency(key, { operation: 'new', fingerprint, status: 'complete', targetId, result: payload });
    return payload;
  });
}

function assertNoExternalDebugger(targetInfo) {
  if (targetInfo?.attached && !sessions.has(targetInfo.targetId)) {
    throw new BrokerError(
      'external_debugger_present',
      '该页面已被 DevTools 或其他调试控制器占用；请关闭该页的 DevTools，并且不要让 Codex 扩展与 broker 同时控制同一页面。',
      { targetId: targetInfo.targetId },
      409,
    );
  }
}

function isHeavySpa(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'x.com' || host.endsWith('.instagram.com');
  } catch { return false; }
}

function looksSensitiveUrlValue(value) {
  let decoded;
  try { decoded = decodeURIComponent(String(value)); } catch { decoded = String(value); }
  return /(?:^|[^A-Za-z0-9])(?:access|refresh|auth|authorization|bearer|csrf|xsrf|session|secret|password|credential|signature|jwt|token)(?:$|[^A-Za-z0-9])/iu.test(decoded)
    || /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u.test(decoded)
    || /^[a-f0-9]{24,}$/iu.test(decoded)
    || /^[A-Za-z0-9_-]{32,}$/u.test(decoded)
    || decoded.length > 96 && /^[A-Za-z0-9+/_=-]+$/u.test(decoded);
}

function sanitizePublicUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:', 'mailto:', 'about:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    const segments = parsed.pathname.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const previous = index > 0 ? segments[index - 1] : '';
      if (!registeredPublicPathSegment(parsed, index) && (looksSensitiveUrlValue(segments[index]) || /^(?:reset|verify|oauth|callback|invite|magic|token|auth)$/iu.test(previous) && segments[index].length >= 16)) {
        segments[index] = '[redacted]';
      }
    }
    parsed.pathname = segments.join('/');
    const publicQueryKeys = registeredPublicQueryKeys(parsed);
    for (const key of [...parsed.searchParams.keys()]) {
      const values = parsed.searchParams.getAll(key);
      if (!publicQueryKeys.has(key.toLowerCase()) || values.some((value) => looksSensitiveUrlValue(value) || value.length > 512)) parsed.searchParams.delete(key);
    }
    const result = parsed.toString();
    if (result.length > 4096) return parsed.protocol === 'about:' ? 'about:blank' : `${parsed.origin}/[redacted-long-url]`;
    return result;
  } catch { return null; }
}

function sanitizeResearchSnapshot(value) {
  if (Array.isArray(value)) return value.map(sanitizeResearchSnapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeResearchSnapshot(entry)]));
  if (typeof value === 'string' && /^https?:\/\//iu.test(value)) return sanitizePublicUrl(value);
  return value;
}

function sanitizePopupDestination(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return sanitizePublicUrl(rawUrl);
  } catch { return null; }
}

function publicOrigin(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

async function releaseTargetUnlocked(targetId, owner, leaseToken, deadline) {
  requireLease(targetId, owner, leaseToken, { allowQuarantined: true });
  const sessionId = sessions.get(targetId);
  if (sessionId) await detachSessionOrRetire(targetId, sessionId, deadline, 1000);
  clearSessionByTarget(targetId, 'lease_released');
  leases.delete(targetId);
  // Releasing ownership does not prove the timed-out page recovered.
  // Keep its quarantine across reacquisition; only explicit successful
  // recovery or confirmed target destruction may clear it.
  stalledTargets.delete(targetId);
  invalidateTargetIdempotency(targetId, { keepManagedNew: true });
}

async function closeManagedTargetUnlocked(targetId, owner, leaseToken, deadline) {
  const lease = requireLease(targetId, owner, leaseToken, { allowQuarantined: true });
  if (!lease.createdByBroker || !managedTabs.has(targetId)) {
    throw new BrokerError('close_not_allowed', '只允许关闭当前 broker 为该任务创建的 target；既有用户页只能 release。', { targetId }, 403);
  }
  const closing = { destroyed: false };
  closingTargets.set(targetId, closing);
  try {
    let result = null;
    try {
      result = await sendCdp('Target.closeTarget', { targetId }, { targetId, timeoutMs: BUDGETS.metadata, deadline });
    } catch (error) {
      if (isTargetGoneCdpError(error)) {
        closing.destroyed = true;
        forgetDestroyedTargetState(targetId, 'target_destroyed');
      } else if (!closing.destroyed) {
        quarantinedTargets.set(targetId, { code: 'outcome_unknown', method: 'Target.closeTarget', at: new Date().toISOString() });
        throw new BrokerError('outcome_unknown', '关闭任务页的结果未知；已隔离 target，禁止自动重放。', { targetId, cause: error?.code || null }, 409);
      }
    }
    if (result?.success !== true && !closing.destroyed) {
      // Edge may report success:false when a page disappeared while the
      // broker was disconnected and therefore emitted no targetDestroyed
      // event. Confirm whether it is truly still live before retaining a slot.
      try {
        await assertTargetExists(targetId, deadline);
      } catch (error) {
        if (error?.code === 'target_destroyed') closing.destroyed = true;
        else throw error;
      }
      if (!closing.destroyed) {
        throw new BrokerError('close_failed', 'Edge 未确认关闭 broker 自建任务页。', { targetId }, 502);
      }
    }
  } finally {
    closingTargets.delete(targetId);
  }
  const sessionId = sessions.get(targetId);
  if (sessionId) clearSessionByTarget(targetId, 'target_finalized', sessionId);
  leases.delete(targetId);
  managedTabs.delete(targetId);
  quarantinedTargets.delete(targetId);
  contextVersions.delete(targetId);
  stalledTargets.delete(targetId);
  invalidateTargetIdempotency(targetId);
}

async function recoverTargetUnlocked(targetId, owner, leaseToken, deadline) {
  const lease = requireLease(targetId, owner, leaseToken, { allowQuarantined: true });
  const epoch = lease.epoch;
  const oldSessionId = sessions.get(targetId);
  if (oldSessionId && isOpen(browserSocket)) {
    const detached = await detachSessionOrRetire(targetId, oldSessionId, deadline, 700);
    clearSessionByTarget(targetId, 'target_recovering', oldSessionId);
    if (detached.status === 'connection_retired') await connectBrowser(deadline);
  }
  const result = await callFixedFunctionUnlocked(targetId, 'function(){return {title:String(document.title||\"\").slice(0,1000),ready:document.readyState}}', [], {
    deadline,
    timeoutMs: BUDGETS.dom,
  });
  deadline.remaining('target recovery result');
  const page = result?.result?.value;
  if (result?.exceptionDetails) {
    throw new BrokerError('recovery_probe_failed', '固定恢复健康检查抛出异常；保留 target 隔离状态。', { targetId, reason: 'runtime_exception' }, 502);
  }
  if (!page || typeof page !== 'object' || Array.isArray(page)
      || typeof page.title !== 'string' || page.title.length > 1000
      || !['loading', 'interactive', 'complete'].includes(page.ready)) {
    throw new BrokerError('recovery_probe_failed', '固定恢复健康检查未返回有效页面状态；保留 target 隔离状态。', { targetId, reason: 'invalid_health' }, 502);
  }
  const current = requireLease(targetId, owner, leaseToken, { allowQuarantined: true });
  if (current.epoch !== epoch) {
    throw new BrokerError('lease_changed', '恢复期间 target lease 已变化。', { targetId }, 409);
  }
  quarantinedTargets.delete(targetId);
  return page;
}

function routeBudget(pathname) {
  if (['/info', '/dom/query', '/research/snapshot'].includes(pathname)) return BUDGETS.read;
  if (pathname === '/activate') return BUDGETS.dom;
  if (['/targets', '/acquire', '/release'].includes(pathname)) return BUDGETS.metadata;
  if (['/new', '/navigate', '/back', '/screenshot', '/close', '/finalize', '/recover'].includes(pathname)) return BUDGETS.navigation;
  return BUDGETS.dom;
}

// Content-free timing distinguishes queue/attachment failures from a sent
// screenshot awaiting Edge. A deadline only stops our wait, not remote work.
let lastScreenshot = null;
async function captureScreenshotUnlocked(targetId, format, deadline) {
  const attempt = { targetId, format, startedAt: new Date().toISOString(), status: 'running', stage: 'capture', elapsedMs: 0 };
  lastScreenshot = attempt;
  const started = Date.now();
  try {
    const result = await targetCommandUnlocked(targetId, 'Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 80 } : {}),
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    }, { deadline, timeoutMs: BUDGETS.screenshot });
    const bytes = Buffer.from(result.data || '', 'base64');
    if (!bytes.length) throw new BrokerError('screenshot_failed', 'Edge 未返回截图数据。', { targetId }, 502);
    attempt.status = 'complete';
    attempt.byteLength = bytes.length;
    return bytes;
  } catch (error) {
    attempt.status = 'failed';
    attempt.errorCode = error?.code || 'screenshot_failed';
    attempt.stage = error?.details?.method === 'Page.captureScreenshot' ? 'edge_response' : 'capture_or_attach';
    attempt.quarantined = quarantinedTargets.has(targetId);
    throw error;
  } finally {
    attempt.elapsedMs = Date.now() - started;
  }
}

async function handleHttpRequest(request, response) {
  let parsed;
  try { parsed = new URL(request.url || '/', `http://${HOST}:${PORT}`); } catch {
    throw new BrokerError('invalid_request_target', 'HTTP request-target 不是有效 URL。', undefined, 400);
  }
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);
  const requestDeadline = deadlineAfter(REQUEST_TIMEOUT_MS);
  const absoluteTimer = setTimeout(() => {
    requestDeadline.cancel('request_timeout');
    if (!response.writableEnded) {
      try { fail(response, new BrokerError('request_timeout', `HTTP 请求超过 ${REQUEST_TIMEOUT_MS}ms 的绝对预算。`, { budgetMs: REQUEST_TIMEOUT_MS }, 504)); } catch {}
    }
    request.destroy();
  }, REQUEST_TIMEOUT_MS);
  response.once('finish', () => clearTimeout(absoluteTimer));
  response.once('close', () => {
    clearTimeout(absoluteTimer);
    if (!response.writableFinished) requestDeadline.cancel('request_aborted');
  });
  request.once('aborted', () => requestDeadline.cancel('request_aborted'));
  // A fully received GET may never emit IncomingMessage.aborted when the
  // caller disappears while CDP is still running. Observe the transport too,
  // but only cancel before the response has actually finished.
  const onTransportClose = () => {
    if (!response.writableFinished) requestDeadline.cancel('request_aborted');
  };
  request.socket.once('close', onTransportClose);
  response.once('finish', () => request.socket.off('close', onTransportClose));
  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    requestDeadline.cancel('request_timeout');
    if (!response.writableEnded) request.destroy();
  });
    if (pathname === '/health') {
      ok(response, {
        service: SERVICE_NAME,
        capabilities: ['target-quarantine-lifetime-v1', 'renderer-read-budget-v2', 'isolated-context-reuse-v1', 'research-recipe-reload-v1', 'bilibili-body-container-v3', 'bilibili-attribution-v2', 'research-dom-window-v2', 'element-text-completeness-v1', 'visible-same-origin-frame-v1', 'scroll-selector-v1', 'iframe-center-wheel-v1', 'click-popup-urls-v1', 'leased-page-activate-v1', 'visible-open-shadow-v1', 'public-xhs-route-ids-v1', 'public-route-query-ids-v1', 'research-dom-snapshot-v1'],
        connection: { state: connectionState, approvalRequired: lastConnectError?.code === 'approval_required', lastErrorCode: lastConnectError?.code || null, lastCommandTimeout:lastCdpTimeout },
        screenshot: { timeoutMs: BUDGETS.screenshot, last: lastScreenshot },
        leases: leases.size,
        sessions: sessions.size,
        taskPages: { active: activeTaskPageCount(), limit: MAX_ACTIVE_TASK_PAGES },
      });
    return;
  }
  try {
    authorize(request);
    cleanupIdempotencyRecords();
    const owner = requestOwner(request, query, true);
    await connectBrowser(requestDeadline);
    await cleanupExpiredLeases(requestDeadline);
    if (!isOpen(browserSocket)) await connectBrowser(requestDeadline);
    const deadline = deadlineAfter(routeBudget(pathname), requestDeadline);

    if (pathname === '/targets' && request.method === 'GET') {
      const targets = await pageTargets(deadline);
      ok(response, { targets: targets.map((target) => {
        const lease = leases.get(target.targetId);
        const reservation = pendingCreationMarkers.get(target.url);
        const leaseState = lease || reservation || managedTabs.has(target.targetId) || orphanCreationTargets.has(target.targetId) ? 'busy' : 'available';
        return {
          targetId: target.targetId,
          title: null,
          url: publicOrigin(target.url),
          attached: leaseState === 'available' ? Boolean(target.attached) : null,
          lease: leaseState,
          externalDebugger: leaseState === 'available' ? Boolean(target.attached && !sessions.has(target.targetId)) : null,
          quarantined: null,
        };
      }) });
      return;
    }
    if (pathname === '/acquire' && request.method === 'POST') {
      await sweepOrphanCreationTargets(deadline);
      await sweepUnclaimedDerivedTargets(deadline);
      const requestId = requestIdempotencyKey(request);
      const manageToken = requestManageToken(request);
      const fingerprint = opaqueFingerprint(['acquire', query.target]);
      const { key, existing } = idempotencyRecord(owner, requestId, 'acquire', fingerprint);
      if (existing?.status === 'complete') {
        await queueForTarget(
          query.target,
          deadline,
          async () => {
            const replay = await replayCompletedAcquireLease({ key, existing, owner, manageToken, deadline });
            ok(response, { ...replay, replayed: true });
          },
        );
        return;
      }
      if (!existing) storeIdempotency(key, { operation: 'acquire', fingerprint, status: 'pending' });
      try {
        await queueForTarget(query.target, deadline, async () => {
          const current = idempotencyRecords.get(key);
          if (current?.status === 'complete') {
            const replay = await replayCompletedAcquireLease({ key, existing: current, owner, manageToken, deadline });
            ok(response, { ...replay, replayed: true });
            return;
          }
          const destroyedBeforeAcquire = destroyedTargets.has(query.target);
          let lease = null;
          try {
            const targetInfo = await assertTargetExists(query.target, deadline);
            // Close the targetCreated delivery race: a directly queried child
            // with an explicit controlled opener is reserved before any lease
            // can be issued, even when its discovery event is still pending.
            trackDerivedTaskTarget(targetInfo);
            if (pendingCreationMarkers.has(targetInfo.url) || orphanCreationTargets.has(query.target)) {
              throw new BrokerError('target_reserved', '该 target 属于尚未完成的幂等 new 请求，不能通过 acquire 抢占。', { targetId: query.target }, 409);
            }
            assertNoExternalDebugger(targetInfo);
            deadline.remaining('acquire lease');
            const managed = managedTabs.get(query.target);
            if (managed?.derivedFrom) {
              throw new BrokerError('target_reserved', '该 target 是等待 broker 收口的无 lease 派生页，不能由调用方接管。', { targetId: query.target }, 409);
            }
            if (managed && !manageToken) {
              throw new BrokerError('manage_token_required', '重新租用 broker 自建页面需要 X-CDP-Manage capability。', { targetId: query.target }, 409);
            }
            if (managed && !safeEqualToken(manageToken, managed.manageToken)) {
              throw new BrokerError('manage_token_conflict', 'X-CDP-Manage capability 与该 broker 自建页面不匹配。', { targetId: query.target }, 403);
            }
            const preexistingChildTargetIds = await snapshotPreexistingChildTargetIds(query.target, deadline);
            lease = acquireLease(query.target, owner, Boolean(managed), Boolean(managed), preexistingChildTargetIds);
            const guardedTarget = await assertTargetExists(query.target, deadline);
            assertNoExternalDebugger(guardedTarget);
            const currentLease = leases.get(query.target);
            if (pendingCreationMarkers.has(guardedTarget.url) || destroyedTargets.has(query.target) || currentLease !== lease) {
              throw new BrokerError('target_destroyed', 'target 在租约建立期间已失效或被保留。', { targetId: query.target }, 409);
            }
          } catch (error) {
            if (leases.get(query.target) === lease) leases.delete(query.target);
            if (error?.code === 'target_destroyed' && !destroyedBeforeAcquire) {
              throw new BrokerError(
                'target_destroyed',
                'target 在租约建立期间已失效；未发布失效 lease。',
                { targetId: query.target },
                502,
              );
            }
            throw error;
          }
          const result = { targetId: query.target, leaseToken: lease.token, leaseEpoch: lease.epoch, acquiredAt: lease.acquiredAt, requestId };
          storeIdempotency(key, { operation: 'acquire', fingerprint, status: 'complete', result });
          ok(response, result);
        });
      } catch (error) {
        if (idempotencyRecords.get(key)?.status === 'pending') idempotencyRecords.delete(key);
        throw error;
      }
      return;
    }
    if (pathname === '/release' && request.method === 'POST') {
      const leaseToken = requestLeaseToken(request);
      if (stalledTargets.has(query.target)) {
        requireLease(query.target, owner, leaseToken, { allowQuarantined: true });
        stalledTargets.delete(query.target);
      }
      await queueForTarget(query.target, deadline, () => releaseTargetUnlocked(query.target, owner, leaseToken, deadline));
      ok(response, { targetId: query.target, released: true, closed: false });
      return;
    }
    if (pathname === '/new' && request.method === 'POST') {
      const targetUrl = query.url || 'about:blank';
      let parsedUrl;
      try { parsedUrl = new URL(targetUrl); } catch { throw new BrokerError('invalid_url', 'new 需要有效 URL。', undefined, 400); }
      if (!['http:', 'https:', 'about:'].includes(parsedUrl.protocol)) throw new BrokerError('invalid_url_scheme', '只允许 http、https 或 about URL。', undefined, 400);
      if (parsedUrl.protocol === 'about:' && parsedUrl.href !== 'about:blank') throw new BrokerError('invalid_url', 'about URL 只允许 about:blank。', undefined, 400);
      const requestId = requestIdempotencyKey(request);
      const activate = query.activate === 'true';
      const fingerprint = opaqueFingerprint(['new', activate, targetUrl]);
      // A previous broker process may have died after Edge created its marked
      // about:blank page but before the HTTP response was committed. Remove
      // only exact cryptographic broker markers before creating another page.
      await sweepOrphanCreationTargets(deadline);
      await sweepUnclaimedDerivedTargets(deadline);
      const { key, existing } = idempotencyRecord(owner, requestId, 'new', fingerprint);
      if (existing?.status === 'complete') {
        await queueForTarget(
          existing.result?.targetId,
          deadline,
          async () => {
            const replay = await replayCompletedNewLease({ key, existing, owner, deadline });
            ok(response, { ...replay, replayed: true });
          },
        );
        return;
      }
      if (existing?.status === 'pending') {
        const targets = await pageTargets(deadline);
        const recoveredTarget = existing.targetId
          ? targets.find((target) => target.targetId === existing.targetId)
          : targets.find((target) => target.url === existing.markerUrl);
        if (!recoveredTarget) {
          if (existing.targetId) {
            idempotencyRecords.delete(key);
            pendingCreationMarkers.delete(existing.markerUrl);
            throw new BrokerError('target_destroyed', '待恢复的任务页已被 Edge 销毁；同一 request id 可安全重试建页。', { requestId, targetId: existing.targetId }, 404);
          }
          throw new BrokerError('operation_pending', '同一 new 请求仍在等待 Edge 返回；请用相同 X-CDP-Request-Id 稍后重试，不得换 key 重复建页。', { requestId }, 409);
        }
        const recovered = await initializePendingNewTarget({
          key,
          owner,
          requestId,
          fingerprint,
          markerUrl: existing.markerUrl,
          targetUrl,
          targetId: recoveredTarget.targetId,
          deadline,
          recovered: true,
        });
        ok(response, { ...recovered, replayed: true });
        return;
      }
      assertTaskPageCapacity();
      const markerUrl = makeBrokerMarkerUrl();
      pendingCreationMarkers.set(markerUrl, { owner, requestId, createdAt: Date.now() });
      storeIdempotency(key, { operation: 'new', fingerprint, status: 'pending', markerUrl });
      let result;
      try {
        result = await sendCdp('Target.createTarget', { url: markerUrl, background: !activate }, { timeoutMs: BUDGETS.metadata, deadline });
      } catch (error) {
        if (!isOutcomeUnknownError(error)) {
          idempotencyRecords.delete(key);
          pendingCreationMarkers.delete(markerUrl);
        }
        throw error;
      }
      const targetId = result.targetId;
      if (!targetId) {
        idempotencyRecords.delete(key);
        pendingCreationMarkers.delete(markerUrl);
        throw new BrokerError('target_create_failed', 'Edge 未返回新 target。', undefined, 502);
      }
      // Ownership begins as soon as Edge reports the created target, before
      // navigation and response delivery. A lost response or long-idle pending
      // operation therefore remains counted and recoverable instead of becoming
      // an untracked open tab.
      ensureManagedTaskTarget(targetId, owner);
      const currentAfterCreate = idempotencyRecords.get(key);
      if (currentAfterCreate?.status === 'complete') {
        ok(response, { ...currentAfterCreate.result, replayed: true });
        return;
      }
      if (currentAfterCreate?.status !== 'pending' || currentAfterCreate.markerUrl !== markerUrl) {
        throw new BrokerError('operation_state_changed', 'Edge 已创建 target，但幂等 new 状态已变化；未发布 lease。', { requestId, targetId }, 409);
      }
      pendingCreationMarkers.set(markerUrl, { owner, requestId, createdAt: Date.now(), targetId });
      storeIdempotency(key, { operation: 'new', fingerprint, status: 'pending', markerUrl, targetId });
      const payload = await initializePendingNewTarget({
        key,
        owner,
        requestId,
        fingerprint,
        markerUrl,
        targetUrl,
        targetId,
        deadline,
        recovered: false,
      });
      ok(response, payload);
      return;
    }
    if (pathname === '/close' || pathname === '/finalize') {
      if (request.method !== 'POST') throw new BrokerError('method_not_allowed', 'close/finalize 必须使用 POST。', undefined, 405);
      const leaseToken = requestLeaseToken(request);
      await queueForTarget(query.target, deadline, () => closeManagedTargetUnlocked(query.target, owner, leaseToken, deadline));
      ok(response, { targetId: query.target, closed: true });
      return;
    }

    if (pathname === '/recover' && request.method === 'POST') {
      const leaseToken = requestLeaseToken(request);
      requireLease(query.target, owner, leaseToken, { allowQuarantined: true });
      // Only explicit, leased recovery may enter a stalled lane. Keep the
      // marker in place so ordinary requests stay blocked until validation.
      const page = await withTargetLease(query.target, owner, leaseToken, deadline, () => recoverTargetUnlocked(query.target, owner, leaseToken, deadline), { allowQuarantined: true, allowStalled: true });
      stalledTargets.delete(query.target);
      ok(response, { targetId: query.target, recovered: true, page });
      return;
    }

    const targetId = query.target;
    const leaseToken = requestLeaseToken(request);
    if (pathname === '/activate' && request.method === 'POST') {
      await withTargetLease(targetId, owner, leaseToken, deadline, () => targetCommandUnlocked(
        targetId, 'Page.bringToFront', {}, { deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true },
      ));
      ok(response, { targetId, activated: true });
      return;
    }
    if (pathname === '/navigate' && request.method === 'POST') {
      let destination;
      try { destination = new URL(query.url); } catch { throw new BrokerError('invalid_url', 'navigate 需要有效 URL。', undefined, 400); }
      if (!['http:', 'https:'].includes(destination.protocol)) throw new BrokerError('invalid_url_scheme', 'navigate 只允许 http 或 https URL。', undefined, 400);
      const result = await withTargetLease(targetId, owner, leaseToken, deadline, async () => {
        await targetCommandUnlocked(targetId, 'Page.enable', {}, { deadline, timeoutMs: BUDGETS.dom });
        const navigation = await targetCommandUnlocked(targetId, 'Page.navigate', { url: destination.toString() }, { deadline, timeoutMs: BUDGETS.navigation, retrySession: false, sideEffect: true });
        await sleep(Math.min(350, deadline.remaining('navigation settle')));
        contextVersions.set(targetId, (contextVersions.get(targetId) || 0) + 1);
        return navigation;
      });
      ok(response, { targetId, frameId: result.frameId || null, url: sanitizePublicUrl(destination.toString()) });
      return;
    }
    if (pathname === '/back' && request.method === 'POST') {
      await withTargetLease(targetId, owner, leaseToken, deadline, async () => {
        await callFixedFunctionUnlocked(targetId, 'function(){history.back();return true}', [], { deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true });
        await sleep(Math.min(500, deadline.remaining('back settle')));
      });
      ok(response, { targetId });
      return;
    }
    if (pathname === '/info' && request.method === 'GET') {
      const result = await withTargetLease(targetId, owner, leaseToken, deadline, () => callFixedFunctionUnlocked(targetId, DOM_QUERY_FUNCTION, [{ kind: 'document' }], { deadline, timeoutMs: BUDGETS.dom }));
      ok(response, { targetId, page: result.result?.value ?? null, contextVersion: contextVersions.get(targetId) || 0 });
      return;
    }
    if (pathname === '/eval') {
      throw new BrokerError('endpoint_removed', '任意 JavaScript eval 已永久移除；请使用 /dom/query。', undefined, 410);
    }
    if (pathname === '/research/snapshot' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(request, 1024, deadline)); }
      catch { throw new BrokerError('invalid_json', '研究快照需要 recipe JSON。', undefined, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'recipe')) {
        throw new BrokerError('invalid_research_request', '只允许已登记 recipe，不接受代码、选择器或接口地址。', undefined, 400);
      }
      try { assertResearchRecipe(body.recipe); }
      catch { throw new BrokerError('invalid_research_recipe', '未知研究DOM配方。', undefined, 400); }
      let loadedRecipe;
      const result = await withTargetLease(targetId, owner, leaseToken, deadline, async () => {
        try { loadedRecipe = await getFixedResearchReadFunction(body.recipe); }
        catch { throw new BrokerError('research_recipe_load_failed', '固定本地采集规则加载失败；保留连接和断点，修复规则后再试。', undefined, 503); }
        return callFixedFunctionUnlocked(targetId, loadedRecipe.declaration, [], { deadline, timeoutMs: BUDGETS.dom });
      });
      if (result.exceptionDetails) throw new BrokerError('research_snapshot_failed', '固定研究DOM快照失败。', { targetId }, 400);
      const value = sanitizeResearchSnapshot(result.result?.value ?? null);
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024 * 1024) {
        throw new BrokerError('research_snapshot_too_large', '单次研究快照过大；保存断点并缩小页面范围，不能当作已读。', { targetId }, 413);
      }
      ok(response, { targetId, value, recipeRevision: loadedRecipe.revision, contextVersion: contextVersions.get(targetId) || 0 });
      return;
    }
    if (pathname === '/dom/query' && request.method === 'POST') {
      const rawBody = await readBody(request, 16 * 1024, deadline);
      let parsedBody;
      try { parsedBody = JSON.parse(rawBody); } catch { throw new BrokerError('invalid_json', 'DOM 查询体不是有效 JSON。', undefined, 400); }
      const spec = validateDomQuery(parsedBody);
      const result = await withTargetLease(targetId, owner, leaseToken, deadline, () => callFixedFunctionUnlocked(targetId, spec.frameSelector ? wrapVisibleFrame(DOM_QUERY_FUNCTION) : DOM_QUERY_FUNCTION, [spec], { deadline, timeoutMs: BUDGETS.dom }));
      if (result.exceptionDetails) throw new BrokerError('dom_query_failed', result.exceptionDetails.text || '固定 DOM 查询失败。', { targetId }, 400);
      const value = result.result?.value ?? null;
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) throw new BrokerError('dom_response_too_large', 'DOM 查询响应超过 64 KiB，请缩小 limit、fields 或 maxChars。', { targetId }, 413);
      ok(response, { targetId, value, contextVersion: contextVersions.get(targetId) || 0 });
      return;
    }
    if ((pathname === '/click' || pathname === '/clickAt') && request.method === 'POST') {
      const selector = validateClickSpec(await readBody(request, 2048, deadline));
      if (!selector) throw new BrokerError('selector_required', 'POST body 需要 CSS 选择器。', undefined, 400);
      const clickResult = await withPopupRiskReservation(targetId, deadline, () => withTargetLease(targetId, owner, leaseToken, deadline, async () => {
          const activate = pathname === '/click';
          const locate = await callFixedFunctionUnlocked(targetId, selector.frameSelector ? wrapVisibleFrame(CLICK_FUNCTION, true) : CLICK_FUNCTION, [selector, activate], { deadline, timeoutMs: BUDGETS.dom, retrySession: !activate, sideEffect: activate });
          if (locate.exceptionDetails) throw new BrokerError('click_failed', locate.exceptionDetails.text || '固定点击操作失败。', { targetId }, 400);
          const value = locate.result?.value;
          if (!value || value.error) throw new BrokerError('element_not_found', `未找到可见元素 ${selector}。`, { targetId, reason: value?.error || null }, 404);
          if (value.navigationUrl) {
            const destination = new URL(value.navigationUrl);
            if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
              throw new BrokerError('invalid_url_scheme', '点击仅能在当前页跟随普通HTTP(S)链接。', { targetId }, 400);
            }
            await targetCommandUnlocked(targetId, 'Page.enable', {}, { deadline, timeoutMs: BUDGETS.dom });
            await targetCommandUnlocked(targetId, 'Page.navigate', { url: destination.toString() }, { deadline, timeoutMs: BUDGETS.navigation, retrySession: false, sideEffect: true });
            contextVersions.set(targetId, (contextVersions.get(targetId) || 0) + 1);
          } else if (pathname === '/clickAt') {
            await targetCommandUnlocked(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 }, { deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true });
            await targetCommandUnlocked(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 }, { deadline, timeoutMs: BUDGETS.dom, retrySession: false, sideEffect: true });
          }
          return value;
        }));
      const point = clickResult.value;
      ok(response, { targetId, clicked: true, element: { tag: point.tag, text: point.text }, popupUrls: clickResult.popupUrls, popupUrlStatus: clickResult.popupUrlStatus });
      return;
    }
    if (pathname === '/setFiles') throw new BrokerError('endpoint_removed', 'setFiles 已移除；文件选择需要单独的显式授权流程。', undefined, 410);
    if (pathname === '/scroll' && request.method === 'POST') {
      const direction = query.direction || 'down';
      const selector = query.selector === undefined ? null : validateSelector(query.selector, true);
      const amount = Math.min(5000, Math.max(1, Math.abs(Number.parseInt(query.y || '500', 10) || 500)));
      if (!['down', 'up', 'top', 'bottom'].includes(direction)) throw new BrokerError('invalid_scroll_direction', 'direction 只允许 down、up、top、bottom。', undefined, 400);
      const position = await withTargetLease(targetId, owner, leaseToken, deadline, async () => {
        const targetInfo = await assertTargetExists(targetId, deadline);
        if (isHeavySpa(targetInfo.url) && (direction === 'bottom' || amount > 800)) {
          throw new BrokerError('heavy_page_requires_incremental_scroll', 'YouTube 等重页面只允许每次不超过 800px 的增量滚动。', { targetId }, 400);
        }
        const position = await scrollPositionUnlocked(targetId, direction, amount, { deadline, selector });
        await sleep(Math.min(300, deadline.remaining('scroll settle')));
        return position;
      });
      ok(response, { targetId, position });
      return;
    }
    if (pathname === '/screenshot' && request.method === 'GET') {
      if (query.file) throw new BrokerError('server_file_output_removed', '服务端 file 写入已移除；请由客户端使用 -OutFile 保存响应。', undefined, 410);
      const bytes = await withTargetLease(targetId, owner, leaseToken, deadline, () => captureScreenshotUnlocked(targetId, query.format === 'jpeg' ? 'jpeg' : 'png', deadline));
      response.statusCode = 200;
      response.setHeader('Content-Type', query.format === 'jpeg' ? 'image/jpeg' : 'image/png');
      response.setHeader('Cache-Control', 'no-store');
      response.end(bytes);
      return;
    }
    throw new BrokerError('not_found', '未知 endpoint 或 HTTP 方法。', {
      endpoints: ['/health', '/targets', '/acquire', '/release', '/new', '/finalize', '/recover', '/navigate', '/back', '/info', '/activate', '/dom/query', '/research/snapshot', '/click', '/clickAt', '/scroll', '/screenshot'],
    }, 404);
  } catch (error) { fail(response, error); }
}

const server = http.createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error) => fail(response, error));
});

async function existingBrokerHealthy() {
  const result = await httpJson(`http://${HOST}:${PORT}/health`, 1000);
  return result?.ok === true && result?.service === SERVICE_NAME;
}

async function startServer() {
  // Resolve an already-occupied API port before endpoint discovery, so a
  // hostile slow /health response consumes the one bounded probe only once.
  if (await checkTcpPort(PORT, 250)) {
    if (await existingBrokerHealthy()) {
      console.log(`[Edge CDP Broker] 已有实例运行在 ${HOST}:${PORT}`);
      return false;
    }
    throw new BrokerError('port_in_use', `端口 ${PORT} 已被其他程序占用。`);
  }
  // Reserve the Edge debugging endpoint before publishing an HTTP API or
  // bearer token. This makes a second broker fail closed even when it uses a
  // different API port. When Edge debugging is not enabled yet, startup may
  // continue and the first later connection attempt will atomically take it.
  try {
    const initialEndpoints = await discoverEdgeEndpoints(deadlineAfter(3000));
    if (initialEndpoints[0]) await ensureProfileLock(initialEndpoints[0]);
  } catch (error) {
    if (error?.code === 'edge_profile_in_use' || process.env.CDP_BROWSER_WS_URL) throw error;
  }
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(PORT, HOST);
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE' && await existingBrokerHealthy()) {
      console.log(`[Edge CDP Broker] 已有实例运行在 ${HOST}:${PORT}`);
      return false;
    }
    if (error?.code === 'EADDRINUSE') throw new BrokerError('port_in_use', `端口 ${PORT} 已被其他程序占用。`);
    throw error;
  }
  try {
    createTokenFile();
    createOrLoadMarkerKey();
  } catch (error) {
    removeOwnTokenFile();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 1500);
      try { server.close(finish); } catch { finish(); return; }
      try { server.closeAllConnections?.(); } catch {}
    });
    throw error;
  }
  console.log(`[Edge CDP Broker] listening http://${HOST}:${PORT}`);
  console.log(`[Edge CDP Broker] token file: ${TOKEN_FILE}`);
  connectBrowser(deadlineAfter(HANDSHAKE_TIMEOUT_MS + 8000)).catch((error) => console.error(`[Edge CDP Broker] initial connection: ${error.code || 'error'}: ${error.message}`));
  return true;
}

server.headersTimeout = 5000;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 1000;
server.maxRequestsPerSocket = 50;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Edge CDP Broker] ${signal}; preserving Edge pages and stopping broker.`);
  try { browserSocket?.close(); } catch {}
  rejectAllPending(new BrokerError('broker_stopping', 'Broker 正在停止。', undefined, 503));
  removeOwnTokenFile();
  await closeProfileLock();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  const started = await startServer();
  if (!started) return;
  process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('exit', removeOwnTokenFile);
}

const executedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (executedDirectly) {
  main().catch((error) => {
    console.error(`[Edge CDP Broker] ${error.code || 'fatal'}: ${error.message}`);
    removeOwnTokenFile();
    void closeProfileLock();
    process.exitCode = 1;
  });
}

export {
  ALLOWED_CDP_METHODS,
  BrokerError,
  DOM_QUERY_FUNCTION,
  CLICK_FUNCTION,
  SCROLL_FUNCTION,
  scrollPositionUnlocked,
  MAX_ACTIVE_TASK_PAGES,
  acquireLease,
  activeTaskPageCount,
  assertTaskPageCapacity,
  assertCdpMethodAllowed,
  deadlineAfter,
  discoverEdgeEndpoint,
  isHeavySpa,
  queueForTarget,
  requireLease,
  sanitizePublicUrl,
  sanitizeResearchSnapshot,
  validateDomQuery,
  validateShadowPath,
  validateClickSpec,
  validateBrowserWsUrl,
  validateOwner,
  validateSelector,
};
