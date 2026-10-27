import crypto from 'node:crypto';

export const REGULAR_DELIVERY_CHAT = 'oc_2ed0070e09a740d81fff566d3b2db7d5';
export const SPECIAL_DELIVERY_CHAT = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
export const REGULAR_DISPATCH_CHAT = 'oc_6589cfd31f18a0298c93602b6592ed04';
export const LOCAL_DELIVERY_CODES = Object.freeze(['TS', '临A', 'BK1']);
export const SPECIAL_OWNER_CODE = 'SPECIAL_OWNER';

export class DeliveryHold extends Error {
  constructor(code) { super(code); this.name = 'DeliveryHold'; this.code = code; }
}
export function requireDelivery(condition, code) {
  if (!condition) throw new DeliveryHold(code);
}
export function deliveryHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
export function positiveRevision(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}
export function routePolicy(config, kind, createdAtMs) {
  const policy = config?.[kind];
  requireDelivery(policy?.enabled === true, 'route_disabled');
  requireDelivery(policy.chatId === (kind === 'regular' ? REGULAR_DELIVERY_CHAT : SPECIAL_DELIVERY_CHAT), 'unexpected_route_group');
  requireDelivery(typeof policy.authorization === 'string' && policy.authorization.trim().length > 0, 'route_authorization_missing');
  requireDelivery(Number.isSafeInteger(policy.activationFromMs) && policy.activationFromMs > 0, 'activation_missing');
  requireDelivery(Number.isSafeInteger(createdAtMs) && createdAtMs >= policy.activationFromMs, 'pre_activation_message');
  requireDelivery(typeof policy.tenantKey === 'string' && policy.tenantKey.length > 0, 'tenant_unverified');
  requireDelivery(Array.isArray(policy.allowedHostnames) && policy.allowedHostnames.length > 0 &&
    policy.allowedHostnames.every(host => typeof host === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host)), 'hosts_unverified');
  requireDelivery(Array.isArray(policy.allowedAudienceFingerprints) && policy.allowedAudienceFingerprints.length > 0 &&
    policy.allowedAudienceFingerprints.every(value => /^[a-f0-9]{64}$/u.test(value)), 'audience_unverified');
  return policy;
}
export function assertFreshEvidence(evidence, nowMs = Date.now()) {
  const observedAt = Date.parse(evidence?.observedAt);
  requireDelivery(Number.isSafeInteger(observedAt) && observedAt <= nowMs + 5000 && nowMs - observedAt <= 5 * 60_000, 'inspection_stale');
}
export function assertAuthorizedSender(message, identity, policy) {
  const expected = policy.sender;
  requireDelivery(expected?.verified === true && expected.proofMessageId && expected.tenantKey === policy.tenantKey &&
    ['open_id', 'user_id', 'union_id'].includes(expected.idType) && typeof expected.id === 'string' && expected.id.length > 0,
  'sender_identity_unverified');
  requireDelivery(identity?.verified === true && identity.senderType === 'user' && identity.id === expected.id &&
    identity.idType === expected.idType && identity.tenantKey === expected.tenantKey &&
    identity.messageId === message.messageId && identity.chatId === policy.chatId, 'sender_not_authorized');
  // The adapter must compare against authoritative message sender metadata,
  // never a quoted name, a mention, or a name extracted from the message body.
  requireDelivery(identity.fromMessageMetadata === true, 'sender_metadata_missing');
}
export function parseDeliveryFile(text, policy) {
  const found = [...String(text || '').matchAll(/https?:\/\/[^\s<>"'\u3000]+/giu)]
    .map(match => match[0].replace(/[)\]，。；、]+$/u, ''));
  requireDelivery(found.length === 1, found.length ? 'multiple_file_links' : 'no_file_link');
  let url;
  try { url = new URL(found[0]); } catch { throw new DeliveryHold('invalid_file_link'); }
  requireDelivery(url.protocol === 'https:' && !url.username && !url.password && !url.port, 'invalid_file_origin');
  requireDelivery(policy.allowedHostnames.includes(url.hostname), 'unapproved_file_hostname');
  const match = url.pathname.match(/^\/docx\/([A-Za-z0-9]+)\/?$/u);
  requireDelivery(Boolean(match), 'unsupported_file_type');
  return { token: match[1], type: 'docx', hostname: url.hostname, url: `https://${url.hostname}/docx/${match[1]}` };
}
export function parseDeliveryFiles(text, policy) {
  const lines = String(text || '').split(/\r?\n/u);
  const records = [];
  for (const line of lines) {
    if (!/https?:\/\//iu.test(line)) continue;
    const file = parseDeliveryFile(line, policy);
    const before = line.slice(0, line.search(/https?:\/\//iu)).trim();
    const match = before.match(/^([^:：]+)[:：]\s*$/u);
    records.push({ ...file, label: match ? match[1].trim() : null });
  }
  requireDelivery(records.length > 0 && records.length <= 10, records.length ? 'too_many_file_links' : 'no_file_link');
  requireDelivery(new Set(records.map(file => file.token)).size === records.length, 'duplicate_file_link');
  requireDelivery(records.length === 1 || records.every(file => file.label), 'delivery_labels_required');
  return records;
}
function normalizeCode(value) {
  const code = String(value).normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
  if (/^[A-J]$/u.test(code)) return `临${code}`;
  requireDelivery(/^(?:TS\d*|JW\d+|BK\d+|临[A-J])$/u.test(code), 'delivery_label_ambiguous');
  return code;
}
function normalizeSourceCode(value) {
  try { return normalizeCode(value); }
  catch (error) {
    const label = String(value || '').normalize('NFKC').trim();
    // A verified full allocation can contain a named teammate between formal
    // range endpoints. Preserve position without granting it any local role.
    requireDelivery(/^[\p{L}\p{N}_-]{1,30}$/u.test(label), 'source_order_member_invalid');
    return label;
  }
}
export function expandDeliveryLabel(label, sourceOrder) {
  if (!label) return [...LOCAL_DELIVERY_CODES];
  const segments = String(label).normalize('NFKC').toUpperCase().replace(/\s+/gu, '')
    .split(/[\/、,，+]/u);
  requireDelivery(segments.length > 0 && segments.every(Boolean), 'delivery_label_ambiguous');
  const result = [];
  for (const segment of segments) {
    const range = segment.split(/[-–—~～至到]/u);
    requireDelivery(range.length <= 2 && range.every(Boolean), 'delivery_label_ambiguous');
    const start = normalizeCode(range[0]);
    if (range.length === 1) { result.push(start); continue; }
    const numericStart = start.match(/^(TS|JW|BK)(\d*)$/u);
    const end = /^\d+$/u.test(range[1]) && numericStart
      ? normalizeCode(`${numericStart[1]}${range[1]}`) : normalizeCode(range[1]);
    const numericEnd = end.match(/^(TS|JW|BK)(\d*)$/u);
    if (numericStart && numericEnd && numericStart[1] === numericEnd[1]) {
      const from = numericStart[2] === '' ? 0 : Number(numericStart[2]);
      const to = numericEnd[2] === '' ? 0 : Number(numericEnd[2]);
      requireDelivery(from <= to && to - from <= 100, 'delivery_label_ambiguous');
      for (let value = from; value <= to; value++) result.push(`${numericStart[1]}${value === 0 && numericStart[2] === '' ? '' : value}`);
    } else if (/^临[A-J]$/u.test(start) && /^临[A-J]$/u.test(end)) {
      const from = start.charCodeAt(1), to = end.charCodeAt(1);
      requireDelivery(from <= to, 'delivery_label_ambiguous');
      for (let value = from; value <= to; value++) result.push(`临${String.fromCharCode(value)}`);
    } else {
      requireDelivery(Array.isArray(sourceOrder) && sourceOrder.length > 0, 'delivery_label_source_order_required');
      const order = sourceOrder.map(normalizeSourceCode);
      requireDelivery(new Set(order).size === order.length && order.includes(start) && order.includes(end), 'delivery_label_ambiguous');
      const from = order.indexOf(start), to = order.indexOf(end);
      requireDelivery(from <= to, 'delivery_label_ambiguous');
      result.push(...order.slice(from, to + 1));
    }
  }
  return [...new Set(result)];
}
export function sourceAssignmentOrder(job, sourceBlock) {
  const assignments = (job?.dispatchScope?.receiptAssignments || []).filter(item => item.sourceBlock === sourceBlock);
  requireDelivery(assignments.length > 0, 'delivery_label_source_order_unverified');
  return [...new Set(assignments.map(item => normalizeSourceCode(item.code)))];
}
export function assertTarget(target, file, policy, nowMs) {
  assertFreshEvidence(target, nowMs);
  requireDelivery(target.token === file.token && target.type === 'docx' && target.hostname === file.hostname, 'target_identity_mismatch');
  const tenantKeys = policy.allowedTenantKeys || [policy.tenantKey];
  const ownerTenantKeys = policy.allowedOwnerTenantKeys || [policy.tenantKey];
  requireDelivery(tenantKeys.includes(target.tenantKey) && ownerTenantKeys.includes(target.ownerTenantKey), 'target_organization_mismatch');
  requireDelivery(target.canRead === true && target.canWrite === true, 'target_access_unverified');
  // A sender-supplied exact file token is authoritative. A name-based resolver
  // must prove uniqueness; it cannot manufacture a global duplicate-name count.
  requireDelivery(target.identitySelection === 'exact_token' || target.matchingTitleCount === 1, 'target_title_ambiguous');
  requireDelivery(positiveRevision(target.revisionId), 'target_revision_missing');
  requireDelivery(target.audience?.permissionsComplete === true && typeof policy.expectedExternal === 'boolean' &&
    target.audience?.external === policy.expectedExternal && target.audience?.public === false &&
    policy.allowedAudienceFingerprints.includes(target.audience?.fingerprint), 'target_audience_unapproved');
}
export function assignmentKey(assignment) {
  return JSON.stringify([assignment?.sourceBlock, assignment?.code, assignment?.itemNumbers, assignment?.subject]);
}
export function assertAssociation(association, job, message, target) {
  requireDelivery(job && job.requestId === association?.requestId && job.sourceMessageId === association.sourceMessageId &&
    (job.batchId || job.requestId) === association.batchId, 'order_identity_mismatch');
  requireDelivery(job.chatId === REGULAR_DISPATCH_CHAT, 'regular_source_group_mismatch');
  requireDelivery(LOCAL_DELIVERY_CODES.includes(association.code), 'nonlocal_assignment');
  const matches = (job.dispatchScope?.assignments || []).filter(item => assignmentKey(item) === assignmentKey(association));
  requireDelivery(matches.length === 1, 'assignment_ambiguous');
  requireDelivery(association.targetToken === target.token && typeof association.slotId === 'string' && association.slotId.length > 0,
    'slot_identity_missing');
  const evidence = association.evidence;
  requireDelivery(evidence?.kind === 'source_and_target' && evidence.deliveryMessageId === message.messageId &&
    evidence.sourceMessageId === job.sourceMessageId && evidence.documentToken === target.token &&
    String(evidence.targetRevisionId) === String(target.revisionId) &&
    evidence.matchingRequestCount === 1 && evidence.matchingSubjectCount === 1 && evidence.matchingSlotCount === 1,
  'mapping_evidence_incomplete');
}
export function assertCompletedJob(job) {
  requireDelivery(job?.deliveryEligible !== false, 'specialized_artifact_review_required');
  requireDelivery(job?.status === 'completed' && job.codexThreadId && job.codexThreadRequestId === job.requestId,
    'report_not_completed');
}
export function assertReviewReceipts(receipts) {
  requireDelivery(Array.isArray(receipts) && receipts.length > 0 && receipts.length <= 30, 'source_review_missing');
  requireDelivery(new Set(receipts.map(item => item.token)).size === receipts.length, 'source_review_ambiguous');
  for (const receipt of receipts) {
    requireDelivery(receipt?.verdict === 'PASS' && /^[A-Za-z0-9]+$/u.test(receipt.token || '') &&
      positiveRevision(receipt.revision_id) && receipt.script_version && receipt.reviewer_id &&
      receipt.layout_fingerprint && receipt.generated_at, 'source_review_invalid');
  }
}
export function assertMaterial(material, association, job, receipts, policy, { requireBlocks = true } = {}) {
  requireDelivery(material?.requestId === job.requestId && material.sourceMessageId === job.sourceMessageId &&
    assignmentKey(material) === assignmentKey(association), 'report_assignment_mismatch');
  const link = parseDeliveryFile(material.url, policy);
  requireDelivery(link.token === material.token, 'report_token_mismatch');
  const receipt = receipts.find(item => item.token === material.token);
  requireDelivery(receipt && String(receipt.revision_id) === String(material.revisionId), 'report_revision_unreviewed');
  if (requireBlocks) {
    requireDelivery(Array.isArray(material.blocks) && material.blocks.length > 0 && material.blocks.length <= 1000 &&
      JSON.stringify(material.blocks).length <= 8 * 1024 * 1024 && deliveryHash(material.blocks) === material.contentHash,
    'report_content_unbound');
    requireDelivery(material.boundToReviewedSnapshot === true, 'report_snapshot_binding_missing');
  }
  return link;
}
export function assertSlot(slot, association, target, nowMs) {
  assertFreshEvidence(slot, nowMs);
  requireDelivery(slot.documentToken === target.token && slot.slotId === association.slotId &&
    String(slot.revisionId) === String(target.revisionId) && /^[a-f0-9]{64}$/u.test(slot.slotHash || ''), 'slot_changed');
  requireDelivery(slot.canAppend === true, 'slot_append_unavailable');
  const owned = slot.ownershipVerified === true && slot.ownerRequestId === association.requestId &&
    slot.ownerSourceMessageId === association.sourceMessageId && slot.ownerAssignmentKey === assignmentKey(association);
  requireDelivery(slot.empty === true || owned, 'slot_not_empty_or_owned');
  requireDelivery(slot.otherAuthorsContentProtected === true, 'other_content_protection_unverified');
}
export function assertSpecialGroup(group, policy, nowMs) {
  assertFreshEvidence(group, nowMs);
  requireDelivery(group.chatId === SPECIAL_DELIVERY_CHAT && group.tenantKey === policy.tenantKey &&
    group.canSend === true && group.membersComplete === true &&
    Number.isSafeInteger(group.memberCount) && group.memberCount > 0 && typeof policy.expectedExternal === 'boolean' &&
    group.external === policy.expectedExternal &&
    policy.allowedAudienceFingerprints.includes(group.audienceFingerprint), 'special_audience_unapproved');
}

export function assertSpecialOwnership(job, policy) {
  const owner = policy.owner;
  const evidence = job.specialOwnership;
  requireDelivery(typeof owner?.id === 'string' && owner.id.length > 0 &&
    typeof owner.name === 'string' && owner.name.length > 0 &&
    typeof owner.authorization === 'string' && owner.authorization.length > 0,
  'special_owner_authorization_missing');
  requireDelivery(evidence?.verified === true && evidence.ownerId === owner.id &&
    evidence.authorization === owner.authorization && evidence.sourceChatId === SPECIAL_DELIVERY_CHAT &&
    evidence.sourceMessageId === job.sourceMessageId, 'special_owner_provenance_mismatch');
  const assignments = job.dispatchScope?.assignments;
  requireDelivery(Array.isArray(assignments) && assignments.length > 0 &&
    assignments.every(item => item.code === SPECIAL_OWNER_CODE) &&
    new Set(assignments.map(assignmentKey)).size === assignments.length, 'special_assignments_ambiguous');
  return assignments;
}
