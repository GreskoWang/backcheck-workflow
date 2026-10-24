import crypto from 'node:crypto';

import { normalizeReplyText } from './reply-policy.mjs';

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
  acceptanceFromMs,
  maxChars,
  formatText,
  send,
  now = () => new Date(),
}) {
  if (!enabled) return { status: 'disabled' };
  const job = store.getJob(requestId);
  const binding = store.getBinding();
  if (!job || job.status !== 'running' || job.stage !== 'scope_resolved' ||
      job.scopeOnly || scope?.decision !== 'execute' ||
      scope?.requestMode !== 'team_dispatch' ||
      !Array.isArray(scope.receiptAssignments) || !scope.receiptAssignments.length ||
      !Array.isArray(scope.assignments) || !scope.assignments.length ||
      !binding?.chatId || !binding.chatId.endsWith('92ed04') ||
      job.chatId !== binding.chatId ||
      job.codexThreadRequestId !== requestId ||
      !job.sourceMessageId ||
      !Number.isSafeInteger(acceptanceFromMs) || acceptanceFromMs <= 0 ||
      !Number.isSafeInteger(job.sourceMessageCreatedAtMs) ||
      job.sourceMessageCreatedAtMs < acceptanceFromMs) {
    return { status: 'ineligible' };
  }
  // This persisted claim blocks retries after a crash or an ambiguous API
  // response. Historical suppressed receipts stay suppressed as well.
  if (job.acceptanceSendAttemptAt || job.acceptanceQueuedAt ||
      job.acceptanceSuppressedAt) {
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
    return { status: 'uncertain' };
  }
}
