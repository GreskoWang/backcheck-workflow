import { isNewDispatchMessage } from './activation-boundary.mjs';

export const LEGACY_DISPATCH_CHAT_ID = 'oc_6589cfd31f18a0298c93602b6592ed04';
export const GROUP_ROLES = Object.freeze(['regular_dispatch', 'special_dispatch', 'regular_delivery']);
const validChatId = (value) => /^oc_[A-Za-z0-9]+$/u.test(String(value || ''));
const positiveMs = (value) => Number.isSafeInteger(value) && value > 0;
// Missing or malformed configuration must not authorize the explicit-off path.
const accountingPermission = (value) => typeof value === 'boolean' ? value : null;

// This is deliberately a pure resolver. It never migrates bindings, invents a
// cutover time, enables a group, or imports the primary group's permissions.
export function resolveGroupPolicies({ localConfig = {}, binding, runtime = {} } = {}) {
  const legacyChatId = localConfig.target_chat_id;
  if (!validChatId(legacyChatId) || binding?.chatId !== legacyChatId) {
    throw new Error('Target chat and stored binding disagree');
  }
  if (localConfig.groups != null && !Array.isArray(localConfig.groups)) {
    throw new Error('groups must be an explicit policy array');
  }
  const supplied = localConfig.groups || [];
  const seen = new Set();
  const policies = supplied.map((entry) => {
    if (!validChatId(entry?.chatId) || seen.has(entry.chatId)) {
      throw new Error('group policy has an invalid or duplicate chatId');
    }
    seen.add(entry.chatId);
    if (!GROUP_ROLES.includes(entry.role)) throw new Error('group policy has an unsupported role');
    const legacy = entry.chatId === legacyChatId;
    if (legacy && entry.role !== 'regular_dispatch') {
      throw new Error('the original dispatch group must retain its role');
    }
    if (!legacy && !String(entry.authorizationRef || '').trim()) {
      throw new Error('additional group requires an explicit authorization reference');
    }
    const activationFromMs = entry.activationFromMs ?? (legacy ? runtime.acceptNewMessagesFromMs : null);
    const acceptanceFromMs = entry.acceptanceFromMs ?? (legacy ? runtime.acceptanceRepliesFromMs : null);
    if (activationFromMs != null && !positiveMs(activationFromMs)) {
      throw new Error('group activationFromMs must be a positive integer or null');
    }
    if (acceptanceFromMs != null && !positiveMs(acceptanceFromMs)) {
      throw new Error('group acceptanceFromMs must be a positive integer or null');
    }
    const dispatch = entry.role !== 'regular_delivery';
    if (!dispatch && (entry.acceptanceRepliesEnabled === true || entry.accountingEnabled === true || entry.researchEnabled === true)) {
      throw new Error('delivery-only groups cannot authorize intake, accounting or research');
    }
    if (dispatch && entry.acceptanceRepliesEnabled === true && positiveMs(acceptanceFromMs) &&
        positiveMs(activationFromMs) && acceptanceFromMs < activationFromMs) {
      throw new Error('receipt cutover cannot precede group activation');
    }
    return Object.freeze({
      ...entry,
      enabled: entry.enabled === true,
      activationFromMs,
      acceptanceFromMs,
      acceptanceRepliesEnabled: dispatch && entry.acceptanceRepliesEnabled === true,
      accountingEnabled: dispatch ? accountingPermission(entry.accountingEnabled) : false,
      researchEnabled: dispatch && entry.researchEnabled === true,
    });
  });
  // The original group survives additions without resetting its binding or
  // watermarks. Its legacy receipt permission is restricted to the exact ID.
  if (!seen.has(legacyChatId)) {
    policies.unshift(Object.freeze({
      chatId: legacyChatId,
      chatName: binding.chatName || null,
      role: 'regular_dispatch',
      enabled: localConfig.listener_enabled === true,
      activationFromMs: runtime.acceptNewMessagesFromMs,
      acceptanceFromMs: runtime.acceptanceRepliesFromMs,
      acceptanceRepliesEnabled: legacyChatId === LEGACY_DISPATCH_CHAT_ID && localConfig.acceptance_replies_enabled === true,
      accountingEnabled: accountingPermission(localConfig.accounting?.enabled),
      researchEnabled: true,
      authorizationRef: 'existing-primary-binding',
    }));
  }
  return Object.freeze(policies);
}

export function activeGroupPolicies(policies) {
  return policies.filter((policy) => policy.enabled === true && positiveMs(policy.activationFromMs));
}

export function getGroupPolicy(policies, chatId) {
  return policies.find((policy) => policy.chatId === chatId) || null;
}

export function isDispatchGroup(policy) {
  return ['regular_dispatch', 'special_dispatch'].includes(policy?.role);
}

export function isDeliveryGroup(policy) {
  return policy?.role === 'regular_delivery';
}

export function acceptsGroupMessage(policy, message) {
  return policy?.enabled === true && message?.chatId === policy.chatId &&
    isNewDispatchMessage(message, policy.activationFromMs);
}

export function canSendAcceptance(policy, job) {
  return isDispatchGroup(policy) && policy?.acceptanceRepliesEnabled === true &&
    acceptsGroupMessage(policy, { chatId: job?.chatId, createTime: job?.sourceMessageCreatedAtMs }) &&
    isNewDispatchMessage({ createTime: job?.sourceMessageCreatedAtMs }, policy.acceptanceFromMs);
}
