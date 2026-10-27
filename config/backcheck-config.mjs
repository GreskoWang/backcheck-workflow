import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGroupPolicies, activeGroupPolicies } from '../tools/feishu-codex-bridge/src/group-policy.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export const configPath = process.env.BACKCHECK_CONFIG_PATH || path.join(root, 'backcheck-local.json');
export const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'runtime-paths.json'), 'utf8'));
for (const [key, value] of Object.entries(runtime.env)) process.env[key] ??= String(value);
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
const existing = (process.env[pathKey] || '').split(path.delimiter).filter(Boolean);
process.env[pathKey] = [...new Set([...runtime.path_entries, ...existing])].join(path.delimiter);
process.env.FEISHU_APP_ID = localConfig.app_id;
process.env.FEISHU_TEMPLATE_DOCUMENT_TOKEN = localConfig.template_document_token || '';
process.env.FEISHU_TARGET_GROUP_INVITE_URL = localConfig.target_group_invite_url || '';
// LOCALAPPDATA is scoped to this business process, never changed in Windows settings.
process.env.LOCALAPPDATA = runtime.feishu_local_appdata;

export function assertListenerReady() {
  if (localConfig.listener_enabled !== true) throw new Error('Listener disabled in config/backcheck-local.json');
  if (!/^oc_[A-Za-z0-9]+$/u.test(localConfig.target_chat_id || '')) throw new Error('Bind the verified target chat ID before listening');
  if (localConfig.template_read_verified !== true) throw new Error('Run the read-only template check before listening');
  const bindingPath = path.join(runtime.env.BACKGROUND_CHECK_WORKSPACE, 'tools', 'feishu-codex-bridge', 'state', 'binding.json');
  const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8').replace(/^\uFEFF/u, ''));
  if (binding.chatId !== localConfig.target_chat_id) throw new Error('Target chat and stored binding disagree');
  const statePath = path.join(path.dirname(bindingPath), 'runtime.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/u, ''));
  const policies = resolveGroupPolicies({ localConfig, binding, runtime: state });
  if (!activeGroupPolicies(policies).some((policy) => policy.chatId === binding.chatId)) {
    throw new Error('The original dispatch group must retain an active policy');
  }
  return policies;
}

export function assertAccountingReady() {
  const cfg = localConfig.accounting;
  if (cfg?.enabled !== true || cfg.rules_reviewed !== true || !/^[A-Za-z0-9_-]{10,128}$/u.test(cfg.spreadsheet_token || '')) {
    throw new Error('Accounting is disabled or its target/rules have not been configured');
  }
}
