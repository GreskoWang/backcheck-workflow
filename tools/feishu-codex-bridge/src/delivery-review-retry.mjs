import crypto from 'node:crypto';
import { canResumeDeliveryReview, deliveryReviewInputFingerprint } from './delivery-review.mjs';

function jobFingerprint(job) {
  return crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex');
}

export function inspectDeliveryReviewRetry(store, { requestId, workspace }) {
  const before = store.getJob(requestId);
  const legacyReviewRecovery = before?.status === 'recovery_required' &&
    before.stage === 'thread_recovery_required' && before.recoveryFromStage === 'verifying_delivery';
  if (!before || (!['review_pending', 'failed'].includes(before.status) && !legacyReviewRecovery)) {
    throw new Error('only a pending delivery review can be explicitly requeued');
  }
  const requiresLegacyRestore = (before.status === 'failed' && before.stage === 'failed') || legacyReviewRecovery;
  let prepared;
  if (requiresLegacyRestore) {
    if (!canResumeDeliveryReview({ ...before, status: 'review_pending', stage: 'verifying_delivery' })) {
      throw new Error('legacy review restoration requires the same owned thread, saved result, and exact report manifest');
    }
    prepared = { ...before, reviewInputFingerprint: deliveryReviewInputFingerprint({
      ...before, stateDir: store.stateDir, workspace,
    }) };
  } else {
    prepared = store.prepareDeliveryReview(requestId, { workspace });
  }
  const failed = before.reviewLastFailure;
  const unchangedRejection = ['FAIL', 'BLOCKED'].includes(failed?.status) &&
    failed.inputFingerprint === prepared.reviewInputFingerprint;
  return {
    requestId, threadId: before.codexThreadId,
    status: before.status, stage: before.stage,
    requiresLegacyRestore,
    expectedJobSha256: jobFingerprint(before),
    inputFingerprint: prepared.reviewInputFingerprint,
    queueAllowed: !unchangedRejection,
    reason: unchangedRejection ? 'review_inputs_unchanged' : 'explicit_review_retry_available',
  };
}

// The maintenance CLI owns the same instance lock as the bridge. This function
// never creates a research thread, runs a model, reads an account, or sends.
export function queueDeliveryReviewRetry(store, {
  requestId, workspace, expectedJobSha256, expectedInputSha256, reason,
  restoreLegacyReview = false, now = new Date(),
}) {
  if (!/^[a-f0-9]{64}$/u.test(String(expectedJobSha256 || ''))) {
    throw new Error('review retry requires the inspected job SHA-256');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(expectedInputSha256 || ''))) {
    throw new Error('review retry requires the inspected input SHA-256');
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
    throw new Error('review retry requires a bounded explanation of the changed evidence or read error');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('review retry requires a valid timestamp');
  }
  const inspection = inspectDeliveryReviewRetry(store, { requestId, workspace });
  if (inspection.expectedJobSha256 !== expectedJobSha256) {
    throw new Error('delivery review job changed since inspection');
  }
  if (inspection.inputFingerprint !== expectedInputSha256) {
    throw new Error('delivery review inputs changed since inspection');
  }
  if (!inspection.queueAllowed) throw new Error('review_inputs_unchanged');
  if (inspection.requiresLegacyRestore && restoreLegacyReview !== true) {
    throw new Error('legacy failed stage requires explicit restore-review-checkpoint');
  }
  const before = store.getJob(requestId);
  if (jobFingerprint(before) !== expectedJobSha256) {
    throw new Error('delivery review job changed during retry preparation');
  }
  const rechecked = inspectDeliveryReviewRetry(store, { requestId, workspace });
  if (rechecked.expectedJobSha256 !== expectedJobSha256 ||
      rechecked.inputFingerprint !== expectedInputSha256 || !rechecked.queueAllowed) {
    throw new Error('delivery review inputs or state changed during retry preparation');
  }
  return store.updateJob(requestId, {
    status: 'queued', stage: 'verifying_delivery',
    reviewRetryRequestedAt: now.toISOString(), reviewRetryReason: reason.trim(),
    reviewRetryCount: (Number.isSafeInteger(before.reviewRetryCount) ? before.reviewRetryCount : 0) + 1,
    reviewRetryInputFingerprint: inspection.inputFingerprint,
    ...(inspection.requiresLegacyRestore ? {
      reviewRestoredFrom: { status: before.status, stage: before.stage,
        errorSummary: before.errorSummary || null, restoredAt: now.toISOString() },
    } : {}),
  });
}
