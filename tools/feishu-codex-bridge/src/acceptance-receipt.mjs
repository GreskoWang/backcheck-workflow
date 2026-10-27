import crypto from 'node:crypto';

import { normalizeReplyText } from './reply-policy.mjs';
import { canSendAcceptance } from './group-policy.mjs';
import { isResolvedTeamDispatch } from './dispatch-scope.mjs';

function safeFailure(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/(app_secret|authorization|access_token|refresh_token|secret|token)["'=:\s]+[^\s,"'}]+/gi, '$1=<redacted>')
    .slice(0, 400);
}

function receiptId(chatId, messageId, text) {
  return crypto.createHash('sha256')
    .update(`${chatId}\0${messageId}\0${text}`)
    .digest('hex');
}

export async function sendAcceptanceReceiptOnce({
  store,
  requestId,
  scope,
  enabled,
  allowedChatId,
  acceptanceFromMs,
  policy,
  maxChars,
  formatText,
  send,
  readback,
  now = () => new Date(),
}) {
  if (!enabled) return { status: 'disabled' };
  const job = store.getJob(requestId);
  const binding = store.getBinding();
  const special = scope?.requestMode === 'special_dispatch' && policy?.role === 'special_dispatch' &&
    job?.workflowKind === 'special_research' && job.specialOwnership?.verified === true &&
    job.specialOwnership.sourceChatId === job.chatId &&
    job.specialOwnership.sourceMessageId === job.sourceMessageId &&
    job.specialOwnership.ownerId === policy.defaultOwner?.id &&
    job.specialOwnership.authorization === policy.defaultOwner?.authorizationRef;
  // Multi-group dispatch is bound to its exact configured policy. Legacy
  // single-group callers must supply an explicit full chat ID and binding.
  const configuredChatId = policy ? policy.chatId : allowedChatId;
  if (typeof configuredChatId !== 'string' || !/^oc_[A-Za-z0-9]+$/u.test(configuredChatId)) {
    return { status: 'ineligible', reason: 'acceptance_chat_not_configured' };
  }
  if (!policy && binding?.chatId !== configuredChatId) {
    return { status: 'ineligible', reason: 'acceptance_chat_binding_mismatch' };
  }
  if (job?.chatId !== configuredChatId) {
    return { status: 'ineligible', reason: 'acceptance_message_chat_mismatch' };
  }
  const receiptAllowed = policy
    ? canSendAcceptance(policy, job)
    : Number.isSafeInteger(acceptanceFromMs) && acceptanceFromMs > 0 &&
      Number.isSafeInteger(job?.sourceMessageCreatedAtMs) && job.sourceMessageCreatedAtMs >= acceptanceFromMs;
  if (!job || job.status !== 'running' || job.stage !== 'scope_resolved' ||
      job.scopeOnly || !(isResolvedTeamDispatch(scope) ||
        (special && scope?.decision === 'execute' && Array.isArray(scope.assignments) && scope.assignments.length)) ||
      !receiptAllowed || job.intakeHold || job.duplicateOfRequestId ||
      job.codexThreadRequestId !== requestId ||
      !job.sourceMessageId) {
    return { status: 'ineligible' };
  }
  // This persisted claim blocks retries after a crash or an ambiguous API
  // response. Historical suppressed receipts stay suppressed as well.
  if (job.acceptanceQueuedAt || job.acceptanceSuppressedAt ||
      (job.acceptanceSendAttemptAt && (job.acceptanceSendOutcome === 'confirmed' ||
        job.acceptanceReadbackAt || typeof readback !== 'function'))) {
    return { status: 'already_attempted' };
  }

  let text;
  try {
    text = normalizeReplyText(formatText(scope, requestId), maxChars);
  } catch (error) {
    store.updateJob(requestId, { acceptancePreparationError: safeFailure(error) });
    return { status: 'preparation_failed' };
  }
  const item = {
    id: receiptId(job.chatId, job.sourceMessageId, text),
    chatId: job.chatId,
    replyTo: job.sourceMessageId,
    text,
  };
  async function reconcileUncertain() {
    if (typeof readback !== 'function') return { status: 'uncertain' };
    const current = store.getJob(requestId);
    if (current.acceptanceReadbackAt) return { status: 'uncertain' };
    store.updateJob(requestId, { acceptanceReadbackAt: now().toISOString() });
    try {
      const result = await readback(item, { attemptedAt: current.acceptanceSendAttemptAt });
      if (result?.status === 'confirmed' && /^om_[A-Za-z0-9_-]+$/u.test(result.messageId || '')) {
        store.updateJob(requestId, { acceptanceSendOutcome: 'confirmed',
          acceptanceReplyMessageId: result.messageId, acceptanceConfirmedByReadbackAt: now().toISOString() });
        return { status: 'confirmed_by_readback', messageId: result.messageId };
      }
      store.updateJob(requestId, { acceptanceSendOutcome: 'uncertain',
        acceptanceReadbackReason: safeFailure(result?.reason || 'receipt_not_uniquely_confirmed') });
    } catch (error) {
      store.updateJob(requestId, { acceptanceSendOutcome: 'uncertain', acceptanceReadbackReason: safeFailure(error) });
    }
    return { status: 'uncertain' };
  }
  if (job.acceptanceSendAttemptAt) {
    if (job.acceptanceReplyId !== item.id) return { status: 'already_attempted' };
    return reconcileUncertain();
  }
  store.updateJob(requestId, {
    acceptanceSendAttemptAt: now().toISOString(),
    acceptanceReplyId: item.id,
    acceptanceSendOutcome: 'pending_confirmation',
  });
  try {
    const messageId = await send(item);
    if (!messageId) throw new Error('Feishu receipt response had no message id');
    store.updateJob(requestId, {
      acceptanceSendOutcome: 'confirmed',
      acceptanceSentAt: now().toISOString(),
      acceptanceReplyMessageId: messageId,
    });
    return { status: 'sent', messageId };
  } catch (error) {
    store.updateJob(requestId, {
      acceptanceSendOutcome: 'uncertain',
      acceptanceSendError: safeFailure(error),
    });
    return reconcileUncertain();
  }
}
