#!/usr/bin/env node
// Start or verify the single persistent Edge CDP broker without exposing its token.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const TOKEN_FILE = path.join(
  process.env.CDP_PROXY_TOKEN_DIR ? path.resolve(process.env.CDP_PROXY_TOKEN_DIR) : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy'),
  `${PROXY_PORT}.token`,
);
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
const PREFLIGHT_OWNER = `preflight-${process.pid}`;

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  console.log(major >= 22 ? `node: ok (${version})` : `node: warn (${version}, 建议 Node.js 22+)`);
}

function checkMemory() {
  const freeGiB = os.freemem() / 1024 / 1024 / 1024;
  console.log(`memory: ${freeGiB.toFixed(2)} GiB free`);
  if (freeGiB < 3) console.log('memory: warn — 可用内存低于 3 GiB；不要再启动浏览器控制子线程，完成当前检查后重启 Codex 以清理旧 CUA runtime。');
}

function checkPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function edgeActivePortFiles() {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (os.platform() !== 'win32') return [];
  return [
    path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'),
    path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'DevToolsActivePort'),
    path.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data', 'DevToolsActivePort'),
    path.join(localAppData, 'Microsoft', 'Edge Dev', 'User Data', 'DevToolsActivePort'),
    path.join(localAppData, 'Microsoft', 'Edge SxS', 'User Data', 'DevToolsActivePort'),
  ];
}

function edgeRemoteDebuggingPreference() {
  if (os.platform() !== 'win32') return null;
  const localState = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Local State');
  try {
    const value = JSON.parse(fs.readFileSync(localState, 'utf8'))?.devtools?.remote_debugging?.['user-enabled'];
    return typeof value === 'boolean' ? value : null;
  } catch { return null; }
}

async function detectEdgePort() {
  for (const filePath of edgeActivePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && lines[1]?.startsWith('/devtools/browser/') && await checkPort(port)) return port;
    } catch {}
  }
  return null;
}

async function requestJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let data;
    try { data = JSON.parse(await response.text()); } catch { data = null; }
    return { status: response.status, data };
  } catch (error) { return { status: 0, data: null, error }; }
}

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return token.length >= 32 ? token : null;
  } catch { return null; }
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'edge-cdp-broker.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
  return logFile;
}

async function waitForBrokerProcess(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await requestJson(`${BASE_URL}/health`, { timeoutMs: 750 });
    if (health.data?.service === 'edge-cdp-broker-v2') return health.data;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function verifyConnection() {
  const token = readToken();
  if (!token) return { ok: false, code: 'token_unavailable' };
  const result = await requestJson(`${BASE_URL}/targets`, {
    timeoutMs: 6500,
    headers: { Authorization: `Bearer ${token}`, 'X-CDP-Owner': PREFLIGHT_OWNER },
  });
  if (result.data?.ok === true && Array.isArray(result.data.targets)) return { ok: true, count: result.data.targets.length };
  return { ok: false, code: result.data?.error?.code || (result.status === 0 ? 'broker_unreachable' : 'broker_error'), message: result.data?.error?.message };
}

async function ensureProxy() {
  let health = await requestJson(`${BASE_URL}/health`, { timeoutMs: 1000 });
  let logFile = path.join(os.tmpdir(), 'edge-cdp-broker.log');
  if (health.data?.service !== 'edge-cdp-broker-v2') {
    console.log('broker: starting...');
    logFile = startProxyDetached();
    const started = await waitForBrokerProcess();
    if (!started) {
      console.log('broker: failed_to_start');
      console.log(`log: ${logFile}`);
      return false;
    }
    health = { data: started };
  } else console.log('broker: running');

  const connection = await verifyConnection();
  if (connection.ok) {
    console.log(`broker: ready (${connection.count} Edge page target(s))`);
    return true;
  }

  const refreshed = await requestJson(`${BASE_URL}/health`, { timeoutMs: 1000 });
  if (['connecting', 'validating'].includes(refreshed.data?.connection?.state)) {
    console.log('broker: connecting (existing handshake in progress)');
    console.log('action: 同一个 Edge 连接仍在等待握手或身份核验；不要重启或重复连接。只有实际看到远程调试安全提示时才由用户确认。');
    return false;
  }
  const code = connection.code || refreshed.data?.connection?.lastErrorCode || 'connection_failed';
  console.log(`broker: ${code}`);
  if (code === 'cdp_handshake_timeout') {
    console.log('action: Edge 调试端点已发现，但未在当前握手预算内完成连接（默认30秒）。若 Edge 当前确实显示安全提示，请选择“允许”；否则先等待浏览器启动完成并只重试一次。');
  } else if (code === 'remote_debugging_unavailable') {
    if (edgeRemoteDebuggingPreference() === true) {
      console.log('action: Edge 设置已启用，但实时端点尚未就绪。确保普通可见 Edge 使用默认用户配置运行，等待 DevToolsActivePort 与监听端口出现后只重试一次；不要要求用户切换开关。');
    } else {
      console.log('action: 在 Edge 打开 edge://inspect/#remote-debugging，并启用 Allow remote debugging for this browser instance。');
    }
  } else if (code === 'edge_profile_in_use') {
    console.log('action: 这个 Edge 调试实例已有 broker；复用已登记的 127.0.0.1:3456 实例，不要换端口启动第二个 broker。');
  } else if (code === 'token_unavailable') {
    console.log(`action: broker token 尚不可用；查看日志 ${logFile}`);
  } else {
    console.log(`action: ${connection.message || '查看 broker 日志后重试。'}`);
    console.log(`log: ${logFile}`);
  }
  return false;
}

async function main() {
  checkNode();
  checkMemory();
  const edgePort = await detectEdgePort();
  const edgePreference = edgeRemoteDebuggingPreference();
  console.log(edgePort
    ? `edge: remote debugging available (port ${edgePort})`
    : edgePreference === true
      ? 'edge: remote debugging enabled; live endpoint not ready'
      : 'edge: remote debugging endpoint not found');
  const ok = await ensureProxy();
  if (!ok) process.exitCode = 2;
  try {
    const sites = fs.readdirSync(path.join(ROOT, 'references', 'site-patterns')).filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/u, ''));
    if (sites.length) console.log(`site-patterns: ${sites.join(', ')}`);
  } catch {}
}

await main();
