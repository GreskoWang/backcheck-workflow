import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deliveryHash, expandDeliveryLabel, REGULAR_DELIVERY_CHAT, REGULAR_DISPATCH_CHAT, SPECIAL_DELIVERY_CHAT,
} from '../src/delivery-policy.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import {
  handleDeliveryMessage, retryPendingRegularDeliveries, deliverSpecialCompletedJob,
} from '../src/delivery-router.mjs';

const time = Date.parse('2026-10-26T05:00:00Z');
const iso = new Date(time).toISOString();
const audience = deliveryHash('explicit-approved-audience');
const hostname = 'approved.feishu.cn';

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TMP || os.tmpdir(), 'delivery-guard-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const store = new DeliveryStore(stateDir);
  const common = { enabled: true, activationFromMs: time - 1000, authorization: 'explicit user route approval',
    allowedHostnames: [hostname], tenantKey: 'tenant', expectedExternal: false, allowedAudienceFingerprints: [audience] };
  const config = {
    regular: { ...common, chatId: REGULAR_DELIVERY_CHAT,
      sender: { idType: 'open_id', id: 'ou_y', tenantKey: 'tenant', verified: true, proofMessageId: 'om_identity' } },
    special: { ...common, chatId: SPECIAL_DELIVERY_CHAT, expectedExternal: true,
      owner: { id: 'wangshukun', name: '王书鲲', authorization: 'user-20261026-special-owner' } },
  };
  const message = { chatId: REGULAR_DELIVERY_CHAT, messageId: 'om_address', createTime: time,
    content: `batch RQ-TEST deliver https://${hostname}/docx/TargetToken`, senderId: 'ou_y', senderIdType: 'open_id', senderTenantKey: 'tenant' };
  const assignment = { subject: 'Subject A', code: 'TS', itemNumbers: ['1'], sourceBlock: '第1个需求' };
  const job = { requestId: 'RQ-TEST', sourceMessageId: 'om_order', sourceMessageCreatedAtMs: time,
    chatId: REGULAR_DISPATCH_CHAT, status: 'completed', codexThreadId: 'thread-a', codexThreadRequestId: 'RQ-TEST',
    dispatchScope: { decision: 'execute', requestMode: 'team_dispatch', assignments: [assignment] } };
  let revision = 4;
  const target = () => ({ token: 'TargetToken', type: 'docx', hostname, tenantKey: 'tenant', ownerTenantKey: 'tenant',
    canRead: true, canWrite: true, matchingTitleCount: 1, revisionId: revision,
    audience: { permissionsComplete: true, external: false, public: false, fingerprint: audience }, observedAt: iso });
  const association = () => ({ ...assignment, requestId: job.requestId, sourceMessageId: job.sourceMessageId,
    batchId: job.requestId, targetToken: 'TargetToken', slotId: 'block_subject_a',
    evidence: { kind: 'source_and_target', deliveryMessageId: message.messageId,
      sourceMessageId: job.sourceMessageId, documentToken: 'TargetToken', targetRevisionId: revision,
      matchingRequestCount: 1, matchingSubjectCount: 1, matchingSlotCount: 1 } });
  const receipt = (token = 'ReportToken', rev = 9) => ({ verdict: 'PASS', token, revision_id: rev,
    script_version: 'test', reviewer_id: 'reviewer', layout_fingerprint: 'layout', generated_at: iso });
  const blocks = [{ block_type: 2, text: { elements: [{ text_run: { content: 'Already audited content' } }] } }];
  const material = () => ({ ...assignment, requestId: job.requestId, sourceMessageId: job.sourceMessageId,
    url: `https://${hostname}/docx/ReportToken`, token: 'ReportToken', revisionId: 9,
    blocks, contentHash: deliveryHash(blocks), boundToReviewedSnapshot: true });
  const committed = new Map();
  const calls = { insert: 0, send: 0, target: 0, verify: 0, sharedReview: 0 };
  const adapters = {
    capabilities: { atomicRevisionGuard: true, incrementalInsertOnly: true },
    resolveSenderIdentity: async ({ message: msg }) => ({ verified: true, id: msg.senderId, idType: msg.senderIdType,
      tenantKey: msg.senderTenantKey, senderType: 'user', fromMessageMetadata: true, messageId: msg.messageId, chatId: msg.chatId }),
    inspectTarget: async () => { calls.target++; return target(); },
    resolveRegularAssociations: async () => ({ status: 'matched', matches: [association()] }),
    verifyCompletedReports: async () => { calls.verify++; return [receipt()]; },
    readReviewedReport: async () => material(),
    inspectSlot: async ({ target: current, association: mapping }) => ({ documentToken: current.token, slotId: mapping.slotId,
      revisionId: current.revisionId, slotHash: deliveryHash('empty-slot'), empty: true, canAppend: true,
      otherAuthorsContentProtected: true, observedAt: iso }),
    insertOwnedBlocks: async input => {
      calls.insert++;
      assert.equal(input.operation, 'insert_only');
      assert.equal(input.requireServerRevisionGuard, true);
      assert.equal(input.expectedRevisionId, revision);
      assert.equal(input.expectedAudienceFingerprint, audience);
      assert.ok(store.getIntent(input.intentId), 'intent must precede API mutation');
      revision++;
      committed.set(input.intentId, { status: 'confirmed', intentId: input.intentId, requestId: input.requestId,
        payloadHash: input.payloadHash, targetToken: input.documentToken, slotId: input.slotId, revisionId: revision });
    },
    readBackIntent: async ({ intent }) => committed.get(intent.id) || { status: 'absent' },
    reviewSharedTarget: async ({ intent, readback }) => { calls.sharedReview++; return {
      verification: 'latest_shared_document_pass', externalBlocksUnchanged: true, verdict: 'PASS',
      receipt: receipt(intent.targetToken, readback.revisionId),
    }; },
    readLatestTargetRevision: async () => revision,
    inspectSpecialGroup: async () => ({ chatId: SPECIAL_DELIVERY_CHAT, tenantKey: 'tenant', external: true,
      canSend: true, membersComplete: true, memberCount: 3, audienceFingerprint: audience, observedAt: iso }),
    sendSpecialResult: async input => {
      calls.send++;
      assert.equal(input.chatId, SPECIAL_DELIVERY_CHAT);
      assert.equal(input.messageType, 'text');
      assert.ok(store.getIntent(input.intentId));
      committed.set(input.intentId, { status: 'confirmed', intentId: input.intentId,
        requestId: job.requestId, payloadHash: input.payloadHash, chatId: input.chatId, messageId: 'om_result' });
    },
  };
  const options = { message, jobs: [job], config, store, adapters, now: () => time };
  return { options, stateDir, store, config, message, assignment, job, adapters, calls, receipt, target, association, material, committed,
    revision: () => revision };
}

function specialize(f) {
  f.job.chatId = SPECIAL_DELIVERY_CHAT;
  f.job.deliveryKind = 'special';
  f.assignment.code = 'SPECIAL_OWNER';
  f.job.specialOwnership = { ownerId: 'wangshukun', authorization: 'user-20261026-special-owner',
    sourceChatId: SPECIAL_DELIVERY_CHAT, sourceMessageId: f.job.sourceMessageId, verified: true };
}

test('disabled delivery routes do not inspect, write, or create journal state', async t => {
  const f = fixture(t); f.config.regular.enabled = false;
  assert.equal((await handleDeliveryMessage(f.options)).status, 'ignored');
  assert.equal(f.calls.target, 0); assert.deepEqual(fs.readdirSync(f.stateDir), []);
});

test('a verified partial plan continues only its never-attempted steps before shared review', async t => {
  const f = fixture(t); let pending = false, continued = 0;
  const insert = f.adapters.insertOwnedBlocks, readback = f.adapters.readBackIntent;
  f.adapters.insertOwnedBlocks = async input => { await insert(input); pending = true; };
  f.adapters.readBackIntent = async args => pending ? { status: 'pending_steps' } : readback(args);
  f.adapters.continueOwnedDelivery = async ({ intent }) => {
    assert.ok(f.store.getIntent(intent.id)); assert.equal(f.calls.sharedReview, 0);
    continued++; pending = false;
  };
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(continued, 1); assert.equal(f.calls.insert, 1); assert.equal(f.calls.sharedReview, 1);
  await handleDeliveryMessage(f.options);
  assert.equal(continued, 1); assert.equal(f.calls.insert, 1);
});

test('unknown previous write results never authorize continuation or shared PASS', async t => {
  const f = fixture(t); let continued = 0;
  f.adapters.readBackIntent = async () => ({ status: 'unconfirmed' });
  f.adapters.continueOwnedDelivery = async () => { continued++; };
  const result = await handleDeliveryMessage(f.options);
  assert.equal(result.status, 'outcome_uncertain');
  assert.equal(continued, 0); assert.equal(f.calls.sharedReview, 0);
});

test('stable metadata identity is mandatory; matching display name is insufficient', async t => {
  const f = fixture(t); f.message.senderId = 'ou_someone_else'; f.message.content = 'Y: ' + f.message.content;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'sender_not_authorized');
  assert.equal(f.calls.target, 0); assert.equal(f.calls.insert, 0);
  f.message.senderId = 'ou_y'; f.config.regular.sender.verified = false;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'sender_identity_unverified');
});

test('old messages and unapproved hostnames stop before document inspection', async t => {
  const f = fixture(t); f.message.createTime = time - 2000;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'pre_activation_message');
  f.message.createTime = time; f.message.content = 'https://attacker.feishu.cn/docx/TargetToken';
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'unapproved_file_hostname');
  assert.equal(f.calls.target, 0);
});

test('unknown file types and multi-file messages hold without guessing', async t => {
  const f = fixture(t); f.message.content = `https://${hostname}/sheets/TargetToken`;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'unsupported_file_type');
  f.message.content = `https://${hostname}/docx/TargetToken https://${hostname}/docx/SecondToken`;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'multiple_file_links');
  assert.equal(f.calls.insert, 0);
});

test('regular target organization, audience, title uniqueness and permissions are mandatory', async t => {
  for (const [patch, expected] of [
    [{ ownerTenantKey: 'external' }, 'target_organization_mismatch'],
    [{ audience: { external: true, public: false, fingerprint: audience } }, 'target_audience_unapproved'],
    [{ matchingTitleCount: 2 }, 'target_title_ambiguous'],
    [{ canWrite: false }, 'target_access_unverified'],
  ]) {
    const f = fixture(t); f.adapters.inspectTarget = async () => ({ ...f.target(), ...patch });
    assert.equal((await handleDeliveryMessage(f.options)).reason, expected);
    assert.equal(f.calls.insert, 0);
  }
});

test('explicitly approved existing external audience and owner tenant are accepted; unknown audiences still hold', async t => {
  const f = fixture(t);
  f.config.regular.expectedExternal = true;
  f.config.regular.allowedOwnerTenantKeys = ['known-partner-tenant'];
  f.adapters.inspectTarget = async () => ({ ...f.target(), ownerTenantKey: 'known-partner-tenant',
    audience: { permissionsComplete: true, external: true, public: false, fingerprint: audience } });
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 1);
});

test('a labeled multi-file message inspects and fills only the exact locally assigned link', async t => {
  const f = fixture(t);
  f.message.content = [
    '10.26日下午2点DDL：', `ts1-3：https://${hostname}/docx/OtherGroupToken`,
    `ts：https://${hostname}/docx/TargetToken`, `bk2：https://${hostname}/docx/OtherOwnerToken`,
  ].join('\n');
  const inspected = [];
  f.adapters.inspectTarget = async ({ file }) => { inspected.push(file.token); return f.target(); };
  const result = await handleDeliveryMessage(f.options);
  assert.equal(result.status, 'delivered');
  assert.equal(result.results.filter(item => item.status === 'ignored').length, 2);
  assert.ok(inspected.every(token => token === 'TargetToken'));
  assert.equal(f.calls.insert, 1); assert.equal(Object.keys(f.store.read().requests).length, 1);
});

test('cross-family file labels expand only against the verified source block order', async t => {
  const f = fixture(t);
  f.message.content = `ts/ts4-jw1：https://${hostname}/docx/TargetToken`;
  f.job.dispatchScope.receiptAssignments = ['TS', 'TS1', 'TS2', 'TS3', 'TS4', 'TS5', 'JW1', 'JW2', '临A']
    .map(code => ({ ...f.assignment, code }));
  f.adapters.resolveDeliveryLinkScope = async ({ file, message }) => ({ status: 'matched',
    deliveryMessageId: message.messageId, fileToken: file.token,
    sources: [{ requestId: f.job.requestId, sourceMessageId: f.job.sourceMessageId, sourceBlock: f.assignment.sourceBlock }] });
  assert.deepEqual(expandDeliveryLabel('ts/ts4-jw1', ['TS', 'TS1', 'TS2', 'TS3', 'TS4', 'TS5', 'JW1']), ['TS', 'TS4', 'TS5', 'JW1']);
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 1);
});

test('a missing source range endpoint or association outside the file label holds before writing', async t => {
  const f = fixture(t);
  f.message.content = `jw2-临j：https://${hostname}/docx/TargetToken`;
  f.job.dispatchScope.receiptAssignments = [f.assignment];
  f.adapters.resolveDeliveryLinkScope = async ({ file, message }) => ({ status: 'matched',
    deliveryMessageId: message.messageId, fileToken: file.token,
    sources: [{ requestId: f.job.requestId, sourceMessageId: f.job.sourceMessageId, sourceBlock: f.assignment.sourceBlock }] });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'delivery_label_ambiguous');
  assert.equal(f.calls.target, 0);
  f.message.content = `bk1：https://${hostname}/docx/TargetToken`;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'assignment_outside_file_label');
  assert.equal(f.calls.insert, 0);
});

test('multiple unlabelled files cannot be guessed from document names', async t => {
  const f = fixture(t);
  f.message.content = `https://${hostname}/docx/TargetToken\nhttps://${hostname}/docx/AnotherToken`;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'delivery_labels_required');
  assert.equal(f.calls.target, 0);
});

test('incomplete matched reports wait durably and are inserted only after completion', async t => {
  const f = fixture(t); f.job.status = 'handed_off';
  assert.equal((await handleDeliveryMessage(f.options)).status, 'waiting_completion');
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.insert, 0);
  f.job.status = 'completed';
  assert.equal((await retryPendingRegularDeliveries(f.options))[0].status, 'delivered');
  assert.equal(f.calls.insert, 1); assert.equal(f.calls.sharedReview, 1);
});

test('mapping must bind source message, batch, subject, local code and unique slot', async t => {
  const f = fixture(t);
  f.adapters.resolveRegularAssociations = async () => ({ status: 'matched', matches: [{ ...f.association(), batchId: 'wrong-batch' }] });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'order_identity_mismatch');
  f.adapters.resolveRegularAssociations = async () => ({ status: 'matched', matches: [{ ...f.association(), code: 'TS1' }] });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'nonlocal_assignment');
  assert.equal(f.calls.insert, 0);
});

test('occupied unowned slots and concurrent target revisions cannot be overwritten', async t => {
  const f = fixture(t); const inspect = f.adapters.inspectSlot;
  f.adapters.inspectSlot = async input => ({ ...await inspect(input), empty: false, ownershipVerified: false });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'slot_not_empty_or_owned');
  assert.equal(f.calls.insert, 0);
  f.adapters.inspectSlot = inspect;
  let count = 0; f.adapters.inspectTarget = async () => ({ ...f.target(), revisionId: ++count === 1 ? 4 : 5 });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'target_changed_before_insert');
  assert.equal(f.calls.insert, 0);
});

test('source latest review and reviewed block hash are required before mutation', async t => {
  const f = fixture(t);
  f.adapters.verifyCompletedReports = async () => [{ ...f.receipt(), verdict: 'FAIL' }];
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'source_review_invalid');
  f.adapters.verifyCompletedReports = async () => [f.receipt()];
  f.adapters.readReviewedReport = async () => ({ ...f.material(), contentHash: deliveryHash('forged') });
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'report_content_unbound');
  assert.equal(f.calls.insert, 0);
});

test('successful incremental delivery is journaled and duplicate messages do not insert again', async t => {
  const f = fixture(t);
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 1);
  const journal = new DeliveryStore(f.stateDir).read();
  assert.equal(Object.values(journal.intents)[0].status, 'delivered');
  assert.equal(Object.values(journal.intents)[0].sharedReviewReceipt.revision_id, f.revision());
});

test('lost write response is recovered by readback, without a second insertion', async t => {
  const f = fixture(t); const insert = f.adapters.insertOwnedBlocks;
  f.adapters.insertOwnedBlocks = async input => { await insert(input); throw new Error('network response lost'); };
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 1);
});

test('parallel duplicate events and later repeated addresses share one mutation intent', async t => {
  const f = fixture(t);
  const result = await Promise.all([handleDeliveryMessage(f.options), handleDeliveryMessage(f.options)]);
  assert.ok(result.some(item => item.status === 'delivered'));
  assert.equal(f.calls.insert, 1);
  f.message.messageId = 'om_repeated_address';
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 1);
});

test('incremental mutation cannot run through an adapter lacking an atomic revision guard', async t => {
  const f = fixture(t); f.adapters.capabilities.atomicRevisionGuard = false;
  assert.equal((await handleDeliveryMessage(f.options)).reason, 'incremental_adapter_unverified');
  assert.equal(f.calls.insert, 0); assert.equal(Object.keys(f.store.read().intents).length, 0);
});

test('multiple matching subjects use fresh target revision and mapping for each insertion', async t => {
  const f = fixture(t);
  const second = { ...f.assignment, subject: 'Subject B', code: 'BK1', itemNumbers: ['2'] };
  f.job.dispatchScope.assignments.push(second);
  f.adapters.resolveRegularAssociations = async () => ({ status: 'matched', matches: [f.association(), {
    ...f.association(), ...second, slotId: 'block_subject_b',
  }] });
  f.adapters.verifyCompletedReports = async () => [f.receipt(), f.receipt('ReportTokenB')];
  f.adapters.readReviewedReport = async ({ association }) => ({ ...f.material(), ...association,
    token: association.subject === 'Subject A' ? 'ReportToken' : 'ReportTokenB',
    url: `https://${hostname}/docx/${association.subject === 'Subject A' ? 'ReportToken' : 'ReportTokenB'}`,
  });
  assert.equal((await handleDeliveryMessage(f.options)).status, 'delivered');
  assert.equal(f.calls.insert, 2); assert.equal(f.calls.sharedReview, 2);
  assert.equal(f.revision(), 6);
});

test('uncertain or absent readback never automatically retries the mutation across restart', async t => {
  const f = fixture(t);
  f.adapters.insertOwnedBlocks = async () => { f.calls.insert++; throw new Error('unknown result'); };
  assert.equal((await handleDeliveryMessage(f.options)).status, 'outcome_uncertain');
  f.options.store = new DeliveryStore(f.stateDir);
  assert.equal((await retryPendingRegularDeliveries(f.options))[0].status, 'outcome_uncertain');
  assert.equal(f.calls.insert, 1);
});

test('independent source PASS never substitutes for shared target latest revision review', async t => {
  const f = fixture(t);
  f.adapters.reviewSharedTarget = async () => ({ verdict: 'PASS', receipt: f.receipt() });
  const first = await handleDeliveryMessage(f.options);
  assert.equal(first.status, 'pending');
  assert.equal(first.results[0].status, 'review_blocked');
  assert.equal(Object.values(f.store.read().intents)[0].status, 'review_blocked');
  f.adapters.reviewSharedTarget = async ({ intent, readback }) => ({
    verification: 'latest_shared_document_pass', externalBlocksUnchanged: true, verdict: 'PASS',
    receipt: f.receipt(intent.targetToken, readback.revisionId),
  });
  assert.equal((await retryPendingRegularDeliveries(f.options))[0].status, 'delivered');
  assert.equal(f.calls.insert, 1);
});

test('a shared target edited after review remains uncompleted', async t => {
  const f = fixture(t); f.adapters.readLatestTargetRevision = async () => 99;
  const result = await handleDeliveryMessage(f.options);
  assert.equal(result.results[0].reason, 'shared_target_changed_after_review');
  assert.equal(f.calls.insert, 1);
});

test('special group sends completed audited default-owner reports to exact approved audience', async t => {
  const f = fixture(t); specialize(f);
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).status, 'delivered');
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).status, 'delivered');
  assert.equal(f.calls.send, 1); assert.equal(f.calls.insert, 0);
  const intent = Object.values(f.store.read().intents)[0];
  assert.match(intent.text, /专项背调已完成/u);
  assert.match(intent.text, /https:\/\/approved\.feishu\.cn\/docx\/ReportToken/u);
});

test('special external destination requires exact observed audience and external flag', async t => {
  const f = fixture(t); specialize(f);
  f.config.special.expectedExternal = false;
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'special_audience_unapproved');
  f.config.special.expectedExternal = true;
  f.adapters.inspectSpecialGroup = async () => ({ chatId: SPECIAL_DELIVERY_CHAT, tenantKey: 'tenant', external: true,
    canSend: true, membersComplete: true, memberCount: 3, audienceFingerprint: deliveryHash('new-unknown-recipient'), observedAt: iso });
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'special_audience_unapproved');
  assert.equal(f.calls.send, 0);
});

test('special history, uncompleted jobs and unreviewed output types cannot send', async t => {
  const f = fixture(t); specialize(f);
  f.job.sourceMessageCreatedAtMs = time - 2000;
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'pre_activation_message');
  f.job.sourceMessageCreatedAtMs = time; f.job.status = 'handed_off';
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'report_not_completed');
  f.job.status = 'completed'; f.adapters.readReviewedReport = async () => ({ ...f.material(), url: `https://${hostname}/sheets/ReportToken` });
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'unsupported_file_type');
  assert.equal(f.calls.send, 0);
});

test('special default ownership requires group-scoped user-rule provenance but no settled price', async t => {
  const f = fixture(t); specialize(f);
  f.job.specialOwnership.authorization = 'group-message-instruction';
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).reason, 'special_owner_provenance_mismatch');
  assert.equal(f.calls.send, 0);
  f.job.specialOwnership.authorization = f.config.special.owner.authorization;
  f.job.accountingStatus = 'pending_price';
  assert.equal((await deliverSpecialCompletedJob({ ...f.options, job: f.job })).status, 'delivered');
  assert.equal(f.calls.send, 1);
});

test('delivery store refuses a duplicate intent with changed payload and protects identity fields', t => {
  const f = fixture(t); const intent = { id: deliveryHash('intent'), kind: 'special', payloadHash: deliveryHash('payload'), requestId: 'RQ-A' };
  assert.equal(f.store.claimIntent(intent).claimed, true);
  assert.equal(new DeliveryStore(f.stateDir).claimIntent(intent).claimed, false);
  assert.throws(() => f.store.claimIntent({ ...intent, payloadHash: deliveryHash('other') }), /delivery_intent_conflict/u);
  assert.throws(() => f.store.updateIntent(intent.id, { requestId: 'RQ-B' }), /identity_immutable/u);
});

test('unreleased journal lock holds instead of breaking another writer lock', t => {
  const f = fixture(t); fs.writeFileSync(f.store.lockFile, 'existing writer');
  assert.throws(() => f.store.claimIntent({ id: deliveryHash('id'), payloadHash: deliveryHash('body') }), /delivery_state_locked/u);
  assert.equal(fs.readFileSync(f.store.lockFile, 'utf8'), 'existing writer');
});
