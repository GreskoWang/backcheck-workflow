import { deliveryHash, requireDelivery } from './delivery-policy.mjs';

// Pure planner: no API access, no mutation retries, and no review verdicts.
export const RISK_MERGE_PLAN_VERSION = 'risk-merge-plan-1';
const clone = value => structuredClone(value);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
const hash = value => deliveryHash(stable(value));
const equal = (a, b) => hash(a) === hash(b);
export function riskBlockText(block) {
  const payload = Object.values(block || {}).find(value => Array.isArray(value?.elements));
  return (payload?.elements || []).map(element => element.text_run?.content || '').join('');
}
function snapshotTree(input) {
  const token = input?.token || input?.document?.document_id;
  const revisionId = input?.revisionId ?? input?.document?.revision_id;
  const blocks = input?.blocks || input?.block_list?.items;
  requireDelivery(typeof token === 'string' && Number.isSafeInteger(revisionId) && revisionId > 0, 'risk_snapshot_identity_missing');
  requireDelivery(input?.block_list?.has_more !== true && input?.hasMore !== true && Array.isArray(blocks) && blocks.length <= 20000, 'risk_snapshot_incomplete');
  const by = new Map(blocks.map(block => [block.block_id, block]));
  requireDelivery(by.size === blocks.length && by.get(token)?.block_type === 1, 'risk_tree_invalid');
  const seen = new Set();
  function walk(id, parent) {
    const block = by.get(id);
    requireDelivery(block && !seen.has(id) && (!parent || block.parent_id === parent), 'risk_tree_invalid');
    seen.add(id);
    requireDelivery(!block.children || Array.isArray(block.children), 'risk_tree_invalid');
    for (const child of block.children || []) walk(child, id);
  }
  walk(token);
  requireDelivery(seen.size === by.size, 'risk_tree_incomplete');
  return { token, revisionId, blocks, by, root: by.get(token) };
}
function snapshotValue(tree) {
  return { token: tree.token, revisionId: tree.revisionId, blocks: clone(tree.blocks) };
}
function clean(block) {
  const result = clone(block);
  delete result.block_id; delete result.parent_id; delete result.children;
  for (const value of Object.values(result)) {
    if (value?.style?.indentation_level === 'NoIndent') delete value.style.indentation_level;
  }
  return result;
}
function nodesFrom(tree, ids, numbered = false) {
  let number = 0;
  function visit(id) {
    const source = tree.by.get(id);
    let block = clean(source);
    if (numbered && source.block_type === 13) {
      number += 1;
      block = { block_type: 2, text: { elements: [{ text_run: {
        content: `${number}. ${riskBlockText(source)}`,
        text_element_style: { bold: false, inline_code: false, italic: false, strikethrough: false, underline: false },
      } }], style: { align: 1, folded: false } } };
    }
    return { sourceId: id, block, children: (source.children || []).map(visit), hasChildren: Object.hasOwn(source, 'children') };
  }
  return ids.map(visit);
}
function nodeBlocks(nodes) {
  return nodes.map(node => ({ ...clone(node.block), ...(node.hasChildren ? { children: nodeBlocks(node.children) } : {}) }));
}
function allNodes(nodes) { return nodes.flatMap(node => [node, ...allNodes(node.children)]); }
function canonical(tree, ids) { return nodeBlocks(nodesFrom(tree, ids)); }
function section(tree, slotId, subject) {
  const ids = tree.root.children || [], start = ids.indexOf(slotId);
  requireDelivery(start >= 0 && tree.by.get(slotId).block_type === 4 && riskBlockText(tree.by.get(slotId)) === subject, 'risk_subject_slot_mismatch');
  const offset = ids.slice(start + 1).findIndex(id => [3, 4].includes(tree.by.get(id).block_type));
  const end = offset < 0 ? ids.length : start + 1 + offset;
  return { start, end, ids: ids.slice(start + 1, end), nextHeadingId: ids[end] || null };
}
export function riskAppendPrefixEvidence({ snapshot, slotId, subject }) {
  const tree = snapshotTree(snapshot), own = section(tree, slotId, subject);
  return { targetToken: tree.token, revisionId: tree.revisionId, slotId,
    rootBlockIds: clone(own.ids), contentHash: hash(canonical(tree, own.ids)) };
}
function sourceBodySection(tree, plan) {
  const own = section(tree, plan.slotId, plan.targetSubject), prefix = plan.preservedBodyPrefixIds || [];
  requireDelivery(equal(own.ids.slice(0, prefix.length), prefix), 'risk_preserved_prefix_changed');
  return { ...own, start: own.start + prefix.length, ids: own.ids.slice(prefix.length), allIds: own.ids };
}
function prefixLength(actual, expected, code) {
  requireDelivery(actual.length <= expected.length && actual.every((item, index) => equal(item, expected[index])), code);
  return actual.length;
}
function alignNodes(nodes, tree, ids, mapping = {}, options = {}) {
  requireDelivery(nodes.length === ids.length, 'risk_block_mapping_incomplete');
  nodes.forEach((node, i) => {
    const actual = tree.by.get(ids[i]);
    requireDelivery(actual, 'risk_block_mapping_incomplete');
    const expected = clone(node.block);
    if (expected.block_type === 27 && options.plan) {
      const sourceImageToken = expected.image?.token, targetImageToken = actual.image?.token;
      requireDelivery(typeof sourceImageToken === 'string' && sourceImageToken, 'risk_source_image_token_missing');
      if (options.placeholders && !targetImageToken) {
        expected.image.token = targetImageToken;
        if (!Object.hasOwn(actual.image || {}, 'token')) delete expected.image.token;
        options.images?.push({ sourceDocumentId: options.plan.sourceToken, targetDocumentId: options.plan.targetToken,
          sourceBlockId: node.sourceId, targetBlockId: ids[i], sourceImageToken,
          slotId: options.plan.slotId, planHash: options.plan.planHash, stageId: options.stageId });
      } else {
        const matches = (options.mediaProofs || []).filter(proof => proof.sourceBlockId === node.sourceId && proof.targetBlockId === ids[i]);
        requireDelivery(matches.length === 1, 'risk_image_transfer_proof_missing');
        const proof = matches[0], sourceDoc = proof.sourceDocumentId || proof.sourceDocId, targetDoc = proof.targetDocumentId || proof.targetDocId;
        requireDelivery(sourceDoc === options.plan.sourceToken && targetDoc === tree.token && proof.sourceImageToken === sourceImageToken &&
          proof.targetImageToken === targetImageToken && typeof targetImageToken === 'string' && targetImageToken &&
          /^[a-f0-9]{64}$/u.test(proof.sourceSha256 || '') && proof.sourceSha256 === proof.targetSha256 &&
          proof.planHash === options.plan.planHash && proof.slotId === options.plan.slotId && proof.stageId === options.stageId,
        'risk_image_transfer_proof_mismatch');
        expected.image.token = targetImageToken;
      }
    }
    requireDelivery(equal(expected, clean(actual)) && node.hasChildren === Object.hasOwn(actual, 'children'), 'risk_block_mapping_conflict');
    mapping[node.sourceId] = ids[i];
    alignNodes(node.children, tree, actual.children || [], mapping, options);
  });
  return mapping;
}
function prefixNodesLength(tree, ids, nodes, code, options = {}) {
  requireDelivery(ids.length <= nodes.length, code);
  try { alignNodes(nodes.slice(0, ids.length), tree, ids, {}, options); }
  catch (error) { if (error.code === 'risk_block_mapping_conflict') requireDelivery(false, code); throw error; }
  return ids.length;
}
function visitLinks(value, callback) {
  if (Array.isArray(value)) value.forEach(item => visitLinks(item, callback));
  else if (value && typeof value === 'object') {
    if (value.link && typeof value.link.url === 'string') callback(value.link);
    Object.values(value).forEach(item => visitLinks(item, callback));
  }
}
function internalLink(url, token) {
  if (url.startsWith('#')) return { anchor: url.slice(1), relative: true };
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.pathname.replace(/\/$/u, '') !== `/docx/${token}`) return null;
  requireDelivery(parsed.protocol === 'https:' && /(^|\.)feishu\.cn$/u.test(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port, 'risk_internal_link_origin_invalid');
  requireDelivery(parsed.hash && !parsed.search, 'risk_internal_link_anchor_missing');
  return { anchor: parsed.hash.slice(1), origin: parsed.origin };
}
function reboundSummary(plan, mapping) {
  const nodes = clone(plan.summaryNodes);
  visitLinks(nodes, link => {
    const parsed = internalLink(link.url, plan.sourceToken);
    if (!parsed) return;
    const target = mapping[parsed.anchor];
    requireDelivery(typeof target === 'string' && target, 'risk_summary_link_target_unmapped');
    link.url = `${plan.targetOrigin || parsed.origin || 'https://my.feishu.cn'}/docx/${plan.targetToken}#${target}`;
  });
  return nodes;
}
function riskOrder(job, association) {
  const input = association.summaryOrder || job?.dispatchScope?.receiptAssignments || job?.dispatchScope?.assignments;
  requireDelivery(Array.isArray(input) && input.length > 0, 'risk_dispatch_order_missing');
  const subjects = input.filter(item => typeof item === 'string' || !association.sourceBlock || item.sourceBlock === association.sourceBlock)
    .map(item => typeof item === 'string' ? item : item.targetSubject || item.subject);
  requireDelivery(subjects.every(name => typeof name === 'string' && name) && new Set(subjects).size === subjects.length, 'risk_dispatch_order_ambiguous');
  return subjects;
}
function summaryRegion(tree, plan) {
  const ids = tree.root.children || [];
  const h1 = title => ids.filter(id => tree.by.get(id).block_type === 3 && riskBlockText(tree.by.get(id)) === title);
  const starts = h1('风险摘要'), ends = h1('基本信息和背调详情');
  const explicit = plan.summaryRegion;
  const startId = explicit?.startHeadingId || (starts.length === 1 ? starts[0] : null);
  const endId = explicit?.endHeadingId || (ends.length === 1 ? ends[0] : null);
  requireDelivery(startId && endId && ids.includes(startId) && ids.includes(endId), 'risk_summary_region_unknown');
  requireDelivery(tree.by.get(startId).block_type === 3 && riskBlockText(tree.by.get(startId)) === '风险摘要' &&
    tree.by.get(endId).block_type === 3 && riskBlockText(tree.by.get(endId)) === '基本信息和背调详情', 'risk_summary_region_mismatch');
  const start = ids.indexOf(startId), end = ids.indexOf(endId);
  requireDelivery(start < end && ids.indexOf(plan.slotId) > end, 'risk_summary_region_mismatch');
  const headings = ids.slice(start + 1, end).filter(id => tree.by.get(id).block_type === 4);
  const names = headings.map(id => riskBlockText(tree.by.get(id)));
  const ranks = names.map(name => plan.subjectOrder.indexOf(name.endsWith('风险摘要') ? name.slice(0, -4) : ''));
  requireDelivery(ranks.every(rank => rank >= 0) && ranks.every((rank, i) => !i || rank > ranks[i - 1]), 'risk_summary_order_conflict');
  // Every root item in this region must belong to a named summary. Unknown
  // loose content before the first summary is never adopted as our slot.
  const first = headings.length ? ids.indexOf(headings[0]) : end;
  requireDelivery(first === start + 1, 'risk_summary_region_has_unassigned_content');
  const ownName = `${plan.targetSubject}风险摘要`, ownIndex = names.indexOf(ownName);
  if (ownIndex >= 0) {
    const ownStart = ids.indexOf(headings[ownIndex]);
    const ownEnd = ownIndex + 1 < headings.length ? ids.indexOf(headings[ownIndex + 1]) : end;
    return { start: ownStart, end: ownEnd, ids: ids.slice(ownStart, ownEnd), startHeadingId: startId, endHeadingId: endId };
  }
  const rank = plan.subjectOrder.indexOf(plan.targetSubject);
  requireDelivery(rank >= 0, 'risk_subject_order_missing');
  const following = ranks.findIndex(value => value > rank);
  const index = following < 0 ? end : ids.indexOf(headings[following]);
  return { start: index, end: index, ids: [], startHeadingId: startId, endHeadingId: endId };
}
function assertOriginalPreserved(original, current) {
  requireDelivery(original.token === current.token, 'risk_target_token_mismatch');
  const oldIds = original.root.children || [], ids = current.root.children || [];
  requireDelivery(equal(ids.filter(id => oldIds.includes(id)), oldIds), 'risk_original_order_changed');
  for (const [id, block] of original.by) {
    const found = current.by.get(id);
    requireDelivery(found && equal(id === original.token ? clean(block) : block, id === original.token ? clean(found) : found), 'risk_original_content_changed');
  }
}

/** The caller must have independently bound sourceSnapshot to a current real
 * source audit. This planner never turns risk groups or supplied text into PASS. */
export function planRiskMerge({ job, association, sourceSnapshot, targetSnapshot, approvedAppendPrefix = null }) {
  const source = snapshotTree(sourceSnapshot), target = snapshotTree(targetSnapshot);
  requireDelivery(job?.requestId && sourceSnapshot.requestId === job.requestId && association?.slotId && association.subject, 'risk_plan_binding_missing');
  requireDelivery(source.token !== target.token, 'risk_source_is_target');
  requireDelivery(Array.isArray(sourceSnapshot.review_context?.risk_groups) && sourceSnapshot.review_context.risk_groups.length > 0, 'risk_source_groups_missing');
  const rootIds = source.root.children || [];
  const basics = rootIds.filter(id => source.by.get(id).block_type === 5 && riskBlockText(source.by.get(id)) === '基本信息');
  const summaries = rootIds.filter(id => source.by.get(id).block_type === 5 && riskBlockText(source.by.get(id)) === '风险摘要');
  requireDelivery(basics.length === 1 && summaries.length === 1, 'risk_source_structure_unsupported');
  const basic = rootIds.indexOf(basics[0]), summary = rootIds.indexOf(summaries[0]);
  requireDelivery(summary < basic && basic > summary + 1, 'risk_source_summary_empty');
  const bodyNodes = nodesFrom(source, rootIds.slice(basic), true);
  const summaryNodes = nodesFrom(source, rootIds.slice(summary, basic));
  const targetSubject = association.targetSubject || association.subject;
  const oldHeading = summaryNodes[0].block.heading3;
  summaryNodes[0].block = { block_type: 4, heading2: { ...clone(oldHeading), elements: [{ text_run: { content: `${targetSubject}风险摘要` } }] } };
  const bodySourceIds = new Set(allNodes(bodyNodes).map(node => node.sourceId));
  let internalCount = 0;
  visitLinks(summaryNodes, link => {
    const parsed = internalLink(link.url, source.token);
    if (parsed) { requireDelivery(bodySourceIds.has(parsed.anchor), 'risk_summary_link_outside_body'); internalCount += 1; }
  });
  requireDelivery(internalCount > 0, 'risk_summary_internal_links_missing');
  visitLinks(bodyNodes, link => requireDelivery(!internalLink(link.url, source.token), 'risk_body_internal_links_require_separate_plan'));
  const plan = { version: RISK_MERGE_PLAN_VERSION, requestId: job.requestId, sourceToken: source.token,
    sourceRevisionId: source.revisionId, targetToken: target.token, targetSubject, subject: association.subject,
    slotId: association.slotId, subjectOrder: riskOrder(job, association), bodyNodes, summaryNodes,
    sourceSnapshot: clone(sourceSnapshot), beforeSnapshot: snapshotValue(target),
    summaryRegion: clone(association.summaryRegion || null), targetOrigin: association.targetOrigin || null,
    preservedBodyPrefixIds: [],
    stages: [{ stageId: 'body', dependsOn: null }, { stageId: 'summary', dependsOn: 'body' }],
    reviewRequired: 'latest_shared_full_document_PASS' };
  if (plan.targetOrigin) requireDelivery(/^https:\/\/[a-z0-9.-]+\.feishu\.cn$/u.test(plan.targetOrigin), 'risk_target_origin_invalid');
  if (approvedAppendPrefix) {
    const evidence = riskAppendPrefixEvidence({ snapshot: targetSnapshot, slotId: plan.slotId, subject: targetSubject });
    requireDelivery(approvedAppendPrefix.verdict === 'append_safe' && typeof approvedAppendPrefix.reviewerId === 'string' && approvedAppendPrefix.reviewerId &&
      typeof approvedAppendPrefix.rationale === 'string' && approvedAppendPrefix.rationale && evidence.rootBlockIds.length > 0 &&
      Object.entries(evidence).every(([key, value]) => equal(value, approvedAppendPrefix[key])), 'risk_preserved_prefix_evidence_mismatch');
    const nodes = allNodes(nodesFrom(target, evidence.rootBlockIds));
    requireDelivery(!nodes.some(node => [3, 4, 5].includes(node.block.block_type) &&
      ['基本信息', '背调详情', '风险摘要'].includes(riskBlockText(node.block))), 'risk_preserved_prefix_contains_report');
    plan.preservedBodyPrefixIds = clone(evidence.rootBlockIds);
    plan.approvedAppendPrefix = clone(approvedAppendPrefix);
  }
  const body = sourceBodySection(target, plan);
  // An existing image-bearing copy requires its own established transfer
  // evidence; do not infer image equality merely from shape or count.
  prefixNodesLength(target, body.ids, bodyNodes, 'risk_body_existing_content_conflict', { plan, stageId: 'body' });
  const region = summaryRegion(target, plan);
  plan.summaryRegion = { startHeadingId: region.startHeadingId, endHeadingId: region.endHeadingId };
  // Existing summary can be compared only after its target IDs are known.
  if (region.ids.length && body.ids.length !== bodyNodes.length) requireDelivery(false, 'risk_existing_summary_with_incomplete_body');
  if (region.ids.length) prefixLength(canonical(target, region.ids), nodeBlocks(reboundSummary(plan, alignNodes(bodyNodes, target, body.ids))), 'risk_summary_existing_content_conflict');
  plan.planHash = hash(plan);
  return plan;
}
function checkPlan(plan) {
  const value = clone(plan); delete value.planHash;
  requireDelivery(plan.version === RISK_MERGE_PLAN_VERSION && hash(value) === plan.planHash, 'risk_plan_changed');
}
export function prepareRiskMergeStage({ plan, stageId, snapshot, mediaProofs = [] }) {
  checkPlan(plan);
  requireDelivery(['body', 'summary'].includes(stageId), 'risk_stage_unknown');
  const current = snapshotTree(snapshot), original = snapshotTree(plan.beforeSnapshot);
  assertOriginalPreserved(original, current);
  const body = sourceBodySection(current, plan);
  let nodes, range, mapping = {};
  if (stageId === 'body') {
    requireDelivery(equal(snapshotValue(current), plan.beforeSnapshot), 'risk_target_changed_before_body');
    nodes = plan.bodyNodes; range = { start: body.start + 1, ids: body.ids };
  } else {
    mapping = alignNodes(plan.bodyNodes, current, body.ids, {}, { plan, mediaProofs, stageId: 'body' });
    nodes = reboundSummary(plan, mapping); range = summaryRegion(current, plan);
    assertOnlyOwnedAdditions(plan, current, body.ids, range.ids);
  }
  const offset = prefixNodesLength(current, range.ids, nodes, `risk_${stageId}_existing_content_conflict`, { plan, mediaProofs, stageId });
  const index = range.start + offset, blocks = nodeBlocks(nodes.slice(offset)), rootIds = current.root.children || [];
  const writeBlocks = clone(blocks);
  function emptyImageTokens(values) {
    for (const value of values) { if (value.block_type === 27) value.image.token = ''; emptyImageTokens(value.children || []); }
  }
  emptyImageTokens(writeBlocks);
  const stage = { planHash: plan.planHash, stageId, status: blocks.length ? 'insert' : 'noop',
    targetToken: current.token, parentBlockId: current.token, expectedRevisionId: current.revisionId,
    index, expectedBeforeId: rootIds[index - 1] || null, expectedAfterId: rootIds[index] || null,
    blocks, writeBlocks, imageBindings: allNodes(nodes.slice(offset)).filter(node => node.block.block_type === 27)
      .map(node => ({ sourceBlockId: node.sourceId, sourceImageToken: node.block.image.token })),
    sourceIds: nodes.slice(offset).map(node => node.sourceId), sourceToTargetBlockIds: mapping,
    beforeSnapshot: snapshotValue(current), expectedBlocksHash: hash(blocks) };
  stage.stepHash = hash(stage);
  return stage;
}
function assertOnlyOwnedAdditions(plan, current, bodyIds, summaryIds) {
  const original = snapshotTree(plan.beforeSnapshot), owned = new Set();
  function walk(id) { owned.add(id); for (const child of current.by.get(id).children || []) walk(child); }
  [...bodyIds, ...summaryIds].forEach(walk);
  for (const id of current.by.keys()) requireDelivery(original.by.has(id) || owned.has(id), 'risk_unrelated_blocks_added');
}
function inspectStage({ plan, stage, snapshot, mediaProofs = [], placeholders = false }) {
  checkPlan(plan);
  const value = clone(stage); delete value.stepHash;
  requireDelivery(stage.planHash === plan.planHash && hash(value) === stage.stepHash, 'risk_stage_changed');
  const before = snapshotTree(stage.beforeSnapshot), after = snapshotTree(snapshot);
  assertOriginalPreserved(before, after);
  const beforeIds = before.root.children || [], afterIds = after.root.children || [];
  const inserted = afterIds.slice(stage.index, stage.index + stage.blocks.length);
  requireDelivery(equal(afterIds, [...beforeIds.slice(0, stage.index), ...inserted, ...beforeIds.slice(stage.index)]) &&
    inserted.every(id => !before.by.has(id)), 'risk_stage_readback_mismatch');
  const body = sourceBodySection(after, plan);
  const images = [];
  const mapping = alignNodes(plan.bodyNodes, after, body.ids, {}, { plan, mediaProofs, placeholders: placeholders && stage.stageId === 'body', images, stageId: 'body' });
  const all = stage.stageId === 'body' ? plan.bodyNodes : reboundSummary(plan, mapping);
  const ownNodes = all.filter(node => stage.sourceIds.includes(node.sourceId));
  requireDelivery(equal(ownNodes.map(node => node.sourceId), stage.sourceIds) && equal(nodeBlocks(ownNodes), stage.blocks), 'risk_stage_source_mismatch');
  alignNodes(ownNodes, after, inserted, {}, { plan, mediaProofs, placeholders, images: stage.stageId === 'summary' ? images : null, stageId: stage.stageId });
  const added = after.blocks.filter(block => !before.by.has(block.block_id));
  const expectedAdded = new Set();
  function walk(id) { expectedAdded.add(id); for (const child of after.by.get(id).children || []) walk(child); }
  inserted.forEach(walk);
  requireDelivery(added.length === expectedAdded.size && added.every(block => expectedAdded.has(block.block_id)), 'risk_stage_unrelated_blocks_added');
  requireDelivery(stage.status === 'noop' ? after.revisionId === before.revisionId : after.revisionId > before.revisionId, 'risk_stage_revision_unconfirmed');
  return { status: placeholders && images.length ? 'media_pending' : 'confirmed', planHash: plan.planHash, stepHash: stage.stepHash, stageId: stage.stageId,
    targetToken: after.token, revisionId: after.revisionId, createdBlockIds: [...expectedAdded],
    sourceToTargetBlockIds: mapping, images, originalBlocksUnchanged: true, snapshotHash: hash(snapshotValue(after)) };
}
export function confirmRiskMergeStage(args) { return inspectStage({ ...args, placeholders: false }); }
export function inspectRiskMergePlaceholders(args) {
  const result = inspectStage({ ...args, placeholders: true });
  requireDelivery(result.images.every(image => result.createdBlockIds.includes(image.targetBlockId)), 'risk_image_placeholder_not_new');
  return { ...result, status: 'media_pending', requiresFinalReadback: true };
}
export const confirmRiskMergePlaceholder = inspectRiskMergePlaceholders;
/** Deterministic proof only. Semantic, visual, business-risk, jump and fresh
 * revision checks remain mandatory in the separate whole-document reviewer. */
export function verifyRiskMergeProjection({ plan, snapshot, mediaProofs = [] }) {
  checkPlan(plan);
  const current = snapshotTree(snapshot), original = snapshotTree(plan.beforeSnapshot);
  assertOriginalPreserved(original, current);
  const body = sourceBodySection(current, plan), region = summaryRegion(current, plan);
  const mapping = alignNodes(plan.bodyNodes, current, body.ids, {}, { plan, mediaProofs, stageId: 'body' });
  const summary = reboundSummary(plan, mapping);
  try { alignNodes(summary, current, region.ids, {}, { plan, mediaProofs, stageId: 'summary' }); }
  catch (error) { if (error.code === 'risk_block_mapping_conflict') requireDelivery(false, 'risk_summary_projection_mismatch'); throw error; }
  assertOnlyOwnedAdditions(plan, current, body.ids, region.ids);
  return { deterministic: 'verified', reviewRequired: plan.reviewRequired, planHash: plan.planHash,
    targetToken: current.token, revisionId: current.revisionId, sourceToTargetBlockIds: mapping,
    bodyRootBlockIds: body.ids, preservedBodyPrefixIds: clone(plan.preservedBodyPrefixIds), summaryRootBlockIds: region.ids, originalBlocksUnchanged: true,
    snapshotHash: hash(snapshotValue(current)) };
}
