import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import * as Lark from '@larksuiteoapi/node-sdk';

import { BridgeStore } from '../src/store.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { createSpecialPricingRegistry } from '../src/special-pricing.mjs';
import { createCompletionObserver, completionJobFingerprint } from '../src/completion-observer.mjs';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { prepareSpecialIncoming } from '../src/special-preflight.mjs';
import { sendAcceptanceReceiptOnce } from '../src/acceptance-receipt.mjs';
import { normalizePolledMessage, historyItemToRawEvent } from '../src/feishu-poller.mjs';
import { deliveryHash, REGULAR_DISPATCH_CHAT, REGULAR_DELIVERY_CHAT, SPECIAL_DELIVERY_CHAT } from '../src/delivery-policy.mjs';

const time = Date.parse('2026-10-26T05:00:00Z');
const iso = new Date(time).toISOString();
const activation = time - 1000;
const requestId = 'RQ-20261026-WORKFLOW';
const hostname = 'approved.feishu.cn';
const audience = deliveryHash('explicit-approved-group-audience');
const defaultOwner = { id: 'wangshukun', name: '王书鲲', authorizationRef: 'trusted-human-special-owner' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TEMP_ROOT || process.env.BRIDGE_TEST_TMP || os.tmpdir(), 'workflow-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const sessionsRoot = path.join(root, 'sessions'); fs.mkdirSync(sessionsRoot);
  const store = new BridgeStore(stateDir);
  store.setBinding({ chatId: REGULAR_DISPATCH_CHAT, chatName: 'Original dispatch' });
  const deliveryStore = new DeliveryStore(stateDir);
  const pricingRegistry = createSpecialPricingRegistry({ stateDir });
  const groupPolicies = [
    { chatId: REGULAR_DISPATCH_CHAT, role: 'regular_dispatch', enabled: true,
      activationFromMs: time - 100000, acceptanceFromMs: time - 100000,
      researchEnabled: true, accountingEnabled: true, acceptanceRepliesEnabled: true },
    { chatId: SPECIAL_DELIVERY_CHAT, role: 'special_dispatch', enabled: true,
      activationFromMs: activation, acceptanceFromMs: activation,
      researchEnabled: true, accountingEnabled: true, acceptanceRepliesEnabled: true,
      authorizationRef: 'trusted-human-special-group', defaultOwner },
    { chatId: REGULAR_DELIVERY_CHAT, role: 'regular_delivery', enabled: true,
      activationFromMs: activation, researchEnabled: false, accountingEnabled: false, acceptanceRepliesEnabled: false },
  ];
  const common = { enabled: false, activationFromMs: activation, authorization: 'trusted-human-delivery-route',
    allowedHostnames: [hostname], tenantKey: 'tenant', expectedExternal: false,
    allowedAudienceFingerprints: [audience] };
  const config = { delivery: { observationActivationFromMs: activation,
    regular: { ...common, chatId: REGULAR_DELIVERY_CHAT,
      sender: { idType: 'open_id', id: 'ou_y', tenantKey: 'tenant', verified: true, proofMessageId: 'om_identity' } },
    special: { ...common, chatId: SPECIAL_DELIVERY_CHAT,
      owner: { id: defaultOwner.id, name: defaultOwner.name, authorization: defaultOwner.authorizationRef } },
  } };
  const calls = { adapters: 0, identity: 0, target: 0, sourceReview: 0, send: 0, observer: 0, forget: 0 };
  const committed = new Map();
  const receipt = { token: 'ReviewedReport', revision_id: 9, verdict: 'PASS', script_version: 'test',
    reviewer_id: 'fixture-reviewer', layout_fingerprint: 'fixture-layout', generated_at: iso };
  const adapters = {
    resolveSenderIdentity: async ({ message }) => {
      calls.identity++; return { verified: true, id: message.senderId, idType: message.senderIdType,
        tenantKey: message.senderTenantKey, senderType: 'user', fromMessageMetadata: true,
        messageId: message.messageId, chatId: message.chatId };
    },
    inspectTarget: async () => {
      calls.target++; return { token: 'TargetToken', type: 'docx', hostname, tenantKey: 'tenant', ownerTenantKey: 'tenant',
        canRead: true, canWrite: true, matchingTitleCount: 1, revisionId: 4, observedAt: iso,
        audience: { permissionsComplete: true, external: false, public: false, fingerprint: audience } };
    },
    resolveRegularAssociations: async () => ({ status: 'unmatched', matches: [] }),
    verifyCompletedReports: async () => { calls.sourceReview++; return [receipt]; },
    readReviewedReport: async ({ job, association }) => ({ ...association, requestId: job.requestId,
      sourceMessageId: job.sourceMessageId, url: `https://${hostname}/docx/ReviewedReport`,
      token: 'ReviewedReport', revisionId: 9 }),
    inspectSpecialGroup: async () => ({ chatId: SPECIAL_DELIVERY_CHAT, tenantKey: 'tenant', external: false,
      canSend: true, membersComplete: true, memberCount: 3, audienceFingerprint: audience, observedAt: iso }),
    sendSpecialResult: async args => {
      calls.send++;
      assert.ok(deliveryStore.getIntent(args.intentId), 'intent must precede outbound delivery');
      committed.set(args.intentId, { status: 'confirmed', intentId: args.intentId,
        requestId: args.requestId, payloadHash: args.payloadHash, chatId: args.chatId, messageId: 'om_result' });
    },
    readBackIntent: async ({ intent }) => committed.get(intent.id) || { status: 'absent' },
  };
  let observation = async () => ({ status: 'waiting', reason: 'research_active' });
  const observer = { async observe(job, auth) { calls.observer++; return observation(job, auth); },
    forget() { calls.forget++; } };
  const options = { config, groupPolicies, store, deliveryStore, pricingRegistry,
    getAdapters: () => { calls.adapters++; return adapters; }, completionObserver: observer, now: () => time };
  const runtime = createWorkflowRuntime(options);
  const specialMessage = { messageId: 'om_special', chatId: SPECIAL_DELIVERY_CHAT, createTime: time,
    senderId: 'ou_dispatcher', content: '【特殊背调】', rawContentType: 'post',
    resources: [{ type: 'image', fileKey: 'img_fixture' }] };
  function addJob(patch = {}) {
    const job = { requestId, sourceMessageId: 'om_order', chatId: REGULAR_DISPATCH_CHAT,
      sourceMessageCreatedAtMs: time, status: 'handed_off', stage: 'research_started', requestText: 'Fixture order',
      ...patch };
    store.addJob(job);
    store.bindExecutionThread(job.requestId, `thread-${job.requestId}`);
    return store.getJob(job.requestId);
  }
  function specialJob(patch = {}) {
    return addJob({ chatId: SPECIAL_DELIVERY_CHAT, workflowKind: 'special_research', deliveryKind: 'special',
      specialOwnership: { ownerId: defaultOwner.id, authorization: defaultOwner.authorizationRef,
        sourceChatId: SPECIAL_DELIVERY_CHAT, sourceMessageId: 'om_order', verified: true },
      dispatchScope: { decision: 'execute', requestMode: 'special_dispatch',
        assignments: [{ code: 'SPECIAL_OWNER', subject: 'Fixture subject', itemNumbers: ['1'], sourceBlock: 'special block' }] }, ...patch });
  }
  return { root, stateDir, sessionsRoot, store, deliveryStore, pricingRegistry, groupPolicies, config,
    calls, adapters, observer, options, runtime, specialMessage, receipt, addJob, specialJob,
    observeWith(fn) { observation = fn; } };
}

test('special intake persists the full original job and pending price before any asynchronous image work', async t => {
  const f = fixture(t);
  const routing = f.runtime.routeExtension(f.specialMessage);
  const durable = new BridgeStore(f.stateDir).getJobBySourceMessageId('om_special');
  assert.ok(durable, 'queued source is durable before routeExtension yields');
  assert.equal(durable.stage, 'special_intake_pending');
  assert.deepEqual(durable.sourceMessage.resources, f.specialMessage.resources);
  assert.deepEqual(durable.sourceMediaKeys, ['image:img_fixture']);
  assert.equal(durable.accountingStatus, 'pending_pricing');
  assert.equal(f.pricingRegistry.findOrder({ requestId: durable.requestId }).pricing, null);
  assert.equal((await routing).status, 'queued');
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let downloading = false, modelCalls = 0;
  const preparation = prepareSpecialIncoming({ message: durable.sourceMessage, groupPolicy: f.groupPolicies[1], stateDir: f.stateDir,
    preflightModel: 'offline-fixture', client: { im: { v1: { messageResource: { get: async () => {
      assert.equal(new BridgeStore(f.stateDir).getJobBySourceMessageId('om_special').requestId, durable.requestId);
      downloading = true; await paused;
      return { getReadableStream: () => Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])]) };
    } } } } }, createCodex: () => ({ startThread: () => ({ run: async () => {
      modelCalls++; return { finalResponse: JSON.stringify({ decision: 'ready', requestType: 'public_video_research',
        subjects: ['Fixture subject'], requirements: { objective: 'Read specified public video', deliverables: ['Fact table'],
          sourceUrls: ['https://example.com/public-video'], timeframe: 'explicit source', constraints: [], reviewNeeds: ['verify facts'] },
        unreadableImageIndexes: [], ambiguities: [], publicSourcesOnly: true }), items: [] };
    } }) }) });
  assert.equal(downloading, true); assert.equal(modelCalls, 0);
  release();
  assert.equal((await preparation).status, 'ready');
  assert.equal(modelCalls, 1); assert.equal(f.store.listJobs().length, 1);
});

test('poll and WebSocket replay preserve one special job and one pricing record across restart', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.runtime.routeExtension(f.specialMessage), f.runtime.routeExtension(f.specialMessage)]);
  assert.deepEqual(results.map(item => item.status).sort(), ['duplicate', 'queued']);
  const restarted = createWorkflowRuntime({ ...f.options, store: new BridgeStore(f.stateDir),
    pricingRegistry: createSpecialPricingRegistry({ stateDir: f.stateDir }) });
  assert.equal((await restarted.routeExtension(f.specialMessage)).status, 'duplicate');
  assert.equal(f.store.listJobs().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'special-pricing.json'), 'utf8')).orders.length, 1);
});

test('special dispatch rejects the ordinary header and does not mistake distinct image resources for the same cross-group order', async t => {
  const f = fixture(t);
  assert.equal((await f.runtime.routeExtension({ ...f.specialMessage, content: '【背调需求】' })).status, 'ignored');
  f.addJob({ requestText: '【特殊背调】', sourceMediaKeys: ['image:img_other'] });
  assert.equal((await f.runtime.routeExtension(f.specialMessage)).status, 'queued');
  assert.equal(f.store.listJobs().length, 2);
});

test('original group remains on its existing dispatch route without new delivery or pricing side effects', async t => {
  const f = fixture(t);
  const result = await f.runtime.routeExtension({ ...f.specialMessage, chatId: REGULAR_DISPATCH_CHAT,
    content: '【背调需求10.26】\nTS\n1、Fixture company' });
  assert.equal(result.handled, false); assert.equal(result.policy.role, 'regular_dispatch');
  assert.equal(f.store.listJobs().length, 0); assert.equal(f.calls.adapters, 0);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'special-pricing.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'delivery-state.json')), false);
});

test('actual SDK merged-forward envelopes remain durably held in both dispatch groups without billing or execution', async t => {
  const f = fixture(t);
  const botIdentity = { openId: 'ou_bot', name: 'Fixture bot' };
  for (const [index, chatId] of [REGULAR_DISPATCH_CHAT, SPECIAL_DELIVERY_CHAT].entries()) {
    const item = { message_id: `om_forward_${index}`, chat_id: chatId, msg_type: 'merge_forward',
      root_id: 'om_not_verified_origin', parent_id: 'om_not_verified_origin', create_time: String(time),
      sender: { id: 'ou_dispatcher', id_type: 'open_id', sender_type: 'user' },
      body: { content: '{}' }, mentions: [] };
    // Exercise both the poller and the same SDK event normalizer used by WS.
    // No submessage fetcher is supplied; source identity must never be guessed.
    const message = index === 0
      ? await normalizePolledMessage(item, chatId, botIdentity, { allowUnmentioned: true })
      : await Lark.normalize(historyItemToRawEvent(item, chatId, botIdentity), { botIdentity });
    assert.equal(message.rawContentType, 'merge_forward');
    assert.equal((await f.runtime.routeExtension(message)).status, 'held');
    const durable = new BridgeStore(f.stateDir).getJobBySourceMessageId(message.messageId);
    assert.equal(durable.status, 'intake_held');
    assert.equal(durable.canonicalSourceMessageId, message.messageId);
    assert.throws(() => f.store.prepareExecutionJob(durable.requestId), /origin review/);
    assert.equal((await f.runtime.routeExtension(message)).status, 'duplicate');
  }
  assert.equal(f.store.listJobs().length, 2);
  assert.equal(f.calls.adapters, 0);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'special-pricing.json')), false);
});

test('delivery-group addresses create only delivery records and never research or accounting jobs', async t => {
  const f = fixture(t); f.config.delivery.regular.enabled = true;
  const result = await f.runtime.routeExtension({ messageId: 'om_target', chatId: REGULAR_DELIVERY_CHAT,
    createTime: time, content: `ts：https://${hostname}/docx/TargetToken`, senderId: 'ou_y', senderIdType: 'open_id', senderTenantKey: 'tenant' });
  assert.equal(result.handled, true); assert.equal(result.status, 'held');
  assert.equal(Object.keys(f.deliveryStore.read().requests).length, 1);
  assert.equal(f.store.listJobs().length, 0); assert.equal(f.calls.observer, 0);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'special-pricing.json')), false);
  assert.equal(f.calls.send, 0);
});

test('disabled groups, pre-activation new-group messages and ordinary conversation are ignored without side effects', async t => {
  const f = fixture(t);
  for (const msg of [{ ...f.specialMessage, createTime: activation - 1 },
    { ...f.specialMessage, chatId: REGULAR_DELIVERY_CHAT, createTime: activation - 1 },
    { ...f.specialMessage, chatId: 'oc_unapproved' }, { ...f.specialMessage, content: '收到，谢谢' }]) {
    assert.equal((await f.runtime.routeExtension(msg)).status, 'ignored');
  }
  f.groupPolicies[1].enabled = false;
  assert.equal((await f.runtime.routeExtension(f.specialMessage)).status, 'ignored');
  assert.equal(f.store.listJobs().length, 0); assert.equal(f.calls.adapters, 0);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'special-pricing.json')), false);
});

test('completion cutover prevents historical handed-off jobs from being upgraded or reviewed', async t => {
  const f = fixture(t);
  const historical = f.addJob({ sourceMessageCreatedAtMs: activation - 1 });
  let liveReviews = 0;
  const realObserver = createCompletionObserver({ workspace: f.root, stateDir: f.stateDir, sessionsRoot: f.sessionsRoot,
    readLatestRevision: async () => { liveReviews++; throw new Error('must not read old reports'); } });
  const runtime = createWorkflowRuntime({ ...f.options, completionObserver: realObserver });
  const results = await runtime.observeCompletions();
  assert.equal(results[0].status, 'ignored'); assert.equal(results[0].reason, 'before_completion_activation');
  assert.equal(f.store.getJob(historical.requestId).status, 'handed_off');
  assert.equal(liveReviews, 0); assert.equal(f.calls.adapters, 0);
});

test('waiting, blocked, candidate and ignored observations never mark research completed', async t => {
  for (const status of ['waiting', 'blocked', 'candidate', 'ignored']) {
    const f = fixture(t); const job = f.addJob();
    f.observeWith(async () => ({ status, reason: 'fixture' }));
    await f.runtime.observeCompletions();
    assert.equal(f.store.getJob(job.requestId).status, 'handed_off');
    assert.equal(f.calls.adapters, 0); assert.equal(f.calls.forget, 0);
  }
});

test('eligible completion requires an unchanged job fingerprint before its state transition', async t => {
  const f = fixture(t); const job = f.addJob();
  f.observeWith(async observed => {
    const expectedJobSha256 = completionJobFingerprint(observed);
    f.store.updateJob(observed.requestId, { status: 'paused', stage: 'operator_pause' });
    return { status: 'eligible', expectedJobSha256, completion: { finalResponse: 'Fixture completed' }, reviewReceipts: [f.receipt] };
  });
  await f.runtime.observeCompletions();
  assert.equal(f.store.getJob(job.requestId).status, 'paused');
  assert.equal(f.calls.adapters, 0); assert.equal(f.calls.forget, 0);
});

test('verified eligibility transitions once and preserves independent review evidence', async t => {
  const f = fixture(t); const job = f.addJob();
  f.observeWith(async observed => ({ status: 'eligible', expectedJobSha256: completionJobFingerprint(observed),
    completion: { finalResponse: `https://${hostname}/docx/ReviewedReport`, turnId: 'verified-turn' }, reviewReceipts: [f.receipt] }));
  await f.runtime.observeCompletions(); await f.runtime.observeCompletions();
  const completed = new BridgeStore(f.stateDir).getJob(job.requestId);
  assert.equal(completed.status, 'completed'); assert.equal(completed.stage, 'completed');
  assert.equal(completed.completionEvidence.turnId, 'verified-turn'); assert.deepEqual(completed.reviewReceipts, [f.receipt]);
  assert.equal(f.calls.observer, 1); assert.equal(f.calls.forget, 1); assert.equal(f.calls.send, 0);
});

test('nonstandard artifacts stay handed off and never enter completion or outward delivery adapters', async t => {
  const f = fixture(t); f.config.delivery.special.enabled = true;
  const job = f.specialJob({ deliveryEligible: false, deliveryReviewStatus: 'special_artifact_review_pending' });
  f.observeWith(async () => { throw new Error('nonstandard artifacts must not use the ordinary report observer'); });
  await f.runtime.observeCompletions();
  assert.equal(f.store.getJob(job.requestId).status, 'handed_off');
  assert.equal(f.calls.observer, 0); assert.equal(f.calls.send, 0);
  assert.equal(f.calls.adapters, 0);
});

test('onCompleted independently honors the nonstandard-artifact delivery hold', async t => {
  const f = fixture(t); f.config.delivery.special.enabled = true;
  const job = f.specialJob({ status: 'completed', stage: 'completed', deliveryEligible: false,
    deliveryReviewStatus: 'special_artifact_review_pending' });
  await f.runtime.onCompleted(job);
  assert.equal(f.calls.send, 0); assert.equal(f.calls.sourceReview, 0);
  assert.equal(Object.keys(f.deliveryStore.read().intents).length, 0);
});

test('special receipts require exact scope and owner proof but never wait for a numeric price', async t => {
  const f = fixture(t);
  const queued = await f.runtime.routeExtension(f.specialMessage);
  f.store.updateJob(queued.job.requestId, { status: 'running', stage: 'scope_resolved' });
  const scope = { decision: 'execute', requestMode: 'special_dispatch',
    assignments: [{ code: 'SPECIAL_OWNER', subject: 'Fixture subject', itemNumbers: ['1'] }] };
  let sends = 0;
  const options = { store: f.store, requestId: queued.job.requestId, scope, enabled: true,
    policy: f.groupPolicies[1], maxChars: 6000, formatText: () => '专项需求已接单\n王书鲲 → 1 → Fixture subject',
    send: async item => { sends++; assert.equal(item.chatId, SPECIAL_DELIVERY_CHAT);
      assert.equal(f.store.getJob(queued.job.requestId).acceptanceSendOutcome, 'pending_confirmation'); return 'om_receipt'; } };
  assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'sent');
  assert.equal((await sendAcceptanceReceiptOnce({ ...options, store: new BridgeStore(f.stateDir) })).status, 'already_attempted');
  assert.equal(sends, 1); assert.equal(f.pricingRegistry.findOrder({ requestId: queued.job.requestId }).pricing, null);
});

test('special receipt cannot borrow original policy, delivery-only policy or a mismatched default owner', async t => {
  for (const mode of ['original', 'delivery', 'owner', 'missing-proof', 'ordinary-scope']) {
    const f = fixture(t); const queued = await f.runtime.routeExtension(f.specialMessage);
    f.store.updateJob(queued.job.requestId, { status: 'running', stage: 'scope_resolved',
      ...(mode === 'missing-proof' ? { specialOwnership: null } : {}) });
    const scope = { decision: 'execute', requestMode: mode === 'ordinary-scope' ? 'direct_request' : 'special_dispatch',
      assignments: [{ code: 'SPECIAL_OWNER', subject: 'Fixture subject', itemNumbers: ['1'] }] };
    const policy = mode === 'original' ? f.groupPolicies[0] : mode === 'delivery' ? f.groupPolicies[2]
      : mode === 'owner' ? { ...f.groupPolicies[1], defaultOwner: { ...defaultOwner, id: 'other' } } : f.groupPolicies[1];
    const result = await sendAcceptanceReceiptOnce({ store: f.store, requestId: queued.job.requestId,
      scope, enabled: true, policy, maxChars: 6000, formatText: () => 'Receipt',
      send: async () => { throw new Error('unauthorized receipt send'); } });
    assert.equal(result.status, 'ineligible');
    assert.equal(f.store.getJob(queued.job.requestId).acceptanceSendAttemptAt, undefined);
  }
});
