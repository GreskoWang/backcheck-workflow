import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_DISPATCH_CHAT_ID, resolveGroupPolicies, activeGroupPolicies,
  getGroupPolicy, acceptsGroupMessage, canSendAcceptance } from '../src/group-policy.mjs';

const special = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const delivery = 'oc_2ed0070e09a740d81fff566d3b2db7d5';
const cutoff = 1793000000123;
const legacyRuntime = { acceptNewMessagesFromMs: 1792000000000, acceptanceRepliesFromMs: 1792000000000 };
const config = { target_chat_id: LEGACY_DISPATCH_CHAT_ID, listener_enabled: true,
  acceptance_replies_enabled: true, accounting: { enabled: true } };
const resolve = (groups) => resolveGroupPolicies({ localConfig: { ...config, groups },
  binding: { chatId: LEGACY_DISPATCH_CHAT_ID }, runtime: legacyRuntime });

test('adding inactive groups preserves original permissions and cutoff without expanding them', () => {
  const policies = resolve([
    { chatId: special, role: 'special_dispatch', enabled: true, activationFromMs: null, authorizationRef: 'user-request' },
    { chatId: delivery, role: 'regular_delivery', enabled: true, activationFromMs: null, authorizationRef: 'user-request' },
  ]);
  assert.equal(policies.length, 3);
  assert.deepEqual(activeGroupPolicies(policies).map((p) => p.chatId), [LEGACY_DISPATCH_CHAT_ID]);
  assert.equal(policies[0].activationFromMs, legacyRuntime.acceptNewMessagesFromMs);
  assert.equal(policies[0].acceptanceRepliesEnabled, true);
  assert.equal(getGroupPolicy(policies, special).acceptanceRepliesEnabled, false);
  assert.equal(getGroupPolicy(policies, 'oc_unknown'), null);
});

test('special receipt requires its own activation, authorization and matching chat', () => {
  const policy = getGroupPolicy(resolve([{ chatId: special, role: 'special_dispatch', enabled: true,
    activationFromMs: cutoff, acceptanceFromMs: cutoff, acceptanceRepliesEnabled: true,
    authorizationRef: 'user-request' }]), special);
  const job = { chatId: special, sourceMessageCreatedAtMs: cutoff };
  assert.equal(canSendAcceptance(policy, job), true);
  assert.equal(canSendAcceptance(policy, { ...job, chatId: LEGACY_DISPATCH_CHAT_ID }), false);
  assert.equal(canSendAcceptance(policy, { ...job, sourceMessageCreatedAtMs: cutoff - 1 }), false);
  assert.equal(canSendAcceptance({ ...policy, acceptanceFromMs: null }, job), false);
  assert.equal(acceptsGroupMessage(policy, { chatId: special, createTime: cutoff }), true);
  assert.equal(acceptsGroupMessage({ ...policy, enabled: false }, { chatId: special, createTime: cutoff }), false);
});

test('delivery policy cannot gain dispatch permissions or inherit receipt privileges', () => {
  const row = { chatId: delivery, role: 'regular_delivery', enabled: true, activationFromMs: cutoff, authorizationRef: 'user-request' };
  const policy = getGroupPolicy(resolve([row]), delivery);
  assert.equal(canSendAcceptance(policy, { chatId: delivery, sourceMessageCreatedAtMs: cutoff + 1 }), false);
  for (const field of ['acceptanceRepliesEnabled', 'accountingEnabled', 'researchEnabled']) {
    assert.throws(() => resolve([{ ...row, [field]: true }]), /delivery-only/u);
  }
});

test('rejects malformed, duplicate and unauthorized group entries', () => {
  const row = { chatId: special, role: 'special_dispatch', authorizationRef: 'user-request' };
  assert.throws(() => resolve([row, row]), /duplicate/u);
  assert.throws(() => resolve([{ ...row, authorizationRef: '' }]), /authorization/u);
  assert.throws(() => resolve([{ ...row, activationFromMs: '1793000000000' }]), /positive integer/u);
  assert.throws(() => resolve([{ ...row, role: 'anything' }]), /unsupported role/u);
  assert.throws(() => resolve([{ ...row, activationFromMs: cutoff, acceptanceRepliesEnabled: true, acceptanceFromMs: cutoff - 1 }]), /precede/u);
  assert.throws(() => resolve([{ chatId: LEGACY_DISPATCH_CHAT_ID, role: 'regular_delivery' }]), /retain its role/u);
});

test('accounting permission distinguishes explicit off from missing or malformed configuration', () => {
  for (const value of [true, false, undefined, 'false', null]) {
    const localConfig = { ...config, accounting: value === undefined ? undefined : { enabled: value } };
    const [legacy] = resolveGroupPolicies({ localConfig, binding: { chatId: LEGACY_DISPATCH_CHAT_ID }, runtime: legacyRuntime });
    assert.equal(legacy.accountingEnabled, typeof value === 'boolean' ? value : null);
    const policy = getGroupPolicy(resolve([{ chatId: special, role: 'special_dispatch', authorizationRef: 'user-request',
      accountingEnabled: value }]), special);
    assert.equal(policy.accountingEnabled, typeof value === 'boolean' ? value : null);
  }
});
