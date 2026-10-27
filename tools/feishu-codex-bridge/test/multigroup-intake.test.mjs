import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../src/store.mjs';
import { FeishuMessagePoller } from '../src/feishu-poller.mjs';

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multigroup-intake-'));
  try { return run(new BridgeStore(root), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const job = (id, chatId, requestText = '【背调需求10.26】\nTS\n1、主体甲 https://example.com/a') => ({
  requestId: id, chatId, status: 'queued', requestText, sourceMessageCreatedAtMs: 1793000000000,
});

test('verified cross-group forward aliases survive restart and never create a second order', () => withStore((store, root) => {
  store.addJobForMessage('om_original', job('RQ-1', 'oc_a'));
  const duplicate = store.addJobForMessage('om_forward', job('RQ-2', 'oc_b'), {
    canonicalSourceMessageId: 'om_original', canonicalSourceVerified: true,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.added, false);
  assert.equal(store.listJobs().length, 1);
  assert.equal(duplicate.job.requestId, 'RQ-1');
  const fresh = new BridgeStore(root);
  fresh.forgetMessage('om_forward');
  assert.equal(fresh.getJobBySourceMessageId('om_forward').requestId, 'RQ-1');
  assert.equal(fresh.addJobForMessage('om_forward', job('RQ-3', 'oc_b')).added, false);
  assert.equal(fresh.listJobs().length, 1);
  assert.equal(fresh.isMessageSeen('om_forward'), true);
}));

test('forward arriving before its original still produces one canonical order', () => withStore((store) => {
  store.addJobForMessage('om_forward', job('RQ-1', 'oc_b'), {
    canonicalSourceMessageId: 'om_original', canonicalSourceVerified: true,
  });
  assert.equal(store.addJobForMessage('om_original', job('RQ-2', 'oc_a')).duplicate, true);
  assert.equal(store.listJobs().length, 1);
}));

test('cross-group identical content is durably held, not silently merged or executed', () => withStore((store, root) => {
  store.addJobForMessage('om_original', job('RQ-1', 'oc_a'));
  const result = store.addJobForMessage('om_other', job('RQ-2', 'oc_b'));
  assert.equal(result.held, true);
  assert.equal(result.job.status, 'intake_held');
  assert.deepEqual(result.job.intakeHold.candidateRequestIds, ['RQ-1']);
  assert.equal(store.listJobs().length, 2);
  const fresh = new BridgeStore(root);
  assert.equal(fresh.recoverInterruptedJobs().find((j) => j.requestId === 'RQ-2').status, 'intake_held');
  assert.throws(() => fresh.prepareExecutionJob('RQ-2'), /origin review/u);
  fresh.updateJob('RQ-2', { status: 'queued' });
  assert.throws(() => fresh.prepareExecutionJob('RQ-2'), /origin review/u);
  assert.throws(() => fresh.updateJob('RQ-2', { intakeHold: null }), /protected field/u);
}));

test('same subject with a different order or same-chat new message remains distinct', () => withStore((store) => {
  store.addJobForMessage('om_one', job('RQ-1', 'oc_a'));
  const newBatch = store.addJobForMessage('om_two', job('RQ-2', 'oc_b', '【背调需求10.27】\nTS\n1、主体甲 https://example.com/a'));
  const sameChat = store.addJobForMessage('om_three', job('RQ-3', 'oc_a'));
  assert.equal(newBatch.held, false);
  assert.equal(sameChat.held, false);
  assert.equal(store.listJobs().length, 3);
}));

test('unverified origin claim is rejected rather than suppressing another order', () => withStore((store) => {
  store.addJobForMessage('om_original', job('RQ-1', 'oc_a'));
  assert.throws(() => store.addJobForMessage('om_other', job('RQ-2', 'oc_b'), {
    canonicalSourceMessageId: 'om_original',
  }), /verified message metadata/u);
  assert.equal(store.listJobs().length, 1);
}));

test('concurrent websocket and polling deliveries claim one durable order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multigroup-intake-race-'));
  try {
    const store = new BridgeStore(root);
    const results = await Promise.all(['RQ-WS', 'RQ-POLL'].map(async (id) =>
      store.addJobForMessage('om_same', job(id, 'oc_a'))));
    assert.equal(results.filter((item) => item.added).length, 1);
    assert.equal(new BridgeStore(root).listJobs().length, 1);
    assert.throws(() => store.updateJob(results[0].job.requestId, { chatId: 'oc_b' }), /protected field/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const now = 1793000010000;
const cutoff = now - 2501;
function event(chatId, id, time) {
  return { message_id: id, chat_id: chatId, msg_type: 'text', create_time: String(time),
    sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user' }, mentions: [],
    body: { content: JSON.stringify({ text: '【背调需求】\nTS\n1、主体甲' }) } };
}

test('multi-group poller scopes chats, cuts off history and isolates failed chat watermarks', async () => {
  const queries = [], seen = [], watermarks = {};
  const policies = [
    { chatId: 'oc_a', enabled: true, activationFromMs: cutoff },
    { chatId: 'oc_b', enabled: true, activationFromMs: cutoff },
    { chatId: 'oc_pending', enabled: true, activationFromMs: null },
  ];
  const poller = new FeishuMessagePoller({
    client: { im: { v1: {
      chat: { list() { throw new Error('unexpected chat discovery'); } },
      message: { async list({ params }) { queries.push(params); return { code: 0, data: { items: [
        event(params.container_id, `${params.container_id}_old`, cutoff - 1),
        event(params.container_id, `${params.container_id}_new`, cutoff + 1),
      ] } }; } },
    } } }, botIdentity: { openId: 'ou_bot' }, getPolicies: () => policies,
    onMessage: async (msg) => { seen.push(msg.messageId); if (msg.chatId === 'oc_b') throw new Error('handler failed'); },
    getWatermark: () => Math.floor(cutoff / 1000) - 1000,
    setWatermark: (chatId, value) => { watermarks[chatId] = value; },
    intervalMs: 5000, lookbackMs: 900000, now: () => now,
  });
  await assert.rejects(() => poller.pollOnce(), /polling operation/u);
  assert.deepEqual(queries.map((q) => q.container_id), ['oc_a', 'oc_b']);
  assert.ok(queries.every((q) => q.start_time === String(Math.floor(cutoff / 1000))));
  assert.deepEqual(seen, ['oc_a_new', 'oc_b_new']);
  assert.equal(watermarks.oc_a, Math.floor(now / 1000) - 1);
  assert.equal(watermarks.oc_b, undefined);
});

test('all-inactive explicit policies never fall back to scanning visible chats', async () => {
  const poller = new FeishuMessagePoller({ client: {}, botIdentity: { openId: 'ou_bot' },
    getPolicies: () => [{ chatId: 'oc_pending', enabled: true, activationFromMs: null }],
    onMessage: async () => { throw new Error('unexpected dispatch'); }, intervalMs: 5000, lookbackMs: 900000, now: () => now });
  assert.deepEqual(await poller.pollOnce(), { chatCount: 0, forwardedCount: 0 });
});
