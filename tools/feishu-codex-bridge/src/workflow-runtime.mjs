import { newRequestId } from './commands.mjs';
import { acceptsGroupMessage, getGroupPolicy } from './group-policy.mjs';
import { completionJobFingerprint } from './completion-observer.mjs';
import { collectSpecialMessageData } from './special-intake.mjs';
import { handleDeliveryMessage, retryPendingRegularDeliveries, deliverSpecialCompletedJob } from './delivery-router.mjs';

export function isExplicitSpecialRequest(message) {
  return /(?:^|\n)\s*(?:\*\*)?【(?:特殊|专项)背调(?:需求)?[^】]*】/u.test(String(message?.content || ''));
}

// Intake persists the original normalized message before media/model work.
// This means a poll/WS race or restart cannot lose a slow image-only request.
export function enqueueSpecialRequest({ message, policy, store, pricingRegistry, idFactory = newRequestId }) {
  if (!acceptsGroupMessage(policy, message) || policy.role !== 'special_dispatch' ||
      !isExplicitSpecialRequest(message)) return { handled: true, status: 'ignored' };
  const existing = store.getJobBySourceMessageId(message.messageId);
  if (existing) return { handled: true, status: 'duplicate', job: existing };
  const requestId = idFactory();
  const savedMessage = structuredClone(message);
  // Only bounded Feishu event data is persisted; no transport/client objects.
  if (JSON.stringify(savedMessage).length > 256 * 1024) return { handled: true, status: 'held', reason: 'special_message_too_large' };
  const owner = policy.defaultOwner;
  if (!owner?.id || !owner.name || !owner.authorizationRef) return { handled: true, status: 'held', reason: 'special_owner_unconfigured' };
  const source = collectSpecialMessageData({ message });
  const job = {
    requestId, status: 'queued', stage: 'special_intake_pending', workflowKind: 'special_research',
    deliveryKind: 'special', requestText: String(message.content || ''),
    sourceMessage: savedMessage, sourceMessageId: message.messageId, chatId: message.chatId,
    sourceMediaKeys: source.attachments.map(item => `${item.type}:${item.fileKey}`),
    sourceMessageCreatedAtMs: Number(message.createTime), senderId: message.senderId,
    createdAt: new Date().toISOString(), codexThreadId: null, codexThreadRequestId: requestId,
    specialOwnership: { ownerId: owner.id, authorization: owner.authorizationRef,
      sourceChatId: message.chatId, sourceMessageId: message.messageId, verified: true },
    pricingStatus: 'pending_pricing',
  };
  const result = store.addJobForMessage(message.messageId, job);
  if (!result.added || result.held) return { handled: true, status: result.held ? 'held' : 'duplicate', ...result };
  // The registry is local pending-price bookkeeping. It does not write a fee,
  // assume zero, or call the ordinary accounting gate.
  try {
    const pricing = pricingRegistry.registerOrder({ requestId, sourceMessageId: message.messageId, chatId: message.chatId });
    store.updateJob(requestId, { specialPricingOrderId: pricing.orderId,
      pricingStatus: pricing.status, accountingStatus: 'pending_pricing' });
  } catch {
    // The order itself already records pending_pricing durably. An unavailable
    // auxiliary registry must not turn an accepted order into a lost wakeup.
    store.updateJob(requestId, { accountingStatus: 'pending_pricing', pricingRegistryPending: true });
  }
  return { handled: true, status: 'queued', job: store.getJob(requestId) };
}

export function createWorkflowRuntime({ config, groupPolicies, store, deliveryStore, pricingRegistry,
  getAdapters, completionObserver, now = () => Date.now() }) {
  let checking = false;
  let deliveryChain = Promise.resolve();
  function serializedDelivery(action) {
    const next = deliveryChain.then(action);
    deliveryChain = next.catch(() => {});
    return next;
  }
  const attemptedCompletion = new Set();
  async function routeExtension(message) {
    const policy = getGroupPolicy(groupPolicies, message.chatId);
    if (!acceptsGroupMessage(policy, message)) return { handled: true, status: 'ignored' };
    if (['regular_dispatch', 'special_dispatch'].includes(policy.role) && message.rawContentType === 'merge_forward') {
      const existing = store.getJobBySourceMessageId(message.messageId);
      if (existing) return { handled: true, status: 'duplicate', job: existing };
      // The SDK verifies the envelope type, but exposes no authenticated order
      // origin here. A forwarded bundle must not create a second charge/run.
      const result = store.addJobForMessage(message.messageId, {
        requestId: newRequestId(), status: 'intake_held', stage: 'forward_origin_review',
        requestText: String(message.content || '').slice(0, 256 * 1024),
        sourceMessageId: message.messageId, chatId: message.chatId,
        sourceMessageCreatedAtMs: Number(message.createTime), sourceMessageType: 'merge_forward',
        createdAt: new Date(now()).toISOString(),
        intakeHold: { reason: 'forward_origin_unverified', heldAt: new Date(now()).toISOString() },
      });
      return { handled: true, status: 'held', reason: 'forward_origin_unverified', job: result.job };
    }
    if (policy.role === 'regular_delivery') {
      const result = await serializedDelivery(() => handleDeliveryMessage({ message, jobs: store.listJobs(), config: config.delivery,
        store: deliveryStore, adapters: getAdapters(), now }));
      return { handled: true, ...result };
    }
    if (policy.role === 'special_dispatch') return enqueueSpecialRequest({ message, policy, store, pricingRegistry });
    return { handled: false, policy };
  }
  async function onCompleted(job) {
    return serializedDelivery(async () => {
    if (job.deliveryEligible === false) return { status: 'review_pending', reason: job.remainingDeliveryGate };
    if (job.deliveryKind === 'special') {
      const result = await deliverSpecialCompletedJob({ job, config: config.delivery, store: deliveryStore, adapters: getAdapters(), now });
      store.updateJob(job.requestId, { deliveryStatus: result.status,
        deliveryHoldReason: result.reason || null, deliveryIntentId: result.intentId || null });
    }
    await retryPendingRegularDeliveries({ jobs: store.listJobs(), config: config.delivery,
      store: deliveryStore, adapters: getAdapters(), now });
    });
  }
  async function retryPendingDeliveries() {
    // Call once on startup/configuration or a meaningful delivery event. Held
    // work stays visible in jobs.json; no timer blindly resends an old intent.
    for (const job of store.listJobs()) {
      if (job.status === 'completed' && job.deliveryKind === 'special' &&
          job.deliveryEligible !== false && job.deliveryStatus !== 'delivered' &&
          Number(job.sourceMessageCreatedAtMs) >= Number(config.delivery?.special?.activationFromMs || Infinity)) {
        await onCompleted(job);
      }
    }
    return serializedDelivery(() => retryPendingRegularDeliveries({ jobs: store.listJobs(), config: config.delivery,
      store: deliveryStore, adapters: getAdapters(), now }));
  }
  async function observeCompletions() {
    const cutover = config.delivery?.observationActivationFromMs;
    if (checking || !Number.isSafeInteger(cutover) || cutover <= 0) return [];
    checking = true;
    const outcomes = [];
    try {
      for (const job of store.listJobs()) {
        const policy = getGroupPolicy(groupPolicies, job.chatId);
        if (job.status !== 'handed_off' || job.deliveryEligible === false || !policy?.researchEnabled ||
            !acceptsGroupMessage(policy, { chatId: job.chatId, createTime: job.sourceMessageCreatedAtMs })) continue;
        const fingerprint = completionJobFingerprint(job);
        if (attemptedCompletion.has(fingerprint)) continue;
        const result = await completionObserver.observe(job, { enabled: true, chatId: job.chatId,
          activatedFromMs: Math.max(policy.activationFromMs, cutover) });
        outcomes.push({ requestId: job.requestId, status: result.status, reason: result.reason });
        if (result.status === 'blocked' || result.status === 'ignored') attemptedCompletion.add(fingerprint);
        if (result.status !== 'eligible') continue;
        const current = store.getJob(job.requestId);
        if (completionJobFingerprint(current) !== result.expectedJobSha256) continue;
        store.updateJob(job.requestId, { status: 'completed', stage: 'completed',
          completedAt: new Date(now()).toISOString(), finalResponse: result.completion.finalResponse,
          reviewReceipts: result.reviewReceipts, completionEvidence: result.completion });
        completionObserver.forget(job.requestId);
        await onCompleted(store.getJob(job.requestId));
      }
      return outcomes;
    } finally { checking = false; }
  }
  return { routeExtension, observeCompletions, onCompleted, retryPendingDeliveries };
}
