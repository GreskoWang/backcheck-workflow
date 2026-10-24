import { localConfig, assertListenerReady } from '../../../config/backcheck-config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const bridgeRoot = path.resolve(moduleDir, '..');

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const config = Object.freeze({
  workspace:
    process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(bridgeRoot, '..', '..'),
  credentialReader:
    process.env.FEISHU_CREDENTIAL_READER ||
    path.join(process.env.FEISHU_MCP_ROOT || path.join(process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(bridgeRoot, '..', '..'), 'external', 'feishu-mcp'), 'scripts', 'read-credential.ps1'),
  targetGroupInviteUrl:
    process.env.FEISHU_TARGET_GROUP_INVITE_URL ||
    '',
  stateDir: path.join(bridgeRoot, 'state'),
  logDir: path.join(bridgeRoot, 'logs'),
  // Feishu rich-text normalisation expands links to Markdown and can nearly
  // double the visible character count. Large but ordinary team dispatches
  // therefore need more room than a plain-text message of the same content.
  maxRequestChars: positiveInteger('BRIDGE_MAX_REQUEST_CHARS', 20000),
  maxReplyChars: positiveInteger('BRIDGE_MAX_REPLY_CHARS', 6000),
  // Listening alone does not authorize a message back to the dispatch group.
  feishuGroupRepliesEnabled: process.env.FEISHU_GROUP_REPLIES_ENABLED === 'true',
  // A new, verified full-team dispatch may send one allocation receipt.
  // All other group replies and the historical outbox remain disabled.
  feishuAcceptanceRepliesEnabled: localConfig.acceptance_replies_enabled === true,
  heartbeatMinutes: positiveInteger('BRIDGE_HEARTBEAT_MINUTES', 30),
  pollIntervalSeconds: positiveInteger('FEISHU_POLL_INTERVAL_SECONDS', 5),
  pollLookbackMinutes: positiveInteger('FEISHU_POLL_LOOKBACK_MINUTES', 15),
  // Legacy SDK/Desktop configuration only. The CLI continuation pins
  // workspace-write, on-request, user review and sandbox network disabled
  // independently; this setting must never widen that CLI path.
  codexSandboxMode: process.env.CODEX_SANDBOX_MODE || 'danger-full-access',
  codexModel: process.env.CODEX_MODEL || undefined,
  // Dispatch scoping uses the SDK before any receipt or research thread is
  // created. Pin an independently validated model instead of inheriting the
  // account's global Codex model, which may not support SDK structured output.
  codexPreflightModel: process.env.CODEX_PREFLIGHT_MODEL || 'gpt-6-sol',
  codexPreflightFallbackModel: process.env.CODEX_PREFLIGHT_FALLBACK_MODEL || 'gpt-5.6-luna',
  // The user's global value is "ultra", while the current gpt-6-sol API accepts
  // through "max". Pin the highest supported value for unattended jobs.
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT || 'max',
  // The pinned CLI/ConPTY handoff has an existing durable thread path. The
  // Desktop UI route remains opt-in until its AppX/window prerequisites are
  // verified in the account that runs the bridge.
  codexDispatchMode: process.env.CODEX_DISPATCH_MODE || 'desktop_native_handoff_v1',
  codexResearchStartTimeoutMs:
    positiveInteger('CODEX_RESEARCH_START_TIMEOUT_SECONDS', 15 * 60) * 1000,
  codexBootstrapModel: process.env.CODEX_BOOTSTRAP_MODEL || 'gpt-5.6-luna',
  codexBootstrapReasoningEffort: process.env.CODEX_BOOTSTRAP_REASONING_EFFORT || 'low',
  codexBootstrapTimeoutMs:
    positiveInteger('CODEX_BOOTSTRAP_TIMEOUT_SECONDS', 180) * 1000,
  // Execution threads are created and owned by Codex Desktop so the user can
  // open them while they are running. The bridge only performs a guarded UI
  // submit and then observes the native rollout file.
  codexNativeDiscoveryTimeoutMs:
    positiveInteger('CODEX_NATIVE_DISCOVERY_TIMEOUT_SECONDS', 45) * 1000,
  codexNativeCompletionTimeoutMs:
    positiveInteger('CODEX_NATIVE_COMPLETION_TIMEOUT_SECONDS', 24 * 60 * 60) * 1000,
});
