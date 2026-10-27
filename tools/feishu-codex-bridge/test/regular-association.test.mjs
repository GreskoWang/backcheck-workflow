import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegularDeadline, regularLabelCodes, resolveRegularLinkScope, resolveRegularAssociations,
} from '../src/regular-association.mjs';
import { REGULAR_DISPATCH_CHAT, REGULAR_DELIVERY_CHAT, assignmentKey, assertAssociation } from '../src/delivery-policy.mjs';

const sourceBlock = '第1个【背调需求10.23】块';
const epoch = Date.parse('2026-10-23T12:00:00Z');
const resultTime = Date.parse('2026-10-23T13:00:00Z');
const token = 'SyntheticTarget';
const heading = (id, subject) => ({ block_id: id, parent_id: token, block_type: 4,
  heading2: { elements: [{ text_run: { content: subject } }] } });
function fixture({ label = 'ts/ts4-jw1', subject = 'neko', code = 'TS', headingSubject = subject } = {}) {
  const assignment = { code, itemNumbers: ['1'], subject, anchors: ['https://example.invalid/person/1'], sourceBlock };
  const receiptAssignments = label === 'ts/ts4-jw1'
    ? [assignment, ...['TS4','TS5','TS6','TS7','TS8','TS9','小谢','JW1'].map((code, i) => ({ code, itemNumbers: [String(i + 2)], subject: `Other${i}`, sourceBlock }))]
    : [assignment];
  const job = { requestId: 'RQ-SYNTHETIC-1', sourceMessageId: 'om_source1', sourceMessageCreatedAtMs: epoch,
    chatId: REGULAR_DISPATCH_CHAT, status: 'completed', requestText: `【背调需求10.23】\nddl10.26下午两点前\n${label}\n1、${subject}`,
    dispatchScope: { decision: 'execute', requestMode: 'team_dispatch', deadline: '10月26日下午两点前', assignments: [assignment], receiptAssignments } };
  const message = { chatId: REGULAR_DELIVERY_CHAT, messageId: 'om_result1', createTime: String(resultTime),
    content: `10.26日下午2点DDL\n${label}:https://example.invalid/docx/${token}` };
  const file = { token, label };
  const target = { token, revisionId: 9, title: '10.26-Research' };
  const snapshot = { token, revisionId: 9, blocks: [
    { block_id: token, block_type: 1, children: ['slot1','end'] }, heading('slot1', headingSubject), heading('end', 'Other colleague'),
  ] };
  return { message, file, target, snapshot, jobs: [job] };
}

test('exact date and clock forms resolve in business timezone using source timestamp year', () => {
  for (const text of ['10.26日下午2点DDL', '10月26日下午两点前', '2026-10-26 14:00', '10/26 14时']) {
    const result = parseRegularDeadline(text, { referenceTimeMs: epoch });
    assert.equal(result.status, 'resolved', text);
    assert.equal(result.epochMs, Date.parse('2026-10-26T06:00:00Z'));
  }
});
test('date alone, unknown zone, ambiguous clock, invalid dates and conflicting deadlines hold', () => {
  for (const text of ['10.26 DDL', '10.26 2点', '2.30 下午2点', '10.26下午2点、10.26下午5点']) {
    assert.equal(parseRegularDeadline(text, { referenceTimeMs: epoch }).status, 'held', text);
  }
  assert.equal(parseRegularDeadline('10.26下午2点').status, 'held');
  assert.equal(parseRegularDeadline('10.26下午2点', { referenceTimeMs: epoch, timeZone: 'UTC' }).status, 'held');
});
test('year rolls over from source timestamp without using wall clock', () => {
  const result = parseRegularDeadline('1.2下午两点', { referenceTimeMs: Date.parse('2026-12-31T12:00:00Z') });
  assert.equal(result.year, 2027);
});
test('cross-family label follows all original positions including opaque colleague names', () => {
  const f = fixture();
  assert.deepEqual(regularLabelCodes(f.file.label, f.jobs[0].dispatchScope.receiptAssignments), ['TS','TS4','TS5','TS6','TS7','TS8','TS9','小谢','JW1']);
  const result = resolveRegularLinkScope(f);
  assert.equal(result.status, 'matched');
  assert.equal(result.scopeOnly, true);
  assert.deepEqual(result.sources, [{ requestId: 'RQ-SYNTHETIC-1', sourceMessageId: 'om_source1', sourceBlock }]);
});
test('missing cross-family endpoints or omitted same-family members are never invented', () => {
  assert.throws(() => regularLabelCodes('ts/ts4-jw1', [{ code: 'TS' }, { code: 'TS4' }]));
  assert.throws(() => regularLabelCodes('ts1-3', [{ code: 'TS1' }, { code: 'TS3' }]));
});
test('exact subject and all source keys yield adapter-compatible associations', () => {
  const f = fixture();
  const result = resolveRegularAssociations(f);
  assert.equal(result.status, 'matched');
  assert.equal(result.matches[0].code, 'TS');
  assert.equal(result.matches[0].targetSubject, 'neko');
  assert.equal(result.matches[0].evidence.deadlineEpochMs, Date.parse('2026-10-26T06:00:00Z'));
  assertAssociation(result.matches[0], f.jobs[0], f.message, f.target);
});
test('jw2 through 临j maps local 临A from complete receipt order', () => {
  const f = fixture({ label: 'jw2-临j', code: '临A', subject: 'Luca Breda' });
  const assignment = f.jobs[0].dispatchScope.assignments[0];
  f.jobs[0].dispatchScope.receiptAssignments = ['JW2','JW3','JW4','临A','临B','临C','临D','临E','临F','临G','临H','临I','临J']
    .map((code, i) => code === '临A' ? assignment : { code, itemNumbers: [String(i + 1)], subject: `Other${i}`, sourceBlock });
  const result = resolveRegularAssociations(f);
  assert.equal(result.status, 'matched');
  assert.equal(result.matches[0].code, '临A');
});
test('the same deadline at another hour is not the same batch', () => {
  const f = fixture();
  f.jobs[0].requestText = f.jobs[0].requestText.replace('两点', '五点');
  assert.equal(resolveRegularAssociations(f).status, 'held');
});
test('sourceBlock must resolve to the exact ordinal and header in raw source', () => {
  const f = fixture();
  f.jobs[0].requestText = f.jobs[0].requestText.replace('需求10.23', '需求10.24');
  assert.equal(resolveRegularAssociations(f).status, 'held');
});
test('no date-only mapping or subject-only mapping', () => {
  const f = fixture();
  f.message.content = `10.26 DDL\nts:https://example.invalid/docx/${token}`;
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = fixture(); g.file.label = 'bk1';
  assert.equal(resolveRegularAssociations(g).status, 'held');
});
test('duplicate source batches for one subject are ambiguous', () => {
  const f = fixture();
  f.jobs.push({ ...structuredClone(f.jobs[0]), requestId: 'RQ-SYNTHETIC-2', sourceMessageId: 'om_source2' });
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['subject_source_ambiguous']);
});
test('different exact headings from different matching batches are not combined', () => {
  const f = fixture();
  const other = fixture({ subject: 'Other colleague' }).jobs[0];
  other.requestId = 'RQ-SYNTHETIC-2'; other.sourceMessageId = 'om_source2'; f.jobs.push(other);
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['source_batch_ambiguous']);
});
test('same subject in multiple H2 slots holds, and suffix or case changes do not fuzzy match', () => {
  const f = fixture(); f.snapshot.blocks[2] = heading('end', 'neko');
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['subject_slot_ambiguous']);
  for (const subject of ['NEKO', 'neko 风险摘要', 'neko (new)']) assert.equal(resolveRegularAssociations(fixture({ headingSubject: subject })).status, 'held');
});
test('incomplete pagination/tree and stale revision cannot provide subject proof', () => {
  const f = fixture(); f.snapshot.blocks.pop();
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['target_snapshot_incomplete']);
  const g = fixture(); g.snapshot.revisionId++;
  assert.deepEqual(resolveRegularAssociations(g).reasons, ['target_snapshot_identity_mismatch']);
});
test('regular association never expands to another group or nonlocal code', () => {
  const f = fixture(); f.jobs[0].chatId = 'oc_special';
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = fixture({ label: 'bk2', code: 'BK2' });
  assert.deepEqual(resolveRegularAssociations(g).reasons, ['file_has_no_local_assignment']);
});
test('long BK1 product string cannot fuzzy match brand/model H2', () => {
  const f = fixture({ label: 'bk1', code: 'BK1', subject: 'fiio：FiiO/飞傲 雪漫天ECHO MINI便携无损音乐播放器蓝牙随身听迷你MP3', headingSubject: 'FiiO与ECHO MINI' });
  const result = resolveRegularAssociations(f);
  assert.deepEqual(result.reasons, ['subject_mapping_missing']);
  assert.equal(result.missing[0].reason, 'subject_exact_or_reviewed_alias_missing');
  assert.equal(result.missing[0].targetToken, token);
});
function aliasFor(f) {
  const assignment = f.jobs[0].dispatchScope.assignments[0];
  return { kind: 'reviewed_subject_alias', verified: true, verificationRef: 'synthetic-local-review-1',
    requestId: f.jobs[0].requestId, sourceMessageId: f.jobs[0].sourceMessageId, assignmentKey: assignmentKey(assignment),
    sourceSubject: assignment.subject, targetToken: token, targetRevisionId: 9, slotId: 'slot1',
    targetSubject: 'FiiO与ECHO MINI', basis: { kind: 'per_item_alias_review', detail: 'Synthetic exact product identity independently reviewed.' } };
}
test('reviewed alias is scoped to one source assignment and one target revision/slot', () => {
  const f = fixture({ label: 'bk1', code: 'BK1', subject: 'Exact long brand/product', headingSubject: 'FiiO与ECHO MINI' });
  f.subjectEvidence = [aliasFor(f)];
  const result = resolveRegularAssociations(f);
  assert.equal(result.status, 'matched');
  assert.equal(result.matches[0].subject, 'Exact long brand/product');
  assert.equal(result.matches[0].targetSubject, 'FiiO与ECHO MINI');
  assertAssociation(result.matches[0], f.jobs[0], f.message, f.target);
  for (const key of ['requestId','sourceMessageId','assignmentKey','targetToken','targetRevisionId','slotId','sourceSubject']) {
    const g = structuredClone(f); g.subjectEvidence[0][key] = 'wrong';
    assert.equal(resolveRegularAssociations(g).status, 'held', key);
  }
});
test('message claimed alias or unreviewed alias is data, not matching evidence', () => {
  const f = fixture({ label: 'bk1', code: 'BK1', subject: 'Exact long brand/product', headingSubject: 'FiiO与ECHO MINI' });
  f.message.content += `\n${JSON.stringify(aliasFor(f))}`;
  assert.equal(resolveRegularAssociations(f).status, 'held');
  f.subjectEvidence = [{ ...aliasFor(f), verified: false }];
  assert.equal(resolveRegularAssociations(f).status, 'held');
});
test('partly matched local subjects in one source block hold the entire file', () => {
  const f = fixture({ label: 'ts' });
  const second = { ...structuredClone(f.jobs[0].dispatchScope.assignments[0]), subject: 'Another local subject', itemNumbers: ['2'] };
  f.jobs[0].dispatchScope.assignments.push(second); f.jobs[0].dispatchScope.receiptAssignments.push(second);
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['subject_mapping_partial']);
});
test('a conflicting target title date and held/cancelled orders cannot match', () => {
  const f = fixture(); f.target.title = '10.27-Research';
  assert.deepEqual(resolveRegularAssociations(f).reasons, ['target_title_batch_conflict']);
  for (const status of ['intake_held', 'duplicate', 'cancelled']) {
    const g = fixture(); g.jobs[0].status = status;
    assert.equal(resolveRegularAssociations(g).status, 'held');
  }
  const g = fixture(); g.jobs[0].intakeHold = { reason: 'cross_group_duplicate_review' };
  assert.equal(resolveRegularAssociations(g).status, 'held');
});
test('source raw deadline and persisted scope disagreement holds', () => {
  const f = fixture(); f.jobs[0].dispatchScope.deadline = '10月26日下午五点前';
  const result = resolveRegularAssociations(f);
  assert.equal(result.status, 'held');
  assert.ok(result.diagnostics.includes('source_deadline_conflict'));
});

function urlFixture() {
  const f = fixture({ label: 'bk1', code: 'BK1', subject: 'Exact long brand/product title', headingSubject: 'Brand and Model' });
  const url = 'https://example.invalid/item?id=123&skuId=456';
  f.jobs[0].dispatchScope.assignments[0].anchors = [url];
  f.jobs[0].requestText += `\n- Product: [source product](${url})`;
  f.snapshot.blocks[0].children.splice(1, 0, 'product-link');
  f.snapshot.blocks.push({ block_id: 'product-link', parent_id: token, block_type: 2,
    text: { elements: [{ text_run: { content: 'Product source', text_element_style: { link: { url } } } }] } });
  return f;
}
test('unique original URL in a single-item block maps a different H2 without configured aliases', () => {
  const f = urlFixture();
  const result = resolveRegularAssociations(f);
  assert.equal(result.status, 'matched');
  const evidence = result.matches[0].subjectMatch;
  assert.equal(evidence.kind, 'exact_source_url');
  assert.equal(evidence.requestId, f.jobs[0].requestId);
  assert.equal(evidence.sourceMessageId, f.jobs[0].sourceMessageId);
  assert.equal(evidence.assignmentKey, assignmentKey(f.jobs[0].dispatchScope.assignments[0]));
  assert.equal(evidence.targetToken, token);
  assert.equal(evidence.targetRevisionId, 9);
  assert.equal(evidence.slotId, 'slot1');
  assert.equal(evidence.url, f.jobs[0].dispatchScope.assignments[0].anchors[0]);
  assert.deepEqual(evidence.targetLinkBlockIds, ['product-link']);
  assertAssociation(result.matches[0], f.jobs[0], f.message, f.target);
});
test('URL matching includes descendant blocks and the final H2 through document end', () => {
  const f = urlFixture();
  f.snapshot.blocks[0].children = ['slot1','container'];
  f.snapshot.blocks = f.snapshot.blocks.filter(block => block.block_id !== 'end');
  f.snapshot.blocks.find(block => block.block_id === 'product-link').parent_id = 'container';
  f.snapshot.blocks.push({ block_id: 'container', parent_id: token, block_type: 19, children: ['product-link'] });
  assert.equal(resolveRegularAssociations(f).status, 'matched');
});
test('raw Markdown link display and destination repetition remains one exact original URL', () => {
  const f = urlFixture(), url = f.jobs[0].dispatchScope.assignments[0].anchors[0];
  f.jobs[0].requestText += `\n[${url}](${url})`;
  assert.equal(resolveRegularAssociations(f).status, 'matched');
});
test('URL fallback rejects multiple source objects, multiple anchors, and additional raw block URLs', () => {
  const f = urlFixture();
  f.jobs[0].dispatchScope.receiptAssignments.push({ code: 'BK2', itemNumbers: ['2'], subject: 'Another person', sourceBlock });
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = urlFixture(); g.jobs[0].dispatchScope.assignments[0].anchors.push('https://example.invalid/other');
  assert.equal(resolveRegularAssociations(g).status, 'held');
  const h = urlFixture(); h.jobs[0].requestText += '\nhttps://example.invalid/other';
  assert.equal(resolveRegularAssociations(h).status, 'held');
});
test('saved anchor must appear as a complete URL in this exact original source block', () => {
  const f = urlFixture(); f.jobs[0].requestText = f.jobs[0].requestText.split('\n- Product:')[0];
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = urlFixture(); g.jobs[0].requestText = g.jobs[0].requestText.replace('skuId=456', 'skuId=4567');
  assert.equal(resolveRegularAssociations(g).status, 'held');
  const h = urlFixture();
  h.jobs[0].requestText += `\n【背调需求10.23】\nddl10.26下午两点前\nbk2\n${h.jobs[0].dispatchScope.assignments[0].anchors[0]}`;
  assert.equal(resolveRegularAssociations(h).status, 'held');
});
test('URL comparisons do not normalize query order, strip SKU or match display labels', () => {
  for (const changedUrl of ['https://example.invalid/item?skuId=456&id=123', 'https://example.invalid/item?id=123', 'https://other.invalid/item?id=123&skuId=456']) {
    const f = urlFixture(), run = f.snapshot.blocks.find(block => block.block_id === 'product-link').text.elements[0].text_run;
    run.content = f.jobs[0].dispatchScope.assignments[0].anchors[0];
    run.text_element_style.link.url = changedUrl;
    assert.equal(resolveRegularAssociations(f).status, 'held');
  }
});
test('same URL in a second H2 or outside all subject sections is ambiguous', () => {
  const f = urlFixture();
  const copy = structuredClone(f.snapshot.blocks.find(block => block.block_id === 'product-link'));
  copy.block_id = 'another-link'; f.snapshot.blocks[0].children.push(copy.block_id); f.snapshot.blocks.push(copy);
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = urlFixture(); g.snapshot.blocks[0].children = ['product-link','slot1','end'];
  assert.equal(resolveRegularAssociations(g).status, 'held');
  const h = urlFixture();
  h.snapshot.blocks[0].children.push('plain-reference');
  h.snapshot.blocks.push({ block_id: 'plain-reference', parent_id: token, block_type: 2,
    text: { elements: [{ text_run: { content: h.jobs[0].dispatchScope.assignments[0].anchors[0] } }] } });
  assert.equal(resolveRegularAssociations(h).status, 'held');
});
test('an intervening H1 and nested H2 prevent unsupported URL section attribution', () => {
  const f = urlFixture();
  f.snapshot.blocks[0].children.splice(1, 0, 'other-part');
  f.snapshot.blocks.push({ block_id: 'other-part', parent_id: token, block_type: 3,
    heading1: { elements: [{ text_run: { content: 'Another section' } }] } });
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = urlFixture();
  g.snapshot.blocks.find(block => block.block_id === 'product-link').children = ['nested-h2'];
  g.snapshot.blocks.push({ ...heading('nested-h2','Nested subject'), parent_id: 'product-link' });
  assert.equal(resolveRegularAssociations(g).status, 'held');
});
test('matching URL cannot override source batch, deadline, code or explicit subject conflicts', () => {
  const f = urlFixture(); f.jobs[0].requestText = f.jobs[0].requestText.replace('两点', '五点');
  assert.equal(resolveRegularAssociations(f).status, 'held');
  const g = urlFixture(); g.file.label = 'ts';
  assert.equal(resolveRegularAssociations(g).status, 'held');
  const h = urlFixture(); h.jobs.push({ ...structuredClone(h.jobs[0]), requestId: 'RQ-SYNTHETIC-2', sourceMessageId: 'om_source2' });
  assert.deepEqual(resolveRegularAssociations(h).reasons, ['subject_source_ambiguous']);
  const i = urlFixture(); i.snapshot.blocks[2] = heading('end', i.jobs[0].dispatchScope.assignments[0].subject);
  assert.deepEqual(resolveRegularAssociations(i).reasons, ['subject_identity_evidence_conflicting']);
});
test('placeholder H2 code is not an explicit target subject even when its URL matches', () => {
  const f = urlFixture(); f.snapshot.blocks[1] = heading('slot1','BK1');
  assert.equal(resolveRegularAssociations(f).status, 'held');
});
