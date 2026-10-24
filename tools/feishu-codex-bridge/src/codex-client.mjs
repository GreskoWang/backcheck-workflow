import { Codex } from '@openai/codex-sdk';
import { localConfig } from '../../../config/backcheck-config.mjs';

// Windows desktop honors the user's system proxy. The independent CLI needs
// the same route explicitly in its own process environment.
export function buildCodexEnvironment(base = process.env, proxyUrl = localConfig.codex_proxy_url) {
  const env = {...base};
  if (!proxyUrl) return env;
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) || proxy.username || proxy.password) {
    throw new Error('The configured Codex route must be a local HTTP proxy without embedded credentials');
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[name] = proxy.href;
  const bypass = [...new Set([...(env.NO_PROXY || env.no_proxy || '').split(',').filter(Boolean),
    'localhost', '127.0.0.1', '::1', '.feishu.cn', 'open.feishu.cn'])].join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  return env;
}

export function createLocalCodex(options = {}) {
  return new Codex({...options, env: buildCodexEnvironment(options.env || process.env)});
}
