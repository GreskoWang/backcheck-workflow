import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliveryHash } from '../src/delivery-policy.mjs';
import { createSharedDeliveryReviewer, proveAdditiveInsertion, runToolFreeReview } from '../src/shared-delivery-review.mjs';
const text = content => ({ elements: [{ text_run: { content } }] });
function snapshots() {
  const before = { token: 'Target', revisionId: 1, document: { document_id: 'Target', revision_id: 1, title: 'Shared' }, blocks: [
    { block_id: 'Target', block_type: 1, children: ['h', 'ref', 'next'], page: text('Shared') },
    { block_id: 'h', parent_id: 'Target', block_type: 4, heading2: text('Subject') },
    { block_id: 'ref', parent_id: 'Target', block_type: 2, text: text('Source reference') },
    { block_id: 'next', parent_id: 'Target', block_type: 4, heading2: text('Other') },
  ] };
  const current = structuredClone(before); current.revisionId = 2; current.document.revision_id = 2;
  current.blocks[0].children.splice(2, 0, 'new'); current.blocks.push({ block_id: 'new', parent_id: 'Target', block_type: 2, text: text('Reviewed report') });
  const prepared = { subject: 'Subject', before, expectedRevisionId: 1, insertionIndex: 2, nextHeadingId: 'next',
    expectedBlocks: [{ block_type: 2, text: text('Reviewed report') }], expectedCreatedIds: ['new'] };
  return { before, current, prepared };
}
function folder(t) { const base = process.env.BRIDGE_TEST_TMP || os.tmpdir(); fs.mkdirSync(base, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(base, 'shared-review-')); t.after(() => { assert.ok(workspace.startsWith(path.resolve(base) + path.sep)); fs.rmSync(workspace, { recursive: true, force: true }); });
  return { workspace, stateDir: path.join(workspace, 'state') }; }
test('nonempty reference append retains every original block and exact ordering', () => {
  const f = snapshots(); const proof = proveAdditiveInsertion(f.prepared, f.current);
  assert.deepEqual(proof.insertedAllIds, ['new']); assert.equal(proof.preservedBlockCount, 4);
});
test('changed, deleted or reordered original blocks and unrelated additions are rejected', () => {
  for (const mutate of [f => { f.current.blocks[2].text = text('Changed'); },
    f => { f.current.blocks = f.current.blocks.filter(b => b.block_id !== 'ref'); f.current.blocks[0].children.splice(1, 1); },
    f => { f.current.blocks[0].children.reverse(); },
    f => { f.current.blocks[0].children.push('unrelated'); f.current.blocks.push({ block_id: 'unrelated', parent_id: 'Target', block_type: 2, text: text('Unrelated') }); }]) {
    const f = snapshots(); mutate(f); assert.throws(() => proveAdditiveInsertion(f.prepared, f.current));
  }
});
test('slot classification requires actual full block coverage and caches unchanged evidence', async t => {
  const dirs = folder(t), f = snapshots(); let calls = 0;
  const reviewer = createSharedDeliveryReviewer({ ...dirs, dependencies: { runReadOnlyReview: async () => { calls += 1;
    return { reviewerId: 'test-reader', result: { decision: 'append_safe', readBlockIds: ['ref'], reason: 'reference only', conflicts: [] } }; } } });
  const args = { snapshot: f.before, association: { subject: 'Subject' }, material: { blocks: f.prepared.expectedBlocks }, ownIds: ['ref'] };
  assert.equal((await reviewer.classifySlot(args)).decision, 'append_safe'); await reviewer.classifySlot(args); assert.equal(calls, 1);
  const missing = createSharedDeliveryReviewer({ ...dirs, dependencies: { runReadOnlyReview: async () => ({ result: { decision: 'append_safe', readBlockIds: [], conflicts: [] } }) } });
  args.association.subject = 'Different'; await assert.rejects(missing.classifySlot(args), /slot_review_incomplete/u);
});
test('existing completed structure is not appended to as if it were an empty template', async t => {
  const dirs = folder(t), f = snapshots(); f.before.blocks[2] = { block_id: 'ref', parent_id: 'Target', block_type: 5, heading3: text('基本信息') };
  const reviewer = createSharedDeliveryReviewer({ ...dirs, dependencies: { runReadOnlyReview: async () => { throw new Error('must not call'); } } });
  await assert.rejects(reviewer.classifySlot({ snapshot: f.before, association: {}, material: { blocks: f.prepared.expectedBlocks }, ownIds: ['ref'] }), /existing_subject_report_conflict/u);
});
test('model entry disables all tools and uses only the validated lazy model', async t => {
  const dirs = folder(t); let options, threadOptions;
  const result = await runToolFreeReview({ ...dirs, model: () => 'validated-model', input: 'data', schema: {},
    createCodex: config => { options = config; return { startThread: config => { threadOptions = config;
      return { id: 'test-thread', run: async () => ({ items: [{ type: 'agent_message' }], finalResponse: '{}', usage: null }) }; } }; } });
  assert.equal(result.reviewerId, 'codex:test-thread'); assert.ok(options.configOverrides.includes('mcp_servers={}'));
  assert.equal(threadOptions.sandboxMode, 'read-only'); assert.equal(threadOptions.networkAccessEnabled, false);
  assert.equal(threadOptions.model, 'validated-model');
  await assert.rejects(runToolFreeReview({ ...dirs, model: () => null }), /model_missing/u);
});
function reviewFixture(t, options = {}) {
  const dirs = folder(t), f = snapshots(); let modelCalls = 0, captures = 0, gates = 0;
  const records = f.current.blocks.map(b => ({ location: b.block_id, text: JSON.stringify(b) }));
  const reviewer = createSharedDeliveryReviewer({ ...dirs, dependencies: {
    runSharedGates: async ({ snapshot }) => { gates += 1; return { source: { verdict: options.sourceFail ? 'FAIL' : 'PASS', stats: { errors: 0, blocked: 0 } },
      records, layoutFingerprint: 'layout', policyVersion: '1', disclaimer: { errors: options.deterministicFail ? [{}] : [],
        blocked: snapshot.review_context.disclaimer_review ? [] : [{}], text_sha256: 'text-hash' } }; },
    captureSharedSection: async ({ directory }) => { captures += 1; fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'view.jpg');
      fs.writeFileSync(file, Buffer.from([255, 216, 255, 1])); return { method: 'test-capture', shots: [{ path: file, sha256: deliveryHash(fs.readFileSync(file)), viewportText: 'Subject' }] }; },
    runReadOnlyReview: async () => { modelCalls += 1; return { reviewerId: 'actual-test-review', result: {
      semanticStatus: options.semanticFail ? 'FAIL' : 'PASS', readLocations: options.coverageMissing ? [] : records.map(r => r.location), findings: [],
      visualStatus: options.visualBlocked ? 'BLOCKED' : 'PASS', visualChecks: { heading_levels: true, cards_and_grids: true, visible_platform_numbers: true, spacing: true, images: true },
      seenImageIndexes: [0], remaining: [] } }; },
  } });
  const args = { intent: { id: 'intent', requestId: 'RQ-A', targetToken: 'Target', slotId: 'h' }, prepared: f.prepared,
    current: f.current, source: { review_context: {} }, rawContent: 'Shared report', targetUrl: 'https://my.feishu.cn/docx/Target',
    readLatestRevision: async () => options.changedRevision ? 3 : 2 };
  return { reviewer, args, counts: () => ({ modelCalls, captures, gates }) };
}
test('automatic shared review obtains actual model+visual evidence then runs the final real gate contract', async t => {
  const f = reviewFixture(t); const r = await f.reviewer.review(f.args);
  assert.equal(r.verdict, 'PASS'); assert.equal(r.scope.whole_team_complete, false); assert.equal(r.receipt.revision_id, 2);
  assert.deepEqual(f.counts(), { modelCalls: 1, captures: 1, gates: 2 });
  await f.reviewer.review(f.args); assert.equal(f.counts().modelCalls, 1); assert.equal(f.counts().captures, 1);
});
test('source/deterministic failure stops before screenshots or semantic model work', async t => {
  for (const flag of ['sourceFail', 'deterministicFail']) { const f = reviewFixture(t, { [flag]: true });
    await assert.rejects(f.reviewer.review(f.args)); assert.equal(f.counts().captures, 0); assert.equal(f.counts().modelCalls, 0); }
});
test('real semantic/visual nonpass and missing coverage cannot produce a receipt', async t => {
  for (const flag of ['semanticFail', 'visualBlocked', 'coverageMissing', 'changedRevision']) {
    const f = reviewFixture(t, { [flag]: true }); await assert.rejects(f.reviewer.review(f.args));
  }
});
test('unchanged failed review is reused without another model or browser run', async t => {
  const f = reviewFixture(t, { visualBlocked: true }); await assert.rejects(f.reviewer.review(f.args));
  await assert.rejects(f.reviewer.review(f.args)); assert.equal(f.counts().modelCalls, 1); assert.equal(f.counts().captures, 1);
});
