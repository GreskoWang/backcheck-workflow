import {
  REGULAR_DISPATCH_CHAT, REGULAR_DELIVERY_CHAT, LOCAL_DELIVERY_CODES,
  assignmentKey, expandDeliveryLabel, DeliveryHold,
} from './delivery-policy.mjs';

// This module is a pure association resolver. Sender identity, file access,
// completion/review, and safe insertion remain independent delivery gates.
const DAY = 86400000;
const own = value => typeof value === 'string' && value.trim().length > 0;
const clean = value => String(value || '').normalize('NFC').trim();
const code = value => {
  const normalized = clean(value).normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
  return /^[A-J]$/u.test(normalized) ? `临${normalized}` : normalized;
};
function fail(reason, detail = {}) { return { status: 'held', matches: [], reasons: [reason], ...detail }; }
function number(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (Object.hasOwn(digits, value)) return digits[value];
  const tens = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : NaN;
}
const DATE = /(?:(\d{4})\s*(?:年|[-/.]))?(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})(?:日|号)?/gu;
const TIME = /^\s*(?:[（(]?周[一二三四五六日天][）)]?)?\s*(凌晨|早上|上午|中午|下午|晚上|晚间)?\s*([0-9一二两三四五六七八九十零〇]{1,3})\s*(?:(:)(\d{2})|(?:点|时)(半|[0-9一二两三四五六七八九十零〇]{1,3}分?)?)/u;

/** Parse one exact minute, never a date-only batch. Missing years are resolved
 * only near the original message timestamp in the explicitly supported zone. */
export function parseRegularDeadline(text, { referenceTimeMs, timeZone = 'Asia/Shanghai' } = {}) {
  if (timeZone !== 'Asia/Shanghai') return fail('deadline_timezone_unsupported');
  const values = [];
  for (const match of String(text || '').normalize('NFKC').matchAll(DATE)) {
    const time = String(text || '').normalize('NFKC').slice(match.index + match[0].length).match(TIME);
    if (!time) continue;
    let hour = number(time[2]);
    const minute = time[3] ? Number(time[4]) : time[5] === '半' ? 30 : time[5] ? number(time[5].replace(/分$/u, '')) : 0;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || hour > 23) return fail('deadline_time_invalid');
    if (String(text || '').normalize('NFKC').slice(match.index + match[0].length + time[0].length).match(/^:\d/u)) return fail('deadline_seconds_unsupported');
    if (time[1]) {
      if (hour < 1 || hour > 12) return fail('deadline_time_invalid');
      if (/早上|上午/u.test(time[1]) && hour === 12) return fail('deadline_time_ambiguous');
      if (/下午|晚上|晚间/u.test(time[1]) && hour < 12) hour += 12;
      if (/凌晨|早上|上午/u.test(time[1]) && hour === 12) hour = 0;
      if (time[1] === '中午' && hour !== 12) return fail('deadline_time_ambiguous');
    } else if (!time[3] && hour >= 1 && hour <= 12) return fail('deadline_time_ambiguous');
    const month = Number(match[2]), day = Number(match[3]);
    const explicitYear = match[1] ? Number(match[1]) : null;
    const ref = Number(referenceTimeMs);
    if (!explicitYear && (!Number.isFinite(ref) || ref <= 0)) return fail('deadline_year_reference_missing');
    const referenceYear = new Date(ref + 8 * 3600000).getUTCFullYear();
    const years = explicitYear ? [explicitYear] : [referenceYear - 1, referenceYear, referenceYear + 1];
    const candidates = years.map(year => {
      const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
      if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day) return null;
      const epochMs = local.getTime() - 8 * 3600000;
      return { epochMs, year, month, day, hour, minute, timeZone, yearEvidence: explicitYear ? 'explicit' : 'message_timestamp_near_date' };
    }).filter(value => value && (explicitYear || Math.abs(value.epochMs - ref) <= 183 * DAY));
    if (candidates.length !== 1) return fail('deadline_date_ambiguous');
    values.push(candidates[0]);
  }
  const unique = [...new Map(values.map(value => [value.epochMs, value])).values()];
  return unique.length === 1 ? { status: 'resolved', ...unique[0] } : fail(unique.length ? 'deadline_conflicting' : 'deadline_exact_time_missing');
}

function sourceBlocks(job) {
  const text = String(job.requestText || '');
  const headers = [...text.matchAll(/(?:【|\[)\s*背调需求[^\]】\r\n]*(?:】|\])/gu)];
  return headers.map((header, index) => ({ ordinal: index + 1, header: clean(header[0]),
    text: text.slice(header.index, headers[index + 1]?.index ?? text.length) }));
}
function blockFor(job, sourceBlock) {
  const match = clean(sourceBlock).match(/^第(\d+)(?:个)?((?:【|\[)\s*背调需求[^\]】\r\n]*(?:】|\]))块$/u);
  if (!match) return null;
  return sourceBlocks(job).find(block => block.ordinal === Number(match[1]) && block.header === match[2]) || null;
}
function deadlineLines(text) {
  return String(text || '').split(/\r?\n/u).filter(line => /ddl|deadline|截止|交付时间/iu.test(line)).join('\n');
}

/** Source receipt order may contain named colleagues between recognized range
 * endpoints. Such names are positional data and never become local codes. */
export function regularLabelCodes(label, receiptAssignments) {
  if (!own(label)) throw new DeliveryHold('delivery_label_missing');
  const order = [...new Set(receiptAssignments.map(item => code(item.code)))];
  if (!order.length || order.some(item => !item || item.length > 50 || /[\r\n\p{Cc}]/u.test(item))) throw new DeliveryHold('source_receipt_order_invalid');
  const segments = String(label).normalize('NFKC').toUpperCase().replace(/\s+/gu, '').split(/[\/、,，+]/u);
  const selected = [];
  for (const segment of segments) {
    try { selected.push(...expandDeliveryLabel(segment)); }
    catch (error) {
      if (!(error instanceof DeliveryHold) || error.code !== 'delivery_label_source_order_required') throw error;
      const endpoints = segment.split(/[-–—~～至到]/u).map(value => expandDeliveryLabel(value));
      if (endpoints.length !== 2 || endpoints.some(value => value.length !== 1)) throw new DeliveryHold('delivery_label_ambiguous');
      const start = order.indexOf(endpoints[0][0]), end = order.indexOf(endpoints[1][0]);
      if (start < 0 || end < start) throw new DeliveryHold('delivery_label_source_order_unverified');
      selected.push(...order.slice(start, end + 1));
    }
  }
  const unique = [...new Set(selected)];
  if (!unique.length || unique.some(item => !order.includes(item))) throw new DeliveryHold('delivery_label_source_order_unverified');
  return unique;
}

function candidateSources({ message, file, jobs }) {
  if (message?.chatId !== REGULAR_DELIVERY_CHAT || !own(message.messageId) || !own(file?.token)) return fail('regular_association_source_invalid');
  const deadline = parseRegularDeadline(deadlineLines(message.content), { referenceTimeMs: message.createTime });
  if (deadline.status !== 'resolved') return deadline;
  const candidates = [], issues = [];
  for (const job of jobs || []) {
    if (job.chatId !== REGULAR_DISPATCH_CHAT || job.dispatchScope?.requestMode !== 'team_dispatch' ||
      !['execute', 'no_owned_assignment'].includes(job.dispatchScope?.decision) || !own(job.requestId) || !own(job.sourceMessageId) ||
      job.intakeHold || ['intake_held', 'duplicate', 'cancelled'].includes(job.status)) continue;
    const receipts = job.dispatchScope?.receiptAssignments;
    if (!Array.isArray(receipts)) continue;
    for (const sourceBlock of new Set(receipts.map(item => item.sourceBlock))) {
      const block = blockFor(job, sourceBlock);
      if (!block) { issues.push('source_block_evidence_missing'); continue; }
      const sourceDeadline = parseRegularDeadline(deadlineLines(block.text), { referenceTimeMs: job.sourceMessageCreatedAtMs });
      if (sourceDeadline.status !== 'resolved') { issues.push(...sourceDeadline.reasons); continue; }
      if (sourceDeadline.epochMs !== deadline.epochMs) continue;
      const scopeDeadline = parseRegularDeadline(job.dispatchScope.deadline, { referenceTimeMs: job.sourceMessageCreatedAtMs });
      if (scopeDeadline.status === 'resolved' && scopeDeadline.epochMs !== sourceDeadline.epochMs) {
        issues.push('source_deadline_conflict'); continue;
      }
      const assignments = receipts.filter(item => item.sourceBlock === sourceBlock);
      if (new Set(assignments.map(assignmentKey)).size !== assignments.length) { issues.push('source_receipt_duplicate'); continue; }
      let codes;
      try { codes = regularLabelCodes(file.label, assignments); }
      catch (error) { issues.push(error instanceof DeliveryHold ? error.code : 'source_label_invalid'); continue; }
      candidates.push({ job, sourceBlock, codes, receipts: assignments, deadline: sourceDeadline });
    }
  }
  if (!candidates.length) return fail('date_label_source_unmatched', { diagnostics: [...new Set(issues)], deadline });
  return { status: 'candidates', candidates, deadline };
}

/** Scope evidence helps expand cross-family labels; it is not subject mapping
 * and cannot authorize a write. All final matching still requires a snapshot. */
export function resolveRegularLinkScope(args) {
  const result = candidateSources(args);
  if (result.status !== 'candidates') return result;
  const signatures = new Set(result.candidates.map(candidate => JSON.stringify(candidate.codes)));
  if (signatures.size !== 1) return fail('delivery_label_ambiguous');
  return { status: 'matched', deliveryMessageId: args.message.messageId, fileToken: args.file.token,
    deadline: result.deadline, scopeOnly: true, codes: result.candidates[0].codes,
    sources: result.candidates.map(({ job, sourceBlock }) => ({ requestId: job.requestId, sourceMessageId: job.sourceMessageId, sourceBlock })) };
}

function textOf(block) {
  const payload = Object.values(block || {}).find(value => value && typeof value === 'object' && Array.isArray(value.elements));
  return (payload?.elements || []).map(element => element.text_run?.content || '').join('');
}
function actualUrls(text) {
  // Preserve every byte, including query ordering and tracking parameters. URL
  // decoding, redirect following, hostname-only and substring matches cannot
  // establish this identity. Parenthesized/raw nonstandard URLs fail closed.
  return [...new Set([...String(text || '').matchAll(/https?:\/\/[^\s<>"'\[\]()]+/gu)].map(match => match[0]))];
}
function linkUrlsOf(block) {
  const payload = Object.values(block || {}).find(value => value && typeof value === 'object' && Array.isArray(value.elements));
  return (payload?.elements || []).map(element => element.text_run?.text_element_style?.link?.url)
    .filter(value => typeof value === 'string');
}
function slotsOf(snapshot) {
  const blocks = snapshot?.blocks;
  if (!Array.isArray(blocks) || blocks.length > 20000 || snapshot.complete === false) return null;
  const by = new Map(blocks.map(block => [block.block_id, block]));
  const root = by.get(snapshot.token), visited = new Set();
  if (by.size !== blocks.length || root?.block_type !== 1) return null;
  function visit(id, parent) {
    const block = by.get(id);
    if (!block || visited.has(id) || (parent && block.parent_id !== parent)) throw new Error('incomplete');
    visited.add(id);
    for (const child of block.children || []) visit(child, id);
  }
  try { visit(snapshot.token); } catch { return null; }
  if (visited.size !== blocks.length) return null;
  const children = root.children || [];
  const headings = children.map(id => by.get(id)).filter(block => block.block_type === 4);
  const allHeadingsAreRootChildren = headings.length === blocks.filter(block => block.block_type === 4).length;
  return headings.map(block => {
    const start = children.indexOf(block.block_id);
    const next = children.findIndex((id, index) => index > start && [3, 4].includes(by.get(id).block_type));
    const regionIds = new Set();
    function descend(id) { regionIds.add(id); for (const child of by.get(id).children || []) descend(child); }
    children.slice(start + 1, next < 0 ? children.length : next).forEach(descend);
    return { slotId: block.block_id, subject: clean(textOf(block)), regionIds, allHeadingsAreRootChildren };
  });
}
function reviewedAlias(evidence, assignment, candidate, target, slot) {
  return evidence?.kind === 'reviewed_subject_alias' && evidence.verified === true && own(evidence.verificationRef) &&
    evidence.requestId === candidate.job.requestId && evidence.sourceMessageId === candidate.job.sourceMessageId &&
    evidence.assignmentKey === assignmentKey(assignment) && evidence.sourceSubject === assignment.subject &&
    evidence.targetToken === target.token && String(evidence.targetRevisionId) === String(target.revisionId) &&
    evidence.slotId === slot.slotId && clean(evidence.targetSubject) === slot.subject &&
    ['per_item_alias_review', 'exact_source_url', 'explicit_source_number'].includes(evidence.basis?.kind) && own(evidence.basis?.detail);
}

function exactSourceUrlMatch(assignment, candidate, target, snapshot, slots) {
  // A single item in this exact original source block is mandatory. Receipt
  // positions from other people are retained; none may be silently discarded.
  if (candidate.receipts.length !== 1 || assignmentKey(candidate.receipts[0]) !== assignmentKey(assignment)) return null;
  const block = blockFor(candidate.job, assignment.sourceBlock);
  if (!block || !Array.isArray(assignment.anchors) || assignment.anchors.length !== 1) return null;
  const url = assignment.anchors[0];
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (typeof url !== 'string' || url !== url.trim() || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const sourceUrls = actualUrls(block.text);
  if (sourceUrls.length !== 1 || sourceUrls[0] !== url ||
    sourceBlocks(candidate.job).filter(other => actualUrls(other.text).includes(url)).length !== 1) return null;
  const linkedBlocks = snapshot.blocks.filter(item => linkUrlsOf(item).includes(url));
  if (!linkedBlocks.length) return null;
  const referringBlocks = snapshot.blocks.filter(item => linkUrlsOf(item).includes(url) || actualUrls(textOf(item)).includes(url));
  const matching = slots.filter(slot => slot.allHeadingsAreRootChildren && own(slot.subject) &&
    !/^(?:TS\d*|JW\d+|BK\d+|临[A-J]|风险摘要|基本信息|背调详情)$/iu.test(slot.subject) &&
    referringBlocks.every(item => slot.regionIds.has(item.block_id)));
  // This also rejects links before H2, after a following H1, nested H2, and
  // the same URL in a second subject range. A text label is not a link target.
  if (matching.length !== 1) return null;
  const slot = matching[0];
  return { slot, evidence: { kind: 'exact_source_url', requestId: candidate.job.requestId,
    sourceMessageId: candidate.job.sourceMessageId, sourceBlock: assignment.sourceBlock,
    assignmentKey: assignmentKey(assignment), sourceSubject: assignment.subject,
    targetToken: target.token, targetRevisionId: target.revisionId, slotId: slot.slotId,
    targetSubject: slot.subject, url, sourceReceiptCount: 1, sourceAnchorCount: 1,
    matchingSourceBlockCount: 1, matchingTargetSectionCount: 1,
    targetLinkBlockIds: linkedBlocks.map(item => item.block_id), verification: 'exact_original_source_and_full_snapshot' } };
}

/** Resolve exact source batch + block + label + subject. subjectEvidence is a
 * trusted, per-item reviewed evidence input, never data extracted from messages.
 * This resolver does not approve document content or insertion boundaries. */
export function resolveRegularAssociations({ message, file, target, snapshot, jobs, subjectEvidence = [] }) {
  if (snapshot?.token !== target?.token || String(snapshot?.revisionId) !== String(target?.revisionId) || file?.token !== target?.token) return fail('target_snapshot_identity_mismatch');
  const slots = slotsOf(snapshot);
  if (!slots) return fail('target_snapshot_incomplete');
  const result = candidateSources({ message, file, jobs });
  if (result.status !== 'candidates') return result;
  const titleDate = [...String(target.title || snapshot.title || '').normalize('NFKC').matchAll(DATE)][0];
  if (titleDate && (Number(titleDate[2]) !== result.deadline.month || Number(titleDate[3]) !== result.deadline.day ||
    (titleDate[1] && Number(titleDate[1]) !== result.deadline.year))) return fail('target_title_batch_conflict');
  const matches = [], missing = [];
  for (const candidate of result.candidates) {
    const assignments = candidate.job.dispatchScope.assignments || [];
    for (const assignment of assignments.filter(item => item.sourceBlock === candidate.sourceBlock && candidate.codes.includes(item.code) && LOCAL_DELIVERY_CODES.includes(item.code))) {
      if (candidate.receipts.filter(item => assignmentKey(item) === assignmentKey(assignment)).length !== 1 || assignments.filter(item => assignmentKey(item) === assignmentKey(assignment)).length !== 1) return fail('source_assignment_receipt_conflict');
      const exact = slots.filter(slot => slot.subject === clean(assignment.subject));
      const aliases = slots.flatMap(slot => subjectEvidence.filter(evidence => reviewedAlias(evidence, assignment, candidate, target, slot)).map(evidence => ({ slot, evidence })));
      if (aliases.length > 1 || (exact.length && aliases.some(alias => alias.slot.slotId !== exact[0].slotId))) return fail('subject_alias_conflicting');
      const urlMatch = exactSourceUrlMatch(assignment, candidate, target, snapshot, slots);
      if (urlMatch && ((exact.length && exact[0].slotId !== urlMatch.slot.slotId) ||
        aliases.some(alias => alias.slot.slotId !== urlMatch.slot.slotId))) return fail('subject_identity_evidence_conflicting');
      const selected = exact.length ? exact : aliases.length ? aliases.map(alias => alias.slot) : urlMatch ? [urlMatch.slot] : [];
      if (selected.length > 1) return fail('subject_slot_ambiguous');
      if (!selected.length) {
        missing.push({ reason: 'subject_exact_or_reviewed_alias_missing', requestId: candidate.job.requestId,
          sourceMessageId: candidate.job.sourceMessageId, sourceBlock: assignment.sourceBlock, code: assignment.code,
          sourceSubject: assignment.subject, targetToken: target.token, targetSubjects: slots.map(slot => slot.subject) });
        continue;
      }
      const slot = selected[0], job = candidate.job;
      matches.push({ ...structuredClone(assignment), requestId: job.requestId, sourceMessageId: job.sourceMessageId,
        batchId: job.batchId || job.requestId, targetToken: target.token, slotId: slot.slotId, targetSubject: slot.subject,
        subjectMatch: exact.length ? { kind: 'exact_subject' } : aliases.length ?
          { kind: 'reviewed_subject_alias', verificationRef: aliases[0].evidence.verificationRef } : urlMatch.evidence,
        evidence: { kind: 'source_and_target', deliveryMessageId: message.messageId, sourceMessageId: job.sourceMessageId,
          documentToken: target.token, targetRevisionId: target.revisionId, matchingRequestCount: 1, matchingSubjectCount: 1, matchingSlotCount: 1,
          sourceBlock: candidate.sourceBlock, deadlineEpochMs: result.deadline.epochMs, label: file.label,
          receiptCodes: candidate.receipts.map(item => item.code), sourceOrderVerified: true } });
    }
  }
  if (!matches.length) return fail(missing.length ? 'subject_mapping_missing' : 'file_has_no_local_assignment', { missing, deadline: result.deadline });
  if (new Set(matches.map(match => match.slotId)).size !== matches.length) return fail('subject_source_ambiguous');
  // More than one source batch matching different headings is still a batch
  // conflict. A multi-file message may map different files independently.
  if (new Set(matches.map(match => `${match.requestId}/${match.sourceMessageId}`)).size !== 1) return fail('source_batch_ambiguous');
  const matchedSources = new Set(matches.map(match => `${match.requestId}/${match.sourceMessageId}/${match.sourceBlock}`));
  if (missing.some(item => matchedSources.has(`${item.requestId}/${item.sourceMessageId}/${item.sourceBlock}`))) return fail('subject_mapping_partial', { missing });
  return { status: 'matched', matches, reasons: [], deadline: result.deadline, deliveryMessageId: message.messageId,
    fileToken: file.token, sources: [...new Map(matches.map(match => [JSON.stringify([match.requestId, match.sourceMessageId, match.sourceBlock]),
      { requestId: match.requestId, sourceMessageId: match.sourceMessageId, sourceBlock: match.sourceBlock }])).values()] };
}
