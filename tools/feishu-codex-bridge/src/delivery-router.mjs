import {
  DeliveryHold, requireDelivery, deliveryHash, routePolicy, assertAuthorizedSender,
  parseDeliveryFiles, expandDeliveryLabel, sourceAssignmentOrder, assertTarget, assertAssociation, assertCompletedJob,
  assertReviewReceipts, assertMaterial, assertSlot, assertSpecialGroup, assertSpecialOwnership,
  assignmentKey, LOCAL_DELIVERY_CODES, SPECIAL_DELIVERY_CHAT, REGULAR_DELIVERY_CHAT,
} from './delivery-policy.mjs';
import { assertSpecialArtifactReview } from './special-artifacts.mjs';
import { specialArtifactPayload } from './special-delivery-adapter.mjs';

function reason(error, fallback = 'delivery_adapter_failed') {
  return error instanceof DeliveryHold ? error.code : fallback;
}
function adapter(adapters, name) {
  requireDelivery(typeof adapters?.[name] === 'function', `adapter_missing_${name}`);
  return adapters[name];
}
function compactMessage(message) {
  requireDelivery(message?.chatId && message.messageId && String(message.content || '').length <= 20000, 'delivery_message_invalid');
  return {
    chatId: message.chatId, messageId: message.messageId,
    createTime: Number(message.createTime), content: String(message.content || ''),
    senderId: message.senderId, senderIdType: message.senderIdType,
    senderTenantKey: message.senderTenantKey,
  };
}
function nowValue(now) { return Number(now()); }
async function resolveFileScope({ file, message, jobs, adapters }) {
  try { return { codes: expandDeliveryLabel(file.label), sources: null }; }
  catch (error) {
    if (!(error instanceof DeliveryHold) || error.code !== 'delivery_label_source_order_required') throw error;
  }
  const evidence = await adapter(adapters, 'resolveDeliveryLinkScope')({ file, message, jobs });
  requireDelivery(evidence?.status === 'matched' && evidence.deliveryMessageId === message.messageId &&
    evidence.fileToken === file.token && Array.isArray(evidence.sources) && evidence.sources.length > 0 &&
    evidence.sources.length <= 30, 'delivery_label_ambiguous');
  const scopes = evidence.sources.map(source => {
    const matches = jobs.filter(job => job.requestId === source.requestId && job.sourceMessageId === source.sourceMessageId);
    requireDelivery(matches.length === 1, 'delivery_label_source_order_unverified');
    return expandDeliveryLabel(file.label, sourceAssignmentOrder(matches[0], source.sourceBlock));
  });
  requireDelivery(scopes.every(codes => JSON.stringify(codes) === JSON.stringify(scopes[0])), 'delivery_label_ambiguous');
  return { codes: scopes[0], sources: evidence.sources };
}
function assertFileAssociation(file, scope, association, job) {
  requireDelivery(scope.codes.includes(association.code), 'assignment_outside_file_label');
  if (scope.sources) {
    requireDelivery(scope.sources.some(source => source.requestId === job.requestId &&
      source.sourceMessageId === job.sourceMessageId && source.sourceBlock === association.sourceBlock), 'file_label_batch_mismatch');
    requireDelivery(expandDeliveryLabel(file.label, sourceAssignmentOrder(job, association.sourceBlock)).includes(association.code),
      'assignment_outside_file_label');
  }
}
function confirmedReadback(readback, intent) {
  return readback?.status === 'confirmed' && readback.intentId === intent.id &&
    readback.requestId === intent.requestId && readback.payloadHash === intent.payloadHash &&
    (intent.kind === 'regular'
      ? readback.targetToken === intent.targetToken && readback.slotId === intent.slotId &&
        Number.isSafeInteger(Number(readback.revisionId)) && Number(readback.revisionId) > 0
      : readback.chatId === intent.chatId && typeof readback.messageId === 'string' && readback.messageId.length > 0);
}
async function reconcileIntent(intent, { store, adapters }) {
  if (intent.status === 'delivered') return { status: 'delivered', intentId: intent.id };
  let readback, continued = false;
  try { readback = await adapter(adapters, 'readBackIntent')({ intent }); }
  catch { store.updateIntent(intent.id, { status: 'outcome_uncertain', reason: 'readback_failed' }); return { status: 'uncertain', intentId: intent.id }; }
  if (intent.kind === 'regular' && readback?.status === 'pending_steps') {
    try {
      await adapter(adapters, 'continueOwnedDelivery')({ intent: store.getIntent(intent.id) });
      continued = true;
      readback = await adapter(adapters, 'readBackIntent')({ intent: store.getIntent(intent.id) });
    } catch {
      store.updateIntent(intent.id, { status: 'outcome_uncertain', reason: 'remaining_steps_unconfirmed' });
      return { status: 'uncertain', intentId: intent.id, mutated: continued };
    }
    if (readback?.status === 'pending_steps') {
      store.updateIntent(intent.id, { status: 'pending_steps', reason: 'remaining_steps_require_verified_checkpoint' });
      return { status: 'pending', intentId: intent.id, mutated: continued };
    }
  }
  if (!confirmedReadback(readback, intent)) {
    // Even a currently absent result is not permission to replay an attempt:
    // a delayed commit or incomplete read can otherwise duplicate delivery.
    store.updateIntent(intent.id, { status: 'outcome_uncertain', reason: 'readback_unconfirmed' });
    return { status: 'uncertain', intentId: intent.id };
  }
  if (intent.kind === 'special') {
    store.updateIntent(intent.id, { status: 'delivered', deliveredMessageId: readback.messageId });
    return { status: 'delivered', intentId: intent.id, ...(continued ? { mutated: true } : {}) };
  }
  store.updateIntent(intent.id, { status: 'inserted_pending_review', insertedRevisionId: Number(readback.revisionId) });
  try {
    const review = await adapter(adapters, 'reviewSharedTarget')({ intent, readback });
    const receipt = review?.receipt;
    requireDelivery(review?.verification === 'latest_shared_document_pass' && review.externalBlocksUnchanged === true &&
      review.verdict === 'PASS' && receipt?.verdict === 'PASS' && receipt.token === intent.targetToken &&
      String(receipt.revision_id) === String(readback.revisionId) && receipt.script_version &&
      receipt.reviewer_id && receipt.layout_fingerprint && receipt.generated_at, 'shared_target_review_missing');
    const latest = await adapter(adapters, 'readLatestTargetRevision')({ token: intent.targetToken });
    requireDelivery(String(latest) === String(receipt.revision_id), 'shared_target_changed_after_review');
    store.updateIntent(intent.id, { status: 'delivered', sharedReviewReceipt: receipt });
    return { status: 'delivered', intentId: intent.id, ...(continued ? { mutated: true } : {}) };
  } catch (error) {
    const heldReason = reason(error, 'shared_target_review_failed');
    store.updateIntent(intent.id, { status: 'review_blocked', reason: heldReason });
    return { status: 'review_blocked', intentId: intent.id, reason: heldReason };
  }
}

async function deliverRegularMatch({ association, job, request, target, policy, store, adapters, now }) {
  assertCompletedJob(job);
  const receipts = await adapter(adapters, 'verifyCompletedReports')({ job });
  assertReviewReceipts(receipts);
  const material = await adapter(adapters, 'readReviewedReport')({ job, association, receipts });
  assertMaterial(material, association, job, receipts, policy);
  const intentId = deliveryHash(['regular', job.requestId, job.sourceMessageId,
    assignmentKey(association), target.token, association.slotId, material.token]);
  const payloadHash = deliveryHash([material.token, material.revisionId, material.contentHash]);
  const prior = store.getIntent(intentId);
  if (prior) {
    requireDelivery(prior.payloadHash === payloadHash, 'delivery_payload_changed');
    return reconcileIntent(prior, { store, adapters });
  }
  requireDelivery(adapters.capabilities?.atomicRevisionGuard === true &&
    adapters.capabilities?.incrementalInsertOnly === true, 'incremental_adapter_unverified');
  const latestTarget = await adapter(adapters, 'inspectTarget')({ file: request.file, message: request.message });
  assertTarget(latestTarget, request.file, policy, nowValue(now));
  requireDelivery(String(latestTarget.revisionId) === String(target.revisionId), 'target_changed_before_insert');
  const slot = await adapter(adapters, 'inspectSlot')({ target: latestTarget, association });
  assertSlot(slot, association, latestTarget, nowValue(now));
  const intent = {
    id: intentId, kind: 'regular', requestId: job.requestId, sourceMessageId: job.sourceMessageId,
    deliveryRequestId: request.id, targetToken: target.token, slotId: association.slotId,
    assignment: { subject: association.subject, code: association.code, itemNumbers: association.itemNumbers,
      sourceBlock: association.sourceBlock },
    reportToken: material.token, reportRevisionId: material.revisionId,
    contentHash: material.contentHash, payloadHash, expectedRevisionId: Number(target.revisionId),
    expectedSlotHash: slot.slotHash, recipientAudienceFingerprint: target.audience.fingerprint,
  };
  // Durable before the first external mutation. A competing replay gets the
  // existing intent and can only read back, never issue another insertion.
  const claim = store.claimIntent(intent);
  if (!claim.claimed) return reconcileIntent(claim.intent, { store, adapters });
  try {
    await adapter(adapters, 'insertOwnedBlocks')({
      intentId, idempotencyKey: intentId, requestId: job.requestId,
      documentToken: target.token, slotId: association.slotId,
      expectedRevisionId: intent.expectedRevisionId, expectedSlotHash: slot.slotHash,
      expectedAudienceFingerprint: target.audience.fingerprint,
      blocks: material.blocks, payloadHash, contentHash: material.contentHash,
      operation: 'insert_only', requireServerRevisionGuard: true,
    });
  } catch {
    store.updateIntent(intentId, { status: 'outcome_uncertain', reason: 'insert_response_unconfirmed' });
  }
  return { ...await reconcileIntent(store.getIntent(intentId), { store, adapters }), mutated: true };
}

async function processRegularRequest(request, { jobs, config, store, adapters, now, remainingWrites = 30 }) {
  const policy = routePolicy(config, 'regular', Number(request.message.createTime));
  const identity = await adapter(adapters, 'resolveSenderIdentity')({ message: request.message });
  assertAuthorizedSender(request.message, identity, policy);
  const files = parseDeliveryFiles(request.message.content, policy);
  const file = files.find(item => item.token === request.file.token && item.label === request.file.label);
  requireDelivery(Boolean(file), 'delivery_target_changed');
  const fileScope = await resolveFileScope({ file, message: request.message, jobs, adapters });
  requireDelivery(fileScope.codes.some(code => LOCAL_DELIVERY_CODES.includes(code)), 'file_has_no_local_assignment');
  const target = await adapter(adapters, 'inspectTarget')({ file, message: request.message });
  assertTarget(target, file, policy, nowValue(now));
  const resolved = await adapter(adapters, 'resolveRegularAssociations')({ message: request.message, target, jobs });
  requireDelivery(resolved?.status === 'matched' && Array.isArray(resolved.matches) &&
    resolved.matches.length > 0 && resolved.matches.length <= 30, resolved?.status === 'unmatched' ? 'order_unmatched' : 'order_mapping_ambiguous');
  requireDelivery(new Set(resolved.matches.map(item => item.slotId)).size === resolved.matches.length, 'duplicate_target_slot');
  const plans = resolved.matches.map(association => {
    const candidates = jobs.filter(job => job.requestId === association.requestId);
    requireDelivery(candidates.length === 1, 'order_mapping_ambiguous');
    const job = candidates[0];
    assertAssociation(association, job, request.message, target);
    assertFileAssociation(file, fileScope, association, job);
    return { association, job };
  });
  if (plans.some(({ job }) => job.status !== 'completed')) {
    store.updateRequest(request.id, { status: 'waiting_completion', reason: 'report_not_completed' });
    return { status: 'waiting_completion', requestId: request.id };
  }
  const results = [];
  for (const plan of plans) {
    // A prior insertion changes the document revision. Re-resolve the remaining
    // slots on the next event rather than trusting a pre-write block boundary.
    if (results.some(item => item.mutated)) break;
    const result = await deliverRegularMatch({ ...plan, request, target, policy, store, adapters, now });
    results.push(result);
    if (result.status !== 'delivered') break;
  }
  const done = results.length === plans.length && results.every(item => item.status === 'delivered');
  const status = done ? 'delivered' : results.some(item => item.status === 'uncertain') ? 'outcome_uncertain' : 'pending';
  const intentIds = [...new Set([...(request.intentIds || []), ...results.map(item => item.intentId).filter(Boolean)])];
  store.updateRequest(request.id, { status, intentIds, reason: done ? null : results.at(-1)?.reason || 'remaining_slots_require_fresh_mapping' });
  if (!done && results.some(item => item.mutated) && results.every(item => item.status === 'delivered') && remainingWrites > 1) {
    return processRegularRequest({ ...request, intentIds }, { jobs, config, store, adapters, now, remainingWrites: remainingWrites - 1 });
  }
  return { status, requestId: request.id, results };
}

/** Observe only this explicitly authorized delivery group. Disabled routes do
 * not save messages. Identity and source timestamps are checked before a file
 * is inspected; message bodies remain untrusted link/mapping data. */
export async function handleDeliveryMessage({ message, jobs = [], config, store, adapters, now = () => Date.now() }) {
  if (message?.chatId !== REGULAR_DELIVERY_CHAT || config?.regular?.enabled !== true) return { status: 'ignored' };
  let request;
  try {
    const compact = compactMessage(message);
    const policy = routePolicy(config, 'regular', compact.createTime);
    const identity = await adapter(adapters, 'resolveSenderIdentity')({ message: compact });
    assertAuthorizedSender(compact, identity, policy);
    const files = parseDeliveryFiles(compact.content, policy);
    const results = [];
    for (const file of files) {
      request = null;
      try {
        const scope = await resolveFileScope({ file, message: compact, jobs, adapters });
        if (!scope.codes.some(code => LOCAL_DELIVERY_CODES.includes(code))) {
          results.push({ status: 'ignored', reason: 'file_has_no_local_assignment', fileToken: file.token });
          continue;
        }
        request = store.recordRequest(compact, file);
        const result = request.status === 'delivered' ? { status: 'delivered', requestId: request.id }
          : await processRegularRequest(request, { jobs, config, store, adapters, now });
        results.push({ ...result, fileToken: file.token });
      } catch (error) {
        const heldReason = reason(error);
        if (request) store.updateRequest(request.id, { status: 'held', reason: heldReason });
        results.push({ status: 'held', reason: heldReason, fileToken: file.token,
          ...(request ? { requestId: request.id } : {}) });
      }
    }
    if (results.length === 1) return results[0];
    const relevant = results.filter(item => item.status !== 'ignored');
    const status = relevant.length === 0 ? 'ignored' : relevant.every(item => item.status === 'delivered') ? 'delivered'
      : relevant.some(item => item.status === 'held') ? 'held'
      : relevant.some(item => item.status === 'outcome_uncertain') ? 'outcome_uncertain'
      : relevant.every(item => item.status === 'waiting_completion') ? 'waiting_completion' : 'pending';
    return { status, results };
  } catch (error) {
    const heldReason = reason(error);
    if (request) store.updateRequest(request.id, { status: 'held', reason: heldReason });
    return { status: 'held', reason: heldReason, ...(request ? { requestId: request.id } : {}) };
  }
}

/** Call on a meaningful completion/configuration event, not an unbounded
 * retry loop. Existing intents perform readback/review only. */
export async function retryPendingRegularDeliveries({ jobs = [], config, store, adapters, now = () => Date.now() }) {
  if (config?.regular?.enabled !== true) return [];
  const results = [];
  for (const request of store.pendingRequests()) {
    try { results.push(await processRegularRequest(request, { jobs, config, store, adapters, now })); }
    catch (error) {
      const heldReason = reason(error);
      store.updateRequest(request.id, { status: 'held', reason: heldReason });
      results.push({ status: 'held', requestId: request.id, reason: heldReason });
    }
  }
  return results;
}

export async function deliverSpecialCompletedJob({ job, config, store, adapters, now = () => Date.now() }) {
  if (config?.special?.enabled !== true) return { status: 'ignored' };
  try {
    const policy = routePolicy(config, 'special', Number(job?.sourceMessageCreatedAtMs));
    requireDelivery(job?.chatId === SPECIAL_DELIVERY_CHAT && job.deliveryKind === 'special', 'special_source_unverified');
    assertCompletedJob(job);
    // This separately authorized group has an explicit default owner. It does
    // not inherit or broaden the regular dispatch group's three-code policy.
    const assignments = assertSpecialOwnership(job, policy);
    if (job.deliveryReviewMode === 'special_artifacts_v1') {
      const reviewed = await adapter(adapters, 'verifySpecialArtifacts')({ job });
      assertSpecialArtifactReview(reviewed, job);
      const group = await adapter(adapters, 'inspectSpecialGroup')({ chatId: SPECIAL_DELIVERY_CHAT });
      assertSpecialGroup(group, policy, nowValue(now));
      const results = [];
      for (const material of reviewed.materials) {
        requireDelivery(material.assignments.every(item => assignments.some(approved => assignmentKey(item) === assignmentKey(approved))),
          'special_artifact_assignment_mismatch');
        const intent = { id: deliveryHash(['special-artifact', job.requestId, job.sourceMessageId, material.artifactId]),
          kind: 'special', deliveryMode: 'artifact', requestId: job.requestId, sourceMessageId: job.sourceMessageId,
          chatId: SPECIAL_DELIVERY_CHAT, artifactId: material.artifactId,
          payloadHash: deliveryHash(specialArtifactPayload(material, job)),
          reviewedMaterial: material, reviewReceipt: reviewed.receipts.find(item => item.artifactId === material.artifactId),
          recipientAudienceFingerprint: group.audienceFingerprint };
        const claim = store.claimIntent(intent);
        if (claim.intent.status === 'delivered') { results.push({ status: 'delivered', intentId: intent.id }); continue; }
        try {
          // The adapter resumes only stages proven not attempted. It never
          // repeats an uncertain upload or message send.
          await adapter(adapters, 'sendSpecialArtifact')({ job, material, intentId: intent.id,
            expectedAudienceFingerprint: group.audienceFingerprint });
        } catch (error) {
          store.updateIntent(intent.id, { status: 'outcome_uncertain', reason: reason(error, 'special_artifact_send_unconfirmed') });
        }
        const result = await reconcileIntent(store.getIntent(intent.id), { store, adapters });
        results.push(result);
        if (result.status !== 'delivered') break;
      }
      const delivered = results.length === reviewed.materials.length && results.every(item => item.status === 'delivered');
      return { status: delivered ? 'delivered' : 'uncertain', results,
        intentId: results.length === 1 ? results[0].intentId : undefined };
    }
    const receipts = await adapter(adapters, 'verifyCompletedReports')({ job });
    assertReviewReceipts(receipts);
    const reports = [];
    for (const association of assignments) {
      const material = await adapter(adapters, 'readReviewedReport')({ job, association, receipts });
      const file = assertMaterial(material, association, job, receipts, policy, { requireBlocks: false });
      reports.push({ subject: association.subject, code: association.code, url: file.url,
        token: material.token, revisionId: material.revisionId });
    }
    requireDelivery(new Set(reports.map(item => item.token)).size === reports.length &&
      receipts.length === reports.length, 'special_reports_ambiguous');
    const group = await adapter(adapters, 'inspectSpecialGroup')({ chatId: SPECIAL_DELIVERY_CHAT });
    assertSpecialGroup(group, policy, nowValue(now));
    const text = ['专项背调已完成', ...reports.map(item => `${String(item.subject).replace(/[\r\n\t]/gu, ' ')}\n${item.url}`)].join('\n');
    requireDelivery(text.length <= 6000, 'special_result_too_long');
    const intent = { id: deliveryHash(['special', job.requestId, job.sourceMessageId]), kind: 'special',
      requestId: job.requestId, sourceMessageId: job.sourceMessageId, chatId: SPECIAL_DELIVERY_CHAT,
      payloadHash: deliveryHash(text), reports, text, recipientAudienceFingerprint: group.audienceFingerprint };
    const claim = store.claimIntent(intent);
    if (!claim.claimed) return reconcileIntent(claim.intent, { store, adapters });
    try {
      await adapter(adapters, 'sendSpecialResult')({ chatId: SPECIAL_DELIVERY_CHAT, replyTo: job.sourceMessageId,
        requestId: job.requestId, text, messageType: 'text', intentId: intent.id, idempotencyKey: intent.id,
        expectedAudienceFingerprint: group.audienceFingerprint, payloadHash: intent.payloadHash });
    } catch { store.updateIntent(intent.id, { status: 'outcome_uncertain', reason: 'send_response_unconfirmed' }); }
    return reconcileIntent(store.getIntent(intent.id), { store, adapters });
  } catch (error) { return { status: 'held', reason: reason(error) }; }
}
