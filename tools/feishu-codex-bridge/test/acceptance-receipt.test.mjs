import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAcceptanceReceiptOnce } from '../src/acceptance-receipt.mjs';
import { formatAcceptanceReply } from '../src/codex-runner.mjs';

const requestId = 'RQ-20261006-NEW';
const groupId = 'oc_6589cfd31f18a0298c93602b6592ed04';
const acceptanceFromMs = Date.parse('2026-10-06T15:30:00Z');

function fixture() {
  const job = {
    requestId,
    codexThreadRequestId: requestId,
    status: 'running',
    stage: 'scope_resolved',
    scopeOnly: false,
    chatId: groupId,
    sourceMessageId: 'om_new_dispatch',
    sourceMessageCreatedAtMs: acceptanceFromMs + 1,
  };
  const scope = {
    decision: 'execute',
    requestMode: 'team_dispatch',
    assignments: [{ code: 'TS', itemNumbers: ['1'], subject: 'Owned company' }],
    receiptAssignments: [
      { code: 'TS', itemNumbers: ['1'], subject: 'Owned company' },
      { code: 'TS2', itemNumbers: ['2'], subject: 'Other member company' },
    ],
  };
  const store = {
    getJob: (id) => id === requestId ? structuredClone(job) : null,
    getBinding: () => ({ chatId: groupId }),
    updateJob: (id, patch) => {
      assert.equal(id, requestId);
      Object.assign(job, patch);
      return structuredClone(job);
    },
  };
  const options = {
    store, requestId, scope, enabled: true, acceptanceFromMs, allowedChatId: groupId,
    maxChars: 6000, formatText: formatAcceptanceReply,
    now: () => new Date('2026-10-06T15:31:00Z'),
  };
  return { job, scope, store, options };
}

test('one new full-team dispatch sends the entire allocation map exactly once', async () => {
  const { job, options } = fixture();
  const sent = [];
  options.send = async (item) => {
    assert.equal(job.acceptanceSendOutcome, 'pending_confirmation');
    assert.ok(job.acceptanceSendAttemptAt);
    sent.push(item);
    return 'om_receipt';
  };
  const first = await sendAcceptanceReceiptOnce(options);
  const second = await sendAcceptanceReceiptOnce(options);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'already_attempted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, 'om_new_dispatch');
  assert.equal(sent[0].chatId, groupId);
  assert.match(sent[0].text, /TS → 1 → Owned company/u);
  assert.match(sent[0].text, /TS2 → 2 → Other member company/u);
  assert.equal(job.acceptanceSendOutcome, 'confirmed');
  assert.equal(job.acceptanceReplyMessageId, 'om_receipt');
});

test('an uncertain Feishu response is recorded and never retried', async () => {
  const { job, options } = fixture();
  let calls = 0;
  options.send = async () => { calls += 1; throw new Error('response lost'); };
  assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'uncertain');
  assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'already_attempted');
  assert.equal(calls, 1);
  assert.equal(job.acceptanceSendOutcome, 'uncertain');
  assert.match(job.acceptanceSendError, /response lost/u);
});

test('old, direct, unowned, wrong-group and suppressed jobs never send', async () => {
  for (const kind of ['old', 'direct', 'unowned', 'wrong_group', 'suppressed', 'disabled']) {
    const { job, scope, store, options } = fixture();
    if (kind === 'old') job.sourceMessageCreatedAtMs = acceptanceFromMs - 1;
    if (kind === 'direct') scope.requestMode = 'direct_request';
    if (kind === 'unowned') scope.assignments = [];
    if (kind === 'wrong_group') store.getBinding = () => ({ chatId: 'oc_other' });
    if (kind === 'suppressed') job.acceptanceSuppressedAt = '2026-10-04T00:00:00Z';
    if (kind === 'disabled') options.enabled = false;
    options.send = async () => { throw new Error(`unexpected send: ${kind}`); };
    const result = await sendAcceptanceReceiptOnce(options);
    assert.equal(result.status, kind === 'suppressed' ? 'already_attempted' :
      kind === 'disabled' ? 'disabled' : 'ineligible');
    assert.equal(job.acceptanceSendAttemptAt, undefined);
  }
});

test('a too-long allocation list is not truncated or sent', async () => {
  const { job, options } = fixture();
  options.maxChars = 10;
  options.send = async () => { throw new Error('unexpected send'); };
  const result = await sendAcceptanceReceiptOnce(options);
  assert.equal(result.status, 'preparation_failed');
  assert.equal(job.acceptanceSendAttemptAt, undefined);
  assert.match(job.acceptancePreparationError, /above the 10-character limit/u);
});

test('special group sends only with its own explicit policy and keeps one receipt', async () => {
  const { job, options } = fixture();
  job.chatId = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
  options.policy = { chatId: job.chatId, role: 'special_dispatch', enabled: true,
    activationFromMs: acceptanceFromMs, acceptanceFromMs, acceptanceRepliesEnabled: true };
  let calls = 0;
  options.send = async (item) => { calls += 1; assert.equal(item.chatId, job.chatId); return 'om_special_receipt'; };
  assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'sent');
  assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'already_attempted');
  assert.equal(calls, 1);
});

test('similar suffix, delivery-only, missing cutoff and held orders never gain receipt permission', async () => {
  for (const kind of ['suffix', 'delivery', 'cutoff', 'held', 'wrong_policy']) {
    const { job, store, options } = fixture();
    options.send = async () => { throw new Error('unexpected send'); };
    if (kind === 'suffix') { job.chatId = 'oc_other_92ed04'; store.getBinding = () => ({ chatId: job.chatId }); }
    else {
      options.policy = { chatId: job.chatId, role: 'special_dispatch', enabled: true,
        activationFromMs: acceptanceFromMs, acceptanceFromMs, acceptanceRepliesEnabled: true };
      if (kind === 'delivery') options.policy.role = 'regular_delivery';
      if (kind === 'cutoff') options.policy.acceptanceFromMs = null;
      if (kind === 'held') job.intakeHold = { reason: 'review' };
      if (kind === 'wrong_policy') options.policy.chatId = 'oc_another';
    }
    assert.equal((await sendAcceptanceReceiptOnce(options)).status, 'ineligible');
    assert.equal(job.acceptanceSendAttemptAt, undefined);
  }
});
