import test from 'node:test';
import assert from 'node:assert/strict';
import { planRiskMerge, prepareRiskMergeStage, confirmRiskMergeStage, verifyRiskMergeProjection, riskAppendPrefixEvidence, inspectRiskMergePlaceholders } from '../src/risk-merge-plan.mjs';

// Deliberately synthetic offline fixtures; these are not source review PASSes.
const text = value => ({ elements: [{ text_run: { content: value } }] });
const block = (id, type, value, parent = 'Source') => ({ block_id: id, parent_id: parent, block_type: type,
  [{ 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 13: 'ordered' }[type]]: text(value) });
export function fixture() {
  const source = { requestId: 'RQ-TEST', document: { document_id: 'Source', revision_id: 4 }, review_context: { risk_groups: [{ title: 'Synthetic risk' }] },
    block_list: { has_more: false, items: [
      { block_id: 'Source', block_type: 1, children: ['risk', 'example', 'callout', 'basic', 'details', 'platform', 'fact'] },
      block('risk', 5, '风险摘要'), block('example', 6, '举例1'),
      { block_id: 'callout', parent_id: 'Source', block_type: 19, callout: { emoji_id: 'pushpin' }, children: ['summaryText'] },
      { block_id: 'summaryText', parent_id: 'callout', block_type: 2, text: { elements: [{ text_run: { content: 'Synthetic fact', text_element_style: {
        link: { url: 'https://my.feishu.cn/docx/Source#fact' } } } }] } },
      block('basic', 5, '基本信息'), block('details', 5, '背调详情'), block('platform', 13, 'Synthetic platform'), block('fact', 2, 'Synthetic fact'),
    ] } };
  const target = { token: 'Target', revisionId: 8, blocks: [
    { block_id: 'Target', block_type: 1, children: ['riskStart', 'bodyStart', 'subject', 'other', 'otherText'] },
    block('riskStart', 3, '风险摘要', 'Target'), block('bodyStart', 3, '基本信息和背调详情', 'Target'),
    block('subject', 4, 'Subject', 'Target'), block('other', 4, 'Other', 'Target'), block('otherText', 2, 'Untouched author text', 'Target'),
  ] };
  const assignment = { subject: 'Subject', slotId: 'subject', sourceBlock: 'block-1' };
  const job = { requestId: 'RQ-TEST', dispatchScope: { receiptAssignments: [assignment, { subject: 'Other', sourceBlock: 'block-1' }] } };
  return { source, target, assignment, job };
}
const planFor = f => planRiskMerge({ job: f.job, association: f.assignment, sourceSnapshot: f.source, targetSnapshot: f.target });
export function applyStage(snapshot, stage) {
  const next = structuredClone(snapshot), ids = [];
  let count = 0;
  function add(node, parent) {
    const id = `${stage.stageId}_${snapshot.revisionId}_${++count}`, item = { ...structuredClone(node), block_id: id, parent_id: parent };
    delete item.children; next.blocks.push(item);
    if (node.children) item.children = node.children.map(child => add(child, id));
    return id;
  }
  stage.blocks.forEach(node => ids.push(add(node, next.token)));
  next.blocks.find(item => item.block_id === next.token).children.splice(stage.index, 0, ...ids);
  if (ids.length) next.revisionId += 1;
  return next;
}
function bodyDone(f) {
  const plan = planFor(f), stage = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  const next = applyStage(f.target, stage), proof = confirmRiskMergeStage({ plan, stage, snapshot: next });
  return { plan, next, proof, stage };
}

test('two insertion stages rebind nested summary links to actual body IDs and preserve other authors', () => {
  const f = fixture(), { plan, next, proof } = bodyDone(f);
  assert.deepEqual(plan.stages.map(stage => stage.stageId), ['body', 'summary']);
  const stage = prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next });
  assert.equal(stage.blocks[0].heading2.elements[0].text_run.content, 'Subject风险摘要');
  assert.equal(stage.blocks[2].children[0].text.elements[0].text_run.text_element_style.link.url,
    `https://my.feishu.cn/docx/Target#${proof.sourceToTargetBlockIds.fact}`);
  const final = applyStage(next, stage);
  assert.equal(confirmRiskMergeStage({ plan, stage, snapshot: final }).createdBlockIds.length, 4);
  const result = verifyRiskMergeProjection({ plan, snapshot: final });
  assert.equal(result.deterministic, 'verified'); assert.equal(result.reviewRequired, 'latest_shared_full_document_PASS');
  assert.equal(result.verdict, undefined); assert.deepEqual(final.blocks.find(item => item.block_id === 'otherText'), f.target.blocks.at(-1));
});

test('summary preparation is blocked until full body can be mapped', () => {
  const f = fixture(), plan = planFor(f);
  assert.throws(() => prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: f.target }), /risk_block_mapping_incomplete/);
});

test('an exact existing body prefix appends only missing root blocks', () => {
  const f = fixture(), firstPlan = planFor(f), firstStage = prepareRiskMergeStage({ plan: firstPlan, stageId: 'body', snapshot: f.target });
  f.target = applyStage(f.target, { ...firstStage, blocks: firstStage.blocks.slice(0, 2) });
  const plan = planFor(f), stage = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  assert.equal(stage.blocks.length, 2); assert.equal(stage.expectedBeforeId, 'body_8_2');
  assert.equal(stage.blocks[0].text.elements[0].text_run.content, '1. Synthetic platform');
});

test('full existing body and summary deduplicate to noops', () => {
  const f = fixture(), { plan, next } = bodyDone(f);
  f.target = applyStage(next, prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next }));
  const repeated = planFor(f);
  for (const stageId of ['body', 'summary']) {
    const stage = prepareRiskMergeStage({ plan: repeated, stageId, snapshot: f.target });
    assert.equal(stage.status, 'noop'); assert.equal(stage.blocks.length, 0);
    assert.equal(confirmRiskMergeStage({ plan: repeated, stage, snapshot: f.target }).status, 'confirmed');
  }
});

test('nonempty conflicting slot never authorizes deletion or replacement', () => {
  const f = fixture(); f.target.blocks[0].children.splice(3, 0, 'human'); f.target.blocks.push(block('human', 2, 'Human addition', 'Target'));
  const before = structuredClone(f.target);
  assert.throws(() => planFor(f), /risk_body_existing_content_conflict/); assert.deepEqual(f.target, before);
});

test('unknown summary boundaries fail specifically rather than excluding all risk', () => {
  const f = fixture(); f.target.blocks.find(item => item.block_id === 'riskStart').heading1 = text('Unknown region');
  assert.throws(() => planFor(f), /risk_summary_region_unknown/);
});

test('missing order evidence or unknown existing summary is held without guessing', () => {
  const f = fixture(); delete f.job.dispatchScope;
  assert.throws(() => planFor(f), /risk_dispatch_order_missing/);
  const other = fixture(); other.target.blocks[0].children.splice(1, 0, 'unknownSummary'); other.target.blocks.push(block('unknownSummary', 4, 'Unknown风险摘要', 'Target'));
  assert.throws(() => planFor(other), /risk_summary_order_conflict/);
});

test('summary keeps other author summary order and inserts at dispatch order position', () => {
  const f = fixture(); f.target.blocks[0].children.splice(1, 0, 'otherSummary', 'otherRiskText');
  f.target.blocks.push(block('otherSummary', 4, 'Other风险摘要', 'Target'), block('otherRiskText', 2, 'Other risk', 'Target'));
  const { plan, next } = bodyDone(f), stage = prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next });
  assert.equal(stage.expectedAfterId, 'otherSummary');
  const final = applyStage(next, stage); verifyRiskMergeProjection({ plan, snapshot: final });
  assert.ok(final.blocks[0].children.indexOf('otherSummary') < final.blocks[0].children.indexOf('otherRiskText'));
});

test('explicit target subject alias is used only with exact target heading/order', () => {
  const f = fixture(); f.assignment.targetSubject = 'Target alias'; f.target.blocks.find(item => item.block_id === 'subject').heading2 = text('Target alias');
  assert.equal(planFor(f).targetSubject, 'Target alias');
});

test('last subject body can append to root end without a fake next boundary', () => {
  const f = fixture(); f.target.blocks = f.target.blocks.filter(item => !['other', 'otherText'].includes(item.block_id));
  f.target.blocks[0].children = f.target.blocks[0].children.filter(id => !['other', 'otherText'].includes(id));
  const { plan, next } = bodyDone(f);
  assert.equal(next.blocks[0].children.at(-1), 'body_8_4');
  assert.equal(prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next }).status, 'insert');
});

test('source summary cannot keep unresolved internal references', () => {
  const f = fixture(); f.source.block_list.items.find(item => item.block_id === 'summaryText').text.elements[0].text_run.text_element_style.link.url = 'https://my.feishu.cn/docx/Source#missing';
  assert.throws(() => planFor(f), /risk_summary_link_outside_body/);
});

test('relative source anchor is safely rebound using confirmed body mapping', () => {
  const f = fixture(); f.source.block_list.items.find(item => item.block_id === 'summaryText').text.elements[0].text_run.text_element_style.link.url = '#fact';
  const { plan, next, proof } = bodyDone(f), stage = prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next });
  assert.equal(stage.blocks[2].children[0].text.elements[0].text_run.text_element_style.link.url, `https://my.feishu.cn/docx/Target#${proof.sourceToTargetBlockIds.fact}`);
});

test('changed revisions, original content, root order and unrelated additions are rejected', () => {
  const f = fixture(), plan = planFor(f), changedRevision = structuredClone(f.target); changedRevision.revisionId += 1;
  assert.throws(() => prepareRiskMergeStage({ plan, stageId: 'body', snapshot: changedRevision }), /risk_target_changed_before_body/);
  const { next } = bodyDone(f), changedText = structuredClone(next);
  changedText.blocks.find(item => item.block_id === 'otherText').text = text('Edited');
  assert.throws(() => prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: changedText }), /risk_original_content_changed/);
  const changedOrder = structuredClone(next); changedOrder.blocks[0].children.reverse();
  assert.throws(() => prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: changedOrder }), /risk_original_order_changed/);
  const unrelated = structuredClone(next); unrelated.blocks[0].children.push('unrelated'); unrelated.blocks.push(block('unrelated', 2, 'Unrelated new content', 'Target'));
  assert.throws(() => prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: unrelated }), /risk_unrelated_blocks_added/);
});

test('readback of a timeout with no commit cannot confirm or imply retry permission', () => {
  const f = fixture(), plan = planFor(f), stage = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  assert.throws(() => confirmRiskMergeStage({ plan, stage, snapshot: f.target }), /risk_stage_readback_mismatch/);
  assert.equal(confirmRiskMergeStage({ plan, stage, snapshot: applyStage(f.target, stage) }).status, 'confirmed');
});

test('duplicate insertion after timeout is detected', () => {
  const f = fixture(), { plan, next, stage } = bodyDone(f);
  const duplicate = applyStage(next, stage);
  assert.throws(() => confirmRiskMergeStage({ plan, stage, snapshot: duplicate }), /risk_stage_readback_mismatch/);
});

test('plan or stage modification and incomplete trees fail closed', () => {
  const f = fixture(), plan = planFor(f), stage = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  const tamperedPlan = structuredClone(plan); tamperedPlan.targetSubject = 'Somebody';
  assert.throws(() => prepareRiskMergeStage({ plan: tamperedPlan, stageId: 'body', snapshot: f.target }), /risk_plan_changed/);
  const tamperedStage = structuredClone(stage); tamperedStage.index += 1;
  assert.throws(() => confirmRiskMergeStage({ plan, stage: tamperedStage, snapshot: applyStage(f.target, stage) }), /risk_stage_changed/);
  f.source.block_list.has_more = true; assert.throws(() => planFor(f), /risk_snapshot_incomplete/);
});

test('a separately reviewed exact reference prefix is preserved before the new source', () => {
  const f = fixture(); f.target.blocks[0].children.splice(3, 0, 'reference'); f.target.blocks.push(block('reference', 2, 'Human reference', 'Target'));
  const evidence = riskAppendPrefixEvidence({ snapshot: f.target, slotId: 'subject', subject: 'Subject' });
  assert.equal(evidence.verdict, undefined);
  const approvedAppendPrefix = { ...evidence, verdict: 'append_safe', reviewerId: 'offline-classifier-fixture', rationale: 'Synthetic disjoint reference fixture' };
  const plan = planRiskMerge({ job: f.job, association: f.assignment, sourceSnapshot: f.source, targetSnapshot: f.target, approvedAppendPrefix });
  const body = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target }); assert.equal(body.expectedBeforeId, 'reference');
  const next = applyStage(f.target, body); confirmRiskMergeStage({ plan, stage: body, snapshot: next });
  const summary = prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: next }), final = applyStage(next, summary);
  assert.deepEqual(verifyRiskMergeProjection({ plan, snapshot: final }).preservedBodyPrefixIds, ['reference']);
  assert.deepEqual(final.blocks.find(item => item.block_id === 'reference'), f.target.blocks.at(-1));
});

test('stale prefix evidence and an existing report skeleton are never adopted as references', () => {
  const f = fixture(); f.target.blocks[0].children.splice(3, 0, 'reference'); f.target.blocks.push(block('reference', 5, '基本信息', 'Target'));
  const evidence = riskAppendPrefixEvidence({ snapshot: f.target, slotId: 'subject', subject: 'Subject' });
  const approvedAppendPrefix = { ...evidence, verdict: 'append_safe', reviewerId: 'offline-classifier-fixture', rationale: 'Fixture only' };
  const args = { job: f.job, association: f.assignment, sourceSnapshot: f.source, targetSnapshot: f.target, approvedAppendPrefix };
  assert.throws(() => planRiskMerge(args), /risk_preserved_prefix_contains_report/);
  approvedAppendPrefix.revisionId += 1;
  assert.throws(() => planRiskMerge(args), /risk_preserved_prefix_evidence_mismatch/);
});

function imageFixture() {
  const f = fixture(), root = f.source.block_list.items[0];
  root.children.splice(3, 0, 'summaryImage'); root.children.push('bodyImage');
  for (const id of ['summaryImage', 'bodyImage']) f.source.block_list.items.push({ block_id: id, parent_id: 'Source', block_type: 27,
    image: { token: 'original-image-token', width: 300, height: 200, align: 2 } });
  return f;
}
function simulatedTransfer(snapshot, placeholders) {
  const output = structuredClone(snapshot);
  const mediaProofs = placeholders.images.map((image, index) => {
    const targetImageToken = `uploaded-${image.targetBlockId}`;
    output.blocks.find(block => block.block_id === image.targetBlockId).image.token = targetImageToken;
    output.revisionId += 1;
    return { ...image, targetImageToken, sourceSha256: 'a'.repeat(64), targetSha256: 'a'.repeat(64),
      simulationOnly: true, syntheticOrdinal: index };
  });
  return { snapshot: output, mediaProofs };
}

test('image placeholders never count as confirmed; each actual new image needs bound equal-byte hashes', () => {
  const f = imageFixture(), plan = planFor(f), body = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  assert.equal(body.blocks.at(-1).image.token, 'original-image-token'); assert.equal(body.writeBlocks.at(-1).image.token, '');
  let current = applyStage(f.target, { ...body, blocks: body.writeBlocks });
  assert.throws(() => confirmRiskMergeStage({ plan, stage: body, snapshot: current }), /risk_image_transfer_proof_missing/);
  const pendingBody = inspectRiskMergePlaceholders({ plan, stage: body, snapshot: current });
  assert.equal(pendingBody.status, 'media_pending'); assert.equal(pendingBody.images[0].sourceBlockId, 'bodyImage');
  assert.ok(pendingBody.createdBlockIds.includes(pendingBody.images[0].targetBlockId));
  const bodyTransfer = simulatedTransfer(current, pendingBody); current = bodyTransfer.snapshot;
  confirmRiskMergeStage({ plan, stage: body, snapshot: current, mediaProofs: bodyTransfer.mediaProofs });
  const summary = prepareRiskMergeStage({ plan, stageId: 'summary', snapshot: current, mediaProofs: bodyTransfer.mediaProofs });
  current = applyStage(current, { ...summary, blocks: summary.writeBlocks });
  const pendingSummary = inspectRiskMergePlaceholders({ plan, stage: summary, snapshot: current, mediaProofs: bodyTransfer.mediaProofs });
  assert.equal(pendingSummary.images[0].sourceBlockId, 'summaryImage');
  const summaryTransfer = simulatedTransfer(current, pendingSummary), mediaProofs = [...bodyTransfer.mediaProofs, ...summaryTransfer.mediaProofs];
  current = summaryTransfer.snapshot;
  confirmRiskMergeStage({ plan, stage: summary, snapshot: current, mediaProofs });
  assert.equal(verifyRiskMergeProjection({ plan, snapshot: current, mediaProofs }).deterministic, 'verified');
  assert.throws(() => verifyRiskMergeProjection({ plan, snapshot: current, mediaProofs: bodyTransfer.mediaProofs }), /risk_image_transfer_proof_missing/);
});

test('media proof cannot substitute hashes, source, target, slot, stage, or plan', () => {
  const f = imageFixture(), plan = planFor(f), body = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  const inserted = applyStage(f.target, { ...body, blocks: body.writeBlocks }), pending = inspectRiskMergePlaceholders({ plan, stage: body, snapshot: inserted });
  const transferred = simulatedTransfer(inserted, pending), original = transferred.mediaProofs[0];
  for (const patch of [{ targetSha256: 'b'.repeat(64) }, { sourceSha256: 'not-a-hash' }, { sourceDocumentId: 'OtherSource' },
    { targetDocumentId: 'OtherTarget' }, { sourceImageToken: 'wrong-token' }, { slotId: 'other' }, { stageId: 'summary' }, { planHash: 'wrong-plan' }]) {
    assert.throws(() => confirmRiskMergeStage({ plan, stage: body, snapshot: transferred.snapshot, mediaProofs: [{ ...original, ...patch }] }), /risk_image_transfer_proof_mismatch/);
  }
  const unexpected = structuredClone(inserted); unexpected.blocks.find(block => block.block_id === pending.images[0].targetBlockId).image.token = 'unproven-token';
  assert.throws(() => inspectRiskMergePlaceholders({ plan, stage: body, snapshot: unexpected }), /risk_image_transfer_proof_missing/);
});

test('image dimensions and non-image fields still must match exactly', () => {
  const f = imageFixture(), plan = planFor(f), body = prepareRiskMergeStage({ plan, stageId: 'body', snapshot: f.target });
  const inserted = applyStage(f.target, { ...body, blocks: body.writeBlocks }); inserted.blocks.find(block => block.block_type === 27).image.width = 999;
  assert.throws(() => inspectRiskMergePlaceholders({ plan, stage: body, snapshot: inserted }), /risk_block_mapping_conflict/);
});
