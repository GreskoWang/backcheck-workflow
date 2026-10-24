import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import axios from 'axios';

const ENSURE_UAT = process.env.FEISHU_UAT_SCRIPT || path.join(process.env.FEISHU_MCP_ROOT || path.join(process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'external', 'feishu-mcp'), 'scripts', 'ensure-feishu-uat.ps1');
const larkPackage = path.join(path.dirname(process.execPath), 'node_modules', '@larksuiteoapi', 'lark-mcp');
const requireLark = createRequire(path.join(larkPackage, 'package.json'));
let localAuthStore;
function authStore() {
  localAuthStore ||= requireLark('./dist/auth/store.js').authStore;
  return localAuthStore;
}

function runUatCheck() {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', ENSURE_UAT], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      let status;
      try { status = JSON.parse(output.trim()).status; } catch {}
      if (code === 0 && status === 'READY') resolve();
      else reject(new Error(`existing Feishu UAT is not ready: ${status || 'unknown'}`));
    });
  });
}

export async function currentToken(appId, dependencies = {}) {
  const store = dependencies.store || authStore();
  const check = dependencies.runUatCheck || runUatCheck;
  const now = dependencies.now || Date.now;
  let token = await store.getLocalAccessToken(appId);
  let metadata = token ? await store.getToken(token) : null;
  // The installed auth store uses Unix seconds (not JavaScript milliseconds).
  const expiryMs = Number(metadata?.expiresAt) * (Number(metadata?.expiresAt) < 1e12 ? 1000 : 1);
  if (metadata && expiryMs <= now() + 60_000) {
    await check();
    // Reload the existing store explicitly rather than waiting for its file watcher.
    if (typeof store.loadFromStorage === 'function') await store.loadFromStorage();
    token = await store.getLocalAccessToken(appId);
    metadata = token ? await store.getToken(token) : null;
    const refreshedExpiryMs = Number(metadata?.expiresAt) *
      (Number(metadata?.expiresAt) < 1e12 ? 1000 : 1);
    if (!metadata || refreshedExpiryMs <= now()) {
      throw new Error('existing Feishu UAT refresh could not be confirmed');
    }
  }
  if (!token || !metadata) {
    throw new Error('existing Feishu UAT is unavailable');
  }
  return token;
}

export async function existingAccountingAuthMetadata(appId) {
  const token = await authStore().getLocalAccessToken(appId);
  const metadata = token ? await authStore().getToken(token) : null;
  return { present: Boolean(metadata),
    expiresAtUtc: metadata?.expiresAt ? new Date(Number(metadata.expiresAt) *
      (Number(metadata.expiresAt) < 1e12 ? 1000 : 1)).toISOString() : null,
    scopes: metadata?.scopes ?? null };
}

// Reuse the application connection for reads. The existing app identity has
// read-only access to this workbook; writes use the already authorized user
// identity and never expose its token to logs or command arguments.
export function accountingClient(appClient, appId, dependencies = {}) {
  if (!appClient || !appId) throw new Error('accounting client requires existing Feishu identities');
  const getToken = dependencies.currentToken || currentToken;
  const checkUat = dependencies.runUatCheck || runUatCheck;
  const reloadAuth = dependencies.reloadAuth || (() => authStore().loadFromStorage());
  const request = dependencies.request || ((args) => axios.request(args));
  return {
    sheets: appClient.sheets,
    async request(args) {
      if (args.method === 'GET') return appClient.request(args);
      if (!['PUT', 'POST'].includes(args.method) ||
          !/^\/open-apis\/sheets\/v2\/spreadsheets\//u.test(args.url)) {
        throw new Error('accounting write endpoint is not allowlisted');
      }
      let token = await getToken(appId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response;
        try { response = await request({
          url: `https://open.feishu.cn${args.url}`, method: args.method,
          data: args.data, timeout: 20000, validateStatus: () => true,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }); } catch (cause) {
          const error = new Error('accounting API transport failed');
          error.code = 'ACCOUNTING_TRANSPORT_FAILED';
          throw error;
        }
        if ((response.status === 401 || response.data?.code === 99991668) && attempt === 0) {
          await checkUat();
          await reloadAuth();
          token = await getToken(appId);
          continue;
        }
        if (response.status !== 200) {
          const error = new Error(`accounting API HTTP ${response.status}`);
          error.response = { status: response.status,
            data: { code: response.data?.code } };
          throw error;
        }
        return response.data;
      }
      throw new Error('accounting API retry was exhausted');
    },
  };
}
