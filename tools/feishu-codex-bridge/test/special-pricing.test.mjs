import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpecialPricingRegistry } from '../src/special-pricing.mjs';

const source = { requestId: 'RQ-20261026-SPECIAL', sourceMessageId: 'om_special', chatId: 'oc_special' };
const alias = { requestId: 'RQ-20261026-FORWARDED', sourceMessageId: 'om_forwarded', chatId: 'oc_original' };
const operatorInstructionId = 'Sentinel_test_authorized_user_instruction';
const confirmingUser = { openId: 'ou_verified_owner', tenantKey: 'trusted_tenant' };

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TEMP_ROOT || os.tmpdir(), 'special-pricing-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const confirmations = new Map(), aliases = new Map();
  const options = { stateDir,
    confirmationAuthority: { operatorInstructionIds: [operatorInstructionId], confirmingUser,
      confirmationChatIds: ['oc_confirmations'] },
    resolveTrustedConfirmation: async id => structuredClone(confirmations.get(id)),
    resolveTrustedAlias: async id => structuredClone(aliases.get(id)),
  };
  const registry = createSpecialPricingRegistry(options);
  const order = registry.registerOrder(source);
  function confirmation(id, amount = '700', target = source) {
    const value = { confirmationId: id, kind: 'operator_instruction', decision: 'confirm_special_price',
      target: { ...target, orderId: order.orderId }, price: { amount, currency: 'CNY' },
      provenance: { source: 'authenticated_human_instruction', instructionId: operatorInstructionId } };
    confirmations.set(id, value); return value;
  }
  function aliasProof(id = 'alias-proof-1') {
    const value = { aliasId: id, kind: 'platform_original_message', orderId: order.orderId,
      originalSourceMessageId: source.sourceMessageId, originalChatId: source.chatId, alias,
      provenance: { source: 'verified_feishu_message_metadata' } };
    aliases.set(id, value); return value;
  }
  const read = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'special-pricing.json'), 'utf8'));
  return { stateDir, confirmations, aliases, options, registry, order, confirmation, aliasProof, read };
}

test('new special order records default owner and pending pricing without 0/600/700 or blocking research', t => {
  const f = fixture(t);
  assert.equal(f.order.owner, '王书鲲');
  assert.equal(f.order.status, 'pending_pricing');
  assert.equal(f.order.pricing, null);
  assert.equal(f.order.pricingBlocksResearch, false);
  assert.equal(Object.hasOwn(f.order, 'amount'), false);
  assert.equal(Object.hasOwn(f.order, 'rate'), false);
  assert.deepEqual(f.read().confirmations, []);
  assert.equal(f.registry.ledgerCapability(f.order.orderId).canWrite, false);
});

test('duplicate delivery and restart reuse one source/request price record', t => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) assert.equal(f.registry.registerOrder(source).operation, 'existing');
  const restarted = createSpecialPricingRegistry(f.options);
  assert.equal(restarted.registerOrder(source).orderId, f.order.orderId);
  assert.equal(f.read().orders.length, 1);
  assert.equal(restarted.findOrder({ sourceMessageId: source.sourceMessageId }).status, 'pending_pricing');
});

test('same source or request with a changed counterpart cannot create a second amount automatically', t => {
  const f = fixture(t);
  assert.equal(f.registry.registerOrder({ ...source, requestId: alias.requestId }).operation, 'alias_verification_required');
  assert.equal(f.registry.registerOrder({ ...source, sourceMessageId: alias.sourceMessageId }).operation, 'alias_verification_required');
  assert.equal(f.read().orders.length, 1);
  assert.equal(f.read().orders[0].aliases.length, 0);
});

test('explicit trusted operator confirmation binds the exact order and survives restart', async t => {
  const f = fixture(t); f.confirmation('price-confirmed', '712.35');
  const result = await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'price-confirmed' });
  assert.equal(result.status, 'price_confirmed'); assert.equal(result.pricing.amountMinor, 71235);
  assert.equal(result.pricing.amount, '712.35');
  assert.equal(createSpecialPricingRegistry(f.options).getOrder(f.order.orderId).pricing.amountMinor, 71235);
  assert.equal(result.ledgerCapability.status, 'blocked');
  assert.equal(result.pricingBlocksResearch, false);
});

test('untrusted raw group text, display names, missing resolver and unapproved operator instructions cannot confirm', async t => {
  const f = fixture(t);
  for (const change of [
    record => { record.kind = 'group_text'; record.senderName = 'Y'; },
    record => { record.provenance.instructionId = 'untrusted_message'; },
    record => { record.provenance.source = 'group_text'; },
  ]) {
    const record = f.confirmation('untrusted'); change(record);
    await assert.rejects(f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'untrusted' }),
      { code: 'SPECIAL_PRICING_UNTRUSTED' });
  }
  const noResolver = createSpecialPricingRegistry({ stateDir: f.stateDir });
  await assert.rejects(noResolver.confirmPrice({ orderId: f.order.orderId, confirmationId: 'untrusted', amount: 700 }),
    { code: 'SPECIAL_PRICING_UNTRUSTED' });
  assert.equal(f.registry.getOrder(f.order.orderId).status, 'pending_pricing');
  assert.equal(f.read().confirmations.length, 0);
});

test('event price confirmation requires the exact stable user, tenant, allowed chat and verified metadata', async t => {
  const f = fixture(t);
  const eventRecord = () => {
    const record = f.confirmation('event-confirmation', '650'); record.kind = 'verified_user_event';
    record.provenance = { source: 'verified_feishu_message_metadata', senderType: 'user',
      senderOpenId: confirmingUser.openId, tenantKey: confirmingUser.tenantKey,
      messageId: 'om_price_confirmed', chatId: 'oc_confirmations', priceMatchesMessage: true };
    return record;
  };
  for (const change of [record => { record.provenance.senderOpenId = 'ou_third_party'; },
    record => { record.provenance.tenantKey = 'external_tenant'; },
    record => { record.provenance.chatId = 'oc_unknown'; },
    record => { record.provenance.senderType = 'app'; },
    record => { record.provenance.priceMatchesMessage = false; },
    record => { delete record.provenance.messageId; }]) {
    const record = eventRecord(); change(record);
    await assert.rejects(f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'event-confirmation' }),
      { code: 'SPECIAL_PRICING_UNTRUSTED' });
  }
  eventRecord();
  assert.equal((await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'event-confirmation' })).pricing.amountMinor, 65000);
});

test('zero, negative, approximate, excessive precision, formulas and non-CNY amounts are rejected', async t => {
  const f = fixture(t);
  for (const amount of [0, -1, '0.00', '700元', '约700', '=600+100', '7e2', '700.001', '1e300']) {
    f.confirmation('invalid-price', amount);
    await assert.rejects(f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'invalid-price' }));
  }
  f.confirmation('invalid-price').price.currency = 'USD';
  await assert.rejects(f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'invalid-price' }));
  assert.equal(f.read().confirmations.length, 0);
});

test('the two historically priced 700 orders never become a default for another special order', async t => {
  const f = fixture(t); f.confirmation('only-this-order', '700');
  await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'only-this-order' });
  const next = f.registry.registerOrder({ requestId: 'RQ-OTHER-ORDER', sourceMessageId: 'om_new_special', chatId: source.chatId });
  assert.equal(next.pricing, null); assert.equal(next.status, 'pending_pricing');
});

test('known aliases share one confirmed price, repeated proofs and confirmations are idempotent', async t => {
  const f = fixture(t); f.aliasProof();
  await f.registry.linkAlias({ orderId: f.order.orderId, aliasId: 'alias-proof-1' });
  await f.registry.linkAlias({ orderId: f.order.orderId, aliasId: 'alias-proof-1' });
  f.confirmation('alias-price', '699', alias);
  await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'alias-price' });
  for (let n = 0; n < 2; n++) assert.equal((await f.registry.confirmPrice({ orderId: f.order.orderId,
    confirmationId: 'alias-price' })).operation, 'already_confirmed');
  f.confirmation('same-price-again', '699');
  assert.equal((await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'same-price-again' })).operation, 'already_confirmed');
  const stored = f.read(); assert.equal(stored.orders.length, 1); assert.equal(stored.orders[0].aliases.length, 1);
  assert.equal(stored.orders[0].pricing.amountMinor, 69900);
  assert.equal(f.registry.registerOrder(alias).orderId, f.order.orderId);
  assert.equal(f.registry.findOrder({ requestId: alias.requestId }).orderId, f.order.orderId);
});

test('unverified forward aliases and aliases already owned by another order cannot merge charges', async t => {
  const f = fixture(t); const proof = f.aliasProof(); proof.provenance.source = 'group_text';
  await assert.rejects(f.registry.linkAlias({ orderId: f.order.orderId, aliasId: 'alias-proof-1' }));
  f.aliasProof(); f.registry.registerOrder(alias);
  const result = await f.registry.linkAlias({ orderId: f.order.orderId, aliasId: 'alias-proof-1' });
  assert.equal(result.status, 'pricing_conflict');
  assert.equal(f.read().orders.length, 2);
  assert.equal(f.read().orders[0].aliases.length, 0);
});

test('conflicting confirmations hold the canonical order without replacing its first price or affecting research', async t => {
  const f = fixture(t); f.confirmation('first', '700'); f.confirmation('conflict', '800');
  await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'first' });
  const result = await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'conflict' });
  assert.equal(result.status, 'pricing_conflict'); assert.equal(result.pricing.amountMinor, 70000);
  assert.equal(result.pricingBlocksResearch, false); assert.equal(result.ledgerCapability.status, 'blocked');
  f.confirmation('later-agreement', '700');
  assert.equal((await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'later-agreement' })).status, 'pricing_conflict');
});

test('changed confirmation provenance or a mismatched source target creates a durable hold', async t => {
  const f = fixture(t); f.confirmation('reused', '700');
  await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'reused' });
  f.confirmation('reused', '800');
  assert.equal((await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'reused' })).status, 'pricing_conflict');
  const other = fixture(t); other.confirmation('mismatched-target', '700', alias);
  const result = await other.registry.confirmPrice({ orderId: other.order.orderId, confirmationId: 'mismatched-target' });
  assert.equal(result.status, 'pricing_conflict'); assert.equal(result.pricing, null);
});

test('concurrent confirmation calls create one price, and stale process locks fail closed', async t => {
  const f = fixture(t); f.confirmation('concurrent', '777');
  await Promise.all([f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'concurrent' }),
    f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'concurrent' })]);
  assert.equal(f.read().confirmations.length, 1);
  assert.equal(f.read().orders[0].pricing.amountMinor, 77700);
  fs.writeFileSync(path.join(f.stateDir, 'special-pricing.lock'), 'prior owner');
  assert.throws(() => f.registry.registerOrder(source), { code: 'SPECIAL_PRICING_BUSY' });
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'special-pricing.lock'), 'utf8'), 'prior owner');
});

test('registry never edits existing accounting state or exposes a writable ledger adapter', async t => {
  const f = fixture(t);
  const sentinel = path.join(f.stateDir, 'accounting-ledger.json');
  fs.writeFileSync(sentinel, '{"existing":"preserve"}\n');
  f.confirmation('confirmed', '700'); await f.registry.confirmPrice({ orderId: f.order.orderId, confirmationId: 'confirmed' });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"existing":"preserve"}\n');
  assert.deepEqual(Object.keys(f.registry).sort(), ['confirmPrice', 'findOrder', 'getOrder', 'ledgerCapability', 'linkAlias', 'registerOrder'].sort());
  assert.deepEqual(f.registry.ledgerCapability(f.order.orderId), {
    status: 'blocked', reason: 'controlled_special_accounting_required', canWrite: false });
});
